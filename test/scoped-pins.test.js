import assert from "node:assert/strict";
import test from "node:test";
import { applyScopedPins, prioritizePinnedRows, selectOperationalFocusRows,
  normalizeSurface, filterRows, sortRows, groupRows } from "../shared/surfaces.js";
import { sortGridRows } from "../shared/focus-grid.js";

const scope = { surfaceId: "desk", paneId: "dual:0" };
const rows = Array.from({ length: 12 }, (_, i) => ({
  repository: i === 10 ? "other/repo" : "owner/repo", runId: i + 1, runAttempt: 1,
  workflow: "Build", branch: "main", event: "push", runNumber: i + 1,
  state: i < 8 ? "in_progress" : "completed", conclusion: i < 8 ? "unknown" : "success",
  attention: "normal", elapsedMs: i * 1000, createdAtEpoch: i + 1,
  manualWatch: false
}));
const pins = [
  { id: "first", scope, ...rows[9], order: 1 },
  { id: "second", scope, ...rows[8], order: 2 },
  { id: "other-pane", scope: { ...scope, paneId: "dual:1" }, ...rows[7], order: 3 }
];
const surface = normalizeSurface({ id: "desk", layout: "rows", focusCondenseHistory: true,
  maxItems: 3, minAttention: "normal", showSuccess: true });

test("pins reserve bounded row slots before Focus condensation and remain independent of watches", () => {
  const scoped = applyScopedPins(rows, pins, scope);
  const selected = selectOperationalFocusRows(scoped, surface).rows;
  assert.deepEqual(selected.map(row => row.runId), [10, 9, 1]);
  assert.equal(selected[0].manualWatch, false);
  assert.equal(selected[1].manualWatch, false);
  assert.equal(rows[9].pinOrder, undefined, "never mutate provider snapshots");
  assert.equal(pins[0].manualWatch, false);
});

test("all ordinary primary and secondary grid sorts keep stable scoped pin ordering", () => {
  const scoped = applyScopedPins(rows, pins, scope);
  for (const primary of ["elapsed", "repository", "workflow", "attention", "state"]) {
    for (const direction of ["asc", "desc"]) {
      const sorted = prioritizePinnedRows(sortGridRows(scoped, primary, direction, "runNumber", direction));
      assert.deepEqual(sorted.slice(0, 2).map(row => row.runId), [10, 9]);
    }
  }
  for (const sort of ["priority", "elapsed", "repository", "remaining"]) {
    assert.deepEqual(sortRows(scoped, { ...surface, sort }).slice(0, 2).map(row => row.runId), [10, 9]);
  }
});

test("independent surfaces, dual/vert panes and exact attempts never share pin priority", () => {
  for (const other of [{ surfaceId: "wall", paneId: "dual:0" }, { ...scope, paneId: "main" },
    { ...scope, paneId: "vert:0" }]) {
    assert.ok(applyScopedPins(rows, pins, other).every(row => row.pinOrder === undefined));
  }
  assert.equal(prioritizePinnedRows(applyScopedPins(rows, pins, { ...scope, paneId: "dual:1" }))[0].runId, 8);
  const rerun = { ...rows[9], runAttempt: 2 };
  assert.equal(applyScopedPins([rerun], pins, scope)[0].pinOrder, undefined);
  assert.equal(applyScopedPins([{ ...rows[9], repository: "OWNER/REPO" }], pins, scope)[0].pinOrder, 1);
});

test("pins honour every explicit filter rather than changing attention, watch or provider status", () => {
  const scoped = applyScopedPins(rows, pins, scope);
  for (const override of [
    { repositoryPatterns: ["other/*"] }, { workflowPatterns: ["Other"] },
    { eventPatterns: ["pull_request"] }, { showSuccess: false },
    { minAttention: "interesting" }, { watchedOnly: true }, { stallsOnly: true }
  ]) {
    const filtered = filterRows(scoped, { ...surface, ...override });
    assert.ok(filtered.every(row => row.pinOrder === undefined));
  }
});

test("grouped cards and lanes put one stable pinned group ahead of every ordinary group", () => {
  const scoped = sortRows(applyScopedPins(rows, pins, scope), surface);
  for (const groupBy of ["repository", "attention", "state"]) {
    const groups = groupRows(scoped, { ...surface, groupBy });
    assert.equal(groups[0].key, "pinned");
    assert.deepEqual(groups[0].rows.map(row => row.runId), [10, 9]);
    assert.ok(groups.slice(1).flatMap(group => group.rows).every(row => row.pinOrder === undefined));
  }
});
