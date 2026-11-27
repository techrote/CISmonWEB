import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { jobActivitySummary, activeWorkerSummary, observedRunState } from "./worker-summary.js";

const REPO = "techrote/cybersand", SCHEMA = "actions-rusher.telemetry.v1";
const HOUR = 3600000, DAY = 24 * HOUR;
const states = ["unknown","queued","in_progress","completed"];
const conclusions = ["unknown","success","failure","cancelled","timed_out","skipped","neutral","action_required","startup_failure","stale"];
const events = ["push","pull_request","pull_request_target","workflow_dispatch","workflow_run","schedule","merge_group","repository_dispatch","release","check_suite","create","delete","issue_comment","issues"];
const hash = v => typeof v === "string" && v.length > 0 && v.length <= 8192 ? createHash("sha256").update(v).digest("hex") : undefined;
const sha = v => typeof v === "string" && /^[a-f0-9]{40}$/.test(v) ? v : undefined;
const id = v => Number.isSafeInteger(v) && v > 0 ? String(v) : undefined;
const num = v => Number.isFinite(v) && v >= 0 ? v : undefined;
const time = v => Number.isSafeInteger(v) && v > 0 ? v : undefined;
const epoch = v => time(v) === undefined ? undefined : v * 1000;
const one = (v, allowed) => allowed.includes(v) ? v : undefined;
const bool = v => typeof v === "boolean" ? v : undefined;
const data = (v) => Object.fromEntries(Object.entries(v).filter(([,x]) => x !== undefined));
const envelope = (kind, at, identity, payload) => ({schema:SCHEMA,repository:REPO,origin:"live",kind,observedAt:at,eventAt:at,...identity,data:data(payload)});
function analysis(a) {
  if (!a) return {};
  const b = a.baseline || {};
  return data({attention:one(a.attention,["normal","interesting","suspicious","action_required"]),
    confidence:one(a.confidence,["none","low","medium","high"]),
    elapsedMs:num(a.elapsedMs),waitingMs:num(a.waitingMs),elapsedLowerBound:bool(a.elapsedLowerBound),
    possiblyStalled:bool(a.possiblyStalled),ratio:num(a.ratio),
    z:Number.isFinite(a.z) ? a.z : undefined,estimatedRemainingMs:num(a.estimatedRemainingMs),
    baselineSamples:num(b.samples),baselineMedianMs:num(b.median),baselineMinMs:num(b.minimum),
    baselineMaxMs:num(b.maximum),baselineP25Ms:num(b.p25),baselineP75Ms:num(b.p75),
    baselineMadMs:num(b.mad),baselineEwmaMs:num(b.ewma)});
}
function common(s) {
  return {state:one(s.state,states),conclusion:one(s.conclusion,conclusions),
    startedAt:epoch(s.startedAtEpoch),completedAt:epoch(s.completedAtEpoch)};
}
// Projection contains no raw provider strings, configuration, logs, URLs, paths or errors.
export function projectRun(tracked, analyzer, at, maxRecords = 2000, includeChildren = true) {
  const s = tracked.snapshot;
  if (s.repository !== REPO || !id(s.runId) || !id(s.runAttempt)) return [];
  const identity = data({runId:id(s.runId),attempt:s.runAttempt,workflowId:id(s.workflowId),headSha:sha(s.headSha)});
  const activity = jobActivitySummary(s,at);
  const confirm = time(Math.max(tracked.providerConfirmedAtMs || 0,s.providerConfirmedAtMs || 0));
  const fresh = confirm !== undefined && confirm <= at + 5000 && at-confirm <= 120000;
  const effective = observedRunState(s,at);
  const jobs = Array.isArray(s.jobs) ? s.jobs : [];
  const executed=jobs.filter(j=>j.conclusion!=="skipped");
  const terminalJobsComplete=s.state==="completed"&&s.jobsCoverageComplete===true&&jobs.every(j=>j.state==="completed")&&executed.length>0&&executed.every(j=>epoch(j.startedAtEpoch)!==undefined&&epoch(j.completedAtEpoch)!==undefined&&j.completedAtEpoch>=j.startedAtEpoch);
  const jobSpanMs=terminalJobsComplete?(Math.max(...executed.map(j=>j.completedAtEpoch))-Math.min(...executed.map(j=>j.startedAtEpoch)))*1000:undefined;
  const coverage = {providerConfirmedAt:confirm,providerFresh:fresh,
    jobsFetchedAt:time(s.jobsFetchedAtMs),jobsFresh:activity.fresh,
    jobsCoverageComplete:bool(s.jobsCoverageComplete),jobsExpectedCount:num(s.jobsExpectedCount)};
  const records = [envelope("run",at,identity,{...common(s),...coverage,
    nameHash:hash(s.workflowName),event:one(s.event,events),createdAt:epoch(s.createdAtEpoch),
    updatedAt:epoch(s.updatedAtEpoch),runStartedAt:epoch(s.runStartedAtEpoch),
    firstSeenAt:time(tracked.firstSeenMs),firstObservedRunningAt:epoch(s.firstObservedRunningAtEpoch),
    observedStartedAt:epoch(s.observedStartedAtEpoch),executionState:one(effective,states),
    runningJobs:activity.fresh?activity.running:undefined,queuedJobs:activity.fresh?activity.queued:undefined,
    assignedRunningJobs:activity.fresh?activity.assignedRunning:undefined,
    unassignedRunningJobs:activity.fresh?activity.unassignedRunning:undefined,
    observedJobs:jobs.length,terminalJobsComplete,jobSpanMs,childrenUnchanged:!includeChildren,
    ...analysis(analyzer.analyzeRun({...s,state:effective},Math.floor(at/1000)))})];
  if(!includeChildren)return records;
  let omitted=0,stageAttention="normal",stagePossiblyStalled=false;
  const rank={normal:0,interesting:1,suspicious:2,action_required:3};
  const stage=a=>{if(rank[a.attention]>rank[stageAttention])stageAttention=a.attention;stagePossiblyStalled||=!!a.possiblyStalled;};
  for (const j of jobs) {
    if (!id(j.id)) {omitted++;continue;}
    if (records.length >= maxRecords) {omitted++;break;}
    const ji = {...identity,jobId:id(j.id)};
    const ja=analyzer.analyzeJob(s,j,Math.floor(at/1000));
    if(activity.fresh&&j.state==="in_progress")stage(ja);
    records.push(envelope("job",at,ji,{...common(j),...coverage,nameHash:hash(j.name),
      runnerId:id(j.runnerId),runnerHash:hash(j.runnerName),...analysis(ja)}));
    for(const step of j.steps || []) {
      if(!id(step.number)){omitted++;continue;}
      if(records.length>=maxRecords){omitted++;break;}
      const sa=analyzer.analyzeStep(s,j,step,Math.floor(at/1000));
      if(activity.fresh&&j.state==="in_progress"&&step.state==="in_progress")stage(sa);
      records.push(envelope("step",at,{...ji,stepNumber:step.number},{...common(step),...coverage,
        nameHash:hash(step.name),...analysis(sa)}));
    }
  }
  if(omitted) records[0].data.exportPartial=true;
  if(activity.fresh){records[0].data.stageAttention=stageAttention;records[0].data.stagePossiblyStalled=stagePossiblyStalled;}
  return records;
}

export function projectHealth(monitor,at,reason="heartbeat") {
  const tracked=monitor.tracker.all().filter(t=>t.snapshot.repository===REPO);
  const w=activeWorkerSummary(tracked,at);
  const repo=monitor.repositories.find(x=>x.fullName===REPO);
  return envelope("monitor",at,{},{
    reason,trackedRuns:tracked.length,queuedRuns:w.providerQueuedRunCount,
    runningRuns:w.workerTotalRunningRuns,activeWorkers:w.activeWorkers,
    activeWorkersPartial:w.activeWorkersPartial,workerCoverageRuns:w.workerCoverageRuns,
    workerTotalLiveRuns:w.workerTotalLiveRuns,observedRunningJobs:w.observedRunningJobCount,
    unassignedRunningJobs:w.unassignedRunningJobCount,
    providerReady:bool(monitor.providerReady),repoTracked:!!repo,
    providerConfirmedAt:time(repo?.lastSuccessAtMs),rateRemaining:num(monitor.rateRemaining),
    rateLimitedUntil:time(monitor.rateLimitedUntilMs),
    requestErrors:num(monitor.recentRequestErrors),
    pendingReconciliations:[...monitor.runReconciliations.keys()].filter(k=>k.startsWith(REPO+"#")).length
  });
}

// One writer per directory. Hourly journals, bounded RAM, bounded disk per hour;
// prepend a newline to every append so a torn tail cannot swallow a good batch.
// No provider calls, no blocking fs operations; write failures drop evidence,
// not the monitor. Gaps are reported on the next successful append.
export class TelemetryJournal {
  constructor(dir,{maxBytes=4*1024*1024,hourBytes=32*1024*1024,clock=Date.now}={}) {
    this.dir=dir;this.maxBytes=maxBytes;this.hourBytes=hourBytes;this.clock=clock;
    this.queue=[];this.bytes=0;this.dropped=0;this.writing=null;this.timer=null;
    this.retryAt=0;this.lastPrune=-1;this.lastHealth=0;this.closed=false;
    this.seenJobs=new WeakMap();
    this.offer([envelope("monitor",this.clock(),{},{reason:"session-start"})]);
  }
  capture(tracked,analyzer,at=this.clock()){
    try {
      const s=tracked.snapshot;if(s.repository!==REPO)return;
      // Do not spend unbounded projection work while the writer is saturated.
      if(this.bytes>this.maxBytes*0.9||this.retryAt>at){this.dropped++;this.schedule();return;}
      const jobs=s.jobs,previous=Array.isArray(jobs)?this.seenJobs.get(jobs):undefined;
      // Repeat child samples at least once per minute when detail remains
      // unchanged; summary-only confirmations still produce run snapshots.
      const includeChildren=previous===undefined||at-previous>=60000;
      const rows=projectRun(tracked,analyzer,at,2000,includeChildren);
      if(this.offer(rows)&&includeChildren&&Array.isArray(jobs)&&!rows[0]?.data.exportPartial)this.seenJobs.set(jobs,at);
    }catch {this.dropped++;this.schedule();}
  }
  health(monitor,at=this.clock(),reason="heartbeat"){
    if(reason==="heartbeat"&&at-this.lastHealth<30000)return;
    if(reason==="heartbeat")this.lastHealth=at;
    try{this.offer([projectHealth(monitor,at,reason)]);}catch{this.dropped++;}
  }
  failure(scope,status,at=this.clock()){
    if(!/^(repo:techrote\/cybersand$|(?:run|jobs|backfill):techrote\/cybersand#|scheduler$)/.test(scope))return;
    const reason=scope.split(":")[0];
    this.offer([envelope("monitor",at,{},{reason:reason==="scheduler"?"scheduler-error":"provider-error",httpStatus:num(status)})]);
  }
  reconcile(snapshot,at,reason){
    if(snapshot.repository!==REPO)return;
    this.offer([envelope("monitor",at,data({runId:id(snapshot.runId),attempt:id(snapshot.runAttempt)?snapshot.runAttempt:undefined,workflowId:id(snapshot.workflowId),headSha:sha(snapshot.headSha)}),{reason,providerConfirmedAt:time(snapshot.providerConfirmedAtMs)})]);
  }
  offer(records){
    if(this.closed)return false;
    let complete=true;
    for(const r of records){
      const line=JSON.stringify(r)+"\n", size=Buffer.byteLength(line);
      if(this.bytes+size>this.maxBytes){this.dropped++;complete=false;continue;}
      this.queue.push(line);this.bytes+=size;
    }
    this.schedule();return complete;
  }
  schedule(){
    if(this.timer||this.writing||this.closed||(!this.queue.length&&!this.dropped))return;
    this.timer=setTimeout(()=>{this.timer=null;void this.flush();},Math.max(0,this.retryAt-this.clock(),100));
    this.timer.unref?.();
  }
  async prune(at) {
    const h=Math.floor(at/HOUR);
    if(h===this.lastPrune)return;
    for(const name of await readdir(this.dir)){
      const match=/^telemetry-(\d+)\.jsonl$/.exec(name);
      if(match&&Number(match[1])*HOUR+HOUR<=at-30*DAY)
        await unlink(path.join(this.dir,name)).catch(e=>{if(e.code!=="ENOENT")throw e;});
    }
    this.lastPrune=h;
  }
  async flush(){
    if(this.writing)return this.writing;
    if(!this.queue.length&&!this.dropped)return;
    const at=this.clock();
    if(at<this.retryAt){this.schedule();return;}
    const lines=this.queue;this.queue=[];this.bytes=0;
    const lost=this.dropped;this.dropped=0;
    const gap=lost?JSON.stringify(envelope("monitor",at,{},{reason:"export-gap",droppedRecords:lost}))+"\n":"";
    const payload="\n"+gap+lines.join("");
    this.writing=(async()=>{
      try{
        await mkdir(this.dir,{recursive:true,mode:0o700});
        await this.prune(at);
        const file=path.join(this.dir,"telemetry-"+Math.floor(at/HOUR)+".jsonl");
        const size=await stat(file).then(x=>x.size,e=>{if(e.code==="ENOENT")return 0;throw e;});
        if(size+Buffer.byteLength(payload)>this.hourBytes){
          this.dropped+=lost+lines.length;this.retryAt=(Math.floor(at/HOUR)+1)*HOUR;return;
        }
        await appendFile(file,payload,{mode:0o600});
      }catch{this.dropped+=lost+lines.length;this.retryAt=this.clock()+30000;}
    })();
    try{await this.writing;}finally{this.writing=null;this.schedule();}
  }
  async stop(){
    this.closed=true;if(this.timer)clearTimeout(this.timer);this.timer=null;
    if(this.writing)await this.writing;
    await this.flush();
  }
}
