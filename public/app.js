import { isFunLayout } from "/fun-core.js";
import { createFocusGrid } from "/focus-grid-view.js";
import { GRID_FIELDS, GRID_DATE_FORMATS, GRID_DEFAULT_WIDTH,
  normalizeGridFields, normalizePane, normalizeVertCount, normalizeVertPanes } from "/focus-grid.js";
import { createFunView } from "/fun-surfaces.js";
import {
  DEFAULT_SURFACES,
  SURFACE_FIELDS,
  filterRows,
  groupRows,
  sortRows,
  normalizeSurface,
  normalizeSurfaces
} from "/surfaces.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  providerState: $("#providerState"),
  repoCount: $("#repoCount"),
  scannedRepoCount: $("#scannedRepoCount"),
  trackedCount: $("#trackedCount"),
  liveCount: $("#liveCount"),
  visibleCount: $("#visibleCount"),
  rateRemaining: $("#rateRemaining"),
  syncAge: $("#syncAge"),
  syncBanner: $("#syncBanner"),
  updatedAt: $("#updatedAt"),
  telemetry: $("#telemetry"),
  errorBanner: $("#errorBanner"),
  scanBanner: $("#scanBanner"),
  dashboard: $("#dashboard"),
  emptyState: $("#emptyState"),
  emptyTitle: $("#emptyTitle"),
  emptyDetail: $("#emptyDetail"),
  summaryStrip: $("#summaryStrip"),
  minimalFooter: $("#minimalFooter"),
  minimalSummary: $("#minimalSummary"),
  surfaceTitle: $("#surfaceTitle"),
  surfaceSummary: $("#surfaceSummary"),
  surfaceMode: $("#surfaceMode"),
  surfaceBar: $("#surfaceBar"),
  surfaceTabs: $("#surfaceTabs"),
  main: $("#main"),
  detailDialog: $("#detailDialog"),
  detailTitle: $("#detailTitle"),
  detailMeta: $("#detailMeta"),
  detailActions: $("#detailActions"),
  detailBody: $("#detailBody"),
  settingsDialog: $("#settingsDialog"),
  settingsForm: $("#settingsForm"),
  settingsStatus: $("#settingsStatus"),
  surfaceDialog: $("#surfaceDialog"),
  surfaceForm: $("#surfaceForm"),
  surfaceStatus: $("#surfaceStatus"),
  surfaceEditorSelect: $("#surfaceEditorSelect")
};

let config = null;
let latestState = null;
let selectedRun = null;
let polling = false;
let pollTimer = null;
let editingSurfaces = [];
let editingSurfaceId = null;
let funView = null;
let gridInteracting = false;
const gridScroll = new Map();
const gridVerticalScroll = new Map();
let gridSaveQueue = Promise.resolve();
let editingPaneIndex = 0;
let minimalOnly = false;
let localSurfaceOverride = null;

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function badge(text, className) {
  return node("span", "badge " + (className || ""), String(text || "unknown").replaceAll("_", " "));
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days) return days + "d" + hours + "h";
  if (hours) return hours + "h" + minutes + "m";
  if (minutes) return minutes + "m" + seconds + "s";
  return seconds + "s";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
  return data;
}

function activeSurface() {
  const surfaces = config?.surfaces || DEFAULT_SURFACES;
  return surfaces.find((surface) => surface.id === (localSurfaceOverride || config?.activeSurfaceId)) || surfaces[0];
}

function displayRunState(row) {
  if (row.state === "completed") return row.conclusion;
  if (row.state === "in_progress" && row.providerState === "queued") {
    return "jobs active (" + (row.observedRunningJobs || 1) + ")";
  }
  return row.state;
}

function fieldMeta(row, field) {
  switch (field) {
    case "stage": return ["CURRENT STAGE", row.stage || "workflow", ""];
    case "state": return ["STATE", displayRunState(row),
      row.providerState !== row.state ? "GitHub: " + row.providerState : ""];
    case "elapsed": return [
      row.state === "queued" ? "WAITING" : "ELAPSED",
      row.state === "queued" ? formatDuration(row.waitingMs) :
        row.elapsedLowerBound ? "≥" + (row.elapsedMs ? formatDuration(row.elapsedMs) : "0s") :
          formatDuration(row.elapsedMs),
      row.elapsedLowerBound ? "since first observed running (lower bound)" : ""
    ];
    case "baseline": return ["MEDIAN", formatDuration(row.baselineMedianMs), row.baselineMedianMs ? row.confidence + " baseline" : "no baseline"];
    case "ratio": return ["RATIO", row.ratio ? row.ratio.toFixed(2) + "×" : "—", row.ratio >= 1.3 ? "above expected" : ""];
    case "remaining": return ["ETA", formatDuration(row.estimatedRemainingMs), row.possiblyStalled ? "possible stall" : ""];
    case "branch": return ["BRANCH", row.branch || "—", row.event || ""];
    case "confidence": return ["CONF", row.confidence || "none", row.baselineMedianMs ? "timing model" : ""];
    default: return [field.toUpperCase(), "—", ""];
  }
}

function stateBadge(row) {
  const text = displayRunState(row);
  const className = row.state === "completed" ? row.attention : row.state;
  return badge(text, className);
}

function renderIdentity(row, surface) {
  const identity = node("div", "identity");
  const primary = node("div", "primary");
  primary.append(node("span", "repository", row.repository));
  if (surface.showAttentionBadge) primary.append(badge(row.attention, row.attention));
  if (surface.showWatchFlags && row.manualWatch) primary.append(node("span", "flag", "WATCH"));
  if (surface.showStallFlag && row.possiblyStalled) primary.append(node("span", "flag", "STALL?"));
  identity.append(primary);

  const secondary = [
    row.workflow + " #" + row.runNumber,
    surface.fields.includes("branch") ? "" : row.branch,
    row.event
  ].filter(Boolean).join("  ·  ");
  identity.append(node("div", "workflow", secondary));
  return identity;
}

function renderRunCard(row, surface) {
  const card = node("button", "run-card");
  card.type = "button";
  card.dataset.attention = row.attention;
  card.dataset.layout = surface.layout;
  card.addEventListener("click", () => openDetail(row.repository, row.runId));

  const identityCell = node("div", "run-cell identity-cell");
  identityCell.append(renderIdentity(row, surface));
  card.append(identityCell);

  for (const field of surface.fields) {
    const [label, value, sub] = fieldMeta(row, field);
    const cell = node("div", "run-cell field-cell");
    cell.dataset.field = field;
    cell.append(node("span", "metric-label", label));
    if (field === "state") cell.append(stateBadge(row));
    else cell.append(node("span", "metric-value", value));
    if (sub) cell.append(node("span", "metric-sub", sub));
    card.append(cell);
  }
  return card;
}


function saveGridConfig() {
  const surfaces = config.surfaces;
  gridSaveQueue = gridSaveQueue.catch(() => {}).then(async () => {
    const next = await api("/api/display", {
      method: "PUT",
      body: JSON.stringify({ surfaces, activeSurfaceId: config.activeSurfaceId })
    });
    // The currently shown state may have switched while the request was pending.
    if (config.surfaces === surfaces) config = next;
  });
  gridSaveQueue.catch(error => {
    elements.errorBanner.hidden = false;
    elements.errorBanner.textContent = "Unable to persist grid settings: " + error.message;
  });
}

function changeGridOptions(paneIndex, changes, paneKind = "dual") {
  const current = activeSurface();
  if (!current) return;
  let next = { ...current };
  if (paneIndex >= 0) {
    const key = paneKind === "vert" ? "vertPanes" : "dualPanes";
    const panes = structuredClone(current[key]);
    if (!panes[paneIndex]) return;
    panes[paneIndex] = { ...panes[paneIndex], ...changes };
    next[key] = panes;
  } else {
    next = { ...next, ...changes };
  }
  config = { ...config, surfaces: config.surfaces.map(p => p.id === current.id ? next : p) };
  saveGridConfig();
  if (latestState && !gridInteracting) renderDashboard(latestState);
}

function targetSortSecondary(paneIndex, paneKind) {
  const current = activeSurface();
  const target = paneIndex < 0 ? current :
    current[paneKind === "vert" ? "vertPanes" : "dualPanes"][paneIndex];
  return target?.gridSortSecondaryBy || "";
}

function gridCallbacks(surface, paneIndex = -1, paneKind = "dual") {
  const key = surface.id + ":" + paneKind + ":" + paneIndex;
  return {
    onOpen: openDetail,
    onInteracting: value => { gridInteracting = value; },
    getScroll: () => gridScroll.get(key) || 0,
    onScroll: value => gridScroll.set(key, value),
    getScrollTop: () => gridVerticalScroll.get(key) || 0,
    onScrollTop: value => gridVerticalScroll.set(key, value),
    onWidth: (field, width) => {
      const current = activeSurface();
      const target = paneIndex < 0 ? current :
        current[paneKind === "vert" ? "vertPanes" : "dualPanes"][paneIndex];
      changeGridOptions(paneIndex, {
        gridWidths: { ...target.gridWidths, [field]: width }
      }, paneKind);
    },
    onSort: (field, direction) => changeGridOptions(paneIndex, {
      gridSortBy: field, gridSortDir: direction,
      gridSortSecondaryBy: field === targetSortSecondary(paneIndex, paneKind) ? "" :
        targetSortSecondary(paneIndex, paneKind)
    }, paneKind),
    onSecondarySort: (field, direction) => {
      const current = activeSurface();
      const target = paneIndex < 0 ? current :
        current[paneKind === "vert" ? "vertPanes" : "dualPanes"][paneIndex];
      changeGridOptions(paneIndex, {
        gridSortSecondaryBy: field === target.gridSortBy ? "" : field,
        gridSortSecondaryDir: direction
      }, paneKind);
    },
    onLock: (field, locked) => {
      const current = activeSurface();
      const target = paneIndex < 0 ? current :
        current[paneKind === "vert" ? "vertPanes" : "dualPanes"][paneIndex];
      const locks = new Set(target.gridLockedWidths || []);
      if (locked) locks.add(field); else locks.delete(field);
      changeGridOptions(paneIndex, { gridLockedWidths: [...locks] }, paneKind);
    },
    onReorder: fields => changeGridOptions(paneIndex, { gridFields: fields }, paneKind)
  };
}

function focusDualRows(all, pane, parent, index) {
  const filters = {
    ...parent, ...pane,
    // The pane controls its own status and attention filters.
    repositoryPatterns: pane.repositoryPatterns,
    workflowPatterns: pane.workflowPatterns,
    eventPatterns: pane.eventPatterns
  };
  return sortRows(filterRows(all, filters), { ...filters, sort: "priority" })
    .slice(0, pane.maxItems);
}

function renderFocusDual(all, surface) {
  const root = node("section", "focus-dual");
  let visible = 0;
  const displayed = [];
  surface.dualPanes.forEach((pane, index) => {
    const section = node("section", "focus-dual-pane");
    section.dataset.density = pane.density || surface.density;
    const selected = focusDualRows(all, pane, surface, index);
    visible += selected.length;
    displayed.push(...selected);
    const title = node("header", "focus-dual-header");
    title.append(
      node("strong", "", pane.name),
      node("small", "", selected.length + " displayed")
    );
    section.append(title, createFocusGrid(
      selected,
      { ...surface, ...pane },
      gridCallbacks(surface, index),
      surface.name + " / " + pane.name
    ));
    root.append(section);
  });
  return { root, visible, displayed };
}

function renderFocusVert(all, surface) {
  const root = node("section", "focus-vert");
  root.setAttribute("aria-label", surface.name + " stacked Focus grids");
  let visible = 0;
  const displayed = [];
  surface.vertPanes.forEach((pane, index) => {
    const section = node("section", "focus-vert-pane");
    section.dataset.density = pane.density || surface.density;
    section.style.height = pane.heightValue + pane.heightUnit;
    section.setAttribute("aria-label", pane.name);
    const selected = focusDualRows(all, pane, surface, index);
    visible += selected.length;
    displayed.push(...selected);
    const title = node("header", "focus-dual-header focus-vert-header");
    title.append(
      node("strong", "", pane.name),
      node("small", "", selected.length + " runs · " +
        pane.heightValue + (pane.heightUnit === "vh" ? "% viewport" : "px"))
    );
    section.append(title, createFocusGrid(
      selected, { ...surface, ...pane },
      gridCallbacks(surface, index, "vert"),
      surface.name + " / " + pane.name
    ));
    if (!selected.length) {
      section.append(node("p", "focus-pane-empty", "No workflow runs match this pane's filters."));
    }
    root.append(section);
  });
  return { root, visible, displayed };
}

function renderTable(rows, surface) {
  const wrap = node("div", "table-wrap");
  const table = node("table", "surface-table");
  const thead = node("thead");
  const header = node("tr");
  header.append(node("th", "", "Repository / workflow"));
  for (const field of surface.fields) header.append(node("th", "", fieldMeta({}, field)[0]));
  thead.append(header);
  table.append(thead);

  const tbody = node("tbody");
  for (const row of rows) {
    const tr = node("tr");
    tr.tabIndex = 0;
    tr.dataset.attention = row.attention;
    tr.addEventListener("click", () => openDetail(row.repository, row.runId));
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") openDetail(row.repository, row.runId);
    });

    const identity = node("td");
    identity.append(renderIdentity(row, surface));
    tr.append(identity);

    for (const field of surface.fields) {
      const [, value, sub] = fieldMeta(row, field);
      const cell = node("td");
      if (field === "state") cell.append(stateBadge(row));
      else {
        cell.append(node("span", "table-value", value));
        if (sub) cell.append(node("span", "table-sub", sub));
      }
      tr.append(cell);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  return wrap;
}

function renderGroups(rows, surface) {
  const groups = groupRows(rows, surface);
  const fragment = document.createDocumentFragment();

  for (const group of groups) {
    const section = node("section", "surface-group");
    if (group.label) {
      const heading = node("header", "group-header");
      heading.append(node("span", "", group.label), node("span", "group-count", String(group.rows.length)));
      section.append(heading);
    }

    const container = node("div", surface.layout === "lanes" ? "lane-items" : "group-items");
    for (const row of group.rows) container.append(renderRunCard(row, surface));
    section.append(container);
    fragment.append(section);
  }
  return fragment;
}

function renderDashboard(state) {
  latestState = state;
  const surface = activeSurface();
  // Polling may continue while a user drags a resize divider. Do not destroy
  // the captured DOM node until the pointer is released.
  if (gridInteracting && ["rows", "table", "focus_dual", "focus_vert"].includes(surface.layout)) return;
  const matchedRows = filterRows(state.rows || [], surface);
  const orderedRows = sortRows(matchedRows, surface);
  const rows = orderedRows.slice(0, surface.maxItems);
  let displayedRows = rows;

  elements.visibleCount.textContent =
    matchedRows.length > rows.length ? rows.length + "/" + matchedRows.length : String(rows.length);
  const fun = isFunLayout(surface.layout);
  if (!fun && funView) {
    funView.destroy();
    funView = null;
  }
  if (!fun) elements.dashboard.replaceChildren();
  elements.dashboard.className = "dashboard layout-" + surface.layout + " density-" + surface.density;
  elements.emptyState.hidden = fun || rows.length !== 0;

  if (rows.length === 0) {
    if (state.repositorySelectionMode === "activity" &&
        state.pendingActivityProbeCount > 0) {
      elements.emptyTitle.textContent = "Checking workflow activity…";
      elements.emptyDetail.textContent =
        state.pendingActivityProbeCount + " eligible repositories awaiting activity probes. " +
        state.repositoryCount + " admitted to monitoring so far.";
    } else if (state.repositorySelectionMode === "activity" &&
        state.repositoryCount === 0 && state.candidateRepositoryCount > 0) {
      elements.emptyTitle.textContent = "No active repositories admitted.";
      elements.emptyDetail.textContent =
        "No recently updated GitHub Actions workflows matched the " +
        (config.activeAgeDays || 7) + "-day window. Inactive repositories are rechecked.";
    } else if (state.scannedRepositoryCount < state.repositoryCount) {
      elements.emptyTitle.textContent = "Scanning repositories…";
      elements.emptyDetail.textContent =
        state.scannedRepositoryCount + " of " + state.repositoryCount +
        " checked; queued/running actions can be missing until their repository has been scanned.";
    } else if (state.dashboardCandidateCount > 0) {
      elements.emptyTitle.textContent = "No runs match this surface.";
      elements.emptyDetail.textContent =
        state.dashboardCandidateCount + " CISmon-visible runs are tracked but hidden by this surface's filters.";
    } else if (state.trackedRunCount > 0) {
      elements.emptyTitle.textContent = "No currently visible runs.";
      elements.emptyDetail.textContent =
        state.trackedRunCount + " runs remain in working memory, but none currently meet CISmon visibility rules.";
    } else {
      elements.emptyTitle.textContent = "No workflow activity discovered.";
      elements.emptyDetail.textContent =
        "All " + state.repositoryCount + " repositories have been scanned; use Rescan if GitHub shows newer activity.";
    }
  }

  if (fun) {
    if (!funView || funView.id !== surface.id || funView.layout !== surface.layout) {
      funView?.destroy();
      elements.dashboard.replaceChildren();
      funView = createFunView(surface, openDetail, formatDuration);
      elements.dashboard.append(funView.root);
      funView.mount();
    }
    funView.update(rows, state, surface);
  } else if (surface.layout === "focus_dual" || surface.layout === "focus_vert") {
    const { root, visible, displayed } = surface.layout === "focus_vert"
      ? renderFocusVert(state.rows || [], surface)
      : renderFocusDual(state.rows || [], surface);
    elements.dashboard.append(root);
    elements.visibleCount.textContent = String(visible);
    displayedRows = displayed;
    elements.emptyState.hidden = true;
  } else if (surface.layout === "table" || surface.layout === "rows") {
    elements.dashboard.append(createFocusGrid(rows, surface, gridCallbacks(surface), surface.name));
  } else {
    elements.dashboard.append(renderGroups(rows, surface));
  }

  const counts = {
    active: displayedRows.filter((row) => row.state === "in_progress").length,
    queued: displayedRows.filter((row) => row.state === "queued").length,
    alerts: displayedRows.filter((row) => row.attention === "action_required").length,
    suspicious: displayedRows.filter((row) => row.attention === "suspicious").length
  };
  const workerCount = Number(state.activeWorkers || 0);
  const workerLabel = workerCount + (state.activeWorkersPartial ? "+" : "") + " active workers";
  elements.surfaceSummary.title = state.activeWorkersPartial
    ? workerCount + " confirmed occupied runner slots; job detail received for " +
      (state.workerCoverageRuns || 0) + "/" + (state.workerTotalLiveRuns || 0) +
      " queued/running workflows (all available job pages). Actual count may be higher."
    : workerCount + " confirmed in-progress Actions jobs occupying runner slots " +
      "across queued and running workflows.";
  elements.surfaceSummary.textContent =
    workerLabel + " · " + displayedRows.length + " shown" +
    (!["focus_dual", "focus_vert"].includes(surface.layout) && matchedRows.length > rows.length ? " of " + matchedRows.length + " matching" : "") +
    " · " + counts.active + " running · " + counts.queued +
    " queued · " + counts.suspicious + " suspicious · " + counts.alerts + " action required";
  elements.minimalSummary.textContent = elements.surfaceSummary.textContent;
  elements.minimalSummary.title = elements.surfaceSummary.title;
}

function applySurfaceVisuals() {
  const surface = activeSurface();
  document.body.dataset.theme = surface.theme;
  document.body.dataset.density = surface.density;
  document.body.classList.toggle("surface-hide-chrome", surface.hideChrome);
  document.body.classList.toggle("surface-hide-topbar", surface.hideChrome && !surface.showTelemetry);
  elements.main.classList.toggle("full-width", surface.fullWidth || minimalOnly);
  document.body.classList.toggle("minimal-only", minimalOnly);
  $("#exitBorderlessButton").hidden = !minimalOnly;
  elements.minimalFooter.hidden = !minimalOnly;
  elements.telemetry.hidden = !surface.showTelemetry;
  elements.summaryStrip.hidden = !surface.showSummary;
  elements.surfaceBar.hidden = surface.hideChrome;
  elements.errorBanner.hidden = !surface.showError || !latestState?.lastError;
  elements.surfaceTitle.textContent = surface.name;
  elements.surfaceMode.textContent =
    surface.layout + " · " + surface.density + " · " + surface.sort +
    (surface.groupBy !== "none" ? " · grouped " + surface.groupBy : "");
}

function renderSurfaceTabs() {
  elements.surfaceTabs.replaceChildren();
  for (const surface of config.surfaces) {
    const button = node("button", "surface-tab" + (surface.id === (localSurfaceOverride || config.activeSurfaceId) ? " active" : ""), surface.name);
    button.type = "button";
    button.dataset.surfaceId = surface.id;
    button.addEventListener("click", () => switchSurface(surface.id));
    elements.surfaceTabs.append(button);
  }
}

async function switchSurface(surfaceId) {
  if (!config.surfaces.some((surface) => surface.id === surfaceId)) return;
  localSurfaceOverride = surfaceId;
  if (!minimalOnly) try {
    config = await api("/api/display", {
      method: "PUT",
      body: JSON.stringify({ activeSurfaceId: surfaceId })
    });
  } catch (error) {
    elements.errorBanner.hidden = false;
    elements.errorBanner.textContent = error.message;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("surface", surfaceId);
  history.replaceState(null, "", url);
  renderSurfaceTabs();
  applySurfaceVisuals();
  if (latestState) renderDashboard(latestState);
  schedulePoll();
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return "<1s";
  if (ms < 60000) return Math.floor(ms / 1000) + "s";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m";
  return Math.floor(ms / 3600000) + "h";
}

function renderSyncHealth(state) {
  const mode = state.syncStatus || (state.providerReady ? "online" : "offline");
  const indicator = {
    online: "ONLINE", scanning: "SCANNING", stale: "STALE",
    degraded: "DEGRADED", rate_limited: "PAUSED", offline: "OFFLINE"
  };
  elements.providerState.textContent = indicator[mode] || "UNKNOWN";
  elements.syncAge.textContent = formatAge(
    state.oldestLiveSummaryAgeMs ?? state.oldestRepoSummaryAgeMs
  );
  let warning = "";
  if (mode === "rate_limited") {
    const remaining = Math.max(0, (state.rateLimitedUntil || 0) - Date.now());
    warning = "GitHub API rate-limited. Polling paused for " +
      formatAge(remaining) + ". " + (state.rateLimitReason || "") +
      ". Existing workflow data is cached and may be stale.";
  } else if (mode === "stale") {
    warning = "Live workflow states are stale: the slowest active repository was last confirmed " +
      formatAge(state.oldestLiveSummaryAgeMs) + " ago. GitHub may have newer queued/running/completed states. Polling continues.";
  } else if (mode === "degraded") {
    warning = "GitHub API requests are degraded; some workflow stages may lag. " +
      (state.ongoingDetailFailures
        ? state.ongoingDetailFailures + " active job-detail requests are retrying. "
        : "") +
      (state.failedInitialScanCount
        ? state.failedInitialScanCount + " repositories have not yet returned a successful workflow summary. "
        : "") +
      (state.lastError || "Retrying failed requests with backoff.");
  } else if (state.rateRemaining >= 0 && state.rateRemaining <= 500) {
    warning = "GitHub API quota is low (" + state.rateRemaining +
      " remaining). The scheduler may need to back off.";
  }
  elements.syncBanner.hidden = !warning;
  elements.syncBanner.dataset.sync = mode;
  elements.syncBanner.textContent = warning;
}

async function pollState() {
  if (polling) return;
  polling = true;
  try {
    const state = await api("/api/state");
    renderSyncHealth(state);
    elements.repoCount.textContent = String(state.repositoryCount);
    elements.repoCount.title = state.repositorySelectionMode === "activity"
      ? state.repositoryCount + " watched / " + state.candidateRepositoryCount +
        " eligible repositories (activity-based)"
      : state.repositoryCount + " watched repositories";
    elements.scannedRepoCount.textContent =
      String(state.scannedRepositoryCount) + "/" + String(state.repositoryCount);
    elements.trackedCount.textContent = String(state.trackedRunCount);
    elements.liveCount.textContent =
      String(state.trackedActiveCount) + "/" + String(state.trackedQueuedCount);
    elements.rateRemaining.textContent = state.rateRemaining >= 0 ? String(state.rateRemaining) : "—";
    elements.updatedAt.textContent = new Date(state.updatedAt).toLocaleTimeString();

    const surface = activeSurface();
    elements.errorBanner.hidden = !surface.showError || !state.lastError;
    elements.errorBanner.textContent = state.lastError || "";
    elements.errorBanner.dataset.kind = /HTTP 50[0-9]|request timeout|network request failed/.test(state.lastError || "")
      ? "transient" : "error";

    const pendingActivity = state.repositorySelectionMode === "activity" &&
      (state.pendingActivityProbeCount || 0) > 0;
    const incomplete = state.scannedRepositoryCount < state.repositoryCount;
    const unfinished = state.pendingSweepCount > 0 ||
      state.attemptedRepositoryCount < state.repositoryCount;
    elements.scanBanner.hidden = !incomplete && !pendingActivity;
    elements.scanBanner.textContent = pendingActivity
      ? "Activity-based discovery: " + state.repositoryCount + "/" +
        state.candidateRepositoryCount + " repositories admitted; " +
        state.pendingActivityProbeCount + " awaiting workflow-activity checks (age " +
        (config.activeAgeDays || 7) + " days)."
      : incomplete
      ? unfinished
        ? "Repository sweep " + state.scannedRepositoryCount + "/" + state.repositoryCount +
          " confirmed · " + state.pendingSweepCount + " pending" +
          ". Workflow discovery remains incomplete."
        : state.failedInitialScanCount + " repositories failed initial workflow acquisition." +
          " Retries continue with exponential backoff; their live states are unknown."
      : "";

    renderDashboard(state);

    if (selectedRun && elements.detailDialog.open) {
      await renderDetail(selectedRun.repository, selectedRun.runId, false);
    }
  } catch (error) {
    elements.providerState.textContent = "ERROR";
    elements.errorBanner.hidden = false;
    elements.errorBanner.textContent = error.message;
  } finally {
    polling = false;
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const delay = activeSurface()?.refreshMs || 2000;
  pollTimer = setTimeout(async () => {
    await pollState();
    schedulePoll();
  }, delay);
}

function analysisGrid(analysis) {
  const grid = node("div", "analysis-grid");
  const values = [
    ["ATTENTION", analysis.attention.replaceAll("_", " ")],
    ["ELAPSED", formatDuration(analysis.elapsedMs)],
    ["MEDIAN", formatDuration(analysis.baseline?.median || 0)],
    ["RUN ETA", formatDuration(analysis.estimatedRemainingMs)],
    ["P25 / P75", formatDuration(analysis.baseline?.p25 || 0) + " / " + formatDuration(analysis.baseline?.p75 || 0)],
    ["MAD", formatDuration(analysis.baseline?.mad || 0)],
    ["EWMA", formatDuration(analysis.baseline?.ewma || 0)],
    ["RATIO", analysis.ratio ? analysis.ratio.toFixed(2) + "×" : "—"],
    ["ROBUST Z", Number.isFinite(analysis.z) ? analysis.z.toFixed(2) : "—"],
    ["CONFIDENCE", analysis.confidence],
    ["SAMPLES", String(analysis.baseline?.samples || 0)]
  ];
  for (const [label, value] of values) {
    const cell = node("div");
    cell.append(node("span", "metric-label", label), node("strong", "", value));
    grid.append(cell);
  }
  return grid;
}

function actionButton(label, handler, secondary = false) {
  const button = node("button", "button" + (secondary ? " secondary" : ""), label);
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}

async function renderDetail(repository, runId, show = true) {
  const detail = await api("/api/run?repository=" + encodeURIComponent(repository) + "&runId=" + encodeURIComponent(runId));
  selectedRun = { repository, runId };
  elements.detailTitle.textContent = detail.repository + " / " + detail.workflowName + " #" + detail.runNumber;
  elements.detailMeta.textContent = [
    detail.event,
    detail.branch,
    detail.headSha ? detail.headSha.slice(0, 10) : "",
    detail.providerState === "queued" && detail.state === "in_progress"
      ? "GitHub queued · " + detail.observedRunningJobs + " executing jobs"
      : "",
    detail.jobsCoverageComplete === false ? "Job scan incomplete" : ""
  ].filter(Boolean).join("  ·  ");

  elements.detailActions.replaceChildren();
  elements.detailActions.append(actionButton(detail.manualWatch ? "Stop watching" : "Watch run", async () => {
    await api("/api/watch", {
      method: "POST",
      body: JSON.stringify({ repository, runId, watched: !detail.manualWatch })
    });
    await renderDetail(repository, runId, false);
    await pollState();
  }, true));

  if (!detail.acknowledged && detail.analysis.attention === "action_required") {
    elements.detailActions.append(actionButton("Acknowledge failure", async () => {
      await api("/api/acknowledge", {
        method: "POST",
        body: JSON.stringify({ repository, runId })
      });
      elements.detailDialog.close();
      selectedRun = null;
      await pollState();
    }));
  }

  if (detail.htmlUrl) {
    const link = node("a", "button secondary", "Open on GitHub");
    link.href = detail.htmlUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    elements.detailActions.append(link);
  }

  elements.detailBody.replaceChildren(analysisGrid(detail.analysis));
  for (const job of detail.jobs || []) {
    const block = node("section", "job");
    const header = node("div", "job-header");
    header.append(
      node("div", "job-name", job.name + (job.runnerName ? "  ·  " + job.runnerName : "")),
      badge(job.state === "completed" ? job.conclusion : job.state, job.state),
      node("span", "metric-sub", formatDuration(job.analysis.elapsedMs))
    );
    block.append(header);

    const steps = node("div", "steps");
    for (const step of job.steps || []) {
      const row = node("div", "step");
      row.append(
        node("span", "step-number", String(step.number).padStart(2, "0")),
        node("span", "", step.name),
        badge(step.state === "completed" ? step.conclusion : step.state, step.state),
        node("span", "step-duration", formatDuration(step.analysis.elapsedMs))
      );
      steps.append(row);
    }
    if (!(job.steps || []).length) steps.append(node("div", "step", "No step detail returned."));
    block.append(steps);
    elements.detailBody.append(block);
  }

  if (!(detail.jobs || []).length) {
    elements.detailBody.append(node("p", "metric-sub", "Job details have not been fetched yet."));
  }
  if (show && !elements.detailDialog.open) elements.detailDialog.showModal();
}

async function openDetail(repository, runId) {
  try {
    await renderDetail(repository, runId, true);
  } catch (error) {
    elements.errorBanner.hidden = false;
    elements.errorBanner.textContent = error.message;
  }
}

async function openSettings() {
  config = await api("/api/config");
  $("#githubToken").value = "";
  $("#githubOwner").value = config.githubOwner || "";
  $("#maxRepositories").value = config.maxRepositories;
  $("#repositorySelectionMode").value = config.repositorySelectionMode || "activity";
  $("#activeAgeDays").value = config.activeAgeDays || 7;
  $("#historyDepth").value = config.historyDepth;
  $("#backfillRunsPerRepo").value = config.backfillRunsPerRepo;
  $("#includePatterns").value = (config.includePatterns || []).join("\n");
  $("#excludePatterns").value = (config.excludePatterns || []).join("\n");
  $("#clearGithubToken").checked = false;
  $("#tokenState").textContent = config.hasGithubToken
    ? "A token is stored locally. Leave blank to keep it."
    : "No token stored.";
  const monitorState = latestState || await api("/api/state");
  $("#watchedRepoList").textContent =
    (monitorState.watchedRepositories || []).join("\n") ||
    "No repositories currently admitted; activity probes may still be running.";

  elements.settingsStatus.textContent = "";
  elements.settingsDialog.showModal();
}

function updateSurfaceEditorSelect(selectedId) {
  elements.surfaceEditorSelect.replaceChildren();
  for (const surface of editingSurfaces) {
    const option = node("option", "", surface.name);
    option.value = surface.id;
    option.selected = surface.id === selectedId;
    elements.surfaceEditorSelect.append(option);
  }
}


function fillSortOptions(select) {
  select.replaceChildren();
  for (const [id, label] of [["priority", "CI priority"], ...GRID_FIELDS.map(([key, title]) => [key, title])]) {
    const option = node("option", "", label);
    option.value = id;
    select.append(option);
  }
}

function writeFieldEditor(selector, fields) {
  const container = $(selector);
  container.replaceChildren();
  const ordered = normalizeGridFields(fields);
  const order = [...ordered, ...GRID_FIELDS.map(([id]) => id).filter(id => !ordered.includes(id))];
  for (const field of order) {
    const label = node("label", "grid-field-chip");
    label.draggable = true;
    label.dataset.field = field;
    const checkbox = node("input");
    checkbox.type = "checkbox";
    checkbox.checked = ordered.includes(field);
    checkbox.dataset.gridField = field;
    label.append(checkbox, node("span", "", GRID_FIELDS.find(([key]) => key === field)?.[1] || field));
    label.addEventListener("dragstart", event => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", field);
    });
    label.addEventListener("dragover", event => event.preventDefault());
    label.addEventListener("drop", event => {
      event.preventDefault();
      const dragged = event.dataTransfer.getData("text/plain");
      const source = [...container.children].find(el => el.dataset.field === dragged);
      if (source && source !== label) container.insertBefore(source, label);
    });
    container.append(label);
  }
}
// Applying changes is a draft-only operation: target names and Vert heights
// are retained, and normal Save surfaces persists all profiles together.
const COPIED_FOCUS_FIELDS = [
  "repositoryPatterns", "workflowPatterns", "eventPatterns", "minAttention",
  "showInProgress", "showQueued", "showSuccess", "showFailures",
  "showOtherCompleted", "watchedOnly", "stallsOnly", "maxItems",
  "gridFields", "gridWidths", "gridRowLines", "gridOverflowMode",
  "gridHeaderOverflowMode", "gridBreakAfterSeparators", "gridSortBy", "gridSortDir",
  "gridSortSecondaryBy", "gridSortSecondaryDir", "gridLockedWidths",
  "gridAddedFormat", "gridUpdatedFormat", "gridAddedPattern", "gridUpdatedPattern"
];
function currentFocusSource() {
  const source = editingSurfaces.find(surface => surface.id === editingSurfaceId);
  if (!source) return null;
  if (source.layout === "focus_dual") return source.dualPanes[editingPaneIndex];
  if (source.layout === "focus_vert") return source.vertPanes[editingPaneIndex];
  return source;
}
function applyFocusToPanel(destinationId, kind, index) {
  commitEditorFormToDraft();
  const source = currentFocusSource();
  const destination = editingSurfaces.find(item => item.id === destinationId);
  if (!source || !destination) return;
  const field = kind === "vert" ? "vertPanes" : "dualPanes";
  if (!destination[field]?.[index]) return;
  const patch = Object.fromEntries(
    COPIED_FOCUS_FIELDS.filter(key => Object.prototype.hasOwnProperty.call(source, key))
      .map(key => [key, structuredClone(source[key])])
  );
  // Preserve destination-specific name and physical panel dimensions.
  const original = destination[field][index];
  const newPanel = { ...original, ...patch };
  destination[field][index] = kind === "vert"
    ? normalizeVertPanes(destination[field].map((panel, i) => i === index ? newPanel : panel),
      destination.vertCount, destination)[index]
    : normalizePane(newPanel, index, destination);
  elements.surfaceStatus.textContent = "Copied to " + destination.name +
    " / " + original.name + ". Save surfaces to persist.";
  renderFocusCopyTargets();
}
function renderFocusCopyTargets() {
  const target = $("#focusCopyTargets");
  target.replaceChildren();
  for (const surface of editingSurfaces) {
    const kind = surface.layout === "focus_vert" ? "vert" :
      surface.layout === "focus_dual" ? "dual" : null;
    if (!kind) continue;
    const panes = kind === "vert" ? surface.vertPanes : surface.dualPanes;
    for (let i = 0; i < panes.length; i++) {
      if (surface.id === editingSurfaceId && editingPaneIndex === i) continue;
      const button = node("button", "button secondary",
        surface.name + " / " + panes[i].name);
      button.type = "button";
      button.addEventListener("click", () => applyFocusToPanel(surface.id, kind, i));
      target.append(button);
    }
  }
  if (!target.children.length) target.append(node("span", "surface-help",
    "No other Focus Dual or Focus Vert panels available."));
}

function readFieldEditor(selector) {
  return [...$(selector).querySelectorAll(".grid-field-chip")]
    .filter(chip => chip.querySelector("input").checked)
    .map(chip => chip.dataset.field);
}

function writePaneForm(pane) {
  $("#dualPaneName").value = pane.name;
  $("#dualPaneSort").value = pane.gridSortBy;
  $("#dualPaneDirection").value = pane.gridSortDir;
  $("#dualPaneSecondarySort").value = pane.gridSortSecondaryBy || "";
  $("#dualPaneSecondaryDirection").value = pane.gridSortSecondaryDir || "desc";
  $("#dualPaneAddedDateFormat").value = pane.gridAddedFormat || "short";
  $("#dualPaneUpdatedDateFormat").value = pane.gridUpdatedFormat || "short";
  $("#dualPaneAddedDatePattern").value = pane.gridAddedPattern || "YYYY-MM-DD HH:mm";
  $("#dualPaneUpdatedDatePattern").value = pane.gridUpdatedPattern || "YYYY-MM-DD HH:mm";
  $("#dualPaneMax").value = pane.maxItems;
  $("#dualPaneRowHeight").value = pane.gridRowLines ?? 0;
  $("#dualPaneHeaderOverflow").value = pane.gridHeaderOverflowMode || "ellipsis";
  $("#dualPaneDensity").value = pane.density || "compact";
  $("#dualPaneAttention").value = pane.minAttention;
  $("#dualPaneOverflow").value = pane.gridOverflowMode || (pane.gridWrap ? "wrap" : "ellipsis");
  $("#dualPaneBreakAfterSeparators").checked = pane.gridBreakAfterSeparators !== false;
  $("#vertPaneHeightUnit").value = pane.heightUnit || "vh";
  $("#vertPaneHeightValue").value = pane.heightValue || 42;
  updateVertHeightRange();
  $("#dualPaneRepositories").value = pane.repositoryPatterns.join("\n");
  $("#dualPaneWorkflows").value = pane.workflowPatterns.join("\n");
  $("#dualPaneEvents").value = pane.eventPatterns.join("\n");
  for (const [key, selector] of Object.entries({
    showInProgress:"dualPaneRunning",showQueued:"dualPaneQueued",
    showSuccess:"dualPaneSuccess",showFailures:"dualPaneFailures",
    showOtherCompleted:"dualPaneOther",watchedOnly:"dualPaneWatched",stallsOnly:"dualPaneStalls"
  })) $("#"+selector).checked = pane[key];
  writeFieldEditor("#dualGridFieldEditor", pane.gridFields);
}
function updateVertHeightRange() {
  const unit = $("#vertPaneHeightUnit").value;
  const element = $("#vertPaneHeightValue");
  element.min = unit === "px" ? "120" : "10";
  element.max = unit === "px" ? "1600" : "100";
}

function commitPaneForm() {
  const surface = editingSurfaces.find(item => item.id === editingSurfaceId);
  if (!surface || $("#dualPaneSection").hidden) return;
  const vertical = surface.layout === "focus_vert";
  const key = vertical ? "vertPanes" : "dualPanes";
  const list = [...surface[key]];
  const original = list[editingPaneIndex];
  if (!original) return;
  const value = {
    ...original,
    name: $("#dualPaneName").value,
    gridSortBy: $("#dualPaneSort").value,
    gridSortDir: $("#dualPaneDirection").value,
    gridSortSecondaryBy: $("#dualPaneSecondarySort").value,
    gridSortSecondaryDir: $("#dualPaneSecondaryDirection").value,
    gridAddedFormat: $("#dualPaneAddedDateFormat").value,
    gridUpdatedFormat: $("#dualPaneUpdatedDateFormat").value,
    gridAddedPattern: $("#dualPaneAddedDatePattern").value,
    gridUpdatedPattern: $("#dualPaneUpdatedDatePattern").value,
    maxItems: Number($("#dualPaneMax").value),
    gridRowLines: Number($("#dualPaneRowHeight").value),
    gridHeaderOverflowMode: $("#dualPaneHeaderOverflow").value,
    density: $("#dualPaneDensity").value,
    minAttention: $("#dualPaneAttention").value,
    gridWrap: $("#dualPaneOverflow").value === "wrap",
    gridOverflowMode: $("#dualPaneOverflow").value,
    gridBreakAfterSeparators: $("#dualPaneBreakAfterSeparators").checked,
    repositoryPatterns: $("#dualPaneRepositories").value,
    workflowPatterns: $("#dualPaneWorkflows").value,
    eventPatterns: $("#dualPaneEvents").value,
    showInProgress: $("#dualPaneRunning").checked,
    showQueued: $("#dualPaneQueued").checked,
    showSuccess: $("#dualPaneSuccess").checked,
    showFailures: $("#dualPaneFailures").checked,
    showOtherCompleted: $("#dualPaneOther").checked,
    watchedOnly: $("#dualPaneWatched").checked,
    stallsOnly: $("#dualPaneStalls").checked,
    gridFields: readFieldEditor("#dualGridFieldEditor")
  };
  if (vertical) {
    value.heightUnit = $("#vertPaneHeightUnit").value;
    value.heightValue = Number($("#vertPaneHeightValue").value);
    list[editingPaneIndex] = normalizeVertPanes(
      list.map((pane, i) => i === editingPaneIndex ? value : pane),
      surface.vertCount, surface
    )[editingPaneIndex];
  } else {
    list[editingPaneIndex] = normalizePane(value, editingPaneIndex, surface);
  }
  surface[key] = list;
}

function updateDualSection(surface) {
  const vertical = surface.layout === "focus_vert";
  const multiple = vertical || surface.layout === "focus_dual";
  $("#dualPaneSection").hidden = !multiple;
  $("#focusGridSection").hidden = !["rows","table","focus_dual","focus_vert"].includes(surface.layout);
  $("#vertPaneCountGroup").hidden = !vertical;
  $("#vertPaneHeightGroup").hidden = !vertical;
  $("#paneEditorTitle").textContent = vertical
    ? "Focus Vert · independent stacked pane settings"
    : "Focus Dual · independent pane settings";
  if (!multiple) return;
  const count = vertical ? surface.vertCount : 2;
  if (editingPaneIndex >= count) editingPaneIndex = count - 1;
  const select = $("#dualPaneSelect");
  select.replaceChildren();
  for (let index = 0; index < count; index++) {
    const option = node("option", "",
      vertical ? "Pane " + (index + 1) :
        index === 0 ? "Left pane" : "Right pane");
    option.value = String(index);
    select.append(option);
  }
  $("#vertPaneCount").value = String(surface.vertCount);
  select.value = String(editingPaneIndex);
  writePaneForm((vertical ? surface.vertPanes : surface.dualPanes)[editingPaneIndex]);
}

function writeSurfaceForm(surface) {
  $("#surfaceName").value = surface.name;
  $("#surfaceGridOverflow").value = surface.gridOverflowMode || (surface.gridWrap ? "wrap" : "ellipsis");
  $("#surfaceGridBreakAfterSeparators").checked = surface.gridBreakAfterSeparators !== false;
  $("#surfaceGridSort").value = surface.gridSortBy;
  $("#surfaceGridRowHeight").value = surface.gridRowLines ?? 0;
  $("#surfaceHeaderOverflow").value = surface.gridHeaderOverflowMode || "ellipsis";
  $("#surfaceGridDirection").value = surface.gridSortDir;
  $("#surfaceGridSecondarySort").value = surface.gridSortSecondaryBy || "";
  $("#surfaceGridSecondaryDirection").value = surface.gridSortSecondaryDir || "desc";
  $("#surfaceAddedDateFormat").value = surface.gridAddedFormat || "short";
  $("#surfaceUpdatedDateFormat").value = surface.gridUpdatedFormat || "short";
  $("#surfaceAddedDatePattern").value = surface.gridAddedPattern || "YYYY-MM-DD HH:mm";
  $("#surfaceUpdatedDatePattern").value = surface.gridUpdatedPattern || "YYYY-MM-DD HH:mm";
  writeFieldEditor("#gridFieldEditor", surface.gridFields);
  updateDualSection(surface);
  renderFocusCopyTargets();
  $("#surfaceLayout").value = surface.layout;
  $("#surfaceDensity").value = surface.density;
  $("#surfaceTheme").value = surface.theme;
  $("#surfaceRefreshMs").value = String(surface.refreshMs);
  $("#surfaceMaxItems").value = surface.maxItems;
  $("#surfaceSort").value = surface.sort;
  $("#surfaceGroupBy").value = surface.groupBy;
  $("#surfaceMinAttention").value = surface.minAttention;
  $("#surfaceRepositoryPatterns").value = surface.repositoryPatterns.join("\n");
  $("#surfaceWorkflowPatterns").value = surface.workflowPatterns.join("\n");
  $("#surfaceEventPatterns").value = surface.eventPatterns.join("\n");
  $("#surfaceShowInProgress").checked = surface.showInProgress;
  $("#surfaceShowQueued").checked = surface.showQueued;
  $("#surfaceShowSuccess").checked = surface.showSuccess;
  $("#surfaceShowFailures").checked = surface.showFailures;
  $("#surfaceShowOtherCompleted").checked = surface.showOtherCompleted;
  $("#surfaceWatchedOnly").checked = surface.watchedOnly;
  $("#surfaceStallsOnly").checked = surface.stallsOnly;
  $("#surfaceShowTelemetry").checked = surface.showTelemetry;
  $("#surfaceShowSummary").checked = surface.showSummary;
  $("#surfaceShowError").checked = surface.showError;
  $("#surfaceShowAttentionBadge").checked = surface.showAttentionBadge;
  $("#surfaceShowWatchFlags").checked = surface.showWatchFlags;
  $("#surfaceShowStallFlag").checked = surface.showStallFlag;
  $("#surfaceFullWidth").checked = surface.fullWidth;
  $("#surfaceHideChrome").checked = surface.hideChrome;
  $("#surfaceMotion").value = surface.motion || "normal";
  $("#surfaceReactivity").value = surface.reactivity ?? 50;
  $("#surfaceShowFunControls").checked = surface.showFunControls !== false;
  for (const field of SURFACE_FIELDS) {
    const input = $("#field-" + field);
    if (input) input.checked = surface.fields.includes(field);
  }
}

function readSurfaceForm(existing) {
  return normalizeSurface({
    ...existing,
    name: $("#surfaceName").value,
    layout: $("#surfaceLayout").value,
    gridWrap: $("#surfaceGridOverflow").value === "wrap",
    gridOverflowMode: $("#surfaceGridOverflow").value,
    gridBreakAfterSeparators: $("#surfaceGridBreakAfterSeparators").checked,
    gridSortBy: $("#surfaceGridSort").value,
    gridRowLines: Number($("#surfaceGridRowHeight").value),
    gridHeaderOverflowMode: $("#surfaceHeaderOverflow").value,
    gridSortDir: $("#surfaceGridDirection").value,
    gridSortSecondaryBy: $("#surfaceGridSecondarySort").value,
    gridSortSecondaryDir: $("#surfaceGridSecondaryDirection").value,
    gridAddedFormat: $("#surfaceAddedDateFormat").value,
    gridUpdatedFormat: $("#surfaceUpdatedDateFormat").value,
    gridAddedPattern: $("#surfaceAddedDatePattern").value,
    gridUpdatedPattern: $("#surfaceUpdatedDatePattern").value,
    gridFields: readFieldEditor("#gridFieldEditor"),
    density: $("#surfaceDensity").value,
    theme: $("#surfaceTheme").value,
    refreshMs: Number($("#surfaceRefreshMs").value),
    maxItems: Number($("#surfaceMaxItems").value),
    sort: $("#surfaceSort").value,
    groupBy: $("#surfaceGroupBy").value,
    minAttention: $("#surfaceMinAttention").value,
    repositoryPatterns: $("#surfaceRepositoryPatterns").value,
    workflowPatterns: $("#surfaceWorkflowPatterns").value,
    eventPatterns: $("#surfaceEventPatterns").value,
    showInProgress: $("#surfaceShowInProgress").checked,
    showQueued: $("#surfaceShowQueued").checked,
    showSuccess: $("#surfaceShowSuccess").checked,
    showFailures: $("#surfaceShowFailures").checked,
    showOtherCompleted: $("#surfaceShowOtherCompleted").checked,
    watchedOnly: $("#surfaceWatchedOnly").checked,
    stallsOnly: $("#surfaceStallsOnly").checked,
    fields: $$("[data-surface-field]:checked").map((input) => input.dataset.surfaceField),
    showTelemetry: $("#surfaceShowTelemetry").checked,
    showSummary: $("#surfaceShowSummary").checked,
    showError: $("#surfaceShowError").checked,
    showAttentionBadge: $("#surfaceShowAttentionBadge").checked,
    showWatchFlags: $("#surfaceShowWatchFlags").checked,
    showStallFlag: $("#surfaceShowStallFlag").checked,
    fullWidth: $("#surfaceFullWidth").checked,
    hideChrome: $("#surfaceHideChrome").checked,
    motion: $("#surfaceMotion").value,
    reactivity: Number($("#surfaceReactivity").value),
    showFunControls: $("#surfaceShowFunControls").checked
  });
}

function commitEditorFormToDraft() {
  if (!editingSurfaceId) return;
  commitPaneForm();
  const index = editingSurfaces.findIndex((surface) => surface.id === editingSurfaceId);
  if (index < 0) return;
  editingSurfaces[index] = readSurfaceForm(editingSurfaces[index]);
}

function selectEditorSurface(id) {
  const surface = editingSurfaces.find((candidate) => candidate.id === id) || editingSurfaces[0];
  if (!surface) return;
  editingSurfaceId = surface.id;
  editingPaneIndex = 0;
  updateSurfaceEditorSelect(surface.id);
  writeSurfaceForm(surface);
}

async function openSurfaceSettings() {
  config = await api("/api/config");
  editingSurfaces = normalizeSurfaces(structuredClone(config.surfaces));
  updateSurfaceEditorSelect(config.activeSurfaceId);
  selectEditorSurface(config.activeSurfaceId);
  elements.surfaceStatus.textContent = "";
  elements.surfaceDialog.showModal();
}

function uniqueSurfaceId(base) {
  const stem = String(base || "surface").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "") || "surface";
  const ids = new Set(editingSurfaces.map((surface) => surface.id));
  if (!ids.has(stem)) return stem;
  let suffix = 2;
  while (ids.has(stem + "-" + suffix)) suffix += 1;
  return stem + "-" + suffix;
}

$("#dualPaneSelect").addEventListener("change", () => {
  const next = Number($("#dualPaneSelect").value);
  commitPaneForm();
  editingPaneIndex = next;
  const surface = editingSurfaces.find(x => x.id === editingSurfaceId);
  if (surface) writePaneForm(
    (surface.layout === "focus_vert" ? surface.vertPanes : surface.dualPanes)[next]
  );
});
$("#vertPaneHeightUnit").addEventListener("change", updateVertHeightRange);
$("#vertPaneCount").addEventListener("change", () => {
  const surface = editingSurfaces.find(x => x.id === editingSurfaceId);
  if (!surface || surface.layout !== "focus_vert") return;
  commitPaneForm();
  const count = normalizeVertCount($("#vertPaneCount").value);
  surface.vertPanes = normalizeVertPanes(surface.vertPanes, count, surface);
  surface.vertCount = count;
  editingPaneIndex = Math.min(editingPaneIndex, count - 1);
  updateDualSection(surface);
});
$("#surfaceLayout").addEventListener("change", () => {
  const current = editingSurfaces.find(x => x.id === editingSurfaceId);
  if (!current) return;
  // Commit the outgoing editor before switching between dual and vertical.
  commitPaneForm();
  current.layout = $("#surfaceLayout").value;
  editingPaneIndex = 0;
  updateDualSection(current);
});

elements.surfaceEditorSelect.addEventListener("change", () => {
  const nextId = elements.surfaceEditorSelect.value;
  commitEditorFormToDraft();
  selectEditorSurface(nextId);
});

$("#newSurfaceButton").addEventListener("click", () => {
  commitEditorFormToDraft();
  const id = uniqueSurfaceId("surface");
  const created = normalizeSurface({
    ...DEFAULT_SURFACES[0],
    id,
    name: "New surface"
  }, editingSurfaces.length);
  editingSurfaces.push(created);
  selectEditorSurface(created.id);
});

$("#duplicateSurfaceButton").addEventListener("click", () => {
  commitEditorFormToDraft();
  const source = editingSurfaces.find((surface) => surface.id === elements.surfaceEditorSelect.value);
  if (!source) return;
  const duplicate = normalizeSurface({
    ...structuredClone(source),
    id: uniqueSurfaceId(source.id + "-copy"),
    name: source.name + " copy"
  }, editingSurfaces.length);
  editingSurfaces.push(duplicate);
  selectEditorSurface(duplicate.id);
});

$("#deleteSurfaceButton").addEventListener("click", () => {
  if (editingSurfaces.length <= 1) {
    elements.surfaceStatus.textContent = "At least one surface is required.";
    return;
  }
  const id = elements.surfaceEditorSelect.value;
  const index = editingSurfaces.findIndex((surface) => surface.id === id);
  if (index < 0) return;
  editingSurfaces.splice(index, 1);
  editingSurfaceId = null;
  selectEditorSurface(editingSurfaces[Math.min(index, editingSurfaces.length - 1)].id);
});

$("#resetSurfacesButton").addEventListener("click", () => {
  editingSurfaces = normalizeSurfaces(structuredClone(DEFAULT_SURFACES));
  editingSurfaceId = null;
  selectEditorSurface("focus");
  elements.surfaceStatus.textContent = "Defaults loaded into the editor. Save to persist.";
});

elements.surfaceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  commitEditorFormToDraft();
  elements.surfaceStatus.textContent = "Saving…";
  try {
    const selectedId = elements.surfaceEditorSelect.value;
    const activeStillExists = editingSurfaces.some((surface) => surface.id === config.activeSurfaceId);
    const activeSurfaceId = activeStillExists ? config.activeSurfaceId : selectedId;
    config = await api("/api/display", {
      method: "PUT",
      body: JSON.stringify({
        surfaces: editingSurfaces,
        activeSurfaceId
      })
    });
    elements.surfaceDialog.close();
    renderSurfaceTabs();
    applySurfaceVisuals();
    if (latestState) renderDashboard(latestState);
    schedulePoll();
  } catch (error) {
    elements.surfaceStatus.textContent = error.message;
  }
});

elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.settingsStatus.textContent = "Saving…";
  try {
    config = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        githubToken: $("#githubToken").value,
        clearGithubToken: $("#clearGithubToken").checked,
        githubOwner: $("#githubOwner").value,
        maxRepositories: Number($("#maxRepositories").value),
        repositorySelectionMode: $("#repositorySelectionMode").value,
        activeAgeDays: Number($("#activeAgeDays").value),
        historyDepth: Number($("#historyDepth").value),
        backfillRunsPerRepo: Number($("#backfillRunsPerRepo").value),
        includePatterns: $("#includePatterns").value,
        excludePatterns: $("#excludePatterns").value
      })
    });
    elements.settingsDialog.close();
    renderSurfaceTabs();
    applySurfaceVisuals();
    await pollState();
  } catch (error) {
    elements.settingsStatus.textContent = error.message;
  }
});

$("#settingsButton").addEventListener("click", () => openSettings().catch((error) => {
  elements.errorBanner.hidden = false;
  elements.errorBanner.textContent = error.message;
}));

$("#surfaceSettingsButton").addEventListener("click", () => openSurfaceSettings().catch((error) => {
  elements.errorBanner.hidden = false;
  elements.errorBanner.textContent = error.message;
}));

$("#kioskSurfaceButton").addEventListener("click", () => openSurfaceSettings().catch((error) => {
  elements.errorBanner.hidden = false;
  elements.errorBanner.textContent = error.message;
}));

$("#refreshButton").addEventListener("click", async () => {
  const button = $("#refreshButton");
  button.disabled = true;
  button.textContent = "Scanning…";
  try {
    await api("/api/refresh", { method: "POST", body: "{}" });
    await pollState();
  } finally {
    button.disabled = false;
    button.textContent = "Rescan";
  }
});


function setMinimalSurface(value) {
  minimalOnly = !!value;
  const url = new URL(location.href);
  if (minimalOnly) url.searchParams.set("minimal", "1");
  else url.searchParams.delete("minimal");
  history.replaceState(null, "", url);
  applySurfaceVisuals();
}
$("#borderlessButton").addEventListener("click", () => setMinimalSurface(true));
$("#exitBorderlessButton").addEventListener("click", () => setMinimalSurface(false));
$("#popupButton").addEventListener("click", () => {
  const url = new URL(location.href);
  url.searchParams.set("surface", activeSurface().id);
  url.searchParams.set("minimal", "1");
  // Browser/toolbars/OS decoration are controlled by Firefox, not page CSS.
  // popup=yes is advisory; deliberately do not call this outside a user click.
  window.open(url.href, "CISmonWEB_Surface",
    "popup=yes,toolbar=no,location=no,menubar=no,status=no,resizable=yes,scrollbars=yes,width=1160,height=760");
});

// Experimental alternate popup creation: create a restricted about:blank
// popup synchronously inside the click, then navigate its Location. Firefox
// may still enforce a read-only URL bar; JS cannot suppress browser chrome.
$("#popupBlankButton").addEventListener("click", () => {
  const url = new URL(location.href);
  url.searchParams.set("surface", activeSurface().id);
  url.searchParams.set("minimal", "1");
  const child = window.open("about:blank", "_blank",
    "popup=yes,toolbar=no,location=no,menubar=no,status=no,personalbar=no,scrollbars=yes,resizable=yes,width=1160,height=760");
  if (!child) {
    elements.errorBanner.hidden = false;
    elements.errorBanner.textContent = "Popup blocked by Firefox. Allow popups for 127.0.0.1.";
    return;
  }
  child.location.replace(url.href);
});

$("#fullscreenButton").addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
});

for (const button of $$("[data-close]")) {
  button.addEventListener("click", () => {
    const dialog = document.getElementById(button.dataset.close);
    dialog?.close();
    if (dialog === elements.detailDialog) selectedRun = null;
  });
}
elements.detailDialog.addEventListener("close", () => { selectedRun = null; });

async function boot() {
  fillSortOptions($("#surfaceGridSort"));
  fillSortOptions($("#dualPaneSort"));
  for (const id of ["surfaceGridSecondarySort", "dualPaneSecondarySort"]) {
    const el = $("#" + id);
    el.replaceChildren();
    const none = node("option", "", "None");
    none.value = "";
    el.append(none);
    for (const [field, label] of GRID_FIELDS) {
      const option = node("option", "", label);
      option.value = field;
      el.append(option);
    }
  }
  for (const id of ["surfaceAddedDateFormat", "surfaceUpdatedDateFormat",
    "dualPaneAddedDateFormat", "dualPaneUpdatedDateFormat"]) {
    const el = $("#" + id);
    el.replaceChildren();
    for (const [format, label] of GRID_DATE_FORMATS) {
      const option = node("option", "", label);
      option.value = format;
      el.append(option);
    }
  }
  const query = new URL(location.href).searchParams;
  minimalOnly = query.get("minimal") === "1";
  config = await api("/api/config");
  const requested = new URL(window.location.href).searchParams.get("surface");
  if (requested && config.surfaces.some((surface) => surface.id === requested)) {
    localSurfaceOverride = requested;
    // Popup windows must not hijack the main window's active surface.
    if (!minimalOnly && requested !== config.activeSurfaceId) {
      config = await api("/api/display", {
        method: "PUT",
        body: JSON.stringify({ activeSurfaceId: requested })
      });
    }
  }
  renderSurfaceTabs();
  applySurfaceVisuals();
  await pollState();
  schedulePoll();
}

await boot();
