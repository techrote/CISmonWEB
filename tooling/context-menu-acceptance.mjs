// Browser acceptance against the production local HTTP API. Only external
// GitHub transport is replaced by completion-provider-fixture.mjs. Native
// Firefox/Chromium render the app; no /api/state or mutation response is mocked.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { normalizeSurfaces } from "../shared/surfaces.js";
import { FUN_PRESET_VERSION } from "../shared/fun-core.js";

const playwrightModule = process.env.CISMON_PLAYWRIGHT_MODULE || "playwright";
const playwright = await import(isAbsolute(playwrightModule) ? pathToFileURL(playwrightModule).href : playwrightModule);
const browserName = process.env.CISMON_BROWSER || "firefox";
assert.ok(["firefox", "chromium"].includes(browserName));
const headless = process.env.CISMON_HEADLESS !== "0";
const report = {
  status: "running", startedAt: new Date().toISOString(), platform: process.platform,
  node: process.version, browser: browserName, headless,
  transport: "Production local HTTP API and scheduler; external GitHub transport fixture only",
  audio: "Production chime graphs rendered by native OfflineAudioContext output-device fixture; speaker audibility not verified"
};
const artifacts = process.env.CISMON_BROWSER_ARTIFACTS;
if (artifacts) await mkdir(artifacts, { recursive: true });
const dataDir = await mkdtemp(join(tmpdir(), "cismon-completion-browser-"));
const fixturePath = join(dataDir, "provider-fixture.json");
const requestLog = join(dataDir, "provider-requests.jsonl");
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = "http://127.0.0.1:" + port;
const repo = "test-owner/test-repository";
const sha = "a".repeat(40);
const sha2 = "b".repeat(40);
const unknownSha = "c".repeat(40);
const ambiguousSha = "d".repeat(40);
const now = Date.now();
const iso = milliseconds => new Date(milliseconds).toISOString();
const run = (id, changes = {}) => ({
  id, run_number: id, run_attempt: 1, workflow_id: id, check_suite_id: id,
  name: "Workflow " + id, head_branch: "feature", event: "pull_request", head_sha: sha,
  html_url: "https://github.com/" + repo + "/actions/runs/" + id,
  status: "in_progress", conclusion: null,
  created_at: iso(now - 180000), run_started_at: iso(now - 120000), updated_at: iso(now - 60000),
  pull_requests: [{ number: 7, head: { sha } }], ...changes
});
const pr = (number, head = sha) => ({
  number, state: "open", merged: false, head: { sha: head },
  base: { ref: "main", repo: { full_name: repo } },
  html_url: "https://github.com/" + repo + "/pull/" + number,
  merge_commit_sha: head
});
const suite = (id, head = sha, status = "in_progress", conclusion = null) => ({
  id, head_sha: head, status, conclusion
});
const check = (id, head = sha, status = "in_progress", conclusion = null) => ({
  id, name: "Check " + id, head_sha: head, status, conclusion,
  check_suite: { id }, completed_at: status === "completed" ? iso(Date.now()) : null
});
let fixture = {
  repository: repo,
  runs: [run(101), run(102), run(103, { status: "completed", conclusion: "success", event: "push", head_sha: unknownSha, pull_requests: [] }),
    run(104, { head_sha: unknownSha, event: "push", pull_requests: [] }),
    run(105, { head_sha: ambiguousSha, pull_requests: [{ number: 8, head: { sha: ambiguousSha } }, { number: 9, head: { sha: ambiguousSha } }] })],
  prs: [pr(7), pr(8, ambiguousSha), pr(9, ambiguousSha)],
  checks: {
    [sha]: { suites: [suite(101), suite(102)], runs: [check(101), check(102)],
      statuses: [{ id: 1, context: "external-ci", state: "pending", updated_at: iso(now) }] }
  }
};
const pane = (sort = "desc") => ({ minAttention: "normal", showInProgress: true, showQueued: true,
  showSuccess: true, showFailures: true, showOtherCompleted: true, maxItems: 10,
  watchedOnly: false, stallsOnly: false,
  gridSortBy: "runNumber", gridSortDir: sort, gridSortSecondaryBy: "workflow", gridSortSecondaryDir: "asc",
  gridFields: ["workflow", "runNumber", "state", "elapsed"], focusCondenseHistory: false });
const surfaces = normalizeSurfaces([
  ...["rows", "table", "cards", "lanes", "signal", "afterimage", "lanes_plus", "hungry_margins"].map(layout => ({
    id: layout === "rows" ? "focus" : layout, name: "Test " + layout, layout,
    ...pane(), refreshMs: 1000, showTelemetry: true, showSummary: true,
    hideChrome: false, fullWidth: true, groupBy: "none"
  })),
  { id: "dual", name: "Test Dual", layout: "focus_dual", ...pane(),
    refreshMs: 1000, dualPanes: [pane("desc"), pane("asc")], hideChrome: false },
  { id: "vert", name: "Test Vert", layout: "focus_vert", ...pane(),
    refreshMs: 1000, vertCount: 3, vertPanes: [pane("desc"), pane("asc"), pane("desc")], hideChrome: false }
]);
await writeFile(join(dataDir, "config.json"), JSON.stringify({
  githubToken: "test-only-provider-fixture", githubOwner: "test-owner", repositorySelectionMode: "all",
  maxRepositories: 1, backfillRunsPerRepo: 1, historyDepth: 8,
  surfaces, activeSurfaceId: "focus", surfacePresetVersion: FUN_PRESET_VERSION, focusUxVersion: 2
}));
async function saveFixture() {
  const temporary = fixturePath + ".tmp";
  await writeFile(temporary, JSON.stringify(fixture));
  await rename(temporary, fixturePath);
}
await saveFixture();
let server, browser;
const errors = [];
let serverOutput = "";

async function api(path, input, method = "POST") {
  const response = await fetch(base + path, input === undefined ? {} : {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(input)
  });
  const body = await response.json();
  assert.ok(response.ok, path + ": HTTP " + response.status + " " + JSON.stringify(body));
  return body;
}
async function waitState(predicate, name, timeout = 120000) {
  const started = Date.now();
  let state;
  while (Date.now() - started < timeout) {
    state = await api("/api/state");
    if (predicate(state)) return state;
    await sleep(300);
  }
  throw new Error("Timed out: " + name + "\n" + JSON.stringify(state?.interactions) + "\n" + serverOutput);
}
async function startServer() {
  server = spawn(process.execPath, ["--import", pathToFileURL(resolve("tooling/completion-provider-fixture.mjs")).href, "src/server.js"], {
    cwd: resolve("."), windowsHide: true,
    env: { ...process.env, GITHUB_TOKEN: "", CISMON_OWNER: "", CISMON_HOST: "127.0.0.1",
      CISMON_PORT: String(port), CISMON_DATA_DIR: dataDir, CISMON_BROWSER_FIXTURE: fixturePath,
      CISMON_BROWSER_REQUEST_LOG: requestLog }, stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", chunk => { serverOutput += String(chunk); });
  server.stderr.on("data", chunk => { serverOutput += String(chunk); });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error("Server exited: " + serverOutput);
    try { if ((await fetch(base + "/api/state")).ok) return; } catch { /* startup */ }
    await sleep(80);
  }
  throw new Error("Server did not start: " + serverOutput);
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise(resolve => server.once("exit", resolve));
  server.kill();
  await Promise.race([exited, sleep(3000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL"); await exited;
  }
}
const runRow = (page, id, scope) => page.locator('[data-run-context][data-run-key="' + repo + "#" + id + '@1"]' +
  (scope ? '[data-pane-id="' + scope + '"]' : "")).first();
async function show(page, surface = "focus", minimal = false) {
  await page.goto(base + "/?surface=" + surface + (minimal ? "&minimal=1" : ""), { waitUntil: "domcontentloaded" });
  await runRow(page, 101).waitFor({ timeout: 15000 });
}
async function menu(page, id = 101, scope) {
  await runRow(page, id, scope).click({ button: "right" });
  await page.locator("#runContextMenu").waitFor({ state: "visible" });
}
async function action(page, name) {
  if (name.startsWith("copy-")) {
    // Closing a menu is synchronous; clipboard writes are not. Do not steal
    // document focus for the clipboard read before the actual write settles.
    // Wait out any previous toast so its "Copied" cannot satisfy this action.
    await page.locator("#interactionToast").waitFor({ state: "hidden" });
  }
  await page.locator('#runContextMenu [data-action="' + name + '"]').click();
  await page.locator("#runContextMenu").waitFor({ state: "hidden" });
  if (name.startsWith("copy-")) {
    await page.waitForFunction(() => {
      const toast = document.querySelector("#interactionToast");
      return toast && !toast.hidden && /^(Copied|Copy failed:)/.test(toast.textContent);
    });
    assert.equal(await page.locator("#interactionToast").textContent(), "Copied",
      "production clipboard action must report success before contents are inspected");
  }
}
async function clipboardContents(page) {
  if (browserName === "chromium") {
    // Headless Chromium's native Clipboard API is its clipboard authority;
    // an OS Ctrl+V bridge is not supplied by every headless environment. This
    // grants only the test reader permission, AFTER the real menu write.
    // Never replace navigator.clipboard or return the expected fixture text.
    await page.context().grantPermissions(["clipboard-read"], { origin: base });
    await page.bringToFront();
    report.clipboardReader = "Native Chromium navigator.clipboard.readText; reader permission granted after production write";
    try { return await page.evaluate(() => navigator.clipboard.readText()); }
    finally { await page.context().clearPermissions(); }
  }
  // Paste by a real browser gesture, not a mocked navigator.clipboard.
  report.clipboardReader = "Native Firefox Ctrl+V into a real textarea";
  await page.evaluate(() => {
    const input = document.createElement("textarea"); input.id = "clipboardAcceptance";
    document.body.append(input); input.focus();
  });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
  await page.waitForFunction(() => document.querySelector("#clipboardAcceptance")?.value.length > 0);
  const text = await page.locator("#clipboardAcceptance").inputValue();
  await page.locator("#clipboardAcceptance").evaluate(element => element.remove());
  return text;
}
async function installOfflineAudio(context) {
  // An explicit output-device fixture: production ChimePlayer schedules
  // genuine browser oscillators/gains into OfflineAudioContext. This checks
  // signal shape and multi-window ownership, not speakers or autoplay policy.
  await context.addInitScript(() => {
    window.__completionAudio = [];
    const NativeOffline = window.OfflineAudioContext;
    class OutputFixture {
      constructor() { this.state = "suspended"; this.listeners = []; this.backend = null; }
      get currentTime() { return 0; }
      get destination() { return this.backend.destination; }
      addEventListener(name, callback) { if (name === "statechange") this.listeners.push(callback); }
      resume() { this.state = "running"; for (const callback of this.listeners) callback(); return Promise.resolve(); }
      close() { this.state = "closed"; return Promise.resolve(); }
      createOscillator() {
        if (!this.backend) {
          const backend = this.backend = new NativeOffline(1, 48000, 48000);
          setTimeout(() => {
            this.backend = null;
            backend.startRendering().then(buffer => {
              const data = buffer.getChannelData(0);
              let peak = 0, energy = 0;
              for (const sample of data) { peak = Math.max(peak, Math.abs(sample)); energy += sample * sample; }
              window.__completionAudio.push({ peak, rms: Math.sqrt(energy / data.length), samples: data.length });
            });
          }, 0);
        }
        return this.backend.createOscillator();
      }
      createGain() { return this.backend.createGain(); }
    }
    window.AudioContext = OutputFixture;
  });
}
async function enableSound(page) {
  await page.locator(".notification-button:visible").first().click();
  await page.locator("#notificationSoundEnabled").check();
  await page.getByRole("button", { name: "Enable audio in this window", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#notificationAudioStatus")?.textContent.includes("Audio ready"));
  await page.getByRole("button", { name: "Close completion notifications", exact: true }).click();
}

try {
  await startServer();
  await waitState(state => state.rows.length >= 5, "initial provider rows");
  browser = await playwright[browserName].launch({ headless,
    ...(process.env.CISMON_BROWSER_EXECUTABLE ? { executablePath: process.env.CISMON_BROWSER_EXECUTABLE } : {}) });
  report.browserVersion = await browser.version();
  const context = await browser.newContext({ viewport: { width: 1220, height: 820 } });
  await installOfflineAudio(context);
  const page = await context.newPage();
  page.on("pageerror", error => { errors.push(error.message); console.error("BROWSER ERROR:", error.message); });
  await show(page);
  await menu(page);
  assert.deepEqual((await page.locator("#runContextMenu button").allTextContents()).slice(0, 2).map(text => text.trim()),
    ["Copy CI link", "Copy PR link"]);
  await action(page, "copy-ci");
  assert.equal(await clipboardContents(page), "https://github.com/" + repo + "/actions/runs/101/attempts/1");
  await waitState(state => state.rows.find(row => row.runId === 101)?.prAssociation?.status === "resolved", "lazy PR association");
  await menu(page);
  await page.waitForFunction(() => document.querySelector('[data-action="copy-pr"]')?.getAttribute("aria-disabled") === "false");
  await action(page, "copy-pr");
  assert.equal(await clipboardContents(page), "https://github.com/" + repo + "/pull/7");
  await menu(page);
  await action(page, "copy-sha");
  assert.equal(await clipboardContents(page), sha);
  await menu(page); await action(page, "workflow-history");
  assert.equal(await page.locator("[data-run-context]").count(), 1);
  assert.equal((await api("/api/state")).rows.length, 5, "workflow history is a contextual view, not monitoring mutation");
  await page.locator("#clearWorkflowView").click();
  assert.equal(await page.locator("[data-run-context]").count(), 5);
  console.log("PASS " + browserName + " actual copy-first CI/PR/SHA clipboard contents and lazy PR resolution");

  for (const [surface, scopes] of [["focus", ["main"]], ["table", ["main"]], ["dual", ["dual:0", "dual:1"]],
    ["vert", ["vert:0", "vert:1", "vert:2"]], ["cards", ["main"]], ["lanes", ["main"]],
    ["signal", ["main"]], ["afterimage", ["main"]], ["lanes_plus", ["main"]], ["hungry_margins", ["main"]]]) {
    await show(page, surface);
    for (const scope of scopes) {
      await menu(page, 101, scope);
      assert.equal((await page.locator("#runContextMenu button").first().textContent()).trim(), "Copy CI link");
      assert.equal(await page.locator("#detailDialog").isVisible(), false);
      await page.keyboard.press("Escape");
      await runRow(page, 101, scope).focus();
      await page.keyboard.press("Shift+F10");
      assert.equal(await page.locator("#runContextMenu").isVisible(), true);
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.evaluate(() => document.activeElement.dataset.action), "copy-pr");
      await page.keyboard.press("Escape");
      await page.keyboard.press("ContextMenu");
      assert.equal(await page.locator("#runContextMenu").isVisible(), true);
      await page.keyboard.press("Tab");
      assert.equal(await page.locator("#runContextMenu").isVisible(), false);
    }
  }
  console.log("PASS " + browserName + " shared pointer/keyboard menu across ten layouts and all Dual/Vert panes");

  await show(page);
  await runRow(page, 101).click({ button: "right", modifiers: ["Shift"] });
  assert.equal(await page.locator("#runContextMenu").isVisible(), false, "Shift-right-click preserves native browser menu");
  await page.keyboard.press("Escape");
  await menu(page);
  await page.locator("#surfaceTitle").click();
  assert.equal(await page.locator("#runContextMenu").isVisible(), false);
  await page.setViewportSize({ width: 420, height: 440 });
  await show(page, "focus", true);
  await runRow(page, 101).evaluate(element => element.dispatchEvent(new MouseEvent("contextmenu", {
    clientX: 416, clientY: 436, button: 2, bubbles: true, cancelable: true
  })));
  const box = await page.locator("#runContextMenu").boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 420 && box.y + box.height <= 440,
    "menu fits small surface-only viewport: " + JSON.stringify(box));
  if (artifacts) await page.screenshot({ path: join(artifacts, browserName + "-menu-small.png") });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#minimalNotificationControls .notification-button").isVisible(), true);
  await page.setViewportSize({ width: 1220, height: 820 });
  console.log("PASS " + browserName + " outside dismissal, native Shift-right-click and viewport clamping in surface-only mode");

  await show(page, "dual");
  await menu(page, 103, "dual:1"); await action(page, "pin");
  await waitState(state => state.interactions.pins.length === 1, "pin persisted");
  await page.waitForFunction(() => document.querySelector('[data-pane-id="dual:1"][data-run-context]')?.dataset.runKey.endsWith("#103@1"));
  assert.notEqual(await page.locator('[data-pane-id="dual:0"][data-run-context]').first().getAttribute("data-run-key"), repo + "#103@1");
  await menu(page, 103, "dual:1"); await action(page, "watch");
  await waitState(state => state.rows.find(row => row.runId === 103)?.manualWatch, "independent manual watch");
  await menu(page, 103, "dual:1"); await action(page, "unpin");
  assert.equal((await api("/api/state")).rows.find(row => row.runId === 103).manualWatch, true);
  await menu(page, 103, "dual:1"); await action(page, "pin");
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-pane-id="dual:1"][data-run-context]')?.dataset.runKey.endsWith("#103@1"));
  console.log("PASS " + browserName + " independent pane pin precedence, refresh persistence and watch isolation");

  await show(page);
  await menu(page, 104);
  await waitState(state => state.rows.find(row => row.runId === 104)?.prAssociation?.status !== "pending" &&
    state.rows.find(row => row.runId === 104)?.prAssociation?.status !== "unknown", "unavailable association");
  await menu(page, 104);
  assert.equal(await page.locator('[data-action="copy-pr"]').getAttribute("aria-disabled"), "true");
  assert.ok((await page.locator('[data-action="copy-pr"]').getAttribute("aria-description")).length > 10);
  await page.keyboard.press("Escape");
  await menu(page, 105);
  await waitState(state => state.rows.find(row => row.runId === 105)?.prAssociation?.status === "ambiguous", "ambiguous association");
  await menu(page, 105);
  assert.equal(await page.locator('[data-action="arm-pr"]').getAttribute("aria-disabled"), "true");
  await page.keyboard.press("Escape");
  await runRow(page, 103).click();
  await page.locator("#detailDialog").waitFor({ state: "visible" });
  await page.locator('[data-close="detailDialog"]').click();
  console.log("PASS " + browserName + " missing/ambiguous PR disables actions and ordinary Run Detail still opens");

  await enableSound(page);
  await page.locator("#notificationControls .notification-button").click();
  await page.getByRole("button", { name: "Preview success", exact: true }).click();
  await page.waitForFunction(() => window.__completionAudio.length === 1);
  await page.getByRole("button", { name: "Preview failure", exact: true }).click();
  await page.waitForFunction(() => window.__completionAudio.length === 2);
  const renders = await page.evaluate(() => window.__completionAudio);
  assert.ok(renders.every(value => value.rms > 0 && value.peak < 0.15), "native offline envelopes are nonempty and attenuated");
  await page.locator("#notificationMuted").check();
  await page.waitForFunction(() => document.querySelector('#notificationMuted').checked && document.querySelector('[aria-label="Completion chime volume"]'));
  assert.equal(await page.getByRole("button", { name: "Preview success", exact: true }).isDisabled(), true);
  await page.locator("#notificationMuted").uncheck();
  await page.getByRole("button", { name: "Close completion notifications", exact: true }).click();
  await page.evaluate(() => { window.__completionAudio.length = 0; });
  console.log("PASS " + browserName + " both production chimes render attenuated native offline envelopes; mute/preview controls work");

  const popupOpened = context.waitForEvent("page");
  await page.locator("#popupButton").click();
  const popup = await popupOpened;
  popup.on("pageerror", error => errors.push(error.message));
  await show(popup, "focus", true);
  await enableSound(popup);
  await menu(page); await action(page, "arm-run");
  await waitState(state => state.interactions.subscriptions.some(sub => sub.type === "run" && sub.seenActive), "fresh active run confirmation");
  const completedAt = iso(Date.now());
  fixture.runs.find(run => run.id === 101).status = "completed";
  fixture.runs.find(run => run.id === 101).conclusion = "success";
  fixture.runs.find(run => run.id === 101).updated_at = completedAt;
  await saveFixture(); await api("/api/refresh", {});
  await waitState(state => state.interactions.events.some(event => event.type === "run" && event.delivery.status === "played"), "two-window claimed completion playback");
  await sleep(1000);
  const totalAudio = await page.evaluate(() => window.__completionAudio.length) + await popup.evaluate(() => window.__completionAudio.length);
  assert.equal(totalAudio, 1, "two windows must produce one rendered chime");
  let interactions = await api("/api/interactions");
  assert.equal(interactions.events.length, 1);
  assert.equal(interactions.events[0].outcome, "success");
  await page.reload(); await popup.reload();
  await sleep(1500);
  assert.equal(await page.evaluate(() => window.__completionAudio.length) + await popup.evaluate(() => window.__completionAudio.length), 0,
    "refresh must not replay consumed delivery");
  console.log("PASS " + browserName + " real server claim/begin/ack with two browser clients, one native offline chime and no reload replay");

  await stopServer(); await startServer();
  await waitState(state => state.interactions.pins.length === 1 && state.interactions.events.length === 1, "restart persistence");
  await show(page, "dual");
  await waitState(state => state.interactions.pins[0]?.status === "available", "exact-attempt pin rehydration");
  assert.equal((await api("/api/interactions")).events[0].delivery.status, "played");
  console.log("PASS production server restart preserves pin, event and delivery state and rehydrates provider status");

  // Retrospective arming and cancellation both traverse real menu/routes.
  await show(page);
  await menu(page, 101);
  assert.equal(await page.locator('[data-action="arm-run"]').getAttribute("aria-disabled"), "true");
  await page.keyboard.press("Escape");
  await menu(page, 102); await action(page, "arm-run");
  await menu(page, 102); await action(page, "cancel-run");
  assert.equal((await api("/api/interactions")).subscriptions.find(sub => sub.type === "run" && sub.runId === 102).status, "cancelled");
  console.log("PASS completed attempt cannot arm retrospectively; a live subscription can be cancelled from its row");

  await menu(page, 102);
  await waitState(state => state.rows.find(row => row.runId === 102)?.prAssociation?.status === "resolved", "PR lookup after restart");
  await menu(page, 102); await action(page, "arm-pr");
  await waitState(state => state.interactions.subscriptions.some(sub => sub.type === "pr" && sub.seenActive), "initial full pending PR scan");
  const oldHeadCompleted = iso(Date.now());
  fixture.checks[sha] = {
    suites: [suite(101, sha, "completed", "success"), suite(102, sha, "completed", "success")],
    runs: [check(101, sha, "completed", "success"), check(102, sha, "completed", "success")],
    statuses: [{ id: 1, context: "external-ci", state: "success", updated_at: oldHeadCompleted }]
  };
  fixture.prs[0] = pr(7, sha2);
  Object.assign(fixture.runs.find(run => run.id === 102), {
    head_sha: sha2, pull_requests: [{ number: 7, head: { sha: sha2 } }], updated_at: iso(Date.now())
  });
  fixture.checks[sha2] = {
    suites: [suite(102, sha2)], runs: [check(102, sha2)],
    statuses: [{ id: 2, context: "external-ci", state: "pending", updated_at: iso(Date.now()) }]
  };
  await saveFixture(); await api("/api/refresh", {});
  await waitState(state => state.interactions.subscriptions.some(sub => sub.type === "pr" && sub.headSha === sha2), "PR tracks pushed replacement head");
  assert.equal((await api("/api/interactions")).events.filter(event => event.type === "pr").length, 0,
    "old-head completed checks must not emit a PR result");
  console.log("PASS PR alert follows a new head and ignores completed old-head checks");

  const currentCompletedAt = iso(Date.now());
  Object.assign(fixture.runs.find(run => run.id === 102), {
    status: "completed", conclusion: "success", updated_at: currentCompletedAt
  });
  fixture.checks[sha2].suites = [suite(102, sha2, "completed", "success")];
  fixture.checks[sha2].runs = [check(102, sha2, "completed", "success")];
  const pendingCheckStarted = Date.now();
  await saveFixture(); await api("/api/refresh", {});
  await waitState(state => state.interactions.subscriptions.some(sub => sub.type === "pr" &&
    sub.confirmedAtMs > pendingCheckStarted && /remain pending/.test(sub.reason)), "pending commit status blocks completed check/workflow success");
  assert.equal((await api("/api/interactions")).events.filter(event => event.type === "pr").length, 0);
  await enableSound(page); await enableSound(popup);
  await page.evaluate(() => { window.__completionAudio.length = 0; });
  await popup.evaluate(() => { window.__completionAudio.length = 0; });
  fixture.checks[sha2].statuses = [{ id: 3, context: "external-ci", state: "success", updated_at: iso(Date.now()) }];
  await saveFixture();
  await waitState(state => state.interactions.events.some(event => event.type === "pr" && event.delivery.status === "played"),
    "settled fully verified current-head PR completion", 180000);
  interactions = await api("/api/interactions");
  const prEvents = interactions.events.filter(event => event.type === "pr");
  assert.equal(prEvents.length, 1);
  assert.equal(prEvents[0].headSha, sha2);
  assert.equal(prEvents[0].outcome, "success");
  await sleep(1000);
  assert.equal(await page.evaluate(() => window.__completionAudio.length) + await popup.evaluate(() => window.__completionAudio.length), 1);
  console.log("PASS PR-wide terminal success requires workflows, suites, checks AND status contexts on replacement head; one settled event/chime");
  if (artifacts) {
    await page.locator(".notification-button:visible").first().click();
    await page.screenshot({ path: join(artifacts, browserName + "-completion-history.png") });
    await page.getByRole("button", { name: "Close completion notifications", exact: true }).click();
  }

  // Genuine native autoplay/device status is distinct from the output fixture.
  const nativeContext = await browser.newContext({ viewport: { width: 1220, height: 820 } });
  const nativePage = await nativeContext.newPage();
  nativePage.on("pageerror", error => errors.push(error.message));
  await show(nativePage);
  await nativePage.locator("#notificationControls .notification-button").click();
  await nativePage.getByRole("button", { name: "Enable audio in this window", exact: true }).click();
  await sleep(1700);
  const nativeAudioStatus = await nativePage.locator("#notificationAudioStatus").textContent();
  report.nativeAudioStatus = nativeAudioStatus;
  assert.match(nativeAudioStatus, /Audio ready|Audio blocked|Audio unavailable/);
  console.log("OBSERVED " + browserName + " native AudioContext: " + nativeAudioStatus);
  if (artifacts) await nativePage.screenshot({ path: join(artifacts, browserName + "-notifications.png") });
  await nativeContext.close();

  await api("/api/interactions", { action: "arm-run", repository: repo, runId: 104, runAttempt: 1 });
  const blockedContext = await browser.newContext();
  await blockedContext.addInitScript(() => {
    // Controlled policy denial complements the native-device observation.
    window.AudioContext = class {
      constructor() { this.state = "suspended"; }
      addEventListener() {}
      resume() { return new Promise(() => {}); }
      close() { return Promise.resolve(); }
    };
  });
  const blockedPage = await blockedContext.newPage();
  blockedPage.on("pageerror", error => errors.push(error.message));
  await show(blockedPage);
  assert.match(await blockedPage.locator("#notificationControls .notification-button").textContent(), /Enable audio/);
  await blockedPage.locator("#notificationControls .notification-button").click();
  await blockedPage.getByRole("button", { name: "Enable audio in this window", exact: true }).click();
  await blockedPage.waitForFunction(() => document.querySelector("#notificationAudioStatus").dataset.audioState === "blocked");
  assert.equal(await blockedPage.getByRole("button", { name: "Enable audio in this window", exact: true }).isEnabled(), true);
  await blockedContext.close();
  await api("/api/interactions", { action: "cancel-run", repository: repo, runId: 104, runAttempt: 1 });
  console.log("PASS explicit browser audio-policy denial shows actionable blocked state without claiming playback");

  assert.deepEqual(errors, [], "browser page errors");
  const logs = (await readFile(requestLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(logs.some(entry => /\/attempts\/1$/.test(entry.pathname)), "pin/subscriptions use exact-attempt provider routes");
  assert.ok(logs.some(entry => entry.pathname.endsWith("/pulls")), "association is provider-verified");
  report.providerRequests = logs.length;
  report.status = "passed";
  console.log("PASS " + browserName + " completion acceptance; " + logs.length + " bounded scheduler transport requests observed");
  console.log("Qualification: " + process.platform + "/" + browserName + " " + await browser.version() +
    "; headless=" + headless + "; audio delivery uses explicitly instrumented native OfflineAudioContext, not speakers.");
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  if (artifacts && browser) {
    for (const context of browser.contexts()) {
      const page = context.pages()[0];
      if (page) await page.screenshot({ path: join(artifacts, browserName + "-failure.png") }).catch(() => {});
    }
  }
  console.error(serverOutput);
  throw error;
} finally {
  await browser?.close();
  await stopServer();
  if (artifacts) {
    await writeFile(join(artifacts, browserName + "-report.json"), JSON.stringify({
      ...report, completedAt: new Date().toISOString(), pageErrors: errors
    }, null, 2) + "\n");
    await writeFile(join(artifacts, browserName + "-server.log"), serverOutput);
    try { await writeFile(join(artifacts, browserName + "-provider-requests.jsonl"), await readFile(requestLog)); } catch { /* startup failure */ }
  }
  await rm(dataDir, { recursive: true, force: true });
}
