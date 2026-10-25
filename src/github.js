import { Conclusion, RunState } from "./core/model.js";

export class GitHubClient {
  constructor(tokenProvider) {
    this.tokenProvider = tokenProvider;
  }

  async get(apiPath, etag = "") {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "CISmonWEB",
    };
    const token = this.tokenProvider();
    if (token) headers.Authorization = "Bearer " + token;
    if (etag) headers["If-None-Match"] = etag;

    const response = await fetch("https://api.github.com" + apiPath, { headers });
    let json = null;
    if (response.status !== 304) {
      const text = await response.text();
      if (text) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
    }

    return {
      status: response.status,
      ok: response.ok,
      notModified: response.status === 304,
      json,
      etag: response.headers.get("etag") || "",
      rateRemaining: Number(response.headers.get("x-ratelimit-remaining") ?? -1),
      rateResetEpoch: Number(response.headers.get("x-ratelimit-reset") ?? 0),
    };
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
