// Browser audio is an optional delivery channel. Completion and one-shot
// subscription ownership belong to the server; rendering a row never chimes.
export const DEFAULT_SOUND = Object.freeze({ soundEnabled: false, muted: false, volume: 0.25 });

export function soundSettings(value = {}) {
  const volume = Number(value.volume);
  return {
    soundEnabled: value.soundEnabled === true,
    muted: value.muted === true,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.25
  };
}

// Two three-voice sine chords keep the signal soft and distinguish the
// contour without relying on a startling transient or high harmonics.
export function chimeNotes(kind) {
  const chords = kind === "failure"
    ? [[293.66, 311.13, 415.30], [261.63, 277.18, 369.99]]
    : [[261.63, 329.63, 392.00], [329.63, 392.00, 523.25]];
  return chords.flatMap((frequencies, index) => frequencies.map(frequency => ({
    frequency, offset: index * 0.28, duration: 0.56,
    attack: 0.025, peak: 0.045
  })));
}

export class ChimePlayer {
  constructor({ AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext,
    onState = () => {}, setTimer = (...args) => globalThis.setTimeout(...args),
    clearTimer = handle => globalThis.clearTimeout(handle) } = {}) {
    this.AudioContext = AudioContext;
    this.onState = onState;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.context = null;
    this.voices = new Set();
    this.status = AudioContext ? "idle" : "unavailable";
    this.reason = AudioContext ? "Click Enable audio to initialise sound in this window." :
      "Web Audio is unavailable in this browser.";
    this.playing = null;
    this.disposed = false;
  }

  setStatus(status, reason = "") {
    this.status = status;
    this.reason = reason;
    this.onState({ status, reason });
  }

  ready() { return !this.disposed && this.context?.state === "running"; }

  enableFromGesture() {
    // Do not put an await before creation/resume: Firefox requires that call
    // to stay in the trusted click/key handler's user-activation task.
    if (this.disposed || !this.AudioContext) return Promise.resolve(false);
    try {
      if (!this.context || this.context.state === "closed") {
        this.context = new this.AudioContext();
        this.context.addEventListener?.("statechange", () => {
          if (this.disposed) return;
          if (this.context.state === "running") this.setStatus("ready", "Audio is ready in this window.");
          else this.setStatus("blocked", "Audio paused or blocked. Click Enable audio in this window.");
        });
      }
      const resumed = this.context.state === "running" ? Promise.resolve() : this.context.resume();
      let timeout;
      const bounded = new Promise(resolve => { timeout = this.setTimer(() => resolve(false), 1500); });
      return Promise.race([Promise.resolve(resumed).then(() => this.ready(), () => false), bounded])
        .then(ready => {
          this.clearTimer(timeout);
          if (!this.disposed) this.setStatus(ready ? "ready" : "blocked", ready
            ? "Audio is ready in this window."
            : "Audio blocked. Click Enable audio; check this site's autoplay permission and your audio output device if it remains blocked.");
          return ready;
        });
    } catch {
      this.setStatus("unavailable", "Audio could not initialise. Check your browser audio and autoplay settings.");
      return Promise.resolve(false);
    }
  }

  async play(kind, volume = 0.25) {
    if (!this.ready()) return { status: "blocked", reason: "AudioContext is not running." };
    if (this.playing) return { status: "failed", reason: "A preview or completion chime is already playing." };
    if (!(volume > 0)) return { status: "blocked", reason: "Volume is zero." };
    const context = this.context;
    const start = context.currentTime + 0.025;
    const notes = chimeNotes(kind);
    let finish;
    const result = new Promise(resolve => { finish = resolve; });
    let timeout;
    let completed = 0;
    const clean = (status, reason) => {
      if (this.playing !== clean) return;
      this.playing = null;
      this.clearTimer(timeout);
      for (const voice of this.voices) {
        voice.oscillator.onended = null;
        try { voice.oscillator.stop(); } catch { /* already ended */ }
        voice.oscillator.disconnect();
        voice.envelope.disconnect();
      }
      this.voices.clear();
      finish({ status, reason });
    };
    this.playing = clean;
    try {
      for (const note of notes) {
        const oscillator = context.createOscillator();
        const envelope = context.createGain();
        const at = start + note.offset;
        const peak = note.peak * Math.min(1, volume);
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(note.frequency, at);
        envelope.gain.setValueAtTime(0, at);
        envelope.gain.linearRampToValueAtTime(peak, at + note.attack);
        envelope.gain.exponentialRampToValueAtTime(Math.max(0.00001, peak * 0.42), at + 0.17);
        envelope.gain.exponentialRampToValueAtTime(0.00001, at + note.duration - 0.015);
        envelope.gain.linearRampToValueAtTime(0, at + note.duration);
        oscillator.connect(envelope);
        envelope.connect(context.destination);
        this.voices.add({ oscillator, envelope });
        oscillator.onended = () => {
          completed++;
          if (completed === notes.length) clean(this.ready() ? "played" : "blocked",
            this.ready() ? "Browser completed the audio envelopes; speaker output cannot be verified."
              : "Audio was suspended during playback.");
        };
        oscillator.start(at);
        oscillator.stop(at + note.duration + 0.01);
      }
      // A suspended context might never emit ended. Bound acknowledgement
      // and report the interruption without retrying the same event.
      timeout = this.setTimer(() => clean("blocked", "Browser did not confirm completed playback."), 2500);
    } catch {
      clean("failed", "Browser failed to schedule the completion chime.");
    }
    return result;
  }

  stop(reason = "Sound muted or disabled during playback.") {
    this.playing?.("blocked", reason);
  }

  destroy() {
    this.disposed = true;
    this.stop("Window closed before playback confirmation.");
    void this.context?.close?.().catch(() => {});
  }
}

export class NotificationDelivery {
  constructor({ api, player, onChange = () => {}, onStatus = () => {},
    clientId = globalThis.crypto?.randomUUID?.() || (Date.now() + "-" + Math.random().toString(16).slice(2)),
    setTimer = (...args) => globalThis.setTimeout(...args),
    clearTimer = handle => globalThis.clearTimeout(handle) } = {}) {
    this.api = api;
    this.player = player;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.clientId = clientId;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.settings = { ...DEFAULT_SOUND };
    this.events = [];
    this.pendingAcks = new Map();
    this.busy = false;
    this.timer = null;
    this.disposed = false;
  }

  update(state) {
    if (this.disposed || !state) return;
    this.settings = soundSettings(state.settings);
    this.events = state.events || [];
    if (!this.allowed()) this.player.stop?.();
    this.schedule();
  }

  allowed() {
    return this.settings.soundEnabled && !this.settings.muted && this.settings.volume > 0;
  }

  schedule() {
    if (this.timer || this.busy || this.disposed) return;
    if (!this.pendingAcks.size && (!this.allowed() || !this.player.ready() ||
        !this.events.some(event => ["pending", "claimed"].includes(event.delivery?.status)))) return;
    this.timer = this.setTimer(() => { this.timer = null; void this.deliver(); }, 350);
  }

  post(path, body) { return this.api(path, { method: "POST", body: JSON.stringify(body) }); }

  async acknowledge(claimId, outcome) {
    const acknowledgement = { clientId: this.clientId, claimId, ...outcome };
    this.pendingAcks.set(claimId, acknowledgement);
    const next = await this.post("/api/notifications/ack", acknowledgement);
    this.pendingAcks.delete(claimId);
    this.onChange(next);
  }

  async deliver() {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      for (const [claimId, acknowledgement] of [...this.pendingAcks]) {
        const next = await this.post("/api/notifications/ack", acknowledgement);
        this.pendingAcks.delete(claimId);
        this.onChange(next);
      }
      if (!this.allowed() || !this.player.ready() || this.player.playing || this.disposed) return;
      const claim = await this.post("/api/notifications/claim", { clientId: this.clientId, audioReady: true });
      if (!claim.claimId || !claim.events?.length) return;
      if (!this.allowed() || !this.player.ready() || this.disposed) return; // unbegun lease can be recovered
      // This server write irrevocably consumes delivery before oscillators
      // start. A lost response deliberately favours no duplicate audio over
      // guessing that playback was safe to retry in another window.
      const begun = await this.post("/api/notifications/begin", { clientId: this.clientId, claimId: claim.claimId });
      if (!begun.ok) return;
      const outcome = this.disposed || !this.allowed()
        ? { status: "blocked", reason: "Sound disabled or window closed before playback." }
        : await this.player.play(begun.sound || claim.sound, this.settings.volume);
      this.onStatus(outcome.status === "played" ? "Completion chime played in this window." : outcome.reason);
      await this.acknowledge(claim.claimId, outcome);
    } catch {
      this.onStatus("Notification delivery is offline or uncertain. History preserves the server's last confirmed state.");
    } finally {
      this.busy = false;
      // Normal /api/state refresh schedules subsequent batches/ack retries;
      // a failed request never creates its own fast polling loop.
    }
  }

  destroy() {
    this.disposed = true;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}

function readableDelivery(event) {
  const status = event.delivery?.status || "pending";
  return ({
    pending: "Awaiting an audio-ready window (up to two minutes)",
    claimed: "Audio delivery claimed by one window",
    attempted: "Playback attempted; confirmation unavailable",
    played: "Browser confirmed playback; speaker output unverified",
    blocked: "Playback was blocked or interrupted",
    failed: "Playback failed",
    expired: "No eligible window delivered sound before expiry",
    silent: "Recorded without a success/failure chime"
  })[status] || status;
}

export function createNotifications({ api, onChange = () => {},
  document = globalThis.document, window = globalThis.window } = {}) {
  const buttons = new Set();
  let state = { revision: -1, pins: [], subscriptions: [], events: [], settings: { ...DEFAULT_SOUND } };
  let lastRevision = -1;
  let saving = false;
  let previewing = false;
  let message = "";
  let disposed = false;
  const el = (tag, className = "", text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const dialog = el("dialog", "dialog notification-dialog");
  dialog.id = "notificationDialog";
  dialog.setAttribute("aria-labelledby", "notificationTitle");
  const shell = el("div", "dialog-shell");
  const header = el("header", "dialog-header");
  const heading = el("h2", "", "Completion notifications");
  heading.id = "notificationTitle";
  const close = el("button", "icon-button", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close completion notifications");
  close.addEventListener("click", () => dialog.close());
  header.append(heading, close);
  const controls = el("section", "notification-controls");
  const labelled = (text, type, id) => {
    const label = el("label", "notification-setting");
    const input = el("input");
    input.type = type;
    input.id = id;
    label.append(input, el("span", "", text));
    controls.append(label);
    return input;
  };
  const enabled = labelled("Sound enabled", "checkbox", "notificationSoundEnabled");
  const muted = labelled("Mute", "checkbox", "notificationMuted");
  const volume = labelled("Volume", "range", "notificationVolume");
  volume.min = "0"; volume.max = "100"; volume.step = "1";
  volume.setAttribute("aria-label", "Completion chime volume");
  const volumeValue = el("output", "notification-volume-value", "25%");
  volumeValue.setAttribute("for", volume.id);
  volume.parentElement.append(volumeValue);
  const actions = el("div", "notification-audio-actions");
  const enableAudio = el("button", "button secondary", "Enable audio in this window");
  const success = el("button", "button secondary", "Preview success");
  const failure = el("button", "button secondary", "Preview failure");
  for (const button of [enableAudio, success, failure]) button.type = "button";
  actions.append(enableAudio, success, failure);
  controls.append(actions);
  const status = el("p", "notification-audio-status");
  status.id = "notificationAudioStatus";
  status.setAttribute("role", "status");
  const help = el("p", "notification-help", "Audio needs an open, connected window and permission to play. Enable audio after reopening a window. Muted, blocked or closed windows cannot guarantee a chime; completion history remains available. Preview respects mute and volume.");
  const subscriptionHeading = el("h3", "", "Armed alerts and recent status");
  const subscriptions = el("ul", "notification-subscriptions");
  const historyHeading = el("h3", "", "Recent completion history");
  const history = el("ol", "notification-history");
  const reminder = el("p", "notification-help", "Watch run keeps a run visible. The Alerts surface filters attention-worthy runs. Completion alerts are separate, one-shot subscriptions; PR alerts follow checks on the current PR head, not merge or closure.");
  shell.append(header, controls, status, help, subscriptionHeading, subscriptions, historyHeading, history, reminder);
  dialog.append(shell);
  document.body.append(dialog);

  const player = new ChimePlayer({ AudioContext: window?.AudioContext || window?.webkitAudioContext,
    onState: () => { renderStatus(); delivery?.schedule(); } });
  const accept = next => {
    update(next);
    onChange(next);
  };
  const delivery = new NotificationDelivery({ api, player, onChange: accept,
    onStatus: text => { message = text; renderStatus(); } });

  function renderStatus() {
    const settings = soundSettings(state.settings);
    const armed = (state.subscriptions || []).filter(item => item.status === "armed").length;
    const sound = !settings.soundEnabled ? "Sound off" : settings.muted || settings.volume === 0 ? "Muted" :
      player.ready() ? "Audio ready" : player.status === "unavailable" ? "Audio unavailable" : "Audio blocked — click to enable";
    const needsAudio = settings.soundEnabled && !settings.muted && settings.volume > 0 && !player.ready() &&
      (armed > 0 || (state.events || []).some(event => event.delivery?.status === "pending"));
    const audioWarning = needsAudio ? (player.status === "unavailable" ? "Audio unavailable" : "Enable audio") : "";
    for (const button of buttons) {
      button.textContent = (button.dataset.compact === "true" ? "🔔 " + armed : "Notifications · " + armed) +
        (audioWarning ? " · " + audioWarning : "");
      button.setAttribute("aria-label", "Completion notifications: " + armed + " armed; " + sound);
      button.title = armed + " armed completion alerts · " + sound;
      button.dataset.audioState = !settings.soundEnabled ? "off" : settings.muted ? "muted" : player.status;
    }
    status.textContent = sound + ". " + (message || player.reason);
    status.dataset.audioState = player.status;
    const mutedSound = settings.muted || settings.volume === 0;
    success.disabled = saving || previewing || mutedSound || player.status === "unavailable";
    failure.disabled = success.disabled;
    enableAudio.disabled = player.status === "unavailable";
    enabled.disabled = saving;
    muted.disabled = saving;
  }

  function renderLists() {
    subscriptions.replaceChildren();
    const armed = (state.subscriptions || []).filter(item => item.status === "armed");
    const inactive = (state.subscriptions || []).filter(item => item.status !== "armed")
      .sort((a, b) => (b.finishedAtMs || b.armedAtMs) - (a.finishedAtMs || a.armedAtMs)).slice(0, 10);
    if (!armed.length) subscriptions.append(el("li", "notification-empty", "No armed completion alerts. Right-click a run to add one."));
    for (const subscription of [...armed, ...inactive]) {
      const item = el("li", "notification-record");
      const title = subscription.type === "pr"
        ? subscription.repository + " PR #" + subscription.prNumber
        : subscription.repository + " run #" + subscription.runId + " / attempt " + subscription.runAttempt;
      item.append(el("strong", "", title));
      item.append(el("span", "notification-record-detail", (subscription.status === "armed" ? subscription.phase || "pending" : subscription.status) +
        (subscription.reason ? " · " + subscription.reason : "") +
        (subscription.headSha ? " · head " + subscription.headSha.slice(0, 8) : "")));
      if (subscription.status !== "armed") { subscriptions.append(item); continue; }
      const cancel = el("button", "button secondary", "Cancel alert");
      cancel.type = "button";
      cancel.setAttribute("aria-label", "Cancel " + title + " completion alert");
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        try {
          accept(await api("/api/interactions", { method: "POST", body: JSON.stringify({
            action: subscription.type === "pr" ? "cancel-pr" : "cancel-run",
            repository: subscription.repository, runId: subscription.runId,
            runAttempt: subscription.runAttempt, prNumber: subscription.prNumber,
            subscriptionId: subscription.id, generation: subscription.generation
          }) }));
        } catch (error) { message = error.message; cancel.disabled = false; renderStatus(); }
      });
      item.append(cancel);
      subscriptions.append(item);
    }
    history.replaceChildren();
    const events = [...(state.events || [])].sort((a, b) => b.observedAtMs - a.observedAtMs).slice(0, 30);
    if (!events.length) history.append(el("li", "notification-empty", "No completion events yet."));
    for (const event of events) {
      const item = el("li", "notification-record");
      item.dataset.eventId = event.id;
      item.dataset.delivery = event.delivery?.status || "pending";
      item.append(el("strong", "", event.title || event.repository));
      item.append(el("span", "notification-record-detail", String(event.outcome || "indeterminate") + " · " +
        new Date(event.observedAtMs).toLocaleString() + (event.reason ? " · " + event.reason : "")));
      item.append(el("span", "notification-delivery", readableDelivery(event)));
      history.append(item);
    }
  }

  async function save(patch) {
    saving = true;
    renderStatus();
    try {
      accept(await api("/api/notifications/settings", { method: "POST", body: JSON.stringify(patch) }));
      message = "Sound settings saved.";
    } catch (error) { message = error.message; }
    finally {
      saving = false;
      renderSettings();
      renderStatus();
    }
  }

  function renderSettings() {
    const settings = soundSettings(state.settings);
    enabled.checked = settings.soundEnabled;
    muted.checked = settings.muted;
    if (document.activeElement !== volume) volume.value = String(Math.round(settings.volume * 100));
    volumeValue.textContent = Math.round(settings.volume * 100) + "%";
  }

  enabled.addEventListener("change", () => {
    if (enabled.checked) void player.enableFromGesture();
    else player.stop();
    void save({ soundEnabled: enabled.checked });
  });
  muted.addEventListener("change", () => {
    if (!muted.checked) void player.enableFromGesture();
    else player.stop();
    void save({ muted: muted.checked });
  });
  volume.addEventListener("input", () => { volumeValue.textContent = volume.value + "%"; });
  volume.addEventListener("change", () => { void save({ volume: Number(volume.value) / 100 }); });
  enableAudio.addEventListener("click", () => { message = ""; void player.enableFromGesture(); });
  const preview = async kind => {
    if (previewing || soundSettings(state.settings).muted || soundSettings(state.settings).volume === 0) return;
    const ready = player.enableFromGesture();
    previewing = true;
    renderStatus();
    if (await ready) {
      const result = await player.play(kind, soundSettings(state.settings).volume);
      message = result.status === "played" ? "Preview completed in this browser; speaker output cannot be verified." : result.reason;
    }
    previewing = false;
    renderStatus();
    delivery.schedule();
  };
  success.addEventListener("click", () => { void preview("success"); });
  failure.addEventListener("click", () => { void preview("failure"); });

  function update(next) {
    if (disposed || !next) return;
    // Ignore an older polling response overtaking a mutation response.
    const revision = Number(next.revision ?? 0);
    if (revision < lastRevision) return;
    state = { ...state, ...next, settings: soundSettings(next.settings || state.settings) };
    renderSettings();
    renderStatus();
    if (revision !== lastRevision) renderLists();
    lastRevision = revision;
    delivery.update(state);
  }

  function open() {
    if (disposed) return;
    renderLists();
    if (!dialog.open) dialog.showModal();
  }

  function createButton({ compact = false } = {}) {
    const button = el("button", compact ? "notification-button notification-button-compact" : "button secondary notification-button");
    button.type = "button";
    button.dataset.compact = String(compact);
    button.addEventListener("click", () => {
      if (state.settings.soundEnabled && !state.settings.muted) void player.enableFromGesture();
      open();
    });
    buttons.add(button);
    renderStatus();
    return button;
  }

  renderSettings(); renderStatus(); renderLists();
  return {
    createButton, update, open,
    enableFromGesture: () => player.enableFromGesture(),
    destroy() {
      disposed = true;
      delivery.destroy();
      player.destroy();
      dialog.remove();
      for (const button of buttons) button.remove();
      buttons.clear();
    }
  };
}
