import { RunState } from "./core/model.js";

// An in-progress Actions job occupies one runner slot. Count job IDs rather
// than runner_name: GitHub-hosted runners may share display names, and a job
// is the unique unit of runner assignment in Actions.
//
// This is a confirmed lower bound, not an account-wide GitHub runner inventory.
// Incomplete/stale job detail cannot be silently converted into a precise 0.
export function activeWorkerSummary(tracked, nowMs = Date.now(), maxDetailAgeMs = 120000) {
  let runningWorkflowCount = 0;
  let coveredWorkflowCount = 0;
  const activeJobs = new Set();
  for (const item of tracked) {
    const run = item.snapshot || item;
    if (run.state !== RunState.InProgress) continue;
    runningWorkflowCount++;
    const detailMs = Number(run.jobsFetchedAtMs || 0);
    if (!detailMs || detailMs > nowMs + 30000 ||
        nowMs - detailMs > maxDetailAgeMs || !Array.isArray(run.jobs)) continue;
    coveredWorkflowCount++;
    for (const job of run.jobs) {
      if (job.state !== RunState.InProgress || !Number.isFinite(job.id) || job.id <= 0) continue;
      activeJobs.add(run.repository + "#" + job.id);
    }
  }
  return {
    activeWorkers: activeJobs.size,
    workerCoverageRuns: coveredWorkflowCount,
    workerTotalRunningRuns: runningWorkflowCount,
    activeWorkersPartial: coveredWorkflowCount < runningWorkflowCount
  };
}
