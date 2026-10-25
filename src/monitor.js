import { RuntimeAnalyzer } from "./core/analyzer.js";
import { buildDashboard } from "./core/dashboard.js";
import { globMatch } from "./core/glob.js";
import { PollPolicy } from "./core/poll-policy.js";
import { RunState } from "./core/model.js";
import { RunTracker } from "./core/tracker.js";
import { GitHubClient, parseJob, parseRun } from "./github.js";

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
    }, 500);
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

  async discoverRepositories() {
    const nowMs = Date.now();
    this.nextDiscoveryMs = nowMs + 60000;
    if (!this.config.githubToken) {
      this.providerReady = false;
      this.repositories = [];
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
        lastActivityMs: 0,
        latestUpdatedEpoch: 0,
        hadActive: false,
        hadQueued: false
      }));

    this.providerReady = this.repositories.length > 0;
    this.lastError = this.providerReady ? "" : "no matching repositories";
    return this.providerReady;
  }

  async applyConfig(input) {
    this.config = await this.configStore.update(input);
    this.history.setMaxPerKey(this.config.historyDepth);
    this.repositories = [];
    this.backfill = [];
    this.queuedBackfill.clear();
    this.activeDetailNextMs.clear();
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
    for (const value of this.activeDetailNextMs.keys()) this.activeDetailNextMs.set(value, 0);
    this.nextRequestAllowedMs = 0;
    return true;
  }

  queueBackfill(run) {
    const key = detailKey(run);
    if (this.queuedBackfill.has(key)) return;
    this.queuedBackfill.add(key);
    this.backfill.push({ ...run, jobs: [] });
  }

  async pollRepository(repo, nowMs) {
    const response = await this.client.get("/repos/" + repo.fullName + "/actions/runs?per_page=20", repo.etag);
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
        if (!this.activeDetailNextMs.has(detailKey(run))) this.activeDetailNextMs.set(detailKey(run), 0);
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
    this.lastError = "";
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
      for (const tracked of this.tracker.all()) {
        if (tracked.snapshot.state !== RunState.InProgress) continue;
        const key = detailKey(tracked.snapshot);
        const due = this.activeDetailNextMs.get(key) ?? 0;
        if (nowMs < due) continue;
        await this.fetchRunDetails(tracked.snapshot, nowMs, false);
        this.activeDetailNextMs.set(key, nowMs + this.policy.activeMs);
        this.nextRequestAllowedMs = nowMs + 1000;
        return;
      }

      for (const repo of this.repositories) {
        if (nowMs < repo.nextPollMs) continue;
        await this.pollRepository(repo, nowMs);
        this.nextRequestAllowedMs = nowMs + 1000;
        return;
      }

      while (this.backfill.length) {
        const run = this.backfill.shift();
        this.queuedBackfill.delete(detailKey(run));
        if (this.history.hasRun(run.repository, run.runId)) continue;
        await this.fetchRunDetails(run, nowMs, true);
        this.nextRequestAllowedMs = nowMs + 1200;
        return;
      }
    } finally {
      this.busy = false;
    }
  }

  state() {
    const nowMs = Date.now();
    const nowEpoch = Math.floor(nowMs / 1000);
    return {
      providerReady: this.providerReady,
      repositoryCount: this.repositories.length,
      rateRemaining: this.rateRemaining,
      rateLimitedUntil: this.rateLimitedUntilMs || 0,
      lastError: this.lastError,
      updatedAt: nowMs,
      rows: buildDashboard(this.tracker, this.analyzer, nowMs, nowEpoch, 64)
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
