import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GRID_FIELDS, GRID_MIN_WIDTH, GRID_SHORT_LABEL, formatGridDuration,
  normalizeGridWidths, sortGridRows
} from "../shared/focus-grid.js";
import { normalizeSurface } from "../shared/surfaces.js";

const hours = 4 * 60 * 60 * 1000 + 33 * 60 * 1000;
const minutes = 6 * 60 * 1000 + 26 * 1000;

test("decimal auto units match the 4h33m and 6m26s examples", () => {
  assert.equal(formatGridDuration(hours, { durationMode: "decimal", durationDecimals: 1 }), "4.6h");
  assert.equal(formatGridDuration(hours, { durationMode: "decimal", durationDecimals: 2 }), "4.55h");
  assert.equal(formatGridDuration(minutes, { durationMode: "decimal", durationDecimals: 1 }), "6.4m");
  assert.equal(formatGridDuration(minutes, { durationMode: "decimal", durationDecimals: 2 }), "6.43m");
});

test("unitless hours always use h internally and never show a suffix", () => {
  assert.equal(formatGridDuration(hours, { durationMode: "unitless_hours", durationDecimals: 1 }), "4.6");
  assert.equal(formatGridDuration(hours, { durationMode: "unitless_hours", durationDecimals: 2 }), "4.55");
  assert.equal(formatGridDuration(minutes, { durationMode: "unitless_hours", durationDecimals: 1 }), "0.1");
  assert.equal(formatGridDuration(minutes, { durationMode: "unitless_hours", durationDecimals: 2 }), "0.11");
  assert.equal(formatGridDuration(0, { durationMode: "unitless_hours" }, true), "0.0");
});

test("fixed decimal units, invalid data and legacy compact mode", () => {
  const options = { durationMode: "decimal", durationUnit: "m", durationDecimals: 2 };
  assert.equal(formatGridDuration(hours, options), "273.00m");
  assert.equal(formatGridDuration(minutes, { ...options, durationUnit: "s" }), "386.00s");
  assert.equal(formatGridDuration(0, options), "—");
  assert.equal(formatGridDuration(-1, options), "—");
  assert.equal(formatGridDuration(NaN, options), "—");
  assert.equal(formatGridDuration(hours, { durationMode: "compact" }), null);
});

test("surface and panes persist independent duration preferences, with legacy defaults", () => {
  const surface = normalizeSurface({
    id: "focus-custom", layout: "focus_dual",
    durationMode: "decimal", durationUnit: "h", durationDecimals: 2,
    dualPanes: [{ durationMode: "unitless_hours", durationDecimals: 1 }, {}]
  });
  assert.equal(surface.durationMode, "decimal");
  assert.equal(surface.durationUnit, "h");
  assert.equal(surface.durationDecimals, 2);
  assert.equal(surface.dualPanes[0].durationMode, "unitless_hours");
  assert.equal(surface.dualPanes[1].durationMode, "decimal");
  assert.equal(surface.dualPanes[1].durationUnit, "h");
  assert.equal(surface.dualPanes[1].durationDecimals, 2);
  const legacy = normalizeSurface({ id: "older", durationMode: "bad", durationUnit: "bad", durationDecimals: 9 });
  assert.equal(legacy.durationMode, "compact");
  assert.equal(legacy.durationUnit, "auto");
  assert.equal(legacy.durationDecimals, 1);
});

test("five-character column labels and reduced minimum width do not alter raw sorting", () => {
  assert.equal(GRID_MIN_WIDTH, 36);
  assert.deepEqual(normalizeGridWidths({ workflow: 1, elapsed: 42, missing: 36 }),
    { workflow: 36, elapsed: 42 });
  for (const [field] of GRID_FIELDS) {
    assert.ok(GRID_SHORT_LABEL[field], "No short label for " + field);
    assert.ok(GRID_SHORT_LABEL[field].length <= 5, "Label too long: " + field);
  }
  const rows = [{ runId: 1, elapsedMs: 2600000 }, { runId: 2, elapsedMs: 3000000 }];
  assert.deepEqual(sortGridRows(rows, "elapsed", "desc").map(r => r.runId), [2, 1]);
});

test("column labels and sort indicators are separate DOM nodes and editor controls exist", () => {
  const grid = readFileSync(new URL("../public/focus-grid.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(grid, /make\("span", "focus-sort-label", GRID_LABEL\[field\]\)/);
  assert.match(grid, /make\("span", "focus-sort-indicator"/);
  assert.match(grid, /measureText\(GRID_LABEL\[field\]\)/);
  assert.match(grid, /pointercancel/);
  assert.match(css, /\.focus-sort-indicator\s*\{[^}]*pointer-events: none/s);
  for (const prefix of ["surface", "dualPane"]) {
    for (const prop of ["DurationMode", "DurationUnit", "DurationDecimals"]) {
      assert.match(html, new RegExp('id="' + prefix + prop + '"'));
    }
  }
  assert.match(app, /durationMode: \$\("#surfaceDurationMode"\)\.value/);
  assert.match(app, /durationMode: \$\("#dualPaneDurationMode"\)\.value/);
});
