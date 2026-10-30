# CISmonWEB

CISmonWEB is a local web application port of techrote/CISmon, the ESP32/CYD desk-side CI monitor.

The port is based on CISmon commit 5c67fd1d3669cc704c384380d059d59566879e2f. It keeps the original project's purpose:

> What is running? What is taking too long? What just broke? Is there anything I need to care about?

It is not intended to reproduce GitHub's Actions UI. It is an attention-oriented working-memory display for long-running automation.

## What the web port preserves

- authenticated repository discovery with owner/include/exclude filtering;
- adaptive repository polling;
- GitHub ETag / If-None-Match support;
- active run → job → step detail polling ahead of lower-priority work;
- persistent timing history without storing CI logs;
- run/job/step timing baselines;
- median, quartile, MAD and EWMA statistics;
- NORMAL, INTERESTING, SUSPICIOUS, and ACTION REQUIRED states;
- approximate remaining-time estimates;
- possible-stall detection;
- persistent unacknowledged failures;
- manual run watches;
- completed-run history backfill.

The anomaly thresholds intentionally match the current CISmon portable core:

    >= 1.30x median or robust-z >= 2.5  -> INTERESTING
    >= 1.75x median or robust-z >= 4.0  -> SUSPICIOUS
    >= 3.00x median or robust-z >= 6.0  -> SUSPICIOUS + possible stall while active
    failed/timed-out/action-required     -> ACTION REQUIRED

## Display surfaces

CISmonWEB is not limited to one dashboard layout. Display surfaces are persisted profiles that can be switched from the surface bar without restarting repository discovery or resetting monitoring state.

Built-in profiles:

| Surface | Purpose |
| --- | --- |
| Focus | balanced attention-ranked desk view |
| Focus Dual | two independently configured, sortable, resizable Focus grids in one surface |
| Dense | maximum-information table view |
| Alerts | interesting/suspicious/action-required work only |
| Wallboard | kiosk-style card display for a larger screen |
| Repository lanes | per-repository grouped workflow lanes |
| Stalls | possible-stall-focused diagnostic surface |
| Signal Retention | oscilloscope-like data-driven waveform field |
| Afterimage Debt | ghosted cards plus transitions actually observed in this browser |
| Repository Lanes+ | animated per-repository operational boards |
| Hungry Margins | directly embedded original 037 artwork, autonomously animated and driven by actual CI state |

Each surface can independently configure layout, density, theme, refresh cadence, maximum items, sorting, grouping, minimum attention level, repository/workflow/event globs, run-state visibility, watched-only/stalls-only filters, visible fields, telemetry, error/summary chrome, full-width mode and kiosk/minimal chrome.

Layouts include rows, cards, dense table, lanes, Signal Retention, Afterimage Debt, Repository Lanes+ and Hungry Margins. Themes include dark, black, light, amber-terminal and green-terminal. Experimental surfaces also have independent motion intensity, pointer reactivity and artwork-control visibility.

A surface can be addressed directly with a URL such as:

    http://127.0.0.1:8787/?surface=wallboard
    http://127.0.0.1:8787/?surface=signal-retention
    http://127.0.0.1:8787/?surface=afterimage-debt
    http://127.0.0.1:8787/?surface=repository-lanes-plus
    http://127.0.0.1:8787/?surface=hungry-margins

Use the **Surface** button to edit, create, duplicate, delete or reset profiles. Fullscreen is available from the top toolbar.

See docs/DISPLAY_SURFACES.md for the complete model.

**Focus UI upgrade:** Focus/Dense/Rows can now show separately selectable OWNER, REPO, WORKFLOW, ATTN, ADDED, UPDATED, ETA, CONF and QTY (successful baseline sample count), with sortable headers, drag-resizable columns, field drag reordering and wrap/clip policy. Use **Surface only** to hide all app chrome, or **Popup** for a browser-controlled, toolbar-minimal window. See [docs/FOCUS_GRID.md](docs/FOCUS_GRID.md) for the controls and popup limitations.

### Original 037 artwork and autonomous CI visuals

Hungry Margins now runs the **actual uploaded 037 HTML/Canvas artwork** inside an isolated frame instead of the old simplified renderer. The original liquid/resonance, chromatic slug, contamination, broken seals and reactive hungry-margin effects remain intact. A separate CI bridge sends bounded virtual brush movements even while idle, and uses running/queued/stalled states plus actual observed transitions to drive distinctive activity.

This surface reflects **all current monitor candidates**, not only the items in its HTML run list. Queue pressure drives the margins, running work feeds an internal wandering organism, stalled runs trigger unstable pulses, existing failures leave faint one-time scars, observed failures produce stronger contamination, and observed successes relax a local area. Human input takes priority over the autonomous movement.

[Hungry Margins visual architecture](docs/HUNGRY_MARGINS_CI.md) documents exact source provenance, event semantics, input controls and the sandbox boundary. The artwork does not change GitHub Actions or CI polling.


## Web-specific architecture

CISmonWEB moves GitHub access out of the display client:

    Browser dashboard
           |
           | local /api/*
           v
    Node local server
           |
           +--> RunTracker / RuntimeAnalyzer / dashboard ranking
           |
           +--> local config + JSONL timing journal
           |
           +--> serialized adaptive polling
                        |
                        v
                 GitHub Actions API

The browser never receives the configured GitHub token. By default the Node server binds only to 127.0.0.1.

See docs/ARCHITECTURE.md and docs/SECURITY.md.

## Requirements

- Node.js 20 or newer.
- A fine-grained GitHub token with read-only access to the repositories you want to monitor.

There are no runtime npm dependencies.

## Run locally

    git clone https://github.com/techrote/CISmonWEB.git
    cd CISmonWEB
    npm start

Open http://127.0.0.1:8787 and select Configure. Enter a fine-grained read-only token, then optionally set an owner and include/exclude globs.

Alternatively, keep the token out of the configuration file:

    GITHUB_TOKEN=github_pat_... npm start

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| GITHUB_TOKEN | unset | Overrides the stored GitHub token |
| CISMON_OWNER | stored value | Overrides owner filtering |
| CISMON_DATA_DIR | ~/.cismonweb | Local config/history directory |
| CISMON_HOST | 127.0.0.1 | HTTP bind address |
| CISMON_PORT | 8787 | HTTP port |

## Local data

CISmonWEB writes config.json and history.jsonl under ~/.cismonweb by default.

config.json is written with user-only file permissions where the host filesystem supports them. history.jsonl contains timing metadata, not Actions log content.

A timing baseline is keyed by repository, workflow ID, event, and optional job/step names. Only successful observations contribute to expected-duration baselines, matching the firmware project.

## Repository discovery at scale

CISmonWEB monitors repository summaries independently from browser refreshes. With large repository sets, discovery uses a bounded fast sweep on startup and when **Rescan** is pressed.

The scheduler is fair rather than array-order based:

- never-scanned/most-overdue repositories are serviced first;
- simultaneously due active-run detail requests are ordered by due time;
- active-run detail can only consume a bounded burst before due repository discovery is serviced;
- startup/manual sweeps scan multiple repositories per batch;
- each repository summary request reads up to 100 recent workflow runs.

The top telemetry exposes **SCANNED** and **TRACKED** counts. While a sweep is incomplete, CISmonWEB shows a sweep banner because queued/running work can still be missing until its repository has been checked.

This is distinct from the browser surface refresh cadence: a 1-second surface does not cause GitHub to be polled every second.

## Synchronisation reliability and diagnostics

The browser refreshes its local dashboard independently of GitHub API calls.
**UI time is not proof of fresh GitHub data.** The top telemetry includes
**SYNC AGE**, the age of the oldest recently confirmed active/queued repository
(or the oldest repository when no live workflows are known).
The sync indicator shows ONLINE / SCANNING / DEGRADED / STALE / PAUSED.

If GitHub reports a transient HTTP 502 or a request stalls, the client now has
a 12-second end-to-end request deadline. Active job-detail failures use
bounded exponential retry, and their warnings clear when the same endpoint
recovers (or disappear from the banner after 90 seconds). Repository workflow
summaries continue independently of job detail failures. A transient GitHub
502 is **not** mistaken for rate-limit exhaustion.

Repositories with old workflow activity now correctly retain their real
GitHub activity timestamp: merely discovering a repo for the first time
does not make it "recently active". This prevents all ~83 repositories being
forced onto a 60-second poll interval, which previously overloaded the
one-request-per-second steady-state scheduler. Active repository summary
requests receive preferential slots, with fair background service.

The repository catalog is also refreshed every 10 minutes, preserving
existing ETags, state and poll clocks and admitting newly discovered repos
without resetting the monitor. A failed catalog refresh keeps existing
monitoring alive.

Queued-run age is displayed as waiting time, **never** compared to a completed
workflow's execution-duration baseline; queued items cannot be tagged as
runtime stalls until they actually start.

The dashboard uses different banners for transient API errors, stale live
status and rate-limit backoff. The `/api/state` JSON endpoint exposes
`syncStatus`, `oldestLiveSummaryAgeMs`, `oldestRepoSummaryAgeMs`,
`lastSuccessfulSummaryAtMs`, `rateLimitedUntil` and recent request errors.
A full repository sweep is complete only after a successful response from
each repository; attempted-but-failed requests do not count as scanned.

## Polling behavior

The default policy mirrors CISmon:

| Repository state | Poll interval |
| --- | ---: |
| Active workflow | 15 s |
| Queued workflow | 20 s |
| Recently active | 60 s |
| Idle | 120 s |
| Cold | 300 s |
| Errors | exponential backoff, capped at 10 min |

Request priority remains:

    active run job detail
        > due repository workflow list
            > completed-run history backfill

The local server spaces GitHub requests rather than issuing a continuous burst.

## Test

    npm test
    npm run check

The test suite checks statistical parity, attention thresholds, tracker behavior, poll policy, glob semantics, GitHub normalization, persistent timing-journal reload, surface migration, observed-only afterimage events and local animation asset routing.

## Current limitations

- GitHub Actions is the only provider.
- Repository discovery considers the first 100 repositories returned by /user/repos, then applies filters and the configured cap.
- Workflow polling currently reads up to 100 recent runs per repository.
- Job detail reads the first 100 jobs of the latest attempt.
- The timing journal is append-only; bounded in-memory retention is implemented, but on-disk compaction is not yet.
- Configuration has no authentication because the server is intended to bind to loopback. Do not expose it to an untrusted network without adding an authentication boundary.
- This is a local monitor, not a webhook receiver; fresh state is bounded by its adaptive poll interval.
