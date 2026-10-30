// Shared, pure Focus grid model. UI column state never changes GitHub polling.
export const GRID_FIELDS = Object.freeze([
  ["owner", "OWNER", 115],
  ["repository", "REPO", 170],
  ["workflow", "WORKFLOW", 260],
  ["runNumber", "#", 64],
  ["attention", "ATTN", 112],
  ["stage", "STAGE", 175],
  ["state", "STATE", 100],
  ["elapsed", "ELAPSED", 94],
  ["baseline", "MED", 85],
  ["ratio", "RATIO", 72],
  ["remaining", "ETA", 85],
  ["confidence", "CONF", 70],
  ["qty", "QTY", 58],
  ["added", "ADDED", 120],
  ["updated", "UPDATED", 120],
  ["branch", "BRANCH", 210],
  ["event", "EVENT", 110]
]);
export const GRID_FIELD_SET = new Set(GRID_FIELDS.map(([id]) => id));
export const GRID_LABEL = Object.freeze(Object.fromEntries(GRID_FIELDS.map(([id, label]) => [id, label])));
export const GRID_DEFAULT_WIDTH = Object.freeze(Object.fromEntries(GRID_FIELDS.map(([id, , width]) => [id, width])));
export const DEFAULT_FOCUS_COLUMNS = Object.freeze([
  "owner", "repository", "workflow", "attention", "stage",
  "state", "elapsed", "remaining", "confidence", "qty", "added", "updated"
]);

export function normalizeGridFields(input, fallback = DEFAULT_FOCUS_COLUMNS) {
  if (!Array.isArray(input)) return [...fallback];
  const seen = new Set();
  return input.filter(field => {
    if (!GRID_FIELD_SET.has(field) || seen.has(field)) return false;
    seen.add(field);
    return true;
  }).slice(0, GRID_FIELDS.length);
}

export function normalizeGridWidths(input) {
  const widths = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return widths;
  for (const [field, width] of Object.entries(input)) {
    if (!GRID_FIELD_SET.has(field)) continue;
    const numeric = Number(width);
    if (Number.isFinite(numeric)) widths[field] = Math.max(48, Math.min(750, Math.round(numeric)));
  }
  return widths;
}

export function normalizeGridSortBy(value) {
  return value === "priority" || GRID_FIELD_SET.has(value) ? value : "priority";
}

export function normalizePane(input = {}, index = 0, parent = {}) {
  const left = index === 0;
  const textList = value => Array.isArray(value) ? value.map(String).filter(Boolean) :
    typeof value === "string" ? value.split(/[\n,]/).map(x=>x.trim()).filter(Boolean) : [];
  const boolean = (value, fallback) => typeof value === "boolean" ? value : fallback;
  const limited = (value, fallback) => Number.isFinite(Number(value))
    ? Math.max(1, Math.min(512, Math.round(Number(value)))) : fallback;
  return {
    name: String(input.name ?? (left ? "Live / Focus" : "Alerts / History")).slice(0, 50),
    repositoryPatterns: textList(input.repositoryPatterns),
    workflowPatterns: textList(input.workflowPatterns),
    eventPatterns: textList(input.eventPatterns),
    minAttention: ["normal", "interesting", "suspicious", "action_required"].includes(input.minAttention)
      ? input.minAttention : (left ? "normal" : "interesting"),
    showInProgress: boolean(input.showInProgress, true),
    showQueued: boolean(input.showQueued, true),
    showSuccess: boolean(input.showSuccess, left),
    showFailures: boolean(input.showFailures, true),
    showOtherCompleted: boolean(input.showOtherCompleted, left),
    watchedOnly: boolean(input.watchedOnly, false),
    stallsOnly: boolean(input.stallsOnly, false),
    maxItems: limited(input.maxItems, left ? 40 : 24),
    density: ["comfortable", "compact", "ultra"].includes(input.density) ? input.density : "compact",
    gridFields: normalizeGridFields(input.gridFields, parent.gridFields || DEFAULT_FOCUS_COLUMNS),
    gridWidths: normalizeGridWidths(input.gridWidths),
    gridWrap: boolean(input.gridWrap, parent.gridWrap ?? false),
    gridSortBy: normalizeGridSortBy(input.gridSortBy ?? (left ? "priority" : "attention")),
    gridSortDir: input.gridSortDir === "asc" ? "asc" : "desc"
  };
}

export function normalizeDualPanes(input, parent = {}) {
  const list = Array.isArray(input) ? input : [];
  return [normalizePane(list[0] || {}, 0, parent), normalizePane(list[1] || {}, 1, parent)];
}

export function repoOwner(repository) {
  const raw = String(repository || "");
  return raw.includes("/") ? raw.split("/")[0] : "";
}
export function repoName(repository) {
  const raw = String(repository || "");
  return raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw;
}
export function gridFieldRaw(row, field) {
  switch (field) {
    case "owner": return repoOwner(row.repository);
    case "repository": return repoName(row.repository);
    case "workflow": return row.workflow || "";
    case "runNumber": return row.runNumber || 0;
    case "attention": return row.attention || "normal";
    case "stage": return row.stage || "";
    case "state": return row.state === "completed" ? row.conclusion : row.state;
    case "elapsed": return row.elapsedMs || 0;
    case "baseline": return row.baselineMedianMs || 0;
    case "ratio": return row.ratio || 0;
    case "remaining": return row.estimatedRemainingMs || 0;
    case "confidence": return ["none", "low", "medium", "high"].indexOf(row.confidence);
    case "qty": return row.baselineSamples || 0;
    case "added": return row.createdAtEpoch || 0;
    case "updated": return row.updatedAtEpoch || 0;
    case "branch": return row.branch || "";
    case "event": return row.event || "";
    default: return "";
  }
}

export function sortGridRows(rows, by = "priority", direction = "desc") {
  if (by === "priority" || !GRID_FIELD_SET.has(by)) return [...rows];
  const sign = direction === "asc" ? 1 : -1;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const value = row => by === "attention"
      ? ({ normal: 0, interesting: 1, suspicious: 2, action_required: 3 }[row.attention] ?? -1)
      : gridFieldRaw(row, by);
    const x = value(a.row), y = value(b.row);
    const diff = typeof x === "number" && typeof y === "number"
      ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return diff * sign || a.index - b.index;
  }).map(x => x.row);
}

export function reorderGridFields(fields, dragged, target) {
  const result = normalizeGridFields(fields);
  if (dragged === target || !result.includes(dragged) || !result.includes(target)) return result;
  result.splice(result.indexOf(dragged), 1);
  result.splice(result.indexOf(target), 0, dragged);
  return result;
}


// Focus Vert uses the same per-pane Focus policy as Focus Dual but allows
// 2–5 individually sized, vertically stacked panes.
export const FOCUS_VERT_MIN = 2;
export const FOCUS_VERT_MAX = 5;
export const FOCUS_VERT_DEFAULT = 2;

export function normalizeVertCount(input) {
  const n = Number(input);
  return Number.isFinite(n)
    ? Math.max(FOCUS_VERT_MIN, Math.min(FOCUS_VERT_MAX, Math.round(n)))
    : FOCUS_VERT_DEFAULT;
}

export function normalizeVertHeight(input = {}, index = 0, count = FOCUS_VERT_DEFAULT) {
  const unit = input.heightUnit === "px" ? "px" : "vh";
  const fallback = Math.max(16, Math.floor(86 / normalizeVertCount(count)));
  const supplied = Number(input.heightValue);
  const value = Number.isFinite(supplied) && supplied > 0 ? Math.round(supplied) : fallback;
  return {
    heightUnit: unit,
    heightValue: unit === "px"
      ? Math.max(120, Math.min(1600, value))
      : Math.max(10, Math.min(100, value))
  };
}

export function normalizeVertPanes(input, count = FOCUS_VERT_DEFAULT, parent = {}) {
  const length = normalizeVertCount(count);
  const list = Array.isArray(input) ? input : [];
  return Array.from({ length }, (_, i) => {
    const pane = list[i] && typeof list[i] === "object" ? list[i] : {};
    const base = normalizePane({
      ...pane,
      name: pane.name ?? (
        i === 0 ? "Live / Focus" :
        i === 1 ? "Alerts / History" :
        "Focus " + (i + 1)
      ),
      // Additional panes default to a broad overview instead of repeating
      // the alert-only second pane's visibility policy.
      ...(i > 1 && pane.minAttention === undefined ? { minAttention: "normal" } : {})
    }, i, parent);
    return { ...base, ...normalizeVertHeight(pane, i, length) };
  });
}
