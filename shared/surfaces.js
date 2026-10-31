import { DEFAULT_FOCUS_COLUMNS, FOCUS_VERT_DEFAULT, normalizeDualPanes,
  normalizeGridFields, normalizeGridSortBy, normalizeGridWidths,
  normalizeVertCount, normalizeVertPanes, normalizeGridLockedWidths,
  normalizeGridDateFormat, normalizeGridDatePattern, normalizeGridOverflowMode } from "./focus-grid.js";

const LAYOUTS = new Set(["rows", "cards", "table", "lanes", "focus_dual", "focus_vert", "signal", "afterimage", "lanes_plus", "hungry_margins"]);
const DENSITIES = new Set(["comfortable", "compact", "ultra"]);
const MOTIONS = new Set(["off", "subtle", "normal", "intense"]);
const THEMES = new Set(["dark", "black", "light", "amber", "green"]);
const SORTS = new Set(["priority", "elapsed", "repository", "remaining"]);
const GROUPS = new Set(["none", "repository", "state", "attention"]);
const ATTENTION = ["normal", "interesting", "suspicious", "action_required"];
const FIELDS = new Set(["stage", "state", "elapsed", "baseline", "ratio", "remaining", "branch", "confidence"]);

function list(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function choice(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function integer(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function safeId(value, fallback) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, 48);
}

export const DEFAULT_SURFACES = Object.freeze([
  {
    id: "focus",
    name: "Focus",
    layout: "rows",
    density: "comfortable",
    theme: "dark",
    refreshMs: 2000,
    maxItems: 16,
    sort: "priority",
    groupBy: "none",
    minAttention: "normal",
    repositoryPatterns: [],
    workflowPatterns: [],
    eventPatterns: [],
    showInProgress: true,
    showQueued: true,
    showSuccess: true,
    showFailures: true,
    showOtherCompleted: true,
    watchedOnly: false,
    stallsOnly: false,
    fields: ["stage", "state", "elapsed", "baseline", "ratio", "remaining", "branch", "confidence"],
    showTelemetry: true,
    showSummary: true,
    showError: true,
    showAttentionBadge: true,
    showWatchFlags: true,
    showStallFlag: true,
    fullWidth: false,
    hideChrome: false,
    gridFields: DEFAULT_FOCUS_COLUMNS,
    gridWidths: {},
    gridWrap: false,
    gridSortBy: "priority",
    gridSortDir: "desc"
  },
  {
    id: "dense",
    name: "Dense",
    layout: "table",
    density: "ultra",
    theme: "black",
    refreshMs: 1500,
    maxItems: 48,
    sort: "priority",
    groupBy: "none",
    minAttention: "normal",
    repositoryPatterns: [],
    workflowPatterns: [],
    eventPatterns: [],
    showInProgress: true,
    showQueued: true,
    showSuccess: true,
    showFailures: true,
    showOtherCompleted: true,
    watchedOnly: false,
    stallsOnly: false,
    fields: ["stage", "state", "elapsed", "baseline", "ratio", "remaining", "branch", "confidence"],
    showTelemetry: true,
    showSummary: false,
    showError: true,
    showAttentionBadge: true,
    showWatchFlags: true,
    showStallFlag: true,
    fullWidth: true,
    hideChrome: false
  },
  {
    id: "alerts",
    name: "Alerts",
    layout: "rows",
    density: "compact",
    theme: "dark",
    refreshMs: 1000,
    maxItems: 24,
    sort: "priority",
    groupBy: "attention",
    minAttention: "interesting",
    repositoryPatterns: [],
    workflowPatterns: [],
    eventPatterns: [],
    showInProgress: true,
    showQueued: true,
    showSuccess: false,
    showFailures: true,
    showOtherCompleted: false,
    watchedOnly: false,
    stallsOnly: false,
    fields: ["stage", "state", "elapsed", "baseline", "ratio", "remaining"],
    showTelemetry: true,
    showSummary: true,
    showError: true,
    showAttentionBadge: true,
    showWatchFlags: true,
    showStallFlag: true,
    fullWidth: false,
    hideChrome: false
  },
  {
    id: "wallboard",
    name: "Wallboard",
    layout: "cards",
    density: "comfortable",
    theme: "black",
    refreshMs: 2000,
    maxItems: 20,
    sort: "priority",
    groupBy: "none",
    minAttention: "normal",
    repositoryPatterns: [],
    workflowPatterns: [],
    eventPatterns: [],
    showInProgress: true,
    showQueued: true,
    showSuccess: true,
    showFailures: true,
    showOtherCompleted: false,
    watchedOnly: false,
    stallsOnly: false,
    fields: ["stage", "state", "elapsed", "ratio", "remaining"],
    showTelemetry: true,
    showSummary: false,
    showError: true,
    showAttentionBadge: true,
    showWatchFlags: true,
    showStallFlag: true,
    fullWidth: true,
    hideChrome: true
  },
  {
    id: "repo-lanes",
    name: "Repository lanes",
    layout: "lanes",
    density: "compact",
    theme: "dark",
    refreshMs: 2000,
    maxItems: 36,
    sort: "priority",
    groupBy: "repository",
    minAttention: "normal",
    repositoryPatterns: [],
    workflowPatterns: [],
    eventPatterns: [],
    showInProgress: true,
    showQueued: true,
    showSuccess: false,
    showFailures: true,
    showOtherCompleted: false,
    watchedOnly: false,
    stallsOnly: false,
    fields: ["stage", "state", "elapsed", "ratio"],
    showTelemetry: true,
    showSummary: true,
    showError: true,
    showAttentionBadge: true,
    showWatchFlags: true,
    showStallFlag: true,
    fullWidth: true,
    hideChrome: false
  },
  {
    id: "stalls",
    name: "Stalls",
    layout: "cards",
    density: "compact",
    theme: "amber",
    refreshMs: 1000,
    maxItems: 16,
    sort: "elapsed",
    groupBy: "attention",
    minAttention: "interesting",
    repositoryPatterns: [],
    workflowPatterns: [],
    eventPatterns: [],
    showInProgress: true,
    showQueued: false,
    showSuccess: false,
    showFailures: true,
    showOtherCompleted: false,
    watchedOnly: false,
    stallsOnly: true,
    fields: ["stage", "state", "elapsed", "baseline", "ratio"],
    showTelemetry: true,
    showSummary: true,
    showError: true,
    showAttentionBadge: true,
    showWatchFlags: true,
    showStallFlag: true,
    fullWidth: false,
    hideChrome: false
  },
  {
    id: "focus-dual",
    name: "Focus Dual",
    layout: "focus_dual",
    density: "compact",
    theme: "dark",
    refreshMs: 2000,
    maxItems: 64,
    sort: "priority",
    groupBy: "none",
    minAttention: "normal",
    repositoryPatterns: [], workflowPatterns: [], eventPatterns: [],
    showInProgress: true, showQueued: true, showSuccess: true,
    showFailures: true, showOtherCompleted: true,
    watchedOnly: false, stallsOnly: false,
    fields: ["stage", "state", "elapsed", "remaining", "confidence"],
    gridFields: DEFAULT_FOCUS_COLUMNS,
    gridWidths: {},
    gridWrap: false,
    gridSortBy: "priority",
    gridSortDir: "desc",
    dualPanes: [],
    showTelemetry: true, showSummary: true, showError: true,
    showAttentionBadge: true, showWatchFlags: true, showStallFlag: true,
    fullWidth: true, hideChrome: false,
    motion: "off", reactivity: 0, showFunControls: false
  },
  {
    id: "focus-vert",
    name: "Focus Vert",
    layout: "focus_vert",
    density: "compact",
    theme: "dark",
    refreshMs: 2000,
    maxItems: 64,
    sort: "priority",
    groupBy: "none",
    minAttention: "normal",
    repositoryPatterns: [], workflowPatterns: [], eventPatterns: [],
    showInProgress: true, showQueued: true, showSuccess: true,
    showFailures: true, showOtherCompleted: true,
    watchedOnly: false, stallsOnly: false,
    fields: ["stage", "state", "elapsed", "remaining", "confidence"],
    gridFields: DEFAULT_FOCUS_COLUMNS,
    gridWidths: {},
    gridWrap: false,
    gridSortBy: "priority",
    gridSortDir: "desc",
    vertCount: FOCUS_VERT_DEFAULT,
    vertPanes: [],
    showTelemetry: true, showSummary: true, showError: true,
    showAttentionBadge: true, showWatchFlags: true, showStallFlag: true,
    fullWidth: true, hideChrome: false,
    motion: "off", reactivity: 0, showFunControls: false
  },
  {
    id: "signal-retention",
    name: "Signal Retention",
    layout: "signal",
    density: "comfortable",
    theme: "black",
    refreshMs: 2000,
    maxItems: 24,
    sort: "priority",
    groupBy: "none",
    minAttention: "normal",
    repositoryPatterns: [], workflowPatterns: [], eventPatterns: [],
    showInProgress: true, showQueued: true, showSuccess: true,
    showFailures: true, showOtherCompleted: true,
    watchedOnly: false, stallsOnly: false,
    fields: ["stage", "state", "elapsed", "ratio", "branch"],
    showTelemetry: true, showSummary: false, showError: true,
    showAttentionBadge: true, showWatchFlags: true, showStallFlag: true,
    fullWidth: true, hideChrome: false,
    motion: "normal", reactivity: 70, showFunControls: true
  },
  {
    id: "afterimage-debt",
    name: "Afterimage Debt",
    layout: "afterimage",
    density: "comfortable",
    theme: "black",
    refreshMs: 2000,
    maxItems: 24,
    sort: "priority",
    groupBy: "none",
    minAttention: "normal",
    repositoryPatterns: [], workflowPatterns: [], eventPatterns: [],
    showInProgress: true, showQueued: true, showSuccess: true,
    showFailures: true, showOtherCompleted: true,
    watchedOnly: false, stallsOnly: false,
    fields: ["stage", "state", "elapsed", "branch"],
    showTelemetry: true, showSummary: false, showError: true,
    showAttentionBadge: true, showWatchFlags: true, showStallFlag: true,
    fullWidth: true, hideChrome: false,
    motion: "normal", reactivity: 55, showFunControls: true
  },
  {
    id: "repository-lanes-plus",
    name: "Repository Lanes+",
    layout: "lanes_plus",
    density: "compact",
    theme: "dark",
    refreshMs: 2000,
    maxItems: 64,
    sort: "priority",
    groupBy: "repository",
    minAttention: "normal",
    repositoryPatterns: [], workflowPatterns: [], eventPatterns: [],
    showInProgress: true, showQueued: true, showSuccess: false,
    showFailures: true, showOtherCompleted: true,
    watchedOnly: false, stallsOnly: false,
    fields: ["stage", "state", "elapsed", "ratio", "branch"],
    showTelemetry: true, showSummary: false, showError: true,
    showAttentionBadge: true, showWatchFlags: true, showStallFlag: true,
    fullWidth: true, hideChrome: false,
    motion: "subtle", reactivity: 55, showFunControls: true
  },
  {
    id: "hungry-margins",
    name: "Hungry Margins",
    layout: "hungry_margins",
    density: "comfortable",
    theme: "black",
    refreshMs: 2000,
    maxItems: 24,
    sort: "priority",
    groupBy: "none",
    minAttention: "normal",
    repositoryPatterns: [], workflowPatterns: [], eventPatterns: [],
    showInProgress: true, showQueued: true, showSuccess: true,
    showFailures: true, showOtherCompleted: true,
    watchedOnly: false, stallsOnly: false,
    fields: ["stage", "state", "elapsed", "ratio", "branch"],
    showTelemetry: false, showSummary: false, showError: true,
    showAttentionBadge: true, showWatchFlags: true, showStallFlag: true,
    fullWidth: true, hideChrome: false,
    motion: "normal", reactivity: 75, showFunControls: true
  }
]);

export function normalizeSurface(input = {}, index = 0) {
  const fallback = DEFAULT_SURFACES[index] || DEFAULT_SURFACES[0];
  const minAttention = ATTENTION.includes(input.minAttention) ? input.minAttention : fallback.minAttention;
  const fieldsSupplied = Object.prototype.hasOwnProperty.call(input, "fields");
  const fields = list(input.fields).filter((field) => FIELDS.has(field));
  return {
    id: safeId(input.id, "surface-" + (index + 1)),
    name: String(input.name || fallback.name || ("Surface " + (index + 1))).trim().slice(0, 48),
    layout: choice(input.layout, LAYOUTS, fallback.layout),
    density: choice(input.density, DENSITIES, fallback.density),
    theme: choice(input.theme, THEMES, fallback.theme),
    refreshMs: integer(input.refreshMs, fallback.refreshMs, 1000, 60000),
    maxItems: integer(input.maxItems, fallback.maxItems, 1, 512),
    sort: choice(input.sort, SORTS, fallback.sort),
    groupBy: choice(input.groupBy, GROUPS, fallback.groupBy),
    minAttention,
    repositoryPatterns: list(input.repositoryPatterns),
    workflowPatterns: list(input.workflowPatterns),
    eventPatterns: list(input.eventPatterns),
    showInProgress: bool(input.showInProgress, fallback.showInProgress),
    showQueued: bool(input.showQueued, fallback.showQueued),
    showSuccess: bool(input.showSuccess, fallback.showSuccess),
    showFailures: bool(input.showFailures, fallback.showFailures),
    showOtherCompleted: bool(input.showOtherCompleted, fallback.showOtherCompleted),
    watchedOnly: bool(input.watchedOnly, fallback.watchedOnly),
    stallsOnly: bool(input.stallsOnly, fallback.stallsOnly),
    fields: fieldsSupplied ? fields : [...fallback.fields],
    showTelemetry: bool(input.showTelemetry, fallback.showTelemetry),
    showSummary: bool(input.showSummary, fallback.showSummary),
    showError: bool(input.showError, fallback.showError),
    showAttentionBadge: bool(input.showAttentionBadge, fallback.showAttentionBadge),
    showWatchFlags: bool(input.showWatchFlags, fallback.showWatchFlags),
    showStallFlag: bool(input.showStallFlag, fallback.showStallFlag),
    fullWidth: bool(input.fullWidth, fallback.fullWidth),
    hideChrome: bool(input.hideChrome, fallback.hideChrome),
    gridFields: normalizeGridFields(input.gridFields,
      fallback.gridFields || DEFAULT_FOCUS_COLUMNS),
    gridWidths: normalizeGridWidths(input.gridWidths),
    gridWrap: bool(input.gridWrap, fallback.gridWrap ?? false),
    gridOverflowMode: normalizeGridOverflowMode(input.gridOverflowMode,
      bool(input.gridWrap, fallback.gridWrap ?? false)),
    gridSortBy: normalizeGridSortBy(input.gridSortBy ?? fallback.gridSortBy),
    gridSortDir: input.gridSortDir === "asc" ? "asc" : "desc",
    gridSortSecondaryBy: (() => {
      const key = normalizeGridSortBy(input.gridSortSecondaryBy);
      return key === "priority" || key === input.gridSortBy ? "" : key;
    })(),
    gridSortSecondaryDir: input.gridSortSecondaryDir === "asc" ? "asc" : "desc",
    gridLockedWidths: normalizeGridLockedWidths(input.gridLockedWidths),
    gridAddedFormat: normalizeGridDateFormat(input.gridAddedFormat),
    gridUpdatedFormat: normalizeGridDateFormat(input.gridUpdatedFormat),
    gridAddedPattern: normalizeGridDatePattern(input.gridAddedPattern),
    gridUpdatedPattern: normalizeGridDatePattern(input.gridUpdatedPattern),
    dualPanes: normalizeDualPanes(input.dualPanes, {
      gridFields: normalizeGridFields(input.gridFields, DEFAULT_FOCUS_COLUMNS),
      gridWrap: input.gridWrap ?? false
    }),
    vertCount: normalizeVertCount(input.vertCount ?? fallback.vertCount ?? FOCUS_VERT_DEFAULT),
    vertPanes: normalizeVertPanes(
      input.vertPanes,
      input.vertCount ?? fallback.vertCount ?? FOCUS_VERT_DEFAULT,
      {
        gridFields: normalizeGridFields(input.gridFields, DEFAULT_FOCUS_COLUMNS),
        gridWrap: input.gridWrap ?? false
      }
    ),
    motion: choice(input.motion, MOTIONS, fallback.motion || "normal"),
    reactivity: integer(input.reactivity, fallback.reactivity ?? 50, 0, 100),
    showFunControls: bool(input.showFunControls, fallback.showFunControls ?? true)
  };
}

export function normalizeSurfaces(value) {
  const source = Array.isArray(value) && value.length ? value : DEFAULT_SURFACES;
  const seen = new Set();
  return source.slice(0, 32).map((surface, index) => {
    const normalized = normalizeSurface(surface, index);
    let id = normalized.id;
    let suffix = 2;
    while (seen.has(id)) id = normalized.id + "-" + suffix++;
    seen.add(id);
    return { ...normalized, id };
  });
}

export function globMatch(pattern, value) {
  let p = 0;
  let v = 0;
  let star = -1;
  let match = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) {
      p += 1; v += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p; p += 1; match = v;
    } else if (star !== -1) {
      p = star + 1; match += 1; v = match;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

function matchesAny(patterns, value) {
  return patterns.length === 0 || patterns.some((pattern) => globMatch(pattern, value || ""));
}

function attentionRank(value) {
  return Math.max(0, ATTENTION.indexOf(value));
}

function isFailure(row) {
  return ["failure", "timed_out", "action_required", "startup_failure"].includes(row.conclusion);
}

export function filterRows(rows, surface) {
  const minimum = attentionRank(surface.minAttention);
  return rows.filter((row) => {
    if (attentionRank(row.attention) < minimum) return false;
    if (!matchesAny(surface.repositoryPatterns, row.repository)) return false;
    if (!matchesAny(surface.workflowPatterns, row.workflow)) return false;
    if (!matchesAny(surface.eventPatterns, row.event || "")) return false;
    if (surface.watchedOnly && !row.manualWatch) return false;
    if (surface.stallsOnly && !row.possiblyStalled) return false;
    if (row.state === "in_progress" && !surface.showInProgress) return false;
    if (row.state === "queued" && !surface.showQueued) return false;
    if (row.state === "completed") {
      if (row.conclusion === "success" && !surface.showSuccess) return false;
      if (isFailure(row) && !surface.showFailures) return false;
      if (row.conclusion !== "success" && !isFailure(row) && !surface.showOtherCompleted) return false;
    }
    return true;
  });
}

export function sortRows(rows, surface) {
  const sorted = [...rows];
  if (surface.sort === "priority") return sorted;
  if (surface.sort === "elapsed") return sorted.sort((a, b) => (b.elapsedMs || 0) - (a.elapsedMs || 0));
  if (surface.sort === "repository") return sorted.sort((a, b) =>
    String(a.repository).localeCompare(String(b.repository)) ||
    String(a.workflow).localeCompare(String(b.workflow))
  );
  if (surface.sort === "remaining") return sorted.sort((a, b) => {
    const ar = a.estimatedRemainingMs || Number.MAX_SAFE_INTEGER;
    const br = b.estimatedRemainingMs || Number.MAX_SAFE_INTEGER;
    return ar - br;
  });
  return sorted;
}

export function applySurface(rows, surface) {
  return sortRows(filterRows(rows, surface), surface).slice(0, surface.maxItems);
}

export function groupRows(rows, surface) {
  const grouping = surface.groupBy === "none" && surface.layout === "lanes" ? "state" : surface.groupBy;
  if (grouping === "none") return [{ key: "all", label: "", rows }];
  const groups = new Map();
  for (const row of rows) {
    const key = grouping === "repository" ? row.repository :
      grouping === "attention" ? row.attention :
      row.state === "completed" ? row.conclusion : row.state;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, values]) => ({
    key,
    label: String(key).replaceAll("_", " "),
    rows: values
  }));
}

export const SURFACE_FIELDS = [...FIELDS];
