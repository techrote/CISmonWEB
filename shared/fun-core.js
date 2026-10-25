// Pure projections for artistic CI surfaces. Never substitutes for authoritative GitHub state.
export const FUN_LAYOUTS = Object.freeze(["signal", "afterimage", "lanes_plus", "hungry_margins"]);
export const FUN_PRESET_VERSION = 2;

export function isFunLayout(layout) {
  return FUN_LAYOUTS.includes(layout);
}

export function runIdentity(row) {
  return String(row.repository || "") + "#" + String(row.runId ?? "");
}

export function rowStatus(row) {
  return row.state === "completed" ? row.conclusion || "unknown" : row.state || "unknown";
}

export function summarizeFunRows(rows) {
  const result = { running: 0, queued: 0, success: 0, failures: 0, suspicious: 0, interesting: 0, other: 0, total: rows.length };
  for (const row of rows) {
    if (row.state === "in_progress") result.running++;
    else if (row.state === "queued") result.queued++;
    else if (row.conclusion === "success") result.success++;
    else if (["failure", "timed_out", "startup_failure", "action_required", "stale"].includes(row.conclusion)) result.failures++;
    else result.other++;
    if (row.attention === "suspicious") result.suspicious++;
    if (row.attention === "interesting") result.interesting++;
  }
  return result;
}

export function illustrativeCoherence(rows) {
  // A *visual encoding*, NOT a measured GitHub metric or historical failure rate.
  if (!rows.length) return 100;
  const { failures, suspicious, interesting, queued } = summarizeFunRows(rows);
  const penalty = (failures * 0.7 + suspicious * 0.45 + interesting * 0.2 + queued * 0.08) / rows.length;
  return Math.max(15, Math.min(100, 100 - penalty * 100));
}

export function groupFunRepositories(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.repository)) groups.set(row.repository, []);
    groups.get(row.repository).push(row);
  }
  return [...groups.entries()].map(([repository, entries]) => ({
    repository,
    rows: entries,
    counts: summarizeFunRows(entries)
  }));
}

export function hashRunId(value) {
  const text = String(value);
  let hash = 2166136261 >>> 0;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash;
}

export function observeTransitions(previous, rows, nowMs) {
  // Only record changes observed *between browser polls*. Do not fabricate history.
  const next = new Map();
  const changes = [];
  for (const row of rows) {
    const id = runIdentity(row);
    const status = rowStatus(row);
    const old = previous.get(id);
    if (old && old !== status) {
      changes.push({ id, repository: row.repository, workflow: row.workflow, from: old, to: status, at: nowMs });
    }
    next.set(id, status);
  }
  return { next, changes };
}

export function migrateFunPresets(saved, defaults, previousVersion) {
  if (Number(previousVersion) >= FUN_PRESET_VERSION) return saved;
  const incoming = Array.isArray(saved) && saved.length ? [...saved] : [...defaults];
  const present = new Set(incoming.map((entry) => entry && entry.id));
  for (const surface of defaults) {
    if (!FUN_LAYOUTS.includes(surface.layout) || present.has(surface.id)) continue;
    incoming.push(surface);
  }
  return incoming;
}
