import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { Conclusion, RunState, baselineKey } from "./core/model.js";
import { elapsedMs, runExecutionElapsedMs, runExecutionEndEpoch } from "./core/analyzer.js";

function attemptNumber(value) {
  const attempt = Number(value);
  return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
}

function runKey(repository, runId, runAttempt = 1) {
  const attempt = attemptNumber(runAttempt);
  // Preserve old markers as attempt 1; GitHub reuses the run ID on reruns.
  return repository + "#" + runId + (attempt > 1 ? "@" + attempt : "");
}

export class FileHistoryStore {
  constructor(dataDir, maxPerKey = 64) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "history.jsonl");
    this.maxPerKey = maxPerKey;
    this.byKey = new Map();
    this.runs = new Set();
    this.writeQueue = Promise.resolve();
    this.needsSeparator = false;
  }

  setMaxPerKey(value) {
    this.maxPerKey = Math.max(8, Number(value) || 64);
    for (const [key, samples] of this.byKey.entries()) {
      if (samples.length > this.maxPerKey) this.byKey.set(key, samples.slice(-this.maxPerKey));
    }
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    this.byKey.clear();
    this.runs.clear();
    this.needsSeparator = false;
    const input = createReadStream(this.filePath);
    input.on("data", chunk => {
      // A crash can leave a truncated last line. Separate it from the next
      // append so that damage never consumes the next valid transaction.
      if (chunk.length) this.needsSeparator = chunk[chunk.length - 1] !== 10;
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.ingest(JSON.parse(line));
        } catch {
          // Keep a partially damaged journal usable; invalid lines are ignored.
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      lines.close();
      input.destroy();
    }
  }

  ingest(record) {
    if (!record || typeof record !== "object") return;
    if (record.type === "run") {
      if (typeof record.runKey !== "string" || !record.runKey || this.runs.has(record.runKey)) return;
      // New entries store the completion marker and its samples on one line.
      // Incomplete writes are ignored as a whole. Legacy sample/marker lines
      // remain readable, and duplicate new transactions are idempotent.
      for (const sample of Array.isArray(record.samples) ? record.samples : []) this.ingestSample(sample);
      this.runs.add(record.runKey);
      return;
    }
    if (record.type === "sample") this.ingestSample(record);
  }

  ingestSample(record) {
    if (!record || typeof record.key !== "string" || !record.key ||
        !Number.isFinite(record.durationMs) || record.durationMs <= 0 ||
        typeof record.successful !== "boolean") return;
    const samples = this.byKey.get(record.key) || [];
    samples.push({
      runId: record.runId,
      runAttempt: attemptNumber(record.runAttempt),
      durationMs: record.durationMs,
      successful: record.successful,
      completedAtEpoch: Number.isFinite(record.completedAtEpoch) ? record.completedAtEpoch : 0,
    });
    this.byKey.set(record.key, samples.slice(-this.maxPerKey));
  }

  samples(key, limit) {
    return (this.byKey.get(key) || []).slice(-limit);
  }

  hasRun(repository, runId, runAttempt = 1) {
    return this.runs.has(runKey(repository, runId, runAttempt));
  }

  recordRun(run) {
    const snapshot = structuredClone(run);
    const operation = this.writeQueue.then(() => this.appendRun(snapshot));
    // Keep the queue usable after a failed append; the caller still receives
    // the rejection, and no marker or in-memory sample is committed on error.
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async appendRun(run) {
    if (run.state !== RunState.Completed || typeof run.repository !== "string" ||
        !run.repository || !Number.isSafeInteger(run.runId) || run.runId <= 0) return false;
    const identity = runKey(run.repository, run.runId, run.runAttempt);
    if (this.runs.has(identity)) return false;

    const records = [];
    const add = (key, durationMs, successful, completedAtEpoch) => {
      if (!Number.isFinite(durationMs) || durationMs <= 0) return;
      records.push({
        type: "sample",
        key,
        runId: run.runId,
        runAttempt: attemptNumber(run.runAttempt),
        durationMs,
        successful,
        completedAtEpoch,
      });
    };

    // A prefix of a large matrix is not the whole workflow. Keep valid
    // individual job/step samples without teaching ETA a shortened duration.
    if (run.jobsCoverageComplete !== false &&
        (run.jobs || []).every(job => job.state === RunState.Completed)) {
      add(
        baselineKey.run(run),
        runExecutionElapsedMs(run, run.updatedAtEpoch),
        run.conclusion === Conclusion.Success,
        runExecutionEndEpoch(run),
      );
    }

    for (const job of run.jobs || []) {
      if (job.state !== RunState.Completed) continue;
      add(
        baselineKey.job(run, job),
        elapsedMs(job.startedAtEpoch, job.completedAtEpoch, job.completedAtEpoch),
        job.conclusion === Conclusion.Success,
        job.completedAtEpoch,
      );
      for (const step of job.steps || []) {
        if (step.state !== RunState.Completed) continue;
        add(
          baselineKey.step(run, job, step),
          elapsedMs(step.startedAtEpoch, step.completedAtEpoch, step.completedAtEpoch),
          step.conclusion === Conclusion.Success,
          step.completedAtEpoch,
        );
      }
    }

    const record = { type: "run", runKey: identity, samples: records };
    const payload = (this.needsSeparator ? "\n" : "") + JSON.stringify(record) + "\n";
    try {
      await appendFile(this.filePath, payload, { mode: 0o600 });
    } catch (error) {
      this.needsSeparator = true;
      throw error;
    }
    this.needsSeparator = false;
    this.ingest(record);
    return true;
  }
}
