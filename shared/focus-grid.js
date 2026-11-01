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
  ["stageRemaining", "S-ETA", 88],
  ["confidence", "CONF", 70],
  ["qty", "QTY", 58],
  ["confQty", "CONF/QTY", 120],
  ["checks", "CHECKS", 138],
  ["added", "ADDED", 120],
  ["updated", "UPDATED", 120],
  ["branch", "BRANCH", 210],
  ["event", "EVENT", 110]
]);
export const GRID_MIN_WIDTH = 40;
export const GRID_FIELD_SET = new Set(GRID_FIELDS.map(([id]) => id));
export const GRID_OVERFLOW_MODES = Object.freeze([
  ["ellipsis", "Clip with ellipsis"],
  ["hard_clip", "Clip without ellipsis (to border)"],
  ["wrap", "Wrap"]
]);
export function normalizeGridOverflowMode(mode, previousWrap = false) {
  return GRID_OVERFLOW_MODES.some(([id]) => id === mode)
    ? mode : (previousWrap ? "wrap" : "ellipsis");
}
export const GRID_LABEL = Object.freeze(Object.fromEntries(GRID_FIELDS.map(([id, label]) => [id, label])));
export const GRID_DEFAULT_WIDTH = Object.freeze(Object.fromEntries(GRID_FIELDS.map(([id, , width]) => [id, width])));
export const GRID_DATE_FORMATS = Object.freeze([
  ["short", "Local short"],
  ["date", "Local date"],
  ["time", "Local time"],
  ["datetime", "Local date + seconds"],
  ["iso_local", "ISO local"],
  ["iso_utc", "ISO UTC"],
  ["relative", "Relative (ago)"],
  ["custom", "Custom pattern"]
]);
const GRID_DATE_FORMAT_IDS = new Set(GRID_DATE_FORMATS.map(([id]) => id));
export function normalizeGridLockedWidths(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(field => GRID_FIELD_SET.has(field)))];
}
export function normalizeGridDateFormat(value) {
  return GRID_DATE_FORMAT_IDS.has(value) ? value : "short";
}
export function normalizeGridDatePattern(value) {
  return typeof value === "string" ? value.slice(0, 64) : "YYYY-MM-DD HH:mm";
}
export function formatGridDate(epoch, mode = "short", custom = "", nowMs = Date.now()) {
  if (!Number.isFinite(Number(epoch)) || epoch <= 0) return "—";
  const date = new Date(Number(epoch) * 1000);
  if (!Number.isFinite(date.getTime())) return "—";
  const format = normalizeGridDateFormat(mode);
  if (format === "relative") {
    const delta = Math.max(0, nowMs - date.getTime());
    const secs = Math.floor(delta / 1000);
    if (secs < 60) return secs + "s ago";
    if (secs < 3600) return Math.floor(secs / 60) + "m ago";
    if (secs < 86400) return Math.floor(secs / 3600) + "h ago";
    return Math.floor(secs / 86400) + "d ago";
  }
  if (format === "iso_utc") return date.toISOString().replace(".000Z", "Z");
  const opts = format === "time" ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } :
    format === "date" ? { year: "numeric", month: "short", day: "numeric" } :
    format === "datetime" ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" } :
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  if (format === "short" || format === "date" || format === "time" || format === "datetime") {
    return date.toLocaleString([], opts);
  }
  const pad = n => String(n).padStart(2, "0");
  const parts = {
    YYYY: date.getFullYear(), MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()), HH: pad(date.getHours()),
    mm: pad(date.getMinutes()), ss: pad(date.getSeconds())
  };
  const pattern = format === "iso_local" ? "YYYY-MM-DD HH:mm:ss" :
    normalizeGridDatePattern(custom);
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, token => String(parts[token]));
}

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

export const GRID_ROW_LINE_LIMIT = 12;
export function normalizeGridRowLines(value, legacyPixels = 0) {
  const numeric = value === undefined || value === null
    ? (Number(legacyPixels) > 0 ? Math.max(1, Math.round(Number(legacyPixels) / 16)) : 0)
    : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.max(1, Math.min(GRID_ROW_LINE_LIMIT, Math.round(numeric)));
}

export function normalizeGridRowHeight(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.min(160, Math.max(18, Math.round(size)));
}

export function normalizeGridWidths(input) {
  const widths = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return widths;
  for (const [field, width] of Object.entries(input)) {
    if (!GRID_FIELD_SET.has(field)) continue;
    const numeric = Number(width);
    if (Number.isFinite(numeric)) widths[field] = Math.max(GRID_MIN_WIDTH, Math.min(750, Math.round(numeric)));
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
    gridRowHeight: normalizeGridRowHeight(input.gridRowHeight ?? parent.gridRowHeight ?? 0),
    gridRowLines: normalizeGridRowLines(input.gridRowLines,
      input.gridRowHeight ?? parent.gridRowHeight ?? 0),
    gridHeaderOverflowMode: normalizeGridOverflowMode(input.gridHeaderOverflowMode, false),
    gridWrap: boolean(input.gridWrap, parent.gridWrap ?? false),
    gridOverflowMode: normalizeGridOverflowMode(input.gridOverflowMode,
      boolean(input.gridWrap, parent.gridWrap ?? false)),
    gridSortBy: normalizeGridSortBy(input.gridSortBy ?? (left ? "priority" : "attention")),
    gridSortDir: input.gridSortDir === "asc" ? "asc" : "desc",
    gridSortSecondaryBy: normalizeGridSortBy(input.gridSortSecondaryBy) === "priority"
      ? "" : normalizeGridSortBy(input.gridSortSecondaryBy),
    gridSortSecondaryDir: input.gridSortSecondaryDir === "asc" ? "asc" : "desc",
    gridLockedWidths: normalizeGridLockedWidths(input.gridLockedWidths),
    gridAddedFormat: normalizeGridDateFormat(input.gridAddedFormat),
    gridUpdatedFormat: normalizeGridDateFormat(input.gridUpdatedFormat),
    gridAddedPattern: normalizeGridDatePattern(input.gridAddedPattern),
    gridUpdatedPattern: normalizeGridDatePattern(input.gridUpdatedPattern)
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
    case "stageRemaining": return row.stageEstimatedRemainingMs || 0;
    case "confidence": return ["none", "low", "medium", "high"].indexOf(row.confidence);
    case "qty": return row.baselineSamples || 0;
    case "checks": return row.checks?.total ? row.checks.passed / row.checks.total : -1;
    case "confQty": return (["none", "low", "medium", "high"].indexOf(row.confidence) + 1) * 100000 +
      (row.baselineSamples || 0);
    case "added": return row.createdAtEpoch || 0;
    case "updated": return row.updatedAtEpoch || 0;
    case "branch": return row.branch || "";
    case "event": return row.event || "";
    default: return "";
  }
}

const attentionPriority = Object.freeze({ normal: 0, interesting: 1, suspicious: 2, action_required: 3 });
function comparable(row, key) {
  if (key === "attention") return attentionPriority[row.attention] ?? -1;
  if (key === "priority") {
    const running = row.state === "in_progress" ? 10000 : row.state === "queued" ? 9000 : 0;
    return running + (attentionPriority[row.attention] ?? 0) * 1000 +
      (row.manualWatch ? 100 : 0) + Math.min(Math.floor((row.elapsedMs || 0) / 60000), 99);
  }
  return gridFieldRaw(row, key);
}
function compareValues(a, b, direction) {
  const diff = typeof a === "number" && typeof b === "number" ? a - b :
    String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
  return diff * (direction === "asc" ? 1 : -1);
}
export function sortGridRows(rows, by = "priority", direction = "desc",
  secondaryBy = "", secondaryDir = "desc") {
  if ((by === "priority" && !secondaryBy) || !normalizeGridSortBy(by)) return [...rows];
  const secondary = GRID_FIELD_SET.has(secondaryBy) && secondaryBy !== by ? secondaryBy : "";
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const first = compareValues(comparable(a.row, by), comparable(b.row, by), direction);
    if (first) return first;
    if (secondary) {
      const second = compareValues(comparable(a.row, secondary),
        comparable(b.row, secondary), secondaryDir);
      if (second) return second;
    }
    return a.index - b.index;
  }).map(({ row }) => row);
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
