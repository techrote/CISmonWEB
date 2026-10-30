import { Conclusion, RunState } from "./core/model.js";

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, Math.min(3_600_000, dateMs - nowMs)) : 0;
}

export function isGitHubRateLimit(status, remaining, message = "") {
  return status === 429 ||
    remaining === 0 ||
    (status === 403 && /rate limit|abuse detection|too many requests/i.test(message));
}

export class GitHubClient {
  constructor(tokenProvider, fetchImpl = globalThis.fetch, timeoutMs = 12_000) {
    this.tokenProvider = tokenProvider;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async get(apiPath, etag = "") {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "CISmonWEB"
    };
    const token = this.tokenProvider();
    if (token) headers.Authorization = "Bearer " + token;
    if (etag) headers["If-None-Match"] = etag;

    try {
      // A stalled request must never monopolise Monitor.tick()'s single busy
      // lock, or block Promise.allSettled() across a complete rescan batch.
      const response = await this.fetchImpl("https://api.github.com" + apiPath, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      let json = null;
      if (response.status !== 304) {
        const text = await response.text();
        if (text) {
          try { json = JSON.parse(text); } catch { json = null; }
        }
      }

      const remainingRaw = response.headers.get("x-ratelimit-remaining");
      const remaining = remainingRaw === null ? -1 : Number(remainingRaw);
      const resetEpoch = Number(response.headers.get("x-ratelimit-reset") || 0);
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      const message = typeof json?.message === "string" ? json.message : "";
      return {
        status: response.status,
        ok: response.ok,
        notModified: response.status === 304,
        json,
        etag: response.headers.get("etag") || "",
        rateRemaining: Number.isFinite(remaining) ? remaining : -1,
        rateResetEpoch: Number.isFinite(resetEpoch) ? resetEpoch : 0,
        retryAfterMs,
        rateLimited: isGitHubRateLimit(response.status, remaining, message),
        transient: response.status >= 500 || response.status === 429,
        error: response.ok || response.status === 304 ? "" : ("HTTP " + response.status)
      };
    } catch (error) {
      // Treat timeouts and transport resets as failed requests, with bounded
      // retry/backoff. They must not escape tick() and reset its fairness.
      const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      return {
        status: 0,
        ok: false,
        notModified: false,
        json: null,
        etag: "",
        rateRemaining: -1,
        rateResetEpoch: 0,
        retryAfterMs: 0,
        rateLimited: false,
        transient: true,
        error: timeout ? "request timeout" : "network request failed"
      };
    }
  }
}

export function parseState(value) {
  if (value === "queued" || value === "waiting" || value === "pending" || value === "requested") {
    return RunState.Queued;
  }
  if (value === "in_progress") return RunState.InProgress;
  if (value === "completed") return RunState.Completed;
  return RunState.Unknown;
}

export function parseConclusion(value) {
  const known = new Set(Object.values(Conclusion));
  return known.has(value) ? value : Conclusion.Unknown;
}

export function parseTimestamp(value) {
  if (!value) return 0;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : 0;
}

export function parseRun(value, repository) {
  return {
    repository,
    workflowId: Number(value.workflow_id || 0),
    workflowName: value.name || "workflow",
    runId: Number(value.id || 0),
    runNumber: Number(value.run_number || 0),
    branch: value.head_branch || "",
    event: value.event || "",
    headSha: value.head_sha || "",
    htmlUrl: value.html_url || "",
    state: parseState(value.status),
    conclusion: parseConclusion(value.conclusion),
    startedAtEpoch: parseTimestamp(value.run_started_at || value.created_at),
    updatedAtEpoch: parseTimestamp(value.updated_at),
    jobs: [],
  };
}

export function parseJob(value) {
  return {
    id: Number(value.id || 0),
    name: value.name || "job",
    runnerName: value.runner_name || "",
    htmlUrl: value.html_url || "",
    state: parseState(value.status),
    conclusion: parseConclusion(value.conclusion),
    startedAtEpoch: parseTimestamp(value.started_at),
    completedAtEpoch: parseTimestamp(value.completed_at),
    steps: (value.steps || []).map((step) => ({
      name: step.name || "step",
      number: Number(step.number || 0),
      state: parseState(step.status),
      conclusion: parseConclusion(step.conclusion),
      startedAtEpoch: parseTimestamp(step.started_at),
      completedAtEpoch: parseTimestamp(step.completed_at),
    })),
  };
}
