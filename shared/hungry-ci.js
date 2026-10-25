import { hashRunId, runIdentity, summarizeFunRows } from "./fun-core.js";

export const HUNGRY_PROTOCOL = "cismon-hungry-v1";
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, Number.isFinite(x) ? x : 0));
const ACTIVE = new Set(["in_progress", "queued"]);
const FAILURES = new Set(["failure", "timed_out", "action_required", "startup_failure", "stale"]);
const TAU = Math.PI * 2;

export function hungryAnchor(rowOrId) {
  const id = typeof rowOrId === "string" ? rowOrId : runIdentity(rowOrId);
  const a = hashRunId(id);
  const b = hashRunId(id + "/salt");
  return {
    x: .16 + (a / 4294967296) * .68,
    y: .17 + (b / 4294967296) * .66,
    hash: a
  };
}

// Snapshot → expressive controls, not a health score. Never send raw repo names,
// tokens or workflow metadata into the isolated artwork frame.
export function projectHungryCI(rows, maxAnchors = 36) {
  const all = Array.isArray(rows) ? rows : [];
  const counts = summarizeFunRows(all);
  const stalled = all.filter(row => row.possiblyStalled).length;
  const recentSuccess = counts.success;
  const live = counts.running + counts.queued;
  const queuePressure = clamp(counts.queued / (live + 3) * 1.5);
  const failurePressure = clamp(counts.failures / (all.length + 3) * 1.2);
  const stallPressure = clamp(stalled / (counts.running + 2));
  const activity = clamp(.16 + .1 * Math.sqrt(counts.running) + .05 * Math.sqrt(counts.queued) + .045 * Math.sqrt(counts.failures));
  const ranked = [...all].sort((a, b) => {
    const score = r => r.state === "in_progress" ? 4 : r.state === "queued" ? 3 :
      FAILURES.has(r.conclusion) ? 2 : r.possiblyStalled ? 1 : 0;
    return score(b) - score(a);
  });
  const anchors = ranked.slice(0, clamp(Math.round(maxAnchors), 1, 64)).map(row => {
    const { x, y, hash } = hungryAnchor(row);
    return {
      x, y, hash,
      status: row.state === "completed" ? row.conclusion : row.state,
      stalled: !!row.possiblyStalled,
      ratio: clamp(Number(row.ratio) || 0, 0, 25)
    };
  });
  return {
    counts: { running: counts.running, queued: counts.queued, failed: counts.failures, success: recentSuccess, stalled, total: counts.total },
    queuePressure,
    failurePressure,
    stallPressure,
    activity,
    anchors
  };
}

export function hungryTransitionPulses(changes = []) {
  return changes.slice(0, 24).map(change => {
    const { x, y } = hungryAnchor(change.id);
    const to = String(change.to || "");
    const from = String(change.from || "");
    const kind = to === "in_progress" ? "ignite" :
      to === "queued" ? "queue" :
      to === "success" ? "release" :
      FAILURES.has(to) ? "scar" :
      to === "cancelled" || to === "skipped" ? "settle" : "shift";
    return { x, y, kind, force: kind === "scar" ? .95 : kind === "ignite" ? .7 : kind === "release" ? .75 : .35, from, to };
  });
}

// A two-body autonomous brush: an edge-feeder + an inland drifting slug.
// Paths are repeatable, continuous in time, and guaranteed to move with no runs.
export function hungryIdleStrokes(scene, elapsedSeconds, motion = "normal", reactivity = 75) {
  if (motion === "off") return [];
  const speed = motion === "subtle" ? .55 : motion === "intense" ? 1.45 : 1;
  const k = clamp(reactivity / 100);
  const t = Math.max(0, Number(elapsedSeconds) || 0) * speed;
  const margin = .075 + scene.queuePressure * .045;
  const theta = t * (.16 + scene.queuePressure * .08);
  const theta2 = t * (.19 + scene.activity * .05);
  const shoreline = {
    x: clamp(.5 + (.5 - margin) * Math.cos(theta)),
    y: clamp(.5 + (.5 - margin) * Math.sin(theta + .29 * Math.sin(t * .12))),
    force: (.13 + scene.queuePressure * .35 + scene.failurePressure * .12) * k,
    held: scene.queuePressure > .22 && Math.sin(t * 1.2) > .79,
    role: "margin"
  };
  const slug = {
    x: clamp(.5 + .31 * Math.sin(theta2) + .045 * Math.sin(t * .71)),
    y: clamp(.5 + .22 * Math.sin(theta2 * 1.31 + .8)),
    force: (.12 + scene.activity * .22 + scene.stallPressure * .23) * k,
    held: false,
    role: "slug"
  };
  return [shoreline, slug];
}

export function hungryAmbientEvents(scene, tickIndex) {
  // Low-frequency CI-dependent pulses, never invented state transitions.
  if (!scene.anchors.length) return [];
  const index = Math.max(0, Math.floor(tickIndex));
  const row = scene.anchors[index % scene.anchors.length];
  if (row.status === "in_progress") {
    return [{ x: row.x, y: row.y, force: .28, kind: row.stalled ? "stall" : "running" }];
  }
  if (row.status === "queued") {
    return [{ x: row.x, y: row.y, force: .16, kind: "queued" }];
  }
  // Historical failures can affect ambient texture, but not produce a new
  // completion/failure event pulse; those require observed state transitions.
  return [];
}
