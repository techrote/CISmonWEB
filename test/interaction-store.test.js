import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InteractionStore } from "../src/interaction-store.js";
import { ciUrl, commitUrl, prAssociation, runKey } from "../shared/interactions.js";

const scope = { surfaceId: "focus-dual", paneId: "dual:0" };
const sha = "a".repeat(40), nextSha = "b".repeat(40);
function run(id = 1, changes = {}) {
  return { repository: "owner/project", runId: id, runAttempt: 1, workflowName: "Test",
    state: "in_progress", conclusion: "unknown", headSha: sha, updatedAtEpoch: 1700000000, ...changes };
}
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cismon-interactions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { now: 1700000000000 };
  const store = new InteractionStore(directory, { now: () => clock.now });
  await store.load();
  const observe = async (value, options = {}) => {
    clock.now += 1000;
    return store.observeRun({ ...value, updatedAtEpoch: clock.now / 1000 }, {
      requestStartedAtMs: clock.now - 100, confirmedAtMs: clock.now, coverageComplete: true, ...options
    });
  };
  return { directory, clock, store, observe };
}
async function completed(t, { sound = true, outcome = "success", count = 1 } = {}) {
  const context = await setup(t);
  const { store, observe } = context;
  await store.setSettings({ soundEnabled: sound });
  for (let i = 1; i <= count; i++) {
    await store.armRun(run(i));
    await observe(run(i));
    await observe(run(i, { state: "completed", conclusion: outcome }));
  }
  return context;
}

test("scoped pins are ordered, idempotent and durable independently of watch or profile state", async t => {
  const { store, directory, clock, observe } = await setup(t);
  await store.setPin(run(2, { manualWatch: true, githubToken: "never-store" }), scope);
  await store.setPin(run(1), scope);
  await store.setPin(run(2), scope);
  await store.setPin(run(2), { ...scope, paneId: "dual:1" });
  await observe(run(2, { state: "completed", conclusion: "success" }));
  assert.deepEqual(store.publicState().pins.map(pin => pin.order), [1, 2, 3]);
  assert.equal(store.publicState().subscriptions.length, 0);
  await store.setPin(run(2), scope, false);
  assert.equal(store.publicState().pins.length, 2);
  const restored = new InteractionStore(directory, { now: () => clock.now });
  await restored.load();
  assert.deepEqual(restored.publicState().pins.map(pin => [pin.runId, pin.scope.paneId]), [[1, "dual:0"], [2, "dual:1"]]);
  assert.ok(restored.publicState().pins.every(pin => pin.status === "restoring"));
  const raw = await readFile(store.filePath, "utf8");
  assert.doesNotMatch(raw, /never-store|manualWatch|githubToken/);
  assert.deepEqual(await readdir(directory), ["interactions.json"]);
  if (process.platform !== "win32") assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
});

test("failed atomic saves preserve accepted state and later writes recover", async t => {
  const { store } = await setup(t);
  await mkdir(store.filePath);
  await assert.rejects(store.setSettings({ soundEnabled: true }));
  assert.equal(store.publicState().settings.soundEnabled, false);
  assert.equal(store.publicState().revision, 0);
  await rm(store.filePath, { recursive: true });
  await store.setSettings({ volume: 0.4 });
  assert.equal(store.publicState().settings.volume, 0.4);
  assert.equal(store.publicState().settings.soundEnabled, false);
  assert.deepEqual(await readdir(store.dataDir), ["interactions.json"]);
});

test("concurrent settings, pins and subscriptions merge at the durable boundary", async t => {
  const { store } = await setup(t);
  await Promise.all([
    store.setSettings({ soundEnabled: true }), store.setSettings({ volume: 0.1 }),
    store.setPin(run(1), scope), store.setPin(run(2), scope), store.armRun(run(1)), store.armRun(run(1))
  ]);
  const state = store.publicState();
  assert.deepEqual(state.settings, { soundEnabled: true, muted: false, volume: 0.1 });
  assert.equal(state.pins.length, 2);
  assert.equal(state.subscriptions.length, 1);
});

test("run notifications require fresh, exact-attempt activity and dedupe repeated provider results", async t => {
  const { store, observe, clock } = await setup(t);
  await store.armRun(run());
  await store.observeRun(run(1, { state: "completed", conclusion: "success" }), {
    requestStartedAtMs: clock.now - 1000, confirmedAtMs: clock.now + 1
  });
  await observe(run(1, { runAttempt: 2, state: "completed", conclusion: "success" }));
  assert.equal(store.publicState().events.length, 0);
  assert.equal(store.publicState().subscriptions[0].status, "armed");
  await observe(run());
  await observe(run(1, { state: "completed", conclusion: "success" }));
  await observe(run(1, { state: "completed", conclusion: "success" }));
  assert.equal(store.publicState().events.length, 1);
  assert.equal(store.publicState().events[0].outcome, "success");
  assert.equal(store.publicState().subscriptions[0].status, "fired");
});

test("arming terminal runs or a stale active row cannot create a retrospective chime", async t => {
  const { store, observe } = await setup(t);
  assert.throws(() => store.armRun(run(1, { state: "completed", conclusion: "success" })), /terminal/);
  await store.armRun(run());
  await observe(run(1, { state: "completed", conclusion: "success" }));
  assert.equal(store.publicState().events.length, 0);
  assert.equal(store.publicState().subscriptions[0].phase, "already-complete");
});

test("actual job completion after arming preserves fast completions without trusting updated_at", async t => {
  const { store, observe, clock } = await setup(t);
  await store.armRun(run());
  const completedAt = clock.now + 500;
  await observe(run(1, { state: "completed", conclusion: "success" }), {
    terminalTimeSource: "completed_at", terminalTimeMs: completedAt
  });
  assert.equal(store.publicState().events.length, 1);
  await store.armRun(run(2));
  await observe(run(2, { state: "completed", conclusion: "success" }), {
    terminalTimeSource: "updated_at", terminalTimeMs: clock.now + 500
  });
  assert.equal(store.publicState().events.length, 1);
});

test("run outcomes distinguish failure/cancellation/neutral/unknown without false success sound", async t => {
  const { store, observe } = await setup(t);
  await store.setSettings({ soundEnabled: true });
  const conclusions = ["success", "failure", "timed_out", "cancelled", "neutral", "skipped", "unknown"];
  for (const [index, conclusion] of conclusions.entries()) {
    await store.armRun(run(index + 1));
    await observe(run(index + 1));
    await observe(run(index + 1, { state: "completed", conclusion }));
  }
  assert.deepEqual(store.publicState().events.map(event => [event.outcome, event.sound]), [
    ["success", "success"], ["failure", "failure"], ["failure", "failure"], ["cancelled", "failure"],
    ["neutral", null], ["neutral", null], ["indeterminate", null]
  ]);
});

test("an older terminal snapshot cannot conclude a newly confirmed active run", async t => {
  const { store, clock, observe } = await setup(t);
  await store.armRun(run()); await observe(run());
  clock.now += 1000;
  await store.observeRun(run(1, { state: "completed", conclusion: "success", updatedAtEpoch: 1699999990 }), {
    requestStartedAtMs: clock.now - 100, confirmedAtMs: clock.now
  });
  assert.equal(store.publicState().events.length, 0);
  assert.equal(store.publicState().subscriptions[0].status, "armed");
});

test("cancel/rearm races reject the old generation and stale cancellation", async t => {
  const { store, observe } = await setup(t);
  await store.armRun(run()); await observe(run());
  const old = store.publicState().subscriptions[0];
  await store.cancelSubscription(old.id, old.generation);
  await store.armRun(run());
  const fresh = store.publicState().subscriptions[0];
  assert.notEqual(fresh.generation, old.generation);
  await assert.rejects(store.cancelSubscription(old.id, old.generation), /replaced/);
  await observe(run(1, { state: "completed", conclusion: "failure" }), { generation: old.generation });
  assert.equal(store.publicState().events.length, 0);
  await observe(run());
  await observe(run(1, { state: "completed", conclusion: "success" }), { generation: fresh.generation });
  assert.equal(store.publicState().events.length, 1);
});

test("pre-arm actual completion overrides a stale active baseline and later metadata update", async t => {
  const { store, observe, clock } = await setup(t);
  const oldCompletion = clock.now - 10000;
  await store.armRun(run());
  await observe(run());
  await observe(run(1, { state: "completed", conclusion: "success" }), {
    terminalTimeSource: "completed_at", terminalTimeMs: oldCompletion
  });
  assert.equal(store.publicState().events.length, 0);
  assert.equal(store.publicState().subscriptions[0].phase, "already-complete");
});

test("restart keeps active baseline and records completion with the browser closed", async t => {
  const { store, observe, directory, clock } = await setup(t);
  await store.setSettings({ soundEnabled: true });
  await store.armRun(run()); await observe(run());
  const restored = new InteractionStore(directory, { now: () => clock.now });
  await restored.load();
  assert.equal(restored.targets().subscriptions[0].phase, "recovering");
  assert.ok(restored.publicState().revision > store.publicState().revision, "restart recovery is visible to existing browser clients");
  clock.now += 1000;
  await restored.observeRun(run(1, { state: "completed", conclusion: "success", updatedAtEpoch: clock.now / 1000 }), {
    requestStartedAtMs: clock.now - 100, confirmedAtMs: clock.now
  });
  assert.equal(restored.publicState().events[0].delivery.status, "pending");
  clock.now += 121000;
  assert.equal((await restored.claim({ clientId: "browser-later", audioReady: true })).claimId, null);
  assert.equal(restored.publicState().events[0].delivery.status, "expired");
});

test("PR completion requires full current-head evidence, activity and settlement", async t => {
  const { store, clock } = await setup(t);
  await store.armPr("owner/project", 9);
  const sub = store.targets().subscriptions[0];
  async function observe(changes) {
    clock.now += 1000;
    await store.observePr(sub.id, { headSha: sha, complete: true, terminal: false,
      requestStartedAtMs: clock.now - 100, confirmedAtMs: clock.now, ...changes }, { generation: sub.generation });
  }
  await observe({ complete: false, terminal: true, outcome: "success", settled: true, signature: "partial" });
  assert.equal(store.publicState().subscriptions[0].phase, "indeterminate");
  await observe({});
  await observe({ terminal: true, outcome: "success", settled: false, signature: "full" });
  assert.equal(store.publicState().events.length, 0);
  await observe({ headSha: nextSha, terminal: false });
  assert.equal(store.publicState().subscriptions[0].headSha, nextSha);
  await observe({ headSha: nextSha, terminal: true, outcome: "failure", settled: true, signature: "new-check-inventory" });
  assert.equal(store.publicState().events.length, 1);
  assert.equal(store.publicState().events[0].headSha, nextSha);
  assert.equal(store.publicState().events[0].outcome, "failure");
});

test("in-flight old-head response and duplicate PR arms cannot create false success", async t => {
  const { store, clock } = await setup(t);
  await Promise.all([store.armPr("owner/project", 9), store.armPr("owner/project", 9)]);
  assert.equal(store.targets().subscriptions.length, 1);
  const sub = store.targets().subscriptions[0];
  clock.now += 1000;
  const oldStart = clock.now;
  clock.now += 1000;
  await store.observePr(sub.id, { headSha: nextSha, complete: true, terminal: false,
    requestStartedAtMs: clock.now, confirmedAtMs: clock.now });
  clock.now += 1000;
  await store.observePr(sub.id, { headSha: sha, complete: true, terminal: true, outcome: "success", signature: "old", settled: true,
    requestStartedAtMs: oldStart, confirmedAtMs: clock.now });
  assert.equal(store.publicState().events.length, 0);
  assert.equal(store.targets().subscriptions[0].headSha, nextSha);
});

test("two browser clients race for one coalesced claim and only one can begin playback", async t => {
  const { store, clock } = await completed(t, { count: 2 });
  clock.now += 1500;
  const claims = await Promise.all([
    store.claim({ clientId: "browser-one", audioReady: true }), store.claim({ clientId: "browser-two", audioReady: true })
  ]);
  assert.equal(claims.filter(claim => claim.claimId).length, 1);
  assert.equal(claims[0].events.length, 2);
  const input = { clientId: "browser-one", claimId: claims[0].claimId };
  await assert.rejects(store.begin({ ...input, clientId: "browser-two" }), /another window/);
  const started = await Promise.allSettled([store.begin(input), store.begin(input)]);
  assert.deepEqual(started.map(result => result.status), ["fulfilled", "rejected"]);
  assert.ok(store.publicState().events.every(event => event.delivery.status === "attempted"));
  assert.ok(store.publicState().events.every(event => !event.delivery.claimId && !event.delivery.clientId));
  await store.acknowledge({ ...input, status: "played" });
  assert.ok(store.publicState().events.every(event => event.delivery.status === "played"));
  assert.equal((await store.claim({ clientId: "browser-two", audioReady: true })).claimId, null);
});

test("claimed but unstarted delivery recovers; attempted delivery never replays after lost acknowledgement/restart", async t => {
  const { store, clock, directory } = await completed(t);
  clock.now += 1500;
  const abandoned = await store.claim({ clientId: "browser-one", audioReady: true });
  clock.now += 11000;
  const restored = new InteractionStore(directory, { now: () => clock.now });
  await restored.load();
  const recovered = await restored.claim({ clientId: "browser-two", audioReady: true });
  assert.ok(recovered.claimId); assert.notEqual(recovered.claimId, abandoned.claimId);
  await assert.rejects(restored.begin({ clientId: "browser-one", claimId: abandoned.claimId }));
  await restored.begin({ clientId: "browser-two", claimId: recovered.claimId });
  clock.now += 11000;
  const restarted = new InteractionStore(directory, { now: () => clock.now });
  await restarted.load();
  assert.equal((await restarted.claim({ clientId: "browser-three", audioReady: true })).claimId, null);
  assert.equal(restarted.publicState().events[0].delivery.status, "attempted");
  await restarted.acknowledge({ clientId: "browser-two", claimId: recovered.claimId, status: "played" });
  assert.equal(restarted.publicState().events[0].delivery.status, "played");
});

test("blocked playback records failure accurately without retrying a consumed sound", async t => {
  const { store, clock } = await completed(t);
  clock.now += 1500;
  const claim = await store.claim({ clientId: "browser-one", audioReady: true });
  await store.begin({ clientId: "browser-one", claimId: claim.claimId });
  await store.acknowledge({ clientId: "browser-one", claimId: claim.claimId, status: "blocked", reason: "Autoplay permission changed" });
  assert.equal(store.publicState().events[0].delivery.status, "blocked");
  assert.equal((await store.claim({ clientId: "browser-two", audioReady: true })).claimId, null);
});

test("coalescing prioritizes a failure while preserving both run and PR event records", async t => {
  const { store, observe, clock } = await completed(t);
  await store.armPr("owner/project", 9);
  const pr = store.targets().subscriptions[0];
  clock.now += 100;
  await store.observePr(pr.id, { headSha: sha, complete: true, terminal: false, requestStartedAtMs: clock.now, confirmedAtMs: clock.now });
  clock.now += 100;
  await store.observePr(pr.id, { headSha: sha, complete: true, terminal: true, outcome: "failure", signature: "full", settled: true,
    requestStartedAtMs: clock.now, confirmedAtMs: clock.now });
  assert.equal((await store.claim({ clientId: "browser-one", audioReady: true })).claimId, null);
  clock.now += 1500;
  const claim = await store.claim({ clientId: "browser-one", audioReady: true });
  assert.equal(claim.sound, "failure"); assert.equal(claim.events.length, 2);
  assert.deepEqual(claim.events.map(event => event.type), ["run", "pr"]);
});

test("disabled/muted sound never replays old events when enabled later", async t => {
  const { store, clock } = await completed(t, { sound: false });
  assert.equal(store.publicState().events[0].delivery.status, "silent");
  await store.setSettings({ soundEnabled: true }); clock.now += 1500;
  assert.equal((await store.claim({ clientId: "browser-one", audioReady: true })).claimId, null);
});

test("muting after a claim prevents begin and leaves a silent history record", async t => {
  const { store, clock } = await completed(t);
  clock.now += 1500;
  const claim = await store.claim({ clientId: "browser-one", audioReady: true });
  await store.setSettings({ muted: true });
  await assert.rejects(store.begin({ clientId: "browser-one", claimId: claim.claimId }));
  assert.equal(store.publicState().events[0].delivery.status, "silent");
});

test("pin and subscription limits are explicit without evicting active work", async t => {
  const { store } = await setup(t);
  await Promise.all(Array.from({ length: 64 }, (_, index) => store.setPin(run(index + 1), scope)));
  await assert.rejects(store.setPin(run(65), scope), /Pin limit/);
  assert.equal(store.publicState().pins.length, 64);
  await Promise.all(Array.from({ length: 128 }, (_, index) => store.armRun(run(index + 1))));
  await assert.rejects(store.armRun(run(129)), /alert limit/);
  assert.equal(store.targets().subscriptions.length, 128);
});

test("corrupt or future state fails visibly and is never overwritten", async t => {
  const { store } = await setup(t);
  const original = JSON.stringify({ version: 99, pins: [], subscriptions: [], events: [] });
  await writeFile(store.filePath, original);
  await assert.rejects(store.load(), /unsupported/);
  assert.equal(await readFile(store.filePath, "utf8"), original);
});

test("GitHub link helpers preserve exact attempts and never guess a PR from its first number", () => {
  const value = run(42, { runAttempt: 3, htmlUrl: "https://github.com/owner/project/actions/runs/42/attempts/2?noise=1", prNumber: 9 });
  assert.equal(ciUrl(value), "https://github.com/owner/project/actions/runs/42/attempts/3");
  assert.equal(ciUrl({ ...value, htmlUrl: "javascript:alert(1)" }), "https://github.com/owner/project/actions/runs/42/attempts/3");
  assert.equal(prAssociation(value).url, "");
  assert.equal(prAssociation({ ...value, prAssociation: { status: "ambiguous", number: 9 } }).url, "");
  assert.equal(prAssociation({ ...value, prAssociation: { status: "resolved", number: 9, url: "https://evil.example/" } }).url,
    "https://github.com/owner/project/pull/9");
  assert.equal(commitUrl(value), "https://github.com/owner/project/commit/" + sha);
  assert.equal(ciUrl({ ...value, repository: "../secrets" }), "");
  assert.equal(runKey(value), "owner/project#42@3");
});
