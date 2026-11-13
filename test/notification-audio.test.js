import assert from "node:assert/strict";
import test from "node:test";
import { ChimePlayer, NotificationDelivery, chimeNotes, soundSettings } from "../public/notifications.js";

const turn = () => new Promise(resolve => setImmediate(resolve));
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class AudioParam {
  constructor() { this.calls = []; }
  setValueAtTime(...args) { this.calls.push(["set", ...args]); }
  linearRampToValueAtTime(...args) { this.calls.push(["linear", ...args]); }
  exponentialRampToValueAtTime(...args) { this.calls.push(["exponential", ...args]); }
}
class AudioNode {
  constructor() { this.frequency = new AudioParam(); this.gain = new AudioParam(); }
  connect(node) { this.connected = node; }
  disconnect() { this.disconnected = true; }
  start(time) { this.started = time; }
  stop(time) { this.stopped = time; }
}
class AudioContextFixture {
  constructor() {
    this.state = "suspended"; this.currentTime = 1;
    this.destination = {}; this.oscillators = []; this.gains = [];
  }
  addEventListener() {}
  resume() { this.resumeCalled = true; this.state = "running"; return Promise.resolve(); }
  createOscillator() { const node = new AudioNode(); this.oscillators.push(node); return node; }
  createGain() { const node = new AudioNode(); this.gains.push(node); return node; }
  close() { this.state = "closed"; return Promise.resolve(); }
}

test("sound is opt-in with bounded persisted values", () => {
  assert.deepEqual(soundSettings(), { soundEnabled: false, muted: false, volume: 0.25 });
  assert.deepEqual(soundSettings({ soundEnabled: true, muted: true, volume: 7 }), {
    soundEnabled: true, muted: true, volume: 1
  });
  assert.equal(soundSettings({ volume: -3 }).volume, 0);
  assert.equal(soundSettings({ volume: "wrong" }).volume, 0.25);
  assert.equal(soundSettings({ soundEnabled: "true" }).soundEnabled, false);
});

test("success and failure are soft, different chord progressions with opposite contours", () => {
  const positive = chimeNotes("success"), negative = chimeNotes("failure");
  for (const notes of [positive, negative]) {
    assert.equal(notes.length, 6);
    assert.equal(new Set(notes.map(note => note.offset)).size, 2);
    assert.ok(Math.max(...notes.map(note => note.offset + note.duration)) < 1);
    assert.ok(notes.every(note => note.attack >= 0.02 && note.peak <= 0.045));
  }
  assert.ok(positive[3].frequency > positive[0].frequency);
  assert.ok(negative[3].frequency < negative[0].frequency);
  assert.ok(negative[1].frequency / negative[0].frequency < 1.1, "soft minor-second dissonance");
  assert.ok(positive[1].frequency / positive[0].frequency > 1.2, "consonant major third");
});

test("audio is created and resumed synchronously by the gesture, never by playback", async () => {
  const player = new ChimePlayer({ AudioContext: AudioContextFixture });
  assert.equal(player.context, null);
  assert.equal((await player.play("success")).status, "blocked");
  assert.equal(player.context, null);
  const enabling = player.enableFromGesture();
  assert.equal(player.context.resumeCalled, true, "resume remains inside the direct gesture stack");
  assert.equal(await enabling, true);
  const playing = player.play("success", 0.25);
  assert.equal(player.context.oscillators.length, 6);
  for (const envelope of player.context.gains) {
    assert.deepEqual(envelope.gain.calls[0].slice(0, 2), ["set", 0]);
    assert.ok(Math.max(...envelope.gain.calls.map(call => call[1])) <= 0.045 * 0.25);
  }
  for (const oscillator of player.context.oscillators) oscillator.onended();
  assert.equal((await playing).status, "played");
  assert.equal(player.voices.size, 0);
  player.destroy();
});

test("blocked resume is bounded and interrupted audio never reports completed playback", async () => {
  class BlockedContext extends AudioContextFixture {
    resume() { return new Promise(() => {}); }
  }
  let expiry;
  const blocked = new ChimePlayer({ AudioContext: BlockedContext,
    setTimer: fn => { expiry = fn; return 1; }, clearTimer() {} });
  const resumed = blocked.enableFromGesture();
  expiry();
  assert.equal(await resumed, false);
  assert.equal(blocked.status, "blocked");
  assert.equal((await blocked.play("failure")).status, "blocked");
  blocked.destroy();

  const player = new ChimePlayer({ AudioContext: AudioContextFixture });
  await player.enableFromGesture();
  const playing = player.play("failure");
  player.stop();
  assert.equal((await playing).status, "blocked");
  assert.equal(player.voices.size, 0);
  player.destroy();
});

test("default audio and delivery timers preserve the browser Window receiver", async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let calls = 0;
  globalThis.setTimeout = function (...arguments_) {
    assert.equal(this, globalThis, "Firefox rejects an unbound Window.setTimeout method");
    calls++;
    return originalSet(...arguments_);
  };
  globalThis.clearTimeout = function (handle) {
    assert.equal(this, globalThis, "Firefox rejects an unbound Window.clearTimeout method");
    return originalClear(handle);
  };
  const player = new ChimePlayer({ AudioContext: AudioContextFixture });
  const delivery = new NotificationDelivery({ player, api: async () => ({ claimId: null }) });
  try {
    await player.enableFromGesture();
    delivery.update({ settings: { soundEnabled: true }, events: [{ delivery: { status: "pending" } }] });
    assert.ok(calls >= 2, "audio-resume timeout and delivery debounce both use safe wrappers");
    delivery.destroy(); player.destroy();
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});

function deliveryFixture({ request = () => null, playerOverrides = {} } = {}) {
  const requests = [], states = [], messages = [];
  const player = {
    ready: () => true, plays: [], stop() {},
    async play(sound, volume) { this.plays.push({ sound, volume }); return { status: "played", reason: "test" }; },
    ...playerOverrides
  };
  const delivery = new NotificationDelivery({ clientId: "client-a", player,
    api: async (path, options) => {
      const body = JSON.parse(options.body);
      requests.push({ path, body });
      const override = request(path, body);
      if (override) return override;
      if (path.endsWith("/claim")) return { claimId: "claim-1", events: [{ id: "event-1" }], sound: "failure" };
      if (path.endsWith("/begin")) return { ok: true, sound: "failure" };
      return { revision: 2, events: [] };
    },
    onChange: next => states.push(next), onStatus: value => messages.push(value),
    setTimer: () => 1, clearTimer() {}
  });
  delivery.update({ settings: { soundEnabled: true, volume: 0.3 },
    events: [{ id: "event-1", delivery: { status: "pending" } }] });
  return { delivery, player, requests, states, messages };
}

test("delivery claims then durably begins before one chime and acknowledgement", async () => {
  const fixture = deliveryFixture();
  await fixture.delivery.deliver();
  assert.deepEqual(fixture.requests.map(request => request.path), [
    "/api/notifications/claim", "/api/notifications/begin", "/api/notifications/ack"
  ]);
  assert.deepEqual(fixture.player.plays, [{ sound: "failure", volume: 0.3 }]);
  assert.equal(fixture.requests[2].body.status, "played");
  assert.equal(fixture.states.length, 1);
});

test("overlapping updates cannot race two claims or play concurrent sounds", async () => {
  const pending = gate();
  const fixture = deliveryFixture({ request: path => path.endsWith("/claim") ? pending.promise : null });
  const first = fixture.delivery.deliver();
  await fixture.delivery.deliver();
  await fixture.delivery.deliver();
  assert.equal(fixture.requests.length, 1);
  pending.resolve({ claimId: "claim-1", events: [{ id: "event-1" }], sound: "failure" });
  await first;
  assert.equal(fixture.player.plays.length, 1);
});

test("a lost begin response never guesses it may play", async () => {
  const fixture = deliveryFixture({ request: path => path.endsWith("/begin") ? Promise.reject(new Error("offline")) : null });
  await fixture.delivery.deliver();
  assert.equal(fixture.player.plays.length, 0);
  assert.equal(fixture.requests.length, 2);
  assert.match(fixture.messages.at(-1), /offline or uncertain/);
});

test("lost acknowledgement retries acknowledgement without replaying the event", async () => {
  let acknowledgements = 0, claims = 0;
  const fixture = deliveryFixture({ request: path => {
    if (path.endsWith("/ack") && ++acknowledgements === 1) return Promise.reject(new Error("offline"));
    if (path.endsWith("/claim") && ++claims > 1) return { claimId: null, events: [], sound: null };
    return null;
  } });
  await fixture.delivery.deliver();
  assert.equal(fixture.player.plays.length, 1);
  assert.equal(fixture.delivery.pendingAcks.size, 1);
  await fixture.delivery.deliver();
  assert.equal(fixture.player.plays.length, 1);
  assert.equal(fixture.delivery.pendingAcks.size, 0);
  assert.equal(acknowledgements, 2);
});

test("mute, zero volume, blocked browser and preview prevent a delivery claim", async () => {
  for (const settings of [{ soundEnabled: false }, { soundEnabled: true, muted: true }, { soundEnabled: true, volume: 0 }]) {
    const fixture = deliveryFixture();
    fixture.delivery.update({ settings, events: [] });
    await fixture.delivery.deliver();
    assert.equal(fixture.requests.length, 0);
  }
  for (const playerOverrides of [{ ready: () => false }, { playing: () => {} }]) {
    const fixture = deliveryFixture({ playerOverrides });
    await fixture.delivery.deliver();
    assert.equal(fixture.requests.length, 0);
  }
});

test("mute after claim leaves an unbegun lease recoverable and mute after begin records blocked", async () => {
  const claimed = gate();
  const fixture = deliveryFixture({ request: path => path.endsWith("/claim") ? claimed.promise : null });
  const first = fixture.delivery.deliver();
  fixture.delivery.update({ settings: { soundEnabled: true, muted: true }, events: [] });
  claimed.resolve({ claimId: "claim-1", events: [{ id: "event-1" }], sound: "success" });
  await first;
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.player.plays.length, 0);

  const begun = gate();
  const second = deliveryFixture({ request: path => path.endsWith("/begin") ? begun.promise : null });
  const running = second.delivery.deliver();
  await turn();
  second.delivery.update({ settings: { soundEnabled: false }, events: [] });
  begun.resolve({ ok: true, sound: "success" });
  await running;
  assert.equal(second.player.plays.length, 0);
  assert.equal(second.requests.at(-1).body.status, "blocked");
});
