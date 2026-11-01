import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { activeWorkerSummary } from "../src/worker-summary.js";
import { RunState } from "../src/core/model.js";
import { RunTracker } from "../src/core/tracker.js";
import { ConfigStore } from "../src/config-store.js";
import { normalizeGridOverflowMode, normalizeGridWidths, GRID_MIN_WIDTH } from "../shared/focus-grid.js";
import { normalizeSurface } from "../shared/surfaces.js";

const NOW = 1_800_000_000_000;
function tracked(repo, id, runState, jobs, fetchedAt = NOW) {
  return {
    snapshot: {
      repository: repo, runId: id, state: runState,
      jobs, jobsFetchedAtMs: fetchedAt
    }
  };
}
function job(id, state = RunState.InProgress, runnerName = "") {
  return { id, name:"job", state, runnerName };
}

test("active workers count occupied running-job slots, not running workflows", () => {
  const runs = [
    tracked("techrote/a", 1, RunState.InProgress, [
      job(111), job(112), job(113,RunState.Queued), job(111)
    ]),
    tracked("techrote/b", 2, RunState.InProgress, [
      job(111), job(114,RunState.Completed)
    ]),
    tracked("techrote/c", 3, RunState.Queued, [job(115)]),
    tracked("techrote/d", 4, RunState.Completed, [job(116)])
  ];
  const summary = activeWorkerSummary(runs, NOW);
  assert.equal(summary.activeWorkers, 4); // queued parent c has an executing child
  assert.equal(summary.workerCoverageRuns, 3);
  assert.equal(summary.workerTotalRunningRuns, 2); // GitHub-reported running parents
  assert.equal(summary.workerTotalLiveRuns, 3);
  assert.equal(summary.observedRunningRunCount, 3);
  assert.equal(summary.activeWorkersPartial, false);
});

test("unknown and stale job detail produce an explicit lower bound, not a false zero", () => {
  const runs = [
    tracked("techrote/a",1,RunState.InProgress,[job(1)]),
    tracked("techrote/b",2,RunState.InProgress,[],0),
    tracked("techrote/c",3,RunState.InProgress,[job(3)],NOW - 130_000)
  ];
  const summary = activeWorkerSummary(runs,NOW);
  assert.equal(summary.activeWorkers,1);
  assert.equal(summary.workerCoverageRuns,1);
  assert.equal(summary.workerTotalRunningRuns,3);
  assert.equal(summary.activeWorkersPartial,true);
  assert.equal(activeWorkerSummary([], NOW).activeWorkersPartial,false);
});

test("a running workflow with >100 jobs is a known lower bound, not falsely complete", () => {
  const item = tracked("techrote/matrix", 9, RunState.InProgress, [job(1),job(2)]);
  item.snapshot.jobsCoverageComplete = false;
  const result = activeWorkerSummary([item],NOW);
  assert.equal(result.activeWorkers,2);
  assert.equal(result.workerCoverageRuns,0);
  assert.equal(result.workerTotalRunningRuns,1);
  assert.equal(result.activeWorkersPartial,true);
});

test("tracker keeps detail timestamp across an API summary and ignores completed jobs", () => {
  const tracker = new RunTracker();
  const active = {
    repository:"techrote/a", runId:8, state:RunState.InProgress,
    jobsFetchedAtMs:NOW, jobs:[job(901)]
  };
  tracker.upsert(active,NOW);
  tracker.upsert({repository:"techrote/a",runId:8,state:RunState.InProgress,jobs:[]},NOW+1000);
  assert.equal(tracker.find("techrote/a",8).snapshot.jobsFetchedAtMs,NOW);
  assert.equal(activeWorkerSummary(tracker.all(),NOW+1000).activeWorkers,1);
  tracker.upsert({repository:"techrote/a",runId:8,state:RunState.Completed,jobs:[]},NOW+2000);
  assert.equal(activeWorkerSummary(tracker.all(),NOW+2000).activeWorkers,0);
});

test("overflow modes migrate legacy wrapping and persist independently per pane", () => {
  assert.equal(normalizeGridOverflowMode(undefined, true),"wrap");
  assert.equal(normalizeGridOverflowMode(undefined, false),"ellipsis");
  assert.equal(normalizeGridOverflowMode("hard_clip", true),"hard_clip");
  assert.equal(normalizeGridOverflowMode("bad", true),"wrap");
  assert.equal(GRID_MIN_WIDTH,40);
  assert.deepEqual(normalizeGridWidths({owner:1,qty:39,branch:80}),{owner:40,qty:40,branch:80});
  const store = new ConfigStore("/tmp/cismonweb-focus-polish-pure");
  const cfg = store.normalize({
    surfaces: [{
      id:"focus",layout:"rows",gridWrap:true
    },{
      id:"focus-dual",layout:"focus_dual",dualPanes:[
        {gridWrap:true,gridOverflowMode:"hard_clip"},
        {gridWrap:false,gridOverflowMode:"ellipsis"}
      ]
    },{
      id:"focus-vert",layout:"focus_vert",vertCount:2,vertPanes:[
        {gridOverflowMode:"ellipsis"},
        {gridOverflowMode:"hard_clip"}
      ]
    }]
  });
  assert.equal(cfg.surfaces[0].gridOverflowMode,"wrap");
  assert.equal(cfg.surfaces[1].dualPanes[0].gridOverflowMode,"hard_clip");
  assert.equal(cfg.surfaces[1].dualPanes[1].gridOverflowMode,"ellipsis");
  assert.equal(cfg.surfaces[2].vertPanes[0].gridOverflowMode,"ellipsis");
  assert.equal(cfg.surfaces[2].vertPanes[1].gridOverflowMode,"hard_clip");
  assert.equal(normalizeSurface({gridOverflowMode:"hard_clip"}).gridOverflowMode,"hard_clip");
});

test("header alignment, no padlock glyph, compact times, hard clip, and scrollbar fit are wired", async () => {
  const html = await readFile(new URL("../public/index.html",import.meta.url),"utf8");
  const app = await readFile(new URL("../public/app.js",import.meta.url),"utf8");
  const css = await readFile(new URL("../public/styles.css",import.meta.url),"utf8");
  const grid = await readFile(new URL("../public/focus-grid.js",import.meta.url),"utf8");
  for (const id of ["surfaceGridOverflow","dualPaneOverflow"]) {
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(html,/value="hard_clip"/);
  assert.doesNotMatch(grid,/🔒/);
  assert.match(grid,/usedWidth\(\) > wrap\.clientWidth/);
  assert.match(grid,/wrap\.dataset\.horizontal = "fit"/);
  assert.match(grid,/duration\(ms\)/);
  // Scope the compact separator assertion to CONF/QTY: the run-row tooltip
  // intentionally still contains "repo / workflow" with human-readable spaces.
  assert.match(grid,/case "confQty":\s*return[^\n]*\+ "\/" \+/);
  assert.match(css,/\.focus-grid-wrap\[data-horizontal="fit"\]\s*\{\s*overflow-x:\s*hidden/);
  assert.match(css,/text-align:\s*center/);
  assert.match(css,/vertical-align:\s*middle/);
  assert.match(css,/\.focus-grid-table\[data-wrap="hard_clip"\]/);
  assert.match(css,/text-overflow:\s*clip/);
  assert.match(app,/active workers/);
  assert.match(app,/activeWorkersPartial/);
});

test("server state exposes verified active-worker count and coverage", async () => {
  const content = await readFile(new URL("../src/monitor.js",import.meta.url),"utf8");
  assert.match(content,/activeWorkerSummary\(tracked,\s*nowMs\)/);
  assert.match(content,/\.\.\.workers/);
  assert.match(content,/jobsFetchedAtMs:\s*fetchedAtMs/);
  assert.match(content,/MAX_JOB_DETAIL_PAGES/);
});
