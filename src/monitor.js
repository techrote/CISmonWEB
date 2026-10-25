import { RuntimeAnalyzer } from "./core/analyzer.js";
import { buildDashboard } from "./core/dashboard.js";
import { globMatch } from "./core/glob.js";
import { PollPolicy } from "./core/poll-policy.js";
import { RunState } from "./core/model.js";
import { RunTracker } from "./core/tracker.js";
import { GitHubClient, parseJob, parseRun } from "./github.js";
import {
  dueActiveRun,
  dueRepository,
  shouldServiceActive,
  takeSweepBatch
} from "./scheduler.js";

const REQUEST_SPACING_MS = 1000;
const BACKFILL_SPACING_MS = 1200;
const FAST_SWEEP_BATCH_SIZE = 6;
const ACTIVE_DETAIL_BURST_LIMIT = 3;
const DASHBOARD_CANDIDATE_LIMIT = 512;

function detailKey(run) {
  return run.repository + "#" + run.runId;
}

export class Monitor {
  constructor(configStore, history) {
    this.configStore = configStore;
    this.history = history;
    this.config = null;
    this.tracker = new RunTracker();
    this.analyzer = new RuntimeAnalyzer(history, 32);
    this.policy = new PollPolicy();
    this.repositories = [];
    this.backfill = [];
    this.queuedBackfill = new Set();
    this.activeDetailNextMs = new Map();
    this.fastSweepQueue = [];
    this.fastSweepReason = "";
    this.activeDetailStreak = 0;
    this.lastSchedulerAction = "idle";
    this.nextRequestAllowedMs = 0;
    this.rateLimitedUntilMs = 0;
    this.rateRemaining = -1;
    this.lastError = "";
    this.providerReady = false;
    this.busy = false;
    this.nextDiscoveryMs = 0;
    this.timer = null;
  }

  async init() {
    this.config = await this.configStore.load();
    this.history.setMaxPerKey(this.config.historyDepth);
    await this.history.load();
    this.client = new GitHubClient(() => this.config.githubToken);
    await this.discoverRepositories();
    this.timer = setInterval(() => {
      this.tick().catch((error) => { this.lastError = error.message; });
    }, 250);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  repositoryAllowed(fullName) {
    if (this.config.githubOwner && !fullName.startsWith(this.config.githubOwner + "/")) return false;
    const included = this.config.includePatterns.length === 0 ||
      this.config.includePatterns.some((pattern) => globMatch(pattern, fullName));
    if (!included) return false;
    return !this.config.excludePatterns.some((pattern) => globMatch(pattern, fullName));
  }

  updateRate(response, nowMs) {
    if (response.rateRemaining >= 0) this.rateRemaining = response.rateRemaining;
    if ((response.status === 403 || response.status === 429 || response.rateRemaining === 0) &&
        response.rateResetEpoch > 0) {
      const nowEpoch = Math.floor(Date.now() / 1000);
      this.rateLimitedUntilMs = response.rateResetEpoch > nowEpoch
        ? nowMs + (response.rateResetEpoch - nowEpoch + 2) * 1000
        : nowMs + 60000;
    }
  }

  startFastSweep(reason) {
    this.fastSweepQueue = this.repositories.map((repo) => repo.fullName);
    this.fastSweepReason = reason;
    this.nextRequestAllowedMs = 0;
    this.lastSchedulerAction = "sweep:" + reason;
  }

  async discoverRepositories() {
    const nowMs = Date.now();
    this.nextDiscoveryMs = nowMs + 60000;
    if (!this.config.githubToken) {
      this.providerReady = false;
      this.repositories = [];
      this.fastSweepQueue = [];
      this.lastError = "GitHub token not configured";
      return false;
    }

    const response = await this.client.get("/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member");
    this.updateRate(response, nowMs);
    if (!response.ok || !Array.isArray(response.json)) {
      this.providerReady = false;
      this.lastError = "repository discovery HTTP " + response.status;
      return false;
    }

    this.repositories = response.json
      .map((repo) => repo.full_name)
      .filter((name) => name && this.repositoryAllowed(name))
      .slice(0, this.config.maxRepositories)
      .map((fullName) => ({
        fullName,
        etag: "",
        errors: 0,
        nextPollMs: 0,
        lastPollMs: 0,
        pollCount: 0,
        lastActivityMs: 0,
        latestUpdatedEpoch: 0,
        hadActive: false,
        hadQueued: false
      }));

    this.providerReady = this.repositories.length > 0;
    this.lastError = this.providerReady ? "" : "no matching repositories";
    if (this.providerReady) this.startFastSweep("startup");
    return this.providerReady;
  }

  async applyConfig(input) {
    this.config = await this.configStore.update(input);
    this.history.setMaxPerKey(this.config.historyDepth);
    this.repositories = [];
    this.backfill = [];
    this.queuedBackfill.clear();
    this.activeDetailNextMs.clear();
    this.fastSweepQueue = [];
    this.activeDetailStreak = 0;
    this.providerReady = false;
    await this.discoverRepositories();
    return this.configStore.publicConfig();
  }

  async applyDisplayConfig(input) {
    this.config = await this.configStore.update({
      surfaces: input.surfaces ?? this.config.surfaces,
      activeSurfaceId: input.activeSurfaceId ?? this.config.activeSurfaceId
    });
    return this.configStore.publicConfig();
  }

  async refresh() {
    if (!this.providerReady) return this.discoverRepositories();
    for (const repo of this.repositories) repo.nextPollMs = 0;
    for (const key of this.activeDetailNextMs.keys()) this.activeDetailNextMs.set(key, 0);
    this.activeDetailStreak = 0;
    this.startFastSweep("manual");
    return true;
  }

  queueBackfill(run) {
    const key = detailKey(run);
    if (this.queuedBackfill.has(key)) return;
    this.queuedBackfill.add(key);
    this.backfill.push({ ...run, jobs: [] });
  }

  async pollRepository(repo, nowMs) {
    repo.lastPollMs = nowMs;
    repo.pollCount += 1;

    const response = await this.client.get(
      "/repos/" + repo.fullName + "/actions/runs?per_page=100",
      repo.etag
    );
    this.updateRate(response, nowMs);

    if (response.notModified) {
      repo.errors = 0;
      const age = repo.lastActivityMs ? nowMs - repo.lastActivityMs : this.policy.warmWindowMs * 10;
      repo.nextPollMs = nowMs + this.policy.nextInterval(repo.hadActive, repo.hadQueued, age, 0);
      return true;
    }

    if (!response.ok || !response.json) {
      repo.errors += 1;
      repo.nextPollMs = nowMs + this.policy.nextInterval(false, false, 0, repo.errors);
      this.lastError = repo.fullName + " runs HTTP " + response.status;
      return false;
    }

    if (response.etag) repo.etag = response.etag;
    repo.errors = 0;
    let hasActive = false;
    let hasQueued = false;
    let newestUpdated = 0;
    let backfillQueued = 0;

    for (const raw of response.json.workflow_runs || []) {
      const run = parseRun(raw, repo.fullName);
      if (!run.runId) continue;
      newestUpdated = Math.max(newestUpdated, run.updatedAtEpoch);
      this.tracker.upsert(run, nowMs);

      if (run.state === RunState.InProgress) {
        hasActive = true;
        if (!this.activeDetailNextMs.has(detailKey(run))) {
          this.activeDetailNextMs.set(detailKey(run), 0);
        }
      } else if (run.state === RunState.Queued) {
        hasQueued = true;
      } else if (run.state === RunState.Completed &&
                 backfillQueued < this.config.backfillRunsPerRepo &&
                 !this.history.hasRun(run.repository, run.runId)) {
        this.queueBackfill(run);
        backfillQueued += 1;
      }
    }

    if (repo.latestUpdatedEpoch !== newestUpdated) {
      repo.latestUpdatedEpoch = newestUpdated;
      repo.lastActivityMs = nowMs;
    }
    repo.hadActive = hasActive;
    repo.hadQueued = hasQueued;
    const age = repo.lastActivityMs ? nowMs - repo.lastActivityMs : this.policy.warmWindowMs * 10;
    repo.nextPollMs = nowMs + this.policy.nextInterval(hasActive, hasQueued, age, 0);
    return true;
  }

  async pollFastSweep(nowMs) {
    const batch = takeSweepBatch(this.fastSweepQueue, this.repositories, FAST_SWEEP_BATCH_SIZE);
    if (!batch.length) {
      this.fastSweepReason = "";
      return false;
    }

    this.lastSchedulerAction = "sweep:" + this.fastSweepReason;
    const results = await Promise.allSettled(batch.map((repo) => this.pollRepository(repo, nowMs)));
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) this.lastError = "repository sweep: " + rejected.reason.message;
    if (!this.fastSweepQueue.length) this.fastSweepReason = "";
    this.activeDetailStreak = 0;
    this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
    return true;
  }

  async fetchRunDetails(run, nowMs, recordWhenComplete) {
    const response = await this.client.get(
      "/repos/" + run.repository + "/actions/runs/" + run.runId + "/jobs?per_page=100"
    );
    this.updateRate(response, nowMs);
    if (!response.ok || !response.json) {
      this.lastError = run.repository + " jobs HTTP " + response.status;
      return false;
    }

    const detailed = {
      ...run,
      jobs: (response.json.jobs || []).map(parseJob)
    };
    this.tracker.upsert(detailed, nowMs);
    if (recordWhenComplete && detailed.state === RunState.Completed) {
      await this.history.recordRun(detailed);
    }
    return true;
  }

  async tick() {
    if (this.busy) return;
    const nowMs = Date.now();
    this.tracker.prune(nowMs);
    if (nowMs < this.nextRequestAllowedMs || nowMs < this.rateLimitedUntilMs) return;

    if (!this.providerReady) {
      if (nowMs >= this.nextDiscoveryMs) await this.discoverRepositories();
      return;
    }

    this.busy = true;
    try {
      if (this.fastSweepQueue.length) {
        await this.pollFastSweep(nowMs);
        return;
      }

      const active = dueActiveRun(this.tracker.all(), this.activeDetailNextMs, nowMs, detailKey);
      const repo = dueRepository(this.repositories, nowMs);

      if (shouldServiceActive(active, repo, this.activeDetailStreak, ACTIVE_DETAIL_BURST_LIMIT)) {
        const key = detailKey(active.snapshot);
        await this.fetchRunDetails(active.snapshot, nowMs, false);
        this.activeDetailNextMs.set(key, nowMs + this.policy.activeMs);
        this.activeDetailStreak += 1;
        this.lastSchedulerAction = "active-detail:" + key;
        this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
        return;
      }

      if (repo) {
        await this.pollRepository(repo, nowMs);
        this.activeDetailStreak = 0;
        this.lastSchedulerAction = "repository:" + repo.fullName;
        this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
        return;
      }

      if (active) {
        const key = detailKey(active.snapshot);
        await this.fetchRunDetails(active.snapshot, nowMs, false);
        this.activeDetailNextMs.set(key, nowMs + this.policy.activeMs);
        this.activeDetailStreak += 1;
        this.lastSchedulerAction = "active-detail:" + key;
        this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
        return;
      }

      while (this.backfill.length) {
        const run = this.backfill.shift();
        this.queuedBackfill.delete(detailKey(run));
        if (this.history.hasRun(run.repository, run.runId)) continue;
        await this.fetchRunDetails(run, nowMs, true);
        this.activeDetailStreak = 0;
        this.lastSchedulerAction = "backfill:" + detailKey(run);
        this.nextRequestAllowedMs = Date.now() + BACKFILL_SPACING_MS;
        return;
      }

      this.lastSchedulerAction = "idle";
    } finally {
      this.busy = false;
    }
  }

  state() {
    const nowMs = Date.now();
    const nowEpoch = Math.floor(nowMs / 1000);
    const tracked = this.tracker.all();
    const scannedRepositoryCount = this.repositories.filter((repo) => repo.pollCount > 0).length;
    const dueRepositoryCount = this.repositories.filter((repo) => Number(repo.nextPollMs || 0) <= nowMs).length;
    const trackedActiveCount = tracked.filter((run) => run.snapshot.state === RunState.InProgress).length;
    const trackedQueuedCount = tracked.filter((run) => run.snapshot.state === RunState.Queued).length;
    const trackedCompletedCount = tracked.filter((run) => run.snapshot.state === RunState.Completed).length;
    const rows = buildDashboard(
      this.tracker,
      this.analyzer,
      nowMs,
      nowEpoch,
      DASHBOARD_CANDIDATE_LIMIT
    );

    return {
      providerReady: this.providerReady,
      repositoryCount: this.repositories.length,
      scannedRepositoryCount,
      pendingSweepCount: this.fastSweepQueue.length,
      sweepReason: this.fastSweepReason,
      dueRepositoryCount,
      trackedRunCount: tracked.length,
      trackedActiveCount,
      trackedQueuedCount,
      trackedCompletedCount,
      dashboardCandidateCount: rows.length,
      schedulerAction: this.lastSchedulerAction,
      rateRemaining: this.rateRemaining,
      rateLimitedUntil: this.rateLimitedUntilMs || 0,
      lastError: this.lastError,
      updatedAt: nowMs,
      rows
    };
  }

  detail(repository, runId) {
    const tracked = this.tracker.find(repository, runId);
    if (!tracked) return null;
    const nowEpoch = Math.floor(Date.now() / 1000);
    const run = tracked.snapshot;
    return {
      ...run,
      acknowledged: tracked.acknowledged,
      manualWatch: tracked.manualWatch,
      analysis: this.analyzer.analyzeRun(run, nowEpoch),
      jobs: (run.jobs || []).map((job) => ({
        ...job,
        analysis: this.analyzer.analyzeJob(run, job, nowEpoch),
        steps: (job.steps || []).map((step) => ({
          ...step,
          analysis: this.analyzer.analyzeStep(run, job, step, nowEpoch)
        }))
      }))
    };
  }
}
