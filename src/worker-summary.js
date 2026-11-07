import { RunState } from "./core/model.js";

export const JOB_DETAIL_FRESHNESS_MS = 120_000;

export function hasFreshJobDetails(run, nowMs = Date.now(), maxAgeMs = JOB_DETAIL_FRESHNESS_MS) {
  const fetched = Number(run?.jobsFetchedAtMs || 0);
  return fetched > 0 && fetched <= nowMs + 30_000 &&
    nowMs - fetched <= maxAgeMs && Array.isArray(run.jobs);
}

function runnerAssigned(job) {
  return Number.isSafeInteger(job.runnerId) && job.runnerId > 0 ||
    typeof job.runnerName === "string" && job.runnerName.trim().length > 0;
}

// Provider workflow state and actual job activity are independent facts.
// A queued workflow may have many running matrix jobs; a workflow marked
// in_progress may itself have no assigned runner yet.
export function jobActivitySummary(run, nowMs = Date.now(), maxAgeMs = JOB_DETAIL_FRESHNESS_MS) {
  const fresh = hasFreshJobDetails(run, nowMs, maxAgeMs);
  const result = {
    fresh,
    complete: fresh && run.jobsCoverageComplete !== false,
    running: 0, queued: 0, completed: 0, unknown: 0,
    assignedRunning: 0, unassignedRunning: 0,
    total: fresh ? run.jobs.length : 0,
    fetchedAtMs: fresh ? run.jobsFetchedAtMs : 0
  };
  if (!fresh) return result;
  for (const job of run.jobs) {
    if (job.state === RunState.InProgress) {
      result.running++;
      if (runnerAssigned(job)) result.assignedRunning++;
      else result.unassignedRunning++;
    } else if (job.state === RunState.Queued) result.queued++;
    else if (job.state === RunState.Completed) result.completed++;
    else result.unknown++;
  }
  return result;
}

export function observedRunningJobs(run, nowMs = Date.now(), maxAgeMs = JOB_DETAIL_FRESHNESS_MS) {
  if (run?.state !== RunState.Queued && run?.state !== RunState.InProgress) return [];
  if (!hasFreshJobDetails(run, nowMs, maxAgeMs)) return [];
  return run.jobs.filter(job => job.state === RunState.InProgress);
}

// Kept exclusively for execution-clock analysis. Do not use as the GitHub
// provider state in UI, filters or workflow counts.
export function observedRunState(run, nowMs = Date.now(), maxAgeMs = JOB_DETAIL_FRESHNESS_MS) {
  return run?.state === RunState.Queued &&
    observedRunningJobs(run, nowMs, maxAgeMs).length > 0
    ? RunState.InProgress : run?.state;
}

// Confirmed occupied runners are distinct *assigned* running job slots,
// not simply all in-progress workflow parents. Missing/stale job pages and
// missing runner assignment are explicitly reported as incomplete coverage.
export function activeWorkerSummary(tracked, nowMs = Date.now(), maxAgeMs = JOB_DETAIL_FRESHNESS_MS) {
  let liveRuns = 0, providerRunningRuns = 0, providerQueuedRuns = 0;
  let coveredRuns = 0, observedRunningRuns = 0, queuedWithRunningJobs = 0;
  let runningJobCount = 0, unassignedRunningJobs = 0;
  const activeJobs = new Set();
  for (const item of tracked) {
    const run = item.snapshot || item;
    if (run.state !== RunState.Queued && run.state !== RunState.InProgress) continue;
    liveRuns++;
    if (run.state === RunState.InProgress) providerRunningRuns++;
    else providerQueuedRuns++;
    const jobs = jobActivitySummary(run, nowMs, maxAgeMs);
    if (!jobs.fresh) continue;
    if (jobs.running) observedRunningRuns++;
    if (run.state === RunState.Queued && jobs.running) queuedWithRunningJobs++;
    runningJobCount += jobs.running;
    unassignedRunningJobs += jobs.unassignedRunning;
    const unidentified = run.jobs.some(job =>
      job.state === RunState.InProgress &&
      (!Number.isSafeInteger(job.id) || job.id <= 0)
    );
    if (jobs.complete && !unidentified && jobs.unassignedRunning === 0) coveredRuns++;
    for (const job of run.jobs) {
      if (job.state !== RunState.InProgress || !runnerAssigned(job)) continue;
      if (!Number.isSafeInteger(job.id) || job.id <= 0) continue;
      activeJobs.add(run.repository + "#" + job.id);
    }
  }
  return {
    activeWorkers: activeJobs.size,
    activeWorkersPartial: coveredRuns < liveRuns || unassignedRunningJobs > 0,
    observedRunningJobCount: runningJobCount,
    unassignedRunningJobCount: unassignedRunningJobs,
    workerCoverageRuns: coveredRuns,
    workerTotalLiveRuns: liveRuns,
    workerTotalRunningRuns: providerRunningRuns,
    providerQueuedRunCount: providerQueuedRuns,
    observedRunningRunCount: observedRunningRuns,
    queuedWithRunningJobsCount: queuedWithRunningJobs
  };
}
