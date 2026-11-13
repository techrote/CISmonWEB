// Source-matched real Firefox acceptance for duration inheritance and compact
// headers. Browser and server run on Windows CI; only provider state/detail are
// deterministic fixtures, while saved configuration uses the real local API.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { firefox } from "playwright";

const port = 18991;
const base = "http://127.0.0.1:" + port;
const cwd = resolve(".");
const dataDir = await mkdtemp(join(tmpdir(), "cismon-duration-accept-"));
const imageDir = join(cwd, "artifacts", "focus-duration");
const elapsedMs = 4 * 3600000 + 33 * 60000;
const syncAgeMs = 6 * 60000 + 26 * 1000;
const failures = [];
let server = null, browser = null, detailRequests = 0;

async function api(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json();
  assert.ok(response.ok, path + ": " + JSON.stringify(body));
  return body;
}
async function saveSurfaces(surfaces) {
  return api("/api/display", { method: "PUT", body: JSON.stringify({ surfaces }) });
}
async function awaitSavedSurface(surfaceId, predicate) {
  for (let i = 0; i < 55; i++) {
    const surface = (await api("/api/config")).surfaces.find(s => s.id === surfaceId);
    if (predicate(surface)) return surface;
    await sleep(100);
  }
  throw new Error("Timed out waiting for the saved " + surfaceId + " surface state");
}
async function startServer() {
  const child = spawn(globalThis.process.execPath, ["src/server.js"], {
    cwd,
    env: {
      ...globalThis.process.env, CISMON_HOST: "127.0.0.1",
      CISMON_PORT: String(port), CISMON_DATA_DIR: dataDir,
      GITHUB_TOKEN: "", CISMON_OWNER: ""
    },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  let stderr = "";
  child.stderr.on("data", x => { stderr += String(x); });
  child.stdout.on("data", () => {});
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error("server terminated: " + stderr);
    try {
      const response = await fetch(base + "/api/config", { signal: AbortSignal.timeout(1000) });
      if (response.ok) return child;
    } catch { /* retry */ }
    await sleep(100);
  }
  child.kill();
  throw new Error("local server startup failed: " + stderr);
}
async function stopServer(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  for (let i = 0; i < 70; i++) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(100);
  }
  throw new Error("local test server did not exit");
}
const timestamp = Math.floor(Date.now() / 1000);
const item = {
  repository: "techrote/example", workflow: "Duration probe",
  runId: 101, runNumber: 101, runAttempt: 1, state: "in_progress",
  providerState: "in_progress", conclusion: "unknown",
  executionState: "in_progress", attention: "normal",
  manualWatch: false, acknowledged: false, possiblyStalled: false,
  createdAtEpoch: timestamp - 400, updatedAtEpoch: timestamp - 30,
  providerAgeMs: syncAgeMs, providerDataStale: false,
  jobActivity: { fresh: true, complete: true, running: 1, queued: 0, completed: 0 },
  stage: "Build", elapsedMs, waitingMs: 0, elapsedLowerBound: false,
  baselineMedianMs: elapsedMs, estimatedRemainingMs: 900000,
  stageEstimatedRemainingMs: 600000, ratio: 1, confidence: "high",
  baselineSamples: 12, branch: "main", event: "push"
};
function state() {
  return {
    rows: [item], updatedAt: Date.now(), providerReady: true,
    repositoryCount: 1, scannedRepositoryCount: 1, trackedRunCount: 1,
    trackedActiveCount: 1, trackedQueuedCount: 0, dashboardCandidateCount: 1,
    rateRemaining: 1000, syncStatus: "online",
    oldestLiveSummaryAgeMs: syncAgeMs, oldestRepoSummaryAgeMs: syncAgeMs,
    repositorySelectionMode: "all", candidateRepositoryCount: 1,
    attemptedRepositoryCount: 1, activeWorkers: 1,
    activeWorkersPartial: false, observedRunningJobCount: 1,
    unassignedRunningJobCount: 0, workerCoverageRuns: 1,
    workerTotalLiveRuns: 1, pendingActivityProbeCount: 0,
    pendingSweepCount: 0, failedInitialScanCount: 0, lastError: ""
  };
}
function detail() {
  return {
    ...item, workflowName: item.workflow, acknowledged: false,
    jobsCoverageComplete: true, observedRunningJobs: 1,
    analysis: {
      attention: "normal", elapsedMs, estimatedRemainingMs: 900000,
      confidence: "high", ratio: 1, z: 0,
      baseline: { median: elapsedMs, p25: elapsedMs, p75: elapsedMs,
        mad: 60000, ewma: elapsedMs, samples: 12 }
    },
    jobs: [{
      name: "Build", state: "in_progress", analysis: { elapsedMs },
      steps: [{ number: 1, name: "Compile", state: "in_progress", analysis: { elapsedMs } }]
    }]
  };
}
async function show(page, surface) {
  await page.goto(base + "/?surface=" + surface, { waitUntil: "domcontentloaded" });
  await page.locator(".focus-grid-row").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(150);
}
async function openEditor(page) {
  await page.locator("#surfaceSettingsButton").click();
  await page.locator("#surfaceDialog").waitFor({ state: "visible" });
}
async function saveEditor(page) {
  await page.locator('#surfaceForm button[type="submit"]').click();
  await page.locator("#surfaceDialog").waitFor({ state: "hidden", timeout: 15000 });
}
async function cellText(pane, field = "elapsed") {
  return (await pane.locator('.focus-grid-row [data-field="' + field + '"]')
    .first().innerText()).trim();
}
async function assertPaneTimes(page, selector, expected) {
  const panes = page.locator(selector);
  assert.equal(await panes.count(), expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(await cellText(panes.nth(i)), expected[i],
      "pane " + i + " duration mismatch");
  }
}
async function expectDetail(page, text) {
  const elapsed = page.locator("#detailBody .analysis-grid > div")
    .filter({ has: page.locator(".metric-label", { hasText: "ELAPSED" }) })
    .locator("strong");
  assert.equal((await elapsed.first().innerText()).trim(), text);
  assert.equal((await page.locator("#detailBody .job-header .metric-sub").first().innerText()).trim(), text);
  assert.equal((await page.locator("#detailBody .step-duration").first().innerText()).trim(), text);
}
async function inspectHeader(page, field, width, expectedText) {
  const th = page.locator('th[data-field="' + field + '"]');
  const found = await th.evaluate(header => {
    const label = header.querySelector(".focus-sort-label");
    const badge = header.querySelector(".focus-sort-indicator");
    const h = header.getBoundingClientRect();
    const l = label.getBoundingClientRect();
    const b = badge?.getBoundingClientRect();
    return {
      text: label.textContent.trim(), width: h.width,
      centerDelta: Math.abs(l.left + l.width / 2 - (h.left + h.width / 2)),
      gap: b ? l.top - b.bottom : null,
      badgeWithinHeader: b ? b.left >= h.left - 1 && b.right <= h.right + 1 : true
    };
  });
  assert.ok(Math.abs(found.width - width) < 2,
    "header should retain requested width " + width + ": " + JSON.stringify(found));
  assert.equal(found.text, expectedText, "header abbreviation at " + width + "px");
  assert.ok(found.centerDelta < 2, "header must be horizontally centered: " + JSON.stringify(found));
  assert.ok(found.gap === null || found.gap >= -1,
    "badge must not overlap text: " + JSON.stringify(found));
  assert.ok(found.badgeWithinHeader, "badge must stay in the header");
}
try {
  server = await startServer();
  let config = await api("/api/config");
  // Reproduce pre-fix persisted "compact" pane materialization with no
  // intent marker. It must NOT pin every pane to Compact on parent changes.
  const surfaces = config.surfaces.map(surface => {
    if (surface.id !== "focus-dual" && surface.id !== "focus-vert") return surface;
    const key = surface.id === "focus-dual" ? "dualPanes" : "vertPanes";
    return {
      ...surface, [key]: surface[key].map(pane => {
        const { durationOverrideExplicit, ...old } = pane;
        return { ...old, durationMode: "compact", minAttention: "normal",
          showInProgress: true, showQueued: true };
      })
    };
  });
  await saveSurfaces(surfaces);
  config = await api("/api/config");
  for (const kind of ["focus-dual", "focus-vert"]) {
    const surface = config.surfaces.find(s => s.id === kind);
    const panes = kind === "focus-dual" ? surface.dualPanes : surface.vertPanes;
    assert.ok(panes.every(p => p.durationMode === "inherit"),
      "legacy Compact panes should migrate to Inherit surface: " + kind);
  }
  console.log("PASS old normalized Compact panes migrate to inheritance");

  browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 980, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", e => failures.push(e.message));
  await page.route("**/api/state", route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(state())
  }));
  await page.route("**/api/run?**", route => {
    detailRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify(detail()) });
  });

  await show(page, "focus-dual");
  await openEditor(page);
  assert.equal(await page.locator("#dualPaneDurationMode").inputValue(), "inherit");
  await page.locator("#surfaceDurationMode").selectOption("decimal");
  await page.locator("#surfaceDurationDecimals").selectOption("2");
  await saveEditor(page);
  await assertPaneTimes(page, ".focus-dual-pane", ["4.55h", "4.55h"]);
  assert.equal((await page.locator("#syncAge").innerText()).trim(), "6.43m");
  config = await api("/api/config");
  const dual = config.surfaces.find(s => s.id === "focus-dual");
  assert.equal(dual.durationMode, "decimal");
  assert.ok(dual.dualPanes.every(p => p.durationMode === "inherit"));
  console.log("PASS parent editor change propagates to both migrated Dual panes and SYNC AGE");

  await page.locator(".focus-dual-pane").first().locator(".focus-grid-row").first().click();
  await page.locator("#detailDialog").waitFor({ state: "visible" });
  await expectDetail(page, "4.55h");
  const beforeRefresh = detailRequests;
  for (let i = 0; i < 20 && detailRequests === beforeRefresh; i++) await sleep(200);
  assert.ok(detailRequests > beforeRefresh, "detail must refresh with live state polling");
  await expectDetail(page, "4.55h");
  await page.keyboard.press("Escape");
  console.log("PASS detail uses originating pane and preserves it across live refresh");

  await openEditor(page);
  await page.locator("#dualPaneSelect").selectOption("0");
  await page.locator("#dualPaneDurationMode").selectOption("unitless_hours");
  await page.locator("#dualPaneDurationDecimals").selectOption("2");
  await page.locator("#dualPaneSelect").selectOption("1");
  assert.equal(await page.locator("#dualPaneDurationMode").inputValue(), "inherit");
  await saveEditor(page);
  await assertPaneTimes(page, ".focus-dual-pane", ["4.55", "4.55h"]);
  config = await api("/api/config");
  const mixed = config.surfaces.find(s => s.id === "focus-dual");
  assert.equal(mixed.dualPanes[0].durationOverrideExplicit, true);
  assert.equal(mixed.dualPanes[0].durationMode, "unitless_hours");
  assert.equal(mixed.dualPanes[1].durationMode, "inherit");
  await page.locator(".focus-dual-pane").first().locator(".focus-grid-row").first().click();
  await page.locator("#detailDialog").waitFor({ state: "visible" });
  await expectDetail(page, "4.55");
  await page.keyboard.press("Escape");
  await page.locator(".focus-dual-pane").nth(1).locator(".focus-grid-row").first().click();
  await page.locator("#detailDialog").waitFor({ state: "visible" });
  await expectDetail(page, "4.55h");
  await page.keyboard.press("Escape");
  console.log("PASS independent pane overrides and pane-specific detail formatting");

  // Changing parent again affects only inherited panes, after reload too.
  await openEditor(page);
  await page.locator("#surfaceDurationMode").selectOption("compact");
  await saveEditor(page);
  await show(page, "focus-dual");
  await assertPaneTimes(page, ".focus-dual-pane", ["4.55", "4h33m"]);
  assert.equal((await page.locator("#syncAge").innerText()).trim(), "6m");
  console.log("PASS inherited pane changes independently of explicit override after reload");

  await show(page, "focus-vert");
  await openEditor(page);
  await page.locator("#surfaceDurationMode").selectOption("unitless_hours");
  await page.locator("#surfaceDurationDecimals").selectOption("2");
  await saveEditor(page);
  await assertPaneTimes(page, ".focus-vert-pane", ["4.55", "4.55"]);
  assert.equal((await page.locator("#syncAge").innerText()).trim(), "0.11");
  await openEditor(page);
  await page.locator("#dualPaneDurationMode").selectOption("compact");
  await saveEditor(page);
  await assertPaneTimes(page, ".focus-vert-pane", ["4h33m", "4.55"]);
  console.log("PASS Vert parent inheritance and intentional Compact override");

  // Real browser layout: header text and sort badge must remain separated at
  // 36/45/60/160 CSS px, across resize, sorting, zoom and reload.
  await show(page, "focus");
  config = await api("/api/config");
  const focus = config.surfaces.find(s => s.id === "focus");
  focus.gridFields = ["workflow", "elapsed", "repository", "owner", "state", "updated",
    "branch", "stage", "jobActivity", "providerAge", "attention", "checks"];
  focus.gridSortBy = "workflow";
  focus.gridSortDir = "asc";
  focus.gridSortSecondaryBy = "elapsed";
  focus.gridSortSecondaryDir = "desc";
  focus.gridWidths = { ...focus.gridWidths, workflow: 36, elapsed: 45 };
  await saveSurfaces(config.surfaces.map(s => s.id === "focus" ? focus : s));
  await show(page, "focus");
  for (const [width, name] of [[36, "WORKF"], [45, "WORKF"],
    [60, null], [160, "WORKFLOW"]]) {
    config = await api("/api/config");
    const edited = config.surfaces.find(s => s.id === "focus");
    edited.gridWidths = { ...edited.gridWidths, workflow: width };
    await saveSurfaces(config.surfaces.map(s => s.id === "focus" ? edited : s));
    await show(page, "focus");
    const header = page.locator('th[data-field="workflow"]');
    const visible = await header.locator(".focus-sort-label").innerText();
    assert.ok(name === null || visible.trim() === name,
      "expected " + name + " at " + width + ", got " + visible);
    await inspectHeader(page, "workflow", width, visible.trim());
    const badge = await header.locator(".focus-sort-indicator").innerText();
    assert.equal(badge, "↑", "primary badge must not appear in text");
    const secondBadge = await page.locator('th[data-field="elapsed"] .focus-sort-indicator').innerText();
    assert.equal(secondBadge, "2↓", "secondary badge must have rank and arrow");
    assert.equal((await header.locator(".focus-sort-label").innerText()).includes("↑"), false);
    if (width === 36) {
      await page.evaluate(() => { document.documentElement.style.zoom = "1.25"; });
      await page.waitForTimeout(200);
      assert.equal((await header.locator(".focus-sort-label").innerText()).trim(), "WORKF",
        "zoom must not trick the header into using the unclipped full name");
      await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
    }
  }
  await mkdir(imageDir, { recursive: true });
  await page.screenshot({ path: join(imageDir, "headers-wide.png") });
  config = await api("/api/config");
  const narrowFocus = config.surfaces.find(s => s.id === "focus");
  narrowFocus.gridWidths = { ...narrowFocus.gridWidths, workflow: 36, elapsed: 45 };
  await saveSurfaces(config.surfaces.map(s => s.id === "focus" ? narrowFocus : s));
  await show(page, "focus");
  await inspectHeader(page, "workflow", 36, "WORKF");
  await page.screenshot({ path: join(imageDir, "headers-36px.png") });

  // Exercise real keyboard and mouse event paths, not only server-set widths.
  const handle = page.locator('th[data-field="workflow"] .focus-resize-handle');
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(250);
  config = await api("/api/config");
  assert.equal(config.surfaces.find(s => s.id === "focus").gridWidths.workflow, 51);
  const mouseHandle = page.locator('th[data-field="workflow"] .focus-resize-handle');
  await mouseHandle.scrollIntoViewIfNeeded();
  const rect = await mouseHandle.boundingBox();
  assert.ok(rect, "resize handle must be on screen");
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 16, rect.y + rect.height / 2, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  config = await api("/api/config");
  assert.ok(config.surfaces.find(s => s.id === "focus").gridWidths.workflow >= 65,
    "mouse resize must persist width");
  // Click and Shift+click must still change sort state without moving labels.
  await page.locator('th[data-field="elapsed"] .focus-sort').click();
  await page.waitForFunction(() => document.querySelector('th[data-field="elapsed"]')
    ?.getAttribute("aria-sort") !== "none");
  await page.locator('th[data-field="workflow"] .focus-sort').click({ modifiers: ["Shift"] });
  await page.waitForFunction(() => document.querySelector('th[data-field="workflow"]')
    ?.querySelector(".focus-sort-indicator")?.textContent?.startsWith("2"));
  const sorted = await awaitSavedSurface("focus",
    surface => surface.gridSortBy === "elapsed" && surface.gridSortSecondaryBy === "workflow");
  assert.equal(sorted.gridSortBy, "elapsed");
  assert.equal(sorted.gridSortSecondaryBy, "workflow");
  assert.equal(await page.locator('th[data-field="elapsed"] .focus-sort-indicator').count(), 1);
  await page.evaluate(() => { document.documentElement.style.zoom = "1.25"; });
  await page.waitForTimeout(350);
  const zoomedText = (await page.locator('th[data-field="workflow"] .focus-sort-label').innerText()).trim();
  assert.ok(zoomedText === "WORKF" || zoomedText === "WORKFLOW");
  const overlap = await page.locator('th[data-field="workflow"]').evaluate(th => {
    const label = th.querySelector(".focus-sort-label").getBoundingClientRect();
    const badge = th.querySelector(".focus-sort-indicator").getBoundingClientRect();
    return label.top - badge.bottom;
  });
  assert.ok(overlap >= -1, "zoom must not overlap sort badge with label");
  await show(page, "focus"); // reload persisted sort and widths, resets page zoom
  config = await api("/api/config");
  assert.ok(config.surfaces.find(s => s.id === "focus").gridWidths.workflow >= 65);
  assert.equal(config.surfaces.find(s => s.id === "focus").gridSortBy, "elapsed");
  assert.equal(await page.locator('th[data-field="workflow"] .focus-sort-indicator').innerText(),
    "2↓");
  console.log("PASS Firefox 36/45/60/160px header abbreviations, sort badges, mouse/keyboard resizing, CSS zoom and reload");

  assert.deepEqual(failures, [], "uncaught browser page errors");
  console.log("DURATION_COMPACT_FIREFOX_ACCEPTANCE_PASS");
} finally {
  await browser?.close().catch(() => {});
  await stopServer(server);
  await rm(dataDir, { recursive: true, force: true });
}
