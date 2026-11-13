// Shared identities deliberately include the workflow attempt. Pins, watches,
// completion subscriptions and provider attention are separate concerns.
export function validRepository(value) {
  return typeof value === "string" && value.length <= 200 &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
    value.split("/").every(part => part !== "." && part !== "..");
}

export function validRun(value) {
  return validRepository(value?.repository) && Number.isSafeInteger(value.runId) && value.runId > 0 &&
    Number.isSafeInteger(value.runAttempt) && value.runAttempt > 0;
}

export function runKey(row) {
  return row.repository.toLowerCase() + "#" + row.runId + "@" + (row.runAttempt || 1);
}

export function prKey(repository, prNumber) {
  return repository.toLowerCase() + "#" + prNumber;
}

export function validPinScope(scope) {
  return scope && typeof scope.surfaceId === "string" && scope.surfaceId.length > 0 &&
    scope.surfaceId.length <= 100 && /^[A-Za-z0-9_-]+$/.test(scope.surfaceId) &&
    /^(main|dual:[01]|vert:[0-4])$/.test(scope.paneId);
}

export function pinScopeKey(scope) {
  return scope.surfaceId + ":" + scope.paneId;
}

function safeGithubUrl(value, expectedPath) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port ||
        url.username || url.password || !expectedPath.test(url.pathname)) return "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return ""; }
}

export function ciUrl(row) {
  if (!validRun({ ...row, runAttempt: row.runAttempt || 1 })) return "";
  const path = "/" + row.repository + "/actions/runs/" + row.runId;
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const actual = safeGithubUrl(row.htmlUrl, new RegExp("^" + escaped + "(?:/attempts/\\d+)?/?$", "i"));
  // Even GitHub's canonical run URL moves to the latest attempt after a
  // rerun. A context menu belongs to the precise attempt the user selected.
  return (actual || "https://github.com" + path).replace(/\/(?:attempts\/\d+\/?)?$/, "")
    .replace(/\/attempts\/\d+$/, "") + "/attempts/" + (row.runAttempt || 1);
}

export function prAssociation(row) {
  const value = row?.prAssociation;
  if (value?.status === "resolved" && validRepository(row.repository) &&
      Number.isSafeInteger(value.number) && value.number > 0) {
    return {
      status: "resolved", number: value.number,
      url: "https://github.com/" + row.repository + "/pull/" + value.number,
      reason: value.reason || "PR association verified against the current head"
    };
  }
  const status = ["ambiguous", "unavailable", "pending"].includes(value?.status) ? value.status : "unknown";
  return {
    status, number: 0, url: "",
    reason: value?.reason || (status === "ambiguous" ? "More than one PR matches this run" :
      status === "pending" ? "Verifying PR association with GitHub" : "PR association has not been verified")
  };
}

export function commitUrl(row) {
  return validRepository(row?.repository) && /^[0-9a-f]{40}$/i.test(row?.headSha || "")
    ? "https://github.com/" + row.repository + "/commit/" + row.headSha : "";
}

export function completionOutcome(conclusion) {
  if (conclusion === "success") return "success";
  if (["failure", "timed_out", "action_required", "startup_failure", "stale", "error"].includes(conclusion)) return "failure";
  if (conclusion === "cancelled") return "cancelled";
  if (["neutral", "skipped"].includes(conclusion)) return "neutral";
  return "indeterminate";
}

export function outcomeSound(outcome) {
  return outcome === "success" ? "success" : ["failure", "cancelled"].includes(outcome) ? "failure" : null;
}
