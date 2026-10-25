const $ = (selector) => document.querySelector(selector);

const elements = {
  providerState: $("#providerState"),
  repoCount: $("#repoCount"),
  rateRemaining: $("#rateRemaining"),
  updatedAt: $("#updatedAt"),
  errorBanner: $("#errorBanner"),
  dashboard: $("#dashboard"),
  emptyState: $("#emptyState"),
  detailDialog: $("#detailDialog"),
  detailTitle: $("#detailTitle"),
  detailMeta: $("#detailMeta"),
  detailActions: $("#detailActions"),
  detailBody: $("#detailBody"),
  settingsDialog: $("#settingsDialog"),
  settingsForm: $("#settingsForm"),
  settingsStatus: $("#settingsStatus"),
};

let selectedRun = null;
let polling = false;

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

function metric(label, value, sub = "") {
  const cell = node("div", "run-cell");
  cell.append(node("span", "metric-label", label), node("span", "metric-value", value));
  if (sub) cell.append(node("span", "metric-sub", sub));
  return cell;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
  return data;
}

function renderRows(rows) {
  elements.dashboard.replaceChildren();
  elements.emptyState.hidden = rows.length !== 0;

  for (const row of rows) {
    const card = node("button", "run-card");
    card.type = "button";
    card.dataset.attention = row.attention;
    card.addEventListener("click", () => openDetail(row.repository, row.runId));

    const identity = node("div", "run-cell");
    const primary = node("div", "primary");
    primary.append(node("span", "repository", row.repository), badge(row.attention, row.attention));
    if (row.manualWatch) primary.append(node("span", "flag", "WATCH"));
    if (row.possiblyStalled) primary.append(node("span", "flag", "STALL?"));
    identity.append(primary);
    identity.append(node("div", "workflow", row.workflow + "  #" + row.runNumber + (row.branch ? "  ·  " + row.branch : "")));

    const stage = node("div", "run-cell");
    stage.append(node("span", "metric-label", "CURRENT STAGE"));
    stage.append(node("span", "stage", row.stage || "workflow"));

    const state = node("div", "run-cell");
    state.append(node("span", "metric-label", "STATE"));
    state.append(badge(row.state === "completed" ? row.conclusion : row.state, row.state === "completed" ? row.attention : row.state));

    card.append(
      identity,
      stage,
      state,
      metric("ELAPSED", formatDuration(row.elapsedMs), row.confidence !== "none" ? row.confidence + " baseline" : "no baseline yet"),
      metric("MEDIAN", formatDuration(row.baselineMedianMs), row.ratio ? row.ratio.toFixed(2) + "× baseline" : ""),
      metric("EST. REMAINING", formatDuration(row.estimatedRemainingMs), row.possiblyStalled ? "possible stall" : ""),
    );
    elements.dashboard.append(card);
  }
}

async function pollState() {
  if (polling) return;
  polling = true;
  try {
    const state = await api("/api/state");
    elements.providerState.textContent = state.providerReady ? "ONLINE" : "WAITING";
    elements.repoCount.textContent = String(state.repositoryCount);
    elements.rateRemaining.textContent = state.rateRemaining >= 0 ? String(state.rateRemaining) : "—";
    elements.updatedAt.textContent = new Date(state.updatedAt).toLocaleTimeString();
    elements.errorBanner.hidden = !state.lastError;
    elements.errorBanner.textContent = state.lastError || "";
    renderRows(state.rows);
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

function analysisGrid(analysis) {
  const grid = node("div", "analysis-grid");
  const values = [
    ["ATTENTION", analysis.attention.replaceAll("_", " ")],
    ["ELAPSED", formatDuration(analysis.elapsedMs)],
    ["MEDIAN", formatDuration(analysis.baseline?.median || 0)],
    ["RATIO", analysis.ratio ? analysis.ratio.toFixed(2) + "×" : "—"],
    ["CONFIDENCE", analysis.confidence],
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
  elements.detailMeta.textContent = [detail.event, detail.branch, detail.headSha ? detail.headSha.slice(0, 10) : ""].filter(Boolean).join("  ·  ");

  elements.detailActions.replaceChildren();
  elements.detailActions.append(actionButton(detail.manualWatch ? "Stop watching" : "Watch run", async () => {
    await api("/api/watch", {
      method: "POST",
      body: JSON.stringify({ repository, runId, watched: !detail.manualWatch }),
    });
    await renderDetail(repository, runId, false);
    await pollState();
  }, true));

  if (!detail.acknowledged && detail.analysis.attention === "action_required") {
    elements.detailActions.append(actionButton("Acknowledge failure", async () => {
      await api("/api/acknowledge", { method: "POST", body: JSON.stringify({ repository, runId }) });
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
      node("span", "metric-sub", formatDuration(job.analysis.elapsedMs)),
    );
    block.append(header);

    const steps = node("div", "steps");
    for (const step of job.steps || []) {
      const row = node("div", "step");
      row.append(
        node("span", "step-number", String(step.number).padStart(2, "0")),
        node("span", "", step.name),
        badge(step.state === "completed" ? step.conclusion : step.state, step.state),
        node("span", "step-duration", formatDuration(step.analysis.elapsedMs)),
      );
      steps.append(row);
    }
    if (!(job.steps || []).length) steps.append(node("div", "step", "No step detail returned."));
    block.append(steps);
    elements.detailBody.append(block);
  }

  if (!(detail.jobs || []).length) elements.detailBody.append(node("p", "metric-sub", "Job details have not been fetched yet."));
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
  const config = await api("/api/config");
  $("#githubToken").value = "";
  $("#githubOwner").value = config.githubOwner || "";
  $("#maxRepositories").value = config.maxRepositories;
  $("#historyDepth").value = config.historyDepth;
  $("#includePatterns").value = (config.includePatterns || []).join("\n");
  $("#excludePatterns").value = (config.excludePatterns || []).join("\n");
  $("#clearGithubToken").checked = false;
  $("#tokenState").textContent = config.hasGithubToken ? "A token is stored locally. Leave blank to keep it." : "No token stored.";
  elements.settingsStatus.textContent = "";
  elements.settingsDialog.showModal();
}

elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.settingsStatus.textContent = "Saving…";
  try {
    await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        githubToken: $("#githubToken").value,
        clearGithubToken: $("#clearGithubToken").checked,
        githubOwner: $("#githubOwner").value,
        maxRepositories: Number($("#maxRepositories").value),
        historyDepth: Number($("#historyDepth").value),
        includePatterns: $("#includePatterns").value,
        excludePatterns: $("#excludePatterns").value,
      }),
    });
    elements.settingsDialog.close();
    await pollState();
  } catch (error) {
    elements.settingsStatus.textContent = error.message;
  }
});

$("#settingsButton").addEventListener("click", () => openSettings().catch((error) => {
  elements.errorBanner.hidden = false;
  elements.errorBanner.textContent = error.message;
}));

$("#refreshButton").addEventListener("click", async () => {
  await api("/api/refresh", { method: "POST", body: "{}" });
  await pollState();
});

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => {
    const dialog = document.getElementById(button.dataset.close);
    dialog?.close();
    if (dialog === elements.detailDialog) selectedRun = null;
  });
}
elements.detailDialog.addEventListener("close", () => { selectedRun = null; });

await pollState();
setInterval(pollState, 2000);
