import { Conclusion, RunState, isTerminal, needsAttention } from "./model.js";

function id(repository, runId) {
  return repository + "#" + runId;
}

function terminalTimestampMs(snapshot, nowMs) {
  const fromApi = Number(snapshot.updatedAtEpoch || 0) * 1000;
  if (fromApi > 0 && fromApi <= nowMs + 60000) return fromApi;
  return nowMs;
}

export class RunTracker {
  constructor(retained = () => false) {
    this.runs = new Map();
    this.retained = retained;
  }

  upsert(snapshot, nowMs) {
    const key = id(snapshot.repository, snapshot.runId);
    const existing = this.runs.get(key);
    const incomingActive = snapshot.state === RunState.Queued || snapshot.state === RunState.InProgress;

    if (existing) {
      const wasTerminal = isTerminal(existing.snapshot.state);
      const nowTerminal = isTerminal(snapshot.state);
      const incomingAttempt = Number(snapshot.runAttempt || 1);
      const currentAttempt = Number(existing.snapshot.runAttempt || 1);
      // Eventually consistent summaries or an older historical request must
      // not revive a completed attempt or roll a rerun back to its predecessor.
      if (incomingAttempt < currentAttempt ||
          (incomingAttempt === currentAttempt && wasTerminal && !nowTerminal)) return existing;
      const attemptChanged = incomingAttempt !== currentAttempt;
      const merged = { ...snapshot };
      // A rerun reuses the workflow run ID but not its child job attempts.
      // Do not retain old execution evidence into the new attempt.
      if (attemptChanged) {
        merged.jobs = snapshot.jobs || [];
        merged.jobsFetchedAtMs = 0;
        merged.jobsCoverageComplete = false;
        existing.acknowledged = false;
        existing.observedActive = incomingActive;
        existing.firstSeenMs = nowMs;
        existing.terminalSinceMs = nowTerminal ? terminalTimestampMs(snapshot, nowMs) : 0;
      }
      // Workflow-list summaries contain jobs: [] but no detail timestamp.
      // Retain separately fetched evidence across summary refreshes, including
      // verified empty lists. An explicit detail response (timestamp present)
      // is authoritative even when it clears previously running jobs.
      if (!attemptChanged && !Object.hasOwn(snapshot, "jobsFetchedAtMs") &&
          Number(existing.snapshot.jobsFetchedAtMs || 0) > 0) {
        merged.jobs = existing.snapshot.jobs;
        merged.jobsFetchedAtMs = existing.snapshot.jobsFetchedAtMs;
        merged.jobsCoverageComplete = existing.snapshot.jobsCoverageComplete !== false;
        merged.jobsExpectedCount = existing.snapshot.jobsExpectedCount;
      } else if ((!merged.jobs || merged.jobs.length === 0) &&
                 existing.snapshot.jobs?.length &&
                 !attemptChanged && !Object.hasOwn(snapshot, "jobsFetchedAtMs")) {
        merged.jobs = existing.snapshot.jobs;
      }
      const leftQueue = existing.snapshot.state === RunState.Queued &&
        merged.state === RunState.InProgress;
      const runningEvidence = merged.state === RunState.InProgress ||
        merged.jobs?.some(job => job.state === RunState.InProgress);
      merged.observedStartedAtEpoch = !attemptChanged &&
        (existing.snapshot.observedStartedAtEpoch ||
          (leftQueue ? Math.floor(nowMs / 1000) : 0)) || 0;
      // A run first discovered already running may have run_started_at equal
      // to created_at and no job timestamps yet. Retain the *observation*
      // time for a conservative, explicitly labelled lower-bound clock.
      merged.firstObservedRunningAtEpoch = (
        !attemptChanged ? existing.snapshot.firstObservedRunningAtEpoch : 0
      ) || (runningEvidence ? Math.floor(nowMs / 1000) : 0);
      existing.snapshot = merged;
      existing.lastSeenMs = nowMs;
      existing.observedActive ||= incomingActive;
      if ((!wasTerminal || attemptChanged) && nowTerminal) {
        existing.terminalSinceMs = terminalTimestampMs(snapshot, nowMs);
      }
      return existing;
    }

    const tracked = {
      snapshot: {
        ...snapshot, jobs: snapshot.jobs || [],
        // First-seen running runs use GitHub's distinct run_started_at;
        // observations are only an actual queued→running transition fallback.
        observedStartedAtEpoch: 0,
        firstObservedRunningAtEpoch: (
          snapshot.state === RunState.InProgress ||
          snapshot.jobs?.some(job => job.state === RunState.InProgress)
        ) ? Math.floor(nowMs / 1000) : 0
      },
      firstSeenMs: nowMs,
      lastSeenMs: nowMs,
      terminalSinceMs: isTerminal(snapshot.state) ? terminalTimestampMs(snapshot, nowMs) : 0,
      observedActive: incomingActive,
      acknowledged: false,
      manualWatch: false
    };
    this.runs.set(key, tracked);
    return tracked;
  }

  find(repository, runId) {
    return this.runs.get(id(repository, runId)) || null;
  }

  acknowledge(repository, runId, runAttempt = 1) {
    const run = this.find(repository, runId);
    // Run IDs survive reruns. A delayed action may only acknowledge the
    // attempt the caller saw; legacy callers are limited to attempt 1.
    if (!run || !Number.isSafeInteger(runAttempt) || runAttempt < 1 ||
        runAttempt !== Number(run.snapshot.runAttempt || 1)) return false;
    run.acknowledged = true;
    return true;
  }

  setManualWatch(repository, runId, watched) {
    const run = this.find(repository, runId);
    if (!run) return false;
    run.manualWatch = Boolean(watched);
    return true;
  }

  dropRepository(repository) {
    // Admission changes must not leave old live runs consuming detail
    // scheduler slots or appearing in surfaces after a repo is unwatched.
    for (const key of this.runs.keys()) {
      if (key.startsWith(repository + "#") && !this.retained(this.runs.get(key).snapshot)) this.runs.delete(key);
    }
  }

  all() {
    return [...this.runs.values()];
  }

  visible(nowMs, successTtlMs = 3600000, terminalTtlMs = 3600000, includeRetained = true) {
    return this.all().filter((run) => {
      const active = run.snapshot.state === RunState.Queued || run.snapshot.state === RunState.InProgress;
      const failure = needsAttention(run.snapshot.conclusion);
      const persistentObservedFailure = failure && run.observedActive && !run.acknowledged;
      const ttl = run.snapshot.conclusion === Conclusion.Success ? successTtlMs : terminalTtlMs;
      const recentTerminal = isTerminal(run.snapshot.state) &&
        run.terminalSinceMs !== 0 &&
        nowMs - run.terminalSinceMs <= ttl &&
        !(failure && run.acknowledged);

      return includeRetained && this.retained(run.snapshot) || run.manualWatch || active || persistentObservedFailure || recentTerminal;
    });
  }

  prune(nowMs, successTtlMs = 3600000, terminalTtlMs = 3600000) {
    for (const [key, run] of this.runs.entries()) {
      if (!isTerminal(run.snapshot.state) || run.manualWatch || this.retained(run.snapshot)) continue;

      const persistentObservedFailure =
        needsAttention(run.snapshot.conclusion) && run.observedActive && !run.acknowledged;
      if (persistentObservedFailure) continue;

      const ttl = run.snapshot.conclusion === Conclusion.Success ? successTtlMs : terminalTtlMs;
      if (run.terminalSinceMs && nowMs - run.terminalSinceMs > ttl) {
        this.runs.delete(key);
      }
    }
  }
}
