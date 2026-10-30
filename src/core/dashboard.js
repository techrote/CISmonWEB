import { AttentionLevel, RunState, baselineKey, isTerminal } from "./model.js";

function attentionRank(level) {
  if (level === AttentionLevel.ActionRequired) return 4;
  if (level === AttentionLevel.Suspicious) return 3;
  if (level === AttentionLevel.Interesting) return 2;
  return 1;
}

function applyAnalysis(item, analysis) {
  if (attentionRank(analysis.attention) > attentionRank(item.attention)) item.attention = analysis.attention;
  item.possiblyStalled ||= analysis.possiblyStalled;
  if (analysis.baseline.samples > 0) {
    item.confidence = analysis.confidence;
    item.baselineMedianMs = Math.round(analysis.baseline.median);
    item.estimatedRemainingMs = analysis.estimatedRemainingMs;
    item.ratio = analysis.ratio;
    item.baselineSamples = analysis.baseline.samples;
  }
}

function score(item) {
  let result = attentionRank(item.attention) * 1000;

  // A local CI monitor must never allow historical terminal alerts to push
  // current work out of a bounded display candidate set.
  if (item.state === RunState.InProgress) result += 10000;
  else if (item.state === RunState.Queued) result += 9000;

  if (item.manualWatch) result += 100;
  result += Math.min(Math.floor(item.elapsedMs / 60000), 99);
  return result;
}

export function buildDashboard(
  tracker,
  analyzer,
  nowMs,
  nowEpoch,
  limit = 64,
  successTtlMs = 3600000,
  terminalTtlMs = 3600000
) {
  const result = [];
  for (const tracked of tracker.visible(nowMs, successTtlMs, terminalTtlMs)) {
    const run = tracked.snapshot;
    const item = {
      repository: run.repository,
      workflow: run.workflowName,
      stage: "",
      runId: run.runId,
      runNumber: run.runNumber,
      branch: run.branch,
      event: run.event,
      headSha: run.headSha,
      htmlUrl: run.htmlUrl,
      state: run.state,
      conclusion: run.conclusion,
      attention: AttentionLevel.Normal,
      confidence: "none",
      elapsedMs: 0,
      baselineMedianMs: 0,
      estimatedRemainingMs: 0,
      ratio: 0,
      possiblyStalled: false,
      manualWatch: tracked.manualWatch,
      acknowledged: tracked.acknowledged
    };

    let runAnalysis;
    if (nowEpoch > 1000000000) {
      runAnalysis = analyzer.analyzeRun(run, nowEpoch);
      item.elapsedMs = runAnalysis.elapsedMs;
    } else {
      const localElapsed = isTerminal(run.state) && tracked.terminalSinceMs
        ? tracked.terminalSinceMs - tracked.firstSeenMs
        : nowMs - tracked.firstSeenMs;
      runAnalysis = run.state === RunState.Queued
        ? analyzer.analyzeQueuedRun(run, localElapsed)
        : analyzer.analyze(
          baselineKey.run(run),
          localElapsed,
          isTerminal(run.state),
          run.conclusion
        );
      item.elapsedMs = localElapsed;
    }
    applyAnalysis(item, runAnalysis);

    let currentJob = run.jobs?.find((job) => job.state === RunState.InProgress);
    if (!currentJob) currentJob = run.jobs?.find((job) => job.state === RunState.Queued);

    if (currentJob) {
      item.stage = currentJob.name;
      const currentStep = currentJob.steps?.find((step) => step.state === RunState.InProgress);
      if (nowEpoch > 1000000000 && run.state !== RunState.Queued) {
        if (currentStep) {
          item.stage = currentStep.name;
          applyAnalysis(item, analyzer.analyzeStep(run, currentJob, currentStep, nowEpoch));
        } else {
          applyAnalysis(item, analyzer.analyzeJob(run, currentJob, nowEpoch));
        }
      }
    }

    result.push(item);
  }

  result.sort((a, b) => score(b) - score(a) || b.elapsedMs - a.elapsedMs);
  return result.slice(0, limit);
}
