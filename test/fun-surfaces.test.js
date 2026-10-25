import assert from "node:assert/strict";
import test from "node:test";
import { ConfigStore } from "../src/config-store.js";
import { DEFAULT_SURFACES, normalizeSurface } from "../shared/surfaces.js";
import {
  FUN_LAYOUTS, FUN_PRESET_VERSION, groupFunRepositories, hashRunId,
  illustrativeCoherence, isFunLayout, migrateFunPresets,
  observeTransitions, rowStatus, runIdentity, summarizeFunRows
} from "../shared/fun-core.js";

const samples = [
  { repository:"techrote/cybersand", runId:100, workflow:"Native CI", runNumber:8,
    state:"in_progress", conclusion:"unknown", attention:"normal" },
  { repository:"techrote/cybersand", runId:101, workflow:"GDExtension", runNumber:6,
    state:"queued", conclusion:"unknown", attention:"normal" },
  { repository:"techrote/CISmonWEB", runId:102, workflow:"CI", runNumber:3,
    state:"completed", conclusion:"failure", attention:"action_required" }
];

test("all artistic layouts round-trip through the real profile normalizer", () => {
  for (const layout of FUN_LAYOUTS) {
    assert.equal(isFunLayout(layout), true);
    const value = normalizeSurface({ id:layout, layout, motion:"intense", reactivity:130, showFunControls:false });
    assert.equal(value.layout, layout);
    assert.equal(value.motion, "intense");
    assert.equal(value.reactivity, 100);
    assert.equal(value.showFunControls, false);
  }
  assert.equal(isFunLayout("table"), false);
  assert.equal(normalizeSurface({ motion:"invalid", reactivity:-10 }).reactivity, 0);
  assert.equal(normalizeSurface({ motion:"invalid" }).motion, "normal");
});

test("existing custom surfaces migrate exactly once without overwrites or duplication", () => {
  const original = [{ ...DEFAULT_SURFACES[0], name:"My Focus", maxItems:31 }];
  const migrated = migrateFunPresets(original, DEFAULT_SURFACES, 0);
  assert.equal(migrated[0].name, "My Focus");
  assert.equal(migrated[0].maxItems, 31);
  assert.equal(migrated.length, 5);
  for (const preset of FUN_LAYOUTS) assert.equal(migrated.filter(s=>s.layout===preset).length, 1);
  const afterDelete = migrated.filter(s=>s.id!=="hungry-margins");
  assert.deepEqual(migrateFunPresets(afterDelete, DEFAULT_SURFACES, FUN_PRESET_VERSION), afterDelete);
  assert.deepEqual(migrateFunPresets(migrated, DEFAULT_SURFACES, 0), migrated);
  assert.equal(migrateFunPresets(undefined, DEFAULT_SURFACES, 0).length, DEFAULT_SURFACES.length);
  assert.equal(migrateFunPresets([], DEFAULT_SURFACES, 0).length, DEFAULT_SURFACES.length);
});

test("legacy config normalization retains token and display overrides", () => {
  const store = new ConfigStore("/tmp/cismonweb-pure-normalizer");
  const config = store.normalize({
    githubToken:"secret",
    surfaces:migrateFunPresets([{id:"focus",name:"Tuned",layout:"rows",maxItems:40}],DEFAULT_SURFACES,0),
    activeSurfaceId:"focus", surfacePresetVersion:FUN_PRESET_VERSION
  });
  assert.equal(config.githubToken,"secret");
  assert.equal(config.surfaces[0].name, "Tuned");
  assert.equal(config.surfaces[0].maxItems, 40);
  assert.equal(config.surfaces.some(s=>s.id==="hungry-margins"), true);
  assert.equal(store.publicConfig().hasGithubToken, false); // current store was not mutated
});

test("art readouts derive from real run statuses and never replace raw source states", () => {
  assert.deepEqual(summarizeFunRows(samples), {
    running:1, queued:1, success:0, failures:1, suspicious:0, interesting:0, other:0, total:3
  });
  assert.equal(rowStatus(samples[0]), "in_progress");
  assert.equal(rowStatus(samples[2]), "failure");
  assert.equal(groupFunRepositories(samples).length, 2);
  assert.equal(illustrativeCoherence([]), 100);
  assert.ok(illustrativeCoherence(samples) < 100);
  assert.ok(illustrativeCoherence(samples) >= 15);
  assert.equal(hashRunId("abc"), hashRunId("abc"));
  assert.notEqual(hashRunId("abc"), hashRunId("def"));
});

test("afterimage only records status transitions that actually occurred across polls", () => {
  const first = observeTransitions(new Map(), samples, 100);
  assert.equal(first.changes.length, 0);
  const same = observeTransitions(first.next, samples, 200);
  assert.equal(same.changes.length, 0);
  const changed = samples.map(row => ({...row}));
  changed[0].state = "completed";
  changed[0].conclusion = "success";
  const after = observeTransitions(same.next, changed, 300);
  assert.equal(after.changes.length, 1);
  assert.deepEqual(after.changes[0], {
    id:runIdentity(samples[0]), repository:"techrote/cybersand",
    workflow:"Native CI", from:"in_progress",to:"success",at:300
  });
});
