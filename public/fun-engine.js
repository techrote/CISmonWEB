import { hashRunId, illustrativeCoherence, summarizeFunRows } from "/fun-core.js";

// Render-only apparatus. It never alters source monitoring data or issue acknowledgement.
const TAU = Math.PI * 2;
const noop = () => {};
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const ease = (t) => t * t * (3 - 2 * t);
const activeColor = (row) =>
  row.state === "in_progress" ? "#5ce5d5" :
  row.state === "queued" ? "#e8be68" :
  row.attention === "action_required" ? "#d86f69" :
  row.attention === "suspicious" ? "#e3a364" : "#7ba4ad";

function seededNoise(index, seed) {
  let x = (index ^ seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return ((x ^ (x >>> 16)) >>> 0) / 0x100000000;
}

function countsAsRows(rows) {
  return summarizeFunRows(rows);
}

export function createFunEngine(canvas, layout, onChange = noop) {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return {
    mount: noop, update: noop, destroy: noop, pause: noop, reseed: noop,
    exportPng: noop, get paused() { return true; }
  };

  let width = 1, height = 1, dpr = 1, raf = 0, previousFrameMs = 0;
  let seed = hashRunId(Date.now() + ":" + layout), time = 0;
  let paused = false, disposed = false, mounted = false, inside = false;
  let held = false, lastPointer = null, motion = "normal", reactivity = 50;
  let rows = [], transitions = [];
  let lastDrawMs = -Infinity;
  let resizeObserver = null;
  const reducedMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = reducedMedia.matches;
  let wave = new Float32Array(96 * 60);
  let velocity = new Float32Array(96 * 60);
  const cols = 96, lines = 60;
  const responses = Array.from({ length: 4 }, () => new Float32Array(80));
  const hunger = Array.from({ length: 4 }, () => new Float32Array(80));
  let energy = 0, pointer = { x: 0.5, y: 0.5 };
  let impulses = [];

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(100, Math.round(rect.width || 800));
    const h = Math.max(140, Math.round(rect.height || 500));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.4);
    if (w === width && h === height && dpr === pixelRatio) return;
    width = w;
    height = h;
    dpr = pixelRatio;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  function drawGrid(step, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = 0; x < width; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
    for (let y = 0; y < height; y += step) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
    ctx.stroke();
  }

  function base(color) {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
  }

  function linescan(alpha = 0.1) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#000";
    for (let y = 1; y < height; y += 4) ctx.fillRect(0, y, width, 1);
    ctx.globalAlpha = 1;
  }

  function drawSignal() {
    base("#03080e");
    const glow = ctx.createRadialGradient(width * .5, height * .55, 0, width * .5, height * .55, width * .7);
    glow.addColorStop(0, "#0e2940");
    glow.addColorStop(.65, "#071522");
    glow.addColorStop(1, "#020408");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    drawGrid(32, "#24516a35");

    const data = rows.slice(0, 32);
    const count = Math.max(1, data.length);
    const left = Math.min(105, width * .1);
    const right = width - left;
    const zone = height * .72;
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const id = hashRunId(row.repository + "#" + row.runId);
      const center = height * .15 + ((i + .5) / count) * zone;
      const frequency = 1.8 + (id % 7) * .37;
      const amplitude = (row.state === "in_progress" ? 10 : row.state === "queued" ? 5 : 2.4) *
        Math.max(.3, Math.min(2, height / 600));
      const pulse = row.state === "in_progress" ? (1 + .2 * Math.sin(time * 2.1 + i)) : 1;

      ctx.beginPath();
      for (let n = 0; n <= 160; n++) {
        const u = n / 160;
        const x = left + (right - left) * u;
        const carrier = Math.sin((u * frequency * TAU) + time * .62 + id * .001);
        const modulation = Math.sin(u * 36 + time * 1.4 + id * .003) * .28;
        const y = center + (carrier + modulation) * amplitude * pulse;
        if (!n) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = activeColor(row);
      ctx.globalAlpha = row.state === "completed" ? .24 : .67;
      ctx.lineWidth = row.state === "in_progress" ? 1.8 : .85;
      ctx.stroke();

      const dot = (time * (row.state === "in_progress" ? .105 : .035) + seededNoise(id, seed)) % 1;
      const x = left + dot * (right - left);
      ctx.fillStyle = activeColor(row);
      ctx.globalAlpha = row.state === "completed" ? .16 : .8;
      ctx.fillRect(x - 2, center - 2, 4, 4);
    }

    ctx.globalAlpha = .32;
    ctx.strokeStyle = "#80bed5";
    ctx.lineWidth = .7;
    ctx.beginPath();
    ctx.moveTo(left, height * .12);
    ctx.lineTo(left, height * .9);
    ctx.lineTo(right, height * .9);
    ctx.stroke();
    ctx.globalAlpha = 1;
    linescan();
  }

  function drawAfterimage() {
    base("#060a10");
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, "#152b34");
    grad.addColorStop(.4, "#07101a");
    grad.addColorStop(1, "#05060a");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    drawGrid(42, "#48798c18");

    // Each echo corresponds to a real status change seen in this browser.
    for (const event of transitions.slice(-64)) {
      const age = Math.max(0, time * 1000 - event.visualTimeMs);
      if (age > 40000) continue;
      const id = hashRunId(event.id);
      const x = width * (.08 + seededNoise(id + 17, seed) * .84);
      const y = height * (.1 + seededNoise(id + 79, seed) * .78);
      const alpha = Math.max(0, .48 * (1 - age / 40000));
      ctx.strokeStyle = event.to === "failure" || event.to === "timed_out" ? "#f09286" : "#8ee9d2";
      ctx.lineWidth = .8;
      for (let k = 0; k < 4; k++) {
        const radius = 7 + k * 12 + age * .00025;
        ctx.globalAlpha = alpha * (1 - k * .18);
        ctx.strokeRect(x - radius, y - radius * .5, radius * 2, radius);
      }
      ctx.globalAlpha = alpha;
      ctx.font = "10px monospace";
      ctx.fillText(event.from.toUpperCase() + " > " + event.to.toUpperCase(), x + 10, y - 35);
    }

    for (let i = 0; i < Math.min(40, rows.length); i++) {
      const row = rows[i], id = hashRunId(row.repository + ":" + row.runId);
      const x = seededNoise(id, seed) * width;
      const y = seededNoise(id + 1, seed) * height;
      const shift = Math.sin(time * .24 + i) * 15;
      ctx.strokeStyle = activeColor(row);
      ctx.globalAlpha = row.state === "completed" ? .1 : .25;
      for (let j = 0; j < 3; j++) {
        ctx.strokeRect(x + shift * (j + 1), y, 38 + j * 8, 12 + j * 8);
      }
    }
    ctx.globalAlpha = 1;
    linescan(.09);
  }

  function drawLanes() {
    base("#070c10");
    drawGrid(44, "#24443726");
    const n = Math.max(1, Math.min(rows.length, 80));
    for (let i = 0; i < n; i++) {
      const row = rows[i];
      const id = hashRunId(row.repository);
      const x = width * (.08 + seededNoise(id, seed) * .84);
      const y = height * (.1 + seededNoise(id + i * 19, seed) * .8);
      const pulse = row.state === "in_progress" ? Math.sin(time * 1.5 + i) * 6 : 0;
      ctx.strokeStyle = activeColor(row);
      ctx.globalAlpha = row.state === "completed" ? .13 : .32;
      ctx.lineWidth = row.state === "in_progress" ? 1.2 : .5;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, 4 + pulse), 0, TAU);
      ctx.stroke();
      ctx.fillStyle = activeColor(row);
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
    linescan(.07);
  }

  function pulseWave(x, y, strength) {
    const cx = Math.floor(clamp(x) * (cols - 1));
    const cy = Math.floor(clamp(y) * (lines - 1));
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
      const px = cx + i, py = cy + j;
      if (px < 1 || px >= cols - 1 || py < 1 || py >= lines - 1) continue;
      velocity[py * cols + px] += strength / (1 + i * i + j * j);
    }
    energy = clamp(energy + strength * .06);
  }

  function updateWave(dt) {
    if (!dt) return;
    const damping = Math.pow(.97, dt * 30);
    const rate = .14;
    for (let y = 1; y < lines - 1; y++) for (let x = 1; x < cols - 1; x++) {
      const i = y * cols + x;
      const lap = wave[i - 1] + wave[i + 1] + wave[i - cols] + wave[i + cols] - 4 * wave[i];
      velocity[i] = (velocity[i] + lap * rate) * damping;
    }
    for (let i = 0; i < wave.length; i++) wave[i] = clamp((wave[i] + velocity[i]) * .999, -16, 16);
    energy *= Math.exp(-dt * 1.2);
  }

  function drawHungry() {
    base("#050906");
    const counts = countsAsRows(rows);
    const coherence = illustrativeCoherence(rows);
    const severity = clamp((100 - coherence) / 90);
    const grad = ctx.createRadialGradient(width * .49, height * .47, height * .05, width * .5, height * .5, Math.max(width, height) * .8);
    grad.addColorStop(0, "#1b281d");
    grad.addColorStop(.58, "#08110c");
    grad.addColorStop(1, "#020402");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Oxidised fine strata and a submerged, reversible pressure field.
    const detail = motion === "off" ? 0 : 1;
    for (let band = 0; band < 26; band++) {
      const q = (band + .5) / 26;
      const cy = q * height;
      ctx.strokeStyle = band % 4 === 0 ? "#9e997259" : "#697b492e";
      ctx.globalAlpha = .32 + energy * .16;
      ctx.lineWidth = band % 4 === 0 ? 1.1 : .55;
      ctx.beginPath();
      for (let n = 0; n <= 80; n++) {
        const x = n / 80 * width;
        const yi = clamp(Math.floor(q * lines), 0, lines - 1);
        const xi = clamp(Math.floor(n / 80 * cols), 0, cols - 1);
        const displacement = wave[yi * cols + xi] * Math.min(2.8, height / 260);
        const y = cy + Math.sin(n * .092 + band * .47 + time * .1 * detail) * 6 + displacement;
        if (!n) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Three concentric broken seals are inherited from the artwork's reliquary.
    const rBase = Math.min(width, height);
    ctx.save();
    ctx.translate(width * .5, height * .5);
    for (let ring = 0; ring < 3; ring++) {
      const radius = rBase * (.22 + ring * .065);
      ctx.lineWidth = ring === 1 ? 1.4 : .6;
      ctx.strokeStyle = ring === 1 ? "#a99661" : "#87977b";
      for (let section = 0; section < 22; section++) {
        if (seededNoise(section + ring * 173, seed) > .78) continue;
        const start = section / 22 * TAU + time * .002 * (ring - 1);
        ctx.globalAlpha = .09 + seededNoise(section + 801, seed) * .09;
        ctx.beginPath();
        ctx.arc(0, 0, radius, start, start + .15);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Living edge: pressure and time push inward. Near-edge pointer contact causes
    // a local flinch; slower 'hunger' returns thereafter, recording contact.
    const react = reactivity / 100;
    const intrude = .055 + severity * .055 + (counts.queued + counts.running) / Math.max(rows.length, 1) * .02;
    for (let side = 0; side < 4; side++) {
      const points = 80;
      ctx.beginPath();
      if (side === 0) ctx.moveTo(0, 0);
      if (side === 1) ctx.moveTo(width, 0);
      if (side === 2) ctx.moveTo(0, 0);
      if (side === 3) ctx.moveTo(0, height);
      for (let n = 0; n < points; n++) {
        const q = n / (points - 1);
        const idx = n;
        const rip = .009 * Math.sin(q * 37 + side * 1.4 + time * .42 * detail) +
          .006 * Math.sin(q * 91 - side * 2.7 - time * .35 * detail);
        const retract = responses[side][idx];
        const edge = clamp(intrude + rip + hunger[side][idx] - retract, .018, .19);
        const x = side === 0 ? edge * width :
          side === 1 ? (1 - edge) * width : q * width;
        const y = side === 2 ? edge * height :
          side === 3 ? (1 - edge) * height : q * height;
        ctx.lineTo(x, y);
      }
      if (side === 0) { ctx.lineTo(0, height); ctx.closePath(); }
      if (side === 1) { ctx.lineTo(width, height); ctx.closePath(); }
      if (side === 2) { ctx.lineTo(width, 0); ctx.closePath(); }
      if (side === 3) { ctx.lineTo(width, height); ctx.closePath(); }
      ctx.fillStyle = side % 2 ? "#020503" : "#030703";
      ctx.globalAlpha = .93;
      ctx.fill();
      ctx.strokeStyle = side % 2 ? "#66703c" : "#92905a";
      ctx.globalAlpha = .24 + severity * .11;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Archived ash; deterministic, restrained, and reproducible for a seed.
    const scatter = Math.min(120, Math.floor(70 + 50 * severity));
    for (let i = 0; i < scatter; i++) {
      const x = ((seededNoise(i * 23, seed) + time * .0006 * detail * (1 + i % 3)) % 1) * width;
      const y = ((seededNoise(i * 71 + 3, seed) + time * .0012 * detail * (1 + i % 4)) % 1) * height;
      ctx.fillStyle = i % 5 === 0 ? "#8c563b" : "#aaad79";
      ctx.globalAlpha = .05 + seededNoise(i * 7, seed) * .12;
      ctx.fillRect(x, y, 1.4, 1);
    }
    // Contamination sites only arise from actual pointer interactions.
    for (const dot of impulses) {
      const age = time - dot.at;
      if (age > 22) continue;
      const alpha = (1 - age / 22) * .32;
      const x = dot.x * width, y = dot.y * height;
      ctx.strokeStyle = "#b5b76b";
      ctx.globalAlpha = alpha;
      ctx.lineWidth = .5;
      ctx.beginPath();
      ctx.ellipse(x, y, 1 + age * .8, 1 + age * .4, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    linescan(.08);
  }

  function evolveEdges(dt) {
    if (!dt) return;
    const reactivityFactor = reactivity / 100;
    for (let side = 0; side < 4; side++) {
      const arr = responses[side], mem = hunger[side];
      for (let i = 0; i < arr.length; i++) {
        const q = i / (arr.length - 1);
        const depth = side === 0 ? pointer.x : side === 1 ? 1 - pointer.x :
          side === 2 ? pointer.y : 1 - pointer.y;
        const along = side < 2 ? pointer.y : pointer.x;
        const near = inside ? Math.exp(-Math.pow((q - along) / .08, 2)) *
          Math.exp(-Math.pow(depth / .17, 2)) : 0;
        const target = near * reactivityFactor * .13;
        arr[i] += (target - arr[i]) * (1 - Math.exp(-dt * (target > arr[i] ? 18 : 1.4)));
        mem[i] = clamp(mem[i] + near * dt * .005 - dt * .0005, 0, .018);
      }
    }
  }

  function render() {
    if (disposed || !mounted) return;
    ctx.save();
    if (layout === "signal") drawSignal();
    else if (layout === "afterimage") drawAfterimage();
    else if (layout === "lanes_plus") drawLanes();
    else if (layout === "hungry_margins") drawHungry();
    ctx.restore();
  }

  function frame(now) {
    raf = 0;
    if (disposed || document.hidden || !canvas.isConnected || paused || reduced || motion === "off") return;
    const dt = Math.min(.045, Math.max(0, (now - (previousFrameMs || now)) / 1000));
    previousFrameMs = now;
    const speed = motion === "subtle" ? .35 : motion === "intense" ? 1.5 : 1;
    time += dt * speed;
    if (layout === "hungry_margins") {
      tickInteractions();
      updateWave(dt);
      evolveEdges(dt);
    }
    impulses = impulses.filter((p) => time - p.at < 22);
    transitions = transitions.filter((p) => time * 1000 - p.visualTimeMs < 40000);
    if (now - lastDrawMs >= 32) {
      render();
      lastDrawMs = now;
    }
    schedule();
  }

  function schedule() {
    if (raf || disposed || !mounted || paused || reduced || motion === "off" || document.hidden) return;
    raf = requestAnimationFrame(frame);
  }

  function pointerMove(event) {
    const rect = canvas.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / Math.max(1, rect.width));
    const y = clamp((event.clientY - rect.top) / Math.max(1, rect.height));
    const distance = lastPointer ? Math.hypot(x - lastPointer.x, y - lastPointer.y) : 0;
    lastPointer = { x, y };
    pointer = { x, y };
    inside = true;
    if (layout === "hungry_margins" && distance > .001) {
      const steps = Math.min(12, Math.ceil(distance * 80));
      for (let i = 0; i < steps; i++) pulseWave(x, y, Math.min(6, (1 + distance * 200) * reactivity / 100) / steps);
      impulses.push({ x, y, at: time });
      if (impulses.length > 80) impulses.shift();
    }
    if (paused || reduced || motion === "off") render();
  }

  function pointerDown(event) {
    if (!event.isPrimary || event.button !== 0) return;
    held = true;
    pointerMove(event);
    if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
  }

  function pointerUp(event) {
    held = false;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }

  function tickInteractions() {
    if (!held || layout !== "hungry_margins") return;
    pulseWave(pointer.x, pointer.y, .65 * reactivity / 100);
  }

  function onVisibility() {
    previousFrameMs = 0;
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else {
      render();
      schedule();
    }
  }

  function onReduced(event) {
    reduced = event.matches;
    onVisibility();
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerUp);
    canvas.addEventListener("pointerleave", () => { inside = false; lastPointer = null; });
    document.addEventListener("visibilitychange", onVisibility);
    reducedMedia.addEventListener?.("change", onReduced);
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();
    render();
    schedule();
  }

  function update(nextRows, surface, nextTransitions = []) {
    rows = nextRows;
    motion = surface.motion || "normal";
    reactivity = Number(surface.reactivity ?? 50);
    for (const event of nextTransitions) {
      transitions.push({ ...event, visualTimeMs: time * 1000 });
    }
    if (transitions.length > 100) transitions = transitions.slice(-100);
    if (paused || reduced || motion === "off") render();
    else schedule();
    onChange(paused || reduced || motion === "off");
  }

  function pause(nextValue) {
    paused = Boolean(nextValue);
    previousFrameMs = 0;
    if (paused) {
      cancelAnimationFrame(raf);
      raf = 0;
      render();
    } else schedule();
    onChange(paused);
  }

  function reseed() {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    seed = buf[0];
    time = 0;
    energy = 0;
    wave.fill(0);
    velocity.fill(0);
    responses.forEach((a) => a.fill(0));
    hunger.forEach((a) => a.fill(0));
    impulses = [];
    transitions = [];
    render();
  }

  function exportPng() {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "cismon-" + layout.replaceAll("_", "-") + "-" + seed.toString(16) + ".png";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, "image/png");
  }

  function destroy() {
    disposed = true;
    cancelAnimationFrame(raf);
    raf = 0;
    resizeObserver?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    reducedMedia.removeEventListener?.("change", onReduced);
    canvas.removeEventListener("pointermove", pointerMove);
    canvas.removeEventListener("pointerdown", pointerDown);
    canvas.removeEventListener("pointerup", pointerUp);
    canvas.removeEventListener("pointercancel", pointerUp);
  }

  return {
    mount, update, destroy, pause, reseed, exportPng,
    get paused() { return paused; },
    get reduced() { return reduced; },
    get time() { return time; }
  };
}
