# Architecture

CISmonWEB is a behavioral port of the CISmon proof of concept rather than a visual clone of the ESP32 display.

Its main design rule is the same separation used by CISmon: provider transport, normalized state tracking, timing analysis, persistence, scheduling, and presentation should remain independently replaceable.

## Core model and analysis

src/core contains browser/Node-independent logic:

- model.js defines normalized run state, conclusion state, attention levels, and baseline keys;
- statistics.js implements median, P25/P75, MAD, EWMA, and robust z-score;
- analyzer.js applies the same sparse-baseline and anomaly thresholds as CISmon;
- tracker.js is working memory for active, manually watched, recently successful, and unacknowledged failed runs;
- dashboard.js ranks visible runs;
- poll-policy.js selects adaptive repository intervals;
- glob.js implements the same star/question-mark matching behavior used by firmware filtering.

The normalized data model means GitHub-specific JSON does not leak into dashboard policy.

## Current reliability corrections

The scheduler uses latest workflow `updated_at` timestamps to establish
repository activity age. First discovery of an old repository is not a
new activity event. This avoids exceeding steady-state request capacity when
monitoring dozens of repositories. Active repository summaries have priority
within a bounded burst, preserving occasional service for inactive repos.

Request bodies and HTTP connections have an explicit 12-second deadline.
Transient failures (including HTTP 502) are retried with backoff without
blocking the single scheduler or being misidentified as GitHub rate limits.
Failures are scoped to their actual endpoint; an unrelated successful request
does not clear the failed endpoint's warning, while successful recovery does.
Aged warnings auto-expire from the UI.

A 10-minute repository-catalog refresh preserves live state and ETags.
`/api/state` reports last successful summary ages separately from browser
render time so stale GitHub statuses are not shown as current.

Queue time is deliberately excluded from execution-time anomaly/stall
calculations; the queued workflow's wall-clock age is still displayed.

## GitHub transport and scheduling

src/github.js owns REST transport and normalization.

src/monitor.js owns scheduling. Each scheduler tick performs at most one GitHub operation, with this priority:

    active run detail
        > repository run summary
            > history backfill

The scheduler tracks GitHub rate-limit response headers and suspends requests until reset when appropriate.

Repository summary requests carry If-None-Match after an ETag has been observed.

## Persistence

src/config-store.js writes local configuration to the configured data directory.

src/history-store.js maintains an append-only JSONL timing journal. It stores run identity markers, timing keys, duration, success flag, and completion timestamp.

It does not store Actions logs or repository contents.

The in-memory history for each key is bounded by the configured history depth. On-disk compaction is deliberately left as a follow-up.

## Local HTTP boundary

src/server.js serves the static dashboard and a small local JSON API.

The browser can read sanitized configuration, write configuration, read dashboard state, read one run's detailed view, acknowledge a failure, toggle a manual watch, and request immediate polling.

The token is accepted by the configuration endpoint but never returned to the browser.

The server binds to 127.0.0.1 unless CISMON_HOST is explicitly changed.

## Presentation

public contains a dependency-free browser UI.

The main view intentionally remains an information radiator. Rows are ranked before presentation and emphasize attention state, repository/workflow identity, current job or step, elapsed runtime, learned median, elapsed/median ratio, remaining-time estimate, and explicit possible-stall state.

Run detail is a drill-down into normalized jobs/steps already fetched by the monitor.

## Behavioral parity with CISmon

| CISmon | CISmonWEB |
| --- | --- |
| RunTracker | src/core/tracker.js |
| RuntimeAnalyzer | src/core/analyzer.js |
| buildDashboard() | src/core/dashboard.js |
| PollPolicy | src/core/poll-policy.js |
| FileHistoryStore | src/history-store.js |
| GitHubActionsSource | src/github.js + src/monitor.js |
| CYD display/touch | local browser dashboard |
| LittleFS config | local user data directory |

Future providers should normalize into the same run/job/step structures so analysis and UI remain provider-neutral.
