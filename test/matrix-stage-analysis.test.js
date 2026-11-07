import assert from "node:assert/strict";
import test from "node:test";
import { RunTracker } from "../src/core/tracker.js";
import { buildDashboard } from "../src/core/dashboard.js";

const NOW = 1_800_000_000_000;
const analysis = (attention = "normal", elapsedMs = 40000) => ({
  attention, possiblyStalled: attention === "suspicious",
  elapsedMs, baseline: { samples: 0, median: 0 }, confidence: "none",
  estimatedRemainingMs: 0, ratio: attention === "suspicious" ? 3 : 1
});

test("later matrix job's stall raises attention even when first job is normal", () => {
  const tracker = new RunTracker();
  tracker.upsert({
    repository: "techrote/cybersand", workflowId: 31, workflowName: "Native",
    runId: 800, runNumber: 55, event: "push", state: "in_progress",
    runAttempt: 1, conclusion: "unknown",
    createdAtEpoch: NOW/1000 - 300, runStartedAtEpoch: NOW/1000 - 250,
    jobsFetchedAtMs: NOW, jobsCoverageComplete: true,
    jobs: [
      { id: 1, name: "fast", state: "in_progress", startedAtEpoch: NOW/1000 - 90, steps: [] },
      { id: 2, name: "stalled", state: "in_progress", startedAtEpoch: NOW/1000 - 210, steps: [] }
    ]
  }, NOW);
  const analyzed = [];
  const analyzer = {
    analyzeRun: () => analysis("normal", 250000),
    analyzeJob: (_run, job) => {
      analyzed.push(job.name);
      return analysis(job.name === "stalled" ? "suspicious" : "normal",
        job.name === "stalled" ? 210000 : 90000);
    },
    analyzeStep: () => { throw Error("No running steps in test"); }
  };
  const rows = buildDashboard(tracker, analyzer, NOW, NOW/1000, 100);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.deepEqual(analyzed, ["fast", "stalled"]);
  assert.equal(row.activeJobCount, 2);
  assert.equal(row.attention, "suspicious");
  assert.equal(row.possiblyStalled, true);
  assert.equal(row.stageAttention, "suspicious");
  assert.equal(row.stageKind, "job");
  assert.match(row.stage, /2 JOBS EXECUTING.*stalled/);
  assert.match(row.stageSummary, /All available executing jobs were independently analyzed/);
  assert.equal(row.baselineSamples, 0); // stage samples never overwrite run baseline
});
