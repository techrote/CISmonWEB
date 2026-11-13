import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigStore, DEFAULT_CONFIG } from "../src/config-store.js";
import { InteractionStore } from "../src/interaction-store.js";
import { Monitor } from "../src/monitor.js";
import { parseRun } from "../src/github.js";
import { PR_SETTLE_MS, summarizePrEvidence } from "../src/completion-provider.js";

const repository = "owner/project";
const head = "a".repeat(40), otherHead = "b".repeat(40), merge = "c".repeat(40);
const response = (json, status = 200, extra = {}) => ({ status, ok: status === 200, notModified: status === 304,
  json, rateRemaining: 4000, etag: "", rateLimited: false, error: status >= 400 ? "HTTP " + status : "", ...extra });

async function fixture(t) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cismon-completion-provider-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const interactions = new InteractionStore(dataDir);
  await interactions.load();
  const configStore = new ConfigStore(dataDir);
  const monitor = new Monitor(configStore, { samples: () => [], hasRun: () => true, recordRun: async () => {}, setMaxPerKey() {} }, interactions);
  monitor.config = { ...DEFAULT_CONFIG, githubToken: "fixture", repositorySelectionMode: "all" };
  monitor.providerReady = true;
  monitor.nextDiscoveryMs = now + 1_000_000;
  const control = { head, merge: "", state: "in_progress", conclusion: "success", attempt: 1, failurePath: "", failures: 403,
    partialChecks: false, noChecks: false, statusPending: false, checkCount: 2, workflowCount: 2, prState: "open", completedAtMs: now - 10_000,
    required: [], rules: [], dormantSuite: false, perSha: {} };
  const paths = [];
  function rawRun(overrides = {}) {
    return {
      id: 101, workflow_id: 1, name: "CI", run_number: 3, run_attempt: control.attempt,
      head_sha: control.head, head_branch: "feature", status: control.state,
      conclusion: control.state === "completed" ? control.conclusion : null,
      check_suite_id: 11, event: "pull_request", html_url: `https://github.com/${repository}/actions/runs/101`,
      created_at: new Date(now - 120_000).toISOString(), updated_at: new Date(now).toISOString(),
      pull_requests: [{ number: 7, head: { sha: control.head } }], ...overrides
    };
  }
  function pr(number = 7) { return { number, state: control.prState, merged: control.prState === "closed",
    base: { ref: "main", repo: { full_name: repository } }, head: { sha: control.head }, merge_commit_sha: control.merge || null }; }
  function inventories(sha) {
    const state = control.perSha[sha]?.state || control.state;
    const conclusion = control.perSha[sha]?.conclusion || control.conclusion;
    const complete = state === "completed";
    const suites = control.noChecks ? [] : Array.from({ length: control.workflowCount }, (_, i) =>
      ({ id: 11 + i, head_sha: sha, status: state, conclusion: complete ? conclusion : null,
        latest_check_runs_count: Math.floor(control.checkCount / control.workflowCount) + (i < control.checkCount % control.workflowCount ? 1 : 0) }));
    if (control.dormantSuite) suites.push({ id: 99, head_sha: sha, status: "queued", conclusion: null,
      latest_check_runs_count: 0, app: { slug: "dormant-ci" } });
    const checks = control.noChecks ? [] : Array.from({ length: control.checkCount }, (_, i) => ({
      id: 1000 + i, name: "matrix-" + i, head_sha: sha, check_suite: { id: 11 + i % control.workflowCount },
      app: { id: 15368 },
      status: state, conclusion: complete ? conclusion : null,
      completed_at: complete ? new Date(control.completedAtMs).toISOString() : null
    }));
    return { suites, checks };
  }
  let transport = async url => {
    paths.push(url);
    if (control.failurePath && url.includes(control.failurePath)) return response(null, control.failures);
    if (/\/commits\/[a-f0-9]+\/pulls\?/.test(url)) return response([pr()]);
    if (/\/pulls\/\d+$/.test(url)) return response(pr(Number(url.match(/pulls\/(\d+)$/)[1])));
    if (/\/actions\/runs\/\d+$/.test(url)) return response(rawRun({ id: Number(url.match(/runs\/(\d+)$/)[1]) }));
    if (url.endsWith("/branches/main")) return response({ name: "main", protected: control.required.length > 0,
      protection: { required_status_checks: { contexts: control.required.map(value => value.context), checks: control.required } } });
    if (url.includes("/rules/branches/main?")) return response(control.rules);
    if (url.includes("/attempts/") && !url.includes("/jobs")) {
      return response(rawRun({ id: Number(url.match(/runs\/(\d+)/)[1]), run_attempt: Number(url.match(/attempts\/(\d+)/)[1]) }));
    }
    if (url.includes("/jobs?")) return response({ total_count: 1, jobs: [{ id: 501, run_id: Number(url.match(/runs\/(\d+)/)[1]),
      run_attempt: Number(url.match(/attempts\/(\d+)/)?.[1] || 1),
      status: control.state, conclusion: control.state === "completed" ? control.conclusion : null,
      completed_at: control.state === "completed" ? new Date(control.completedAtMs).toISOString() : null }] });
    const sha = url.match(/commits\/([a-f0-9]+)/)?.[1] || new URL("https://example.com" + url).searchParams.get("head_sha");
    const { suites, checks } = inventories(sha);
    const page = Number(new URL("https://example.com" + url).searchParams.get("page") || 1);
    if (url.includes("/check-suites?")) return response({ total_count: suites.length, check_suites: suites.slice((page - 1) * 100, page * 100) });
    if (url.includes("/check-runs?")) return response({ total_count: control.partialChecks ? 200 : checks.length,
      check_runs: checks.slice((page - 1) * 100, page * 100) });
    if (url.includes("/status?")) return response({ sha, total_count: control.statusPending ? 1 : 0,
      state: "pending", statuses: control.statusPending ? [{ id: 1, context: "external", state: "pending" }] : [] });
    if (url.includes("/actions/runs?head_sha=")) return response({ total_count: control.noChecks ? 0 : 1,
      ...(control.noChecks ? {} : { total_count: control.workflowCount }),
      workflow_runs: control.noChecks ? [] : Array.from({ length: control.workflowCount }, (_, i) =>
        rawRun({ id: 101 + i, head_sha: sha, workflow_id: 1 + i, check_suite_id: 11 + i,
          status: control.perSha[sha]?.state || control.state,
          conclusion: (control.perSha[sha]?.state || control.state) === "completed" ? control.perSha[sha]?.conclusion || control.conclusion : null })) });
    if (url.includes("/actions/runs?")) return response({ workflow_runs: [rawRun()] });
    throw new Error("unexpected production request " + url);
  };
  monitor.client = { get: (url, etag) => transport(url, etag) };
  return {
    monitor, interactions, dataDir, control, paths, rawRun,
    now: () => now, advance: ms => { now += ms; },
    setTransport: fn => { transport = fn; }, defaultTransport: () => transport,
    async tick() { now += 1100; await monitor.tick(); },
    async prCycle() {
      const before = interactions.publicState().subscriptions.find(sub => sub.type === "pr");
      const task = monitor.completions.prTasks.get(before.id) || (monitor.completions.due(now), monitor.completions.prTasks.get(before.id));
      now = Math.max(now, task.nextPollMs);
      let began = Boolean(task.scan);
      for (let i = 0; i < 100; i++) {
        now += 1100; await monitor.tick();
        began ||= Boolean(task.scan);
        if (!task.scan && (began || task.nextPollMs > now)) return task;
      }
      throw new Error("PR cycle did not finish within bounded scheduler requests");
    }
  };
}

test("real Monitor scheduler plus durable store delivers one exact-attempt run event, including restart", async t => {
  const f = await fixture(t);
  const run = parseRun(f.rawRun(), repository);
  await f.interactions.armRun(run);
  await f.tick();
  assert.equal(f.interactions.targets().subscriptions[0].seenActive, true);
  const restored = new InteractionStore(f.dataDir);
  await restored.load();
  f.monitor.interactions = restored;
  f.monitor.completions.interactions = restored;
  f.monitor.completions.reset();
  f.control.state = "completed";
  f.control.completedAtMs = f.now() + 1000;
  for (let i = 0; i < 5; i++) await f.tick();
  const events = restored.publicState().events;
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "success");
  assert.equal(events[0].runAttempt, 1);
  f.control.attempt = 2;
  f.monitor.tracker.upsert(parseRun(f.rawRun(), repository), f.now());
  for (let i = 0; i < 5; i++) await f.tick();
  assert.equal(restored.publicState().events.length, 1);
  assert.ok(f.paths.some(url => url.endsWith("/actions/runs/101/attempts/1")));
  assert.ok(f.paths.some(url => url.includes("/attempts/1/jobs?")));
});

test("fast run completion needs exact-attempt completed_at proof, not merely a changed updated_at", async t => {
  const f = await fixture(t);
  await f.interactions.armRun(parseRun(f.rawRun(), repository));
  f.control.state = "completed";
  f.control.completedAtMs = f.now() + 500;
  for (let i = 0; i < 5; i++) await f.tick();
  assert.equal(f.interactions.publicState().events.length, 1);
  assert.equal(f.interactions.publicState().events[0].outcome, "success");
  await f.interactions.armRun(parseRun(f.rawRun({ id: 102, status: "in_progress", conclusion: null }), repository));
  f.setTransport(async () => response(f.rawRun({ id: 101 })));
  const second = f.monitor.completions.due(f.now());
  // The endpoint returns a mismatched ID; a stale terminal response cannot
  // silently satisfy another identity, regardless of its fresh updated_at.
  await f.monitor.completions.service(second);
  assert.equal(f.interactions.publicState().events.length, 1);
  assert.equal(f.interactions.targets().subscriptions[0].phase, "indeterminate");
});

test("an already finished attempt hidden behind a stale live UI never chimes retrospectively", async t => {
  const f = await fixture(t);
  await f.interactions.armRun(parseRun(f.rawRun(), repository));
  f.control.state = "completed";
  for (let i = 0; i < 5; i++) await f.tick();
  assert.equal(f.interactions.publicState().events.length, 0);
  assert.equal(f.interactions.publicState().subscriptions[0].status, "invalidated");
});

for (const conclusion of ["failure", "timed_out", "cancelled", "neutral", "skipped", "unknown"]) {
  test(`exact run ${conclusion} receives an explicit outcome rather than false success`, async t => {
    const f = await fixture(t);
    await f.interactions.armRun(parseRun(f.rawRun(), repository));
    await f.tick();
    f.advance(25_000);
    f.control.state = "completed"; f.control.conclusion = conclusion; f.control.completedAtMs = f.now();
    for (let i = 0; i < 5; i++) await f.tick();
    const event = f.interactions.publicState().events[0];
    assert.ok(event);
    assert.equal(event.outcome, ["neutral", "skipped"].includes(conclusion) ? "neutral" : conclusion === "cancelled" ? "cancelled" : conclusion === "unknown" ? "indeterminate" : "failure");
  });
}

test("pin rehydration retains prior attempts through TTL, reruns, restart and inaccessible responses without watching", async t => {
  const f = await fixture(t);
  const run = parseRun(f.rawRun({ status: "completed", conclusion: "success", updated_at: new Date(f.now() - 7200_000).toISOString() }), repository);
  await f.interactions.setPin(run, { surfaceId: "focus", paneId: "main" });
  f.monitor.tracker.upsert(run, f.now());
  f.monitor.tracker.prune(f.now());
  assert.equal(f.monitor.tracker.all().length, 1);
  assert.equal(f.monitor.tracker.all()[0].manualWatch, false);
  assert.equal(f.monitor.state().rows[0].retainedOnly, true, "expired pinned rows must not leak into another pane's ordinary candidates");
  f.monitor.tracker.upsert({ ...run, runAttempt: 2, state: "in_progress", conclusion: "unknown" }, f.now());
  const before = f.monitor.state().rows;
  assert.ok(before.some(row => row.runAttempt === 1));
  assert.ok(before.some(row => row.runAttempt === 2));
  f.control.failurePath = "/attempts/1"; f.control.failures = 404;
  await f.tick(); await f.tick();
  const pin = f.interactions.publicState().pins[0];
  assert.equal(pin.status, "unavailable");
  assert.equal(f.monitor.state().rows.find(row => row.runAttempt === 1).providerUnavailable, true);
  assert.equal(f.monitor.tracker.find(repository, 101).snapshot.runAttempt, 2);
  const detail = f.monitor.detail(repository, 101, 1);
  assert.equal(detail.runAttempt, 1);
  assert.equal(detail.actionsAvailable, false);
  assert.equal(f.monitor.detail(repository, 101, 2).actionsAvailable, true);
  assert.equal(f.monitor.state().rows.find(row => row.runAttempt === 1).actionsAvailable, false);
  assert.equal(f.monitor.state().rows.find(row => row.runAttempt === 1).retainedOnly, true);
});

test("a paginated multi-workflow/matrix PR completes only after two stable whole-inventory scans", async t => {
  const f = await fixture(t);
  f.control.checkCount = 102;
  await f.interactions.armPr(repository, 7);
  await f.prCycle();
  assert.equal(f.interactions.targets().subscriptions[0].seenActive, true);
  f.control.state = "completed"; f.control.completedAtMs = f.now() + 100;
  const first = await f.prCycle();
  assert.ok(first.candidate);
  assert.equal(f.interactions.publicState().events.length, 0);
  await f.prCycle();
  const state = f.interactions.publicState();
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].type, "pr");
  assert.equal(state.events[0].outcome, "success");
  assert.equal(state.events[0].headSha, head);
  assert.ok(f.paths.some(url => url.includes("/check-runs?") && url.endsWith("page=2")));
  assert.ok(f.paths.some(url => url.includes("/status?")));
  assert.ok(f.paths.some(url => url.includes("/check-suites?")));
  assert.ok(f.paths.some(url => url.includes("/actions/runs?head_sha=")));
  assert.equal(f.interactions.targets().subscriptions.length, 0);
});

for (const situation of ["partial", "checks permission", "statuses permission", "empty", "pending status", "unclassified"]) {
  test(`PR ${situation} evidence never becomes a successful completion`, async t => {
    const f = await fixture(t);
    await f.interactions.armPr(repository, 7);
    if (situation === "partial") f.control.partialChecks = true;
    if (situation === "checks permission") f.control.failurePath = "/check-suites?";
    if (situation === "statuses permission") f.control.failurePath = "/status?";
    if (situation === "empty") f.control.noChecks = true;
    if (situation === "pending status") f.control.statusPending = true;
    f.control.state = "completed";
    if (situation === "unclassified") f.control.conclusion = "unknown";
    for (let i = 0; i < 2; i++) await f.prCycle();
    assert.equal(f.interactions.publicState().events.length, 0);
    assert.equal(f.interactions.targets().subscriptions.length, 1);
    if (situation !== "pending status") assert.equal(f.interactions.targets().subscriptions[0].seenActive, false);
  });
}

test("head replacement during the final confirmation rejects old-head success and follows the new head", async t => {
  const f = await fixture(t);
  await f.interactions.armPr(repository, 7);
  await f.prCycle();
  f.control.state = "completed"; f.control.completedAtMs = f.now() + 100;
  const first = await f.prCycle();
  assert.ok(first.candidate);
  f.advance(PR_SETTLE_MS + 1000);
  while (first.scan?.stage !== "confirm") await f.tick();
  f.control.head = otherHead;
  await f.tick();
  assert.equal(f.interactions.publicState().events.length, 0);
  assert.equal(f.interactions.targets().subscriptions[0].headSha, otherHead);
  f.control.state = "in_progress";
  await f.prCycle();
  f.control.state = "completed"; f.control.conclusion = "failure"; f.control.completedAtMs = f.now() + 100;
  await f.prCycle(); await f.prCycle();
  const event = f.interactions.publicState().events[0];
  assert.equal(event.headSha, otherHead);
  assert.equal(event.outcome, "failure");
});

test("closed/merged PR alone is not completion; merge SHA check coverage remains independent", async t => {
  const f = await fixture(t);
  f.control.merge = merge;
  await f.interactions.armPr(repository, 7);
  await f.prCycle();
  assert.ok(f.paths.some(url => url.includes("commits/" + merge + "/check-runs")));
  f.control.prState = "closed";
  await f.prCycle();
  assert.equal(f.interactions.publicState().events.length, 0);
  assert.equal(f.interactions.targets().subscriptions[0].seenActive, true);
});

test("association lookup is lazy, exhaustive, cached and keeps multiple PRs ambiguous", async t => {
  const f = await fixture(t);
  const run = parseRun(f.rawRun(), repository);
  f.monitor.tracker.upsert(run, f.now());
  assert.equal(f.paths.length, 0);
  assert.equal(f.monitor.state().rows[0].prAssociation.status, "unknown");
  assert.equal(f.monitor.requestPrAssociation(run).status, "pending");
  await f.tick(); await f.tick();
  assert.equal(f.monitor.state().rows[0].prAssociation.status, "resolved");
  assert.equal(f.monitor.state().rows[0].prAssociation.number, 7);
  const count = f.paths.length;
  f.monitor.requestPrAssociation(run);
  assert.equal(f.paths.length, count, "opening the menu never performs an immediate unbudgeted request");
  f.monitor.completions.reset();
  f.setTransport(async url => response([
    { number: 7, base: { repo: { full_name: repository } }, head: { sha: head } },
    { number: 8, base: { repo: { full_name: repository } }, head: { sha: head } }
  ]));
  f.monitor.requestPrAssociation(run);
  await f.monitor.completions.service(f.monitor.completions.due(f.now()));
  assert.equal(f.monitor.state().rows[0].prAssociation.status, "ambiguous");
});

test("a cancelled/rearmed subscription rejects an in-flight previous generation", async t => {
  const f = await fixture(t);
  await f.interactions.armRun(parseRun(f.rawRun(), repository));
  await f.tick();
  f.advance(25_000);
  f.control.state = "completed"; f.control.completedAtMs = f.now();
  const task = f.monitor.completions.due(f.now());
  await f.monitor.completions.service(task); // exact terminal summary; jobs follow
  const sub = f.interactions.targets().subscriptions[0];
  await f.interactions.cancel("run", sub, sub.generation);
  await f.interactions.armRun(parseRun(f.rawRun({ status: "in_progress", conclusion: null }), repository));
  await f.monitor.completions.service(task);
  assert.equal(f.interactions.publicState().events.length, 0);
  assert.equal(f.interactions.targets().subscriptions[0].phase, "verifying");
});

test("304 revalidation uses cached pages and provider configuration changes cannot repopulate caches", async t => {
  const f = await fixture(t);
  const provider = f.monitor.completions;
  let call = 0;
  f.setTransport(async () => ++call === 1 ? response({ value: 7 }, 200, { etag: '"one"' }) : response(null, 304));
  assert.equal((await provider.request("/fixture")).json.value, 7);
  assert.equal((await provider.request("/fixture")).json.value, 7);
  let resolve;
  f.setTransport(() => new Promise(done => { resolve = done; }));
  const pending = provider.request("/old-provider");
  f.monitor.providerGeneration++;
  provider.reset();
  resolve(response({ old: true }, 200, { etag: '"old"' }));
  await pending;
  assert.equal(provider.cache.size, 0);
});

test("suite, workflow and child outcomes stay separate; stale all-green children cannot complete a live parent", () => {
  const evidence = summarizePrEvidence({ headSha: head, sources: [{ sha: head,
    suites: [{ id: 11, head_sha: head, status: "in_progress", conclusion: null }],
    checks: [{ id: 101, head_sha: head, name: "child", check_suite: { id: 11 }, status: "completed", conclusion: "success" }],
    workflows: [{ id: 1, head_sha: head, run_attempt: 1, check_suite_id: 11, status: "queued", conclusion: null }],
    statuses: [], combinedState: "pending" }] });
  assert.equal(evidence.complete, true);
  assert.equal(evidence.terminal, false);
});

for (const source of ["classic", "ruleset", "app mismatch", "required workflow", "branch permission", "rules permission", "dormant suite"]) {
  test(`PR required coverage: ${source} prevents unverified success`, async t => {
    const f = await fixture(t);
    await f.interactions.armPr(repository, 7);
    await f.prCycle();
    f.control.state = "completed";
    f.control.completedAtMs = f.now() + 100;
    if (source === "classic") f.control.required = [{ context: "not-created", app_id: -1 }];
    if (source === "ruleset") f.control.rules = [{ type: "required_status_checks", ruleset_id: 1,
      parameters: { required_status_checks: [{ context: "not-created", integration_id: null }] } }];
    if (source === "app mismatch") f.control.required = [{ context: "matrix-0", app_id: 99 }];
    if (source === "required workflow") f.control.rules = [{ type: "workflows", ruleset_id: 2,
      parameters: { workflows: [{ path: ".github/workflows/external.yml", repository_id: 2 }] } }];
    if (source === "branch permission") f.control.failurePath = "/branches/main";
    if (source === "rules permission") f.control.failurePath = "/rules/";
    if (source === "dormant suite") f.control.dormantSuite = true;
    await f.prCycle(); await f.prCycle();
    assert.equal(f.interactions.publicState().events.length, 0);
    assert.equal(f.interactions.targets().subscriptions.length, 1);
    if (source === "dormant suite") assert.match(f.interactions.targets().subscriptions[0].reason, /dormant-ci suite 99 \(no child checks created\)/);
  });
}

test("matching required contexts and app identities can complete after stable evidence", async t => {
  const f = await fixture(t);
  f.control.required = [{ context: "matrix-0", app_id: 15368 }];
  f.control.rules = [{ type: "required_status_checks", ruleset_id: 1,
    parameters: { required_status_checks: [{ context: "matrix-1", integration_id: 15368 }] } }];
  await f.interactions.armPr(repository, 7);
  await f.prCycle();
  f.control.state = "completed"; f.control.completedAtMs = f.now() + 100;
  await f.prCycle(); await f.prCycle();
  assert.equal(f.interactions.publicState().events[0].outcome, "success");
});

test("PR scan cap and inconsistent pagination never masquerade as complete coverage", async t => {
  const f = await fixture(t);
  await f.interactions.armPr(repository, 7);
  const normal = f.defaultTransport();
  f.setTransport(async url => url.includes("/check-runs?")
    ? response({ total_count: 1001, check_runs: [] }) : normal(url));
  await f.prCycle();
  assert.equal(f.interactions.publicState().events.length, 0);
  assert.match(f.interactions.targets().subscriptions[0].reason, /Incomplete|incomplete/);
  f.monitor.completions.reset();
  f.setTransport(async url => url.includes("/check-runs?")
    ? { ...(await normal(url)), link: '<https://api.github.com/next>; rel="next"' } : normal(url));
  await f.prCycle();
  assert.equal(f.interactions.publicState().events.length, 0);
  assert.match(f.interactions.targets().subscriptions[0].reason, /pagination contradicts/);
});

test("completion enrichment shares normal API rate/backoff and cannot starve live summaries or job detail", async t => {
  const f = await fixture(t);
  const repo = { fullName: repository, nextPollMs: 0, lastPollMs: 0, pollCount: 0,
    errors: 0, successfulPollCount: 0, hadActive: true, hadQueued: false, latestUpdatedEpoch: 0, etag: "" };
  f.monitor.repositories = [repo];
  await f.interactions.armPr(repository, 7);
  f.monitor.rateLimitedUntilMs = f.now() + 10_000;
  await f.tick();
  assert.equal(f.paths.length, 0);
  f.advance(10_000);
  for (let i = 0; i < 36; i++) {
    repo.nextPollMs = 0;
    await f.tick();
  }
  const summaries = f.paths.filter(url => /\/actions\/runs\?per_page=100$/.test(url));
  const jobs = f.paths.filter(url => url.includes("/jobs?"));
  assert.ok(summaries.length >= 10, "ordinary live summaries retain most request slots");
  assert.ok(jobs.length >= 2, "live job detail continues alongside verification");
  assert.ok(f.paths.some(url => url.endsWith("/pulls/7")), "completion verification also progresses");
  assert.ok(f.paths.length <= 36, "no multi-request fetch loop was introduced");
});

test("two PRs with merge refs finish fresh verification cycles under live load and several run subscriptions", async t => {
  const f = await fixture(t);
  f.monitor.nextDiscoveryMs = Infinity;
  f.control.merge = merge;
  const repo = { fullName: repository, nextPollMs: 0, lastPollMs: 0, pollCount: 0,
    errors: 0, successfulPollCount: 0, hadActive: true, hadQueued: false, latestUpdatedEpoch: 0, etag: "" };
  f.monitor.repositories = [repo];
  await f.interactions.armPr(repository, 7);
  await f.interactions.armPr(repository, 8);
  for (const id of [101, 102, 103]) await f.interactions.armRun(parseRun(f.rawRun({ id }), repository));
  let cycles = 0;
  let maxAge = 0;
  while (cycles++ < 700) {
    repo.nextPollMs = 0;
    // Deliberately saturate the old low-priority enrichment too: new work
    // receives only alternate enrichment slots, not an unrealistic idle host.
    for (const target of f.monitor.checkSnapshots.values()) target.nextPollMs = 0;
    await f.tick();
    const scanning = [...f.monitor.completions.prTasks.values()].filter(task => task.scan);
    assert.ok(scanning.length <= 1, "only one PR starts its inventory freshness clock at a time");
    for (const task of scanning) maxAge = Math.max(maxAge, f.now() - task.scan.startedAtMs);
    const subs = f.interactions.targets().subscriptions.filter(sub => sub.type === "pr");
    if (subs.length === 2 && subs.every(sub => sub.seenActive)) break;
  }
  assert.ok(cycles < 700, "both PRs establish a complete pending baseline under real scheduler contention");
  assert.ok(maxAge < 300_000, "continuations finish within the bounded evidence age");
  f.control.state = "completed";
  f.control.completedAtMs = f.now() + 100;
  for (let i = 0; i < 1000; i++) {
    repo.nextPollMs = 0;
    for (const target of f.monitor.checkSnapshots.values()) target.nextPollMs = 0;
    await f.tick();
    if (f.interactions.publicState().events.filter(event => event.type === "pr").length === 2) break;
  }
  const state = f.interactions.publicState();
  assert.equal(state.events.filter(event => event.type === "pr").length, 2);
  assert.equal(state.events.filter(event => event.type === "run").length, 3);
  assert.ok(state.events.every(event => event.outcome === "success"));
});

test("ETag 304 cannot discard cached pagination evidence and turn incomplete checks into success", async t => {
  const f = await fixture(t);
  await f.interactions.armPr(repository, 7);
  const normal = f.defaultTransport();
  let checkReads = 0;
  f.setTransport(async url => {
    if (!url.includes("/check-runs?")) return normal(url);
    if (++checkReads > 1) return response(null, 304);
    return { ...(await normal(url)), etag: '"partial"', link: '<https://api.github.com/next>; rel="next"' };
  });
  await f.prCycle(); await f.prCycle();
  assert.equal(checkReads, 2);
  assert.equal(f.interactions.publicState().events.length, 0);
  assert.match(f.interactions.targets().subscriptions[0].reason, /pagination contradicts/);
});

for (const bad of ["wrong attempt", "duplicate jobs", "nonterminal child"]) {
  test(`fast-completion proof rejects ${bad}`, async t => {
    const f = await fixture(t);
    await f.interactions.armRun(parseRun(f.rawRun(), repository));
    f.control.state = "completed"; f.control.completedAtMs = f.now() + 100;
    const normal = f.defaultTransport();
    f.setTransport(async url => {
      const value = await normal(url);
      if (url.includes("/jobs?")) {
        if (bad === "wrong attempt") value.json.jobs[0].run_attempt = 2;
        if (bad === "duplicate jobs") value.json.jobs.push({ ...value.json.jobs[0] });
        if (bad === "nonterminal child") value.json.jobs[0].status = "in_progress";
      }
      return value;
    });
    for (let i = 0; i < 5; i++) await f.tick();
    assert.equal(f.interactions.publicState().events.length, 0);
    assert.equal(f.interactions.targets().subscriptions[0].phase, "indeterminate");
  });
}

test("expired and permission-denied PR associations return to bounded lazy resolution", async t => {
  const f = await fixture(t);
  const run = parseRun(f.rawRun(), repository);
  f.monitor.tracker.upsert(run, f.now());
  f.control.failurePath = "/pulls?";
  f.monitor.requestPrAssociation(run);
  await f.monitor.completions.service(f.monitor.completions.due(f.now()));
  assert.equal(f.monitor.interactionRun(repository, 101, 1).prAssociation.status, "unavailable");
  f.advance(15 * 60_000 + 1);
  assert.equal(f.monitor.interactionRun(repository, 101, 1).prAssociation.status, "unknown");
  f.control.failurePath = "";
  f.monitor.requestPrAssociation(run);
  await f.monitor.completions.service(f.monitor.completions.due(f.now()));
  assert.equal(f.monitor.interactionRun(repository, 101, 1).prAssociation.status, "resolved");
  f.advance(10 * 60_000 + 1);
  assert.equal(f.monitor.interactionRun(repository, 101, 1).prAssociation.status, "unknown");
  f.setTransport(async () => response([7, 8].map(number => ({ number, base: { repo: { full_name: repository } } }))));
  f.monitor.requestPrAssociation(run);
  await f.monitor.completions.service(f.monitor.completions.due(f.now()));
  assert.equal(f.monitor.interactionRun(repository, 101, 1).prAssociation.status, "ambiguous");
});

test("pin retention clones target state once per revision, not per tracked row", async t => {
  const f = await fixture(t);
  const run = parseRun(f.rawRun(), repository);
  await f.interactions.setPin(run, { surfaceId: "focus", paneId: "main" });
  let reads = 0;
  const targets = f.interactions.targets.bind(f.interactions);
  t.mock.method(f.interactions, "targets", () => { reads++; return targets(); });
  for (let i = 0; i < 4096; i++) f.monitor.completions.retained({ ...run, runId: i + 1 });
  assert.equal(reads, 1);
  await f.interactions.setPin(run, { surfaceId: "focus", paneId: "main" }, false);
  assert.equal(f.monitor.completions.retained(run), false);
  assert.equal(reads, 2);
});

test("closing a PR preserves unfinished test-merge checks across a local restart", async t => {
  const f = await fixture(t);
  f.control.merge = merge;
  f.control.perSha[head] = { state: "completed", conclusion: "success" };
  f.control.perSha[merge] = { state: "in_progress" };
  await f.interactions.armPr(repository, 7);
  await f.prCycle();
  assert.equal(f.interactions.targets().subscriptions[0].relevantMergeSha, merge);
  assert.equal(f.interactions.targets().subscriptions[0].seenOpen, true);
  f.control.prState = "closed";
  f.control.merge = "d".repeat(40); // GitHub's field now means the final merge commit.
  const restored = new InteractionStore(f.dataDir);
  await restored.load();
  f.monitor.interactions = restored;
  f.monitor.completions.interactions = restored;
  f.monitor.completions.reset();
  const before = f.paths.length;
  await f.prCycle(); await f.prCycle();
  assert.equal(restored.publicState().events.length, 0);
  assert.ok(f.paths.slice(before).some(url => url.includes("commits/" + merge + "/check-runs")));
  assert.equal(restored.targets().subscriptions[0].headSha, head);
  f.control.perSha[merge] = { state: "completed", conclusion: "cancelled" };
  f.control.completedAtMs = f.now() + 100;
  await f.prCycle(); await f.prCycle();
  assert.equal(restored.publicState().events.length, 1);
  assert.equal(restored.publicState().events[0].outcome, "cancelled");
});

test("a first-seen closed PR cannot invent prior test-merge coverage", async t => {
  const f = await fixture(t);
  f.control.state = "completed"; f.control.prState = "closed"; f.control.completedAtMs = f.now() + 100;
  await f.interactions.armPr(repository, 7);
  await f.prCycle();
  assert.equal(f.interactions.publicState().events.length, 0);
  assert.match(f.interactions.targets().subscriptions[0].reason, /prior test-merge check coverage is unknown/);
});

for (const conclusion of ["cancelled", "skipped", "startup_failure"]) {
  test(`PR ${conclusion} before job creation is explicit terminal evidence, never empty success`, async t => {
    const f = await fixture(t);
    f.control.checkCount = 0;
    await f.interactions.armPr(repository, 7);
    await f.prCycle();
    assert.equal(f.interactions.targets().subscriptions[0].seenActive, true);
    f.control.state = "completed"; f.control.conclusion = conclusion;
    await f.prCycle(); await f.prCycle();
    const event = f.interactions.publicState().events[0];
    assert.ok(event);
    assert.equal(event.outcome, conclusion === "cancelled" ? "cancelled" : conclusion === "skipped" ? "neutral" : "failure");
  });
}
