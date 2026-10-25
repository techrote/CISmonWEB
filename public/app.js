import {
  DEFAULT_SURFACES,
  SURFACE_FIELDS,
  applySurface,
  groupRows,
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
  visibleCount: $("#visibleCount"),
  rateRemaining: $("#rateRemaining"),
  updatedAt: $("#updatedAt"),
  telemetry: $("#telemetry"),
  errorBanner: $("#errorBanner"),
  scanBanner: $("#scanBanner"),
  dashboard: $("#dashboard"),
  emptyState: $("#emptyState"),
  emptyTitle: $("#emptyTitle"),
  emptyDetail: $("#emptyDetail"),
  summaryStrip: $("#summaryStrip"),
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
  if (days) return days + "d " + hours + "h";
  if (hours) return hours + "h " + minutes + "m";
  if (minutes) return minutes + "m " + seconds + "s";
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
  return surfaces.find((surface) => surface.id === config?.activeSurfaceId) || surfaces[0];
}

function fieldMeta(row, field) {
  switch (field) {
    case "stage": return ["CURRENT STAGE", row.stage || "workflow", ""];
    case "state": return ["STATE", row.state === "completed" ? row.conclusion : row.state, ""];
    case "elapsed": return ["ELAPSED", formatDuration(row.elapsedMs), ""];
    case "baseline": return ["MEDIAN", formatDuration(row.baselineMedianMs), row.baselineMedianMs ? row.confidence + " baseline" : "no baseline"];
    case "ratio": return ["RATIO", row.ratio ? row.ratio.toFixed(2) + "×" : "—", row.ratio >= 1.3 ? "above expected" : ""];
    case "remaining": return ["EST. REMAINING", formatDuration(row.estimatedRemainingMs), row.possiblyStalled ? "possible stall" : ""];
    case "branch": return ["BRANCH", row.branch || "—", row.event || ""];
    case "confidence": return ["CONFIDENCE", row.confidence || "none", row.baselineMedianMs ? "timing model" : ""];
    default: return [field.toUpperCase(), "—", ""];
  }
}

function stateBadge(row) {
  const text = row.state === "completed" ? row.conclusion : row.state;
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
  const rows = applySurface(state.rows || [], surface);

  elements.visibleCount.textContent = String(rows.length);
  elements.dashboard.replaceChildren();
  elements.dashboard.className = "dashboard layout-" + surface.layout + " density-" + surface.density;
  elements.emptyState.hidden = rows.length !== 0;

  if (rows.length === 0) {
    if (state.scannedRepositoryCount < state.repositoryCount) {
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

  if (surface.layout === "table") {
    elements.dashboard.append(renderTable(rows, surface));
  } else {
    elements.dashboard.append(renderGroups(rows, surface));
  }

  const counts = {
    active: rows.filter((row) => row.state === "in_progress").length,
    queued: rows.filter((row) => row.state === "queued").length,
    alerts: rows.filter((row) => row.attention === "action_required").length,
    suspicious: rows.filter((row) => row.attention === "suspicious").length
  };
  elements.surfaceSummary.textContent =
    rows.length + " shown · " + counts.active + " running · " + counts.queued +
    " queued · " + counts.suspicious + " suspicious · " + counts.alerts + " action required";
}

function applySurfaceVisuals() {
  const surface = activeSurface();
  document.body.dataset.theme = surface.theme;
  document.body.dataset.density = surface.density;
  document.body.classList.toggle("surface-hide-chrome", surface.hideChrome);
  document.body.classList.toggle("surface-hide-topbar", surface.hideChrome && !surface.showTelemetry);
  elements.main.classList.toggle("full-width", surface.fullWidth);
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
    const button = node("button", "surface-tab" + (surface.id === config.activeSurfaceId ? " active" : ""), surface.name);
    button.type = "button";
    button.dataset.surfaceId = surface.id;
    button.addEventListener("click", () => switchSurface(surface.id));
    elements.surfaceTabs.append(button);
  }
}

async function switchSurface(surfaceId) {
  if (!config.surfaces.some((surface) => surface.id === surfaceId)) return;
  config.activeSurfaceId = surfaceId;
  try {
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

async function pollState() {
  if (polling) return;
  polling = true;
  try {
    const state = await api("/api/state");
    elements.providerState.textContent = state.providerReady ? "ONLINE" : "WAITING";
    elements.repoCount.textContent = String(state.repositoryCount);
    elements.scannedRepoCount.textContent =
      String(state.scannedRepositoryCount) + "/" + String(state.repositoryCount);
    elements.trackedCount.textContent = String(state.trackedRunCount);
    elements.rateRemaining.textContent = state.rateRemaining >= 0 ? String(state.rateRemaining) : "—";
    elements.updatedAt.textContent = new Date(state.updatedAt).toLocaleTimeString();

    const surface = activeSurface();
    elements.errorBanner.hidden = !surface.showError || !state.lastError;
    elements.errorBanner.textContent = state.lastError || "";

    const scanning = state.scannedRepositoryCount < state.repositoryCount || state.pendingSweepCount > 0;
    elements.scanBanner.hidden = !scanning;
    elements.scanBanner.textContent = scanning
      ? "Repository sweep " + state.scannedRepositoryCount + "/" + state.repositoryCount +
        " checked · " + state.pendingSweepCount + " pending" +
        (state.sweepReason ? " · " + state.sweepReason : "") +
        ". Activity is incomplete until this sweep finishes."
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
    detail.headSha ? detail.headSha.slice(0, 10) : ""
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
  $("#historyDepth").value = config.historyDepth;
  $("#backfillRunsPerRepo").value = config.backfillRunsPerRepo;
  $("#includePatterns").value = (config.includePatterns || []).join("\n");
  $("#excludePatterns").value = (config.excludePatterns || []).join("\n");
  $("#clearGithubToken").checked = false;
  $("#tokenState").textContent = config.hasGithubToken
    ? "A token is stored locally. Leave blank to keep it."
    : "No token stored.";
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

function writeSurfaceForm(surface) {
  $("#surfaceName").value = surface.name;
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
    hideChrome: $("#surfaceHideChrome").checked
  });
}

function commitEditorFormToDraft() {
  if (!editingSurfaceId) return;
  const index = editingSurfaces.findIndex((surface) => surface.id === editingSurfaceId);
  if (index < 0) return;
  editingSurfaces[index] = readSurfaceForm(editingSurfaces[index]);
}

function selectEditorSurface(id) {
  const surface = editingSurfaces.find((candidate) => candidate.id === id) || editingSurfaces[0];
  if (!surface) return;
  editingSurfaceId = surface.id;
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
  config = await api("/api/config");
  const requested = new URL(window.location.href).searchParams.get("surface");
  if (requested && config.surfaces.some((surface) => surface.id === requested) && requested !== config.activeSurfaceId) {
    config = await api("/api/display", {
      method: "PUT",
      body: JSON.stringify({ activeSurfaceId: requested })
    });
  }
  renderSurfaceTabs();
  applySurfaceVisuals();
  await pollState();
  schedulePoll();
}

await boot();
