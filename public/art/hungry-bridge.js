// Appended to the original 037 HTML by the local server. This is the only
// mutation point: the vendored artwork itself is preserved as source material.
(() => {
  "use strict";
  const PROTOCOL = "cismon-hungry-v1";
  const E = window.Decay;
  if (!E || !E.canvas || typeof E.draw !== "function") return;
  const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, Number.isFinite(v) ? v : 0));
  let lastRealPointerAt = -Infinity;
  let scene = null;
  const seededScars = new Set();
  let quietScars = [];
  let brushSteps = 0;
  let consentedPaused = E.paused;

  // Native mouse/touch still drives the actual original handlers. We avoid
  // overwriting a person's brush for three seconds after their last input.
  E.canvas.addEventListener("pointermove", () => {
    lastRealPointerAt = performance.now();
  }, { passive: true });
  E.canvas.addEventListener("pointerdown", () => {
    lastRealPointerAt = performance.now();
  }, { passive: true });

  function available() {
    return performance.now() - lastRealPointerAt > 3000;
  }

  function drawIfPaused() {
    if (E.paused) E.draw();
  }

  function virtualBrush(input) {
    if (!available() || E.paused || !input || typeof input !== "object") return;
    const x = clamp(Number(input.x)), y = clamp(Number(input.y));
    const p = E.pointer;
    const distance = Math.hypot(x - p.x, y - p.y);
    const force = clamp(Number(input.force) || 0, 0, 2);
    p.px = p.x;
    p.py = p.y;
    p.x = x;
    p.y = y;
    p.speed = Math.min(5, p.speed + distance * 12 + force * .16);
    E.held = Boolean(input.held);
    E.inside = false; // Do not invent a real mouse cursor or coordinate tooltip.

    // Run the actual 037 callbacks: resonance, slug, contamination and
    // hungry margin contacts, not a substitute rendering implementation.
    const inducedDistance = clamp(distance * (.55 + force), .002, .095);
    E.infect(x, y, force * .18);
    for (const effect of E.inputs) {
      try { effect(E, { isPrimary: true, pointerId: -1, syntheticVisual: true }, inducedDistance); }
      catch (error) { /* keep the rest of the art responsive */ }
    }
  }

  function soften(x, y, strength) {
    // A successful observed transition produces a localized release, not a
    // historically invented failure or a full specimen reset.
    const cx = Math.floor(x * E.cols);
    const cy = Math.floor(y * E.rows);
    for (let oy = -4; oy <= 4; oy++) for (let ox = -4; ox <= 4; ox++) {
      const xx = cx + ox, yy = cy + oy;
      if (xx < 0 || yy < 0 || xx >= E.cols || yy >= E.rows) continue;
      const index = yy * E.cols + xx;
      const weight = Math.exp(-(ox * ox + oy * oy) / 11);
      E.grid[index] = Math.max(0, E.grid[index] * (1 - strength * .7 * weight));
    }
    E.level = clamp(E.level - strength * .015);
  }

  function pulse(input) {
    if (E.paused || !input || typeof input !== "object") return;
    const x = clamp(Number(input.x)), y = clamp(Number(input.y));
    const kind = String(input.kind || "shift").slice(0, 24);
    const force = clamp(Number(input.force) || 0, 0, 1.5);
    if (kind === "release" || kind === "settle") {
      soften(x, y, Math.max(.25, force));
      virtualBrush({ x, y, force: force * .3, held: false });
    } else if (kind === "scar") {
      E.level = clamp(E.level + .017 * force);
      virtualBrush({ x, y, force: force * 1.5, held: true });
      E.infect(x, y, force);
      E.held = false;
    } else if (kind === "stall") {
      E.level = clamp(E.level + .006);
      virtualBrush({ x, y, force: Math.min(1.3, force * 1.35), held: true });
      E.held = false;
    } else {
      virtualBrush({ x, y, force, held: kind === "ignite" });
      E.held = false;
    }
  }

  function setScene(input) {
    if (!input || typeof input !== "object") return;
    scene = input;
    // Existing failed workflows leave one subtle initial deposit each. This
    // is a current-state visual marker, NOT an invented failure transition.
    for (const anchor of (Array.isArray(input.anchors) ? input.anchors : []).slice(0, 48)) {
      if (!anchor || typeof anchor !== "object") continue;
      const status = String(anchor.status || "");
      if (!["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(status)) continue;
      const id = String(anchor.hash);
      if (seededScars.has(id)) continue;
      seededScars.add(id);
      E.infect(clamp(Number(anchor.x)), clamp(Number(anchor.y)), .12);
      if (quietScars.length < 12) quietScars.push({
        x: clamp(Number(anchor.x)),
        y: clamp(Number(anchor.y)),
        force: .08, held: false
      });
    }
    const queue = clamp(Number(input.queuePressure));
    const fail = clamp(Number(input.failurePressure));
    const stalls = clamp(Number(input.stallPressure));
    const active = clamp(Number(input.activity));
    const target = .43 + queue * .085 + fail * .045 + stalls * .055 + active * .02;
    E.level = clamp(E.level * .94 + target * .06, .12, .86);
  }

  function setPaused(value) {
    consentedPaused = Boolean(value);
    E.held = false;
    if (E.paused !== consentedPaused) {
      document.getElementById("pause")?.click();
    }
  }

  function exportCanvas() {
    E.canvas.toBlob((blob) => {
      if (blob) window.parent.postMessage({ protocol: PROTOCOL, type: "capture", blob }, "*");
    }, "image/png");
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !event.data ||
        event.data.protocol !== PROTOCOL) return;
    const { type, payload } = event.data;
    switch (type) {
      case "scene": setScene(payload); break;
      case "stroke":
        virtualBrush(payload);
        // Paint a sparse, current-state failure sediment through the *actual*
        // 037 input callbacks. Do not announce these as new failure events.
        if (available() && quietScars.length && (++brushSteps % 6 === 0)) {
          virtualBrush(quietScars.shift());
          E.held = false;
        }
        break;
      case "pulse": pulse(payload); break;
      case "pause": setPaused(payload?.paused); break;
      case "reseed":
        document.getElementById("reset")?.click();
        seededScars.clear();
        quietScars = [];
        brushSteps = 0;
        if (scene) setScene(scene);
        break;
      case "capture": exportCanvas(); break;
      default: break;
    }
    drawIfPaused();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) E.held = false;
  });
  window.parent.postMessage({
    protocol: PROTOCOL,
    type: "ready",
    generation: E.generation,
    original: "037-hungry-margins3.html"
  }, "*");
})();
