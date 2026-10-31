import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeAnalyzer, runExecutionStartEpoch, runExecutionElapsedMs, runQueueWaitingMs } from "../src/core/analyzer.js";
import { RunTracker } from "../src/core/tracker.js";
import { buildDashboard } from "../src/core/dashboard.js";
import { baselineKey, Conclusion, RunState } from "../src/core/model.js";
import { parseRun } from "../src/github.js";
import { FileHistoryStore } from "../src/history-store.js";
import { ConfigStore } from "../src/config-store.js";
import { DEFAULT_SURFACES, normalizeSurface } from "../shared/surfaces.js";
import {
  GRID_FIELD_SET, GRID_DATE_FORMATS, normalizeGridLockedWidths,
  normalizeGridDateFormat, normalizeGridDatePattern, sortGridRows,
  formatGridDate
} from "../shared/focus-grid.js";

function rawRun(status, createdEpoch, runStartedEpoch, updatedEpoch, conclusion = null) {
  const iso = n => new Date(n * 1000).toISOString();
  return {
    id: 901, workflow_id: 7, run_number: 3, name: "CI",
    status, conclusion, event: "push", head_branch: "main",
    created_at: iso(createdEpoch), run_started_at: iso(runStartedEpoch),
    updated_at: iso(updatedEpoch)
  };
}

test("workflow exits queue with elapsed=0 while queue waiting stays separate", () => {
  const created = 1_800_000_000;
  const tracker = new RunTracker();
  const history = { samples: () => [] };
  const analyzer = new RuntimeAnalyzer(history);
  tracker.upsert(parseRun(rawRun("queued", created, created, created + 120),
    "techrote/project"), (created + 120) * 1000);
  let run = tracker.all()[0].snapshot;
  assert.equal(runExecutionElapsedMs(run, created + 120), 0);
  assert.equal(runQueueWaitingMs(run, created + 120), 120000);
  let row = buildDashboard(tracker, analyzer, (created + 120) * 1000, created + 120)[0];
  assert.equal(row.elapsedMs, 0);
  assert.equal(row.waitingMs, 120000);
  assert.equal(row.estimatedRemainingMs, 0);

  tracker.upsert(parseRun(rawRun("in_progress", created, created, created + 130),
    "techrote/project"), (created + 130) * 1000);
  run = tracker.all()[0].snapshot;
  assert.equal(run.observedStartedAtEpoch, created + 130);
  assert.equal(runExecutionElapsedMs(run, created + 130), 0);
  assert.equal(runExecutionElapsedMs(run, created + 150), 20000);
  row = buildDashboard(tracker, analyzer, (created + 150) * 1000, created + 150)[0];
  assert.equal(row.elapsedMs, 20000);
  assert.equal(row.waitingMs, 0);
  assert.equal(row.possiblyStalled, false);
});

test("first job actual start supersedes queue-inclusive run_started_at and terminal updated_at", () => {
  const created = 1_800_000_000;
  const run = {
    ...parseRun(rawRun("completed", created, created, created + 420, "success"), "techrote/project"),
    jobs: [
      { name: "build", state: "completed", conclusion: "success",
        startedAtEpoch: created + 305, completedAtEpoch: created + 350, steps: [] },
      { name: "test", state: "completed", conclusion: "success",
        startedAtEpoch: created + 351, completedAtEpoch: created + 405, steps: [] }
    ]
  };
  assert.equal(runExecutionStartEpoch(run), created + 305);
  assert.equal(runExecutionElapsedMs(run, created + 420), 100000);
  assert.equal(runQueueWaitingMs(run, created + 305), 0);
  assert.match(baselineKey.run(run), /run-exec-v2/);
});

test("history journal records versioned execution-only samples, not inherited queue-inclusive runs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cismon-execution-v2-"));
  try {
    const history = new FileHistoryStore(dir);
    await history.load();
    const created = 1_800_000_000;
    const run = {
      ...parseRun(rawRun("completed", created, created, created + 420, "success"), "techrote/project"),
      jobs: [{ name: "build", state: "completed", conclusion: "success",
        startedAtEpoch: created + 305, completedAtEpoch: created + 405, steps: [] }]
    };
    assert.equal(await history.recordRun(run), true);
    const samples = history.samples(baselineKey.run(run), 32);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].durationMs, 100000);
    const journal = await readFile(path.join(dir, "history.jsonl"), "utf8");
    assert.match(journal, /run-exec-v2/);
    assert.equal(history.samples(JSON.stringify(["run", "techrote/project", 7, "push"]), 32).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("run-level ETA and stall start only with real work, queued job cannot replace run ETA", () => {
  const created = 1_800_000_000;
  const samples = Array.from({ length: 12 }, () => ({ successful: true, durationMs: 120000 }));
  const history = { samples: key => key.startsWith('["run-exec-v2"') ? samples : [] };
  const analyzer = new RuntimeAnalyzer(history);
  const tracker = new RunTracker();
  tracker.upsert(parseRun(rawRun("queued", created, created, created), "techrote/project"), created * 1000);
  let row = buildDashboard(tracker, analyzer, (created + 500) * 1000, created + 500)[0];
  assert.equal(row.elapsedMs, 0);
  assert.equal(row.waitingMs, 500000);
  assert.equal(row.possiblyStalled, false);
  assert.equal(row.estimatedRemainingMs, 0);
  const active = parseRun(rawRun("in_progress", created, created, created + 501), "techrote/project");
  active.jobs = [{name:"await-approval",state:"queued",conclusion:"unknown",
    startedAtEpoch:0,completedAtEpoch:0,steps:[]}];
  tracker.upsert(active,(created + 501) * 1000);
  row = buildDashboard(tracker, analyzer, (created + 531) * 1000, created + 531)[0];
  assert.equal(row.elapsedMs, 30000);
  assert.equal(row.estimatedRemainingMs, 90000);
  assert.equal(row.baselineSamples, 12);
  assert.equal(row.possiblyStalled, false);
});

test("Ctrl-click lock state is per grid/pane and unaffected by sorting", () => {
  assert.equal(GRID_FIELD_SET.has("confQty"), true);
  assert.deepEqual(normalizeGridLockedWidths(["owner", "owner", "confQty", "invalid"]),
    ["owner", "confQty"]);
  const s = normalizeSurface({ id: "focus", layout: "rows",
    gridFields: ["state","updated","confQty"],
    gridWidths: {owner: 212, updated: 140},
    gridLockedWidths: ["owner","updated"],
    gridSortBy: "state", gridSortDir: "asc",
    gridSortSecondaryBy: "updated", gridSortSecondaryDir: "desc" });
  assert.deepEqual(s.gridLockedWidths, ["owner","updated"]);
  assert.equal(s.gridSortSecondaryBy, "updated");
  assert.equal(s.gridSortSecondaryDir, "desc");
  const dual = normalizeSurface({ layout: "focus_dual", dualPanes: [
    { gridLockedWidths:["owner"], gridSortSecondaryBy:"added" },
    { gridLockedWidths:["updated"], gridSortSecondaryBy:"remaining" }
  ]});
  assert.deepEqual(dual.dualPanes[0].gridLockedWidths, ["owner"]);
  assert.deepEqual(dual.dualPanes[1].gridLockedWidths, ["updated"]);
  assert.equal(dual.dualPanes[0].gridSortSecondaryBy, "added");
  assert.equal(dual.dualPanes[1].gridSortSecondaryBy, "remaining");
});

test("secondary sorting is stable and applies only when primary field values tie", () => {
  const rows = [
    { state:"queued",updatedAtEpoch:20,runId:1 },
    { state:"in_progress",updatedAtEpoch:30,runId:2 },
    { state:"queued",updatedAtEpoch:40,runId:3 },
    { state:"in_progress",updatedAtEpoch:10,runId:4 },
    { state:"queued",updatedAtEpoch:40,runId:5 }
  ];
  assert.deepEqual(sortGridRows(rows,"state","asc","updated","desc").map(r=>r.runId),
    [2,4,3,5,1]);
  assert.deepEqual(sortGridRows(rows,"state","asc","updated","asc").map(r=>r.runId),
    [4,2,1,3,5]);
  assert.deepEqual(sortGridRows(rows,"state","asc").map(r=>r.runId),
    [2,4,1,3,5]);
});

test("CONF/QTY is independent of CONF and QTY; date patterns support local and UTC options", () => {
  const normalized = normalizeSurface({ gridFields:["confidence","qty","confQty","added","updated"],
    gridAddedFormat:"custom", gridAddedPattern:"DD/MM/YYYY HH:mm",
    gridUpdatedFormat:"iso_utc" });
  assert.deepEqual(normalized.gridFields,
    ["confidence","qty","confQty","added","updated"]);
  assert.equal(normalized.gridAddedPattern, "DD/MM/YYYY HH:mm");
  assert.equal(normalized.gridUpdatedFormat, "iso_utc");
  assert.ok(GRID_DATE_FORMATS.some(([key])=>key==="relative"));
  assert.equal(normalizeGridDateFormat("invalid"), "short");
  assert.equal(normalizeGridDatePattern("Y".repeat(200)).length,64);
  const epoch = Date.parse("2026-10-31T14:05:07Z")/1000;
  assert.equal(formatGridDate(epoch,"iso_utc"),"2026-10-31T14:05:07Z");
  assert.equal(formatGridDate(epoch,"relative","",epoch*1000 + 90000),"1m ago");
  const d = new Date(epoch*1000);
  const two = n=>String(n).padStart(2,"0");
  assert.equal(formatGridDate(epoch,"custom","DD/MM/YYYY HH:mm"),
    two(d.getDate())+"/"+two(d.getMonth()+1)+"/"+d.getFullYear()+" "+
    two(d.getHours())+":"+two(d.getMinutes()));
});

test("date format and lock customization survive ConfigStore normalization", () => {
  const store = new ConfigStore("/tmp/cismon-model-only");
  const cfg = store.normalize({ surfaces:[{
    id:"focus",name:"Focus",layout:"rows",
    gridLockedWidths:["added"],gridSortBy:"state",
    gridSortSecondaryBy:"added",gridSortSecondaryDir:"desc",
    gridAddedFormat:"custom",gridAddedPattern:"YYYY-MM-DD HH:mm:ss",
    gridUpdatedFormat:"iso_local"
  }],activeSurfaceId:"focus" });
  const surface = cfg.surfaces[0];
  assert.deepEqual(surface.gridLockedWidths,["added"]);
  assert.equal(surface.gridSortSecondaryBy,"added");
  assert.equal(surface.gridAddedFormat,"custom");
  assert.equal(surface.gridAddedPattern,"YYYY-MM-DD HH:mm:ss");
  assert.equal(surface.gridUpdatedFormat,"iso_local");
});


test("witnessed queue exit outranks provisional API start, but already-running discovery uses API", () => {
  const created = 1_800_000_000;
  const tracker = new RunTracker();
  const first = parseRun(rawRun("in_progress", created, created + 45, created + 220), "techrote/project");
  tracker.upsert(first,(created + 220)*1000);
  const discovered = tracker.all()[0].snapshot;
  assert.equal(discovered.observedStartedAtEpoch,0);
  assert.equal(runExecutionStartEpoch(discovered),created + 45);
  assert.equal(runExecutionElapsedMs(discovered,created + 220),175000);

  const witness = new RunTracker();
  witness.upsert(parseRun(rawRun("queued",created,created + 1,created + 100),"techrote/project"),
    (created+100)*1000);
  witness.upsert(parseRun(rawRun("in_progress",created,created + 1,created + 200),"techrote/project"),
    (created+200)*1000);
  const active = witness.all()[0].snapshot;
  assert.equal(active.observedStartedAtEpoch, created+200);
  assert.equal(runExecutionStartEpoch(active), created+200);
  assert.equal(runExecutionElapsedMs(active, created+215),15000);
});


test("Focus headers and editor wire modifier keys and separate date controls", async () => {
  const view = await readFile(new URL("../public/focus-grid.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(view, /event\.ctrlKey/);
  assert.match(view, /event\.shiftKey/);
  assert.match(view, /callbacks\.onSecondarySort/);
  assert.match(view, /callbacks\.onLock/);
  assert.match(view, /options\.gridSortSecondaryBy/);
  assert.match(view, /CONF\/QTY|confQty/);
  for (const id of [
    "surfaceGridSecondarySort","surfaceGridSecondaryDirection",
    "dualPaneSecondarySort","dualPaneSecondaryDirection",
    "surfaceAddedDateFormat","surfaceUpdatedDateFormat",
    "surfaceAddedDatePattern","surfaceUpdatedDatePattern",
    "dualPaneAddedDateFormat","dualPaneUpdatedDateFormat",
    "dualPaneAddedDatePattern","dualPaneUpdatedDatePattern"
  ]) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(app, /gridLockedWidths/);
  assert.match(app, /GRID_DATE_FORMATS/);
});
