import { RuntimeAnalyzer } from "./core/analyzer.js";
import { checkTarget, summarizeCheckRuns } from "./check-summary.js";
import {
  workflowActivitySummary, shouldKeepRepository, ACTIVITY_RECHECK_MS
} from "./activity-selection.js";
import { activeWorkerSummary, observedRunningJobs, observedRunState } from "./worker-summary.js";
import { buildDashboard, PARENT_STALE_MS } from "./core/dashboard.js";
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
const STALE_CLEAR_BATCH_LIMIT = 50;
const MAX_LIVE_REPO_BURST = 2;
const ERROR_VISIBLE_MS = 90000;
const LIVE_FRESHNESS_WARNING_MS = 90000;
const REPOSITORY_CATALOG_REFRESH_MS = 10 * 60 * 1000;
const DASHBOARD_CANDIDATE_LIMIT = 4096;
const TERMINAL_IMPORT_LOOKBACK_MS = 3600000;
const MAX_JOB_DETAIL_PAGES = 20;
const JOB_PAGE_SIZE = 100;
const CHECK_PAGE_SIZE = 100;
const MAX_CHECK_PAGES = 10;
const MAX_CHECK_TARGETS = 80;
const CHECK_ACTIVE_REFRESH_MS = 90000;
const CHECK_FINISHED_REFRESH_MS = 10 * 60000;
const CHECK_PERMISSION_RETRY_MS = 15 * 60000;
const CHECK_SERVICE_INTERVAL = 5;

function detailKey(run) {
  return run.repository + "#" + run.runId;
}

function attemptNumber(run) {
  const value = Number(run.runAttempt || 1);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function backfillKey(run) {
  return detailKey(run) + "@" + attemptNumber(run);
}

function isLive(run) {
  return run.state === RunState.Queued || run.state === RunState.InProgress;
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
    this.activityCandidates = new Map();
    this.activityProbeQueue = [];
    this.normalRequestsSinceActivityProbe = 0;
    this.backfill = [];
    this.queuedBackfill = new Set();
    this.activeDetailNextMs = new Map();
    this.activeDetailErrors = new Map();
    // A recent-runs list is a bounded window, not an inventory. Runs which
    // leave that window need their own authoritative status confirmation.
    this.runReconciliations = new Map();
    // One page per scheduler request; continuation pages take precedence over
    // a new scan so active jobs beyond page 1 are discovered promptly.
    this.liveJobScans = new Map();
    this.checkSnapshots = new Map();
    this.normalRequestsSinceCheck = 0;
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
    this.providerGeneration = 0;
    this.configUpdates = Promise.resolve();
    this.pendingProviderUpdates = 0;
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
      this.tick().catch((error) => {
        this.reportFailure("scheduler", {
          error: error?.message || "unexpected polling failure"
        });
      });
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
    const generation = this.providerGeneration;
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
    if (generation !== this.providerGeneration) return false;
    this.updateRate(response, Date.now());
    if (!response.ok || !Array.isArray(response.json)) {
      // A transient repository-list failure must not discard previously
      // discovered repositories, live run states, ETags, or poll scheduling.
      this.providerReady = this.repositories.length > 0;
      this.reportFailure("repository discovery", response, Date.now());
      return false;
    }

    const activityMode = this.config.repositorySelectionMode === "activity";
    if (activityMode) {
      // Candidate discovery does not itself admit a repository. Only a
      // successful workflow activity probe can put it on the watched list.
      const eligible = response.json
        .map(repo => repo.full_name)
        .filter(name => name && this.repositoryAllowed(name))
        .slice(0, this.config.maxRepositories);
      const old = this.activityCandidates;
      const next = new Map();
      for (const name of eligible) {
        const candidate = old.get(name) || {
          fullName: name, lastProbeMs: 0, nextProbeMs: 0, errors: 0
        };
        next.set(name, candidate);
      }
      this.activityCandidates = next;
      for (const repo of this.repositories) {
        if (!next.has(repo.fullName)) this.dropRepositoryTracking(repo.fullName);
      }
      this.repositories = this.repositories.filter(repo => next.has(repo.fullName));
      const queued = new Set(this.activityProbeQueue.filter(name => next.has(name)));
      for (const [name, candidate] of next) {
        if (!this.repositories.some(repo => repo.fullName === name) &&
            candidate.nextProbeMs <= Date.now()) queued.add(name);
      }
      this.activityProbeQueue = [...queued];
      this.providerReady = eligible.length > 0;
      this.nextDiscoveryMs = Date.now() + REPOSITORY_CATALOG_REFRESH_MS;
      if (this.providerReady) this.clearFailure("repository discovery");
      else this.reportFailure("repository discovery", {
        error: "no matching repository candidates"
      }, Date.now());
      return this.providerReady;
    }

    const previous = new Map(this.repositories.map((repo) => [repo.fullName, repo]));
    const names = response.json
      .map((repo) => repo.full_name)
      .filter((name) => name && this.repositoryAllowed(name))
      .slice(0, this.config.maxRepositories);
    const retained = new Set(names);
    for (const name of previous.keys()) {
      if (!retained.has(name)) this.dropRepositoryTracking(name);
    }
    this.fastSweepQueue = this.fastSweepQueue.filter(name => retained.has(name));
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

  dropRepositoryTracking(fullName) {
    this.tracker.dropRepository(fullName);
    const prefix = fullName + "#";
    for (const map of [this.activeDetailNextMs, this.activeDetailErrors,
      this.liveJobScans, this.runReconciliations]) {
      for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
    }
    this.backfill = this.backfill.filter(run => run.repository !== fullName);
    for (const key of this.queuedBackfill) {
      if (key.startsWith(prefix)) this.queuedBackfill.delete(key);
    }
    for (const key of this.checkSnapshots.keys()) {
      if (key.startsWith(fullName + "@")) this.checkSnapshots.delete(key);
    }
  }

  async probeActivityCandidate(candidate) {
    const generation = this.providerGeneration;
    const now = Date.now();
    const result = await this.client.get(
      "/repos/" + candidate.fullName + "/actions/runs?per_page=10"
    );
    if (generation !== this.providerGeneration) return false;
    this.updateRate(result, now);
    candidate.lastProbeMs = now;
    if (!result.ok || !Array.isArray(result.json?.workflow_runs)) {
      candidate.errors++;
      candidate.nextProbeMs = now + this.policy.nextInterval(
        false, false, 0, candidate.errors
      );
      this.reportFailure("activity:" + candidate.fullName, result, Date.now());
      // A transient failure cannot de-admit an existing monitored repo.
      return false;
    }
    candidate.errors = 0;
    this.clearFailure("activity:" + candidate.fullName);
    candidate.nextProbeMs = now + ACTIVITY_RECHECK_MS;
    const summary = workflowActivitySummary(
      result.json.workflow_runs, this.config.activeAgeDays, now
    );
    const existing = this.repositories.find(repo => repo.fullName === candidate.fullName);
    if (summary.admitted) {
      if (!existing) {
        this.repositories.push({
          fullName: candidate.fullName, etag: "", errors: 0,
          nextPollMs: 0, lastPollMs: 0, pollCount: 0,
          successfulPollCount: 0, lastSuccessAtMs: 0,
          lastResponseStatus: 0, lastActivityMs: summary.newestActivityMs,
          latestUpdatedEpoch: 0, hadActive: summary.live, hadQueued: false
        });
        if (!this.fastSweepQueue.includes(candidate.fullName)) {
          this.fastSweepQueue.push(candidate.fullName);
          this.fastSweepReason = "admitted activity";
        }
      }
    } else if (existing && !existing.hadActive && !existing.hadQueued) {
      // No new workflow activity within the age window: remove from the
      // monitored set. The independent historical journal is unchanged.
      this.repositories = this.repositories.filter(
        repo => repo.fullName !== candidate.fullName
      );
      this.dropRepositoryTracking(candidate.fullName);
      this.fastSweepQueue = this.fastSweepQueue.filter(
        name => name !== candidate.fullName
      );
    }
    return true;
  }

  nextActivityCandidate(nowMs) {
    if (this.config.repositorySelectionMode !== "activity") return null;
    while (this.activityProbeQueue.length) {
      const name = this.activityProbeQueue.shift();
      const candidate = this.activityCandidates.get(name);
      if (!candidate) continue;
      if (candidate.nextProbeMs > nowMs) continue;
      return candidate;
    }
    for (const candidate of this.activityCandidates.values()) {
      if (this.repositories.some(repo => repo.fullName === candidate.fullName)) continue;
      if (candidate.nextProbeMs <= nowMs) return candidate;
    }
    return null;
  }

  queueConfigUpdate(operation) {
    const pending = this.configUpdates.then(operation);
    this.configUpdates = pending.catch(() => {});
    return pending;
  }

  applyConfig(input) {
    this.pendingProviderUpdates++;
    return this.queueConfigUpdate(async () => {
      const oldToken = this.config.githubToken;
      const next = await this.configStore.update(input);
      // In-flight requests may finish after saving a different token/filter.
      // Publish the new generation only after storage succeeds, then reject
      // every response and scheduler continuation from the previous one.
      this.providerGeneration++;
      this.config = next;
      this.history.setMaxPerKey(this.config.historyDepth);
      this.repositories = [];
      this.tracker = new RunTracker();
      this.activityCandidates = new Map();
      this.activityProbeQueue = [];
      this.normalRequestsSinceActivityProbe = 0;
      this.backfill = [];
      this.queuedBackfill.clear();
      this.activeDetailNextMs.clear();
      this.activeDetailErrors.clear();
      this.liveJobScans.clear();
      this.runReconciliations.clear();
      this.checkSnapshots.clear();
      this.normalRequestsSinceCheck = 0;
      this.fastSweepQueue = [];
      this.fastSweepReason = "";
      this.activeDetailStreak = 0;
      this.liveRepoStreak = 0;
      this.providerReady = false;
      this.lastSuccessfulSummaryAtMs = 0;
      this.lastError = "";
      this.lastErrorScope = "";
      this.lastErrorAtMs = 0;
      this.recentRequestErrors = 0;
      this.nextDiscoveryMs = 0;
      if (oldToken !== this.config.githubToken) {
        this.rateRemaining = -1;
        this.rateLimitedUntilMs = 0;
        this.lastRateLimitReason = "";
      }
      if (Date.now() >= this.rateLimitedUntilMs) await this.discoverRepositories();
      this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
      return this.configStore.publicConfig();
    }).finally(() => { this.pendingProviderUpdates--; });
  }

  applyDisplayConfig(input) {
    // Preserve omitted fields at the serialized store boundary. Filling them
    // from an older monitor snapshot loses a concurrent selection/resize.
    const patch = {};
    for (const field of ["surfaces", "activeSurfaceId"]) {
      if (Object.hasOwn(input, field)) patch[field] = input[field];
    }
    return this.queueConfigUpdate(async () => {
      this.config = await this.configStore.update(patch);
      return this.configStore.publicConfig();
    });
  }

  // An operator may prioritize existing stale parents, but must not bypass
  // the ordinary single-request scheduler, rate-limit pause or error backoff.
  requestStaleReconciliation(nowMs = Date.now()) {
    const stale = this.tracker.all().filter(tracked => {
      const confirmedAt = Number(tracked.providerConfirmedAtMs || 0);
      return isLive(tracked.snapshot) && confirmedAt > 0 &&
        nowMs - confirmedAt > PARENT_STALE_MS;
    }).sort((a, b) => a.providerConfirmedAtMs - b.providerConfirmedAtMs);
    let queued = 0;
    let alreadyPending = 0;
    for (const tracked of stale) {
      const key = detailKey(tracked.snapshot);
      const pending = this.runReconciliations.get(key);
      if (pending) {
        alreadyPending++;
        // Do not reset failed confirmations or defeat exponential backoff.
        this.activeDetailNextMs.set(key, Math.min(
          this.activeDetailNextMs.get(key) ?? Infinity, Number(pending.nextPollMs || 0)
        ));
      } else if (queued < STALE_CLEAR_BATCH_LIMIT) {
        this.runReconciliations.set(key, {
          nextPollMs: 0, errors: 0, lastConfirmedAtMs: tracked.providerConfirmedAtMs
        });
        this.activeDetailNextMs.set(key, -1);
        queued++;
      }
    }
    return {
      ok: true, queued, alreadyPending,
      deferred: stale.length - queued - alreadyPending,
      totalStale: stale.length, rateLimited: nowMs < this.rateLimitedUntilMs
    };
  }

  async refresh() {
    if (!this.providerReady) {
      // The scheduler owns API requests and rate-limit pauses. Repeated UI
      // rescans must not launch concurrent/bypassing discovery requests.
      this.nextDiscoveryMs = 0;
      return true;
    }
    for (const repo of this.repositories) repo.nextPollMs = 0;
    this.liveJobScans.clear();
    for (const key of this.activeDetailNextMs.keys()) this.activeDetailNextMs.set(key, 0);
    this.activeDetailStreak = 0;
    this.liveRepoStreak = 0;
    if (this.config.repositorySelectionMode === "activity") {
      this.activityProbeQueue = [...this.activityCandidates.keys()].filter(
        name => !this.repositories.some(repo => repo.fullName === name)
      );
      for (const name of this.activityProbeQueue) {
        this.activityCandidates.get(name).nextProbeMs = 0;
      }
    }
    this.startFastSweep("manual");
    return true;
  }

  queueBackfill(run) {
    const key = backfillKey(run);
    if (this.queuedBackfill.has(key)) return;
    this.queuedBackfill.add(key);
    this.backfill.push({ ...run, jobs: [] });
  }

  enqueueCheckTarget(run) {
    const target = checkTarget(run);
    if (!target) return;
    // Limit enrichment to currently relevant pull-request activity, not
    // thousands of historical runs. Check-runs are lower priority than live
    // workflow summaries and active job detail.
    const key = target.repository + "@" + target.sha;
    const cached = this.checkSnapshots.get(key);
    if (cached) {
      if (isLive(run) && !cached.active) cached.nextPollMs = 0;
      cached.active ||= run.state !== RunState.Completed;
      cached.lastSeenMs = Date.now();
      return;
    }
    if (this.checkSnapshots.size >= MAX_CHECK_TARGETS) {
      const oldest = [...this.checkSnapshots.entries()].sort(
        (a, b) => a[1].lastSeenMs - b[1].lastSeenMs
      )[0];
      if (oldest) this.checkSnapshots.delete(oldest[0]);
    }
    this.checkSnapshots.set(key, {
      ...target, key, page: 1, runs: new Map(), totalCount: null,
      nextPollMs: 0, fetchedAtMs: 0, active: run.state !== RunState.Completed,
      lastSeenMs: Date.now(), failures: 0, error: ""
    });
  }

  dueCheckTarget(nowMs) {
    // A SHA may serve multiple workflows. Derive its live/visible lifetime
    // from current tracking, rather than letting one old active observation
    // poll it every 90 seconds forever after the workflows have finished.
    const visible = new Set();
    const live = new Set();
    for (const tracked of this.tracker.visible(nowMs)) {
      const run = tracked.snapshot;
      const target = checkTarget(run);
      if (!target) continue;
      const key = target.repository + "@" + target.sha;
      visible.add(key);
      if (isLive(run)) live.add(key);
    }
    for (const target of this.checkSnapshots.values()) {
      const wasActive = target.active;
      target.active = live.has(target.key);
      // Fetch the final conclusion promptly, then use the finished cadence.
      if (wasActive && !target.active) target.nextPollMs = Math.min(target.nextPollMs, nowMs);
    }
    const due = [...this.checkSnapshots.values()].filter(
      item => visible.has(item.key) && item.nextPollMs <= nowMs
    );
    // Continue pagination with priority to avoid permanently incomplete
    // 150+ shard PR checks, but do not take slots away from live jobs.
    due.sort((a, b) => (a.page > 1 ? 0 : 1) - (b.page > 1 ? 0 : 1) ||
      a.nextPollMs - b.nextPollMs);
    return due[0] || null;
  }

  async pollCheckTarget(target) {
    const generation = this.providerGeneration;
    const page = target.page;
    const url = "/repos/" + target.repository + "/commits/" + target.sha +
      "/check-runs?per_page=" + CHECK_PAGE_SIZE +
      "&filter=latest&page=" + page;
    const response = await this.client.get(url);
    if (generation !== this.providerGeneration) return false;
    const now = Date.now();
    this.updateRate(response, now);
    if (!response.ok || !Array.isArray(response.json?.check_runs)) {
      target.failures++;
      target.error = "GitHub checks HTTP " + response.status;
      // Fine-grained PATs can lack Checks:read. Mark unavailable and back off,
      // rather than spoiling normal monitor health or fabricating zero passes.
      const interval = response.status === 403 || response.status === 404
        ? CHECK_PERMISSION_RETRY_MS :
          this.policy.nextInterval(false, false, 0, target.failures);
      target.nextPollMs = now + interval;
      target.page = 1;
      // Preserve the last known counts if this is a transient error, but
      // mark them incomplete instead of replacing them with misleading zeroes.
      return false;
    }

    const raw = response.json.check_runs;
    const reported = Number(response.json.total_count);
    if (page === 1) {
      target.runs.clear();
      target.totalCount = Number.isSafeInteger(reported) && reported >= 0
        ? reported : null;
    } else if (Number.isSafeInteger(reported) && reported >= 0) {
      target.totalCount = Math.max(target.totalCount || 0, reported);
    }
    for (const check of raw) {
      if (Number.isSafeInteger(check?.id) && check.id > 0) {
        target.runs.set(check.id, {
          id: check.id, status: check.status,
          conclusion: check.conclusion
        });
      }
    }
    target.fetchedAtMs = now;
    target.failures = 0;
    target.error = "";
    const more = target.totalCount === null
      ? raw.length === CHECK_PAGE_SIZE
      : target.runs.size < target.totalCount;
    if (more && raw.length === CHECK_PAGE_SIZE && page < MAX_CHECK_PAGES) {
      target.page++;
      target.nextPollMs = now;
    } else {
      target.page = 1;
      target.nextPollMs = now + (target.active
        ? CHECK_ACTIVE_REFRESH_MS : CHECK_FINISHED_REFRESH_MS);
    }
    return true;
  }

  checksForRun(run) {
    const target = checkTarget(run);
    if (!target) return null;
    const entry = this.checkSnapshots.get(target.repository + "@" + target.sha);
    if (!entry) return null;
    if (!entry.fetchedAtMs) return {
      passed: 0, failed: 0, pending: 0, skipped: 0,
      total: 0, seen: 0, complete: false, error: entry.error,
      fetchedAtMs: 0
    };
    const metrics = summarizeCheckRuns(
      entry.runs.values(), entry.totalCount,
      entry.page === 1 && !entry.error
    );
    return { ...metrics, error: entry.error, fetchedAtMs: entry.fetchedAtMs };
  }

  async pollRepository(repo, nowMs) {
    const generation = this.providerGeneration;
    const previousConfirmationMs = repo.lastSuccessAtMs;
    repo.lastPollMs = nowMs;
    repo.pollCount += 1;

    const response = await this.client.get(
      "/repos/" + repo.fullName + "/actions/runs?per_page=100",
      repo.etag
    );
    if (generation !== this.providerGeneration) return false;
    const receivedMs = Date.now();
    this.updateRate(response, receivedMs);
    repo.lastResponseStatus = response.status;
    const scope = "repo:" + repo.fullName;

    if (response.notModified) {
      // 304 confirms the last returned summary page is unchanged. It does
      // not confirm status for older runs absent from that page.
      for (const runId of repo.lastSummaryRunIds || []) {
        const tracked = this.tracker.find(repo.fullName, runId);
        if (tracked) tracked.providerConfirmedAtMs = receivedMs;
      }
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
    const seen = new Set();
    const lastSummaryRunIds = new Set();

    for (const raw of response.json.workflow_runs || []) {
      const run = parseRun(raw, repo.fullName);
      if (!Number.isSafeInteger(run.runId) || run.runId <= 0 || run.state === RunState.Unknown) continue;
      const existing = this.tracker.find(run.repository, run.runId);
      if (existing && attemptNumber(run) < attemptNumber(existing.snapshot)) continue;
      if (existing?.snapshot.state === RunState.Completed && isLive(run) &&
          attemptNumber(run) === attemptNumber(existing.snapshot)) continue;
      const key = detailKey(run);
      seen.add(key);
      run.providerConfirmedAtMs = receivedMs;
      this.runReconciliations.delete(key);
      this.clearFailure("run:" + key);
      lastSummaryRunIds.add(run.runId);
      newestUpdated = Math.max(newestUpdated, run.updatedAtEpoch);
      if (run.event === "pull_request" &&
          (run.state === RunState.InProgress || run.state === RunState.Queued)) {
        this.enqueueCheckTarget(run);
      }

      if (existing && Number(existing.snapshot.runAttempt || 1) !==
          Number(run.runAttempt || 1)) {
        this.liveJobScans.delete(key);
        this.activeDetailErrors.delete(key);
        this.activeDetailNextMs.set(key, 0);
      }
      if (shouldTrackSummaryRun(run, Boolean(existing), nowMs, TERMINAL_IMPORT_LOOKBACK_MS)) {
        const tracked = this.tracker.upsert(run, nowMs);
        tracked.providerConfirmedAtMs = receivedMs;
      }

      if (run.state === RunState.InProgress || run.state === RunState.Queued) {
        // Queued is a provider status, not proof that no matrix job runs.
        // Retained fresh job evidence upgrades repository polling priority.
        const tracked = this.tracker.find(run.repository, run.runId)?.snapshot;
        if (run.state === RunState.InProgress ||
            (tracked && observedRunningJobs(tracked, receivedMs).length)) hasActive = true;
        if (run.state === RunState.Queued) hasQueued = true;
        if (!this.activeDetailNextMs.has(detailKey(run))) {
          this.activeDetailNextMs.set(detailKey(run), 0);
        }
      } else if (run.state === RunState.Completed) {
        if (backfillQueued < this.config.backfillRunsPerRepo &&
            !this.history.hasRun(run.repository, run.runId, run.runAttempt)) {
          this.queueBackfill(run);
          backfillQueued += 1;
        }
        this.activeDetailNextMs.delete(detailKey(run));
        this.activeDetailErrors.delete(detailKey(run));
        this.liveJobScans.delete(detailKey(run));
      }
    }

    // The latest 100 runs can omit older executing/queued runs, especially
    // while automation repeatedly pushes. Missing is not cancelled/finished.
    // Retain live evidence and confirm each omitted run in a normal detail
    // slot; never infer the parent conclusion from completed child jobs.
    for (const tracked of this.tracker.all()) {
      const run = tracked.snapshot;
      if (run.repository !== repo.fullName || !isLive(run)) continue;
      const key = detailKey(run);
      if (!seen.has(key) && !this.runReconciliations.has(key)) {
        this.runReconciliations.set(key, {
          nextPollMs: 0, errors: 0,
          lastConfirmedAtMs: Math.max(run.providerConfirmedAtMs || 0,
            previousConfirmationMs || 0, tracked.firstSeenMs || 0)
        });
        this.activeDetailNextMs.set(key, 0);
      }
      if (run.state === RunState.InProgress || observedRunningJobs(run, receivedMs).length) hasActive = true;
      if (run.state === RunState.Queued) hasQueued = true;
    }

    repo.lastSummaryRunIds = lastSummaryRunIds;
    if (repo.latestUpdatedEpoch !== newestUpdated) {
      repo.latestUpdatedEpoch = newestUpdated;
      repo.lastActivityMs = activityTimeFromGitHub(newestUpdated, Date.now());
    }
    repo.hadActive = hasActive;
    repo.hadQueued = hasQueued;
    const age = repo.lastActivityMs ? nowMs - repo.lastActivityMs : this.policy.warmWindowMs * 10;
    repo.nextPollMs = nowMs + this.policy.nextInterval(hasActive, hasQueued, age, 0);
    if (this.config.repositorySelectionMode === "activity" &&
        !shouldKeepRepository(repo, this.config.activeAgeDays, Date.now())) {
      this.repositories = this.repositories.filter(item => item !== repo);
      this.dropRepositoryTracking(repo.fullName);
      const candidate = this.activityCandidates.get(repo.fullName);
      if (candidate) candidate.nextProbeMs = Date.now() + ACTIVITY_RECHECK_MS;
    }
    return true;
  }

  async pollFastSweep(nowMs) {
    const generation = this.providerGeneration;
    const batch = takeSweepBatch(this.fastSweepQueue, this.repositories, FAST_SWEEP_BATCH_SIZE);
    if (!batch.length) {
      this.fastSweepReason = "";
      return false;
    }

    this.lastSchedulerAction = "sweep:" + this.fastSweepReason;
    const results = await Promise.allSettled(batch.map((repo) => this.pollRepository(repo, nowMs)));
    if (generation !== this.providerGeneration) return false;
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) this.reportFailure("repository sweep", { error: "unexpected polling exception" });
    if (!this.fastSweepQueue.length) this.fastSweepReason = "";
    this.activeDetailStreak = 0;
    this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
    return true;
  }

  async reconcileRun(tracked) {
    const generation = this.providerGeneration;
    const previous = tracked.snapshot;
    const key = detailKey(previous);
    const pending = this.runReconciliations.get(key);
    if (!pending) return false;
    const response = await this.client.get(
      "/repos/" + previous.repository + "/actions/runs/" + previous.runId
    );
    if (generation !== this.providerGeneration) return false;
    const receivedMs = Date.now();
    this.updateRate(response, receivedMs);
    const run = response.ok && response.json && !Array.isArray(response.json)
      ? parseRun(response.json, previous.repository) : null;
    const current = this.tracker.find(previous.repository, previous.runId)?.snapshot;
    if (current?.state === RunState.Completed && run && isLive(run) &&
        attemptNumber(run) === attemptNumber(current)) {
      // A stale list/detail response cannot revive a completed attempt, even
      // in scheduler bookkeeping after the tracker rejects the transition.
      this.runReconciliations.delete(key);
      this.activeDetailNextMs.delete(key);
      this.activeDetailErrors.delete(key);
      this.liveJobScans.delete(key);
      return false;
    }
    if (!run || run.runId !== previous.runId || run.state === RunState.Unknown ||
        attemptNumber(run) < attemptNumber(current || previous)) {
      pending.errors++;
      pending.nextPollMs = receivedMs + this.policy.nextInterval(false, false, 0, pending.errors);
      this.reportFailure("run:" + key, response.ok
        ? { error: "invalid or superseded run status response" } : response, receivedMs);
      return false;
    }

    this.clearFailure("run:" + key);
    pending.errors = 0;
    pending.lastConfirmedAtMs = receivedMs;
    pending.nextPollMs = receivedMs + (run.state === RunState.InProgress
      ? this.policy.activeMs : this.policy.queuedMs);
    if (attemptNumber(run) !== attemptNumber(previous)) {
      this.liveJobScans.delete(key);
      this.activeDetailErrors.delete(key);
    }
    run.providerConfirmedAtMs = receivedMs;
    const refreshed = this.tracker.upsert(run, receivedMs);
    // buildDashboard uses the tracked entry, not only its snapshot, for age.
    refreshed.providerConfirmedAtMs = receivedMs;
    if (run.event === "pull_request") this.enqueueCheckTarget(run);
    if (run.state === RunState.Completed) {
      this.runReconciliations.delete(key);
      this.activeDetailNextMs.delete(key);
      this.activeDetailErrors.delete(key);
      this.liveJobScans.delete(key);
      this.clearFailure("jobs:" + key);
      if (!this.history.hasRun(run.repository, run.runId, run.runAttempt)) this.queueBackfill(run);
    }
    const repo = this.repositories.find(item => item.fullName === run.repository);
    if (repo) {
      const live = this.tracker.all().map(item => item.snapshot)
        .filter(item => item.repository === repo.fullName && isLive(item));
      repo.hadActive = live.some(item => item.state === RunState.InProgress ||
        observedRunningJobs(item, receivedMs).length > 0);
      repo.hadQueued = live.some(item => item.state === RunState.Queued);
      repo.lastActivityMs = Math.max(repo.lastActivityMs || 0,
        activityTimeFromGitHub(run.updatedAtEpoch, receivedMs));
    }
    return true;
  }

  async fetchRunDetails(run, nowMs, recordWhenComplete) {
    const generation = this.providerGeneration;
    const key = detailKey(run);
    const live = !recordWhenComplete &&
      (run.state === RunState.Queued || run.state === RunState.InProgress);
    const scan = live ? (this.liveJobScans.get(key) || {
      page: 1, startedAtMs: 0, expected: null, jobsById: new Map(),
      invalidJobs: 0
    }) : null;
    const page = scan?.page || 1;
    const response = await this.client.get(
      "/repos/" + run.repository + "/actions/runs/" + run.runId +
      "/attempts/" + attemptNumber(run) +
      "/jobs?per_page=" + JOB_PAGE_SIZE + "&page=" + page
    );
    if (generation !== this.providerGeneration) return false;
    const currentRun = this.tracker.find(run.repository, run.runId)?.snapshot;
    if (live && currentRun && (attemptNumber(currentRun) !== attemptNumber(run) ||
        currentRun.state === RunState.Completed)) return false;
    const receivedMs = Date.now();
    this.updateRate(response, receivedMs);
    const scope = "jobs:" + key;
    if (!response.ok || !Array.isArray(response.json?.jobs)) {
      // Never replace previously observed jobs with an empty/failed response.
      this.reportFailure(scope, response, receivedMs);
      return false;
    }
    this.clearFailure(scope);

    const rawJobs = response.json.jobs;
    const reportedTotal = Number(response.json.total_count);
    const hasTotal = response.json.total_count !== undefined &&
      Number.isSafeInteger(reportedTotal) && reportedTotal >= 0;
    let jobs;
    let coverageComplete;
    let fetchedAtMs;
    let expectedCount;

    if (live) {
      if (page === 1) {
        scan.startedAtMs = receivedMs;
        scan.jobsById = new Map();
        scan.invalidJobs = 0;
        scan.expected = hasTotal ? reportedTotal : null;
      } else if (hasTotal) {
        // Matrix jobs may be added during a multi-page read.
        scan.expected = Math.max(scan.expected || 0, reportedTotal);
      }
      rawJobs.forEach((raw, index) => {
        const job = parseJob(raw);
        if (!Number.isSafeInteger(job.id) || job.id <= 0) scan.invalidJobs++;
        const id = job.id > 0 ? job.id : "invalid:" + page + ":" + index;
        scan.jobsById.set(id, job);
      });
      jobs = [...scan.jobsById.values()];
      const allSeen = scan.expected === null
        ? rawJobs.length < JOB_PAGE_SIZE : jobs.length >= scan.expected;
      coverageComplete = allSeen && scan.invalidJobs === 0;
      const anotherPage = !allSeen && rawJobs.length === JOB_PAGE_SIZE &&
        page < MAX_JOB_DETAIL_PAGES;
      if (anotherPage) {
        scan.page++;
        this.liveJobScans.set(key, scan);
      } else {
        this.liveJobScans.delete(key);
      }
      // Age the full snapshot from its oldest page, not the newest page.
      fetchedAtMs = scan.startedAtMs;
      expectedCount = scan.expected;
    } else {
      // Historical backfill retains its existing one-page request budget.
      jobs = rawJobs.map(parseJob);
      coverageComplete = hasTotal && reportedTotal <= jobs.length;
      fetchedAtMs = receivedMs;
      expectedCount = hasTotal ? reportedTotal : null;
    }

    const detailed = {
      ...run,
      jobs,
      jobsFetchedAtMs: fetchedAtMs,
      jobsCoverageComplete: coverageComplete,
      jobsExpectedCount: expectedCount
    };
    const existing = this.tracker.find(detailed.repository, detailed.runId);
    const compatibleAttempt = !existing || attemptNumber(existing.snapshot) === attemptNumber(detailed);
    const regressesTerminal = existing?.snapshot.state === RunState.Completed && isLive(detailed);
    if (compatibleAttempt && !regressesTerminal && (!recordWhenComplete ||
        shouldTrackSummaryRun(detailed, Boolean(existing), nowMs, TERMINAL_IMPORT_LOOKBACK_MS))) {
      this.tracker.upsert(detailed, nowMs);
    }
    if (recordWhenComplete && detailed.state === RunState.Completed) {
      await this.history.recordRun(detailed);
    }
    return true;
  }

  async serviceLiveDetail(tracked, nowMs) {
    const generation = this.providerGeneration;
    const run = tracked.snapshot;
    const key = detailKey(run);
    const pending = this.runReconciliations.get(key);
    if (pending && pending.nextPollMs <= nowMs) {
      await this.reconcileRun(tracked);
      if (generation !== this.providerGeneration) return;
      const current = this.tracker.find(run.repository, run.runId)?.snapshot;
      if (current && isLive(current)) {
        // Confirming the parent does not also fetch jobs. Let the next normal
        // detail slot do that, preserving one request per scheduler tick.
        this.activeDetailNextMs.set(key, this.liveJobScans.has(key) ? -1 : 0);
      }
      this.activeDetailStreak++;
      this.lastSchedulerAction = "run-reconcile:" + key;
      this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
      return;
    }
    const ok = await this.fetchRunDetails(run, nowMs, false);
    if (generation !== this.providerGeneration) return;
    const current = this.tracker.find(run.repository, run.runId)?.snapshot;
    if (!current || !isLive(current) || attemptNumber(current) !== attemptNumber(run)) return;
    const errors = ok ? 0 : (this.activeDetailErrors.get(key) || 0) + 1;
    if (ok) this.activeDetailErrors.delete(key);
    else this.activeDetailErrors.set(key, errors);

    const hasActivity = observedRunningJobs(current, Date.now()).length > 0;
    const interval = !ok ? this.policy.nextInterval(false, false, 0, errors)
      : hasActivity || current.state === RunState.InProgress
        ? this.policy.activeMs : this.policy.queuedMs;
    // A partially scanned matrix can hide its active jobs on later pages.
    // Continue immediately (subject to the global API spacing/fairness rule).
    const nextSummary = this.runReconciliations.get(key)?.nextPollMs ?? Infinity;
    this.activeDetailNextMs.set(key, ok && this.liveJobScans.has(key) ? -1 :
      Math.min(Date.now() + interval, nextSummary));
    this.activeDetailStreak += 1;
    this.lastSchedulerAction = "live-detail:" + key;
    this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
  }

  async tick() {
    if (this.busy || this.pendingProviderUpdates) return;
    const generation = this.providerGeneration;
    const nowMs = Date.now();
    this.tracker.prune(nowMs);
    if (nowMs < this.nextRequestAllowedMs || nowMs < this.rateLimitedUntilMs) return;

    this.busy = true;
    try {
      if (!this.providerReady) {
        if (nowMs >= this.nextDiscoveryMs) {
          await this.discoverRepositories();
          if (generation !== this.providerGeneration) return;
          this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
        }
        return;
      }
      if (nowMs >= this.nextDiscoveryMs) {
        await this.discoverRepositories();
        if (generation !== this.providerGeneration) return;
        this.lastSchedulerAction = "repository-catalog";
        this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
        return;
      }
      if (this.fastSweepQueue.length) {
        await this.pollFastSweep(nowMs);
        return;
      }

      const activityCandidate = this.config.repositorySelectionMode === "activity" &&
        (this.repositories.length === 0 ||
          this.normalRequestsSinceActivityProbe >= 6)
        ? this.nextActivityCandidate(nowMs) : null;
      if (activityCandidate) {
        await this.probeActivityCandidate(activityCandidate);
        if (generation !== this.providerGeneration) return;
        this.normalRequestsSinceActivityProbe = 0;
        this.lastSchedulerAction = "activity-probe:" + activityCandidate.fullName;
        this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
        return;
      }
      const active = dueActiveRun(this.tracker.all(), this.activeDetailNextMs, nowMs, detailKey);
      const repo = duePriorityRepository(
        this.repositories, nowMs, this.liveRepoStreak, MAX_LIVE_REPO_BURST
      );

      if (this.normalRequestsSinceCheck >= CHECK_SERVICE_INTERVAL) {
        const target = this.dueCheckTarget(nowMs);
        if (target) {
          await this.pollCheckTarget(target);
          if (generation !== this.providerGeneration) return;
          this.normalRequestsSinceCheck = 0;
          this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
          this.lastSchedulerAction = "check-runs:" + target.repository;
          return;
        }
      }

      if (shouldServiceActive(active, repo, this.activeDetailStreak, ACTIVE_DETAIL_BURST_LIMIT)) {
        await this.serviceLiveDetail(active, nowMs);
        if (generation !== this.providerGeneration) return;
        this.normalRequestsSinceActivityProbe++;
        this.normalRequestsSinceCheck++;
        return;
      }

      if (repo) {
        await this.pollRepository(repo, nowMs);
        if (generation !== this.providerGeneration) return;
        this.normalRequestsSinceActivityProbe++;
        this.normalRequestsSinceCheck++;
        this.liveRepoStreak = (repo.hadActive || repo.hadQueued)
          ? this.liveRepoStreak + 1 : 0;
        this.activeDetailStreak = 0;
        this.lastSchedulerAction = "repository:" + repo.fullName;
        this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
        return;
      }

      if (active) {
        await this.serviceLiveDetail(active, nowMs);
        return;
      }

      const remainingCandidate = this.nextActivityCandidate(nowMs);
      if (remainingCandidate) {
        await this.probeActivityCandidate(remainingCandidate);
        if (generation !== this.providerGeneration) return;
        this.normalRequestsSinceActivityProbe = 0;
        this.lastSchedulerAction = "activity-probe:" + remainingCandidate.fullName;
        this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
        return;
      }

      const target = this.dueCheckTarget(nowMs);
      if (target) {
        await this.pollCheckTarget(target);
        if (generation !== this.providerGeneration) return;
        this.normalRequestsSinceCheck = 0;
        this.nextRequestAllowedMs = Date.now() + REQUEST_SPACING_MS;
        this.lastSchedulerAction = "check-runs:" + target.repository;
        return;
      }

      for (let remaining = this.backfill.length; remaining > 0; remaining--) {
        const run = this.backfill.shift();
        if (run.backfillRetryAtMs > nowMs) {
          this.backfill.push(run);
          continue;
        }
        this.queuedBackfill.delete(backfillKey(run));
        if (this.history.hasRun(run.repository, run.runId, run.runAttempt)) continue;
        let ok;
        try {
          ok = await this.fetchRunDetails(run, nowMs, true);
        } catch (error) {
          if (generation !== this.providerGeneration) return;
          this.reportFailure("backfill:" + detailKey(run), {
            error: error?.message || "history recording failed"
          });
          ok = false;
        }
        if (generation !== this.providerGeneration) return;
        if (ok) this.clearFailure("backfill:" + detailKey(run));
        if (!ok) {
          run.backfillErrors = (run.backfillErrors || 0) + 1;
          run.backfillRetryAtMs = Date.now() + this.policy.nextInterval(false, false, 0, run.backfillErrors);
          this.queuedBackfill.add(backfillKey(run));
          this.backfill.push(run);
        }
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
    const attemptedRepositoryCount = this.repositories.filter(
      (repo) => repo.pollCount > 0
    ).length;
    const failedInitialScanCount = this.repositories.filter(
      (repo) => repo.pollCount > 0 && repo.successfulPollCount === 0
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
    // A successful recent-runs page cannot refresh a run it no longer
    // contains. Keep omitted-run confirmation ages in the existing SYNC AGE.
    for (const pending of this.runReconciliations.values()) {
      if (pending.lastConfirmedAtMs > 0) liveAges.push(nowMs - pending.lastConfirmedAtMs);
    }
    const oldestRepoSummaryAgeMs = ages.length ? Math.max(...ages) : null;
    const oldestLiveSummaryAgeMs = liveAges.length ? Math.max(...liveAges) : null;
    const ongoingDetailFailures = this.activeDetailErrors.size +
      [...this.runReconciliations.values()].filter(pending => pending.errors > 0).length;
    const freshError = this.lastError && nowMs - this.lastErrorAtMs < ERROR_VISIBLE_MS;
    const rateLimited = nowMs < this.rateLimitedUntilMs;
    const syncStatus = rateLimited ? "rate_limited" :
      !this.providerReady ? "offline" :
      scannedRepositoryCount < this.repositories.length &&
        (this.fastSweepQueue.length || attemptedRepositoryCount < this.repositories.length)
        ? "scanning" :
      failedInitialScanCount > 0 ? "degraded" :
      oldestLiveSummaryAgeMs !== null && oldestLiveSummaryAgeMs > LIVE_FRESHNESS_WARNING_MS ? "stale" :
      (ongoingDetailFailures > 0 || freshError) ? "degraded" : "online";
    // LIVE telemetry is GitHub's actual parent workflow state. Job evidence
    // and confirmed runner occupancy are reported independently below.
    const trackedActiveCount = tracked.filter((run) =>
      run.snapshot.state === RunState.InProgress).length;
    const workers = activeWorkerSummary(tracked, nowMs);
    const trackedQueuedCount = tracked.filter((run) =>
      run.snapshot.state === RunState.Queued).length;
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
      candidateRepositoryCount: this.config.repositorySelectionMode === "activity"
        ? this.activityCandidates.size : this.repositories.length,
      pendingActivityProbeCount: this.activityProbeQueue.length,
      repositorySelectionMode: this.config.repositorySelectionMode,
      watchedRepositories: this.repositories.map(repo => repo.fullName),
      scannedRepositoryCount,
      attemptedRepositoryCount,
      failedInitialScanCount,
      oldestRepoSummaryAgeMs,
      oldestLiveSummaryAgeMs,
      lastSuccessfulSummaryAtMs: this.lastSuccessfulSummaryAtMs,
      syncStatus,
      recentRequestErrors: this.recentRequestErrors,
      ongoingDetailFailures,
      pendingRunReconciliations: this.runReconciliations.size,
      pendingSweepCount: this.fastSweepQueue.length,
      sweepReason: this.fastSweepReason,
      dueRepositoryCount,
      trackedRunCount: tracked.length,
      trackedActiveCount,
      ...workers,
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
      rows: rows.map(row => ({
        ...row, checks: this.checksForRun(row)
      }))
    };
  }

  detail(repository, runId) {
    const tracked = this.tracker.find(repository, runId);
    if (!tracked) return null;
    const nowEpoch = Math.floor(Date.now() / 1000);
    const run = tracked.snapshot;
    const effectiveState = observedRunState(run, Date.now());
    const analyzed = effectiveState === run.state ? run : { ...run, state: effectiveState };
    return {
      ...run,
      providerState: run.state,
      state: effectiveState,
      observedRunningJobs: observedRunningJobs(run, Date.now()).length,
      acknowledged: tracked.acknowledged,
      manualWatch: tracked.manualWatch,
      checks: this.checksForRun(run),
      analysis: this.analyzer.analyzeRun(analyzed, nowEpoch),
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
