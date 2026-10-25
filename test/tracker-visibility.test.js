import assert from "node:assert/strict";
import test from "node:test";
import { Conclusion, RunState } from "../src/core/model.js";
import { RunTracker } from "../src/core/tracker.js";
import { shouldTrackSummaryRun } from "../src/summary-policy.js";

function run(overrides = {}) {
  return {
    repository: "techrote/example",
    workflowId: 1,
    workflowName: "CI",
    runId: 1,
    runNumber: 1,
    event: "push",
    branch: "main",
    state: RunState.Completed,
    conclusion: Conclusion.Failure,
    startedAtEpoch: 1000,
    updatedAtEpoch: 1000,
    jobs: [],
    ...overrides
  };
}

test("old terminal summaries are not imported into live attention working memory", () => {
  const nowMs = 10_000_000;
  const old = run({ updatedAtEpoch: 1 });
  assert.equal(shouldTrackSummaryRun(old, false, nowMs, 3600000), false);

  const recent = run({ updatedAtEpoch: 9999 });
  assert.equal(shouldTrackSummaryRun(recent, false, 10_000_000, 3600000), true);
});

test("active and queued summaries are always tracked regardless of age fields", () => {
  assert.equal(
    shouldTrackSummaryRun(run({ state: RunState.InProgress, conclusion: Conclusion.Unknown }), false, 99_000_000, 1),
    true
  );
  assert.equal(
    shouldTrackSummaryRun(run({ state: RunState.Queued, conclusion: Conclusion.Unknown }), false, 99_000_000, 1),
    true
  );
});

test("a failure actually observed live remains until acknowledged", () => {
  const tracker = new RunTracker();
  const active = run({
    state: RunState.InProgress,
    conclusion: Conclusion.Unknown,
    updatedAtEpoch: 1000
  });
  tracker.upsert(active, 1_000_000);

  tracker.upsert(run({
    state: RunState.Completed,
    conclusion: Conclusion.Failure,
    updatedAtEpoch: 1001
  }), 1_001_000);

  assert.equal(tracker.visible(20_000_000, 1000, 1000).length, 1);
  tracker.prune(20_000_000, 1000, 1000);
  assert.equal(tracker.all().length, 1);

  tracker.acknowledge(active.repository, active.runId);
  tracker.prune(20_000_000, 1000, 1000);
  assert.equal(tracker.all().length, 0);
});

test("failure first discovered already terminal ages out like historical context", () => {
  const tracker = new RunTracker();
  tracker.upsert(run({
    updatedAtEpoch: 1000
  }), 1_000_000);

  assert.equal(tracker.visible(1_000_500, 1000, 1000).length, 1);
  assert.equal(tracker.visible(1_002_000, 1000, 1000).length, 0);
  tracker.prune(1_002_000, 1000, 1000);
  assert.equal(tracker.all().length, 0);
});

test("recent cancelled and skipped terminal runs can be surfaced before expiry", () => {
  const tracker = new RunTracker();
  tracker.upsert(run({
    conclusion: Conclusion.Cancelled,
    updatedAtEpoch: 1000
  }), 1_000_000);

  assert.equal(tracker.visible(1_000_500, 1000, 1000).length, 1);
  assert.equal(tracker.visible(1_002_000, 1000, 1000).length, 0);
});
