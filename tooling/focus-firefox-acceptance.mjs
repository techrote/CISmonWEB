// Real Firefox Focus acceptance on GitHub-hosted Windows. No credential,
// mock GitHub token, repository write or network GitHub access is needed.
// The browser renders actual local server pages; only /api/state is replaced
// with deterministic workflow fixtures for repeatable cross-pane checks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { firefox } from "playwright";

const port = 18989;
const base = "http://127.0.0.1:" + port;
const dataDir = await mkdtemp(join(tmpdir(), "cismon-focus-firefox-"));
const cwd = resolve(".");
const failures = [];
let server, browser;

async function api(path, options = {}) {
  const res = await fetch(base + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await res.json();
  assert.ok(res.ok, path + ": " + JSON.stringify(body));
  return body;
}

async function startServer() {
  const process = spawn(globalThis.process.execPath, ["src/server.js"], {
    cwd,
    env: {
      ...globalThis.process.env,
      CISMON_HOST: "127.0.0.1",
      CISMON_PORT: String(port),
      CISMON_DATA_DIR: dataDir,
      GITHUB_TOKEN: "", CISMON_OWNER: ""
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stderr = "";
  process.stderr.on("data", x => { stderr += String(x); });
  process.stdout.on("data", () => {});
  for (let i = 0; i < 80; i++) {
    if (process.exitCode !== null) throw new Error("server exited early: " + stderr);
    try {
      const response = await fetch(base + "/api/config", { signal: AbortSignal.timeout(1000) });
      if (response.ok) return process;
    } catch { /* not yet listening */ }
    await sleep(100);
  }
  process.kill();
  throw new Error("local test server failed to start: " + stderr);
}

async function stopServer(process) {
  if (!process) return;
  if (process.exitCode === null && process.signalCode === null) {
    process.kill();
    for (let i = 0; i < 70; i++) {
      if (process.exitCode !== null || process.signalCode !== null) return;
      await sleep(100);
    }
    throw new Error("local server failed to exit");
  }
}

const nowMs = Date.now();
function row(id, updates = {}) {
  const epoch = Math.floor(nowMs / 1000);
  return {
    repository: "techrote/example",
    workflow: "Browser fixture " + id,
    runId: id, runNumber: id, runAttempt: 1,
    state: "completed", providerState: "completed",
    conclusion: "success", executionState: "completed",
    createdAtEpoch: epoch - 60, updatedAtEpoch: epoch - 30,
    providerAgeMs: 12000, providerDataStale: false,
    jobActivity: { fresh: true, complete: true, running: 0, queued: 0, completed: 1 },
    attention: "normal", manualWatch: false, acknowledged: false, possiblyStalled: false,
    stage: "workflow", elapsedMs: 120000, baselineMedianMs: 300000,
    estimatedRemainingMs: 0, ratio: 0.4, confidence: "medium",
    baselineSamples: 7, waitingMs: 0, elapsedLowerBound: false,
    branch: "main", event: "push",
    ...updates
  };
}
const rows = [
  row(101, {
    workflow: "Long execution stage",
    state: "in_progress", providerState: "in_progress",
    conclusion: "unknown", executionState: "in_progress",
    stage: "Test_long-matrix.step", elapsedMs: 22 * 60000 + 16000,
    jobActivity: { fresh: true, complete: true, running: 2, queued: 1, completed: 0 }
  }),
  row(102, {
    workflow: "Queued parent has executing child",
    state: "queued", providerState: "queued", conclusion: "unknown",
    executionState: "in_progress", attention: "suspicious",
    stage: "1 JOB EXECUTING - compile",
    providerAgeMs: 180000, providerDataStale: true,
    jobActivity: { fresh: true, complete: true, running: 1, queued: 2, completed: 0 }
  }),
  row(103, {
    workflow: "Old failed workflow", conclusion: "failure", attention: "action_required",
    providerAgeMs: 900000, providerDataStale: false
  }),
  row(104, {
    workflow: "Recovered workflow", conclusion: "success",
    providerAgeMs: 950000
  }),
  row(105, {
    workflow: "Second executing workflow",
    state: "in_progress", providerState: "in_progress", conclusion: "unknown",
    executionState: "in_progress", stage: "Windows compile",
    jobActivity: { fresh: true, complete: true, running: 1, queued: 0, completed: 0 }
  })
];
function stateFixture() {
  return {
    rows, updatedAt: Date.now(),
    providerReady: true, repositoryCount: 2, scannedRepositoryCount: 2,
    trackedRunCount: rows.length, trackedActiveCount: 2, trackedQueuedCount: 1,
    dashboardCandidateCount: rows.length, rateRemaining: 1234,
    syncStatus: "online", oldestLiveSummaryAgeMs: 18000,
    oldestRepoSummaryAgeMs: 20000, repositorySelectionMode: "all",
    candidateRepositoryCount: 2, attemptedRepositoryCount: 2,
    activeWorkers: 4, activeWorkersPartial: false,
    observedRunningJobCount: 4, unassignedRunningJobCount: 0,
    workerCoverageRuns: 3, workerTotalLiveRuns: 3,
    pendingActivityProbeCount: 0, pendingSweepCount: 0,
    failedInitialScanCount: 0, lastError: ""
  };
}

async function show(page, surface) {
  await page.goto(base + "/?surface=" + surface, { waitUntil: "domcontentloaded" });
  await page.locator(".focus-grid-row").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(250);
}
async function editorSave(page) {
  await page.locator('#surfaceForm button[type="submit"]').click();
  await page.locator("#surfaceDialog").waitFor({ state: "hidden", timeout: 15000 });
}

try {
  server = await startServer();
  browser = await firefox.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1250, height: 820 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => failures.push(e.message));
  await page.route("**/api/state", route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify(stateFixture())
  }));
  await show(page, "focus");
  assert.equal(await page.locator(".focus-grid-row").count(), 5);
  let summary = await page.locator("#surfaceSummary").innerText();
  assert.match(summary, /2 GitHub in-progress/);
  assert.match(summary, /1 GitHub queued/);
  const failedState = page.locator(".focus-grid-row")
    .filter({ hasText: "Old failed workflow" }).locator('[data-field="state"]');
  assert.equal(await failedState.locator(".focus-state-stale").count(), 0,
    "terminal failures must not say PARENT STALE");
  const queued = page.locator(".focus-grid-row")
    .filter({ hasText: "Queued parent has executing child" }).locator('[data-field="state"]');
  assert.match(await queued.innerText(), /QUEUED/);
  assert.match(await queued.innerText(), /JOB EXECUTING/);
  assert.equal(await queued.locator(".focus-state-stale").count(), 1,
    "live provider state must still surface stale evidence");
  console.log("PASS Firefox Focus initial provider/job/source presentation");

  await show(page, "focus-dual");
  summary = await page.locator("#surfaceSummary").innerText();
  const dual = summary.match(/(\d+) pane appearances \((\d+) unique runs\)/);
  assert.ok(dual, "Dual must disclose unique runs separately: " + summary);
  assert.ok(Number(dual[1]) > Number(dual[2]), "Dual panes must overlap");
  assert.equal(Number(dual[2]), rows.length);
  console.log("PASS Firefox Focus Dual: " + dual[1] + " appearances / " + dual[2] + " unique");

  await show(page, "focus-vert");
  summary = await page.locator("#surfaceSummary").innerText();
  const vert = summary.match(/(\d+) pane appearances \((\d+) unique runs\)/);
  assert.ok(vert, "Vert must disclose unique runs separately: " + summary);
  assert.ok(Number(vert[1]) > Number(vert[2]), "Vert panes must overlap");
  assert.equal(Number(vert[2]), rows.length);
  console.log("PASS Firefox Focus Vert: " + vert[1] + " appearances / " + vert[2] + " unique");

  // Exercise the actual editor -> JSON write -> disk persistence path.
  await show(page, "focus");
  await page.locator("#surfaceSettingsButton").click();
  await page.locator("#surfaceDialog").waitFor({ state: "visible" });
  await page.locator("#surfaceGridOverflow").selectOption("wrap");
  await page.locator("#surfaceFocusCondenseHistory").uncheck();
  await editorSave(page);
  let cfg = await api("/api/config");
  let focus = cfg.surfaces.find(s => s.id === "focus");
  assert.equal(focus.gridOverflowMode, "wrap");
  assert.equal(focus.focusCondenseHistory, false);

  // Keyboard resizing must update the persisted column width, even as the
  // grid is rebuilt by frequent incoming state refreshes.
  const resize = page.locator('th[data-field="elapsed"] .focus-resize-handle');
  await resize.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(500);
  cfg = await api("/api/config");
  focus = cfg.surfaces.find(s => s.id === "focus");
  assert.ok(focus.gridWidths.elapsed < 94, "keyboard resize must persist");

  focus.gridWidths = { ...focus.gridWidths, elapsed: 45, stage: 80 };
  await api("/api/display", {
    method: "PUT", body: JSON.stringify({
      surfaces: cfg.surfaces.map(s => s.id === "focus" ? focus : s)
    })
  });
  await show(page, "focus");
  const elapsed = page.locator(".focus-grid-row")
    .filter({ hasText: "Long execution stage" }).locator('[data-field="elapsed"]');
  assert.match(await elapsed.innerText(), /22m16s/);
  assert.ok(await elapsed.locator("wbr").count() >= 1,
    "Wrap must break compact durations at complete units");
  assert.equal(await page.locator(".focus-grid-table").getAttribute("data-wrap"), "wrap");
  assert.equal(await page.locator('th[data-field="elapsed"]').count(), 1);
  console.log("PASS Firefox Focus wrap, keyboard sizing and config editor persistence");

  // Surface fullscreen uses native browser fullscreen. Some headless
  // configurations disable it; the test must state this, not fake success.
  await page.locator("#surfaceFullscreenButton").click();
  await page.waitForTimeout(300);
  const fullscreen = await page.evaluate(() => !!document.fullscreenElement);
  if (!fullscreen) {
    throw new Error("Firefox headless denied native fullscreen; cannot claim Escape acceptance: " +
      await page.locator("#errorBanner").textContent());
  }
  assert.match(page.url(), /minimal=1/);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 10000 });
  await page.waitForFunction(() => !new URL(location.href).searchParams.has("minimal"), null, {
    timeout: 10000
  });
  console.log("PASS Firefox native fullscreen -> Escape -> normal surface restoration");

  await browser.close();
  browser = null;
  await stopServer(server);
  server = null;
  const saved = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
  const stored = saved.surfaces.find(s => s.id === "focus");
  assert.equal(stored.focusCondenseHistory, false);
  assert.equal(stored.gridOverflowMode, "wrap");
  assert.equal(stored.gridWidths.elapsed, 45);
  server = await startServer();
  cfg = await api("/api/config");
  focus = cfg.surfaces.find(s => s.id === "focus");
  assert.equal(focus.focusCondenseHistory, false);
  assert.equal(focus.gridOverflowMode, "wrap");
  assert.equal(focus.gridWidths.elapsed, 45);
  assert.ok(!JSON.stringify(cfg).includes("github_pat_"), "public config must not expose credentials");
  console.log("PASS native Windows disk config readback and server restart");
  assert.deepEqual(failures, [], "Firefox uncaught page errors");
  console.log("FOCUS_FIREFOX_WINDOWS_ACCEPTANCE_PASS");
} finally {
  await browser?.close().catch(() => {});
  await stopServer(server);
  await rm(dataDir, { recursive: true, force: true });
}
