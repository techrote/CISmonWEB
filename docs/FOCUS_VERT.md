# Focus Vert — vertically stacked Focus panes

**Focus Vert** is a new display surface that stacks **2–5 independent Focus
grids** top to bottom. The default is **2 panes**, each initially set to
43% of the viewport height. Panes are not additional GitHub pollers:
they all render the same existing local /api/state snapshot.

## Editing the surface

Open **Surface** → select **Focus Vert** (or change another surface's layout
to Focus Vert). The **Focus Vert · independent stacked pane settings** section
contains:

- **Number of stacked Focus panes:** 2, 3, 4, or 5.
- **Editing pane:** switch among Pane 1 through Pane N.
- **Pane height mode:** "Window height (%)" or "Fixed height (pixels)".
- **Height value:** 10–100% of viewport height (vh) or 120–1600 px.
- Per-pane name, maximum displayed runs, density, wrapping and sorting.
- Per-pane repository/workflow/event glob filters, minimum attention level,
  running/queued/success/failure/other visibility, watched-only, stalls-only.
- Per-pane independently ordered/visible Focus columns, with persisted widths
  and drag-to-reorder controls shared with the existing Focus and Focus Dual.

Changing the pane count retains the settings of existing panes in their current
order. New panes receive sensible Focus defaults; reducing the count discards
the removed panes' saved configurations when the editor is saved. Changes are
persisted only when **Save surfaces** is selected.

## Height and scrolling behaviour

Each pane has its own fixed visual height, while its grid content scrolls
vertically/horizontally **within that pane**. The outer page can scroll if
all pane heights and chrome exceed the viewport.

- A pane configured for 320px stays 320 pixels high regardless of browser
  height, even in Surface-only/popup mode.
- A pane configured for 35vh occupies 35% of the browser viewport height,
  adjusting as the window is resized.
- An independent pane header displays its height mode and matched run count.

The browser preserves each pane's horizontal and vertical scroll positions
between data refreshes. Header sorting, resize handles and field reordering
use the same source-backed Focus grid implementation as Focus Dual.

## Defaults and migration

The built-in profile ID is **focus-vert** and its layout ID is **focus_vert**.
An existing local configuration from Focus UX version 1 gains the new profile
once, without replacing customized Focus/Dual layouts or GitHub tokens. The
new version marker prevents a deleted Focus Vert profile from reappearing on
subsequent restarts.

Direct URL:

    http://127.0.0.1:8787/?surface=focus-vert

Surface-only mode:

    http://127.0.0.1:8787/?surface=focus-vert&minimal=1

No changes are made to the underlying GitHub API poll schedule, history
journal or run-state/attention classification.
