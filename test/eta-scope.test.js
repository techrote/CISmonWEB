import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeAnalyzer } from "../src/core/analyzer.js";
import { buildDashboard } from "../src/core/dashboard.js";
import { RunTracker } from "../src/core/tracker.js";
import { AttentionLevel, Conclusion, RunState, baselineKey } from "../src/core/model.js";
import { gridFieldRaw, GRID_LABEL } from "../shared/focus-grid.js";

const min = n => n * 60_000;

function scenario() {
  const start = 1_800_000_000;
  const now = start + 40 * 60 + 6;
  const run = {
    repository: "techrote/cybersand", workflowId: 1649,
    workflowName: "Native C++ validation", runId: 1649, runNumber: 1649,
    event: "pull_request", branch: "main", createdAtEpoch: start - 200,
    runStartedAtEpoch: start, startedAtEpoch: start,
    state: RunState.InProgress, conclusion: Conclusion.Unknown,
    jobs: [{
      name: "native", state: RunState.InProgress,
      conclusion: Conclusion.Unknown, startedAtEpoch: start, completedAtEpoch: 0,
      steps: [{
        name: "Compile and run ASan plus UBSan",
        state: RunState.InProgress, conclusion: Conclusion.Unknown,
        startedAtEpoch: now - (4 * 60 + 26), completedAtEpoch: 0
      }]
    }]
  };
  const samples = new Map([
    [baselineKey.run(run), Array.from({length: 11}, () => ({
      successful: true, durationMs: min(79)
    }))],
    [baselineKey.step(run, run.jobs[0], run.jobs[0].steps[0]),
      Array.from({length: 22}, () => ({
        successful: true, durationMs: min(13) + 59_000
      }))]
  ]);
  const history = { samples: key => samples.get(key) || [] };
  const tracker = new RunTracker();
  tracker.upsert(run, now * 1000);
  return { run, now, tracker, analyzer: new RuntimeAnalyzer(history) };
}

test("Focus workflow ETA never silently inherits current step ETA or history quantity", () => {
  const { run, now, tracker, analyzer } = scenario();
  const detail = analyzer.analyzeRun(run, now);
  const stage = analyzer.analyzeStep(run, run.jobs[0], run.jobs[0].steps[0], now);
  const [row] = buildDashboard(tracker, analyzer, now * 1000, now);
  assert.equal(detail.baseline.median, min(79));
  assert.equal(detail.baseline.samples, 11);
  assert.equal(detail.estimatedRemainingMs, min(38) + 54_000);
  assert.equal(stage.baseline.median, min(13) + 59_000);
  assert.equal(stage.baseline.samples, 22);
  assert.equal(stage.estimatedRemainingMs, min(9) + 33_000);
  assert.equal(row.elapsedMs, min(40) + 6_000);
  assert.equal(row.baselineMedianMs, detail.baseline.median);
  assert.equal(row.estimatedRemainingMs, detail.estimatedRemainingMs);
  assert.equal(row.confidence, detail.confidence);
  assert.equal(row.baselineSamples, 11);
  assert.equal(row.ratio, detail.ratio);
  assert.equal(row.stage, "Compile and run ASan plus UBSan");
  assert.equal(row.stageKind, "step");
  assert.equal(row.stageElapsedMs, min(4) + 26_000);
  assert.equal(row.stageBaselineMedianMs, stage.baseline.median);
  assert.equal(row.stageEstimatedRemainingMs, stage.estimatedRemainingMs);
  assert.equal(row.stageBaselineSamples, 22);
  assert.equal(gridFieldRaw(row, "remaining"), min(38) + 54_000);
  assert.equal(gridFieldRaw(row, "stageRemaining"), min(9) + 33_000);
  assert.equal(GRID_LABEL.remaining, "ETA");
  assert.equal(GRID_LABEL.stageRemaining, "S-ETA");
});

test("active stage anomaly can increase attention without corrupting workflow ETA", () => {
  const { run, now, tracker } = scenario();
  // Stage is 3x slower than its own baseline; workflow is still within its
  // overall 79-minute baseline.
  const history = { samples: key => key === baselineKey.run(run)
    ? Array.from({length: 11}, () => ({successful:true,durationMs:min(79)}))
    : Array.from({length: 22}, () => ({successful:true,durationMs:min(1)})) };
  const [row] = buildDashboard(tracker, new RuntimeAnalyzer(history), now*1000, now);
  assert.equal(row.attention, AttentionLevel.Suspicious);
  assert.equal(row.stageAttention, AttentionLevel.Suspicious);
  assert.equal(row.stagePossiblyStalled, true);
  assert.equal(row.possiblyStalled, true);
  assert.equal(row.baselineMedianMs, min(79));
  assert.equal(row.estimatedRemainingMs, min(38) + 54_000);
  assert.equal(row.baselineSamples, 11);
});

test("a current running job baseline cannot override workflow ETA when no active step exists", () => {
  const { run, now, analyzer } = scenario();
  run.jobs[0].steps = [];
  const tracker = new RunTracker();
  tracker.upsert(run, now * 1000);
  const [row] = buildDashboard(tracker, analyzer, now * 1000, now);
  assert.equal(row.stageKind, "job");
  assert.equal(row.baselineMedianMs, min(79));
  assert.equal(row.baselineSamples, 11);
  assert.equal(row.estimatedRemainingMs, min(38) + 54_000);
});

test("queued or completed workflows do not carry misleading active stage estimates", () => {
  const {run, now, analyzer} = scenario();
  const tracker = new RunTracker();
  run.state = RunState.Queued;
  tracker.upsert(run, now * 1000);
  const [row] = buildDashboard(tracker, analyzer, now * 1000, now);
  assert.equal(row.stageEstimatedRemainingMs, 0);
  assert.equal(row.estimatedRemainingMs, 0);
});
