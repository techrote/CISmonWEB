// Completion verification is an additional consumer of the monitor's existing
// low-priority request slots. This module never starts a timer or a GitHub
// request outside service(); a multi-page scan advances one request at a time.
import { createHash } from "node:crypto";
import { parseRun } from "./github.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_ASSOCIATIONS = 80;
const CACHE_LIMIT = 256;
const ACTIVE_REFRESH_MS = 20_000;
const PIN_REFRESH_MS = 10 * 60_000;
const PERMISSION_RETRY_MS = 15 * 60_000;
export const PR_SETTLE_MS = 30_000;
export const PR_MAX_SCAN_AGE_MS = 300_000;
const SHA = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FAILURE = new Set(["failure", "timed_out", "action_required", "startup_failure", "stale"]);
const NEUTRAL = new Set(["neutral", "skipped"]);
const LIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

const attemptKey = run => `${run.repository.toLowerCase()}#${run.runId}@${run.runAttempt || 1}`;
const count = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => Number.isSafeInteger(value) && value > 0;
const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const reasonFor = response => response.status === 403 || response.status === 404
  ? `Unavailable or missing read permission (GitHub HTTP ${response.status}); no completion inferred.`
  : `Provider confirmation unavailable (${response.error || `HTTP ${response.status}`}); retrying.`;

function outcomeOf(value) {
  if (value === "success") return "success";
  if (FAILURE.has(value) || value === "error") return "failure";
  if (value === "cancelled") return "cancelled";
  if (NEUTRAL.has(value)) return "neutral";
  return "indeterminate";
}

function combineOutcomes(values) {
  if (values.includes("indeterminate")) return "indeterminate";
  if (values.includes("failure")) return "failure";
  if (values.includes("cancelled")) return "cancelled";
  if (values.includes("neutral")) return "neutral";
  return values.length ? "success" : "indeterminate";
}

// All inventory pages and the before/after PR identity have already been
// validated when this function runs. A passing child never completes its
// parent suite/workflow; queued suites cover delayed check creation.
// GitHub can leave an installed integration's zero-child suite queued
// indefinitely (observed with Claude). Ignoring it would also ignore delayed
// check creation, so retain pending state and name the responsible suite.
export function summarizePrEvidence(scan) {
  const entries = [];
  const pendingSuites = [];
  let terminalTimeMs = 0;
  let pending = false;
  let malformed = false;
  let checksSeen = 0;
  for (const source of scan.sources) {
    const suites = new Map(source.suites.map(value => [value.id, value]));
    for (const suite of suites.values()) {
      if (suite.head_sha?.toLowerCase() !== source.sha) malformed = true;
      if (LIVE.has(suite.status)) {
        pending = true;
        pendingSuites.push(`${suite.app?.slug || suite.app?.name || "integration"} suite ${suite.id}` +
          (source.checks.some(check => check.check_suite?.id === suite.id) ? "" : " (no child checks created)"));
      }
      else if (suite.status !== "completed") malformed = true;
      else if (outcomeOf(suite.conclusion) === "indeterminate") malformed = true;
      entries.push([source.sha, "suite", suite.id, suite.status, suite.conclusion || ""]);
    }
    for (const check of source.checks) {
      checksSeen++;
      const suiteId = check.check_suite?.id;
      if (!suites.has(suiteId) || check.head_sha?.toLowerCase() !== source.sha) malformed = true;
      if (LIVE.has(check.status)) pending = true;
      else if (check.status !== "completed") malformed = true;
      else if (outcomeOf(check.conclusion) === "indeterminate") malformed = true;
      if (check.status === "completed") {
        terminalTimeMs = Math.max(terminalTimeMs, timestamp(check.completed_at));
      }
      entries.push([source.sha, "check", check.id, suiteId, check.name || "", check.status, check.conclusion || "", check.completed_at || ""]);
    }
    // A completed suite without any visible check is not adequate coverage.
    // It may be an empty integration or inaccessible children: stay unknown.
    for (const suite of suites.values()) {
      const children = source.checks.filter(check => check.check_suite?.id === suite.id).length;
      const emptyUnsuccessfulParent = children === 0 && suite.latest_check_runs_count === 0 &&
        suite.status === "completed" && ["failure", "cancelled", "neutral"].includes(outcomeOf(suite.conclusion)) &&
        source.workflows.some(run => run.check_suite_id === suite.id && run.status === "completed" &&
          ["failure", "cancelled", "neutral"].includes(outcomeOf(run.conclusion)));
      if (emptyUnsuccessfulParent) checksSeen++;
      if (suite.status === "completed" && !children && !emptyUnsuccessfulParent) malformed = true;
      if (suite.latest_check_runs_count !== undefined &&
          (!count(suite.latest_check_runs_count) || suite.latest_check_runs_count !== children)) malformed = true;
    }
    for (const status of source.statuses) {
      checksSeen++;
      if (status.state === "pending") pending = true;
      else if (!["success", "failure", "error"].includes(status.state)) malformed = true;
      entries.push([source.sha, "status", status.context, status.id, status.state, status.updated_at || ""]);
    }
    // GitHub returns pending for an empty combined-status inventory, so only
    // apply the aggregate state when at least one context exists.
    if (source.statuses.length && source.combinedState === "pending") pending = true;
    if (source.statuses.length && !["pending", "success", "failure"].includes(source.combinedState)) malformed = true;
    const latestRuns = new Map();
    for (const run of source.workflows) {
      if (run.head_sha?.toLowerCase() !== source.sha) { malformed = true; continue; }
      const old = latestRuns.get(run.id);
      if (!old || (run.run_attempt || 1) > (old.run_attempt || 1)) latestRuns.set(run.id, run);
    }
    for (const run of latestRuns.values()) {
      if (LIVE.has(run.status)) pending = true;
      else if (run.status !== "completed") malformed = true;
      else if (outcomeOf(run.conclusion) === "indeterminate") malformed = true;
      if (!suites.has(run.check_suite_id)) malformed = true;
      entries.push([source.sha, "workflow", run.id, run.run_attempt || 1, run.check_suite_id, run.status, run.conclusion || ""]);
    }
  }
  const outcomes = entries.filter(entry => entry[1] !== "status")
    .map(entry => outcomeOf(entry[1] === "suite" ? entry[4] : entry[1] === "check" ? entry[6] : entry[6]));
  outcomes.push(...entries.filter(entry => entry[1] === "status").map(entry => outcomeOf(entry[4])));
  const outcome = combineOutcomes(outcomes);
  const missingRequired = (scan.required || []).filter(required => !scan.sources.some(source =>
    source.checks.some(check => check.name === required.context &&
      (!required.appId || check.app?.id === required.appId)) ||
    (!required.appId && source.statuses.some(status => status.context === required.context))));
  // No objects is missing evidence, not an active baseline. Likewise an
  // unclassified terminal object must not turn into a fabricated live edge.
  const complete = !malformed && !scan.unsupportedRequirement && missingRequired.length === 0 &&
    (checksSeen > 0 || pending);
  const terminal = complete && !pending && checksSeen > 0 && outcome !== "indeterminate";
  return {
    complete, terminal, outcome: terminal ? outcome : "indeterminate",
    signature: fingerprint([scan.headSha, scan.mergeSha || "", scan.baseRef || "",
      scan.required || [], scan.rules || [], entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]),
    terminalTimeMs,
    terminalTimeSource: terminalTimeMs ? "completed_at" : "",
    reason: scan.unsupportedRequirement ? "A required workflow rule cannot be verified from this repository's check inventory; completion remains indeterminate."
      : missingRequired.length ? "Required check contexts have not been verified: " + missingRequired
        .map(required => required.context + (required.appId ? ` (app ${required.appId})` : "")).slice(0, 4).join(", ") + "."
      : malformed ? "Check, suite, status or workflow coverage is incomplete or inconsistent; awaiting verified evidence."
      : pendingSuites.length ? `${pendingSuites.length} pending suite(s): ${pendingSuites.slice(0, 3).join(", ")}.`
        : !checksSeen ? "No checks or status contexts have been created; waiting."
          : pending ? "Checks, status contexts or workflows remain pending."
          : outcome === "indeterminate" ? "A terminal outcome is unclassified; awaiting clear provider evidence."
            : "Complete current-head evidence; confirming a stable check set before delivery."
  };
}

export class CompletionProvider {
  constructor(monitor, interactions) {
    this.monitor = monitor;
    this.interactions = interactions;
    this.runTasks = new Map();
    this.prTasks = new Map();
    this.associations = new Map();
    this.cache = new Map();
    this.activePrId = null;
    this.prContinuationStreak = 0;
    this.retainedRevision = -1;
    this.retainedKeys = new Set();
  }

  reset() {
    this.runTasks.clear();
    this.prTasks.clear();
    this.associations.clear();
    this.cache.clear();
    this.activePrId = null;
    this.prContinuationStreak = 0;
    this.retainedRevision = -1;
    this.retainedKeys.clear();
  }

  retained(run) {
    if (!this.interactions) return false;
    const revision = this.interactions.revision ?? this.interactions.current?.revision;
    if (revision === undefined || revision !== this.retainedRevision) {
      const targets = this.interactions.targets();
      this.retainedKeys = new Set([...targets.pins, ...targets.subscriptions.filter(sub => sub.type === "run")].map(attemptKey));
      this.retainedRevision = revision;
    }
    return this.retainedKeys.has(attemptKey(run));
  }

  association(run) {
    const result = this.associations.get(attemptKey(run));
    if (result && result.sha === this.associationSha(run)) {
      if (result.result.status === "pending" || result.nextPollMs > Date.now()) return { ...result.result };
      return { status: "unknown", reason: "Cached PR association expired; open the context menu to verify it again." };
    }
    return { status: "unknown", reason: "PR association has not been verified. Open the context menu to request a bounded lookup." };
  }

  associationSha(run) {
    const candidates = run.prCandidates || [];
    const unique = new Set(candidates.map(candidate => candidate.headSha).filter(sha => SHA.test(sha || "")));
    return (run.event === "pull_request" && unique.size === 1 ? [...unique][0] : run.headSha || "").toLowerCase();
  }

  requestAssociation(run) {
    const key = attemptKey(run);
    const sha = this.associationSha(run);
    let task = this.associations.get(key);
    if (task && task.sha === sha && (task.nextPollMs > Date.now() || task.result.status === "pending")) return { ...task.result };
    if (!SHA.test(sha) || !REPOSITORY.test(run.repository)) {
      return { status: "unavailable", reason: "No valid commit identity is available to verify a PR association." };
    }
    if (!task && this.associations.size >= MAX_ASSOCIATIONS) {
      const oldest = [...this.associations.values()].sort((a, b) => a.requestedAtMs - b.requestedAtMs)[0];
      this.associations.delete(oldest.key);
    }
    task = {
      type: "association", key, repository: run.repository, sha,
      requestedAtMs: Date.now(), nextPollMs: 0, page: 1, pulls: new Map(),
      result: { status: "pending", reason: "Verifying PR association in the normal API request queue…" }
    };
    this.associations.set(key, task);
    return { ...task.result };
  }

  syncTargets(nowMs) {
    const targets = this.interactions?.targets() || { pins: [], subscriptions: [] };
    const runs = new Map();
    for (const pin of targets.pins) runs.set(attemptKey(pin), pin);
    for (const subscription of targets.subscriptions) {
      if (subscription.type === "run") runs.set(attemptKey(subscription), subscription);
    }
    for (const [key, identity] of runs) {
      let task = this.runTasks.get(key);
      if (!task) {
        task = { ...identity, type: "run", key, nextPollMs: 0, failures: 0 };
        this.runTasks.set(key, task);
      }
      const armed = targets.subscriptions.find(sub => sub.type === "run" && attemptKey(sub) === key);
      if (armed && task.subscriptionGeneration !== armed.generation) {
        task.nextPollMs = 0;
        task.jobs = null;
        task.subscriptionGeneration = armed.generation;
      }
      task.subscription = armed || null;
    }
    for (const key of this.runTasks.keys()) if (!runs.has(key)) this.runTasks.delete(key);
    const prIds = new Set();
    for (const subscription of targets.subscriptions.filter(sub => sub.type === "pr")) {
      prIds.add(subscription.id);
      const existing = this.prTasks.get(subscription.id);
      if (!existing || existing.generation !== subscription.generation) {
        this.prTasks.set(subscription.id, {
          ...subscription, type: "pr", nextPollMs: 0, scan: null, candidate: null, failures: 0,
          verifiedHeadSha: subscription.headSha || "",
          relevantMergeSha: subscription.relevantMergeSha || "", seenOpen: subscription.seenOpen === true
        });
      }
    }
    for (const id of this.prTasks.keys()) if (!prIds.has(id)) this.prTasks.delete(id);
    return [...this.runTasks.values(), ...this.prTasks.values(),
      ...[...this.associations.values()].filter(task => task.result.status === "pending")]
      .filter(task => task.nextPollMs <= nowMs)
      .sort((a, b) => a.nextPollMs - b.nextPollMs ||
        (a.type === "run" && a.subscription ? 0 : a.type === "association" ? 1 : a.type === "pr" ? 2 : 3) -
        (b.type === "run" && b.subscription ? 0 : b.type === "association" ? 1 : b.type === "pr" ? 2 : 3) ||
        String(a.key || a.id).localeCompare(String(b.key || b.id)));
  }

  due(nowMs) {
    const due = this.syncTargets(nowMs);
    const active = this.prTasks.get(this.activePrId);
    if (active?.scan) {
      // Starting every subscription's freshness clock at once creates an
      // endless expire/restart loop under load. One inventory owns the PR
      // continuation lane until complete, failed or expired. Other target
      // classes get at least one in four completion slots when due.
      const other = due.find(task => task.type !== "pr");
      if (other && this.prContinuationStreak >= 3) return other;
      if (active.nextPollMs <= nowMs) return active;
      return other || null;
    }
    this.activePrId = null;
    return due[0] || null;
  }

  async request(path) {
    const generation = this.monitor.providerGeneration;
    const cached = this.cache.get(path);
    const response = await this.monitor.client.get(path, cached?.etag || "");
    if (generation !== this.monitor.providerGeneration) return response;
    this.monitor.updateRate(response, Date.now());
    if (response.notModified) {
      if (!cached) return { ...response, ok: false, error: "Uncached conditional response" };
      return { ...response, ok: true, json: cached.json, link: response.link || cached.link || "" };
    }
    if (response.ok && response.json && response.etag) {
      this.cache.delete(path);
      this.cache.set(path, { etag: response.etag, json: response.json, link: response.link || "" });
      while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
    }
    return response;
  }

  async service(task) {
    if (task.type === "pr") {
      this.activePrId = task.id;
      this.prContinuationStreak++;
    } else this.prContinuationStreak = 0;
    if (task.type === "run") return this.serviceRun(task);
    if (task.type === "pr") return this.servicePr(task);
    return this.serviceAssociation(task);
  }

  async serviceAssociation(task) {
    const generation = this.monitor.providerGeneration;
    const response = await this.request(`/repos/${task.repository}/commits/${task.sha}/pulls?per_page=${PAGE_SIZE}&page=${task.page}`);
    if (generation !== this.monitor.providerGeneration || this.associations.get(task.key) !== task) return;
    if (!response.ok || !Array.isArray(response.json)) {
      task.result = { status: "unavailable", reason: reasonFor(response) };
      task.nextPollMs = Date.now() + PERMISSION_RETRY_MS;
      return;
    }
    let invalid = false;
    for (const pull of response.json) {
      if (!identifier(pull.number) || pull.base?.repo?.full_name?.toLowerCase() !== task.repository.toLowerCase()) { invalid = true; continue; }
      task.pulls.set(pull.number, pull);
    }
    if (invalid || (response.json.length === PAGE_SIZE && task.page >= MAX_PAGES)) {
      task.result = { status: "unavailable", reason: "PR association coverage is incomplete; no PR selected." };
    } else if (response.json.length === PAGE_SIZE) {
      task.page++;
      task.nextPollMs = Date.now();
      return;
    } else if (task.pulls.size === 1) {
      const pull = [...task.pulls.values()][0];
      task.result = {
        status: "resolved", number: pull.number, repository: task.repository,
        url: `https://github.com/${task.repository}/pull/${pull.number}`,
        headSha: SHA.test(pull.head?.sha || "") ? pull.head.sha.toLowerCase() : "",
        confirmedAtMs: Date.now(), reason: "Unique PR association verified by GitHub."
      };
    } else {
      task.result = { status: task.pulls.size ? "ambiguous" : "unavailable",
        reason: task.pulls.size ? `${task.pulls.size} related PRs; a unique association cannot be established.`
          : "GitHub reports no accessible related PR for this commit." };
    }
    task.nextPollMs = Date.now() + PIN_REFRESH_MS;
  }

  async serviceRun(task) {
    const generation = this.monitor.providerGeneration;
    const started = Date.now();
    const subscriptionGeneration = task.subscriptionGeneration;
    const base = `/repos/${task.repository}/actions/runs/${task.runId}/attempts/${task.runAttempt || 1}`;
    const path = task.jobs ? `${base}/jobs?per_page=${PAGE_SIZE}&page=${task.jobs.page}` : base;
    const response = await this.request(path);
    if (generation !== this.monitor.providerGeneration || this.runTasks.get(task.key) !== task) return;
    const now = Date.now();
    if (!response.ok || !response.json) {
      task.failures++;
      task.nextPollMs = now + ([403, 404].includes(response.status) ? PERMISSION_RETRY_MS
        : this.monitor.policy.nextInterval(false, false, 0, task.failures));
      task.jobs = null;
      const reason = reasonFor(response);
      for (const pin of this.interactions.targets().pins.filter(pin => attemptKey(pin) === task.key)) {
        await this.interactions.updatePin(pin.id, { status: "unavailable", reason, confirmedAtMs: 0 });
      }
      if (task.subscription) await this.interactions.updateSubscription(task.subscription.id,
        { phase: "indeterminate", reason }, { generation: task.subscriptionGeneration });
      return;
    }
    task.failures = 0;
    if (task.jobs) {
      const scan = task.jobs;
      const rows = response.json.jobs;
      const total = response.json.total_count;
      let valid = Array.isArray(rows) && count(total) && (scan.total === null || scan.total === total);
      if (valid) {
        scan.total = total;
        for (const job of rows) {
          if (!identifier(job.id) || job.run_id !== task.runId ||
              job.run_attempt !== undefined && job.run_attempt !== (task.runAttempt || 1) ||
              scan.seen.has(job.id) || job.status !== "completed") { valid = false; break; }
          scan.seen.add(job.id);
          if (job.status === "completed") scan.completedAtMs = Math.max(scan.completedAtMs, timestamp(job.completed_at));
        }
      }
      if (valid && scan.seen.size < total && rows.length === PAGE_SIZE && scan.page < MAX_PAGES) {
        scan.page++;
        task.nextPollMs = now;
        return;
      }
      const complete = valid && scan.seen.size === total;
      if (!complete || /<[^>]+>;\s*rel="next"/.test(response.link || "")) {
        if (task.subscription) await this.interactions.updateSubscription(task.subscription.id, {
          phase: "indeterminate", reason: "Exact-attempt completion timestamps have incomplete or inconsistent job coverage; retrying safely."
        }, { generation: scan.subscriptionGeneration });
        task.jobs = null;
        task.nextPollMs = now + ACTIVE_REFRESH_MS;
        return;
      }
      await this.interactions.observeRun(scan.run, {
        generation: scan.subscriptionGeneration,
        requestStartedAtMs: scan.startedAtMs, confirmedAtMs: now, coverageComplete: true,
        terminalTimeMs: complete ? scan.completedAtMs : 0,
        terminalTimeSource: complete && scan.completedAtMs ? "completed_at" : ""
      });
      task.jobs = null;
      task.nextPollMs = now + PIN_REFRESH_MS;
      return;
    }
    const run = parseRun(response.json, task.repository);
    if (run.runId !== task.runId || run.runAttempt !== (task.runAttempt || 1) || run.state === "unknown") {
      task.nextPollMs = now + ACTIVE_REFRESH_MS;
      if (task.subscription) await this.interactions.updateSubscription(task.subscription.id,
        { phase: "indeterminate", reason: "Exact run attempt was not verified; stale or inconsistent provider response." },
        { generation: task.subscriptionGeneration });
      return;
    }
    run.providerConfirmedAtMs = now;
    // An older pinned attempt must not roll back the latest tracker entry.
    const current = this.monitor.tracker.find(run.repository, run.runId);
    if (!current || (current.snapshot.runAttempt || 1) <= run.runAttempt) {
      const tracked = this.monitor.tracker.upsert(run, now);
      tracked.providerConfirmedAtMs = now;
    }
    if (run.state === "completed" && task.subscription) {
      for (const pin of this.interactions.targets().pins.filter(pin => attemptKey(pin) === task.key)) {
        await this.interactions.updatePin(pin.id, { snapshot: run, status: "available", reason: "", confirmedAtMs: now });
      }
      // A very fast completion may precede our first post-arm live poll.
      // Real exact-attempt completed_at evidence avoids both retrospective
      // alerts and losing a completion that genuinely happened after arming.
      task.jobs = { run, startedAtMs: started, subscriptionGeneration, page: 1, total: null, seen: new Set(), completedAtMs: 0 };
      task.nextPollMs = now;
      return;
    }
    await this.interactions.observeRun(run, { generation: subscriptionGeneration, requestStartedAtMs: started, confirmedAtMs: now, coverageComplete: true });
    task.nextPollMs = now + (run.state === "completed" ? PIN_REFRESH_MS : ACTIVE_REFRESH_MS);
  }

  newScan() {
    return { stage: "head", startedAtMs: Date.now(), headSha: "", mergeSha: "", baseRef: "",
      required: [], rules: [], unsupportedRequirement: false,
      sources: [], sourceIndex: 0, page: 1, total: null, seen: new Set() };
  }

  prPath(task, scan) {
    const base = `/repos/${task.repository}`;
    if (scan.stage === "head" || scan.stage === "confirm") return `${base}/pulls/${task.prNumber}`;
    if (scan.stage === "branch") return `${base}/branches/${encodeURIComponent(scan.baseRef)}`;
    if (scan.stage === "rules") return `${base}/rules/branches/${encodeURIComponent(scan.baseRef)}?per_page=${PAGE_SIZE}&page=${scan.page}`;
    const source = scan.sources[scan.sourceIndex];
    if (scan.stage === "workflows") return `${base}/actions/runs?head_sha=${source.sha}&per_page=${PAGE_SIZE}&page=${scan.page}`;
    const endpoint = { suites: "check-suites", checks: "check-runs", statuses: "status" }[scan.stage];
    return `${base}/commits/${source.sha}/${endpoint}?per_page=${PAGE_SIZE}${scan.stage === "checks" ? "&filter=latest" : ""}&page=${scan.page}`;
  }

  async prUnknown(task, reason, now, response = null) {
    task.failures++;
    const permission = response && [403, 404].includes(response.status);
    task.nextPollMs = now + (permission ? PERMISSION_RETRY_MS
      : Math.max(ACTIVE_REFRESH_MS, this.monitor.policy.nextInterval(false, false, 0, task.failures)));
    task.candidate = null;
    await this.interactions.observePr(task.id, {
      headSha: task.scan?.headSha || "", complete: false, terminal: false,
      requestStartedAtMs: task.scan?.startedAtMs || now, confirmedAtMs: now,
      outcome: "indeterminate", reason,
      mergeSha: task.relevantMergeSha || "", prState: task.scan?.prState,
      seenOpen: task.seenOpen
    }, { generation: task.generation });
    task.scan = null;
  }

  async servicePr(task) {
    const generation = this.monitor.providerGeneration;
    task.scan ||= this.newScan();
    const scan = task.scan;
    if (Date.now() - scan.startedAtMs > PR_MAX_SCAN_AGE_MS) {
      await this.prUnknown(task, "The bounded check scan aged out before complete coverage; starting fresh.", Date.now());
      return;
    }
    const response = await this.request(this.prPath(task, scan));
    if (generation !== this.monitor.providerGeneration || this.prTasks.get(task.id) !== task) return;
    const now = Date.now();
    if (!response.ok || !response.json) {
      await this.prUnknown(task, `${scan.stage} verification: ${reasonFor(response)}`, now, response);
      return;
    }
    if (scan.stage === "branch") {
      const branch = response.json;
      if (branch.name !== scan.baseRef || typeof branch.protected !== "boolean") {
        await this.prUnknown(task, "Base branch protection metadata is incomplete; required checks are unknown.", now);
        return;
      }
      const checks = branch.protection?.required_status_checks;
      if (branch.protected && (!checks || !Array.isArray(checks.contexts))) {
        await this.prUnknown(task, "Protected branch required-check coverage is unavailable.", now);
        return;
      }
      if (checks && (!Array.isArray(checks.contexts) || checks.checks !== undefined && !Array.isArray(checks.checks))) {
        await this.prUnknown(task, "Required-check branch metadata is malformed; completion remains unknown.", now);
        return;
      }
      let valid = true;
      for (const context of checks?.contexts || []) valid = this.addRequired(scan, context) && valid;
      for (const check of checks?.checks || []) valid = this.addRequired(scan, check.context, check.app_id) && valid;
      if (!valid) {
        await this.prUnknown(task, "Required-check branch metadata is malformed; completion remains unknown.", now);
        return;
      }
      scan.stage = "rules";
      task.nextPollMs = now;
      return;
    }
    if (scan.stage === "rules") {
      if (!Array.isArray(response.json) || response.json.some(rule => !rule || typeof rule.type !== "string")) {
        await this.prUnknown(task, "Active branch rules could not be completely read.", now);
        return;
      }
      let valid = true;
      for (const rule of response.json) {
        // Merge permissions/reviews are not check completion. Required
        // workflows are CI-specific but may refer to a different repository;
        // lacking a verifiable mapping is explicit unknown, never success.
        if (rule.type === "required_status_checks") {
          const checks = rule.parameters?.required_status_checks;
          if (!Array.isArray(checks)) valid = false;
          else for (const check of checks) valid = this.addRequired(scan, check.context, check.integration_id) && valid;
          scan.rules.push({ type: rule.type, rulesetId: rule.ruleset_id || 0,
            required: checks, strict: rule.parameters?.strict_required_status_checks_policy === true });
        } else if (rule.type === "workflows") {
          scan.unsupportedRequirement = true;
          scan.rules.push({ type: rule.type, rulesetId: rule.ruleset_id || 0 });
        }
      }
      if (!valid || (response.json.length === PAGE_SIZE && scan.page >= MAX_PAGES)) {
        await this.prUnknown(task, "Required branch rule coverage is incomplete or malformed.", now);
        return;
      }
      if (response.json.length === PAGE_SIZE) { scan.page++; task.nextPollMs = now; return; }
      if (/<[^>]+>;\s*rel="next"/.test(response.link || "")) {
        await this.prUnknown(task, "Branch rule pagination is incomplete.", now);
        return;
      }
      scan.required.sort((a, b) => a.context.localeCompare(b.context) || a.appId - b.appId);
      scan.rules.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      scan.page = 1;
      scan.stage = "suites";
      task.nextPollMs = now;
      return;
    }
    if (scan.stage === "head" || scan.stage === "confirm") {
      const pull = response.json;
      if (pull.number !== task.prNumber || pull.base?.repo?.full_name?.toLowerCase() !== task.repository.toLowerCase() ||
          !SHA.test(pull.head?.sha || "") || typeof pull.base?.ref !== "string" || !pull.base.ref || pull.base.ref.length > 255) {
        await this.prUnknown(task, "PR identity or current head could not be verified.", now);
        return;
      }
      const headSha = pull.head.sha.toLowerCase();
      if (scan.stage === "head" && task.verifiedHeadSha !== headSha) {
        task.verifiedHeadSha = headSha;
        task.relevantMergeSha = "";
        task.seenOpen = false;
      }
      if (pull.state === "open") {
        task.seenOpen = true;
        task.relevantMergeSha = SHA.test(pull.merge_commit_sha || "") && pull.merge_commit_sha.toLowerCase() !== headSha
          ? pull.merge_commit_sha.toLowerCase() : "";
      } else if (pull.state !== "closed" || !task.seenOpen || task.verifiedHeadSha !== headSha) {
        scan.headSha = headSha;
        scan.prState = pull.state;
        await this.prUnknown(task, "PR is closed and its prior test-merge check coverage is unknown; closure alone cannot establish CI completion.", now);
        return;
      }
      // Closing/merging changes GitHub's merge_commit_sha meaning. Keep the
      // previously verified test-merge target until its checks finish; never
      // replace it with a new final merge commit or silently drop its jobs.
      const mergeSha = task.relevantMergeSha;
      if (scan.stage === "head") {
        scan.headSha = headSha;
        scan.mergeSha = mergeSha;
        scan.baseRef = pull.base.ref;
        scan.prState = pull.state;
        scan.sources = [headSha, ...(mergeSha ? [mergeSha] : [])].map(sha => ({ sha, suites: [], checks: [], statuses: [], workflows: [], combinedState: "" }));
        scan.stage = "branch";
        // Clear old-head candidate at the first authoritative observation,
        // before any eventual response can complete a superseded check set.
        if (task.candidate?.headSha !== headSha || task.candidate?.mergeSha !== mergeSha) task.candidate = null;
        await this.interactions.observePr(task.id, {
          headSha, complete: false, terminal: false, outcome: "indeterminate",
          mergeSha, prState: pull.state, seenOpen: task.seenOpen,
          requestStartedAtMs: scan.startedAtMs, confirmedAtMs: now,
          reason: `${pull.state === "closed" ? "PR is closed; checking its CI independently. " : ""}Verifying every check suite, check run, status context and workflow for the current head.`
        }, { generation: task.generation });
      } else {
        if (headSha !== scan.headSha || mergeSha !== scan.mergeSha || pull.base.ref !== scan.baseRef) {
          task.candidate = null;
          task.scan = null;
          task.nextPollMs = now;
          await this.interactions.observePr(task.id, { headSha, mergeSha, prState: pull.state, seenOpen: task.seenOpen, complete: false, terminal: false, outcome: "indeterminate", requestStartedAtMs: scan.startedAtMs, confirmedAtMs: now, reason: "PR head or test-merge commit changed during verification; restarting for the new head." }, { generation: task.generation });
          return;
        }
        const evidence = summarizePrEvidence(scan);
        const matching = task.candidate?.signature === evidence.signature &&
          task.candidate.headSha === headSha && task.candidate.mergeSha === mergeSha;
        const settled = evidence.complete && evidence.terminal && matching &&
          scan.startedAtMs - task.candidate.confirmedAtMs >= PR_SETTLE_MS;
        if (evidence.complete && evidence.terminal) {
          if (!matching) task.candidate = { headSha, mergeSha, signature: evidence.signature, confirmedAtMs: now };
        } else task.candidate = null;
        await this.interactions.observePr(task.id, {
          ...evidence, headSha, settled,
          mergeSha, prState: pull.state, seenOpen: task.seenOpen,
          requestStartedAtMs: scan.startedAtMs, confirmedAtMs: now,
          reason: settled ? "Current-head check set verified complete in two stable, fully paginated scans." : evidence.reason
        }, { generation: task.generation });
        task.scan = null;
        task.failures = 0;
        task.nextPollMs = now + (evidence.terminal ? PR_SETTLE_MS : ACTIVE_REFRESH_MS);
        return;
      }
      task.nextPollMs = now;
      return;
    }
    const source = scan.sources[scan.sourceIndex];
    const field = { suites: "check_suites", checks: "check_runs", statuses: "statuses", workflows: "workflow_runs" }[scan.stage];
    const rows = response.json[field];
    const total = response.json.total_count;
    const identity = row => scan.stage === "statuses" ? row.context : row.id;
    let valid = Array.isArray(rows) && count(total) && (scan.total === null || scan.total === total);
    if (scan.stage === "statuses" && response.json.sha?.toLowerCase() !== source.sha) valid = false;
    if (valid && (total > MAX_PAGES * PAGE_SIZE || (scan.stage === "workflows" && total >= 1000))) valid = false;
    if (valid) {
      scan.total = total;
      for (const row of rows) {
        const key = identity(row);
        if (scan.stage === "statuses" ? typeof key !== "string" || !key : !identifier(key)) { valid = false; break; }
        if (scan.seen.has(key)) { valid = false; break; }
        scan.seen.add(key);
        source[scan.stage].push(row);
      }
    }
    if (!valid) {
      await this.prUnknown(task, `Incomplete, changing or malformed ${scan.stage} inventory; completion cannot be established.`, now);
      return;
    }
    if (scan.stage === "statuses") source.combinedState = response.json.state;
    if (scan.seen.size < total) {
      if (rows.length !== PAGE_SIZE || scan.page >= MAX_PAGES) {
        await this.prUnknown(task, `Partial ${scan.stage} pagination; completion remains unverified.`, now);
        return;
      }
      scan.page++;
      task.nextPollMs = now;
      return;
    }
    if (scan.seen.size !== total) {
      await this.prUnknown(task, `Inconsistent ${scan.stage} total; completion remains unverified.`, now);
      return;
    }
    if (/<[^>]+>;\s*rel="next"/.test(response.link || "")) {
      await this.prUnknown(task, `Provider pagination contradicts the ${scan.stage} total; coverage remains incomplete.`, now);
      return;
    }
    scan.page = 1;
    scan.total = null;
    scan.seen.clear();
    const stages = ["suites", "checks", "statuses", "workflows"];
    const index = stages.indexOf(scan.stage);
    if (index < stages.length - 1) scan.stage = stages[index + 1];
    else if (++scan.sourceIndex < scan.sources.length) scan.stage = "suites";
    else scan.stage = "confirm";
    task.nextPollMs = now;
  }

  addRequired(scan, context, appId = 0) {
    if (typeof context !== "string" || !context || context.length > 500 ||
        appId !== null && appId !== undefined && (!Number.isSafeInteger(appId) || appId < -1)) return false;
    const required = { context, appId: appId > 0 ? appId : 0 };
    if (!scan.required.some(item => item.context === context && item.appId === required.appId)) scan.required.push(required);
    return true;
  }
}
