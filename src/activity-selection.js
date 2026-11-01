import { RunState } from "./core/model.js";

export const ACTIVITY_DEFAULT_DAYS = 7;
export const ACTIVITY_RECHECK_MS = 10 * 60 * 1000;

export function normalizeSelectionMode(value) {
  return value === "all" ? "all" : "activity";
}
export function normalizeActiveAgeDays(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(365, Math.round(n))) :
    ACTIVITY_DEFAULT_DAYS;
}
export function workflowActivitySummary(workflowRuns, ageDays, nowMs = Date.now()) {
  const days = normalizeActiveAgeDays(ageDays);
  const cutoff = nowMs - days * 86400000;
  let newestActivityMs = 0, live = false;
  for (const raw of Array.isArray(workflowRuns) ? workflowRuns : []) {
    const ts = Date.parse(raw.updated_at || raw.created_at || "");
    if (Number.isFinite(ts) && ts > newestActivityMs) newestActivityMs = ts;
    // A long-lived running/queued workflow must not disappear just because
    // it began before the configured activity window.
    if (["in_progress","queued","requested","waiting","pending"].includes(raw.status)) live = true;
  }
  return {
    admitted: live || newestActivityMs >= cutoff,
    newestActivityMs,
    live,
    cutoffMs: cutoff
  };
}
export function shouldKeepRepository(repo, ageDays, nowMs = Date.now()) {
  return !!repo.hadActive || !!repo.hadQueued ||
    Number(repo.lastActivityMs || 0) >= nowMs - normalizeActiveAgeDays(ageDays) * 86400000;
}
