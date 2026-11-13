import assert from "node:assert/strict";
import test from "node:test";
import { runActionDefinitions, copyText, createContextMenu } from "../public/context-menu.js";
import { ciUrl, prAssociation, commitUrl } from "../shared/interactions.js";

const row = {
  repository: "owner/repo", runId: 22, runAttempt: 3,
  providerState: "in_progress", state: "in_progress", conclusion: "unknown",
  headSha: "a".repeat(40),
  htmlUrl: "https://github.com/owner/repo/actions/runs/22",
  prAssociation: { status: "resolved", number: 31 }
};
function actions(update = {}) {
  const selected = { ...row, ...update.row };
  const association = prAssociation(selected);
  return runActionDefinitions({
    row: selected, association,
    links: { ci: ciUrl(selected), pr: association.url, commit: commitUrl(selected),
      sha: /^[a-f0-9]{40}$/i.test(selected.headSha) ? selected.headSha : "" },
    ...update
  });
}

test("one menu model always begins with copy CI, copy PR, run alert, PR alert", () => {
  for (const rowUpdate of [{}, { prAssociation: null }, { conclusion: "failure", providerState: "completed" }]) {
    const menu = actions({ row: { ...row, ...rowUpdate } });
    assert.deepEqual(menu.slice(0, 4).map(action => action.label), [
      "Copy CI link", "Copy PR link", "Alert when run completes", "Alert when PR checks complete"
    ]);
    assert.deepEqual(menu[4], { separator: true });
    assert.equal(menu.filter(action => action.separator).length, 1);
  }
});

test("unknown, ambiguous and inaccessible PRs do not guess from prNumber", () => {
  for (const status of ["unknown", "ambiguous", "unavailable", "pending"]) {
    const reason = "A specific provider explanation: " + status;
    const menu = actions({ row: { ...row, prNumber: 31, prAssociation: { status, reason } } });
    for (const id of ["copy-pr", "arm-pr", "open-pr"]) {
      const action = menu.find(item => item.id === id);
      assert.equal(action.disabled, true);
      assert.equal(action.reason, reason);
    }
    assert.equal(menu[0].disabled, false);
  }
});

test("cancel remains available on terminal/unavailable rows; watch and pin are independent", () => {
  const menu = actions({ row: { ...row, providerState: "completed", providerUnavailable: true,
    manualWatch: false }, pinned: true, runArmed: { id: "run" }, prArmed: { id: "pr" } });
  assert.equal(menu.find(action => action.id === "cancel-run").disabled, false);
  assert.equal(menu.find(action => action.id === "cancel-pr").disabled, false);
  assert.equal(menu.find(action => action.id === "unpin").checked, true);
  assert.equal(menu.find(action => action.id === "watch").checked, false);
  assert.equal(menu.find(action => action.id === "watch").label, "Watch run");
});

test("provider state alone controls terminal gating; child execution cannot complete a queued run", () => {
  const completed = actions({ row: { ...row, providerState: "completed", state: "in_progress" } });
  assert.equal(completed.find(action => action.id === "arm-run").disabled, true);
  assert.match(completed.find(action => action.id === "arm-run").reason, /No retrospective/);
  const queued = actions({ row: { ...row, providerState: "queued", state: "completed" } });
  assert.equal(queued.find(action => action.id === "arm-run").disabled, false);
  for (const extra of [{ providerState: "unknown" }, { pinStatus: "restoring" }]) {
    assert.equal(actions({ row: { ...row, ...extra } }).find(action => action.id === "arm-run").disabled, true);
  }
});

test("acknowledgement appears only for actionable unacknowledged failures", () => {
  for (const conclusion of ["failure", "timed_out", "action_required", "startup_failure"]) {
    assert.ok(actions({ row: { ...row, conclusion } }).some(action => action.id === "acknowledge"));
    assert.ok(!actions({ row: { ...row, conclusion, acknowledged: true } }).some(action => action.id === "acknowledge"));
  }
  for (const conclusion of ["success", "unknown", "neutral", "skipped", "cancelled"]) {
    assert.ok(!actions({ row: { ...row, conclusion } }).some(action => action.id === "acknowledge"));
  }
});

test("clipboard writes exact selected attempt, verified PR, and full SHA", async () => {
  const copied = [];
  const navigatorObject = { clipboard: { writeText: async value => copied.push(value) } };
  for (const value of [ciUrl(row), prAssociation(row).url, row.headSha]) await copyText(value, navigatorObject);
  assert.deepEqual(copied, [
    "https://github.com/owner/repo/actions/runs/22/attempts/3",
    "https://github.com/owner/repo/pull/31", "a".repeat(40)
  ]);
});

test("clipboard fallback restores focus and reports denied copy accurately", async () => {
  let focusRestored = 0, removed = 0, selected = 0, command = "", text = "";
  const documentObject = {
    activeElement: { isConnected: true, focus() { focusRestored++; } },
    createElement: () => ({ setAttribute() {}, focus() {}, select() { selected++; }, remove() { removed++; } }),
    body: { append(element) { text = element.value; } },
    execCommand(value) { command = value; return true; }
  };
  await copyText("exact-url", { clipboard: { writeText: async () => { throw new Error("denied"); } } }, documentObject);
  assert.equal(text, "exact-url");
  assert.equal(command, "copy");
  assert.equal(selected, 1);
  assert.equal(removed, 1);
  assert.equal(focusRestored, 1);
  documentObject.execCommand = () => false;
  await assert.rejects(copyText("exact-url", {}, documentObject), /denied clipboard/);
  assert.equal(removed, 2);
  assert.equal(focusRestored, 2);
});

test("retained old attempts explain disabled watch and acknowledgement without changing pins", () => {
  const menu = actions({ row: { ...row, actionsAvailable: false, conclusion: "failure",
    actionsUnavailableReason: "Current tracked attempt is 2; this is retained attempt 1." },
    pinned: true, scopeLabel: "Focus Dual / Alerts" });
  for (const id of ["watch", "acknowledge"]) {
    assert.equal(menu.find(action => action.id === id).disabled, true);
    assert.match(menu.find(action => action.id === id).reason, /retained attempt 1/);
  }
  assert.match(menu.find(action => action.id === "unpin").description, /Focus Dual \/ Alerts/);
  assert.equal(menu.find(action => action.id === "arm-run").disabled, true);
});

// Execute the actual menu controller against a small DOM surface. This
// regression models a browser dispatching a queued scroll after a keyboard
// menu opens; it does not replace the production event or focus handlers.
function controllerSurface() {
  class Target {
    constructor() { this.handlers = new Map(); }
    addEventListener(type, handler) { this.handlers.set(type, [...(this.handlers.get(type) || []), handler]); }
    removeEventListener(type, handler) { this.handlers.set(type, (this.handlers.get(type) || []).filter(value => value !== handler)); }
    dispatch(type, values = {}) {
      const event = { type, target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...values };
      for (const handler of this.handlers.get(type) || []) handler(event);
      return event;
    }
  }
  class Element extends Target {
    constructor(tagName, document) {
      super(); this.tagName = tagName; this.ownerDocument = document;
      this.children = []; this.dataset = {}; this.attributes = {}; this.style = {};
      this.rect = { left: 24, top: 380, width: 260, height: 32 };
    }
    append(...values) { for (const child of values) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...values) {
      if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
      for (const child of this.children) child.parentElement = null;
      this.children = []; this.append(...values);
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected); }
    contains(element) { for (let next = element; next; next = next.parentElement) if (next === this) return true; return false; }
    closest(selector) {
      if (selector === "[data-run-context]") return this.dataset.runContext ? this : this.parentElement?.closest?.(selector);
      return null;
    }
    querySelectorAll(selector) {
      const matches = element => selector === "[data-run-context]" ? element.dataset?.runContext :
        selector === '[role^="menuitem"]' ? element.attributes?.role?.startsWith("menuitem") : false;
      const output = [];
      const visit = element => { for (const child of element.children || []) { if (matches(child)) output.push(child); visit(child); } };
      visit(this); return output;
    }
    getBoundingClientRect() { return this.rect; }
    focus() { this.ownerDocument.activeElement = this; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  }
  const document = new Target();
  document.defaultView = Object.assign(new Target(), { innerWidth: 1000, innerHeight: 800 });
  document.createElement = name => new Element(name.toUpperCase(), document);
  document.createTextNode = text => ({ textContent: text });
  document.body = document.createElement("body");
  document.activeElement = document.body;
  const root = document.createElement("section");
  const origin = document.createElement("tr");
  Object.assign(origin.dataset, { runContext: "true", runKey: "owner/repo#22@3", runScope: "desk:vert:2" });
  document.body.append(root); root.append(origin);
  const controller = createContextMenu({ root, resolveTarget: () => ({ row,
    links: { ci: ciUrl(row), pr: prAssociation(row).url, commit: commitUrl(row), sha: row.headSha },
    association: prAssociation(row) }), onSelect() {} });
  const menu = document.body.children.find(element => element.id === "runContextMenu");
  return { document, root, origin, controller, menu };
}

test("queued pre-open scrolls cannot dismiss keyboard menus; actual origin movement still dismisses", () => {
  const { document, root, origin, controller, menu } = controllerSurface();
  origin.focus();
  document.dispatch("keydown", { target: origin, key: "F10", shiftKey: true });
  assert.equal(menu.hidden, false);
  assert.equal(document.activeElement.dataset.action, "copy-ci");
  // A focus()/scrollIntoView operation completed before the menu opened,
  // but Chromium dispatches its scroll event in the following task.
  document.dispatch("scroll", { target: root });
  assert.equal(menu.hidden, false);
  document.dispatch("keydown", { target: document.activeElement, key: "Escape" });
  assert.equal(document.activeElement, origin);
  document.dispatch("keydown", { target: origin, key: "ContextMenu" });
  document.dispatch("scroll", { target: root });
  assert.equal(menu.hidden, false);
  origin.rect.top -= 24;
  document.dispatch("scroll", { target: root });
  assert.equal(menu.hidden, true, "an actual ancestor scroll detaches and dismisses the menu");
  controller.destroy();
});

test("scrolling another pane leaves the current run menu usable", () => {
  const { document, root, origin, controller, menu } = controllerSurface();
  root.dispatch("contextmenu", { target: origin, clientX: 30, clientY: 400 });
  assert.equal(menu.hidden, false);
  const otherPane = document.createElement("section");
  document.body.append(otherPane);
  document.dispatch("scroll", { target: otherPane });
  assert.equal(menu.hidden, false);
  document.dispatch("keydown", { target: document.activeElement, key: "ArrowDown" });
  assert.equal(document.activeElement.dataset.action, "copy-pr");
  controller.destroy();
});
