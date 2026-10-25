import assert from "node:assert/strict";
import test from "node:test";
import { observeTransitions } from "../shared/fun-core.js";
import {
  HUNGRY_PROTOCOL,
  hungryAnchor,
  hungryAmbientEvents,
  hungryIdleStrokes,
  hungryTransitionPulses,
  projectHungryCI
} from "../shared/hungry-ci.js";

const runs = [
  {
    repository: "techrote/cybersand", runId: 101,
    workflow: "native build", state: "in_progress", conclusion: "unknown",
    attention: "normal", possiblyStalled: false, ratio: 1.1
  },
  {
    repository: "techrote/neurounner", runId: 102,
    workflow: "train", state: "queued", conclusion: "unknown",
    attention: "normal", possiblyStalled: false, ratio: 0
  },
  {
    repository: "techrote/cybersand", runId: 103,
    workflow: "test", state: "completed", conclusion: "failure",
    attention: "action_required", possiblyStalled: false, ratio: 5
  },
  {
    repository: "techrote/another", runId: 104,
    workflow: "qualification", state: "in_progress", conclusion: "unknown",
    attention: "suspicious", possiblyStalled: true, ratio: 2.7
  }
];

test("Hungry scene aggregates accurate statuses and no raw GitHub metadata crosses into artwork", () => {
  const scene = projectHungryCI(runs);
  assert.deepEqual(scene.counts, {
    running: 2, queued: 1, failed: 1, success: 0, stalled: 1, total: 4
  });
  assert.equal(scene.anchors.length, 4);
  assert.ok(scene.queuePressure > 0);
  assert.ok(scene.failurePressure > 0);
  assert.ok(scene.stallPressure > 0);
  assert.ok(scene.activity > 0);
  assert.equal(JSON.stringify(scene).includes("techrote"), false);
  assert.equal(JSON.stringify(scene).includes("workflow"), false);
  assert.equal(JSON.stringify(scene).includes("runId"), false);
  assert.equal(HUNGRY_PROTOCOL, "cismon-hungry-v1");
});

test("idle field is never visually inert in the absence of GitHub activity", () => {
  const empty = projectHungryCI([]);
  const p0 = hungryIdleStrokes(empty, 0);
  const p1 = hungryIdleStrokes(empty, 7);
  assert.equal(p0.length, 2);
  assert.notDeepEqual(p0.map(p=>[p.x,p.y]),p1.map(p=>[p.x,p.y]));
  assert.deepEqual(p0, hungryIdleStrokes(empty, 0));
  assert.ok(p0.every(p => p.force > 0));
  assert.equal(hungryIdleStrokes(empty, 1, "off").length, 0);
});

test("idle positions, pressure and intensities stay finite and bounded", () => {
  const scenarios = [projectHungryCI([]), projectHungryCI(runs), projectHungryCI(Array(100).fill(runs[1]))];
  for (const scene of scenarios) {
    for (const motion of ["subtle", "normal", "intense"]) {
      for (const t of [0, .17, 10, 200, 24000]) {
        for (const p of hungryIdleStrokes(scene, t, motion, 75)) {
          assert.ok(Number.isFinite(p.x) && p.x >= 0 && p.x <= 1);
          assert.ok(Number.isFinite(p.y) && p.y >= 0 && p.y <= 1);
          assert.ok(Number.isFinite(p.force) && p.force >= 0 && p.force <= 1);
        }
      }
    }
  }
  assert.ok(projectHungryCI(Array(100).fill(runs[1])).queuePressure >
    projectHungryCI(runs.filter(r=>r.state!=="queued")).queuePressure);
});

test("anchor identities are stable but distinct for different run IDs", () => {
  const a = hungryAnchor(runs[0]);
  const b = hungryAnchor(runs[1]);
  assert.deepEqual(a, hungryAnchor(runs[0]));
  assert.notDeepEqual(a, b);
  assert.ok(a.x > .15 && a.x < .85 && a.y > .16 && a.y < .84);
});

test("new failures, successes, queueing and stalls map to distinct pulses", () => {
  const changes = [
    {id:"techrote/a#1",from:"queued",to:"in_progress"},
    {id:"techrote/a#2",from:"in_progress",to:"success"},
    {id:"techrote/a#3",from:"in_progress",to:"failure"},
    {id:"techrote/a#4",from:"in_progress",to:"cancelled"},
    {id:"techrote/a#5",from:"unknown",to:"queued"}
  ];
  const pulses = hungryTransitionPulses(changes);
  assert.deepEqual(pulses.map(p=>p.kind), ["ignite","release","scar","settle","queue"]);
  assert.deepEqual(hungryTransitionPulses([]), []);
  assert.ok(pulses.every(p=>p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1));
  assert.equal(hungryTransitionPulses(Array(100).fill(changes[0])).length,24);
  const ambient = hungryAmbientEvents(projectHungryCI(runs.filter(r=>r.state==="completed")), 0);
  assert.deepEqual(ambient, []); // old failures must not synthesize new transition events
});

test("initial history does not fake event pulses; only observed transitions do", () => {
  const first = observeTransitions(new Map(), runs, 1000);
  assert.equal(hungryTransitionPulses(first.changes).length,0);
  const modified = runs.map(r => ({...r}));
  modified[0].state = "completed";
  modified[0].conclusion = "success";
  const next = observeTransitions(first.next, modified, 2000);
  assert.equal(hungryTransitionPulses(next.changes).length,1);
  assert.equal(hungryTransitionPulses(next.changes)[0].kind, "release");
});

test("one can drive the artwork with many tracked runs but bounded anchor count", () => {
  const hundreds = Array.from({length:150}, (_,i)=>({...runs[i%4],runId:i+1}));
  assert.equal(projectHungryCI(hundreds).anchors.length,36);
  assert.equal(projectHungryCI(hundreds, 200).anchors.length,64);
});
