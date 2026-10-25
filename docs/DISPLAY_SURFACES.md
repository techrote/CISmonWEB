# Display surfaces

A **surface** is a persisted presentation profile over the same normalized CISmon monitoring state. It does not create another GitHub poller, another history store, or another analysis pipeline.

Switching surfaces is therefore cheap and does not disturb monitoring.

## Built-in surfaces

### Focus

General-purpose desk view. Rows are ordered by CISmon attention priority and retain the broadest field set.

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

## Profile properties

Every surface stores the following independently.

### Layout and density

- layout: rows, cards, table, or lanes;
- density: comfortable, compact, or ultra;
- theme: dark, black, light, amber terminal, or green terminal;
- maximum visible items;
- browser refresh cadence;
- full-width canvas;
- kiosk/minimal chrome.

The browser refresh cadence only controls how often the browser asks the local server for already-normalized state. GitHub API polling remains governed by the monitor's adaptive scheduler.

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

The selected surface becomes the active persisted surface.

## Surface editor behavior

The editor operates on a draft copy of all surfaces. You can move between profiles without losing unsaved edits, then save the set in one operation.

Supported operations:

- create;
- duplicate;
- delete;
- reset to built-in defaults;
- edit all profile properties.

At least one surface must remain.

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
