import { RunState } from "./core/model.js";

export function isLiveRun(run) {
  return run.state === RunState.InProgress || run.state === RunState.Queued;
}

export function shouldTrackSummaryRun(run, alreadyTracked, nowMs, terminalLookbackMs = 3600000) {
  if (alreadyTracked) return true;
  if (isLiveRun(run)) return true;
  if (run.state !== RunState.Completed) return false;

  const updatedMs = Number(run.updatedAtEpoch || 0) * 1000;
  if (!updatedMs || updatedMs > nowMs + 60000) return true;
  return nowMs - updatedMs <= terminalLookbackMs;
}
