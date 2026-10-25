import {
  HUNGRY_PROTOCOL,
  hungryAnchor,
  hungryAmbientEvents,
  hungryIdleStrokes,
  hungryTransitionPulses,
  projectHungryCI
} from "/hungry-ci.js";

// Owns a single opaque-origin iframe. Only aggregate counts, normalized states,
// positions, and artwork-only commands cross this boundary. No GitHub token,
// repository name, workflow label, API request or storage access enters the art.
export function createHungryFrameEngine(iframe, onChange = () => {}) {
  const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = reducedQuery.matches;
  let ready = false, mounted = false, destroyed = false, paused = false;
  let surface = { motion: "normal", reactivity: 75 };
  let scene = projectHungryCI([]);
  let queuedPulses = [];
  let tick = 0, startAt = performance.now(), lastAmbient = 0;
  let interval = 0;

  function post(type, payload) {
    if (!ready || destroyed || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage({ protocol: HUNGRY_PROTOCOL, type, payload }, "*");
  }

  function active() {
    return !destroyed && mounted && ready && !paused && !reduced &&
      surface.motion !== "off" && !document.hidden;
  }

  function pauseActual() {
    post("pause", { paused: paused || reduced || surface.motion === "off" || document.hidden });
    onChange(paused || reduced || surface.motion === "off");
  }

  function updateScene() {
    post("scene", scene);
    while (ready && queuedPulses.length) {
      post("pulse", queuedPulses.shift());
    }
  }

  function idle() {
    if (!active()) return;
    tick++;
    const t = (performance.now() - startAt) / 1000;
    const strokes = hungryIdleStrokes(scene, t, surface.motion, surface.reactivity);
    // The original has one memory-bearing pointer, not two independent brush
    // heads. Time-slice the edge feeder and centre slug in long arcs instead
    // of teleporting between them on every frame.
    const brush = strokes[Math.floor(t / 3.2) % Math.max(strokes.length, 1)];
    if (brush && brush.force > .001) post("stroke", brush);
    if (performance.now() - lastAmbient >= 1200) {
      lastAmbient = performance.now();
      const ambient = hungryAmbientEvents(scene, Math.floor(t / 1.2));
      for (const impulse of ambient) {
        post("pulse", { ...impulse, force: impulse.force * surface.reactivity / 100 });
      }
    }
  }

  function onMessage(event) {
    // Sandbox documents have an opaque origin; verifying the exact child
    // WindowProxy plus protocol is essential.
    if (event.source !== iframe.contentWindow || !event.data ||
        event.data.protocol !== HUNGRY_PROTOCOL) return;
    if (event.data.type === "ready") {
      if (event.data.generation !== 37) return;
      ready = true;
      updateScene();
      pauseActual();
      if (active()) idle();
    } else if (event.data.type === "capture" && event.data.blob instanceof Blob) {
      const blob = event.data.blob;
      if (blob.type !== "image/png" || blob.size > 25_000_000) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "cismon-037-hungry-margins-original.png";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  }

  function onVisibility() {
    pauseActual();
    if (active()) idle();
  }

  function onReduced(event) {
    reduced = event.matches;
    pauseActual();
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("title", "Original 037 Hungry Margins interactive art, driven by live CI");
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisibility);
    reducedQuery.addEventListener?.("change", onReduced);
    iframe.src = "/art/hungry-frame";
    // Small, independently bounded creative-control clock; GitHub API polling
    // remains governed only by the Monitor's existing scheduler.
    interval = window.setInterval(idle, 200);
  }

  function update(rows, nextSurface, changes = [], monitorState = null) {
    surface = nextSurface || surface;
    // All dashboard candidates drive the background; surface filters/item caps
    // only select the HTML run list displayed above the original artwork.
    const all = Array.isArray(monitorState?.rows) ? monitorState.rows : rows;
    scene = projectHungryCI(all);
    if (Number.isInteger(monitorState?.trackedActiveCount)) {
      scene.counts.running = monitorState.trackedActiveCount;
    }
    if (Number.isInteger(monitorState?.trackedQueuedCount)) {
      scene.counts.queued = monitorState.trackedQueuedCount;
    }
    const liveTotal = scene.counts.running + scene.counts.queued;
    scene.queuePressure = Math.min(1, scene.counts.queued / (liveTotal + 3) * 1.5);
    queuedPulses.push(...hungryTransitionPulses(changes));
    queuedPulses = queuedPulses.slice(-48);
    updateScene();
    pauseActual();
  }

  function focus(row) {
    if (!active()) return;
    const { x, y } = hungryAnchor(row);
    const kind = row.possiblyStalled ? "stall" :
      row.state === "in_progress" ? "ignite" :
      row.state === "queued" ? "queue" :
      row.attention === "action_required" ? "scar" : "shift";
    post("pulse", { x, y, force: .36, kind });
  }

  function pause(next) {
    paused = Boolean(next);
    pauseActual();
  }

  function reseed() {
    startAt = performance.now();
    tick = 0;
    queuedPulses = [];
    post("reseed", {});
    updateScene();
  }

  function exportPng() {
    post("capture", {});
  }

  function destroy() {
    destroyed = true;
    ready = false;
    window.clearInterval(interval);
    window.removeEventListener("message", onMessage);
    document.removeEventListener("visibilitychange", onVisibility);
    reducedQuery.removeEventListener?.("change", onReduced);
    // Release the original 037 animation loop with the iframe itself.
    iframe.removeAttribute("src");
  }

  return {
    mount, update, focus, pause, reseed, exportPng, destroy,
    get paused() { return paused; },
    get reduced() { return reduced; },
    get time() { return (performance.now() - startAt) / 1000; }
  };
}
