import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FOCUS_VERT_DEFAULT, FOCUS_VERT_MAX, FOCUS_VERT_MIN,
  normalizeVertCount, normalizeVertHeight, normalizeVertPanes } from "../shared/focus-grid.js";
import { DEFAULT_SURFACES, filterRows, normalizeSurface } from "../shared/surfaces.js";
import { ConfigStore } from "../src/config-store.js";

test("Focus Vert defaults to two panes and caps counts at five", () => {
  const preset = DEFAULT_SURFACES.find(item => item.id === "focus-vert");
  assert.ok(preset);
  assert.equal(preset.layout, "focus_vert");
  assert.equal(FOCUS_VERT_MIN, 2);
  assert.equal(FOCUS_VERT_MAX, 5);
  assert.equal(FOCUS_VERT_DEFAULT, 2);
  assert.equal(normalizeVertCount(undefined), 2);
  assert.equal(normalizeVertCount(0), 2);
  assert.equal(normalizeVertCount(1), 2);
  assert.equal(normalizeVertCount(3), 3);
  assert.equal(normalizeVertCount(20), 5);
  assert.equal(normalizeSurface(preset).vertPanes.length, 2);
  assert.equal(normalizeSurface(preset).vertCount, 2);
});

test("Fixed px and percentage-of-window-height mode are independently bounded", () => {
  assert.deepEqual(normalizeVertHeight({}, 0, 2), {heightUnit:"vh",heightValue:43});
  assert.deepEqual(normalizeVertHeight({heightUnit:"vh", heightValue:27},0,5),
    {heightUnit:"vh",heightValue:27});
  assert.deepEqual(normalizeVertHeight({heightUnit:"px", heightValue:320},0,2),
    {heightUnit:"px",heightValue:320});
  assert.deepEqual(normalizeVertHeight({heightUnit:"px", heightValue:20},0,2),
    {heightUnit:"px",heightValue:120});
  assert.deepEqual(normalizeVertHeight({heightUnit:"px", heightValue:5000},0,2),
    {heightUnit:"px",heightValue:1600});
  assert.deepEqual(normalizeVertHeight({heightUnit:"vh", heightValue:200},0,2),
    {heightUnit:"vh",heightValue:100});
  assert.deepEqual(normalizeVertHeight({heightUnit:"other", heightValue:0},0,5),
    {heightUnit:"vh",heightValue:17});
});

test("Five panes have independent fields, filters, wrapping, sort, width and heights", () => {
  const stored = normalizeSurface({
    id:"my-vert", layout:"focus_vert", vertCount:5,
    vertPanes:[
      {name:"Active", heightUnit:"vh", heightValue:28,
       repositoryPatterns:["techrote/*"],gridFields:["owner","workflow"],
       gridWidths:{owner:175},gridWrap:true,gridSortBy:"updated",gridSortDir:"asc"},
      {name:"Failure", heightUnit:"px", heightValue:240,
       minAttention:"action_required",gridFields:["repository","attention"],
       gridWrap:false,gridSortBy:"attention",gridSortDir:"desc"},
      {name:"Third",heightUnit:"vh",heightValue:15},
      {name:"Fourth",heightUnit:"px",heightValue:300},
      {name:"Fifth",heightUnit:"vh",heightValue:12}
    ]
  });
  assert.equal(stored.vertCount, 5);
  assert.equal(stored.vertPanes.length, 5);
  assert.equal(stored.vertPanes[0].heightValue, 28);
  assert.equal(stored.vertPanes[1].heightUnit, "px");
  assert.equal(stored.vertPanes[1].heightValue, 240);
  assert.equal(stored.vertPanes[2].heightValue, 15);
  assert.equal(stored.vertPanes[3].heightValue, 300);
  assert.equal(stored.vertPanes[4].heightValue, 12);
  assert.equal(stored.vertPanes[0].gridWidths.owner,175);
  assert.equal(stored.vertPanes[1].gridWidths.owner,undefined);
  assert.deepEqual(stored.vertPanes[0].gridFields,["owner","workflow"]);
  assert.deepEqual(stored.vertPanes[1].gridFields,["repository","attention"]);
  assert.equal(stored.vertPanes[0].gridWrap,true);
  assert.equal(stored.vertPanes[1].gridWrap,false);
  assert.equal(stored.vertPanes[0].gridSortDir,"asc");
  assert.equal(stored.vertPanes[1].minAttention,"action_required");
  const rows = [
    { repository:"techrote/a",workflow:"CI",event:"push",state:"queued",
      conclusion:"unknown",attention:"normal",manualWatch:false,possiblyStalled:false },
    { repository:"other/b",workflow:"Test",event:"push",state:"completed",
      conclusion:"failure",attention:"action_required",manualWatch:false,possiblyStalled:false }
  ];
  assert.equal(filterRows(rows,stored.vertPanes[0]).length,1);
  assert.equal(filterRows(rows,stored.vertPanes[1]).length,1);
});

test("Increasing pane count preserves existing pane settings, decreasing truncates", () => {
  const a = normalizeVertPanes([
    { name:"Mine", heightUnit:"px",heightValue:444,
      repositoryPatterns:["techrote/*"], gridFields:["owner","qty"] },
    { name:"Else",heightUnit:"vh",heightValue:35 }
  ],2);
  const extended = normalizeVertPanes(a,5);
  assert.equal(extended.length,5);
  assert.equal(extended[0].heightValue,444);
  assert.equal(extended[0].heightUnit,"px");
  assert.equal(extended[0].name,"Mine");
  assert.deepEqual(extended[0].repositoryPatterns,["techrote/*"]);
  assert.equal(extended[1].heightValue,35);
  assert.equal(extended[4].name,"Focus 5");
  assert.notEqual(extended[4],extended[3]);
  const reduced = normalizeVertPanes(extended,2);
  assert.equal(reduced.length,2);
  assert.equal(reduced[0].heightValue,444);
});

test("Old Focus/Dual settings migrate only once and deleting Vert stays deleted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),"cismonweb-vert-"));
  try {
    const configPath = path.join(dir,"config.json");
    const existing = {
      githubToken:"test-token", githubOwner:"techrote",
      activeSurfaceId:"focus",
      surfacePresetVersion:2, focusUxVersion:1,
      surfaces:[
        {id:"focus",name:"My Focus",layout:"rows",gridFields:["owner","qty"]},
        {id:"focus-dual",name:"My Dual",layout:"focus_dual",dualPanes:[
          {name:"Custom left",maxItems:11},{name:"Right",maxItems:22}
        ] }
      ]
    };
    await writeFile(configPath,JSON.stringify(existing));
    const first = new ConfigStore(dir);
    await first.load();
    assert.equal(first.current.focusUxVersion,2);
    assert.equal(first.current.githubToken,"test-token");
    assert.equal(first.current.githubOwner,"techrote");
    assert.equal(first.current.surfaces[0].name,"My Focus");
    assert.equal(first.current.surfaces[1].name,"My Dual");
    assert.equal(first.current.surfaces[1].dualPanes[0].name,"Custom left");
    assert.equal(first.current.surfaces.filter(x=>x.id==="focus-vert").length,1);
    await first.update({surfaces:first.current.surfaces});
    const persisted = JSON.parse(await readFile(configPath,"utf8"));
    assert.equal(persisted.focusUxVersion,2);
    const second = new ConfigStore(dir);
    await second.load();
    assert.equal(second.current.surfaces.filter(x=>x.id==="focus-vert").length,1);
    await second.update({surfaces: second.current.surfaces.filter(x=>x.id!=="focus-vert")});
    const third = new ConfigStore(dir);
    await third.load();
    assert.equal(third.current.surfaces.some(x=>x.id==="focus-vert"),false);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("Browser layout and editor expose all height controls without extra API transport", async () => {
  const html = await readFile(new URL("../public/index.html",import.meta.url),"utf8");
  const app = await readFile(new URL("../public/app.js",import.meta.url),"utf8");
  const css = await readFile(new URL("../public/styles.css",import.meta.url),"utf8");
  for (const id of ["vertPaneCount","vertPaneCountGroup","vertPaneHeightGroup",
    "vertPaneHeightUnit","vertPaneHeightValue","dualPaneSelect"]) {
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(html, /value="focus_vert"/);
  assert.match(app,/function renderFocusVert/);
  assert.match(app,/gridCallbacks\(surface, index, "vert"\)/);
  assert.match(app,/pane\.heightValue \+ pane\.heightUnit/);
  assert.match(css,/\.focus-vert-pane \.focus-grid-wrap/);
  assert.match(css,/height: auto/);
});
