import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GitHubClient, isGitHubRateLimit, parseRetryAfter } from "../src/github.js";
import { AttentionLevel, Conclusion, RunState } from "../src/core/model.js";
import { RuntimeAnalyzer } from "../src/core/analyzer.js";
import { buildDashboard } from "../src/core/dashboard.js";
import { RunTracker } from "../src/core/tracker.js";
import { Monitor } from "../src/monitor.js";
import { activityTimeFromGitHub, duePriorityRepository } from "../src/scheduler.js";

function repository(fullName = "techrote/sandfall", values = {}) {
  return {
    fullName, etag: "", errors: 0, nextPollMs: 0, lastPollMs: 0,
    pollCount: 0, successfulPollCount: 0, lastSuccessAtMs: 0,
    lastResponseStatus: 0, lastActivityMs: 0, latestUpdatedEpoch: 0,
    hadActive: false, hadQueued: false, ...values
  };
}

function monitorWithClient(get) {
  const monitor = new Monitor({},
    { samples: () => [], hasRun: () => false, recordRun: async () => true });
  monitor.client = { get };
  monitor.config = { backfillRunsPerRepo: 0 };
  monitor.providerReady = true;
  monitor.nextDiscoveryMs = Date.now() + 10 * 60000;
  return monitor;
}

function response(status, json = null, extras = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    notModified: status === 304,
    json,
    etag: '"etag"',
    rateRemaining: 4237,
    rateResetEpoch: 0,
    retryAfterMs: 0,
    rateLimited: false,
    error: status >= 400 ? "HTTP " + status : "",
    ...extras
  };
}

test("GitHub requests have a bounded timeout and return a retryable failure", async () => {
  const neverFinishes = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(
      Object.assign(new Error("timed out"), { name: "TimeoutError" })
    ), { once: true });
  });
  const client = new GitHubClient(() => "", neverFinishes, 30);
  const start = Date.now();
  const result = await client.get("/repos/techrote/sandfall/actions/runs");
  assert.ok(Date.now() - start < 1000);
  assert.equal(result.status, 0);
  assert.equal(result.transient, true);
  assert.equal(result.error, "request timeout");
  assert.equal(result.rateLimited, false);
});

test("HTTP 502 with ample quota is not a rate limit; retry-after and 403 are classified", async () => {
  const client = new GitHubClient(() => "token", async () =>
    new Response(JSON.stringify({ message: "Bad Gateway" }), {
      status: 502,
      headers: { "x-ratelimit-remaining": "4237", "x-ratelimit-reset": "2000000000" }
    })
  );
  const result = await client.get("/test");
  assert.equal(result.status, 502);
  assert.equal(result.rateRemaining, 4237);
  assert.equal(result.rateLimited, false);
  assert.equal(result.transient, true);
  assert.equal(isGitHubRateLimit(403, 4237, "Resource not accessible by integration"), false);
  assert.equal(isGitHubRateLimit(403, 4237, "secondary rate limit exceeded"), true);
  assert.equal(isGitHubRateLimit(429, 4237, ""), true);
  assert.equal(parseRetryAfter("30"), 30000);
  assert.equal(parseRetryAfter("nonsense"), 0);
});

test("first historical repository scan schedules cold polling instead of 60-second overload", async () => {
  const now = Date.now();
  assert.equal(activityTimeFromGitHub(0, now), 0);
  assert.equal(activityTimeFromGitHub(Math.floor(now / 1000) + 9999, now), now);
  assert.ok(activityTimeFromGitHub(Math.floor((now - 86_400_000) / 1000), now) <= now - 86_399_000);

  const old = new Date(now - 20 * 86_400_000).toISOString();
  const raw = {
    id: 42, workflow_id: 4, name: "CI", status: "completed",
    conclusion: "success", run_number: 2, event: "push",
    created_at: old, updated_at: old, run_started_at: old
  };
  const m = monitorWithClient(async () => response(200, { workflow_runs: [raw] }));
  const repo = repository();
  m.repositories = [repo];
  assert.equal(await m.pollRepository(repo, now), true);
  assert.equal(repo.successfulPollCount, 1);
  assert.equal(repo.lastResponseStatus, 200);
  assert.ok(repo.nextPollMs - now >= 299_000); // cold: 300 seconds
  assert.ok(repo.lastActivityMs < now - 19 * 86_400_000);
  assert.equal(m.state().scannedRepositoryCount, 1);
});

test("live status summaries take priority without starving due background repos", () => {
  const now = Date.now();
  const live = repository("a/live", { hadActive: true, nextPollMs: now - 1000 });
  const cold = repository("b/idle", { nextPollMs: now - 200000 });
  assert.equal(duePriorityRepository([cold, live], now, 0, 2), live);
  assert.equal(duePriorityRepository([cold, live], now, 1, 2), live);
  assert.equal(duePriorityRepository([cold, live], now, 2, 2), cold);
});

test("a transient jobs 502 does not block the next repository status request or pause quota", async () => {
  const requests = [];
  const m = monitorWithClient(async (path) => {
    requests.push(path);
    return path.includes("/jobs") ? response(502) : response(304);
  });
  const repo = repository("techrote/ezDarkFactory", { hadActive: true });
  m.repositories = [repo];
  m.tracker.upsert({
    repository: "techrote/ezDarkFactory", runId: 85, workflowId: 7,
    workflowName: "CI", state: RunState.InProgress,
    conclusion: Conclusion.Unknown, jobs: []
  }, Date.now());
  m.activeDetailNextMs.set("techrote/ezDarkFactory#85", 0);
  await m.tick();
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/jobs/);
  assert.equal(m.activeDetailErrors.get("techrote/ezDarkFactory#85"), 1);
  assert.ok(m.activeDetailNextMs.get("techrote/ezDarkFactory#85") > Date.now());
  assert.equal(m.rateLimitedUntilMs, 0);
  assert.match(m.state().lastError, /HTTP 502/);
  m.nextRequestAllowedMs = 0;
  await m.tick();
  assert.equal(requests.length, 2);
  assert.match(requests[1], /actions\/runs/);
  assert.equal(repo.successfulPollCount, 1);
  // A different successful endpoint cannot falsely erase the active-job failure.
  assert.match(m.state().lastError, /jobs:.*HTTP 502/);
});

test("the same job endpoint recovering clears its transient warning and retry backoff", async () => {
  let responseMode = 502;
  const m = monitorWithClient(async () =>
    responseMode === 502 ? response(502) : response(200, { jobs: [] }));
  const run = {
    repository: "techrote/ezDarkFactory", runId: 85,
    state: RunState.InProgress, conclusion: Conclusion.Unknown, jobs: [],
    workflowId: 7, workflowName: "CI"
  };
  assert.equal(await m.fetchRunDetails(run, Date.now(), false), false);
  assert.match(m.state().lastError, /HTTP 502/);
  responseMode = 200;
  assert.equal(await m.fetchRunDetails(run, Date.now(), false), true);
  assert.equal(m.state().lastError, "");
});

test("sync status exposes stale summary age instead of claiming fresh based on UI refresh", () => {
  const m = monitorWithClient(async () => response(304));
  const repo = repository("techrote/sandfall", {
    hadActive: true, successfulPollCount: 1,
    lastSuccessAtMs: Date.now() - 150_000
  });
  m.repositories = [repo];
  assert.equal(m.state().syncStatus, "stale");
  assert.ok(m.state().oldestLiveSummaryAgeMs > 90_000);
  m.updateRate(response(502), Date.now());
  assert.equal(m.rateLimitedUntilMs, 0);
  m.updateRate(response(429, null, { rateLimited: true, retryAfterMs: 120000 }), Date.now());
  assert.equal(m.state().syncStatus, "rate_limited");
});

test("queue wait never compares against runtime baseline and cannot become a stall", () => {
  const samples = Array.from({ length: 10 }, () => ({ successful: true, durationMs: 10000 }));
  const history = { samples: () => samples };
  const analyzer = new RuntimeAnalyzer(history);
  const tracker = new RunTracker();
  tracker.upsert({
    repository: "techrote/greygen", workflowId: 12, runId: 55,
    workflowName: "Build", event: "push", runNumber: 15,
    state: RunState.Queued, conclusion: Conclusion.Unknown,
    startedAtEpoch: 1000, updatedAtEpoch: 0,
    jobs: [{ state: RunState.Queued, name: "job", startedAtEpoch: 1000, completedAtEpoch: 0 }]
  }, 1000000);
  const rows = buildDashboard(tracker, analyzer, 2000000, 2000, 10);
  assert.equal(rows[0].state, RunState.Queued);
  assert.equal(rows[0].attention, AttentionLevel.Normal);
  assert.equal(rows[0].possiblyStalled, false);
  assert.equal(rows[0].ratio, 0);
  assert.equal(rows[0].estimatedRemainingMs, 0);
  assert.equal(rows[0].elapsedMs, 1000000); // time waiting, not executed
});

test("the populated empty-state panel must remain hidden", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="syncAge"/);
  assert.match(html, /id="syncBanner"/);
});


test("catalog refresh preserves ETags, poll clocks and live states while admitting new repositories", async () => {
  let failCatalog = false;
  const m = monitorWithClient(async (path) => {
    assert.match(path, /^\/user\/repos/);
    return failCatalog ? response(502) : response(200, [
      { full_name: "techrote/sandfall" },
      { full_name: "techrote/new-project" }
    ]);
  });
  m.config = {
    ...m.config, githubToken: "test", githubOwner: "techrote",
    includePatterns: [], excludePatterns: [], maxRepositories: 100
  };
  const old = repository("techrote/sandfall", {
    etag: '"old-etag"', lastSuccessAtMs: Date.now() - 4000,
    nextPollMs: Date.now() + 60000, successfulPollCount: 6,
    hadActive: true
  });
  m.repositories = [old];
  assert.equal(await m.discoverRepositories(), true);
  assert.equal(m.repositories.length, 2);
  assert.equal(m.repositories[0], old);
  assert.equal(m.repositories[0].etag, '"old-etag"');
  assert.equal(m.repositories[0].successfulPollCount, 6);
  assert.deepEqual(m.fastSweepQueue, ["techrote/new-project"]);
  assert.ok(m.nextDiscoveryMs > Date.now() + 9 * 60000);

  failCatalog = true;
  assert.equal(await m.discoverRepositories(), false);
  assert.equal(m.providerReady, true);
  assert.equal(m.repositories.length, 2);
  assert.equal(m.repositories[0], old);
  assert.deepEqual(m.fastSweepQueue, ["techrote/new-project"]);
});
