export const RunState = Object.freeze({
  Unknown: "unknown",
  Queued: "queued",
  InProgress: "in_progress",
  Completed: "completed",
});

export const Conclusion = Object.freeze({
  Unknown: "unknown",
  Success: "success",
  Failure: "failure",
  Cancelled: "cancelled",
  TimedOut: "timed_out",
  Skipped: "skipped",
  Neutral: "neutral",
  ActionRequired: "action_required",
  StartupFailure: "startup_failure",
  Stale: "stale",
});

export const AttentionLevel = Object.freeze({
  Normal: "normal",
  Interesting: "interesting",
  Suspicious: "suspicious",
  ActionRequired: "action_required",
});

export function isTerminal(state) {
  return state === RunState.Completed;
}

export function needsAttention(conclusion) {
  return conclusion === Conclusion.Failure ||
    conclusion === Conclusion.TimedOut ||
    conclusion === Conclusion.ActionRequired ||
    conclusion === Conclusion.StartupFailure ||
    conclusion === Conclusion.Stale;
}

function key(parts) {
  return JSON.stringify(parts);
}

export const baselineKey = Object.freeze({
  run(run) {
    return key(["run-exec-v2", run.repository, run.workflowId, run.event]);
  },
  job(run, job) {
    return key(["job", run.repository, run.workflowId, run.event, job.name]);
  },
  step(run, job, step) {
    return key(["step", run.repository, run.workflowId, run.event, job.name, step.name]);
  },
});
