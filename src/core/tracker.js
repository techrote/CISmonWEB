import { Conclusion, RunState, isTerminal, needsAttention } from "./model.js";

function id(repository, runId) {
  return repository + "#" + runId;
}

export class RunTracker {
  constructor() {
    this.runs = new Map();
  }

  upsert(snapshot, nowMs) {
    const key = id(snapshot.repository, snapshot.runId);
    const existing = this.runs.get(key);
    if (existing) {
      const wasTerminal = isTerminal(existing.snapshot.state);
      const nowTerminal = isTerminal(snapshot.state);
      const merged = { ...snapshot };
      if ((!merged.jobs || merged.jobs.length === 0) && existing.snapshot.jobs?.length) {
        merged.jobs = existing.snapshot.jobs;
      }
      existing.snapshot = merged;
      existing.lastSeenMs = nowMs;
      if (!wasTerminal && nowTerminal) existing.terminalSinceMs = nowMs;
      return existing;
    }

    const tracked = {
      snapshot: { ...snapshot, jobs: snapshot.jobs || [] },
      firstSeenMs: nowMs,
      lastSeenMs: nowMs,
      terminalSinceMs: isTerminal(snapshot.state) ? nowMs : 0,
      acknowledged: false,
      manualWatch: false,
    };
    this.runs.set(key, tracked);
    return tracked;
  }

  find(repository, runId) {
    return this.runs.get(id(repository, runId)) || null;
  }

  acknowledge(repository, runId) {
    const run = this.find(repository, runId);
    if (!run) return false;
    run.acknowledged = true;
    return true;
  }

  setManualWatch(repository, runId, watched) {
    const run = this.find(repository, runId);
    if (!run) return false;
    run.manualWatch = Boolean(watched);
    return true;
  }

  all() {
    return [...this.runs.values()];
  }

  visible(nowMs, successTtlMs = 3600000) {
    return this.all().filter((run) => {
      const active = run.snapshot.state === RunState.Queued || run.snapshot.state === RunState.InProgress;
      const failure = needsAttention(run.snapshot.conclusion);
      const recentSuccess = run.snapshot.conclusion === Conclusion.Success &&
        run.terminalSinceMs !== 0 && nowMs - run.terminalSinceMs <= successTtlMs;
      return run.manualWatch || active || (failure && !run.acknowledged) || recentSuccess;
    });
  }

  prune(nowMs, successTtlMs = 3600000, terminalTtlMs = 86400000) {
    for (const [key, run] of this.runs.entries()) {
      if (!isTerminal(run.snapshot.state) || run.manualWatch) continue;
      if (needsAttention(run.snapshot.conclusion) && !run.acknowledged) continue;
      const ttl = run.snapshot.conclusion === Conclusion.Success ? successTtlMs : terminalTtlMs;
      if (run.terminalSinceMs && nowMs - run.terminalSinceMs > ttl) this.runs.delete(key);
    }
  }
}
