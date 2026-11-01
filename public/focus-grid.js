import {
  GRID_DEFAULT_WIDTH, GRID_LABEL, GRID_MIN_WIDTH, gridFieldRaw, formatGridDate,
  normalizeGridFields, reorderGridFields, separatorBreakSegments, sortGridRows
} from "/focus-grid.js";

const make = (tag, className = "", text) => {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = String(text);
  return n;
};


// Inject discretionary browser-native break opportunities without modifying
// displayed text, source values or tooltip strings. Never use innerHTML.
function appendSeparatorBreaks(node, originalText) {
  const parts = separatorBreakSegments(originalText);
  if (parts.length === 1) return;
  node.replaceChildren();
  for (let i = 0; i < parts.length; i++) {
    node.append(document.createTextNode(parts[i]));
    if (i !== parts.length - 1) node.append(document.createElement("wbr"));
  }
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? h + "h" + (m % 60) + "m" :
    m ? m + "m" + (s % 60) + "s" : s + "s";
}
function display(row, field, options) {
  const raw = gridFieldRaw(row, field);
  switch (field) {
    case "elapsed": return row.state === "queued"
      ? "WAIT " + duration(row.waitingMs || 0)
      : row.elapsedLowerBound ? "≥" + (raw > 0 ? duration(raw) : "0s")
        : duration(raw);
    case "remaining": case "stageRemaining": case "baseline": return duration(raw);
    case "ratio": return raw ? raw.toFixed(2) + "×" : "—";
    case "added": return formatGridDate(raw, options.gridAddedFormat, options.gridAddedPattern);
    case "updated": return formatGridDate(raw, options.gridUpdatedFormat, options.gridUpdatedPattern);
    case "confidence": return row.confidence || "none";
    case "qty": return String(row.baselineSamples || 0);
    case "confQty": return (row.confidence || "none").toUpperCase() + "/" +
      (row.baselineSamples || 0);
    case "stage": return raw || "workflow";
    case "attention": return String(raw).replaceAll("_", " ");
    case "state":
      return row.providerState === "queued" && row.state === "in_progress"
        ? "jobs active (" + (row.observedRunningJobs || 1) + ")"
        : String(raw || "unknown").replaceAll("_", " ");
    default: return raw === undefined || raw === null || raw === "" ? "—" : String(raw);
  }
}

export function createFocusGrid(rows, options, callbacks = {}, key = "focus") {
  const fields = normalizeGridFields(options.gridFields);
  const wrap = make("div", "focus-grid-wrap");
  const table = make("table", "focus-grid-table");
  table.dataset.wrap = options.gridOverflowMode ||
    (options.gridWrap ? "wrap" : "ellipsis");
  table.setAttribute("aria-label", key + " workflows");
  const fixedRowLines = Number(options.gridRowLines) || 0;
  table.dataset.fixedRowHeight = fixedRowLines > 0 ? "true" : "false";
  table.dataset.headerOverflow = options.gridHeaderOverflowMode || "ellipsis";
  if (fixedRowLines > 0) {
    table.style.setProperty("--focus-row-lines", String(fixedRowLines));
  }
  const widths = { ...GRID_DEFAULT_WIDTH, ...(options.gridWidths || {}) };
  const locked = new Set(options.gridLockedWidths || []);
  const total = fields.reduce((acc, field) => acc + widths[field], 0);
  table.style.width = total + "px";
  // New grids begin with horizontal overflow hidden. Enable the scrollbar
  // after measuring the attached viewport only if columns actually overflow.
  wrap.dataset.horizontal = "fit";
  const usedWidth = () => fields.reduce((sum, field) => sum + widths[field], 0);
  function updateHorizontalOverflow() {
    if (!wrap.isConnected) return;
    wrap.dataset.horizontal = usedWidth() > wrap.clientWidth + 1 ? "scroll" : "fit";
  }
  const colGroup = make("colgroup");
  const cols = new Map();
  for (const field of fields) {
    const col = make("col");
    col.style.width = widths[field] + "px";
    colGroup.append(col);
    cols.set(field, col);
  }
  table.append(colGroup);

  const head = make("thead");
  const headerRow = make("tr");
  for (const field of fields) {
    const th = make("th", "focus-grid-head");
    th.dataset.field = field;
    th.draggable = true;
    th.dataset.locked = String(locked.has(field));
    const secondary = options.gridSortSecondaryBy === field;
    const sort = make("button", "focus-sort", GRID_LABEL[field] +
      (options.gridSortBy === field ? (options.gridSortDir === "asc" ? " ↑" : " ↓") :
        secondary ? (options.gridSortSecondaryDir === "asc" ? " ²↑" : " ²↓") : "") +
      "");
    sort.type = "button";
    if (table.dataset.headerOverflow === "wrap" &&
        options.gridBreakAfterSeparators !== false) {
      appendSeparatorBreaks(sort, sort.textContent);
    }
    sort.title = (field === "remaining"
      ? "Whole workflow ETA based on run-level history; S-ETA is the active stage only. "
      : field === "stageRemaining"
        ? "Current step/job ETA only; not the remaining workflow time. "
        : "") + "Click: primary sort; Shift+click: secondary sort; Ctrl+click: lock/unlock width";
    sort.setAttribute("aria-pressed", String(locked.has(field)));
    sort.addEventListener("click", event => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        callbacks.onLock?.(field, !locked.has(field));
      } else if (event.shiftKey) {
        event.preventDefault();
        callbacks.onSecondarySort?.(field,
          secondary && options.gridSortSecondaryDir === "desc" ? "asc" : "desc");
      } else {
        callbacks.onSort?.(field,
          options.gridSortBy === field && options.gridSortDir === "desc" ? "asc" : "desc");
      }
    });
    th.addEventListener("dragstart", event => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", field);
      th.classList.add("is-dragging");
    });
    th.addEventListener("dragend", () => th.classList.remove("is-dragging"));
    th.addEventListener("dragover", event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; });
    th.addEventListener("drop", event => {
      event.preventDefault();
      const source = event.dataTransfer.getData("text/plain");
      if (!fields.includes(source)) return;
      callbacks.onReorder?.(reorderGridFields(fields, source, field));
    });
    const handle = make("span", "focus-resize-handle");
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", (locked.has(field) ? "Locked " : "Resize ") +
      GRID_LABEL[field] + " column (Ctrl+click to toggle lock)");
    handle.setAttribute("aria-orientation", "vertical");
    handle.tabIndex = 0;
    handle.dataset.locked = String(locked.has(field));
    function resizeBy(delta) {
      if (locked.has(field)) return;
      const target = Math.max(GRID_MIN_WIDTH, Math.min(750, widths[field] + delta));
      widths[field] = target;
      cols.get(field).style.width = target + "px";
      table.style.width = usedWidth() + "px";
      updateHorizontalOverflow();
    }
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      if (event.ctrlKey || event.metaKey) {
        callbacks.onLock?.(field, !locked.has(field));
        return;
      }
      if (locked.has(field)) return;
      callbacks.onInteracting?.(true);
      const startX = event.clientX, original = widths[field];
      handle.setPointerCapture(event.pointerId);
      const move = ev => { resizeBy(original + ev.clientX - startX - widths[field]); };
      const finish = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        callbacks.onWidth?.(field, widths[field]);
        callbacks.onInteracting?.(false);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", finish, { once: true });
      handle.addEventListener("pointercancel", finish, { once: true });
    });
    handle.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        callbacks.onLock?.(field, !locked.has(field));
        return;
      }
      if (!["ArrowLeft", "ArrowRight"].includes(event.key) || locked.has(field)) return;
      event.preventDefault();
      resizeBy(event.key === "ArrowLeft" ? -15 : 15);
      callbacks.onWidth?.(field, widths[field]);
    });
    th.append(sort, handle);
    headerRow.append(th);
  }
  head.append(headerRow);
  table.append(head);
  const body = make("tbody");
  for (const row of sortGridRows(rows, options.gridSortBy, options.gridSortDir,
    options.gridSortSecondaryBy, options.gridSortSecondaryDir)) {
    const tr = make("tr", "focus-grid-row");
    tr.dataset.attention = row.attention || "normal";
    tr.tabIndex = 0;
    tr.title = row.repository + " / " + row.workflow + " #" + row.runNumber;
    tr.addEventListener("click", () => callbacks.onOpen?.(row.repository, row.runId));
    tr.addEventListener("keydown", ev => {
      if (!["Enter", " "].includes(ev.key)) return;
      ev.preventDefault();
      callbacks.onOpen?.(row.repository, row.runId);
    });
    for (const field of fields) {
      const td = make("td", "focus-grid-cell");
      td.dataset.field = field;
      if (field === "checks") {
        const progress = row.checks;
        const label = !progress ? "Check data unavailable (no PR head SHA)" :
          progress.error ? progress.error :
          "PR head check runs: " + progress.passed + " passed / " +
          progress.total + " total / " + progress.failed + " failed; " +
          progress.pending + " pending; " + progress.skipped + " skipped/cancelled" +
          (progress.complete ? "" : " (incomplete/paginating)");
        td.title = label;
        if (!progress || (progress.total === 0 && !progress.fetchedAtMs)) {
          td.append(make("span", "focus-grid-value", progress?.error ? "—" : "…"));
        } else {
          const counters = make("span", "focus-check-progress");
          counters.setAttribute("aria-label", label);
          counters.append(
            make("span", "focus-check-pass", progress.passed),
            make("span", "focus-check-separator", "/"),
            make("span", "focus-check-total", String(progress.total) + (progress.complete ? "" : "+")),
            make("span", "focus-check-separator", "/"),
            make("span", "focus-check-fail", progress.failed)
          );
          td.append(counters);
        }
      } else {
        const v = display(row, field, options);
        const value = make("span", "focus-grid-value", v);
        if (table.dataset.wrap === "wrap" &&
            options.gridBreakAfterSeparators !== false) {
          appendSeparatorBreaks(value, v);
        }
        value.title = field === "elapsed" && row.elapsedLowerBound
          ? "Lower bound: time since CISmonWEB first observed this workflow running. " +
            "Actual job timestamps have not been acquired; no run ETA is inferred."
          : field === "state" && row.providerState === "queued" &&
          row.state === "in_progress"
          ? v + " — GitHub reports queued; running child jobs were observed" +
            (row.jobsCoverageComplete ? "" : " (partial job coverage)")
          : v;
        if (field === "attention") value.className += " attention-" + row.attention;
        if (field === "state") value.className += " state-" + row.state;
        td.append(value);
      }
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  // DOM dimensions are not known until the new grid has been inserted.
  // Restore per-pane scroll after layout rather than clamping to zero while
  // still detached (particularly important for 2-second refreshes).
  const left = callbacks.getScroll?.() || 0;
  const top = callbacks.getScrollTop?.() || 0;
  requestAnimationFrame(() => {
    if (!wrap.isConnected) return;
    updateHorizontalOverflow();
    if (wrap.dataset.horizontal === "scroll") wrap.scrollLeft = left;
    wrap.scrollTop = top;
  });
  wrap.addEventListener("scroll", () => {
    callbacks.onScroll?.(wrap.scrollLeft);
    callbacks.onScrollTop?.(wrap.scrollTop);
  }, { passive: true });
  return wrap;
}
