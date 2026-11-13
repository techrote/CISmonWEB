import { AttentionLevel, RunState, baselineKey, isTerminal } from "./model.js";
import { runExecutionElapsedMs } from "./analyzer.js";
import { hasFreshJobDetails, jobActivitySummary, observedRunState } from "../worker-summary.js";

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
  if (item.executionState === RunState.InProgress) result += 10000;
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
    const activity = jobActivitySummary(run, nowMs);
    const item = {
      repository: run.repository,
      workflow: run.workflowName,
      workflowId: run.workflowId || 0,
      stage: "",
      runId: run.runId,
      runNumber: run.runNumber,
      runAttempt: run.runAttempt || 1,
      createdAtEpoch: run.createdAtEpoch || run.startedAtEpoch || 0,
      updatedAtEpoch: run.updatedAtEpoch || 0,
      baselineSamples: 0,
      stageKind: "",
      activeJobCount: 0,
      stageSummary: "",
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
      prCandidates: run.prCandidates || [],
      htmlUrl: run.htmlUrl,
      state: run.state, // never replace GitHub's provider status
      executionState: effectiveState, // used solely for execution time/priority
      providerState: run.state,
      jobActivity: activity,
      observedRunningJobs: activity.running,
      jobsCoverageComplete: activity.complete,
      jobsFetchedAtMs: run.jobsFetchedAtMs || 0,
      providerConfirmedAtMs: tracked.providerConfirmedAtMs || 0,
      providerAgeMs: tracked.providerConfirmedAtMs
        ? Math.max(0, nowMs - tracked.providerConfirmedAtMs) : null,
      // Completed runs are historical records, not stale live workflows.
      providerDataStale: run.state !== RunState.Completed &&
        !!tracked.providerConfirmedAtMs &&
        nowMs - tracked.providerConfirmedAtMs > 120_000,
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

    // Analyze every fresh executing matrix child. The first child is not
    // necessarily the slowest or most suspicious; preserve the run's own
    // MED/ETA/CONF/QTY while propagating *any* stage stall into attention.
    const visibleJobs = effectiveState !== RunState.Completed &&
      hasFreshJobDetails(run, nowMs) ? (run.jobs || []) : [];
    const activeJobs = visibleJobs.filter(job => job.state === RunState.InProgress);
    const waitingJobs = visibleJobs.filter(job => job.state === RunState.Queued);
    item.activeJobCount = activeJobs.length;
    if (activeJobs.length) {
      const assessed = [];
      for (const job of activeJobs) {
        const step = job.steps?.find(s => s.state === RunState.InProgress);
        if (nowEpoch <= 1000000000 || effectiveState !== RunState.InProgress) {
          assessed.push({ job, step, analysis: null,
            label: step?.name || job.name, kind: step ? "step" : "job",
            jobElapsedMs: 0 });
          continue;
        }
        const jobAnalysis = analyzer.analyzeJob(run, job, nowEpoch);
        const stepAnalysis = step ? analyzer.analyzeStep(run, job, step, nowEpoch) : null;
        // A job can be stuck even if its current step looks ordinary. Check
        // both scopes and take the more severe result; prefer a named step
        // when severities tie.
        for (const analysis of [jobAnalysis, stepAnalysis]) {
          if (!analysis) continue;
          if (attentionRank(analysis.attention) > attentionRank(item.attention)) {
            item.attention = analysis.attention;
          }
          item.possiblyStalled ||= !!analysis.possiblyStalled;
        }
        const stepIsRepresentative = stepAnalysis &&
          (attentionRank(stepAnalysis.attention) > attentionRank(jobAnalysis.attention) ||
          (attentionRank(stepAnalysis.attention) === attentionRank(jobAnalysis.attention) &&
            (!!stepAnalysis.possiblyStalled || !jobAnalysis.possiblyStalled)));
        assessed.push({
          job, step, kind: stepIsRepresentative ? "step" : "job",
          label: stepIsRepresentative ? step.name : job.name,
          analysis: stepIsRepresentative ? stepAnalysis : jobAnalysis,
          jobElapsedMs: jobAnalysis.elapsedMs || 0
        });
      }
      // Deterministic worst-child selection: severity, possible stall,
      // running duration, then stable job identity. All children still
      // contribute to aggregate attention.
      assessed.sort((x, y) =>
        attentionRank(y.analysis?.attention) - attentionRank(x.analysis?.attention) ||
        Number(!!y.analysis?.possiblyStalled) - Number(!!x.analysis?.possiblyStalled) ||
        y.jobElapsedMs - x.jobElapsedMs ||
        String(x.job.id || x.job.name).localeCompare(String(y.job.id || y.job.name))
      );
      const representative = assessed[0];
      if (representative.analysis) {
        applyStageAnalysis(item, representative.analysis, representative.kind);
      }
      const prefix = activeJobs.length > 1
        ? activeJobs.length + (activity.complete ? "" : "+") + " JOBS EXECUTING · " : "";
      item.stage = prefix + representative.label;
      item.stageSummary = activeJobs.length + " executing child jobs" +
        (activity.complete ? "" : " (partial job coverage)") +
        ". Representative highest-attention stage: " + representative.job.name +
        (representative.step && representative.kind === "step"
          ? " / " + representative.step.name : "") +
        ". All available executing jobs were independently analyzed for stalls.";
    } else if (waitingJobs.length) {
      item.stage = waitingJobs.length === 1 ? waitingJobs[0].name :
        waitingJobs.length + (activity.complete ? "" : "+") + " JOBS WAITING";
    }

    result.push(item);
  }

  result.sort((a, b) => score(b) - score(a) || b.elapsedMs - a.elapsedMs);
  return result.slice(0, limit);
}
