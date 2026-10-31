import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Conclusion, baselineKey } from "./core/model.js";
import { elapsedMs, runExecutionElapsedMs, runExecutionEndEpoch } from "./core/analyzer.js";

function runKey(repository, runId) {
  return repository + "#" + runId;
}

export class FileHistoryStore {
  constructor(dataDir, maxPerKey = 64) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "history.jsonl");
    this.maxPerKey = maxPerKey;
    this.byKey = new Map();
    this.runs = new Set();
  }

  setMaxPerKey(value) {
    this.maxPerKey = Math.max(8, Number(value) || 64);
    for (const [key, samples] of this.byKey.entries()) {
      if (samples.length > this.maxPerKey) this.byKey.set(key, samples.slice(-this.maxPerKey));
    }
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const text = await readFile(this.filePath, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          this.ingest(JSON.parse(line));
        } catch {
          // Keep a partially damaged journal usable; invalid lines are ignored.
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  ingest(record) {
    if (record.type === "run") {
      this.runs.add(record.runKey);
      return;
    }
    if (record.type !== "sample" || !record.key) return;
    const samples = this.byKey.get(record.key) || [];
    samples.push({
      runId: record.runId,
      durationMs: record.durationMs,
      successful: Boolean(record.successful),
      completedAtEpoch: record.completedAtEpoch || 0,
    });
    this.byKey.set(record.key, samples.slice(-this.maxPerKey));
  }

  samples(key, limit) {
    return (this.byKey.get(key) || []).slice(-limit);
  }

  hasRun(repository, runId) {
    return this.runs.has(runKey(repository, runId));
  }

  async recordRun(run) {
    const identity = runKey(run.repository, run.runId);
    if (this.runs.has(identity)) return false;

    const records = [];
    const add = (key, durationMs, successful, completedAtEpoch) => {
      if (durationMs <= 0) return;
      records.push({
        type: "sample",
        key,
        runId: run.runId,
        durationMs,
        successful,
        completedAtEpoch,
      });
    };

    add(
      baselineKey.run(run),
      runExecutionElapsedMs(run, run.updatedAtEpoch),
      run.conclusion === Conclusion.Success,
      runExecutionEndEpoch(run),
    );

    for (const job of run.jobs || []) {
      add(
        baselineKey.job(run, job),
        elapsedMs(job.startedAtEpoch, job.completedAtEpoch, job.completedAtEpoch),
        job.conclusion === Conclusion.Success,
        job.completedAtEpoch,
      );
      for (const step of job.steps || []) {
        add(
          baselineKey.step(run, job, step),
          elapsedMs(step.startedAtEpoch, step.completedAtEpoch, step.completedAtEpoch),
          step.conclusion === Conclusion.Success,
          step.completedAtEpoch,
        );
      }
    }

    records.push({ type: "run", runKey: identity });
    await appendFile(this.filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
    for (const record of records) this.ingest(record);
    return true;
  }
}
