import { RuntimeAnalyzer } from "./core/analyzer.js";
import { buildDashboard } from "./core/dashboard.js";
import { globMatch } from "./core/glob.js";
import { PollPolicy } from "./core/poll-policy.js";
import { RunState } from "./core/model.js";
import { RunTracker } from "./core/tracker.js";
import { GitHubClient, parseJob, parseRun } from "./github.js";
import {
  activityTimeFromGitHub,
  dueActiveRun,
  duePriorityRepository,
  shouldServiceActive,
  takeSweepBatch
} from "./scheduler.js";
import { shouldTrackSummaryRun } from "./summary-policy.js";

const REQUEST_SPACING_MS = 1000;
const BACKFILL_SPACING_MS = 1200;
const FAST_SWEEP_BATCH_SIZE = 4;
const ACTIVE_DETAIL_BURST_LIMIT = 1;
const MAX_LIVE_REPO_BURST = 2;
const ERROR_VISIBLE_MS = 90000;
const LIVE_FRESHNESS_WARNING_MS = 90000;
const REPOSITORY_CATALOG_REFRESH_MS = 10 * 60 * 1000;
const DASHBOARD_CANDIDATE_LIMIT = 4096;
const TERMINAL_IMPORT_LOOKBACK_MS = 3600000;

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
    this.activeDetailErrors = new Map();
    this.fastSweepQueue = [];
    this.fastSweepReason = "";
    this.activeDetailStreak = 0;
    this.liveRepoStreak = 0;
    this.lastSchedulerAction = "idle";
    this.nextRequestAllowedMs = 0;
    this.rateLimitedUntilMs = 0;
    this.rateRemaining = -1;
    this.lastError = "";
    this.lastErrorAtMs = 0;
    this.lastErrorScope = "";
    this.recentRequestErrors = 0;
    this.lastRateLimitReason = "";
    this.lastSuccessfulSummaryAtMs = 0;
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

  reportFailure(scope, response, nowMs = Date.now()) {
    const status = response?.status || 0;
    const detail = response?.error || (status ? "HTTP " + status : "network request failed");
    this.lastError = scope + " " + detail;
    this.lastErrorAtMs = nowMs;
    this.lastErrorScope = scope;
    this.recentRequestErrors += 1;
  }

  clearFailure(scope) {
    // A successful unrelated request must not mask a failing endpoint. But a
    // recovered endpoint should clear its own warning immediately.
    if (this.lastErrorScope === scope) {
      this.lastError = "";
      this.lastErrorAtMs = 0;
      this.lastErrorScope = "";
    }
  }

  updateRate(response, nowMs = Date.now()) {
    if (response.rateRemaining >= 0) this.rateRemaining = response.rateRemaining;
    const limited = response.rateLimited === true ||
      (response.rateLimited === undefined &&
        (response.status === 429 || response.rateRemaining === 0));
    if (limited) {
      const nowEpoch = Math.floor(Date.now() / 1000);
      const resetMs = response.rateResetEpoch > nowEpoch
        ? (response.rateResetEpoch - nowEpoch + 2) * 1000 : 0;
      const waitMs = Math.max(response.retryAfterMs || 0, resetMs, 60000);
      this.rateLimitedUntilMs = Math.max(this.rateLimitedUntilMs, nowMs + waitMs);
      this.lastRateLimitReason = response.status === 429 ? "secondary API limit" :
        "GitHub rate limit";
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
      this.reportFailure("GitHub", { error: "token not configured" }, nowMs);
      return false;
    }

    const response = await this.client.get("/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member");
    this.updateRate(response, Date.now());
    if (!response.ok || !Array.isArray(response.json)) {
      // A transient repository-list failure must not discard previously
      // discovered repositories, live run states, ETags, or poll scheduling.
      this.providerReady = this.repositories.length > 0;
      this.reportFailure("repository discovery", response, Date.now());
      return false;
    }

    const previous = new Map(this.repositories.map((repo) => [repo.fullName, repo]));
    const names = response.json
      .map((repo) => repo.full_name)
      .filter((name) => name && this.repositoryAllowed(name))
      .slice(0, this.config.maxRepositories);
    const added = [];
    this.repositories = names.map((fullName) => {
      if (previous.has(fullName)) return previous.get(fullName);
      added.push(fullName);
      return {
        fullName, etag: "", errors: 0, nextPollMs: 0,
        lastPollMs: 0, pollCount: 0, successfulPollCount: 0,
        lastSuccessAtMs: 0, lastResponseStatus: 0,
        lastActivityMs: 0, latestUpdatedEpoch: 0,
        hadActive: false, hadQueued: false
      };
    });
    this.providerReady = this.repositories.length > 0;
    this.nextDiscoveryMs = Date.now() + REPOSITORY_CATALOG_REFRESH_MS;
    if (this.providerReady) this.clearFailure("repository discovery");
    else this.reportFailure("repository discovery", { error: "no matching repositories" }, Date.now());
    if (this.providerReady && previous.size === 0) {
      this.startFastSweep("startup");
    } else if (added.length) {
      const queued = new Set(this.fastSweepQueue);
      this.fastSweepQueue.push(...added.filter((name) => !queued.has(name)));
      this.fastSweepReason = "new repositories";
    }
    return this.providerReady;
  }

  async applyConfig(input) {
    this.config = await this.configStore.update(input);
    this.history.setMaxPerKey(this.config.historyDepth);
    this.repositories = [];
    this.backfill = [];
    this.queuedBackfill.clear();
    this.activeDetailNextMs.clear();
    this.activeDetailErrors.clear();
    this.fastSweepQueue = [];
    this.activeDetailStreak = 0;
    this.liveRepoStreak = 0;
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
    this.liveRepoStreak = 0;
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
    const receivedMs = Date.now();
    this.updateRate(response, receivedMs);
    repo.lastResponseStatus = response.status;
    const scope = "repo:" + repo.fullName;

    if (response.notModified) {
      repo.errors = 0;
      repo.successfulPollCount += 1;
      repo.lastSuccessAtMs = receivedMs;
      this.lastSuccessfulSummaryAtMs = receivedMs;
      this.clearFailure(scope);
      const age = repo.lastActivityMs ? nowMs - repo.lastActivityMs : this.policy.warmWindowMs * 10;
      repo.nextPollMs = nowMs + this.policy.nextInterval(repo.hadActive, repo.hadQueued, age, 0);
      return true;
    }

    if (!response.ok || !Array.isArray(response.json?.workflow_runs)) {
      repo.errors += 1;
      repo.nextPollMs = receivedMs + this.policy.nextInterval(false, false, 0, repo.errors);
      this.reportFailure(scope, response, receivedMs);
      return false;
    }

    if (response.etag) repo.etag = response.etag;
    repo.errors = 0;
    repo.successfulPollCount += 1;
    repo.lastSuccessAtMs = receivedMs;
    this.lastSuccessfulSummaryAtMs = receivedMs;
    this.clearFailure(scope);
    let hasActive = false;
    let hasQueued = false;
    let newestUpdated = 0;
    let backfillQueued = 0;

    for (const raw of response.json.workflow_runs || []) {
      const run = parseRun(raw, repo.fullName);
      if (!run.runId) continue;
      newestUpdated = Math.max(newestUpdated, run.updatedAtEpoch);

      const existing = this.tracker.find(run.repository, run.runId);
      if (shouldTrackSummaryRun(run, Boolean(existing), nowMs, TERMINAL_IMPORT_LOOKBACK_MS)) {
        this.tracker.upsert(run, nowMs);
      }

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
      if (run.state === RunState.Completed) {
        this.activeDetailNextMs.delete(detailKey(run));
        this.activeDetailErrors.delete(detailKey(run));
      }
    }

    if (repo.latestUpdatedEpoch !== newestUpdated) {
      repo.latestUpdatedEpoch = newestUpdated;
      repo.lastActivityMs = activityTimeFromGitHub(newestUpdated, Date.now());
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
    if (rejected) this.reportFailure("repository sweep", { error: "unexpected polling exception" });
    if (!this.fastSweepQueue.length) this.fastSweepReason = "";
    this.activeDetailStreak = 0;
    this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
    return true;
  }

  async fetchRunDetails(run, nowMs, recordWhenComplete) {
    const response = await this.client.get(
      "/repos/" + run.repository + "/actions/runs/" + run.runId + "/jobs?per_page=100"
    );
    this.updateRate(response, Date.now());
    const scope = "jobs:" + detailKey(run);
    if (!response.ok || !Array.isArray(response.json?.jobs)) {
      this.reportFailure(scope, response, Date.now());
      return false;
    }
    this.clearFailure(scope);

    const detailed = {
      ...run,
      jobs: (response.json.jobs || []).map(parseJob)
    };

    const existing = this.tracker.find(detailed.repository, detailed.runId);
    if (!recordWhenComplete ||
        shouldTrackSummaryRun(detailed, Boolean(existing), nowMs, TERMINAL_IMPORT_LOOKBACK_MS)) {
      this.tracker.upsert(detailed, nowMs);
    }

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
      if (nowMs >= this.nextDiscoveryMs) {
        await this.discoverRepositories();
        this.lastSchedulerAction = "repository-catalog";
        this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
        return;
      }
      if (this.fastSweepQueue.length) {
        await this.pollFastSweep(nowMs);
        return;
      }

      const active = dueActiveRun(this.tracker.all(), this.activeDetailNextMs, nowMs, detailKey);
      const repo = duePriorityRepository(
        this.repositories, nowMs, this.liveRepoStreak, MAX_LIVE_REPO_BURST
      );

      if (shouldServiceActive(active, repo, this.activeDetailStreak, ACTIVE_DETAIL_BURST_LIMIT)) {
        const key = detailKey(active.snapshot);
        const ok = await this.fetchRunDetails(active.snapshot, nowMs, false);
        const errors = ok ? 0 : (this.activeDetailErrors.get(key) || 0) + 1;
        if (ok) this.activeDetailErrors.delete(key);
        else this.activeDetailErrors.set(key, errors);
        this.activeDetailNextMs.set(
          key,
          Date.now() + (ok ? this.policy.activeMs :
            this.policy.nextInterval(false, false, 0, errors))
        );
        this.activeDetailStreak += 1;
        this.lastSchedulerAction = "active-detail:" + key;
        this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
        return;
      }

      if (repo) {
        await this.pollRepository(repo, nowMs);
        this.liveRepoStreak = (repo.hadActive || repo.hadQueued)
          ? this.liveRepoStreak + 1 : 0;
        this.activeDetailStreak = 0;
        this.lastSchedulerAction = "repository:" + repo.fullName;
        this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
        return;
      }

      if (active) {
        const key = detailKey(active.snapshot);
        const ok = await this.fetchRunDetails(active.snapshot, nowMs, false);
        const errors = ok ? 0 : (this.activeDetailErrors.get(key) || 0) + 1;
        if (ok) this.activeDetailErrors.delete(key);
        else this.activeDetailErrors.set(key, errors);
        this.activeDetailNextMs.set(
          key,
          Date.now() + (ok ? this.policy.activeMs :
            this.policy.nextInterval(false, false, 0, errors))
        );
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
    const scannedRepositoryCount = this.repositories.filter(
      (repo) => repo.successfulPollCount > 0
    ).length;
    const dueRepositoryCount = this.repositories.filter(
      (repo) => Number(repo.nextPollMs || 0) <= nowMs
    ).length;
    const ages = this.repositories
      .filter(repo => repo.lastSuccessAtMs > 0)
      .map(repo => nowMs - repo.lastSuccessAtMs);
    const liveAges = this.repositories
      .filter(repo => (repo.hadActive || repo.hadQueued) && repo.lastSuccessAtMs > 0)
      .map(repo => nowMs - repo.lastSuccessAtMs);
    const oldestRepoSummaryAgeMs = ages.length ? Math.max(...ages) : null;
    const oldestLiveSummaryAgeMs = liveAges.length ? Math.max(...liveAges) : null;
    const freshError = this.lastError && nowMs - this.lastErrorAtMs < ERROR_VISIBLE_MS;
    const rateLimited = nowMs < this.rateLimitedUntilMs;
    const syncStatus = rateLimited ? "rate_limited" :
      !this.providerReady ? "offline" :
      scannedRepositoryCount < this.repositories.length ? "scanning" :
      oldestLiveSummaryAgeMs !== null && oldestLiveSummaryAgeMs > LIVE_FRESHNESS_WARNING_MS ? "stale" :
      freshError ? "degraded" : "online";
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
      oldestRepoSummaryAgeMs,
      oldestLiveSummaryAgeMs,
      lastSuccessfulSummaryAtMs: this.lastSuccessfulSummaryAtMs,
      syncStatus,
      recentRequestErrors: this.recentRequestErrors,
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
      rateLimitReason: rateLimited ? this.lastRateLimitReason : "",
      lastError: freshError || !this.providerReady ? this.lastError : "",
      lastErrorAgeMs: freshError ? nowMs - this.lastErrorAtMs : null,
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
