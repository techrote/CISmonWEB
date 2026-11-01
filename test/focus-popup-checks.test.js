import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkTarget, summarizeCheckRuns } from "../src/check-summary.js";
import { Monitor } from "../src/monitor.js";
import { normalizeSurface } from "../shared/surfaces.js";
import {
  normalizeGridRowHeight, GRID_FIELDS, gridFieldRaw
} from "../shared/focus-grid.js";
import { parseRun } from "../src/github.js";
import { buildDashboard } from "../src/core/dashboard.js";
import { RuntimeAnalyzer } from "../src/core/analyzer.js";
import { RunTracker } from "../src/core/tracker.js";

const sha = "a".repeat(40);
const run = {
  repository: "techrote/CISmonWEB",
  event: "pull_request", runId: 100,
  workflowId: 1, runNumber: 2,
  workflowName: "CI",
  state: "in_progress", conclusion: "unknown", checkSha: sha,
  headSha: "b".repeat(40), prNumber: 12
};
const check = (id,status,conclusion) => ({id,status,conclusion});

test("PR check-run tally distinguishes pass/total/failed from pending and skipped", () => {
  const rows = [
    check(1,"completed","success"),
    check(2,"completed","success"),
    check(3,"completed","failure"),
    check(4,"completed","timed_out"),
    check(5,"completed","skipped"),
    check(6,"queued",null),
    check(6,"queued",null)
  ];
  const summary = summarizeCheckRuns(rows,9,false);
  assert.deepEqual(summary,{
    passed:2,failed:2,skipped:1,pending:4,
    total:9,seen:6,complete:false
  });
  assert.deepEqual(summarizeCheckRuns(rows,6,true), {
    passed:2,failed:2,skipped:1,pending:1,total:6,seen:6,complete:true
  });
});

test("Only PR commits with SHA and valid repository become check-run targets", () => {
  assert.deepEqual(checkTarget(run), {repository:"techrote/CISmonWEB",sha});
  assert.equal(checkTarget({...run,event:"push"}),null);
  assert.equal(checkTarget({...run,checkSha:"bad"}),null);
  assert.equal(checkTarget({...run,repository:"invalid"}),null);
});

test("GitHub workflow parser retains PR head SHA rather than synthetic workflow SHA", () => {
  const actual = parseRun({
    id:42,workflow_id:7,run_number:6,name:"CI",
    event:"pull_request",status:"in_progress",head_sha:"c".repeat(40),
    pull_requests:[{number:99,head:{sha}}]
  },"techrote/CISmonWEB");
  assert.equal(actual.checkSha,sha);
  assert.equal(actual.headSha,"c".repeat(40));
  assert.equal(actual.prNumber,99);
  const tracker = new RunTracker();
  tracker.upsert(actual,Date.now());
  const dashboard = buildDashboard(tracker,new RuntimeAnalyzer({samples:()=>[]}),
    Date.now(),Math.floor(Date.now()/1000),10);
  assert.equal(dashboard[0].checkSha,sha);
  assert.equal(dashboard[0].prNumber,99);
});

test("Large PR check matrices paginate without double-counting jobs or false coverage", async () => {
  const monitor = new Monitor({}, {samples:()=>[],hasRun:()=>false});
  const requests = [];
  const first = Array.from({length:100},(_,i)=>check(i+1,"completed","success"));
  const second = [
    check(101,"completed","failure"),check(102,"queued",null)
  ];
  monitor.client = {
    async get(path) {
      requests.push(path);
      return {
        ok:true,status:200,rateRemaining:4700,rateResetEpoch:0,
        json:{total_count:102,check_runs:path.includes("page=2")?second:first}
      };
    }
  };
  monitor.enqueueCheckTarget(run);
  assert.equal(monitor.checkSnapshots.size,1);
  const target=monitor.dueCheckTarget(Date.now());
  assert.ok(target);
  assert.equal(await monitor.pollCheckTarget(target),true);
  assert.equal(target.page,2);
  let counts=monitor.checksForRun(run);
  assert.equal(counts.total,102);
  assert.equal(counts.passed,100);
  assert.equal(counts.pending,2);
  assert.equal(counts.complete,false);
  assert.equal(await monitor.pollCheckTarget(target),true);
  counts=monitor.checksForRun(run);
  assert.equal(counts.passed,100);
  assert.equal(counts.failed,1);
  assert.equal(counts.pending,1);
  assert.equal(counts.complete,true);
  assert.equal(requests.length,2);
  assert.match(requests[0],/commits\/a{40}\/check-runs\?per_page=100&filter=latest&page=1/);
  assert.match(requests[1],/page=2/);
});

test("Unavailable Checks permission backs off without poisoning normal monitor polling", async () => {
  const monitor = new Monitor({}, {samples:()=>[],hasRun:()=>false});
  monitor.client={
    async get(){ return {ok:false,status:403,error:"HTTP 403",rateRemaining:4200,rateResetEpoch:0}; }
  };
  monitor.enqueueCheckTarget(run);
  const target=monitor.dueCheckTarget(Date.now());
  assert.equal(await monitor.pollCheckTarget(target),false);
  assert.ok(target.nextPollMs>Date.now()+14*60000);
  assert.equal(monitor.lastError,"");
  assert.match(monitor.checksForRun(run).error,/403/);
});

test("Focus fixed row height is independently normalized and disabled by zero", () => {
  assert.equal(normalizeGridRowHeight(undefined),0);
  assert.equal(normalizeGridRowHeight(0),0);
  assert.equal(normalizeGridRowHeight(1),18);
  assert.equal(normalizeGridRowHeight(44),44);
  assert.equal(normalizeGridRowHeight(500),160);
  assert.equal(normalizeSurface({gridRowHeight:38}).gridRowHeight,38);
  const dual=normalizeSurface({layout:"focus_dual",dualPanes:[
    {gridRowHeight:24},{gridRowHeight:64}
  ]});
  assert.equal(dual.dualPanes[0].gridRowHeight,24);
  assert.equal(dual.dualPanes[1].gridRowHeight,64);
  const vert=normalizeSurface({layout:"focus_vert",vertCount:2,vertPanes:[
    {gridRowHeight:0},{gridRowHeight:73}
  ]});
  assert.equal(vert.vertPanes[0].gridRowHeight,0);
  assert.equal(vert.vertPanes[1].gridRowHeight,73);
  assert.ok(GRID_FIELDS.some(([name])=>name==="checks"));
  assert.equal(gridFieldRaw({checks:{passed:3,total:5,failed:1}},"checks"),0.6);
});

test("Popup footer/row height/check colors and centered cells are wired without overlay", async () => {
  const html=await readFile(new URL("../public/index.html",import.meta.url),"utf8");
  const css=await readFile(new URL("../public/styles.css",import.meta.url),"utf8");
  const grid=await readFile(new URL("../public/focus-grid.js",import.meta.url),"utf8");
  const app=await readFile(new URL("../public/app.js",import.meta.url),"utf8");
  for(const id of ["minimalFooter","minimalSummary","exitBorderlessButton",
    "surfaceGridRowHeight","dualPaneRowHeight"]) {
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(css,/body\.minimal-only \.minimal-footer/);
  assert.match(css,/\.minimal-exit-button\s*\{\s*position:\s*static/);
  assert.match(css,/\.focus-grid-table \.focus-grid-cell/);
  assert.match(css,/text-align:\s*center/);
  assert.match(css,/\.focus-grid-table\[data-fixed-row-height="true"\]/);
  assert.match(grid,/dataset\.fixedRowHeight/);
  assert.match(grid,/focus-check-pass/);
  assert.match(grid,/focus-check-total/);
  assert.match(grid,/focus-check-fail/);
  assert.match(app,/elements\.minimalSummary\.textContent/);
});
