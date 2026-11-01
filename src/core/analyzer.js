import { AttentionLevel, Conclusion, RunState, baselineKey, needsAttention } from "./model.js";
import { robustStats, robustZ } from "./statistics.js";

export function elapsedMs(startedEpoch, completedEpoch, nowEpoch) {
  if (!startedEpoch) return 0;
  const end = completedEpoch || nowEpoch;
  if (!end || end <= startedEpoch) return 0;
  return (end - startedEpoch) * 1000;
}

// Work begins when the first actual job starts. Workflow created_at is
// *never* an execution start; queued time must not contaminate ETA baselines.
export function runExecutionStartEpoch(run) {
  const startedJobs = (run.jobs || [])
    .map(job => Number(job.startedAtEpoch || 0))
    .filter(value => value > 0);
  if (startedJobs.length) return Math.min(...startedJobs);
  const witnessed = Number(run.observedStartedAtEpoch || 0);
  const provisional = Number(run.runStartedAtEpoch || 0);
  const created = Number(run.createdAtEpoch || 0);
  // When a queued→running transition was witnessed, that observation must
  // win over a provisional run_started_at which may include queue delay.
  if (witnessed > 0) return witnessed;
  // For runs first discovered already running, a distinct API start is the
  // best available estimate until actual job timestamps arrive.
  if (provisional > created && provisional > 0) return provisional;
  // Legacy normalized fixtures (and earlier-source records) only supplied
  // startedAtEpoch; new GitHub rows always include createdAtEpoch explicitly.
  if (!created && Number(run.startedAtEpoch || 0) > 0) return Number(run.startedAtEpoch);
  if (provisional > 0 && !created) return provisional;
  if (run.state === RunState.InProgress) {
    return Number(run.firstObservedRunningAtEpoch || 0);
  }
  return 0;
}

export function runExecutionEndEpoch(run) {
  const finishedJobs = (run.jobs || [])
    .map(job => Number(job.completedAtEpoch || 0))
    .filter(value => value > 0);
  if (finishedJobs.length) return Math.max(...finishedJobs);
  return Number(run.updatedAtEpoch || 0);
}

// When the only execution evidence is a local observation, duration is a
// lower bound. Do not mistake it for a reliable start or train ETA from it.
export function isObservedOnlyExecutionStart(run) {
  if (run.state !== RunState.InProgress) return false;
  const hasStartedJob = (run.jobs || []).some(job => Number(job.startedAtEpoch || 0) > 0);
  return !hasStartedJob &&
    !Number(run.observedStartedAtEpoch || 0) &&
    !(Number(run.runStartedAtEpoch || 0) > Number(run.createdAtEpoch || 0)) &&
    !!Number(run.firstObservedRunningAtEpoch || 0) &&
    !!Number(run.createdAtEpoch || 0);
}

export function runExecutionElapsedMs(run, nowEpoch) {
  const start = runExecutionStartEpoch(run);
  if (run.state === RunState.Queued || !start) return 0;
  return elapsedMs(start,
    run.state === RunState.Completed ? runExecutionEndEpoch(run) : 0, nowEpoch);
}

export function runQueueWaitingMs(run, nowEpoch) {
  if (run.state !== RunState.Queued) return 0;
  return elapsedMs(run.createdAtEpoch || run.startedAtEpoch, 0, nowEpoch);
}

function confidenceFor(samples) {
  if (samples === 0) return "none";
  if (samples < 5) return "low";
  if (samples < 16) return "medium";
  return "high";
}

export class RuntimeAnalyzer {
  constructor(history, sampleWindow = 32) {
    this.history = history;
    this.sampleWindow = sampleWindow;
  }

  analyze(key, elapsed, completed, conclusion) {
    const result = {
      attention: AttentionLevel.Normal,
      confidence: "none",
      baseline: robustStats([]),
      elapsedMs: elapsed,
      deltaMs: 0,
      ratio: 0,
      z: 0,
      possiblyStalled: false,
      estimatedRemainingMs: 0,
      reason: "",
    };

    if (needsAttention(conclusion)) {
      result.attention = AttentionLevel.ActionRequired;
      result.reason = "failed";
    }

    const durations = this.history.samples(key, this.sampleWindow)
      .filter((sample) => sample.successful && sample.durationMs > 0)
      .map((sample) => sample.durationMs);

    result.baseline = robustStats(durations);
    result.confidence = confidenceFor(result.baseline.samples);
    if (result.baseline.samples === 0 || result.baseline.median <= 0) return result;

    result.deltaMs = elapsed - Math.round(result.baseline.median);
    result.ratio = elapsed / result.baseline.median;
    result.z = robustZ(elapsed, result.baseline);

    if (!completed && elapsed < result.baseline.median) {
      result.estimatedRemainingMs = Math.round(result.baseline.median - elapsed);
    }

    if (result.attention === AttentionLevel.ActionRequired) return result;

    if (result.baseline.samples < 3) {
      if (result.ratio >= 2.0) {
        result.attention = AttentionLevel.Interesting;
        result.reason = "well beyond sparse baseline";
      }
      return result;
    }

    if (result.ratio >= 3.0 || result.z >= 6.0) {
      result.attention = AttentionLevel.Suspicious;
      result.possiblyStalled = !completed;
      result.reason = result.possiblyStalled ? "possible stall" : "extreme runtime";
    } else if (result.ratio >= 1.75 || result.z >= 4.0) {
      result.attention = AttentionLevel.Suspicious;
      result.reason = "far slower than baseline";
    } else if (result.ratio >= 1.30 || result.z >= 2.5) {
      result.attention = AttentionLevel.Interesting;
      result.reason = "slower than baseline";
    }
    return result;
  }

  analyzeQueuedRun(run, waitingMs) {
    const result = this.analyze(baselineKey.run(run), 0, false, Conclusion.Unknown);
    result.elapsedMs = 0;
    result.waitingMs = waitingMs;
    result.estimatedRemainingMs = 0;
    result.reason = "queued; execution has not started";
    return result;
  }

  analyzeRun(run, nowEpoch) {
    const elapsed = runExecutionElapsedMs(run, nowEpoch);
    if (run.state === RunState.Queued) {
      return this.analyzeQueuedRun(run, runQueueWaitingMs(run, nowEpoch));
    }
    const analyzed = this.analyze(
      baselineKey.run(run), elapsed,
      run.state === RunState.Completed, run.conclusion
    );
    if (isObservedOnlyExecutionStart(run)) {
      analyzed.elapsedLowerBound = true;
      // An observed-only timer counts time since CISmon noticed the workflow,
      // not total execution. It must not feed a false remaining ETA or stall.
      analyzed.estimatedRemainingMs = 0;
      analyzed.ratio = 0;
      analyzed.z = 0;
      analyzed.possiblyStalled = false;
      if (analyzed.attention !== AttentionLevel.ActionRequired) {
        analyzed.attention = AttentionLevel.Normal;
      }
      analyzed.reason = "execution elapsed is a lower bound since first observation";
    }
    return analyzed;
  }

  analyzeJob(run, job, nowEpoch) {
    return this.analyze(
      baselineKey.job(run, job),
      elapsedMs(job.startedAtEpoch, job.completedAtEpoch, nowEpoch),
      job.state === RunState.Completed,
      job.conclusion,
    );
  }

  analyzeStep(run, job, step, nowEpoch) {
    return this.analyze(
      baselineKey.step(run, job, step),
      elapsedMs(step.startedAtEpoch, step.completedAtEpoch, nowEpoch),
      step.state === RunState.Completed,
      step.conclusion,
    );
  }
}

export { Conclusion };
