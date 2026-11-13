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

Tracked live runs that disappear from the latest-100 summary window are
confirmed through their individual run endpoint in ordinary scheduler slots.
One such confirmation consumes one request; it does not add an unbounded sweep.
Only an authoritative successful response changes the parent state. Failed or
unavailable confirmations retain the last known state and age the existing
SYNC AGE/health signal instead of inventing a cancellation. A successful 304
for the recent-runs list cannot refresh evidence for an omitted run.

Provider configuration saves advance a generation after durable storage
succeeds. Every asynchronous GitHub read checks its generation before
publishing, preventing a late response for the previous token/filter from
repopulating new tracking state. Configuration operations are serialized;
display-only patches preserve omitted fields and do not restart discovery.
Rescan schedules work under the normal rate-limit pause rather than launching
parallel discovery requests.

Queue time is deliberately excluded from execution-time anomaly/stall
calculations; the queued workflow's wall-clock age is still displayed.

## GitHub transport and scheduling

src/github.js owns REST transport and normalization.

src/monitor.js owns scheduling. Live detail includes *queued* as well as
`in_progress` GitHub workflow runs, because a queued parent may already
contain running matrix jobs. Each ordinary scheduler tick performs at most one
GitHub request, interleaving run-job pages with due repository summaries and
historical backfill. Repository discovery and explicit fast sweeps retain their
existing separate bounded request policy.

Job lists are fetched at 100 per page, up to a bounded 20 pages per scan.
Job endpoints are pinned to the workflow run attempt, and old attempt responses
cannot replace a newer attempt. A new attempt resets acknowledgement and
execution evidence while preserving an explicit manual watch on the run.
Continuation pages are prioritised so jobs beyond page 1 become visible.
Each page's jobs are de-duplicated by job ID; an incomplete page set or failed
request remains an explicitly partial lower-bound observation. Completed
scans are revisited under the adaptive live/queued intervals. Raw provider
state is never overwritten: dashboard presentation derives an observed
execution state only from fresh running job evidence.

Historical backfill retains one page per observation. Failed fetches and failed
journal appends are requeued with bounded retry backoff. Partial job sets or
unsettled job states do not contribute a whole-workflow timing sample, although
valid completed job/step samples remain useful. A recorded partial observation
is not later upgraded automatically to a complete history sample.

Check-run enrichment follows tracked PR commit visibility. Live commits use
the existing 90-second cadence; after execution finishes, a final refresh is
scheduled and the interval becomes ten minutes. No relevant visible row means
no further requests for that cached target. A superseded commit cannot remain
permanently classified as active merely because it was once running.

The scheduler tracks rate-limit response headers and suspends requests until
reset when appropriate. Repository summary requests use ETags. Worker counts
refer to fresh, distinct in-progress jobs across the monitored live run set,
with partial coverage reported instead of claiming a falsely exact zero.

## Persistence

src/config-store.js writes local configuration to the configured data directory.

src/history-store.js maintains an append-only JSONL timing journal. New entries
store one completed run attempt's identity and all its timing samples in a
single JSON line. Each sample includes its timing key, duration, success flag,
and completion timestamp. The old separate sample/marker format is still read.

The write queue serializes duplicate callers and commits in-memory samples
only after a successful append. Invalid or interrupted JSON lines are skipped;
a missing final newline is repaired at the next append so a torn tail cannot
consume the next good record. A damaged new batch never produces orphaned
samples without its deduplication marker. This is application-level recovery,
not a promise of power-loss durability or coordination between two processes.

Run IDs are scoped by repository and attempt. Legacy markers identify attempt
1; new attempts use distinct identities. Whole-workflow samples require complete
job coverage; a partial historical matrix may contribute valid job/step samples
without shortening the workflow baseline.

It does not store Actions logs or repository contents.

The journal is streamed during load, and the in-memory samples for each key
are bounded by the configured history depth. Distinct keys and completion
markers are not globally bounded. On-disk compaction and cross-process locking
remain follow-ups; run one CISmonWEB process per data directory.

Before downgrading to an older CISmonWEB version, copy the data directory.
Older readers ignore the new grouped samples even though they understand the
completion marker. New readers continue to accept both formats; the audit
does not rewrite or discard existing timing history.

## Completion interactions

`shared/interactions.js` defines exact-attempt identities, safe GitHub links
and outcome categories. `public/context-menu.js` owns one delegated menu for
all run-oriented renderers. Presentation projects scoped pin order before row
selection, history condensation and primary/secondary grid sorting, without
changing attention or manual-watch state.

`src/interaction-store.js` persists pins, one-shot subscriptions, settings and
the bounded event ledger in a separate atomic file. Its serialized transactions
commit a completion event and subscription disarm together. Generation IDs
protect rearmed subscriptions from earlier asynchronous responses. Delivery
uses claim, durable begin and acknowledgement; consumed attempts are never
requeued. `public/notifications.js` handles the discoverable controls, Web Audio
player, coalesced server delivery and playback diagnostics.

`src/completion-provider.js` advances one request at a time inside the existing
monitor enrichment budget. It verifies run attempts, lazily resolves PR
associations, inventories PR checks/statuses/workflows and required contexts,
and confirms the current head before/after each bounded scan. Two stable complete
terminal scans settle a PR candidate. The existing check-summary display stays
separate from this stricter completion decision.

See [Completion alerts](COMPLETION_ALERTS.md) for exact semantics, bounds,
permission requirements and the crash/restart delivery tradeoff.

## Local HTTP boundary

src/server.js serves the static dashboard and a small local JSON API.

The browser can read sanitized configuration, write configuration, read dashboard state, read one run's detailed view, acknowledge a failure, toggle a manual watch, and request immediate polling.

The token is accepted by the configuration endpoint but never returned to the browser.

The server binds to 127.0.0.1 unless CISMON_HOST is explicitly changed.

## Presentation

public contains a dependency-free browser UI.

The main view intentionally remains an information radiator. Rows are ranked before presentation and emphasize attention state, repository/workflow identity, current job or step, elapsed runtime, learned median, elapsed/median ratio, remaining-time estimate, and explicit possible-stall state.

Run detail is a drill-down into normalized jobs/steps already fetched by the monitor.

Browser configuration reads and writes use one ordered queue. Local revision
counters keep unsaved grid changes intact through delayed or failed responses.
Run-detail responses and actions are bound to the current selection, so an
older response cannot reopen a closed dialog or replace a later selection.
These guards operate within one page; concurrent full surface-set edits from
separate browser windows still use last-writer-wins semantics.

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
