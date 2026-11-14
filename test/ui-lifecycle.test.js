import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import * as surfaces from "../shared/surfaces.js";
import * as grid from "../shared/focus-grid.js";
import * as workflowView from "../shared/workflow-view.js";
import { isFunLayout } from "../shared/fun-core.js";

// Execute the real browser module with controlled requests and a small DOM
// stand-in. These tests exercise event/request ordering without a browser or
// a GitHub credential, and run in the dependency-free Node test suite.
class Element {
  constructor() {
    this.children = [];
    this.handlers = new Map();
    this.dataset = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
    this.style = { setProperty() {} };
    this.value = "";
    this.open = false;
    this.disabled = false;
    this.hidden = false;
  }
  set textContent(value) { this.text = String(value ?? ""); this.children = []; }
  get textContent() { return this.text || this.children.map(child => child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ""; this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, handler) {
    const handlers = this.handlers.get(type) || [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
  }
  dispatch(type, event = {}) {
    return Promise.all((this.handlers.get(type) || []).map(handler => handler(event)));
  }
  showModal() { this.open = true; }
  close() { this.open = false; void this.dispatch("close"); }
}

// Git may check browser sources out with CRLF on Windows. Normalize line
// endings before removing imports for the VM harness, preserving the module.
const original = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
assert.match(original, /\nawait boot\(\);\s*$/);
const source = original.replace(/^import[\s\S]*?from "[^"]+";\n/gm, "")
  .replace(/\nawait boot\(\);\s*$/, "");
const clone = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function initialConfig() {
  return {
    activeSurfaceId: "focus",
    surfaces: surfaces.normalizeSurfaces([
      { id: "focus", name: "Focus", layout: "rows" },
      { id: "dense", name: "Dense", layout: "table" }
    ])
  };
}
function detail(id) {
  return { repository: "owner/repo", workflowName: "Build " + id, runId: id,
    runNumber: id, jobs: [], manualWatch: false,
    analysis: { attention: "normal", elapsedMs: 1000, confidence: "none" } };
}
function app(request) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const document = new Element();
  Object.assign(document, {
    body: new Element(), documentElement: new Element(), fullscreenElement: null,
    querySelector: element, querySelectorAll: () => [],
    getElementById: id => element("#" + id),
    createElement: () => new Element(), createDocumentFragment: () => new Element()
  });
  const location = { href: "http://127.0.0.1:8787/" };
  const context = vm.createContext({
    ...surfaces, ...grid, ...workflowView, isFunLayout, document, location, URL,
    history: { replaceState(_state, _title, url) { location.href = String(url); } },
    window: { location }, structuredClone,
    createFocusGrid: () => new Element(),
    setTimeout: () => 0, clearTimeout() {},
    fetch: async (url, options) => {
      const result = await request(url, options);
      const status = result.httpStatus || 200;
      return { ok: status >= 200 && status < 300, status,
        json: async () => clone(result.httpStatus ? result.body : result) };
    }
  });
  vm.runInContext(source, context, { filename: "public/app.js" });
  context.initial = initialConfig();
  vm.runInContext("config = initial; latestState = { rows: [] };", context);
  return { element, document, location, run: code => vm.runInContext(code, context) };
}

test("pending grid saves serialize with surface changes and preserve other surfaces", async () => {
  const gate = deferred();
  let saved = initialConfig();
  const requests = [];
  const ui = app(async (url, options) => {
    assert.equal(url, "/api/display");
    const input = JSON.parse(options.body);
    requests.push(input);
    if (requests.length === 1) await gate.promise;
    saved = { ...saved, ...input };
    return saved;
  });
  ui.run('changeGridOptions(-1, { gridWidths: { owner: 130 } })');
  await settle();
  const switching = ui.run('switchSurface("dense")');
  await settle();
  assert.equal(requests.length, 1, "surface write must wait for the pending grid write");
  gate.resolve();
  await switching;
  ui.run('changeGridOptions(-1, { gridWidths: { owner: 145 } })');
  await settle();
  assert.equal(saved.surfaces.find(surface => surface.id === "focus").gridWidths.owner, 130);
  assert.equal(saved.surfaces.find(surface => surface.id === "dense").gridWidths.owner, 145);
  assert.equal(saved.activeSurfaceId, "dense");
});

test("Configure reads wait for pending grid settings instead of replacing them", async () => {
  const gate = deferred();
  let saved = initialConfig();
  let reads = 0;
  const ui = app(async (url, options) => {
    if (url === "/api/display") {
      await gate.promise;
      saved = { ...saved, ...JSON.parse(options.body) };
    } else if (url === "/api/config") reads += 1;
    else assert.fail("Unexpected request: " + url);
    return saved;
  });
  ui.run('changeGridOptions(-1, { gridWidths: { owner: 130 } })');
  await settle();
  const opening = ui.run("openSettings()");
  await settle();
  assert.equal(reads, 0, "Configure cannot read an obsolete pre-save configuration");
  gate.resolve();
  await opening;
  assert.equal(reads, 1);
  assert.equal(ui.run('config.surfaces[0].gridWidths.owner'), 130);
  assert.equal(ui.element("#settingsDialog").open, true);
});

test("a failed grid save remains recoverable through the next config operation", async () => {
  const gate = deferred();
  let saved = initialConfig();
  let calls = 0;
  const ui = app(async (url, options) => {
    calls += 1;
    if (calls === 1) {
      await gate.promise;
      return { httpStatus: 500, body: { error: "disk unavailable" } };
    }
    if (url === "/api/display") saved = { ...saved, ...JSON.parse(options.body) };
    return saved;
  });
  ui.run('changeGridOptions(-1, { gridWidths: { owner: 130 } })');
  await settle();
  const switching = ui.run('switchSurface("dense")');
  gate.resolve();
  await switching;
  assert.equal(ui.run('config.surfaces[0].gridWidths.owner'), 130,
    "another successful response must not erase unsaved local grid changes");
  assert.match(ui.element("#errorBanner").textContent, /Unable to persist grid settings: disk unavailable/);
  ui.run('changeGridOptions(-1, { gridWidths: { owner: 145 } })');
  await settle();
  assert.equal(saved.surfaces.find(surface => surface.id === "focus").gridWidths.owner, 130);
  assert.equal(saved.surfaces.find(surface => surface.id === "dense").gridWidths.owner, 145);
});

test("rapid surface switches keep the latest selection and URL while responses are pending", async () => {
  const gate = deferred();
  let saved = initialConfig();
  let requests = 0;
  const ui = app(async (_url, options) => {
    if (++requests === 1) await gate.promise;
    saved = { ...saved, ...JSON.parse(options.body) };
    return saved;
  });
  const first = ui.run('switchSurface("dense")');
  const second = ui.run('switchSurface("focus")');
  assert.equal(ui.run("activeSurface().id"), "focus");
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(saved.activeSurfaceId, "focus");
  assert.equal(ui.run("activeSurface().id"), "focus");
  assert.equal(new URL(ui.location.href).searchParams.get("surface"), "focus");
});

test("a config response cannot erase an edit made while that read was pending", async () => {
  const gate = deferred();
  let saved = initialConfig();
  const ui = app(async (url, options) => {
    if (url === "/api/config") await gate.promise;
    else saved = { ...saved, ...JSON.parse(options.body) };
    return saved;
  });
  const opening = ui.run("openSettings()");
  await settle();
  ui.run('changeGridOptions(-1, { gridWidths: { owner: 130 } })');
  gate.resolve();
  await opening;
  await settle();
  assert.equal(ui.run('config.surfaces[0].gridWidths.owner'), 130);
  assert.equal(saved.surfaces[0].gridWidths.owner, 130);
});

test("newer detail selections cannot be overwritten by older responses", async () => {
  const gate = deferred();
  const ui = app(async url => {
    const id = Number(new URL(url, "http://local").searchParams.get("runId"));
    if (id === 1) await gate.promise;
    return detail(id);
  });
  const first = ui.run('openDetail("owner/repo", 1)');
  await ui.run('openDetail("owner/repo", 2)');
  gate.resolve();
  await first;
  assert.match(ui.element("#detailTitle").textContent, /Build 2/);
  assert.equal(ui.run("selectedRun.runId"), 2);
});

test("closing a detail dialog invalidates a pending refresh", async () => {
  const gate = deferred();
  let requests = 0;
  const ui = app(async () => {
    requests += 1;
    if (requests === 2) await gate.promise;
    return detail(1);
  });
  await ui.run('openDetail("owner/repo", 1)');
  const refresh = ui.run('renderDetail("owner/repo", 1, false)');
  ui.element("#detailDialog").close();
  gate.resolve();
  await refresh;
  assert.equal(ui.run("selectedRun"), null);
  assert.equal(ui.element("#detailDialog").open, false);
});

test("finishing an old Watch action leaves a newer detail selection in place", async () => {
  const gate = deferred();
  const ui = app(async url => {
    if (url === "/api/watch") { await gate.promise; return { ok: true }; }
    if (url === "/api/state") return { rows: [] };
    return detail(Number(new URL(url, "http://local").searchParams.get("runId")));
  });
  await ui.run('openDetail("owner/repo", 1)');
  const watching = ui.element("#detailActions").children[0].dispatch("click");
  ui.element("#detailDialog").close();
  await ui.run('openDetail("owner/repo", 2)');
  gate.resolve();
  await watching;
  assert.match(ui.element("#detailTitle").textContent, /Build 2/);
  assert.equal(ui.run("selectedRun.runId"), 2);
});

test("finishing an old acknowledgement does not close a newer run dialog", async () => {
  const gate = deferred();
  const ui = app(async url => {
    if (url === "/api/acknowledge") { await gate.promise; return { ok: true }; }
    if (url === "/api/state") return { rows: [] };
    const row = detail(Number(new URL(url, "http://local").searchParams.get("runId")));
    if (row.runId === 1) row.analysis.attention = "action_required";
    return row;
  });
  await ui.run('openDetail("owner/repo", 1)');
  const acknowledging = ui.element("#detailActions").children[1].dispatch("click");
  ui.element("#detailDialog").close();
  await ui.run('openDetail("owner/repo", 2)');
  gate.resolve();
  await acknowledging;
  assert.match(ui.element("#detailTitle").textContent, /Build 2/);
  assert.equal(ui.element("#detailDialog").open, true);
  assert.equal(ui.run("selectedRun.runId"), 2);
});

test("acknowledgement carries the displayed attempt and reports a superseded attempt", async () => {
  let sent;
  const ui = app(async (url, options) => {
    if (url === "/api/acknowledge") {
      sent = JSON.parse(options.body);
      return { httpStatus: 409, body: { error: "run attempt changed; reopen run details" } };
    }
    return { ...detail(1), runAttempt: 3, analysis: { attention: "action_required" } };
  });
  await ui.run('openDetail("owner/repo", 1)');
  const button = ui.element("#detailActions").children[1];
  await button.dispatch("click");
  assert.deepEqual(sent, { repository: "owner/repo", runId: 1, runAttempt: 3 });
  assert.equal(ui.element("#detailDialog").open, true);
  assert.equal(button.disabled, false);
  assert.match(ui.element("#errorBanner").textContent, /attempt changed/);
});

test("a failed detail action reports an error and releases its disabled control", async () => {
  const ui = app(async url => url === "/api/watch"
    ? { httpStatus: 500, body: { error: "watch update failed" } }
    : detail(1));
  await ui.run('openDetail("owner/repo", 1)');
  const button = ui.element("#detailActions").children[0];
  const action = button.dispatch("click");
  assert.equal(button.disabled, true);
  await action;
  assert.equal(button.disabled, false);
  assert.equal(ui.element("#errorBanner").hidden, false);
  assert.match(ui.element("#errorBanner").textContent, /watch update failed/);
});

test("Configure distinguishes environment-only and separately stored credentials", async () => {
  for (const hasStoredGithubToken of [false, true]) {
    const ui = app(async () => ({ ...initialConfig(), hasGithubToken: true,
      githubTokenSource: "environment", hasStoredGithubToken }));
    await ui.run("openSettings()");
    const label = ui.element("#tokenState").textContent;
    assert.match(label, /Using GITHUB_TOKEN from the server environment/);
    assert.match(label, hasStoredGithubToken
      ? /A separate token is also stored locally/ : /No token is stored locally/);
    assert.match(label, /does not change the environment token/);
  }
});


test("Clear stale toolbar reports queueing honestly, including pending and deferred work", async () => {
  const ui = app(async (url, options) => {
    assert.equal(url, "/api/clear-stale");
    assert.equal(options.method, "POST");
    assert.equal(options.body, "{}");
    return { queued: 2, alreadyPending: 1, deferred: 3, rateLimited: true };
  });
  ui.run("latestState = { providerReady: true, rows: [{ providerDataStale: true }] };");
  await ui.element("#clearStaleButton").dispatch("click");
  const feedback = ui.element("#clearStaleStatus").textContent;
  assert.match(feedback, /2 new recheck\(s\) queued/);
  assert.match(feedback, /1 already pending/);
  assert.match(feedback, /3 deferred/);
  assert.match(feedback, /API paused/);
  assert.match(feedback, /after GitHub confirms/);
  assert.equal(ui.element("#clearStaleButton").disabled, false);
});
