// Presentation-only normalization. Never infer or overwrite the GitHub
// provider's parent workflow state from an individual matrix child job.
export function workflowStatusPresentation(row) {
  const provider = row.providerState || row.state || "unknown";
  const jobs = row.jobActivity || {};
  const fresh = jobs.fresh === true;
  const complete = jobs.complete === true;
  const running = Number(jobs.running || 0);
  const queued = Number(jobs.queued || 0);
  const completed = Number(jobs.completed || 0);
  const parts = [];

  if (fresh) {
    if (running) parts.push(running + " job" + (running === 1 ? "" : "s") + " executing");
    if (queued) parts.push(queued + " waiting");
    if (completed) parts.push(completed + " finished");
    if (!running && !queued && !completed) parts.push("no jobs reported");
    if (!complete) parts.push("partial job page");
  } else if (provider === "queued" || provider === "in_progress") {
    parts.push("job detail unavailable/stale");
  }
  if (row.providerDataStale) parts.push("parent status may be stale");
  const labels = {
    in_progress: "IN PROGRESS",
    queued: "QUEUED",
    completed: String(row.conclusion || "COMPLETED").replaceAll("_", " ").toUpperCase()
  };
  const jobDetail = provider === "completed" ? "" :
    running ? running + " JOB" + (running === 1 ? "" : "S") + " EXECUTING" :
    fresh && queued ? queued + " JOB" + (queued === 1 ? "" : "S") + " WAITING" :
    fresh && completed ? "JOBS FINISHED" :
    fresh ? "NO JOB RUNNING" : "JOBS UNKNOWN";

  return {
    label: labels[provider] || provider.toUpperCase().replaceAll("_", " "),
    detail: jobDetail,
    sourceState: provider,
    fresh, complete, running, queued,
    providerDataStale: !!row.providerDataStale,
    title: "GitHub workflow: " + (labels[provider] || provider) +
      (parts.length ? ". Jobs: " + parts.join("; ") : "") +
      (row.providerAgeMs !== null && row.providerAgeMs !== undefined
        ? ". Parent last confirmed " + Math.floor(row.providerAgeMs / 1000) + "s ago."
        : "")
  };
}

export function summarizeProviderRows(rows) {
  const result = { inProgress: 0, queued: 0, completed: 0,
    queuedWithExecutingJobs: 0, jobDetailComplete: 0, jobDetailKnown: 0,
    providerStale: 0 };
  for (const row of rows) {
    const status = row.providerState || row.state;
    if (status === "in_progress") result.inProgress++;
    else if (status === "queued") result.queued++;
    else if (status === "completed") result.completed++;
    if (status === "queued" && Number(row.jobActivity?.running || 0) > 0) {
      result.queuedWithExecutingJobs++;
    }
    if (row.jobActivity?.fresh) result.jobDetailKnown++;
    if (row.jobActivity?.complete) result.jobDetailComplete++;
    if (row.providerDataStale) result.providerStale++;
  }
  return result;
}
