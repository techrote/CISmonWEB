import assert from "node:assert/strict";
import test from "node:test";
import { Monitor } from "../src/monitor.js";
import { RunState } from "../src/core/model.js";
import { RunTracker } from "../src/core/tracker.js";
import { RuntimeAnalyzer } from "../src/core/analyzer.js";
import { buildDashboard } from "../src/core/dashboard.js";
import { dueActiveRun } from "../src/scheduler.js";
import {
  activeWorkerSummary, observedRunState, observedRunningJobs
} from "../src/worker-summary.js";

function monitor(get) {
  const m = new Monitor({}, {
    samples: () => [], hasRun: () => false, recordRun: async () => true
  });
  m.client = { get };
  m.config = { backfillRunsPerRepo: 0 };
  m.providerReady = true;
  m.nextDiscoveryMs = Date.now() + 600_000;
  return m;
}

function response(json, status = 200) {
  return {
    status, ok: status === 200, notModified: false, json,
    etag: "", rateRemaining: 4000, rateResetEpoch: 0,
    retryAfterMs: 0, rateLimited: false,
    error: status === 200 ? "" : "HTTP " + status
  };
}

function run(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    repository: "techrote/cybersand", runId: 777,
    workflowId: 7, workflowName: "GDExtension",
    runNumber: 8, event: "pull_request", branch: "test",
    createdAtEpoch: now - 3600,
    runStartedAtEpoch: now - 3600,
    state: RunState.Queued, conclusion: "unknown", jobs: [],
    ...overrides
  };
}

function job(id, status = "completed", now = Math.floor(Date.now() / 1000)) {
  return {
    id, name: "shard " + id, status,
    conclusion: status === "completed" ? "success" : null,
    started_at: new Date((now - 400) * 1000).toISOString(),
    completed_at: status === "completed" ?
      new Date((now - 100) * 1000).toISOString() : null,
    steps: status === "in_progress" ? [{
      name: "Execute original cases", number: 3, status: "in_progress",
      started_at: new Date((now - 80) * 1000).toISOString()
    }] : []
  };
}

test("queued GitHub parent with running children is displayed as executing and occupies runners", async () => {
  const first = Array.from({ length: 100 }, (_, i) => job(1000 + i));
  const second = Array.from({ length: 65 }, (_, i) =>
    job(1100 + i, i < 8 ? "in_progress" : "queued"));
  const calls = [];
  const m = monitor(async path => {
    calls.push(path);
    return response({
      total_count: 165, jobs: path.endsWith("&page=1") ? first : second
    });
  });
  const r = run();
  m.tracker.upsert(r, Date.now());
  const key = r.repository + "#" + r.runId;

  assert.equal(await m.fetchRunDetails(r, Date.now(), false), true);
  let snap = m.tracker.find(r.repository, r.runId).snapshot;
  assert.equal(snap.jobs.length, 100);
  assert.equal(snap.jobsCoverageComplete, false);
  assert.equal(m.liveJobScans.get(key).page, 2);
  assert.equal(activeWorkerSummary(m.tracker.all()).activeWorkers, 0);
  assert.equal(activeWorkerSummary(m.tracker.all()).activeWorkersPartial, true);

  assert.equal(await m.fetchRunDetails(snap, Date.now(), false), true);
  snap = m.tracker.find(r.repository, r.runId).snapshot;
  assert.equal(snap.state, RunState.Queued); // never rewrite GitHub's state
  assert.equal(snap.jobs.length, 165);
  assert.equal(snap.jobsCoverageComplete, true);
  assert.equal(m.liveJobScans.has(key), false);
  assert.equal(observedRunState(snap), RunState.InProgress);
  assert.equal(observedRunningJobs(snap).length, 8);
  const count = activeWorkerSummary(m.tracker.all());
  assert.equal(count.activeWorkers, 8);
  assert.equal(count.workerCoverageRuns, 1);
  assert.equal(count.workerTotalLiveRuns, 1);
  assert.equal(count.workerTotalRunningRuns, 0);
  assert.equal(count.activeWorkersPartial, false);

  const rows = buildDashboard(m.tracker, new RuntimeAnalyzer(m.history),
    Date.now(), Math.floor(Date.now() / 1000), 10);
  assert.equal(rows[0].state, RunState.InProgress);
  assert.equal(rows[0].providerState, RunState.Queued);
  assert.equal(rows[0].observedRunningJobs, 8);
  assert.equal(rows[0].stage, "Execute original cases");
  assert.ok(rows[0].elapsedMs > 0);
  assert.equal(rows[0].waitingMs, 0);
  assert.equal(m.state().trackedActiveCount, 1);
  assert.equal(m.state().trackedQueuedCount, 0);
  assert.equal(m.state().activeWorkers, 8);
  assert.match(calls[0], /per_page=100&page=1$/);
  assert.match(calls[1], /per_page=100&page=2$/);
});

test("queued runs become eligible for details and continuation pages get early priority", async () => {
  const now = Date.now();
  const a = { snapshot: run({runId: 101}) };
  const b = { snapshot: run({runId: 102}) };
  const next = new Map();
  const key = x => x.repository + "#" + x.runId;
  assert.equal(dueActiveRun([a,b], next, now, key), a);
  next.set(key(a.snapshot), -1);
  assert.equal(dueActiveRun([b,a], next, now, key), a);
  next.set(key(a.snapshot), now + 15_000);
  assert.equal(dueActiveRun([a,b], next, now, key), b);

  const paths = [];
  const m = monitor(async path => {
    paths.push(path);
    const pg = path.endsWith("page=1") ? 1 : 2;
    return response({ total_count: 101, jobs: pg === 1
      ? Array.from({ length:100 }, (_, i) => job(i + 1))
      : [job(101, "in_progress")] });
  });
  m.tracker.upsert(a.snapshot, now);
  // No repositories are due, so run details are serviced directly.
  await m.tick();
  assert.equal(paths.length,1);
  assert.equal(m.activeDetailNextMs.get(key(a.snapshot)),-1);
  m.nextRequestAllowedMs=0;
  await m.tick();
  assert.equal(paths.length,2);
  assert.equal(m.liveJobScans.size,0);
  assert.equal(m.state().activeWorkers,1);
});

test("queued summary updates retain observed activity without fabricating provider status", async () => {
  const now = Date.now();
  const r = run({ runId: 811 });
  const m = monitor(async () => response({total_count:1,jobs:[job(811, "in_progress")]}));
  m.tracker.upsert(r, now);
  await m.fetchRunDetails(r, now, false);
  m.tracker.upsert({...r,jobs:[]}, now+1000);
  const snap = m.tracker.find(r.repository,r.runId).snapshot;
  assert.equal(snap.jobs.length,1);
  assert.equal(snap.state,RunState.Queued);
  assert.equal(m.state().activeWorkers,1);
  const repo = {
    fullName:r.repository, etag:"", errors:0, lastActivityMs:now,
    nextPollMs:0, latestUpdatedEpoch:0, hadActive:false, hadQueued:false
  };
  m.client.get=async path => response({workflow_runs:[{
    id:r.runId, name:"GDExtension", workflow_id:7, status:"queued",
    run_number:8, event:"pull_request", created_at:new Date(now-3600000).toISOString()
  }]});
  assert.equal(await m.pollRepository(repo, now+2000),true);
  assert.equal(repo.hadActive,true);
  assert.equal(repo.hadQueued,true);
  assert.equal(m.state().activeWorkers,1);
});

test("explicit empty job details revoke observed activity even under queued parent", async () => {
  const now = Date.now();
  const r=run();
  let hasJob=true;
  const m=monitor(async () => response({total_count:hasJob?1:0,
    jobs:hasJob?[job(22,"in_progress")]:[]}));
  m.tracker.upsert(r,now);
  await m.fetchRunDetails(r,now,false);
  assert.equal(m.state().activeWorkers,1);
  hasJob=false;
  await m.fetchRunDetails(m.tracker.find(r.repository,r.runId).snapshot,now+1000,false);
  const s=m.tracker.find(r.repository,r.runId).snapshot;
  assert.deepEqual(s.jobs,[]);
  assert.equal(s.jobsCoverageComplete,true);
  assert.equal(observedRunState(s),RunState.Queued);
  assert.equal(m.state().activeWorkers,0);
  assert.equal(m.state().activeWorkersPartial,false);
});

test("failed continuation preserves partial evidence and retries same page", async () => {
  const now=Date.now(),r=run();
  let calls=0;
  const paths=[];
  const m=monitor(async path => {
    paths.push(path);
    calls++;
    if(calls===2)return response(null,502);
    return response({total_count:130,jobs:path.endsWith("page=1")
      ? Array.from({length:100},(_,i)=>job(i+1))
      : Array.from({length:30},(_,i)=>job(i+101,i===0?"in_progress":"completed"))});
  });
  m.tracker.upsert(r,now);
  assert.equal(await m.fetchRunDetails(r,now,false),true);
  const before=m.tracker.find(r.repository,r.runId).snapshot;
  assert.equal(await m.fetchRunDetails(before,now,false),false);
  assert.equal(m.tracker.find(r.repository,r.runId).snapshot.jobs.length,100);
  assert.equal(m.liveJobScans.get(r.repository+"#"+r.runId).page,2);
  assert.equal(await m.fetchRunDetails(before,now,false),true);
  assert.equal(m.state().activeWorkers,1);
  assert.equal(m.state().activeWorkersPartial,false);
  assert.equal(paths[1],paths[2]);
  assert.equal(m.state().lastError,"");
});

test("incomplete or stale evidence remains explicitly partial; terminal parents never occupy slots", () => {
  const now=Date.now();
  const r=run({jobs:[{id:4,state:RunState.InProgress}]});
  const tracker=new RunTracker();
  tracker.upsert({...r,jobsFetchedAtMs:now,jobsCoverageComplete:false,jobsExpectedCount:200},now);
  let summary=activeWorkerSummary(tracker.all(),now);
  assert.equal(summary.activeWorkers,1);
  assert.equal(summary.activeWorkersPartial,true);
  summary=activeWorkerSummary(tracker.all(),now+121000);
  assert.equal(summary.activeWorkers,0);
  assert.equal(summary.activeWorkersPartial,true);
  assert.equal(observedRunState(tracker.all()[0].snapshot,now+121000),RunState.Queued);
  tracker.upsert({...r,state:RunState.Completed,jobs:[]},now+122000);
  summary=activeWorkerSummary(tracker.all(),now+122000);
  assert.equal(summary.activeWorkers,0);
  assert.equal(summary.workerTotalLiveRuns,0);
  assert.equal(summary.activeWorkersPartial,false);
});

test("duplicate job IDs are counted once; unknown in-progress IDs force partial coverage", () => {
  const now=Date.now();
  const tracker=new RunTracker();
  const r=run({jobsFetchedAtMs:now,jobsCoverageComplete:true,
    jobs:[{id:31,state:RunState.InProgress},{id:31,state:RunState.InProgress}]});
  tracker.upsert(r,now);
  assert.equal(activeWorkerSummary(tracker.all(),now).activeWorkers,1);
  tracker.upsert({...r,jobs:[{id:0,state:RunState.InProgress}]},now);
  const counts=activeWorkerSummary(tracker.all(),now);
  assert.equal(counts.activeWorkers,0);
  assert.equal(counts.activeWorkersPartial,true);
});
