# Display surfaces

A **surface** is a persisted presentation profile over the same normalized CISmon monitoring state. It does not create another GitHub poller, another history store, or another analysis pipeline.

Switching surfaces is therefore cheap and does not disturb monitoring.

## Built-in surfaces

### Focus

General-purpose desk view. Rows are ordered by CISmon attention priority and retain the broadest field set.

### Focus Dual

Two Focus grids in a single surface. Each pane independently controls repo/workflow/event filters, attention and state visibility, max rows, density, wrapping, field set/order, column widths and sort field/direction. Both share one local monitor response and do not increase GitHub API polling. See [FOCUS_GRID.md](FOCUS_GRID.md).

### Focus Vert

Stacks **two Focus grids by default**, configurable from two to five, with independently selected filters, columns, sorting, density, wrapping and viewport-relative or fixed-pixel pane heights. Every panel has its own scrollable grid and reads the existing /api/state response without further GitHub polling. See [FOCUS_VERT.md](FOCUS_VERT.md).

### Dense

Ultra-dense table intended for many simultaneous workflows or a large desktop monitor.

### Alerts

Filters out normal activity and recent successes, keeping interesting, suspicious, and action-required work.

### Wallboard

Card layout with minimal chrome, full-width canvas, and a deliberately small persistent surface-control affordance. Intended for fullscreen use on a secondary display.

### Repository lanes

Groups currently relevant work by repository into separate lanes.

### Stalls

Filters to runs that CISmon currently considers possible stalls and emphasizes elapsed/baseline information.

### Signal Retention

A dedicated procedural oscilloscope display. Every trace represents an actual surfaced workflow run; live/queued/completed status controls colour, amplitude and movement. The decorative carrier wave is not an actual CPU/CI signal.

### Afterimage Debt

Physical misregistration, image echoes and independently drawn cards. Only run-state transitions actually observed across successive local browser polls create a named afterimage. Newly loaded historical failures do not invent echoes. The event list is ephemeral and resets with the view.

### Repository Lanes+

Per-repository activity boards with true running/queued/failure counts. The softly animated point field is an aesthetic proximity encoding, explicitly **not** a dependency graph.

### Hungry Margins (037)

Uses the **directly imported user-supplied 037 / Hungry Margins** artwork, not the earlier 031 / Shear Crystallization piece or a simplified replacement renderer. Its original painting pipeline runs inside an isolated iframe with the user-supplied HTML source preserved separately.

A bounded virtual-brush adapter drives the original living resonance, chromatic slug, contamination and reactive margins from two autonomous idle paths and real CI state. The backdrop reads **all dashboard candidates**, independent of the surface's filtered displayed rows: running work animates the interior, queued work presses boundaries inward, stalls create unstable pulses, existing failures leave one-time faint marks, and newly **observed** failure/success transitions create local contamination or release. Human pointer input takes priority over autonomous movement.

Exact CI run states remain clickable HTML in a narrow right-hand rail. The **COHERENCE** percentage and queue pressure are explicitly labelled artistic encodings, not actual GitHub health or reliability metrics. No repository action is ever triggered by the artwork.

See [HUNGRY_MARGINS_CI.md](HUNGRY_MARGINS_CI.md) for direct-source integrity, motion model, controls, isolation boundary and tests.


## Profile properties

Every surface stores the following independently.

### Layout and density

- layout: rows, cards, table, lanes, signal, afterimage, lanes_plus, or hungry_margins;
- density: comfortable, compact, or ultra;
- theme: dark, black, light, amber terminal, or green terminal;
- maximum visible items;
- browser refresh cadence;
- full-width canvas;
- kiosk/minimal chrome;
- animation: off / subtle / normal / intense;
- pointer reactivity: 0–100;
- show/hide artwork controls for experimental layouts.

The browser refresh cadence only controls how often the browser asks the local server for already-normalized state. GitHub API polling remains governed by the monitor's adaptive scheduler.

Artistic surfaces use first-party Canvas 2D with no new runtime dependencies. They limit pixel ratio and frame cadence, stop drawing while hidden, and respect `prefers-reduced-motion`. Pause, Reseed and Collect PNG affect only the visual specimen. Collect exports the canvas artwork layer, not the HTML overlay or a run report.

## Ordering and grouping

Sort modes:

- CISmon attention priority;
- longest elapsed;
- repository/workflow;
- estimated finish soonest.

Grouping modes:

- none;
- repository;
- state/conclusion;
- attention level.

Lane layout uses state grouping when no explicit group is chosen.

## Filters

Filters are applied after the server has built its normalized dashboard model.

Available filters include:

- minimum attention: normal, interesting, suspicious, or action-required;
- repository globs;
- workflow-name globs;
- GitHub event globs;
- include/exclude in-progress work;
- include/exclude queued work;
- include/exclude recent successes;
- include/exclude failures;
- include/exclude other terminal states;
- manual-watches only;
- possible-stalls only.

These filters do not change which repositories CISmonWEB polls. Global repository admission remains under **Configure**.

## Field selection

Repository/workflow identity is always present. Each surface can independently choose any subset of:

- current stage;
- state/conclusion;
- elapsed runtime;
- learned median baseline;
- elapsed/baseline ratio;
- estimated remaining time;
- branch/event;
- timing confidence.

The detail dialog remains richer than any surface and shows P25/P75, MAD, EWMA, robust z-score and sample count in addition to jobs and steps.

## Chrome

A surface can independently show or hide:

- top telemetry;
- surface heading/summary;
- error banner;
- attention badges;
- manual-watch flags;
- possible-stall flags.

Kiosk/minimal chrome hides the normal navigation controls. A low-visibility **Surface** button remains in the lower-right corner so the profile is not a trap.

## Persistence and direct URLs

Surface definitions and the active surface are stored in the local CISmonWEB configuration.

Direct selection is supported with:

    /?surface=<surface-id>

For example:

    http://127.0.0.1:8787/?surface=dense
    http://127.0.0.1:8787/?surface=wallboard
    http://127.0.0.1:8787/?surface=stalls
    http://127.0.0.1:8787/?surface=hungry-margins

The selected surface becomes the active persisted surface.

## Surface editor behavior

The editor operates on a draft copy of all surfaces. You can move between profiles without losing unsaved edits, then save the set in one operation.

Supported operations:

- create;
- duplicate;
- delete;
- reset to built-in defaults;
- edit all profile properties.

At least one surface must remain. Up to 32 profiles can be persisted.

On upgrade from the six-surface release, CISmonWEB appends the four new creative defaults once without overwriting existing custom profiles. The migration version is saved with local configuration. Deleting a new surface after migration does not cause it to reappear on every restart.

## Separation from monitoring configuration

Display configuration is written through a separate local endpoint from GitHub/monitor configuration.

Changing a surface does **not**:

- reconnect GitHub;
- clear active runs;
- reset ETags;
- restart history backfill;
- erase timing history;
- change GitHub polling cadence.

This separation is intentional: surface changes are presentation policy, not provider policy.
