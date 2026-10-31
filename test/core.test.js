import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeAnalyzer } from "../src/core/analyzer.js";
import { globMatch } from "../src/core/glob.js";
import { baselineKey, AttentionLevel, Conclusion, RunState } from "../src/core/model.js";
import { PollPolicy } from "../src/core/poll-policy.js";
import { robustStats } from "../src/core/statistics.js";
import { RunTracker } from "../src/core/tracker.js";
import { FileHistoryStore } from "../src/history-store.js";
import { parseConclusion, parseState } from "../src/github.js";

class MemoryHistory {
  constructor() { this.byKey = new Map(); }
  samples(key, limit) { return (this.byKey.get(key) || []).slice(-limit); }
  add(key, durationMs, successful = true) {
    const values = this.byKey.get(key) || [];
    values.push({ durationMs, successful });
    this.byKey.set(key, values);
  }
}

function sampleRun() {
  return {
    repository: "techrote/CISmon",
    workflowId: 42,
    workflowName: "CI",
    runId: 100,
    runNumber: 7,
    event: "pull_request",
    branch: "main",
    state: RunState.InProgress,
    conclusion: Conclusion.Unknown,
    startedAtEpoch: 1000,
    updatedAtEpoch: 0,
    jobs: [],
  };
}

test("robust statistics match CISmon outlier behavior", () => {
  const stats = robustStats([1000, 1100, 1200, 1300, 50000]);
  assert.equal(stats.samples, 5);
  assert.equal(stats.median, 1200);
  assert.equal(stats.mad, 100);
  assert.equal(stats.maximum, 50000);
});

test("runtime analyzer preserves attention thresholds", () => {
  const history = new MemoryHistory();
  const run = sampleRun();
  const key = baselineKey.run(run);
  for (const ms of [9000, 10000, 10500, 11000, 9500, 10000]) history.add(key, ms);
  const analyzer = new RuntimeAnalyzer(history);

  assert.equal(analyzer.analyze(key, 8000, false, Conclusion.Unknown).attention, AttentionLevel.Normal);
  const suspicious = analyzer.analyze(key, 30000, false, Conclusion.Unknown);
  assert.equal(suspicious.attention, AttentionLevel.Suspicious);
  assert.equal(suspicious.possiblyStalled, true);
  assert.equal(analyzer.analyze(key, 5000, true, Conclusion.Failure).attention, AttentionLevel.ActionRequired);
});

test("tracker retains unacknowledged failures and expires them after acknowledgement", () => {
  const tracker = new RunTracker();
  const run = sampleRun();
  tracker.upsert(run, 100);
  assert.equal(tracker.visible(100).length, 1);

  run.state = RunState.Completed;
  run.conclusion = Conclusion.Failure;
  tracker.upsert(run, 200);
  assert.equal(tracker.visible(201).length, 1);
  assert.equal(tracker.acknowledge(run.repository, run.runId), true);
  assert.equal(tracker.visible(201).length, 0);
});

test("poll policy and glob semantics match firmware core", () => {
  const policy = new PollPolicy();
  assert.equal(policy.nextInterval(true, false, 0, 0), policy.activeMs);
  assert.equal(policy.nextInterval(false, true, 0, 0), policy.queuedMs);
  assert.equal(policy.nextInterval(false, false, policy.warmWindowMs * 10, 0), policy.coldMs);
  assert.equal(policy.nextInterval(false, false, 0, 3), policy.errorBaseMs * 4);
  assert.equal(globMatch("techrote/*", "techrote/CISmon"), true);
  assert.equal(globMatch("*Doom*", "techrote/ShadeDoomVK"), true);
  assert.equal(globMatch("foo/*", "techrote/CISmon"), false);
});

test("GitHub normalization handles queued aliases and conclusions", () => {
  assert.equal(parseState("waiting"), RunState.Queued);
  assert.equal(parseState("pending"), RunState.Queued);
  assert.equal(parseState("requested"), RunState.Queued);
  assert.equal(parseState("in_progress"), RunState.InProgress);
  assert.equal(parseConclusion("timed_out"), Conclusion.TimedOut);
  assert.equal(parseConclusion("stale"), Conclusion.Stale);
  assert.equal(parseConclusion("made_up"), Conclusion.Unknown);
});

test("history journal records run, job and step durations and survives reload", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cismonweb-"));
  try {
    const store = new FileHistoryStore(dir, 64);
    await store.load();
    const run = {
      ...sampleRun(),
      state: RunState.Completed,
      conclusion: Conclusion.Success,
      updatedAtEpoch: 1010,
      jobs: [{
        id: 1,
        name: "build",
        state: RunState.Completed,
        conclusion: Conclusion.Success,
        startedAtEpoch: 1001,
        completedAtEpoch: 1009,
        steps: [{
          name: "compile",
          state: RunState.Completed,
          conclusion: Conclusion.Success,
          startedAtEpoch: 1002,
          completedAtEpoch: 1008,
        }],
      }],
    };

    assert.equal(await store.recordRun(run), true);
    assert.equal(store.samples(baselineKey.run(run), 10)[0].durationMs, 8000); // 1001–1009 job execution; not queued/setup time
    assert.equal(store.hasRun(run.repository, run.runId), true);

    const reloaded = new FileHistoryStore(dir, 64);
    await reloaded.load();
    assert.equal(reloaded.hasRun(run.repository, run.runId), true);
    assert.equal(reloaded.samples(baselineKey.run(run), 10).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
