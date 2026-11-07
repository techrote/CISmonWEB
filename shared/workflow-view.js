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
  const providerDataStale = provider !== "completed" && !!row.providerDataStale;
  if (providerDataStale) parts.push("parent status may be stale");
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
    providerDataStale,
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
    if (status !== "completed" && row.providerDataStale) result.providerStale++;
  }
  return result;
}

// Focus Dual/Vert panes may show the same GitHub run in several places.
// Provider workflow counters must use distinct run identities, not pane cells.
function workflowRunKey(row) {
  const id = Number(row?.runId);
  return Number.isSafeInteger(id) && id > 0
    ? String(row.repository || "") + "#" + id + "@" + (Number(row.runAttempt) || 1)
    : null;
}
export function uniqueWorkflowRows(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const key = workflowRunKey(row);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Preserve GitHub-provider queue filtering while showing when it omits
// a queued parent that currently has observed executing child jobs.
export function hiddenQueuedExecutingRows(candidates, displayed) {
  const shown = new Set(displayed.map(workflowRunKey).filter(Boolean));
  return uniqueWorkflowRows(candidates).filter(row =>
    (row.providerState || row.state) === "queued" &&
    row.jobActivity?.fresh === true && Number(row.jobActivity.running) > 0 &&
    !!workflowRunKey(row) && !shown.has(workflowRunKey(row))
  ).length;
}
