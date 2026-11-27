import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,readdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {TelemetryJournal,projectRun} from "../src/telemetry-journal.js";
import {Monitor} from "../src/monitor.js";
const at=1795816800000;
const analyzer={analyzeRun:()=>({attention:"normal",confidence:"low",baseline:{samples:4,median:1000}}),analyzeJob:()=>({}),analyzeStep:()=>({})};
const tracked={providerConfirmedAtMs:at-1000,snapshot:{repository:"techrote/cybersand",runId:42,runAttempt:2,workflowId:7,headSha:"a".repeat(40),state:"queued",workflowName:"TOKEN=supersecret",jobsFetchedAtMs:at-1000,jobsCoverageComplete:false,jobsExpectedCount:3,jobs:[{id:4,name:"secret",state:"in_progress",runnerName:"private machine",steps:[{number:1,name:"password",state:"in_progress"}]}]}};
test("disabled constructor leaves exporter absent",()=>assert.equal(new Monitor({},{}).telemetry,null));
test("partial matrix and stale evidence; no raw names",()=>{
  const rows=projectRun(tracked,analyzer,at);
  assert.deepEqual(rows.map(x=>x.kind),["run","job","step"]);
  assert.equal(rows[0].attempt,2);assert.equal(rows[0].data.jobsCoverageComplete,false);
  assert.equal(rows[0].data.executionState,"in_progress");
  assert.equal(rows[0].data.baselineSamples,4);
  assert.equal(rows[1].data.runnerHash.length,64);
  assert.doesNotMatch(JSON.stringify(rows),/supersecret|private machine|password|TOKEN/);
  assert.equal(projectRun(tracked,analyzer,at+130000)[0].data.jobsFresh,false);
  assert.equal(projectRun(tracked,analyzer,at,1)[0].data.exportPartial,true);
  assert.equal(projectRun({...tracked,snapshot:{...tracked.snapshot,repository:"other/repo"}},analyzer,at).length,0);
});
test("restart separates torn tail; bounded overflow and 30-day cleanup",async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),"telemetry-"));
  try{
    const h=Math.floor(at/3600000),file=path.join(dir,"telemetry-"+h+".jsonl");
    await writeFile(file,'{"torn":');
    await writeFile(path.join(dir,"telemetry-"+(h-31*24)+".jsonl"),"old");
    const j=new TelemetryJournal(dir,{clock:()=>at,maxBytes:2048});
    j.capture(tracked,analyzer,at);j.offer(Array(100).fill({junk:"x".repeat(1000)}));
    await j.stop();
    const raw=await readFile(file,"utf8");
    assert.match(raw,/^\{"torn":\n/);
    const rows=raw.split("\n").flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});
    assert.ok(rows.some(x=>x.data?.reason==="export-gap"));
    assert.ok(rows.some(x=>x.data?.reason==="session-start"));
    assert.equal((await readdir(dir)).length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("repeat confirmations retain run evidence without replaying an unchanged matrix",async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),"telemetry-"));
  try {
    const j=new TelemetryJournal(dir,{clock:()=>at});
    j.capture(tracked,analyzer,at);j.capture(tracked,analyzer,at+1000);
    j.capture(tracked,analyzer,at+61000);await j.stop();
    const raw=await readFile(path.join(dir,"telemetry-"+Math.floor(at/3600000)+".jsonl"),"utf8");
    const rows=raw.trim().split("\n").map(JSON.parse);
    assert.equal(rows.filter(x=>x.kind==="run").length,3);
    assert.equal(rows.filter(x=>x.kind==="job").length,2);
    assert.equal(rows.filter(x=>x.kind==="run"&&x.data.childrenUnchanged).length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("terminal job-span rejects missing paired timestamps",()=>{
  const t={snapshot:{...tracked.snapshot,state:"completed",jobsCoverageComplete:true,jobs:[{id:1,state:"completed",conclusion:"success",startedAtEpoch:1795816700,completedAtEpoch:1795816750},{id:2,state:"completed",conclusion:"skipped"}]}};
  assert.equal(projectRun(t,analyzer,at)[0].data.jobSpanMs,50000);
  t.snapshot.jobs[0].completedAtEpoch=0;
  assert.equal(projectRun(t,analyzer,at)[0].data.terminalJobsComplete,false);
  assert.equal(projectRun(t,analyzer,at)[0].data.jobSpanMs,undefined);
});
