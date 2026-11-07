import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RunState } from "../src/core/model.js";
import { RunTracker } from "../src/core/tracker.js";
import { RuntimeAnalyzer } from "../src/core/analyzer.js";
import { buildDashboard } from "../src/core/dashboard.js";
import { parseJob } from "../src/github.js";
import {
  activeWorkerSummary, jobActivitySummary,
  observedRunState
} from "../src/worker-summary.js";
import {
  workflowStatusPresentation, summarizeProviderRows
} from "../shared/workflow-view.js";
import { GRID_FIELDS, gridFieldRaw } from "../shared/focus-grid.js";

const NOW = 1_800_000_000_000;
function rawJob(id, status, runnerId = null) {
  return parseJob({
    id, status, name: "matrix shard " + id,
    runner_id: runnerId,
    runner_name: runnerId === null ? null : "GitHub Actions " + runnerId,
    started_at: new Date(NOW - 90000).toISOString()
  });
}
function run(state, jobs, overrides = {}) {
  return {
    repository:"techrote/cybersand", runId:200, runNumber:1567,
    runAttempt:1, workflowId:9,workflowName:"Native C++ validation",
    event:"pull_request",branch:"agent/gas-cache",
    state, conclusion:"unknown",
    createdAtEpoch:NOW/1000-1800,
    runStartedAtEpoch:NOW/1000-120,
    jobs, jobsFetchedAtMs:NOW, jobsCoverageComplete:true,
    ...overrides
  };
}
function row(runData, options = {}) {
  const t=new RunTracker();
  const saved=t.upsert(runData,NOW);
  saved.providerConfirmedAtMs=NOW - (options.providerAgeMs || 0);
  return buildDashboard(t,new RuntimeAnalyzer({ samples:()=>[] }),
    NOW,NOW/1000,30)[0];
}

test("GitHub queued workflow with executing matrix children remains queued in dashboard", () => {
  const jobs=[
    rawJob(1,"in_progress",1001),
    rawJob(2,"in_progress",1002),
    rawJob(3,"queued"),
    rawJob(4,"completed",1004)
  ];
  const runData=run(RunState.Queued,jobs);
  const result=row(runData);
  assert.equal(observedRunState(runData,NOW),RunState.InProgress);
  assert.equal(result.state,RunState.Queued);
  assert.equal(result.providerState,RunState.Queued);
  assert.equal(result.executionState,RunState.InProgress);
  assert.equal(result.jobActivity.running,2);
  assert.equal(result.jobActivity.queued,1);
  assert.equal(result.jobActivity.completed,1);
  assert.equal(result.jobActivity.complete,true);
  assert.equal(result.observedRunningJobs,2);
  const shown=workflowStatusPresentation(result);
  assert.equal(shown.label,"QUEUED");
  assert.equal(shown.detail,"2 JOBS EXECUTING");
  assert.match(shown.title,/GitHub workflow: QUEUED/);
  assert.match(shown.title,/2 jobs executing/);
  assert.equal(summarizeProviderRows([result]).queued,1);
  assert.equal(summarizeProviderRows([result]).inProgress,0);
  assert.equal(summarizeProviderRows([result]).queuedWithExecutingJobs,1);
});

test("In-progress workflow with no executing child is not counted as an assigned worker", () => {
  const data=run(RunState.InProgress,[
    rawJob(1,"completed",1001),rawJob(2,"queued")
  ]);
  const shown=row(data);
  const title=workflowStatusPresentation(shown);
  assert.equal(shown.state,RunState.InProgress);
  assert.equal(title.label,"IN PROGRESS");
  assert.equal(title.detail,"1 JOB WAITING");
  assert.match(title.title,/1 waiting/);
  const count=activeWorkerSummary([{snapshot:data}],NOW);
  assert.equal(count.activeWorkers,0);
  assert.equal(count.workerTotalRunningRuns,1);
  assert.equal(count.workerCoverageRuns,1);
  assert.equal(count.activeWorkersPartial,false);
});

test("runner assignment, job observation and provider workflow counts are separate", () => {
  const queued=run(RunState.Queued,[
    rawJob(1,"in_progress",1001),rawJob(2,"in_progress"),
    rawJob(3,"queued")
  ]);
  const running=run(RunState.InProgress,[
    rawJob(4,"in_progress",1004)
  ],{runId:201});
  const counts=activeWorkerSummary([{snapshot:queued},{snapshot:running}],NOW);
  assert.equal(counts.activeWorkers,2); // assigned real runners only
  assert.equal(counts.observedRunningJobCount,3); // one lacks runner ID
  assert.equal(counts.unassignedRunningJobCount,1);
  assert.equal(counts.workerTotalLiveRuns,2);
  assert.equal(counts.workerTotalRunningRuns,1);
  assert.equal(counts.providerQueuedRunCount,1);
  assert.equal(counts.queuedWithRunningJobsCount,1);
  assert.equal(counts.activeWorkersPartial,true);
  const state=jobActivitySummary(queued,NOW);
  assert.equal(state.running,2);
  assert.equal(state.assignedRunning,1);
  assert.equal(state.unassignedRunning,1);
});

test("stale or incomplete job pages never invent current running activity", () => {
  const stale=run(RunState.Queued,[rawJob(1,"in_progress",1001)],{
    jobsFetchedAtMs:NOW-130_000
  });
  const shown=row(stale);
  assert.equal(shown.state,RunState.Queued);
  assert.equal(shown.jobActivity.fresh,false);
  assert.equal(shown.executionState,RunState.Queued);
  assert.equal(workflowStatusPresentation(shown).detail,"JOBS UNKNOWN");
  assert.equal(activeWorkerSummary([{snapshot:stale}],NOW).activeWorkers,0);
  assert.equal(activeWorkerSummary([{snapshot:stale}],NOW).activeWorkersPartial,true);
  const incomplete=run(RunState.Queued,[rawJob(1,"in_progress",1001)],{
    jobsCoverageComplete:false
  });
  assert.equal(jobActivitySummary(incomplete,NOW).complete,false);
  assert.equal(activeWorkerSummary([{snapshot:incomplete}],NOW).activeWorkersPartial,true);
});

test("source confirmation age and distinct run identity survive dashboard projection", () => {
  const source=row(run(RunState.InProgress,[]),{providerAgeMs:123000});
  assert.equal(source.providerDataStale,true);
  assert.equal(source.providerAgeMs,123000);
  assert.equal(source.runNumber,1567);
  assert.equal(source.runAttempt,1);
  assert.equal(workflowStatusPresentation(source).providerDataStale,true);
  assert.ok(GRID_FIELDS.some(([id])=>id==="jobActivity"));
  assert.ok(GRID_FIELDS.some(([id])=>id==="providerAge"));
  assert.equal(gridFieldRaw(source,"providerAge"),123000);
  assert.equal(gridFieldRaw(source,"jobActivity"),0);
});

test("UI labels GitHub workflow and runner observations separately", async () => {
  const browser=await readFile(new URL("../public/focus-grid.js",import.meta.url),"utf8");
  const app=await readFile(new URL("../public/app.js",import.meta.url),"utf8");
  const monitor=await readFile(new URL("../src/monitor.js",import.meta.url),"utf8");
  assert.match(browser,/workflowStatusPresentation\(row\)/);
  assert.match(browser,/focus-state-provider/);
  assert.match(browser,/focus-state-evidence/);
  assert.match(browser,/runAttempt/);
  assert.match(app,/GitHub in-progress/);
  assert.match(app,/GitHub queued/);
  assert.match(app,/assigned runner slots/);
  assert.match(monitor,/providerConfirmedAtMs/);
  assert.match(monitor,/trackedActiveCount = tracked\.filter/);
});


test("source-matched 46-job matrix preserves queued parent with sixteen assigned runners", () => {
  // Representative of a real CyberSand 2026-11-07 matrix run: GitHub parent
  // queued, while sixteen jobs had runner_id and were already executing.
  const jobs = [
    ...Array.from({length:23}, (_,i)=>rawJob(10+i,"completed",1000+i)),
    ...Array.from({length:16}, (_,i)=>rawJob(100+i,"in_progress",2000+i)),
    ...Array.from({length:7}, (_,i)=>rawJob(200+i,"queued"))
  ];
  const snapshot = run(RunState.Queued,jobs,{runId:500,runNumber:143});
  const result = row(snapshot);
  assert.equal(result.state,RunState.Queued);
  assert.equal(result.executionState,RunState.InProgress);
  assert.equal(result.jobActivity.total,46);
  assert.equal(result.jobActivity.running,16);
  assert.equal(result.jobActivity.queued,7);
  assert.equal(result.jobActivity.completed,23);
  assert.equal(result.jobActivity.assignedRunning,16);
  const counts=activeWorkerSummary([{snapshot}],NOW);
  assert.equal(counts.activeWorkers,16);
  assert.equal(counts.observedRunningJobCount,16);
  assert.equal(counts.providerQueuedRunCount,1);
  assert.equal(counts.workerTotalRunningRuns,0);
  assert.equal(counts.queuedWithRunningJobsCount,1);
  const message=workflowStatusPresentation(result);
  assert.equal(message.label,"QUEUED");
  assert.equal(message.detail,"16 JOBS EXECUTING");
});
