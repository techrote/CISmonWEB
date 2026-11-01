import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { separatorBreakSegments } from "../shared/focus-grid.js";
import { normalizeSurface } from "../shared/surfaces.js";
import { RunTracker } from "../src/core/tracker.js";
import {
  RuntimeAnalyzer, isObservedOnlyExecutionStart,
  runExecutionElapsedMs, runExecutionStartEpoch
} from "../src/core/analyzer.js";
import { buildDashboard } from "../src/core/dashboard.js";
import { parseRun } from "../src/github.js";

const start = 1_800_000_000;
const iso = t => new Date(t * 1000).toISOString();
const raw = (state, updated = start + 120) => ({
  id: 75, run_attempt: 1, workflow_id: 4, run_number: 2,
  name: "Native CI", status: state, conclusion: null,
  event: "pull_request", created_at: iso(start),
  run_started_at: iso(start), updated_at: iso(updated)
});
function row(tracker, epoch) {
  const analyzer = new RuntimeAnalyzer({ samples: () => [] });
  const rows = buildDashboard(tracker, analyzer, epoch * 1000, epoch);
  assert.equal(rows.length, 1);
  return rows[0];
}

test("underscore/dash/dot offer discretionary breaks immediately AFTER separators", () => {
  assert.deepEqual(separatorBreakSegments("pull_request"), ["pull_", "request"]);
  assert.deepEqual(separatorBreakSegments("feature-branch.test"), ["feature-", "branch.", "test"]);
  assert.deepEqual(separatorBreakSegments("owner_repo-a.b"), ["owner_", "repo-", "a.", "b"]);
  assert.deepEqual(separatorBreakSegments("plain"), ["plain"]);
  assert.deepEqual(separatorBreakSegments("trailing_"), ["trailing_"]);
  assert.deepEqual(separatorBreakSegments("a__b"), ["a_", "_", "b"]);
  assert.equal(separatorBreakSegments("pull_request").join(""), "pull_request");
});

test("separator-break toggle defaults on and round-trips for surfaces and panes", () => {
  assert.equal(normalizeSurface({}).gridBreakAfterSeparators, true);
  assert.equal(normalizeSurface({ gridBreakAfterSeparators: false }).gridBreakAfterSeparators, false);
  const dual = normalizeSurface({
    layout:"focus_dual",
    gridBreakAfterSeparators:false,
    dualPanes:[
      { gridBreakAfterSeparators:true },
      { gridBreakAfterSeparators:false }
    ]
  });
  assert.equal(dual.dualPanes[0].gridBreakAfterSeparators, true);
  assert.equal(dual.dualPanes[1].gridBreakAfterSeparators, false);
  const vert = normalizeSurface({
    layout:"focus_vert", vertCount:2,
    vertPanes:[{gridBreakAfterSeparators:false},{gridBreakAfterSeparators:true}]
  });
  assert.equal(vert.vertPanes[0].gridBreakAfterSeparators, false);
  assert.equal(vert.vertPanes[1].gridBreakAfterSeparators, true);
});

test("first-seen running run without job/start evidence shows lower-bound elapsed, not blank", () => {
  const tracker = new RunTracker();
  tracker.upsert(parseRun(raw("in_progress")), (start + 120) * 1000);
  let run = tracker.all()[0].snapshot;
  assert.equal(run.observedStartedAtEpoch, 0);
  assert.equal(run.firstObservedRunningAtEpoch, start + 120);
  assert.equal(runExecutionStartEpoch(run), start + 120);
  assert.equal(isObservedOnlyExecutionStart(run), true);
  let a = row(tracker, start + 120);
  assert.equal(a.state, "in_progress");
  assert.equal(a.elapsedMs, 0);
  assert.equal(a.elapsedLowerBound, true);
  assert.equal(a.estimatedRemainingMs, 0);

  // Another summary refresh must preserve the original observation anchor,
  // not restart the clock every time the API returns in_progress.
  tracker.upsert(parseRun(raw("in_progress",start+128)), (start + 128) * 1000);
  run = tracker.all()[0].snapshot;
  assert.equal(run.firstObservedRunningAtEpoch, start + 120);
  assert.equal(runExecutionElapsedMs(run, start+128), 8000);
  a = row(tracker,start+128);
  assert.equal(a.elapsedMs,8000);
  assert.equal(a.elapsedLowerBound,true);
});

test("real job timing supersedes the observed-only lower-bound clock", () => {
  const tracker = new RunTracker();
  tracker.upsert(parseRun(raw("in_progress")), (start + 120) * 1000);
  const detail = parseRun(raw("in_progress",start+138));
  detail.jobs = [{
    id: 6, name:"native build", state:"in_progress",
    startedAtEpoch:start+112, completedAtEpoch:0, steps:[]
  }];
  detail.jobsFetchedAtMs=(start+138)*1000;
  tracker.upsert(detail,(start+138)*1000);
  const run=tracker.all()[0].snapshot;
  assert.equal(runExecutionStartEpoch(run), start+112);
  assert.equal(isObservedOnlyExecutionStart(run),false);
  const a=row(tracker,start+138);
  assert.equal(a.elapsedMs,26000);
  assert.equal(a.elapsedLowerBound,false);
});

test("queued wait does not create an execution clock, and reruns never inherit it", () => {
  const tracker=new RunTracker();
  tracker.upsert(parseRun(raw("queued")), (start + 120)*1000);
  let run=tracker.all()[0].snapshot;
  assert.equal(run.firstObservedRunningAtEpoch,0);
  assert.equal(row(tracker,start+125).elapsedMs,0);
  tracker.upsert(parseRun(raw("in_progress",start+130)), (start+130)*1000);
  run=tracker.all()[0].snapshot;
  assert.equal(run.observedStartedAtEpoch,start+130);
  assert.equal(isObservedOnlyExecutionStart(run),false);
  assert.equal(runExecutionElapsedMs(run,start+140),10000);
  const another={...raw("in_progress",start+160),run_attempt:2};
  tracker.upsert(parseRun(another),(start+160)*1000);
  run=tracker.all()[0].snapshot;
  assert.equal(run.observedStartedAtEpoch,0);
  assert.equal(run.firstObservedRunningAtEpoch,start+160);
});

test("observed-only elapsed cannot create spurious ETA or stall warnings from history", () => {
  const tracker = new RunTracker();
  tracker.upsert(parseRun(raw("in_progress")), (start + 120) * 1000);
  const history = {
    samples: () => Array.from({length:12}, () => ({
      successful: true, durationMs: 60_000
    }))
  };
  const analyzer = new RuntimeAnalyzer(history);
  const [row] = buildDashboard(
    tracker, analyzer, (start + 420)*1000, start + 420
  );
  assert.equal(row.elapsedMs,300_000);
  assert.equal(row.elapsedLowerBound,true);
  assert.equal(row.baselineSamples,12);
  assert.equal(row.estimatedRemainingMs,0);
  assert.equal(row.ratio,0);
  assert.equal(row.possiblyStalled,false);
  assert.equal(row.attention,"normal");
});

test("a queued provider with an observed running child gets the elapsed lower-bound fallback", () => {
  const tracker = new RunTracker();
  tracker.upsert(parseRun(raw("queued")), (start+120)*1000);
  const details = parseRun(raw("queued",start+130));
  details.jobs=[{
    id:9,state:"in_progress",startedAtEpoch:0,completedAtEpoch:0,steps:[]
  }];
  details.jobsFetchedAtMs=(start+130)*1000;
  tracker.upsert(details,(start+130)*1000);
  assert.equal(tracker.all()[0].snapshot.firstObservedRunningAtEpoch,start+130);
  // The display intentionally upgrades queued parent to in_progress from
  // actual executing child evidence; in that view elapsed counts from here.
  const displayed = row(tracker,start+140);
  assert.equal(displayed.state,"in_progress");
  assert.equal(displayed.elapsedLowerBound,true);
  assert.equal(displayed.elapsedMs,10000);
});

test("separator breaks are DOM wbr nodes only when wrapping; no text modification", async () => {
  const browser=await readFile(new URL("../public/focus-grid.js",import.meta.url),"utf8");
  const html=await readFile(new URL("../public/index.html",import.meta.url),"utf8");
  const app=await readFile(new URL("../public/app.js",import.meta.url),"utf8");
  assert.match(browser, /document\.createElement\("wbr"\)/);
  assert.match(browser, /table\.dataset\.wrap === "wrap"/);
  assert.match(browser, /table\.dataset\.headerOverflow === "wrap"/);
  assert.match(browser, /options\.gridBreakAfterSeparators !== false/);
  assert.match(browser, /elapsedLowerBound/);
  assert.match(html, /id="surfaceGridBreakAfterSeparators"/);
  assert.match(html, /id="dualPaneBreakAfterSeparators"/);
  assert.match(app, /gridBreakAfterSeparators/);
});

test("telemetry labels and values are centred inside every cell", async () => {
  const css=await readFile(new URL("../public/styles.css",import.meta.url),"utf8");
  assert.match(css, /\.telemetry > div \{[^}]*text-align: center;[^}]*align-items: center;/s);
  assert.match(css, /\.telemetry \.label,\s*\.telemetry strong \{[^}]*text-align: center;/s);
});
