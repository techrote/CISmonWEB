import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { summarizeProviderRows, uniqueWorkflowRows } from "../shared/workflow-view.js";
import { DEFAULT_FOCUS_COLUMNS } from "../shared/focus-grid.js";

const run = (runId, state, attention = "normal", attempt = 1) => ({
  repository: "techrote/CISmonWEB", runId, runAttempt: attempt,
  state, providerState: state, attention,
  jobActivity: { fresh: true, running: state === "queued" ? 3 : 0 }
});

test("overlapping Dual / Vert pane rows count each workflow once", () => {
  const queued = run(1, "queued", "suspicious");
  const running = run(2, "in_progress");
  const shown = [queued, running, queued, { ...queued }];
  const unique = uniqueWorkflowRows(shown);
  assert.equal(shown.length, 4);
  assert.equal(unique.length, 2);
  const totals = summarizeProviderRows(unique);
  assert.equal(totals.queued, 1);
  assert.equal(totals.queuedWithExecutingJobs, 1);
  assert.equal(totals.inProgress, 1);
  assert.equal(unique.filter(r => r.attention === "suspicious").length, 1);
  assert.equal(uniqueWorkflowRows([queued, { ...queued, runAttempt: 2 }]).length, 2);
  assert.equal(uniqueWorkflowRows([queued, { ...queued, repository: "other/repo" }]).length, 2);
});

test("Focus default foregrounds source state, job activity, freshness", () => {
  const order = DEFAULT_FOCUS_COLUMNS;
  assert.ok(order.indexOf("state") < order.indexOf("elapsed"));
  assert.ok(order.includes("jobActivity"));
  assert.ok(order.includes("providerAge"));
  assert.ok(order.indexOf("providerAge") < order.indexOf("stage"));
  assert.ok(!order.includes("confidence")); // Available on demand, not first-line evidence
});

test("UI explains scope, non-simultaneous assignments and median overrun", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const grid = await readFile(new URL("../public/focus-grid.js", import.meta.url), "utf8");
  assert.match(app, /uniqueWorkflowRows\(displayedRows\)/);
  assert.match(app, /pane appearances/);
  assert.match(app, /NOT an instantaneous concurrency measurement/);
  assert.match(app, /coverage incomplete/);
  assert.match(grid, /PAST MED/);
  assert.match(grid, /not calibrated forecast accuracy/);
});

test("existing custom layouts offer explicit, pane-local evidence-first opt-in", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /id="applyFocusEvidenceColumns"/);
  assert.match(html, /id="applyPaneEvidenceColumns"/);
  assert.match(app, /#applyFocusEvidenceColumns".*addEventListener/s);
  assert.match(app, /#applyPaneEvidenceColumns".*addEventListener/s);
  assert.match(app, /writeFieldEditor\("#dualGridFieldEditor", DEFAULT_FOCUS_COLUMNS\)/);
});
