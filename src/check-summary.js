// Source: GitHub REST GET /repos/{owner}/{repo}/commits/{ref}/check-runs.
// These are commit-level check runs (the PR Checks tab's underlying objects),
// NOT workflow steps or a count inferred from one workflow's jobs.
const FAILURE_CONCLUSIONS = new Set([
  "failure", "timed_out", "action_required", "startup_failure", "stale"
]);
const NEUTRAL_CONCLUSIONS = new Set(["neutral", "skipped", "cancelled"]);

export function checkTarget(run) {
  if (run.event !== "pull_request" || !/^[0-9a-f]{40}$/i.test(run.checkSha || "")) return null;
  if (!/^[^/]+\/[^/]+$/.test(run.repository || "")) return null;
  return { repository: run.repository, sha: run.checkSha.toLowerCase() };
}

export function summarizeCheckRuns(runs, totalCount, complete) {
  const seen = new Map();
  for (const check of runs || []) {
    if (!Number.isSafeInteger(check?.id) || check.id <= 0) continue;
    seen.set(check.id, check);
  }
  let passed = 0, failed = 0, skipped = 0, pending = 0;
  for (const check of seen.values()) {
    if (check.status !== "completed") { pending++; continue; }
    if (check.conclusion === "success") passed++;
    else if (FAILURE_CONCLUSIONS.has(check.conclusion)) failed++;
    else if (NEUTRAL_CONCLUSIONS.has(check.conclusion)) skipped++;
    else pending++; // unknown/unclassified results never become false passes
  }
  const reported = Number.isSafeInteger(totalCount) && totalCount >= 0
    ? totalCount : seen.size;
  const total = Math.max(reported, seen.size);
  const missing = Math.max(0, total - seen.size);
  return {
    passed, failed, skipped, pending: pending + missing,
    total, seen: seen.size,
    complete: Boolean(complete && missing === 0)
  };
}
