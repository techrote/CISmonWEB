import { AttentionLevel, RunState, baselineKey, isTerminal } from "./model.js";
import { runExecutionElapsedMs } from "./analyzer.js";
import { hasFreshJobDetails, observedRunningJobs, observedRunState } from "../worker-summary.js";

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

// Stage observations may increase attention, but must never overwrite the
// workflow-level MED/ETA/CONF/QTY/RATIO. Those fields are one coherent
// duration scope and must match the run detail dialog.
function applyStageAnalysis(item, analysis, kind) {
  if (attentionRank(analysis.attention) > attentionRank(item.attention)) {
    item.attention = analysis.attention;
  }
  item.possiblyStalled ||= analysis.possiblyStalled;
  item.stageKind = kind;
  item.stageElapsedMs = analysis.elapsedMs;
  item.stageAttention = analysis.attention;
  item.stagePossiblyStalled = analysis.possiblyStalled;
  item.stageConfidence = analysis.confidence;
  item.stageBaselineSamples = analysis.baseline.samples;
  item.stageBaselineMedianMs = analysis.baseline.samples > 0
    ? Math.round(analysis.baseline.median) : 0;
  item.stageEstimatedRemainingMs = analysis.baseline.samples > 0
    ? analysis.estimatedRemainingMs : 0;
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
    const effectiveState = observedRunState(run, nowMs);
    const analyzed = effectiveState === run.state ? run : { ...run, state: effectiveState };
    const runningJobs = observedRunningJobs(run, nowMs);
    const item = {
      repository: run.repository,
      workflow: run.workflowName,
      stage: "",
      runId: run.runId,
      runNumber: run.runNumber,
      createdAtEpoch: run.createdAtEpoch || run.startedAtEpoch || 0,
      updatedAtEpoch: run.updatedAtEpoch || 0,
      baselineSamples: 0,
      stageKind: "",
      stageElapsedMs: 0,
      stageAttention: AttentionLevel.Normal,
      stagePossiblyStalled: false,
      stageConfidence: "none",
      stageBaselineSamples: 0,
      stageBaselineMedianMs: 0,
      stageEstimatedRemainingMs: 0,
      branch: run.branch,
      event: run.event,
      headSha: run.headSha,
      checkSha: run.checkSha || "",
      prNumber: run.prNumber || 0,
      htmlUrl: run.htmlUrl,
      state: effectiveState,
      providerState: run.state,
      observedRunningJobs: runningJobs.length,
      jobsCoverageComplete: hasFreshJobDetails(run, nowMs) &&
        run.jobsCoverageComplete !== false,
      jobsFetchedAtMs: run.jobsFetchedAtMs || 0,
      conclusion: run.conclusion,
      attention: AttentionLevel.Normal,
      confidence: "none",
      elapsedMs: 0,
      elapsedLowerBound: false,
      waitingMs: 0,
      baselineMedianMs: 0,
      estimatedRemainingMs: 0,
      ratio: 0,
      possiblyStalled: false,
      manualWatch: tracked.manualWatch,
      acknowledged: tracked.acknowledged
    };

    let runAnalysis;
    if (nowEpoch > 1000000000) {
      runAnalysis = analyzer.analyzeRun(analyzed, nowEpoch);
      item.elapsedMs = runAnalysis.elapsedMs;
      item.elapsedLowerBound = !!runAnalysis.elapsedLowerBound;
      item.waitingMs = runAnalysis.waitingMs || 0;
    } else {
      const localElapsed = effectiveState === RunState.Completed
        ? tracked.terminalSinceMs - tracked.firstSeenMs
        : nowMs - tracked.firstSeenMs;
      const preciseElapsed = runExecutionElapsedMs(analyzed, nowEpoch);
      runAnalysis = effectiveState === RunState.Queued
        ? analyzer.analyzeQueuedRun(analyzed, localElapsed)
        : analyzer.analyze(
          baselineKey.run(analyzed),
          preciseElapsed || (effectiveState === RunState.InProgress &&
            !run.createdAtEpoch && !run.startedAtEpoch ? localElapsed : 0),
          isTerminal(effectiveState),
          run.conclusion
        );
      item.elapsedMs = runAnalysis.elapsedMs;
      item.elapsedLowerBound = !!runAnalysis.elapsedLowerBound;
      item.waitingMs = runAnalysis.waitingMs || 0;
    }
    applyAnalysis(item, runAnalysis);

    const visibleJobs = run.state === RunState.Queued &&
      !hasFreshJobDetails(run, nowMs) ? [] : (run.jobs || []);
    let currentJob = visibleJobs.find((job) => job.state === RunState.InProgress);
    if (!currentJob) currentJob = visibleJobs.find((job) => job.state === RunState.Queued);

    if (currentJob) {
      item.stage = currentJob.name;
      const currentStep = currentJob.steps?.find((step) => step.state === RunState.InProgress);
      if (nowEpoch > 1000000000 &&
          effectiveState !== RunState.Queued && currentJob.state === RunState.InProgress) {
        if (currentStep) {
          item.stage = currentStep.name;
          applyStageAnalysis(item,
            analyzer.analyzeStep(run, currentJob, currentStep, nowEpoch), "step");
        } else {
          applyStageAnalysis(item,
            analyzer.analyzeJob(run, currentJob, nowEpoch), "job");
        }
      }
    }

    result.push(item);
  }

  result.sort((a, b) => score(b) - score(a) || b.elapsedMs - a.elapsedMs);
  return result.slice(0, limit);
}
