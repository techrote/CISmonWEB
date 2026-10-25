import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SURFACES,
  applySurface,
  groupRows,
  normalizeSurface,
  normalizeSurfaces
} from "../shared/surfaces.js";

const rows = [
  { repository: "techrote/a", workflow: "CI", event: "push", state: "in_progress", conclusion: "unknown", attention: "normal", elapsedMs: 1000, estimatedRemainingMs: 9000, manualWatch: false, possiblyStalled: false },
  { repository: "techrote/b", workflow: "Build", event: "pull_request", state: "in_progress", conclusion: "unknown", attention: "suspicious", elapsedMs: 9000, estimatedRemainingMs: 1000, manualWatch: true, possiblyStalled: true },
  { repository: "other/c", workflow: "CI", event: "push", state: "completed", conclusion: "success", attention: "normal", elapsedMs: 4000, estimatedRemainingMs: 0, manualWatch: false, possiblyStalled: false },
  { repository: "techrote/d", workflow: "Release", event: "workflow_dispatch", state: "completed", conclusion: "failure", attention: "action_required", elapsedMs: 7000, estimatedRemainingMs: 0, manualWatch: false, possiblyStalled: false }
];

test("default surfaces include distinct desk, dense, alert and wallboard profiles", () => {
  assert.deepEqual(DEFAULT_SURFACES.map((surface) => surface.id), ["focus", "dense", "alerts", "wallboard", "repo-lanes", "stalls"]);
  assert.equal(DEFAULT_SURFACES[1].layout, "table");
  assert.equal(DEFAULT_SURFACES[3].hideChrome, true);
});

test("surface normalization clamps unsafe values and de-duplicates ids", () => {
  const normalized = normalizeSurface({
    id: "My Surface !",
    layout: "invalid",
    density: "invalid",
    refreshMs: 10,
    maxItems: 999,
    fields: ["stage", "bogus", "elapsed"]
  });
  assert.equal(normalized.id, "my-surface");
  assert.equal(normalized.layout, "rows");
  assert.equal(normalized.refreshMs, 1000);
  assert.equal(normalized.maxItems, 64);
  assert.deepEqual(normalized.fields, ["stage", "elapsed"]);
  assert.deepEqual(normalizeSurface({ fields: [] }).fields, []);

  const list = normalizeSurfaces([{ id: "x" }, { id: "x" }]);
  assert.equal(list[0].id, "x");
  assert.equal(list[1].id, "x-2");
});

test("surface filters combine attention, state and glob constraints", () => {
  const surface = normalizeSurface({
    repositoryPatterns: ["techrote/*"],
    minAttention: "interesting",
    showSuccess: false,
    showOtherCompleted: false,
    maxItems: 10
  });
  assert.deepEqual(applySurface(rows, surface).map((row) => row.repository), ["techrote/b", "techrote/d"]);
});

test("surface watched and stall filters work independently", () => {
  const watched = normalizeSurface({ watchedOnly: true, maxItems: 10 });
  assert.deepEqual(applySurface(rows, watched).map((row) => row.repository), ["techrote/b"]);

  const stalled = normalizeSurface({ stallsOnly: true, maxItems: 10 });
  assert.deepEqual(applySurface(rows, stalled).map((row) => row.repository), ["techrote/b"]);
});

test("surface sorting and grouping are deterministic", () => {
  const surface = normalizeSurface({ sort: "repository", groupBy: "state", maxItems: 10 });
  const filtered = applySurface(rows, surface);
  assert.deepEqual(filtered.map((row) => row.repository), ["other/c", "techrote/a", "techrote/b", "techrote/d"]);
  const grouped = groupRows(filtered, surface);
  assert.deepEqual(grouped.map((group) => group.key), ["success", "in_progress", "failure"]);
});
