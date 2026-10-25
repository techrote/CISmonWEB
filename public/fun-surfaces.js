import {
  groupFunRepositories,
  illustrativeCoherence,
  observeTransitions,
  rowStatus,
  runIdentity,
  summarizeFunRows
} from "/fun-core.js";
import { createFunEngine } from "/fun-engine.js";
import { groupRows } from "/surfaces.js";

const labelFor = {
  signal: ["SIGNAL RETENTION", "CONTINUOUS TRANSMISSION / GITHUB ACTIONS"],
  afterimage: ["AFTERIMAGE DEBT", "OBSERVED STATE TRANSITIONS / RESIDUAL DISPLAY"],
  lanes_plus: ["REPOSITORY LANES+", "AGGREGATE ACTIVITY / NOT A DEPENDENCY GRAPH"],
  hungry_margins: ["037 / HUNGRY MARGINS", "TWO HUNGERS / ONE SURFACE / LIVE CI SUBSTRATE"]
};

function el(tag, className = "", value) {
  const result = document.createElement(tag);
  result.className = className;
  if (value !== undefined) result.textContent = String(value);
  return result;
}

function label(value) {
  return String(value || "unknown").replaceAll("_", " ").toUpperCase();
}

function metric(name, value, detail = "") {
  const box = el("div", "living-metric");
  box.append(el("span", "living-metric-label", name), el("strong", "living-metric-value", value));
  if (detail) box.append(el("small", "living-metric-detail", detail));
  return box;
}

function stateClass(row) {
  return row.state === "in_progress" ? "running" :
    row.state === "queued" ? "queued" :
    row.attention === "action_required" ? "alert" :
    row.attention === "suspicious" ? "suspicious" : "terminal";
}

function makeRow(row, mode, openRun, formatDuration, surface) {
  const button = el("button", "living-run living-run-" + mode + " living-state-" + stateClass(row));
  button.type = "button";
  button.dataset.runKey = runIdentity(row);
  button.setAttribute("aria-label",
    row.repository + ", " + row.workflow + " run " + row.runNumber +
    ", " + label(rowStatus(row)));
  const repo = el("span", "living-run-repo", row.repository);
  const title = el("strong", "living-run-title", row.workflow + " #" + row.runNumber);
  const lower = el("div", "living-run-detail");
  const fields = new Set(surface.fields || []);

  if (fields.has("state")) lower.append(el("span", "living-run-status", label(rowStatus(row))));
  if (fields.has("elapsed")) lower.append(el("span", "living-run-time", formatDuration(row.elapsedMs)));
  if (fields.has("branch") && row.branch) lower.append(el("span", "living-run-branch", row.branch));
  if (fields.has("stage") && row.stage) lower.append(el("span", "living-run-field", row.stage));
  if (fields.has("baseline") && row.baselineMedianMs) {
    lower.append(el("span", "living-run-field", "MED " + formatDuration(row.baselineMedianMs)));
  }
  if (fields.has("ratio") && row.ratio > 0) {
    lower.append(el("span", "living-run-field", Number(row.ratio).toFixed(2) + "×"));
  }
  if (fields.has("remaining") && row.estimatedRemainingMs > 0) {
    lower.append(el("span", "living-run-field", "~" + formatDuration(row.estimatedRemainingMs) + " REMAINING"));
  }
  if (fields.has("confidence") && row.confidence) {
    lower.append(el("span", "living-run-field", row.confidence + " CONFIDENCE"));
  }
  if (surface.showAttentionBadge && row.attention !== "normal") {
    lower.append(el("span", "living-run-attention", label(row.attention)));
  }
  if (surface.showStallFlag && row.possiblyStalled) {
    lower.append(el("span", "living-run-flag", "POSSIBLE STALL"));
  }
  if (surface.showWatchFlags && row.manualWatch) {
    lower.append(el("span", "living-run-flag", "WATCHED"));
  }

  button.append(repo, title, lower);
  button.addEventListener("click", () => openRun(row.repository, row.runId));
  return button;
}

function renderLaneList(rows, target, openRun, formatDuration, surface) {
  target.replaceChildren();
  const groups = surface.groupBy === "repository" || surface.groupBy === "none" ?
    groupFunRepositories(rows).map(g => ({ title: g.repository, rows: g.rows, counts: g.counts })) :
    groupRows(rows, surface).map(g => ({
      title: g.label, rows: g.rows, counts: summarizeFunRows(g.rows)
    }));
  for (const group of groups) {
    const section = el("section", "living-repo-lane");
    const heading = el("header", "living-repo-heading");
    heading.append(el("strong", "", group.title));
    const status = [
      group.counts.running + " RUNNING",
      group.counts.queued + " QUEUED",
      group.counts.failures + " FAILED"
    ].join("   /   ");
    heading.append(el("span", "", status));
    section.append(heading);
    const list = el("div", "living-repo-items");
    for (const row of group.rows) {
      list.append(makeRow(row, "lane", openRun, formatDuration, surface));
    }
    section.append(list);
    target.append(section);
  }
}

function renderRunList(rows, layout, target, openRun, formatDuration, surface) {
  target.replaceChildren();
  const groups = groupRows(rows, surface);
  for (const group of groups) {
    const wrapper = group.label ? el("section", "living-group") : target;
    if (group.label) {
      wrapper.append(el("header", "living-group-heading", group.label + " / " + group.rows.length));
    }
    const inside = group.label ? el("div", "living-group-cards") : target;
    for (const row of group.rows) {
      inside.append(makeRow(row, layout, openRun, formatDuration, surface));
    }
    if (group.label) {
      wrapper.append(inside);
      target.append(wrapper);
    }
  }
}

export function createFunView(surface, openRun, formatDuration) {
  const mode = surface.layout;
  const root = el("section", "living-surface living-" + mode);
  root.dataset.mode = mode;
  const canvas = el("canvas", "living-canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label",
    mode === "hungry_margins"
      ? "A living olive-black border surrounding a live CI activity field. Pointer movement disturbs the surface."
      : "Decorative animated visualization of actual GitHub Actions activity.");
  const overlay = el("div", "living-overlay");
  const top = el("header", "living-top");
  const heading = el("div", "living-heading");
  heading.append(
    el("div", "living-name", labelFor[mode][0]),
    el("div", "living-subtitle", labelFor[mode][1])
  );
  const right = el("div", "living-top-right");
  const readout = el("div", "living-readout");
  const controls = el("nav", "living-controls");
  controls.setAttribute("aria-label", "Surface artwork controls");
  const pause = el("button", "living-control", "Pause");
  pause.type = "button";
  pause.setAttribute("aria-pressed", "false");
  const reset = el("button", "living-control", "Reseed");
  reset.type = "button";
  const exportBtn = el("button", "living-control", "Collect PNG");
  exportBtn.type = "button";
  controls.append(pause, reset, exportBtn);
  right.append(readout, controls);
  top.append(heading, right);

  const metrics = el("div", "living-metrics");
  const content = el("div", "living-content");
  const list = el("div", "living-list");
  content.append(list);

  const footer = el("footer", "living-footer");
  const hint = el("span", "", mode === "hungry_margins"
    ? "MOVE TO DISTURB / HOLD TO LET THE MARGINS FEED"
    : mode === "afterimage" ? "ONLY TRANSITIONS OBSERVED WHILE THIS VIEW IS OPEN BECOME ECHOES"
      : "LIVE CI STATE / EXPLORATORY VISUAL ENCODING");
  const sourceLabel = el("span", "", mode === "hungry_margins" ? "DERIVED FROM 037 / HUNGRY MARGINS" : "CISMON / LIVE");
  footer.append(hint, sourceLabel);
  overlay.append(top, metrics, content, footer);
  root.append(canvas, overlay);

  let seen = new Map();
  let events = [];
  let lastUpdate = null;
  let destroyed = false;
  const engine = createFunEngine(canvas, mode, (isPaused) => {
    pause.textContent = isPaused ? "Resume" : "Pause";
    pause.setAttribute("aria-pressed", String(isPaused));
  });

  pause.addEventListener("click", () => engine.pause(!engine.paused));
  reset.addEventListener("click", () => {
    seen = new Map();
    events = [];
    engine.reseed();
    if (lastUpdate) update(lastUpdate.rows, lastUpdate.state, lastUpdate.surface);
    readout.title = "The visual specimen and observed-while-open event record were reset.";
  });
  exportBtn.addEventListener("click", () => engine.exportPng());

  function update(rows, state, latestSurface) {
    if (destroyed) return;
    lastUpdate = { rows, state, surface: latestSurface };
    const counts = summarizeFunRows(rows);
    const clock = Number(state.updatedAt) ? new Date(state.updatedAt).toLocaleTimeString() : "—";
    const changed = observeTransitions(seen, rows, performance.now());
    seen = changed.next;
    events.push(...changed.changes);
    if (events.length > 32) events = events.slice(-32);

    readout.replaceChildren();
    if (mode === "hungry_margins") {
      const score = illustrativeCoherence(rows);
      readout.append(
        el("strong", "", "COHERENCE " + score.toFixed(3) + "%"),
        el("small", "", "ARTISTIC INDEX / NOT A HEALTH SCORE")
      );
    } else if (mode === "afterimage") {
      readout.append(el("strong", "", events.length + " OBSERVED ECHOES"));
    } else {
      readout.append(el("strong", "", counts.running + " RUNNING / " + counts.queued + " QUEUED"));
    }
    readout.append(el("small", "", "UPDATED " + clock));
    controls.hidden = latestSurface.showFunControls === false;
    metrics.replaceChildren(
      metric("RUNNING", counts.running),
      metric("QUEUED", counts.queued),
      metric("FAILURES", counts.failures),
      metric("ACTIVITY", counts.total, "MATCHED IN SURFACE")
    );

    if (mode === "lanes_plus") {
      renderLaneList(rows, list, openRun, formatDuration, latestSurface);
    } else {
      renderRunList(rows, mode, list, openRun, formatDuration, latestSurface);
    }

    if (!rows.length) {
      list.append(el("p", "living-no-runs", "NO RUNS MATCH CURRENT SURFACE FILTERS"));
    }

    for (const old of content.querySelectorAll(".living-echoes")) old.remove();
    if (mode === "afterimage" && events.length) {
      const timeline = el("aside", "living-echoes");
      timeline.append(el("h3", "", "OBSERVED STATE CHANGES"));
      for (const event of events.slice(-5).reverse()) {
        timeline.append(el("p", "", event.repository + " / " + event.from + " → " + event.to));
      }
      content.append(timeline);
    }

    engine.update(rows, latestSurface, changed.changes);
    const staticMode = engine.reduced || latestSurface.motion === "off";
    pause.disabled = staticMode;
    pause.textContent = staticMode ? "Static" : engine.paused ? "Resume" : "Pause";
    pause.setAttribute("aria-pressed", String(engine.paused));
  }

  return {
    id: surface.id,
    layout: mode,
    root,
    mount: () => engine.mount(),
    update,
    destroy: () => {
      destroyed = true;
      engine.destroy();
    }
  };
}
