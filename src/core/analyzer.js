import { AttentionLevel, Conclusion, RunState, baselineKey, needsAttention } from "./model.js";
import { robustStats, robustZ } from "./statistics.js";

export function elapsedMs(startedEpoch, completedEpoch, nowEpoch) {
  if (!startedEpoch) return 0;
  const end = completedEpoch || nowEpoch;
  if (!end || end <= startedEpoch) return 0;
  return (end - startedEpoch) * 1000;
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

  analyzeRun(run, nowEpoch) {
    return this.analyze(
      baselineKey.run(run),
      elapsedMs(run.startedAtEpoch, run.state === RunState.Completed ? run.updatedAtEpoch : 0, nowEpoch),
      run.state === RunState.Completed,
      run.conclusion,
    );
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
