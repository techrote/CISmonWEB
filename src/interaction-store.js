import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  completionOutcome, outcomeSound, pinScopeKey, prKey, runKey,
  validPinScope, validRepository, validRun
} from "../shared/interactions.js";

const MAX_PINS = 256;
const MAX_PINS_PER_SCOPE = 64;
const MAX_ARMED = 128;
const MAX_HISTORY = 200;
const HISTORY_AGE_MS = 30 * 86400000;
const SHA = /^[0-9a-f]{40}$/i;
const OUTCOMES = new Set(["success", "failure", "cancelled", "neutral", "indeterminate"]);

export class InteractionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function fail(status, message) { throw new InteractionError(status, message); }
function checkRun(run) { if (!validRun(run)) fail(400, "A repository, positive run ID and exact run attempt are required"); }
function checkScope(scope) { if (!validPinScope(scope)) fail(400, "A valid surface and pane scope are required"); }
function active(run) { return ["queued", "in_progress"].includes(run.state); }
function text(value, limit = 400) { return typeof value === "string" ? value.slice(0, limit) : ""; }
function fingerprint(value) { return createHash("sha256").update(value).digest("hex").slice(0, 32); }

// A compact provider snapshot is enough to rehydrate a pin. Never persist
// tokens, full job lists, arbitrary request fields or browser-supplied URLs.
export function pinSnapshot(run) {
  const result = {};
  for (const key of ["repository", "workflowName", "workflow", "workflowId", "runId", "runNumber", "runAttempt",
    "branch", "event", "headSha", "checkSha", "prNumber", "prCandidates", "prAssociation", "htmlUrl", "state", "conclusion",
    "createdAtEpoch", "runStartedAtEpoch", "startedAtEpoch", "updatedAtEpoch"]) {
    if (run[key] !== undefined) result[key] = structuredClone(run[key]);
  }
  result.jobs = [];
  return result;
}

function newState() {
  return {
    version: 1, revision: 0, nextPinOrder: 1,
    settings: { soundEnabled: false, muted: false, volume: 0.25 },
    pins: [], subscriptions: [], events: [], claim: null
  };
}

function publicEvent(event) {
  const { claimId, clientId, leaseExpiresAtMs, ...delivery } = event.delivery || {};
  return { ...event, delivery };
}

export class InteractionStore {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "interactions.json");
    this.current = newState();
    this.pending = Promise.resolve();
    this.now = options.now || Date.now;
    this.coalesceMs = options.coalesceMs ?? 1200;
    this.claimLeaseMs = options.claimLeaseMs ?? 10000;
    this.attemptLeaseMs = options.attemptLeaseMs ?? 5000;
    this.audibleMaxAgeMs = options.audibleMaxAgeMs ?? 120000;
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const raw = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error("notification state is too large");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1 ||
          !Array.isArray(parsed.pins) || !Array.isArray(parsed.subscriptions) || !Array.isArray(parsed.events)) {
        throw new Error("unsupported or invalid notification state; existing file preserved");
      }
      if (parsed.pins.length > MAX_PINS || parsed.subscriptions.length > MAX_HISTORY + MAX_ARMED ||
          parsed.events.length > MAX_HISTORY) throw new Error("notification state exceeds its bounds");
      const restored = { ...newState(), ...Object.fromEntries(Object.keys(newState())
        .filter(key => Object.hasOwn(parsed, key)).map(key => [key, structuredClone(parsed[key])])) };
      restored.revision = Number.isSafeInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0;
      restored.nextPinOrder = Math.max(1, ...restored.pins.map(pin => Number(pin.order || 0) + 1));
      restored.settings = {
        soundEnabled: parsed.settings?.soundEnabled === true,
        muted: parsed.settings?.muted === true,
        volume: typeof parsed.settings?.volume === "number" && Number.isFinite(parsed.settings.volume)
          ? Math.max(0, Math.min(1, parsed.settings.volume)) : 0.25
      };
      // Invalid identities are a storage error, never an invitation to poll
      // an arbitrary path. Fail visibly without overwriting the original.
      if (restored.pins.some(pin => !validRun(pin) || !validPinScope(pin.scope)) ||
          restored.subscriptions.some(sub => !validRepository(sub.repository) ||
            (sub.type === "run" ? !validRun(sub) : sub.type !== "pr" || !Number.isSafeInteger(sub.prNumber) || sub.prNumber < 1))) {
        throw new Error("invalid identity in notification state; existing file preserved");
      }
      for (const pin of restored.pins) {
        pin.status = "restoring";
        pin.reason = "Awaiting provider confirmation after restart";
      }
      for (const sub of restored.subscriptions) {
        if (sub.status === "armed") {
          sub.phase = "recovering";
          sub.reason = "Restoring subscription; awaiting fresh provider evidence";
          // Keep a durable active baseline; settlement itself is rebuilt by
          // the provider from new, complete scans after every restart.
        }
      }
      this.cleanup(restored, this.now());
      // Existing browser windows survive a local server restart. Recovery
      // changes must have a new revision so their event/pin views refresh.
      if (JSON.stringify(restored) !== JSON.stringify(parsed)) {
        restored.revision++;
        await this.persist(restored);
      }
      this.current = restored;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.publicState();
  }

  publicState() {
    const { nextPinOrder, claim, ...state } = this.current;
    return structuredClone({ ...state, events: state.events.map(publicEvent) });
  }

  get revision() { return this.current.revision; }

  targets() {
    return structuredClone({
      pins: this.current.pins,
      subscriptions: this.current.subscriptions.filter(sub => sub.status === "armed")
    });
  }

  cleanup(state, now) {
    if (state.claim && state.claim.expiresAtMs <= now) state.claim = null;
    for (const event of state.events) {
      if (event.delivery.status === "claimed" && event.delivery.leaseExpiresAtMs <= now) {
        event.delivery = { status: "pending", reason: "Delivery owner disconnected before playback began" };
      }
      if (event.delivery.status === "pending" && now - event.observedAtMs > this.audibleMaxAgeMs) {
        event.delivery = { status: "expired", reason: "No audio-ready window claimed this event while it was recent" };
      }
    }
    state.events = state.events.filter(event => now - event.observedAtMs <= HISTORY_AGE_MS).slice(-MAX_HISTORY);
    const armed = state.subscriptions.filter(sub => sub.status === "armed");
    const history = state.subscriptions.filter(sub => sub.status !== "armed" &&
      now - (sub.finishedAtMs || sub.armedAtMs) <= HISTORY_AGE_MS).slice(-MAX_HISTORY);
    state.subscriptions = [...history, ...armed];
  }

  transact(operation) {
    const pending = this.pending.then(async () => {
      const next = structuredClone(this.current);
      const now = this.now();
      this.cleanup(next, now);
      const result = operation(next, now);
      if (JSON.stringify(next) !== JSON.stringify(this.current)) {
        next.revision = this.current.revision + 1;
        await this.persist(next);
        this.current = next;
      }
      return result === undefined ? this.publicState() : structuredClone(result);
    });
    this.pending = pending.catch(() => {});
    return pending;
  }

  async persist(value) {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = this.filePath + "." + randomUUID() + ".tmp";
    let file;
    try {
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(JSON.stringify(value) + "\n", "utf8");
      await file.sync();
      await file.close(); file = null;
      await rename(temporary, this.filePath);
    } finally {
      if (file) await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }

  setPin(run, scope, pinned = true) {
    checkRun(run); checkScope(scope);
    const id = "pin:" + pinScopeKey(scope) + ":" + runKey(run);
    return this.transact((state, now) => {
      const index = state.pins.findIndex(pin => pin.id === id);
      if (!pinned) { if (index >= 0) state.pins.splice(index, 1); return; }
      if (index >= 0) return;
      if (state.pins.length >= MAX_PINS ||
          state.pins.filter(pin => pinScopeKey(pin.scope) === pinScopeKey(scope)).length >= MAX_PINS_PER_SCOPE) {
        fail(409, "Pin limit reached (64 per pane, 256 total); unpin an existing run first");
      }
      state.pins.push({
        id, scope: { ...scope }, repository: run.repository, runId: run.runId, runAttempt: run.runAttempt,
        order: state.nextPinOrder++, pinnedAtMs: now, snapshot: pinSnapshot(run),
        status: "pending", reason: "Awaiting exact-attempt provider confirmation", confirmedAtMs: 0
      });
    });
  }

  armRun(run) {
    checkRun(run);
    if (!active(run)) fail(409, "This attempt is already terminal or its provider state is unknown");
    return this.arm({ type: "run", repository: run.repository, runId: run.runId,
      runAttempt: run.runAttempt, workflow: run.workflowName || run.workflow || "Workflow", headSha: run.headSha || "" });
  }

  armPr(repository, prNumber) {
    if (!validRepository(repository) || !Number.isSafeInteger(prNumber) || prNumber < 1) fail(400, "A verified PR identity is required");
    return this.arm({ type: "pr", repository, prNumber, headSha: "" });
  }

  arm(target) {
    const id = target.type + ":" + (target.type === "run" ? runKey(target) : prKey(target.repository, target.prNumber));
    return this.transact((state, now) => {
      const existing = state.subscriptions.find(sub => sub.id === id);
      if (existing?.status === "armed") return;
      if (state.subscriptions.filter(sub => sub.status === "armed").length >= MAX_ARMED) {
        fail(409, "Completion alert limit reached (128); cancel an existing alert first");
      }
      const sub = {
        ...target, id, generation: randomUUID(), status: "armed", phase: "verifying", armedAtMs: now,
        seenActive: false, activeHeadSha: "", lastActiveAtMs: 0, lastProviderUpdateMs: 0,
        reason: "Verifying current provider state; already completed work will not chime", confirmedAtMs: 0
      };
      if (existing) state.subscriptions.splice(state.subscriptions.indexOf(existing), 1, sub);
      else state.subscriptions.push(sub);
    });
  }

  cancel(type, target, generation) {
    const id = type + ":" + (type === "run" ? runKey(target) : prKey(target.repository, target.prNumber));
    return this.cancelSubscription(id, generation);
  }

  cancelSubscription(id, generation) {
    return this.transact((state, now) => {
      const sub = state.subscriptions.find(item => item.id === id);
      if (!sub || sub.status !== "armed") return;
      if (generation && generation !== sub.generation) fail(409, "This alert was replaced; refresh before cancelling it");
      sub.status = "cancelled"; sub.phase = "cancelled";
      sub.finishedAtMs = now; sub.reason = "Cancelled by the user";
    });
  }

  updateSubscription(id, patch, { generation } = {}) {
    return this.transact(state => {
      const sub = state.subscriptions.find(item => item.id === id && item.status === "armed");
      if (!sub || generation && sub.generation !== generation) return;
      for (const key of ["phase", "reason", "confirmedAtMs", "nextPollMs", "providerStatus", "coverage", "prState"]) {
        if (Object.hasOwn(patch, key)) sub[key] = typeof patch[key] === "string" ? text(patch[key]) : structuredClone(patch[key]);
      }
    });
  }

  invalidateSubscription(id, reason, { generation } = {}) {
    return this.transact((state, now) => {
      const sub = state.subscriptions.find(item => item.id === id && item.status === "armed");
      if (!sub || generation && sub.generation !== generation) return;
      sub.status = "invalidated"; sub.phase = "invalidated";
      sub.finishedAtMs = now; sub.reason = text(reason);
    });
  }

  updatePin(id, patch) {
    return this.transact(state => {
      const pin = state.pins.find(item => item.id === id);
      if (!pin) return;
      for (const key of ["status", "reason", "confirmedAtMs", "nextPollMs"]) {
        if (Object.hasOwn(patch, key)) pin[key] = typeof patch[key] === "string" ? text(patch[key]) : patch[key];
      }
      if (patch.snapshot && validRun(patch.snapshot) && runKey(patch.snapshot) === runKey(pin)) pin.snapshot = pinSnapshot(patch.snapshot);
    });
  }

  proofAfterArm(sub, evidence) {
    return evidence.terminalTimeSource === "completed_at" && Number.isFinite(evidence.terminalTimeMs) &&
      evidence.terminalTimeMs > sub.armedAtMs && evidence.terminalTimeMs <= evidence.confirmedAtMs + 5000;
  }

  invalidateAlreadyComplete(sub, now) {
    sub.status = "invalidated"; sub.phase = "already-complete"; sub.finishedAtMs = now;
    sub.reason = "Already completed when first verified; no post-arm activity was confirmed, so no retrospective chime";
  }

  observeRun(run, evidence = {}) {
    checkRun(run);
    return this.transact((state, now) => {
      const key = runKey(run);
      const confirmedAtMs = Number(evidence.confirmedAtMs);
      if (!Number.isFinite(confirmedAtMs) || confirmedAtMs > now + 5000 || evidence.coverageComplete === false) return;
      for (const pin of state.pins.filter(item => runKey(item) === key)) {
        if (confirmedAtMs < (pin.confirmedAtMs || 0) || evidence.requestStartedAtMs < pin.pinnedAtMs) continue;
        pin.snapshot = pinSnapshot(run); pin.status = "available"; pin.reason = ""; pin.confirmedAtMs = confirmedAtMs;
      }
      const sub = state.subscriptions.find(item => item.id === "run:" + key && item.status === "armed");
      if (!sub || evidence.generation && sub.generation !== evidence.generation ||
          evidence.requestStartedAtMs < sub.armedAtMs || !Number.isFinite(evidence.requestStartedAtMs) ||
          evidence.requestStartedAtMs < (sub.lastRequestStartedAtMs || 0) ||
          confirmedAtMs < (sub.confirmedAtMs || 0)) return;
      sub.lastRequestStartedAtMs = evidence.requestStartedAtMs;
      sub.confirmedAtMs = confirmedAtMs;
      const providerUpdateMs = Number(run.updatedAtEpoch || 0) * 1000;
      if (providerUpdateMs && providerUpdateMs < sub.lastProviderUpdateMs) {
        sub.phase = "pending"; sub.reason = "Ignoring a stale provider response"; return;
      }
      if (active(run)) {
        sub.seenActive = true; sub.lastActiveAtMs = confirmedAtMs;
        sub.lastProviderUpdateMs = Math.max(sub.lastProviderUpdateMs || 0, providerUpdateMs);
        sub.phase = "monitoring"; sub.reason = "Waiting for this exact run attempt to complete"; return;
      }
      if (run.state !== "completed") { sub.phase = "indeterminate"; sub.reason = "Provider run state is unknown"; return; }
      if (evidence.terminalTimeSource === "completed_at" && evidence.terminalTimeMs > 0 &&
          evidence.terminalTimeMs <= sub.armedAtMs) {
        if (evidence.terminalTimeMs < sub.armedAtMs - 1000) this.invalidateAlreadyComplete(sub, now);
        else {
          sub.phase = "indeterminate";
          sub.reason = "Completion timestamp overlaps arming; post-arm completion cannot be established safely";
        }
        return;
      }
      if (!sub.seenActive && !this.proofAfterArm(sub, evidence)) { this.invalidateAlreadyComplete(sub, now); return; }
      // A delayed active observation cannot make a terminal record whose
      // provider timestamp predates arming into a new completion. A genuine
      // completed_at after arming remains valid evidence for fast runs.
      if (providerUpdateMs && providerUpdateMs < sub.armedAtMs - 1000 && !this.proofAfterArm(sub, evidence)) {
        this.invalidateAlreadyComplete(sub, now); return;
      }
      this.finish(state, sub, completionOutcome(run.conclusion), run.conclusion, confirmedAtMs,
        "run:" + key + ":" + completionOutcome(run.conclusion));
    });
  }

  observePr(id, evidence = {}, { generation } = {}) {
    return this.transact((state, now) => {
      const sub = state.subscriptions.find(item => item.id === id && item.type === "pr" && item.status === "armed");
      if (!sub || (generation || evidence.generation) && sub.generation !== (generation || evidence.generation) ||
          !Number.isFinite(evidence.requestStartedAtMs) || evidence.requestStartedAtMs < sub.armedAtMs ||
          evidence.requestStartedAtMs < (sub.lastRequestStartedAtMs || 0) ||
          !Number.isFinite(evidence.confirmedAtMs) || evidence.confirmedAtMs < (sub.confirmedAtMs || 0) ||
          evidence.confirmedAtMs > now + 5000) return;
      sub.lastRequestStartedAtMs = evidence.requestStartedAtMs;
      sub.confirmedAtMs = evidence.confirmedAtMs;
      sub.reason = text(evidence.reason);
      if (!SHA.test(evidence.headSha || "")) { sub.phase = "indeterminate"; sub.reason ||= "PR head is not verified"; return; }
      const headSha = evidence.headSha.toLowerCase();
      if (sub.headSha !== headSha) {
        sub.headSha = headSha; sub.seenActive = false; sub.activeHeadSha = "";
        sub.lastActiveAtMs = 0; sub.signature = "";
        sub.relevantMergeSha = ""; sub.seenOpen = false;
      }
      if (["open", "closed"].includes(evidence.prState)) sub.prState = evidence.prState;
      if (evidence.prState === "open") sub.seenOpen = true;
      if (evidence.prState === "open" && evidence.mergeSha === "") sub.relevantMergeSha = "";
      if (SHA.test(evidence.mergeSha || "") && evidence.mergeSha.toLowerCase() !== headSha) {
        sub.relevantMergeSha = evidence.mergeSha.toLowerCase();
      }
      sub.coverage = evidence.complete === true ? "complete" : "incomplete";
      if (!evidence.complete) { sub.phase = "indeterminate"; sub.reason ||= "Waiting for complete check and status coverage"; return; }
      if (!evidence.terminal) {
        sub.seenActive = true; sub.activeHeadSha = headSha; sub.lastActiveAtMs = evidence.confirmedAtMs;
        sub.phase = "monitoring"; sub.reason ||= "Current PR head still has pending checks or statuses"; return;
      }
      if (!sub.seenActive && !this.proofAfterArm(sub, evidence)) {
        if (evidence.settled) this.invalidateAlreadyComplete(sub, now);
        else { sub.phase = "settling"; sub.reason = "Initial checks appear terminal; confirming coverage before deciding whether work completed after arming"; }
        return;
      }
      sub.signature = text(evidence.signature, 10000);
      if (!evidence.settled || !sub.signature || !OUTCOMES.has(evidence.outcome)) {
        sub.phase = "settling"; sub.reason ||= "Confirming a stable, complete check set before notification"; return;
      }
      this.finish(state, sub, evidence.outcome, evidence.reason || "Verified PR check set completed", evidence.confirmedAtMs,
        "pr:" + prKey(sub.repository, sub.prNumber) + "@" + headSha + ":" + evidence.outcome + ":" + fingerprint(sub.signature));
    });
  }

  finish(state, sub, outcome, reason, observedAtMs, id) {
    sub.status = "fired"; sub.phase = "completed"; sub.finishedAtMs = observedAtMs;
    sub.outcome = outcome; sub.reason = text(reason); sub.eventId = id;
    if (state.events.some(event => event.id === id)) return;
    const sound = outcomeSound(outcome);
    const enabled = state.settings.soundEnabled && !state.settings.muted && state.settings.volume > 0;
    state.events.push({
      id, subscriptionId: sub.id, type: sub.type, repository: sub.repository,
      ...(sub.type === "run" ? { runId: sub.runId, runAttempt: sub.runAttempt } : { prNumber: sub.prNumber }),
      headSha: sub.headSha, outcome, sound, observedAtMs, reason: text(reason),
      title: sub.type === "run" ? sub.repository + " · " + sub.workflow + " · attempt " + sub.runAttempt : sub.repository + " · PR #" + sub.prNumber + " checks",
      delivery: sound && enabled ? { status: "pending", reason: "Waiting for an audio-ready browser window" } : {
        status: "silent", reason: !sound ? "Neutral or indeterminate outcome: no success/failure sound" :
          state.settings.muted ? "Sound was muted at completion" : "Sound was disabled at completion"
      }
    });
    // Also trim after appending, so even a rapid batch never writes an
    // oversized file which its next process cannot load.
    state.events = state.events.slice(-MAX_HISTORY);
  }

  setSettings(patch) {
    if (!patch || typeof patch !== "object") fail(400, "Sound settings must be an object");
    for (const field of ["soundEnabled", "muted"]) {
      if (Object.hasOwn(patch, field) && typeof patch[field] !== "boolean") fail(400, field + " must be a boolean");
    }
    if (Object.hasOwn(patch, "volume") && (typeof patch.volume !== "number" || !Number.isFinite(patch.volume) || patch.volume < 0 || patch.volume > 1)) {
      fail(400, "Volume must be between 0 and 1");
    }
    return this.transact(state => {
      for (const key of ["soundEnabled", "muted", "volume"]) if (Object.hasOwn(patch, key)) state.settings[key] = patch[key];
      if (!state.settings.soundEnabled || state.settings.muted || state.settings.volume === 0) {
        for (const event of state.events) {
          if (["pending", "claimed"].includes(event.delivery.status)) event.delivery = { status: "silent", reason: "Sound disabled or muted before playback" };
        }
        if (state.claim?.phase === "claimed") state.claim = null;
      }
    });
  }

  checkClient(clientId) {
    if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(clientId)) fail(400, "A valid browser client identity is required");
  }

  claim({ clientId, audioReady } = {}) {
    this.checkClient(clientId);
    return this.transact((state, now) => {
      const empty = { claimId: null, events: [], sound: null };
      if (audioReady !== true || !state.settings.soundEnabled || state.settings.muted || state.settings.volume === 0 || state.claim) return empty;
      const pending = state.events.filter(event => event.delivery.status === "pending" && event.sound);
      if (!pending.length || now - pending[0].observedAtMs < this.coalesceMs) return empty;
      const batch = pending.slice(0, 50);
      const claimId = randomUUID(), expiresAtMs = now + this.claimLeaseMs;
      const sound = batch.some(event => event.sound === "failure") ? "failure" : "success";
      state.claim = { id: claimId, clientId, eventIds: batch.map(event => event.id), sound, phase: "claimed", expiresAtMs };
      for (const event of batch) event.delivery = { status: "claimed", claimId, clientId, leaseExpiresAtMs: expiresAtMs, claimedAtMs: now };
      return { claimId, events: batch.map(publicEvent), sound, expiresAtMs };
    });
  }

  begin({ clientId, claimId } = {}) {
    this.checkClient(clientId);
    return this.transact((state, now) => {
      const claim = state.claim;
      if (!claim || claim.id !== claimId || claim.clientId !== clientId || claim.phase !== "claimed") {
        fail(409, "Playback claim expired, was already consumed, or belongs to another window");
      }
      if (!state.settings.soundEnabled || state.settings.muted || state.settings.volume === 0) fail(409, "Sound is disabled or muted");
      claim.phase = "attempted"; claim.expiresAtMs = now + this.attemptLeaseMs;
      const events = state.events.filter(event => claim.eventIds.includes(event.id));
      for (const event of events) {
        event.delivery.status = "attempted"; event.delivery.attemptedAtMs = now;
        event.delivery.reason = "Playback attempt durably consumed; awaiting browser confirmation";
      }
      return { ok: true, events: events.map(publicEvent), sound: claim.sound };
    });
  }

  acknowledge({ clientId, claimId, status, reason = "" } = {}) {
    this.checkClient(clientId);
    if (!["played", "blocked", "failed"].includes(status)) fail(400, "Invalid playback acknowledgement");
    return this.transact((state, now) => {
      const events = state.events.filter(event => event.delivery.claimId === claimId && event.delivery.clientId === clientId);
      if (!events.length || events.some(event => !["attempted", status].includes(event.delivery.status))) {
        fail(409, "No matching playback attempt to acknowledge");
      }
      for (const event of events) {
        if (event.delivery.status === status) continue;
        event.delivery.status = status; event.delivery.acknowledgedAtMs = now;
        event.delivery.reason = text(reason) || (status === "played" ?
          "Browser confirmed a running AudioContext through the sound envelope; speaker output cannot be verified" :
          "Browser could not confirm sound playback; this event will not replay");
      }
      if (state.claim?.id === claimId) state.claim = null;
    });
  }
}
