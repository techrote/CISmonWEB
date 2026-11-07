import assert from "node:assert/strict";
import test from "node:test";
import { Monitor } from "../src/monitor.js";
import { parseRun } from "../src/github.js";

function response(json, status = 200) {
  return {
    status, ok: status === 200, notModified: status === 304,
    json, etag: '"runs"', rateRemaining: 4000, rateResetEpoch: 0,
    rateLimited: false, error: status >= 400 ? "HTTP " + status : ""
  };
}

function rawRun(id = 1, status = "in_progress", attempt = 1) {
  const now = Date.now();
  return {
    id, name: "CI", workflow_id: 10, run_number: id,
    run_attempt: attempt, status,
    conclusion: status === "completed" ? "success" : null,
    event: "push", created_at: new Date(now - 120_000).toISOString(),
    run_started_at: new Date(now - 60_000).toISOString(),
    updated_at: new Date(now).toISOString()
  };
}

function repository(fullName = "owner/project") {
  return {
    fullName, etag: "", errors: 0, nextPollMs: 0, lastPollMs: 0,
    pollCount: 0, successfulPollCount: 0, lastSuccessAtMs: 0,
    lastResponseStatus: 0, lastActivityMs: 0, latestUpdatedEpoch: 0,
    hadActive: false, hadQueued: false
  };
}

function monitor(get) {
  const config = {
    githubToken: "test", githubOwner: "", maxRepositories: 100,
    includePatterns: [], excludePatterns: [], historyDepth: 64,
    backfillRunsPerRepo: 2, repositorySelectionMode: "all", activeAgeDays: 7,
    surfaces: [], activeSurfaceId: "focus"
  };
  const store = {
    current: config,
    async update(patch) { this.current = { ...this.current, ...patch }; return this.current; },
    publicConfig() { const { githubToken, ...safe } = this.current; return safe; }
  };
  const m = new Monitor(store, {
    samples: () => [], hasRun: () => false, recordRun: async () => true,
    setMaxPerKey() {}
  });
  m.config = config;
  m.client = { get };
  m.providerReady = true;
  m.nextDiscoveryMs = Date.now() + 600_000;
  return m;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("a tracked live run outside the latest 100 is reconciled using its authoritative run status", async () => {
  const paths = [];
  const m = monitor(async path => {
    paths.push(path);
    if (path.endsWith("/actions/runs?per_page=100")) {
      return response({ workflow_runs: Array.from({ length: 100 }, (_, i) => rawRun(i + 2, "completed")) });
    }
    if (path.endsWith("/actions/runs/1")) return response(rawRun(1, "completed"));
    return response({ total_count: 0, jobs: [] });
  });
  const repo = repository();
  m.repositories = [repo];
  m.tracker.upsert(parseRun(rawRun(), repo.fullName), Date.now());

  await m.pollRepository(repo, Date.now());
  assert.equal(repo.hadActive, true, "a truncated list cannot revoke an existing live observation");
  await m.tick();
  assert.equal(paths.length, 2, "reconciliation consumes one existing scheduler request slot");
  assert.match(paths[1], /\/actions\/runs\/1$/);
  assert.equal(m.tracker.find(repo.fullName, 1).snapshot.state, "completed");
  assert.equal(m.state().trackedActiveCount, 0);
  assert.equal(m.activeDetailNextMs.has(repo.fullName + "#1"), false);
  assert.ok(m.backfill.some(run => run.runId === 1));
});

test("404 and transient reconciliation errors retain evidence, back off and expose stale status", async () => {
  let status = 404;
  const paths = [];
  const m = monitor(async path => {
    paths.push(path);
    if (path.includes("?per_page=100") && !path.includes("/jobs")) return response({ workflow_runs: [] });
    if (path.endsWith("/actions/runs/1")) return response(null, status);
    return response({ total_count: 0, jobs: [] });
  });
  const repo = repository();
  m.repositories = [repo];
  m.tracker.upsert(parseRun(rawRun(1, "queued"), repo.fullName), Date.now() - 180_000);
  await m.pollRepository(repo, Date.now());
  await m.tick();
  assert.equal(m.tracker.find(repo.fullName, 1).snapshot.state, "queued");
  assert.match(m.state().lastError, /run:.*HTTP 404/);
  assert.equal(m.state().syncStatus, "stale", "fresh list replies cannot refresh an absent run");
  assert.ok(m.runReconciliations.get(repo.fullName + "#1").nextPollMs > Date.now());
  m.nextRequestAllowedMs = 0;
  await m.tick();
  assert.match(paths.at(-1), /\/jobs\?/);
  assert.equal(m.tracker.find(repo.fullName, 1).snapshot.state, "queued");
  // Jobs completing or disappearing is not proof that the parent completed.
  status = 502;
  m.runReconciliations.get(repo.fullName + "#1").nextPollMs = 0;
  m.activeDetailNextMs.set(repo.fullName + "#1", 0);
  m.nextRequestAllowedMs = 0;
  await m.tick();
  assert.equal(m.tracker.find(repo.fullName, 1).snapshot.state, "queued");
  assert.match(m.state().lastError, /run:.*HTTP 502/);
});

test("304 list replies preserve reconciliation until the run returns to the summary window", async () => {
  let runs = [];
  let status = 200;
  const m = monitor(async () => response({ workflow_runs: runs }, status));
  const repo = repository();
  m.repositories = [repo];
  m.tracker.upsert(parseRun(rawRun(), repo.fullName), Date.now());
  await m.pollRepository(repo, Date.now());
  assert.equal(m.runReconciliations.size, 1);
  status = 304;
  await m.pollRepository(repo, Date.now());
  assert.equal(m.runReconciliations.size, 1);
  status = 200;
  runs = [rawRun()];
  await m.pollRepository(repo, Date.now());
  assert.equal(m.runReconciliations.size, 0);
});

test("activity admission retains a known live run absent from an old summary window", async () => {
  const m = monitor(async () => response({ workflow_runs: [] }));
  m.config.repositorySelectionMode = "activity";
  const repo = repository();
  m.repositories = [repo];
  m.tracker.upsert(parseRun(rawRun(), repo.fullName), Date.now());
  await m.pollRepository(repo, Date.now());
  assert.equal(m.repositories.length, 1);
  assert.equal(m.tracker.all().length, 1);
  assert.equal(m.runReconciliations.size, 1);
});

test("an in-flight summary from the old provider configuration cannot repopulate the new monitor", async () => {
  const pending = deferred();
  const m = monitor(async path => path.startsWith("/user/repos")
    ? response([{ full_name: "new/project" }]) : pending.promise);
  const old = repository();
  m.repositories = [old];
  const oldPoll = m.pollRepository(old, Date.now());
  await m.applyConfig({ githubOwner: "new" });
  pending.resolve(response({ workflow_runs: [rawRun()] }));
  await oldPoll;
  assert.deepEqual(m.repositories.map(repo => repo.fullName), ["new/project"]);
  assert.equal(m.tracker.all().length, 0);
  assert.equal(m.backfill.length, 0);
  assert.equal(m.activeDetailNextMs.size, 0);
});

test("an old job response cannot cross a configuration change", async () => {
  const pending = deferred();
  const m = monitor(async path => path.startsWith("/user/repos")
    ? response([{ full_name: "new/project" }]) : pending.promise);
  const run = parseRun(rawRun(), "owner/project");
  m.tracker.upsert(run, Date.now());
  const oldDetail = m.serviceLiveDetail(m.tracker.find(run.repository, run.runId), Date.now());
  await m.applyConfig({ githubOwner: "new" });
  pending.resolve(response({ total_count: 1, jobs: [{ id: 101, status: "in_progress" }] }));
  await oldDetail;
  assert.equal(m.tracker.all().length, 0);
  assert.equal(m.activeDetailNextMs.size, 0);
  assert.equal(m.liveJobScans.size, 0);
});

test("catalog removal in all mode stops every poll and display entry for the removed repository", async () => {
  const m = monitor(async () => response([{ full_name: "new/project" }]));
  const old = repository();
  m.repositories = [old];
  const run = parseRun(rawRun(), old.fullName);
  m.tracker.upsert(run, Date.now());
  m.activeDetailNextMs.set(old.fullName + "#1", 0);
  m.activeDetailErrors.set(old.fullName + "#1", 2);
  m.liveJobScans.set(old.fullName + "#1", { page: 2 });
  m.queueBackfill({ ...run, state: "completed" });
  await m.discoverRepositories();
  assert.equal(m.tracker.all().length, 0);
  assert.equal(m.activeDetailNextMs.size, 0);
  assert.equal(m.activeDetailErrors.size, 0);
  assert.equal(m.liveJobScans.size, 0);
  assert.equal(m.backfill.length, 0);
  assert.equal(m.queuedBackfill.size, 0);
});

test("job reads and queued historical work are bound to a run attempt", async () => {
  const paths = [];
  const recorded = [];
  const m = monitor(async path => {
    paths.push(path);
    return response({ total_count: 0, jobs: [] });
  });
  m.history.recordRun = async run => { recorded.push(run); return true; };
  const old = parseRun(rawRun(1, "completed", 1), "owner/project");
  const current = parseRun(rawRun(1, "queued", 2), "owner/project");
  m.tracker.upsert(current, Date.now());
  m.queueBackfill(old);
  m.queueBackfill({ ...current, state: "completed" });
  assert.equal(m.backfill.length, 2);
  await m.fetchRunDetails(old, Date.now(), true);
  assert.match(paths[0], /\/actions\/runs\/1\/attempts\/1\/jobs\?/);
  assert.equal(recorded[0].runAttempt, 1);
  assert.equal(m.tracker.find(current.repository, 1).snapshot.runAttempt, 2);
  assert.equal(m.tracker.find(current.repository, 1).snapshot.state, "queued");
  await m.fetchRunDetails(current, Date.now(), false);
  assert.match(paths[1], /\/actions\/runs\/1\/attempts\/2\/jobs\?/);
});

test("display config patches do not synthesize absent fields from a stale monitor snapshot", async () => {
  const m = monitor(async () => response([]));
  const patches = [];
  m.configStore.update = async patch => {
    patches.push(patch);
    return { ...m.config, ...patch };
  };
  await m.applyDisplayConfig({ activeSurfaceId: "wallboard" });
  await m.applyDisplayConfig({ surfaces: [{ id: "mine" }] });
  assert.deepEqual(patches, [
    { activeSurfaceId: "wallboard" }, { surfaces: [{ id: "mine" }] }
  ]);
});

test("Rescan only queues offline discovery and cannot bypass a rate-limit pause", async () => {
  let calls = 0;
  const m = monitor(async () => { calls++; return response([]); });
  m.providerReady = false;
  m.rateLimitedUntilMs = Date.now() + 60_000;
  await m.refresh();
  await m.refresh();
  await m.tick();
  assert.equal(calls, 0);
  assert.equal(m.nextDiscoveryMs, 0);
});

test("a missing run which is still live alternates parent confirmation with paginated job work", async () => {
  const paths = [];
  const m = monitor(async path => {
    paths.push(path);
    if (path.endsWith("/actions/runs?per_page=100")) return response({ workflow_runs: [] });
    if (path.endsWith("/actions/runs/1")) return response(rawRun());
    return response({ total_count: 101, jobs: path.endsWith("page=1")
      ? Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, status: "completed", conclusion: "success" }))
      : [{ id: 1100, status: "in_progress", runner_id: 77, runner_name: "GitHub Actions 77" }] });
  });
  const repo = repository();
  m.repositories = [repo];
  m.tracker.upsert(parseRun(rawRun(), repo.fullName), Date.now());
  await m.pollRepository(repo, Date.now());
  await m.tick();
  assert.equal(m.runReconciliations.size, 1);
  assert.equal(m.tracker.find(repo.fullName, 1).snapshot.state, "in_progress");
  for (let i = 0; i < 2; i++) {
    m.nextRequestAllowedMs = 0;
    await m.tick();
  }
  assert.equal(paths.length, 4);
  assert.match(paths[1], /\/actions\/runs\/1$/);
  assert.match(paths[2], /\/attempts\/1\/jobs\?per_page=100&page=1$/);
  assert.match(paths[3], /\/attempts\/1\/jobs\?per_page=100&page=2$/);
  assert.equal(m.state().activeWorkers, 1);
  assert.equal(m.state().activeWorkersPartial, false);
  assert.equal(m.state().syncStatus, "online");
});

test("direct run reconciliation discovers a new attempt and discards old pagination state", async () => {
  const m = monitor(async path => path.endsWith("/actions/runs/1")
    ? response(rawRun(1, "queued", 2)) : response({ workflow_runs: [] }));
  const repo = repository();
  m.repositories = [repo];
  m.tracker.upsert({ ...parseRun(rawRun(), repo.fullName),
    jobs: [{ id: 900, state: "in_progress" }], jobsFetchedAtMs: Date.now(),
    jobsCoverageComplete: true }, Date.now());
  await m.pollRepository(repo, Date.now());
  m.liveJobScans.set(repo.fullName + "#1", { page: 2 });
  await m.tick();
  const current = m.tracker.find(repo.fullName, 1).snapshot;
  assert.equal(current.runAttempt, 2);
  assert.equal(current.state, "queued");
  assert.deepEqual(current.jobs, []);
  assert.equal(m.liveJobScans.size, 0);
  assert.equal(m.state().activeWorkers, 0);
});

test("failed backfill retries later without losing attempts or blocking subsequent work", async () => {
  const paths = [];
  let failing = true;
  const m = monitor(async path => {
    paths.push(path);
    return failing && path.includes("/runs/1/") ? response(null, 502)
      : response({ total_count: 0, jobs: [] });
  });
  const first = parseRun(rawRun(1, "completed"), "owner/project");
  const second = parseRun(rawRun(2, "completed"), "owner/project");
  m.queueBackfill(first);
  m.queueBackfill(second);
  await m.tick();
  assert.equal(m.backfill.length, 2);
  assert.equal(m.queuedBackfill.size, 2);
  assert.ok(m.backfill.find(run => run.runId === 1).backfillRetryAtMs > Date.now());
  m.nextRequestAllowedMs = 0;
  await m.tick();
  assert.match(paths[1], /\/runs\/2\/attempts\/1\/jobs\?/);
  assert.equal(m.backfill.length, 1);
  m.nextRequestAllowedMs = 0;
  await m.tick();
  assert.equal(paths.length, 2, "backoff does not hammer a failed endpoint");
  failing = false;
  m.backfill[0].backfillRetryAtMs = 0;
  await m.tick();
  assert.equal(paths.length, 3);
  assert.equal(m.backfill.length, 0);
  assert.equal(m.queuedBackfill.size, 0);
});

test("history checks include run attempt so a successful first attempt cannot suppress rerun backfill", async () => {
  const m = monitor(async path => path.endsWith("?per_page=100")
    ? response({ workflow_runs: [rawRun(1, "completed", 2)] })
    : response({ total_count: 0, jobs: [] }));
  const checked = [];
  m.history.hasRun = (repo, id, attempt = 1) => { checked.push(attempt); return attempt === 1; };
  const repo = repository();
  m.repositories = [repo];
  await m.pollRepository(repo, Date.now());
  assert.equal(m.backfill.length, 1);
  await m.tick();
  assert.deepEqual(checked, [2, 2]);
  assert.equal(m.backfill.length, 0);
});

test("overlapping provider saves serialize discovery and a failed save leaves current monitoring intact", async () => {
  const firstDiscovery = deferred();
  const discoveries = [];
  const m = monitor(async () => {
    discoveries.push(m.config.githubOwner);
    return discoveries.length === 1 ? firstDiscovery.promise : response([{ full_name: "second/project" }]);
  });
  const first = m.applyConfig({ githubOwner: "first" });
  const second = m.applyConfig({ githubOwner: "second" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(discoveries, ["first"]);
  assert.equal(m.pendingProviderUpdates, 2);
  firstDiscovery.resolve(response([{ full_name: "first/project" }]));
  await Promise.all([first, second]);
  assert.deepEqual(discoveries, ["first", "second"]);
  assert.equal(m.config.githubOwner, "second");
  assert.deepEqual(m.repositories.map(repo => repo.fullName), ["second/project"]);
  assert.equal(m.pendingProviderUpdates, 0);
  const generation = m.providerGeneration;
  m.configStore.update = async () => { throw new Error("write failed"); };
  await assert.rejects(m.applyConfig({ githubOwner: "lost" }), /write failed/);
  assert.equal(m.providerGeneration, generation);
  assert.equal(m.pendingProviderUpdates, 0);
  assert.deepEqual(m.repositories.map(repo => repo.fullName), ["second/project"]);
});

test("a failed history write retains backfill for bounded retry and clears its warning on recovery", async () => {
  const m = monitor(async () => response({ total_count: 0, jobs: [] }));
  let fail = true;
  let recorded = 0;
  m.history.recordRun = async () => {
    if (fail) throw new Error("history disk unavailable");
    recorded++;
    return true;
  };
  m.queueBackfill(parseRun(rawRun(1, "completed"), "owner/project"));
  await m.tick();
  assert.equal(m.backfill.length, 1);
  assert.equal(m.queuedBackfill.size, 1);
  assert.match(m.state().lastError, /backfill:.*history disk unavailable/);
  fail = false;
  m.backfill[0].backfillRetryAtMs = 0;
  m.nextRequestAllowedMs = 0;
  await m.tick();
  assert.equal(recorded, 1);
  assert.equal(m.backfill.length, 0);
  assert.equal(m.state().lastError, "");
});

test("a stale same-attempt list response cannot revive terminal polling flags or check targets", async () => {
  const raw = { ...rawRun(), event: "pull_request", head_sha: "a".repeat(40) };
  const m = monitor(async () => response({ workflow_runs: [raw] }));
  const repo = repository();
  m.repositories = [repo];
  m.tracker.upsert(parseRun({ ...raw, status: "completed", conclusion: "success" }, repo.fullName), Date.now());
  await m.pollRepository(repo, Date.now());
  assert.equal(m.tracker.find(repo.fullName, 1).snapshot.state, "completed");
  assert.equal(repo.hadActive, false);
  assert.equal(repo.hadQueued, false);
  assert.equal(m.activeDetailNextMs.size, 0);
  assert.equal(m.checkSnapshots.size, 0);
  assert.equal(m.runReconciliations.size, 0);
});

test("a stale direct run response cannot revive a terminal attempt confirmed while it was in flight", async () => {
  const pending = deferred();
  const m = monitor(async () => pending.promise);
  const run = parseRun(rawRun(), "owner/project");
  const tracked = m.tracker.upsert(run, Date.now());
  const key = run.repository + "#1";
  m.runReconciliations.set(key, { nextPollMs: 0, errors: 0, lastConfirmedAtMs: Date.now() });
  const reconciliation = m.serviceLiveDetail(tracked, Date.now());
  m.tracker.upsert({ ...run, state: "completed", conclusion: "success" }, Date.now());
  pending.resolve(response(rawRun()));
  await reconciliation;
  assert.equal(m.tracker.find(run.repository, 1).snapshot.state, "completed");
  assert.equal(m.activeDetailNextMs.size, 0);
  assert.equal(m.checkSnapshots.size, 0);
  assert.equal(m.runReconciliations.size, 0);
});

test("check polling demotes finished SHA targets and stops refreshing targets no longer visible", async () => {
  const m = monitor(async () => response({ total_count: 0, check_runs: [] }));
  const raw = { ...rawRun(), event: "pull_request", head_sha: "a".repeat(40) };
  const run = parseRun(raw, "owner/project");
  m.tracker.upsert(run, Date.now());
  m.enqueueCheckTarget(run);
  const target = m.dueCheckTarget(Date.now());
  assert.equal(target.active, true);
  await m.pollCheckTarget(target);
  assert.ok(target.nextPollMs < Date.now() + 100_000);

  m.tracker.upsert({ ...run, state: "completed", conclusion: "success" }, Date.now());
  assert.equal(m.dueCheckTarget(Date.now()), target, "completion triggers one prompt final refresh");
  assert.equal(target.active, false);
  await m.pollCheckTarget(target);
  assert.ok(target.nextPollMs >= Date.now() + 599_000);

  const future = Date.now() + 3_601_000;
  m.tracker.prune(future);
  assert.equal(m.dueCheckTarget(future), null, "old commit SHAs cannot keep consuming requests after rows expire");
  assert.equal(target.active, false);
});

test("checks remain active while any workflow for the SHA is live, and reruns resume polling promptly", async () => {
  const m = monitor(async () => response({ total_count: 0, check_runs: [] }));
  const raw = { ...rawRun(), event: "pull_request", head_sha: "a".repeat(40) };
  const first = parseRun(raw, "owner/project");
  const second = { ...first, runId: 2 };
  m.tracker.upsert(first, Date.now());
  m.tracker.upsert(second, Date.now());
  m.enqueueCheckTarget(first);
  const target = m.dueCheckTarget(Date.now());
  m.tracker.upsert({ ...first, state: "completed", conclusion: "success" }, Date.now());
  assert.equal(m.dueCheckTarget(Date.now()), target);
  assert.equal(target.active, true);
  m.tracker.upsert({ ...second, state: "completed", conclusion: "success" }, Date.now());
  m.dueCheckTarget(Date.now());
  assert.equal(target.active, false);
  await m.pollCheckTarget(target);
  const rerun = { ...second, runAttempt: 2, state: "queued" };
  m.tracker.upsert(rerun, Date.now());
  m.enqueueCheckTarget(rerun);
  assert.equal(m.dueCheckTarget(Date.now()), target);
  assert.equal(target.active, true);
});
