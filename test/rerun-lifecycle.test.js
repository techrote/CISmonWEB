import assert from "node:assert/strict";
import test from "node:test";
import { RunTracker } from "../src/core/tracker.js";
import { RuntimeAnalyzer } from "../src/core/analyzer.js";
import { buildDashboard } from "../src/core/dashboard.js";
import { RunState, Conclusion, AttentionLevel } from "../src/core/model.js";

const epoch = 1_800_000_000;
function run(overrides = {}) {
  return { repository: "techrote/example", runId: 5, runAttempt: 1,
    workflowId: 7, event: "push", createdAtEpoch: epoch,
    runStartedAtEpoch: epoch + 10, updatedAtEpoch: epoch + 20,
    state: RunState.InProgress, conclusion: Conclusion.Unknown, jobs: [], ...overrides };
}

test("acknowledging an earlier attempt never hides a new rerun failure", () => {
  const tracker = new RunTracker();
  const first = run();
  tracker.upsert(first, (epoch + 10) * 1000);
  tracker.upsert({ ...first, state: RunState.Completed, conclusion: Conclusion.Failure }, (epoch + 20) * 1000);
  tracker.acknowledge(first.repository, first.runId);
  tracker.setManualWatch(first.repository, first.runId, true);
  tracker.upsert(run({ runAttempt: 2, state: RunState.Queued }), (epoch + 30) * 1000);
  const active = tracker.find(first.repository, first.runId);
  assert.equal(active.acknowledged, false);
  assert.equal(active.manualWatch, true);
  assert.equal(active.terminalSinceMs, 0);
  tracker.setManualWatch(first.repository, first.runId, false);
  tracker.upsert(run({ runAttempt: 2, state: RunState.Completed,
    conclusion: Conclusion.Failure, updatedAtEpoch: epoch + 40 }), (epoch + 40) * 1000);
  assert.equal(tracker.visible((epoch + 10_000) * 1000, 1000, 1000).length, 1);
});

test("an old attempt response cannot replace the current rerun or its job evidence", () => {
  const tracker = new RunTracker();
  const current = run({ runAttempt: 2, jobsFetchedAtMs: (epoch + 50) * 1000,
    jobsCoverageComplete: true, jobs: [{ id: 12, state: RunState.InProgress }] });
  tracker.upsert(current, (epoch + 50) * 1000);
  tracker.upsert(run({ state: RunState.Completed, conclusion: Conclusion.Success }), (epoch + 51) * 1000);
  const kept = tracker.find(current.repository, current.runId).snapshot;
  assert.equal(kept.runAttempt, 2);
  assert.equal(kept.state, RunState.InProgress);
  assert.equal(kept.jobs[0].id, 12);
});

test("a terminal run cannot regress to live within the same attempt", () => {
  const tracker = new RunTracker();
  tracker.upsert(run({ state: RunState.Completed, conclusion: Conclusion.Success }), (epoch + 20) * 1000);
  tracker.upsert(run(), (epoch + 21) * 1000);
  assert.equal(tracker.all()[0].snapshot.state, RunState.Completed);
  tracker.upsert(run({ runAttempt: 2 }), (epoch + 22) * 1000);
  assert.equal(tracker.all()[0].snapshot.state, RunState.InProgress);
});

test("terminal runs cannot acquire a false active-stage stall from retained job evidence", () => {
  const tracker = new RunTracker();
  const first = run({ jobsFetchedAtMs: (epoch + 10) * 1000, jobsCoverageComplete: true,
    jobs: [{ id: 1, name: "build", state: RunState.InProgress,
      conclusion: Conclusion.Unknown, startedAtEpoch: epoch + 10, steps: [] }] });
  tracker.upsert(first, (epoch + 10) * 1000);
  tracker.upsert(run({ state: RunState.Completed, conclusion: Conclusion.Success,
    updatedAtEpoch: epoch + 15 }), (epoch + 15) * 1000);
  const analyzer = new RuntimeAnalyzer({ samples: key => key.startsWith('["job"')
    ? Array.from({ length: 6 }, () => ({ successful: true, durationMs: 1000 })) : [] });
  const [row] = buildDashboard(tracker, analyzer, (epoch + 100) * 1000, epoch + 100);
  assert.equal(row.state, RunState.Completed);
  assert.equal(row.possiblyStalled, false);
  assert.equal(row.attention, AttentionLevel.Normal);
  assert.equal(row.stage, "");
});

test("expired job snapshots cannot keep producing active-stage stall warnings", () => {
  const tracker = new RunTracker();
  tracker.upsert(run({ jobsFetchedAtMs: (epoch + 10) * 1000, jobsCoverageComplete: true,
    jobs: [{ id: 1, name: "build", state: RunState.InProgress,
      conclusion: Conclusion.Unknown, startedAtEpoch: epoch + 10, steps: [] }] }), (epoch + 10) * 1000);
  const analyzer = new RuntimeAnalyzer({ samples: key => key.startsWith('["job"')
    ? Array.from({ length: 6 }, () => ({ successful: true, durationMs: 1000 })) : [] });
  const [row] = buildDashboard(tracker, analyzer, (epoch + 200) * 1000, epoch + 200);
  assert.equal(row.possiblyStalled, false);
  assert.equal(row.stage, "");
});
