import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  GRID_DEFAULT_WIDTH,
  GRID_FIELDS,
  DEFAULT_FOCUS_COLUMNS,
  gridFieldRaw,
  normalizeDualPanes,
  normalizeGridFields,
  normalizeGridSortBy,
  normalizeGridWidths,
  reorderGridFields,
  repoOwner,
  repoName,
  sortGridRows
} from "../shared/focus-grid.js";
import { DEFAULT_SURFACES, normalizeSurface, filterRows } from "../shared/surfaces.js";
import { ConfigStore } from "../src/config-store.js";
import { parseRun } from "../src/github.js";
import { RunTracker } from "../src/core/tracker.js";
import { RuntimeAnalyzer } from "../src/core/analyzer.js";
import { buildDashboard } from "../src/core/dashboard.js";

const sample = [
  { repository:"techrote/zz", workflow:"Build", runId:1, runNumber:20,
    state:"in_progress", attention:"suspicious", confidence:"high",
    elapsedMs:50000, estimatedRemainingMs:30000, baselineSamples:20,
    createdAtEpoch:100, updatedAtEpoch:250 },
  { repository:"another/aa", workflow:"Test", runId:2, runNumber:10,
    state:"queued", attention:"normal", confidence:"none",
    elapsedMs:7000, estimatedRemainingMs:0, baselineSamples:0,
    createdAtEpoch:110, updatedAtEpoch:160 }
];

test("Focus fields expose independent owner, repo, attention, timestamps, ETA confidence and QTY", () => {
  assert.ok(DEFAULT_FOCUS_COLUMNS.includes("owner"));
  assert.ok(DEFAULT_FOCUS_COLUMNS.includes("repository"));
  for (const field of ["attention","remaining","confidence","qty","added","updated"]) {
    assert.ok(GRID_FIELDS.some(([key]) => key === field));
  }
  assert.equal(repoOwner(sample[0].repository), "techrote");
  assert.equal(repoName(sample[0].repository), "zz");
  assert.equal(gridFieldRaw(sample[0], "qty"), 20);
  assert.equal(gridFieldRaw(sample[0], "attention"), "suspicious");
  assert.equal(gridFieldRaw(sample[0], "added"), 100);
  assert.equal(gridFieldRaw(sample[0], "updated"), 250);
  assert.equal(gridFieldRaw(sample[0], "remaining"), 30000);
});

test("Grid columns can be disabled, reordered, resized and safely normalized", () => {
  const order = ["owner","repository","attention","qty"];
  assert.deepEqual(reorderGridFields(order, "qty", "repository"),
    ["owner","qty","repository","attention"]);
  assert.deepEqual(reorderGridFields(order, "unknown", "qty"), order);
  assert.deepEqual(normalizeGridFields(["owner","owner","garbage","qty"]), ["owner","qty"]);
  assert.deepEqual(normalizeGridFields(undefined), DEFAULT_FOCUS_COLUMNS);
  assert.deepEqual(normalizeGridWidths({ owner:5, qty:900, bogus:100, attention:"133" }),
    { owner:40, qty:750, attention:133 });
  assert.equal(GRID_DEFAULT_WIDTH.repository, 170);
  assert.equal(normalizeGridSortBy("updated"), "updated");
  assert.equal(normalizeGridSortBy("bad"), "priority");
});

test("Grid sorting handles direction, multiple types, stable ties and priority order", () => {
  assert.deepEqual(sortGridRows(sample, "owner", "asc").map(r => r.runId), [2,1]);
  assert.deepEqual(sortGridRows(sample, "updated", "desc").map(r => r.runId), [1,2]);
  assert.deepEqual(sortGridRows(sample, "qty", "asc").map(r => r.runId), [2,1]);
  assert.deepEqual(sortGridRows(sample, "priority", "asc"), sample);
  const ties = sample.map(row => ({ ...row, baselineSamples:3 }));
  assert.deepEqual(sortGridRows(ties, "qty", "desc").map(r => r.runId), [1,2]);
});

test("Dual panes have independent filters, sort direction, fields, widths and wrapping", () => {
  const base = normalizeSurface({ id:"custom", layout:"focus_dual",
    dualPanes:[
      { name:"Active", repositoryPatterns:["techrote/*"], minAttention:"normal",
        maxItems:3, gridFields:["owner","repository","qty"],
        gridWidths:{owner:180}, gridWrap:true, gridSortBy:"qty", gridSortDir:"asc" },
      { name:"Alert", repositoryPatterns:["another/*"], minAttention:"suspicious",
        maxItems:6, gridFields:["workflow","attention"], gridWrap:false,
        gridSortBy:"updated", gridSortDir:"desc" }
    ]
  });
  assert.equal(base.dualPanes.length,2);
  assert.equal(base.dualPanes[0].gridSortBy,"qty");
  assert.equal(base.dualPanes[0].gridWrap,true);
  assert.equal(base.dualPanes[1].gridSortBy,"updated");
  assert.equal(base.dualPanes[1].gridWrap,false);
  assert.deepEqual(base.dualPanes[0].gridFields,["owner","repository","qty"]);
  assert.deepEqual(base.dualPanes[1].gridFields,["workflow","attention"]);
  assert.equal(base.dualPanes[0].gridWidths.owner,180);
  assert.equal(base.dualPanes[1].gridWidths.owner,undefined);
  assert.equal(filterRows(sample,base.dualPanes[0]).length,1);
  assert.equal(filterRows(sample,base.dualPanes[1]).length,0);
  const second = normalizeDualPanes([],base);
  assert.equal(second.length,2);
  assert.notEqual(second[0],second[1]);
});

test("Legacy settings remain normalized and Focus Dual default retains all existing presets", () => {
  const store = new ConfigStore("/tmp/cismon-focus-grid-model-test");
  const config = store.normalize({
    surfaces: DEFAULT_SURFACES, activeSurfaceId:"focus"
  });
  assert.ok(config.surfaces.some(s => s.id === "focus-dual"));
  assert.ok(config.surfaces.some(s => s.id === "hungry-margins"));
  assert.equal(config.surfaces.find(s => s.id === "focus").layout, "rows");
  assert.equal(config.surfaces.find(s => s.id === "focus-dual").layout,"focus_dual");
  const changed = store.normalize({
    surfaces: [{ id:"focus", layout:"rows", gridFields:["owner","qty"],
      gridWidths:{owner:210}, gridWrap:true,gridSortBy:"qty",gridSortDir:"desc"}],
    activeSurfaceId:"focus"
  });
  assert.deepEqual(changed.surfaces[0].gridFields,["owner","qty"]);
  assert.equal(changed.surfaces[0].gridWidths.owner,210);
});

test("Added and Updated are separate GitHub timestamps; QTY refers to baseline sample count", () => {
  const raw = {
    id:54, workflow_id:44, name:"CI", status:"in_progress",
    conclusion:null, run_number:12, event:"push", head_branch:"main",
    created_at:"2026-10-30T20:00:00Z",
    run_started_at:"2026-10-30T20:10:00Z",
    updated_at:"2026-10-30T20:14:00Z"
  };
  const run = parseRun(raw,"techrote/CISmonWEB");
  assert.equal(run.createdAtEpoch,Date.parse(raw.created_at)/1000);
  assert.notEqual(run.createdAtEpoch,run.startedAtEpoch);
  const history={samples:() => Array.from({length:7},()=>({successful:true,durationMs:120000}))};
  const tracker=new RunTracker();
  tracker.upsert(run,Date.parse(raw.updated_at));
  const rows=buildDashboard(tracker,new RuntimeAnalyzer(history),Date.parse(raw.updated_at),
    Date.parse(raw.updated_at)/1000,30);
  assert.equal(rows.length,1);
  assert.equal(rows[0].baselineSamples,7);
  assert.equal(rows[0].createdAtEpoch,run.createdAtEpoch);
  assert.equal(rows[0].updatedAtEpoch,run.updatedAtEpoch);
});

test("App markup supports minimal mode, popup, draggable fields and two pane controls", async () => {
  const html = await readFile(new URL("../public/index.html",import.meta.url),"utf8");
  for (const name of ["borderlessButton","popupButton","exitBorderlessButton",
    "gridFieldEditor","dualPaneSection","dualPaneSelect","dualGridFieldEditor"]) {
    assert.match(html,new RegExp('id="'+name+'"'));
  }
  const src=await readFile(new URL("../public/app.js",import.meta.url),"utf8");
  assert.match(src,/window\.open\(/);
  assert.match(src,/setMinimalSurface\(/);
  const css=await readFile(new URL("../public/styles.css",import.meta.url),"utf8");
  assert.match(css,/body\.minimal-only \.dashboard/);
});
