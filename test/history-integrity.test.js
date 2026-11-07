import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileHistoryStore } from "../src/history-store.js";
import { Conclusion, RunState, baselineKey } from "../src/core/model.js";

function completedRun(overrides = {}) {
  return {
    repository: "techrote/example", workflowId: 7, event: "push",
    runId: 42, runAttempt: 1, state: RunState.Completed,
    conclusion: Conclusion.Success, createdAtEpoch: 900,
    runStartedAtEpoch: 1000, updatedAtEpoch: 1100,
    jobsCoverageComplete: true,
    jobs: [{ id: 101, name: "build", state: RunState.Completed,
      conclusion: Conclusion.Success, startedAtEpoch: 1000,
      completedAtEpoch: 1100,
      steps: [{ name: "compile", state: RunState.Completed,
        conclusion: Conclusion.Success, startedAtEpoch: 1010,
        completedAtEpoch: 1090 }] }],
    ...overrides
  };
}

async function temporaryHistory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cismon-history-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileHistoryStore(dir);
  await store.load();
  return { dir, store };
}

test("history records rerun attempts independently and deduplicates each attempt", async t => {
  const { dir, store } = await temporaryHistory(t);
  const run = completedRun();
  assert.equal(await store.recordRun(run), true);
  assert.equal(store.hasRun(run.repository, run.runId, 2), false);
  assert.equal(await store.recordRun({ ...run, runAttempt: 2 }), true);
  assert.equal(await store.recordRun({ ...run, runAttempt: 2 }), false);
  assert.equal(store.samples(baselineKey.run(run), 32).length, 2);
  const reloaded = new FileHistoryStore(dir);
  await reloaded.load();
  assert.equal(reloaded.hasRun(run.repository, run.runId, 1), true);
  assert.equal(reloaded.hasRun(run.repository, run.runId, 2), true);
  assert.equal(reloaded.hasRun(run.repository, run.runId, 3), false);
  assert.equal(reloaded.samples(baselineKey.run(run), 32).length, 2);
});

test("simultaneous history recording cannot duplicate samples for one attempt", async t => {
  const { store } = await temporaryHistory(t);
  const run = completedRun();
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => store.recordRun(run)));
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(store.samples(baselineKey.run(run), 32).length, 1);
});

test("partial matrix backfill never trains a shortened whole-workflow baseline", async t => {
  const { store } = await temporaryHistory(t);
  const run = completedRun({ jobsCoverageComplete: false, jobsExpectedCount: 200 });
  assert.equal(await store.recordRun(run), true);
  assert.equal(store.samples(baselineKey.run(run), 32).length, 0);
  assert.equal(store.samples(baselineKey.job(run, run.jobs[0]), 32).length, 1);
  assert.equal(store.samples(baselineKey.step(run, run.jobs[0], run.jobs[0].steps[0]), 32).length, 1);
});

test("a terminal parent with unsettled job states cannot train a premature workflow baseline", async t => {
  const { store } = await temporaryHistory(t);
  const run = completedRun();
  run.jobs.push({ id: 102, name: "still settling", state: RunState.InProgress,
    conclusion: Conclusion.Unknown, startedAtEpoch: 1095, completedAtEpoch: 0, steps: [] });
  await store.recordRun(run);
  assert.equal(store.samples(baselineKey.run(run), 32).length, 0);
  assert.equal(store.samples(baselineKey.job(run, run.jobs[0]), 32).length, 1);
});

test("a truncated journal tail cannot swallow the next completed workflow sample", async t => {
  const { dir } = await temporaryHistory(t);
  await writeFile(path.join(dir, "history.jsonl"), '{"type":"sample","key":"torn');
  const store = new FileHistoryStore(dir);
  await store.load();
  const run = completedRun();
  await store.recordRun(run);
  const reloaded = new FileHistoryStore(dir);
  await reloaded.load();
  assert.equal(reloaded.samples(baselineKey.run(run), 32).length, 1);
  assert.equal(reloaded.hasRun(run.repository, run.runId), true);
});

test("each new journal line keeps its sample batch and completion marker together", async t => {
  const { dir, store } = await temporaryHistory(t);
  const run = completedRun();
  await store.recordRun(run);
  const journal = await readFile(path.join(dir, "history.jsonl"), "utf8");
  assert.equal(journal.trim().split("\n").length, 1);
  // A crash halfway through a batch must not retain orphaned samples which
  // would later be counted again when that unmarked attempt is backfilled.
  await writeFile(path.join(dir, "history.jsonl"), journal.slice(0, journal.length / 2));
  const recovered = new FileHistoryStore(dir);
  await recovered.load();
  assert.equal(recovered.samples(baselineKey.run(run), 32).length, 0);
  assert.equal(recovered.hasRun(run.repository, run.runId), false);
  await recovered.recordRun(run);
  const reloaded = new FileHistoryStore(dir);
  await reloaded.load();
  assert.equal(reloaded.samples(baselineKey.run(run), 32).length, 1);
});

test("legacy journals remain readable without blocking a later attempt", async t => {
  const { dir } = await temporaryHistory(t);
  const run = completedRun();
  await writeFile(path.join(dir, "history.jsonl"), [
    { type: "sample", key: baselineKey.run(run), runId: run.runId,
      durationMs: 100000, successful: true, completedAtEpoch: 1100 },
    { type: "run", runKey: run.repository + "#" + run.runId }
  ].map(JSON.stringify).join("\n") + "\n");
  const store = new FileHistoryStore(dir);
  await store.load();
  assert.equal(store.hasRun(run.repository, run.runId), true);
  assert.equal(await store.recordRun({ ...run, runAttempt: 2 }), true);
  assert.equal(store.samples(baselineKey.run(run), 32).length, 2);
});

test("damaged journal values cannot inject nonnumeric or nonfinite baselines", async t => {
  const { dir } = await temporaryHistory(t);
  const run = completedRun();
  const key = baselineKey.run(run);
  const record = durationMs => ({ type: "sample", key, durationMs, successful: true });
  const lines = [null, record("100"), record(-1), record(null),
    { ...record(5), successful: "false" }, record(125)];
  await writeFile(path.join(dir, "history.jsonl"), lines.map(JSON.stringify).join("\n") +
    '\n{"type":"sample","key":' + JSON.stringify(key) + ',"durationMs":1e400,"successful":true}\n');
  const store = new FileHistoryStore(dir);
  await store.load();
  assert.deepEqual(store.samples(key, 32).map(sample => sample.durationMs), [125]);
});

test("history never records an active run as permanently completed", async t => {
  const { store } = await temporaryHistory(t);
  const run = completedRun({ state: RunState.InProgress, conclusion: Conclusion.Unknown });
  assert.equal(await store.recordRun(run), false);
  assert.equal(store.hasRun(run.repository, run.runId), false);
  assert.equal(store.samples(baselineKey.run(run), 32).length, 0);
});

test("a failed journal append does not consume the attempt or poison later writes", async t => {
  const { dir, store } = await temporaryHistory(t);
  const run = completedRun();
  store.filePath = path.join(dir, "missing", "history.jsonl");
  await assert.rejects(store.recordRun(run));
  assert.equal(store.hasRun(run.repository, run.runId), false);
  store.filePath = path.join(dir, "history.jsonl");
  assert.equal(await store.recordRun(run), true);
  assert.equal(store.samples(baselineKey.run(run), 32).length, 1);
});
