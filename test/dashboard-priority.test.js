import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../src/core/dashboard.js";
import { RuntimeAnalyzer } from "../src/core/analyzer.js";
import { Conclusion, RunState } from "../src/core/model.js";
import { RunTracker } from "../src/core/tracker.js";

class EmptyHistory {
  samples() { return []; }
}

function snapshot(runId, state, conclusion, updatedAtEpoch = 1000) {
  return {
    repository: "techrote/example",
    workflowId: runId,
    workflowName: "workflow-" + runId,
    runId,
    runNumber: runId,
    event: "push",
    branch: "main",
    state,
    conclusion,
    startedAtEpoch: 990,
    updatedAtEpoch,
    jobs: []
  };
}

test("live runs cannot be truncated behind terminal action-required backlog", () => {
  const tracker = new RunTracker();
  const nowMs = 1_000_000;

  for (let i = 1; i <= 20; i += 1) {
    tracker.upsert(snapshot(i, RunState.Completed, Conclusion.Failure), nowMs);
  }

  tracker.upsert(snapshot(100, RunState.InProgress, Conclusion.Unknown), nowMs);
  tracker.upsert(snapshot(101, RunState.Queued, Conclusion.Unknown), nowMs);

  const rows = buildDashboard(
    tracker,
    new RuntimeAnalyzer(new EmptyHistory()),
    nowMs,
    1000,
    3
  );

  assert.deepEqual(rows.slice(0, 2).map((row) => row.state), [
    RunState.InProgress,
    RunState.Queued
  ]);
});
