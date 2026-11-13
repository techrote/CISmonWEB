import assert from "node:assert/strict";
import test from "node:test";
import { runActionDefinitions, copyText } from "../public/context-menu.js";
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
