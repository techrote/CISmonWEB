import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildDashboard } from "../src/core/dashboard.js";
import { RunTracker } from "../src/core/tracker.js";
import { RuntimeAnalyzer } from "../src/core/analyzer.js";
import { workflowStatusPresentation, summarizeProviderRows } from "../shared/workflow-view.js";
import {
  normalizeSurface, selectOperationalFocusRows
} from "../shared/surfaces.js";

const NOW = 1_800_000_000_000;
const focus = {
  id: "focus", layout: "rows", sort: "priority",
  minAttention: "normal", focusCondenseHistory: true,
  watchedOnly: false, stallsOnly: false, maxItems: 16
};
function item(id, state, conclusion, options = {}) {
  return {
    repository: "techrote/example",
    workflow: "Build " + id,
    branch: "main", event: "push",
    runId: id, runNumber: id, runAttempt: 1,
    createdAtEpoch: NOW / 1000 - 2000 + id,
    state, conclusion,
    attention: state === "completed" && conclusion === "failure"
      ? "action_required" : "normal",
    manualWatch: false, ...options
  };
}
function sourceRow(state, ageMs) {
  const tracker = new RunTracker();
  const created = Math.floor((NOW - 35 * 60_000) / 1000);
  const run = {
    repository: "techrote/example", workflowId: 10, workflowName: "Build",
    runId: state === "completed" ? 10 : 11, runNumber: 10,
    event: "push", branch: "main", runAttempt: 1,
    createdAtEpoch: created, runStartedAtEpoch: created + 30,
    updatedAtEpoch: Math.floor((NOW - ageMs) / 1000),
    state, conclusion: state === "completed" ? "failure" : "unknown",
    jobs: []
  };
  const tracked = tracker.upsert(run, NOW);
  tracked.providerConfirmedAtMs = NOW - ageMs;
  const rows = buildDashboard(tracker,
    new RuntimeAnalyzer({ samples: () => [] }), NOW, NOW / 1000, 30);
  assert.equal(rows.length, 1);
  return rows[0];
}

test("completed failures retain confirmation age but never claim live PARENT STALE", () => {
  const finished = sourceRow("completed", 19 * 60_000);
  assert.equal(finished.state, "completed");
  assert.equal(finished.providerAgeMs, 19 * 60_000);
  assert.equal(finished.providerDataStale, false);
  assert.equal(workflowStatusPresentation(finished).providerDataStale, false);
  assert.equal(summarizeProviderRows([finished]).providerStale, 0);
  // Defensive presentation: even a legacy terminal row marked stale cannot
  // masquerade as live synchronization trouble.
  const legacy = { ...finished, providerDataStale: true };
  assert.equal(workflowStatusPresentation(legacy).providerDataStale, false);
  assert.equal(summarizeProviderRows([legacy]).providerStale, 0);
  const live = sourceRow("in_progress", 19 * 60_000);
  assert.equal(live.providerDataStale, true);
  assert.equal(workflowStatusPresentation(live).providerDataStale, true);
  assert.equal(summarizeProviderRows([live]).providerStale, 1);
});

test("Focus reserves live capacity and limits duplicate historical failures", () => {
  const live = Array.from({ length: 5 }, (_, i) =>
    item(100 + i, "in_progress", "unknown"));
  const repeated = Array.from({ length: 7 }, (_, i) =>
    item(200 + i, "completed", "failure",
      { workflow: "Repeated CI", branch: "fix/repeat" }));
  // Later successful run on same branch+event supersedes those attempts in
  // operational Focus, but not in the persisted failure history or Alerts.
  const recovered = item(300, "completed", "success",
    { workflow: "Repeated CI", branch: "fix/repeat" });
  const otherFailures = Array.from({ length: 9 }, (_, i) =>
    item(400 + i, "completed", "failure",
      { workflow: "Failing CI " + i, branch: "fix/" + i }));
  const successes = Array.from({ length: 15 }, (_, i) =>
    item(500 + i, "completed", "success",
      { workflow: "Healthy CI " + i }));
  const raw = [...repeated, ...otherFailures, ...successes, ...live, recovered];
  const selected = selectOperationalFocusRows(raw, focus);
  assert.equal(selected.condensed, true);
  assert.equal(selected.rows.length, 16);
  assert.deepEqual(selected.rows.slice(0, 5).map(x => x.runId),
    live.map(x => x.runId));
  assert.equal(selected.rows.filter(x => x.conclusion === "failure").length, 4);
  assert.equal(selected.rows.filter(x => x.workflow === "Repeated CI" &&
    x.conclusion === "failure").length, 0);
  assert.equal(selected.hiddenFailures, repeated.length + otherFailures.length - 4);
  assert.ok(raw.some(x => x.runId === 200)); // original monitor input untouched
});

test("different branches and manual watches are not collapsed together", () => {
  const first = item(1, "completed", "failure", {
    workflow: "Build", branch: "feature/A"
  });
  const latestA = item(2, "completed", "success", {
    workflow: "Build", branch: "feature/A"
  });
  const B = item(3, "completed", "failure", {
    workflow: "Build", branch: "feature/B"
  });
  let selection = selectOperationalFocusRows([first, latestA, B], focus);
  assert.deepEqual(selection.rows.map(r => r.runId), [3, 2]);
  assert.equal(selection.hiddenFailures, 1);
  selection = selectOperationalFocusRows(
    [{ ...first, manualWatch: true }, latestA, B], focus
  );
  assert.deepEqual(selection.rows.map(r => r.runId), [1, 3, 2]);
  assert.equal(selection.hiddenFailures, 0);
});

test("opt-out and diagnostic views preserve the uncondensed order", () => {
  const list = Array.from({ length: 20 }, (_, i) =>
    item(i + 1, "completed", "failure"));
  for (const surface of [
    { ...focus, focusCondenseHistory: false },
    { ...focus, id: "alerts", focusCondenseHistory: false },
    { ...focus, minAttention: "interesting" },
    { ...focus, watchedOnly: true },
    { ...focus, stallsOnly: true }
  ]) {
    const selected = selectOperationalFocusRows(list, surface);
    assert.equal(selected.condensed, false);
    assert.deepEqual(selected.rows.map(x => x.runId),
      list.slice(0, focus.maxItems).map(x => x.runId));
    assert.equal(selected.hiddenFailures, 0);
  }
});

test("existing saved Focus adopts policy while other surfaces do not", () => {
  assert.equal(normalizeSurface({ id: "focus" }).focusCondenseHistory, true);
  assert.equal(normalizeSurface({
    id: "focus", focusCondenseHistory: false
  }).focusCondenseHistory, false);
  assert.equal(normalizeSurface({ id: "dense" }).focusCondenseHistory, false);
  assert.equal(normalizeSurface({ id: "my-view" }).focusCondenseHistory, false);
});

test("Focus editor persists explicit operational mode without changing monitoring", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="surfaceFocusCondenseHistory"/);
  assert.match(app, /selectOperationalFocusRows\(matchedRows, surface\)/);
  assert.match(app, /surfaceFocusCondenseHistory"\)\.checked = surface\.focusCondenseHistory/);
  assert.match(app, /focusCondenseHistory: \$\("#surfaceFocusCondenseHistory"\)\.checked/);
  assert.match(app, /other failed runs not shown/);
});
