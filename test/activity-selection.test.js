import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../src/config-store.js";
import { Monitor } from "../src/monitor.js";
import {
  normalizeSelectionMode, normalizeActiveAgeDays,
  workflowActivitySummary, shouldKeepRepository
} from "../src/activity-selection.js";
import {
  normalizeGridRowLines, normalizeGridOverflowMode, normalizePane
} from "../shared/focus-grid.js";
import { normalizeSurface } from "../shared/surfaces.js";

const NOW=Date.now();
const make = (days,status="completed") =>
  ({updated_at: new Date(NOW-days*86400000).toISOString(),status});

test("activity mode defaults to seven days and rejects old workflows, not old code pushes",()=>{
  assert.equal(normalizeSelectionMode(undefined),"activity");
  assert.equal(normalizeSelectionMode("all"),"all");
  assert.equal(normalizeActiveAgeDays(undefined),7);
  assert.equal(normalizeActiveAgeDays(0),7);
  assert.equal(normalizeActiveAgeDays(900),365);
  assert.equal(workflowActivitySummary([make(6)],7,NOW).admitted,true);
  assert.equal(workflowActivitySummary([make(8)],7,NOW).admitted,false);
  assert.equal(workflowActivitySummary([make(200,"in_progress")],7,NOW).admitted,true);
  assert.equal(workflowActivitySummary([make(200,"queued")],7,NOW).admitted,true);
  assert.equal(workflowActivitySummary([],7,NOW).admitted,false);
  assert.equal(shouldKeepRepository({hadActive:false,hadQueued:false,lastActivityMs:NOW-8*86400000},7,NOW),false);
});

function mockMonitor(config) {
  const m=new Monitor({},{
    samples:()=>[],hasRun:()=>false,recordRun:async()=>true
  });
  m.config={githubToken:"test",githubOwner:"techrote",
    maxRepositories:100,includePatterns:[],excludePatterns:[],
    backfillRunsPerRepo:1,...config};
  m.client={get:async()=>({ok:true,json:[]})};
  return m;
}
test("discovery admits only active workflows, inactive candidates re-enter after new activity", async()=>{
  let active=false;
  const m=mockMonitor({repositorySelectionMode:"activity",activeAgeDays:7});
  const calls=[];
  m.client={
    async get(url) {
      calls.push(url);
      if(url.startsWith("/user/repos"))return {ok:true,json:[
        {full_name:"techrote/recent"}, {full_name:"techrote/old"}
      ],rateRemaining:4500};
      return {ok:true,json:{
        workflow_runs:[url.includes("/recent/")?make(1):make(active?1:15)]
      },rateRemaining:4500};
    }
  };
  assert.equal(await m.discoverRepositories(),true);
  assert.equal(m.repositories.length,0);
  assert.equal(m.activityCandidates.size,2);
  assert.equal(m.activityProbeQueue.length,2);
  for(let i=0;i<2;i++){
    const candidate=m.nextActivityCandidate(Date.now());
    assert.ok(candidate);
    await m.probeActivityCandidate(candidate);
  }
  assert.deepEqual(m.repositories.map(r=>r.fullName),["techrote/recent"]);
  assert.equal(m.fastSweepQueue.length,1);
  // Simulate a later dormant-repo reprobe, without requiring a restart.
  active=true;
  const old=m.activityCandidates.get("techrote/old");
  old.nextProbeMs=0;
  const candidate=m.nextActivityCandidate(Date.now());
  assert.equal(candidate.fullName,"techrote/old");
  await m.probeActivityCandidate(candidate);
  assert.equal(m.repositories.length,2);
  assert.equal(m.fastSweepQueue.length,2);
  assert.ok(calls.some(x=>x.includes("/actions/runs?per_page=10")));
});

test("all-repositories mode preserves legacy discovery irrespective of workflow dates",async()=>{
  const m=mockMonitor({repositorySelectionMode:"all"});
  m.client={get:async()=>({ok:true,json:[
    {full_name:"techrote/old"}, {full_name:"techrote/empty"}
  ],rateRemaining:4500})};
  await m.discoverRepositories();
  assert.equal(m.repositories.length,2);
  assert.equal(m.activityCandidates.size,0);
  assert.equal(m.fastSweepQueue.length,2);
});

test("discovery failure does not de-admit currently monitored repositories",async()=>{
  let fail=false;
  const m=mockMonitor({repositorySelectionMode:"activity",activeAgeDays:7});
  m.client={get:async(url)=>fail?{ok:false,status:502,error:"HTTP 502",rateRemaining:4100}:
    url.startsWith("/user/")?{ok:true,json:[{full_name:"techrote/recent"}],rateRemaining:4100}:
      {ok:true,json:{workflow_runs:[make(1)]},rateRemaining:4100}};
  await m.discoverRepositories();
  await m.probeActivityCandidate(m.nextActivityCandidate(Date.now()));
  fail=true;
  const admitted=m.repositories[0];
  assert.equal(await m.discoverRepositories(),false);
  assert.equal(m.repositories[0],admitted);
  assert.equal(m.providerReady,true);
});

test("existing local settings default to activity mode but preserve credentials and surfaces",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"cismon-selection-"));
  try {
    await writeFile(path.join(dir,"config.json"),JSON.stringify({
      githubToken:"test",surfaces:[{id:"focus",layout:"rows",name:"My focus"}]
    }));
    const store=new ConfigStore(dir);
    await store.load();
    assert.equal(store.current.repositorySelectionMode,"activity");
    assert.equal(store.current.activeAgeDays,7);
    assert.equal(store.current.githubToken,"test");
    assert.equal(store.current.surfaces[0].name,"My focus");
    await store.update({repositorySelectionMode:"all",activeAgeDays:14});
    const again=new ConfigStore(dir);
    await again.load();
    assert.equal(again.current.repositorySelectionMode,"all");
    assert.equal(again.current.activeAgeDays,14);
  } finally {await rm(dir,{recursive:true,force:true})}
});

test("visible row height counts lines and migrates old pixel heights",()=>{
  assert.equal(normalizeGridRowLines(undefined,48),3);
  assert.equal(normalizeGridRowLines(undefined,0),0);
  assert.equal(normalizeGridRowLines(0,48),0);
  assert.equal(normalizeGridRowLines(5,48),5);
  assert.equal(normalizeGridRowLines(99),12);
  const surface=normalizeSurface({gridRowHeight:64});
  assert.equal(surface.gridRowLines,4);
  assert.equal(normalizePane({gridRowHeight:32}).gridRowLines,2);
  assert.equal(normalizeGridOverflowMode("wrap",false),"wrap");
  assert.equal(normalizeSurface({gridHeaderOverflowMode:"wrap"}).gridHeaderOverflowMode,"wrap");
  assert.equal(normalizePane({gridHeaderOverflowMode:"hard_clip"}).gridHeaderOverflowMode,"hard_clip");
});

test("UI exposes copied-pane actions, header overflow, line count and alternate JavaScript popup",async()=>{
  const html=await readFile(new URL("../public/index.html",import.meta.url),"utf8");
  const app=await readFile(new URL("../public/app.js",import.meta.url),"utf8");
  const css=await readFile(new URL("../public/styles.css",import.meta.url),"utf8");
  for(const id of ["surfaceHeaderOverflow","dualPaneHeaderOverflow",
    "focusCopyTargets","surfaceGridRowHeight","dualPaneRowHeight",
    "repositorySelectionMode","activeAgeDays","popupBlankButton"])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(app,/applyFocusToPanel/);
  assert.match(app,/COPIED_FOCUS_FIELDS/);
  assert.match(app,/window\.open\("about:blank"/);
  assert.match(css,/data-header-overflow="wrap"/);
  assert.match(css,/--focus-row-lines/);
});


test("activity probe failures back off without clearing admissions or losing watch history",async()=>{
  let fail=false;
  const m=mockMonitor({repositorySelectionMode:"activity",activeAgeDays:7});
  m.client={get:async(url)=>url.startsWith("/user/")?
    {ok:true,json:[{full_name:"techrote/current"}],rateRemaining:3000}:
    fail?{ok:false,status:502,error:"HTTP 502",rateRemaining:3000}:
      {ok:true,json:{workflow_runs:[make(1)]},rateRemaining:3000}};
  await m.discoverRepositories();
  const candidate=m.nextActivityCandidate(Date.now());
  await m.probeActivityCandidate(candidate);
  assert.equal(m.repositories.length,1);
  fail=true;
  assert.equal(await m.probeActivityCandidate(candidate),false);
  assert.equal(m.repositories.length,1);
  assert.equal(candidate.errors,1);
  assert.match(m.state().lastError,/activity:techrote\/current.*HTTP 502/);
  assert.ok(candidate.nextProbeMs>Date.now());
  fail=false;
  assert.equal(await m.probeActivityCandidate(candidate),true);
  assert.equal(m.repositories.length,1);
  assert.equal(candidate.errors,0);
  assert.equal(m.state().lastError,"");
});
