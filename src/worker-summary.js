import { RunState } from "./core/model.js";

export const JOB_DETAIL_FRESHNESS_MS = 120_000;

export function hasFreshJobDetails(run, nowMs = Date.now(), maxAgeMs = JOB_DETAIL_FRESHNESS_MS) {
  const fetched = Number(run?.jobsFetchedAtMs || 0);
  return fetched > 0 && fetched <= nowMs + 30_000 &&
    nowMs - fetched <= maxAgeMs && Array.isArray(run.jobs);
}

// Preserve the provider's state. A queued parent can have genuinely executing
// children; activity is an observation, not a fabricated GitHub transition.
export function observedRunningJobs(run, nowMs = Date.now(), maxAgeMs = JOB_DETAIL_FRESHNESS_MS) {
  if (run?.state !== RunState.Queued && run?.state !== RunState.InProgress) return [];
  if (!hasFreshJobDetails(run, nowMs, maxAgeMs)) return [];
  return run.jobs.filter(job => job.state === RunState.InProgress);
}

export function observedRunState(run, nowMs = Date.now(), maxAgeMs = JOB_DETAIL_FRESHNESS_MS) {
  return run?.state === RunState.Queued &&
    observedRunningJobs(run, nowMs, maxAgeMs).length > 0
    ? RunState.InProgress : run?.state;
}

// A running job occupies one runner slot. Job IDs (scoped by repository) are
// the unit of identity, not runner display names or the number of workflows.
// This is a fresh, confirmed lower bound for monitored repositories; missing
// pages, stale detail and unidentified jobs cannot be called a precise zero.
export function activeWorkerSummary(tracked, nowMs = Date.now(), maxAgeMs = JOB_DETAIL_FRESHNESS_MS) {
  let liveRuns = 0;
  let providerRunningRuns = 0;
  let coveredRuns = 0;
  let observedRunningRuns = 0;
  const activeJobs = new Set();
  for (const item of tracked) {
    const run = item.snapshot || item;
    if (run.state !== RunState.Queued && run.state !== RunState.InProgress) continue;
    liveRuns++;
    if (run.state === RunState.InProgress) providerRunningRuns++;
    if (!hasFreshJobDetails(run, nowMs, maxAgeMs)) continue;

    const running = observedRunningJobs(run, nowMs, maxAgeMs);
    if (running.length) observedRunningRuns++;
    const unidentified = running.some(job => !Number.isSafeInteger(job.id) || job.id <= 0);
    if (run.jobsCoverageComplete !== false && !unidentified) coveredRuns++;
    for (const job of running) {
      if (!Number.isSafeInteger(job.id) || job.id <= 0) continue;
      activeJobs.add(run.repository + "#" + job.id);
    }
  }
  return {
    activeWorkers: activeJobs.size,
    workerCoverageRuns: coveredRuns,
    workerTotalLiveRuns: liveRuns,
    workerTotalRunningRuns: providerRunningRuns,
    observedRunningRunCount: observedRunningRuns,
    activeWorkersPartial: coveredRuns < liveRuns
  };
}
