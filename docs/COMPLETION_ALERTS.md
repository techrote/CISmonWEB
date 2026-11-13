# Run context menu, scoped pins and completion alerts

This feature implements issue [#21](https://github.com/techrote/CISmonWEB/issues/21).
It adds local presentation and notifications; GitHub remains read-only.

## Everyday use

Right-click any selectable run or focus it and press Shift+F10 / Context Menu.
Copy CI link and Copy PR link occupy the first two compact rows. There is no
heading or divider above them. A missing, ambiguous or inaccessible PR
association is explained on the disabled PR actions. Opening the menu requests
association verification lazily; an API read is queued under normal rate limits,
so the link may take a little time to become available. The first supplied PR
number is never treated as sufficient proof of a unique association.

Next come the one-shot run and PR-check alert toggles, then pin, watch,
acknowledge failure, GitHub/PR/commit navigation, copy SHA and workflow history.
The history action is a temporary view of tracked runs of that workflow. Its
clear button restores the prior view; it does not change monitored repositories
or overwrite surface filters.

Arrow keys/Home/End navigate menu items, Enter activates, Escape restores focus
to the row and Tab resumes ordinary page navigation. Outside clicks and surface
changes dismiss the menu. A refresh reconciles the originating exact run
attempt; removing it dismisses the menu. Firefox Shift+right-click retains the
native browser context menu, and inputs/column controls retain their normal
behavior. Clipboard success/failure is reported by a small status message.
GitHub navigation uses `noopener,noreferrer`; copied run links include the
selected attempt rather than drifting to a later rerun.

## Pins, watches and filtering

Pin identity is surface ID + pane slot + repository + run ID + attempt.
Ordinary surfaces use `main`; Focus Dual uses `dual:0`/`dual:1`; Focus Vert
uses `vert:0` through `vert:4`. Pane names, width changes and temporarily hiding
a Vert pane do not move its pins. Changing between Dual and Vert preserves
each layout's own slots. Removing a surface does not silently erase pins;
**Manage pins** can inspect and remove them.

Within a scope, pins keep insertion order ahead of both sort layers and before
maximum-row selection or Focus history condensation. Repository, workflow,
event, status, attention, watched-only and other explicit filters still apply.
A pin cannot turn an unwatched run into a watched run. A notice explains pins
hidden by filters or awaiting provider confirmation. Pins that exceed the row
cap remain stored and are available through management.

The durable store supports 64 pins per pane and 256 total. It rejects additional
pins explicitly instead of evicting an existing one. A pin retains its compact
provider snapshot beyond the ordinary completed-run TTL. After restart it is
labelled as restoring until bounded polling verifies the exact attempt. A 403,
404 or failed lookup is labelled unavailable; absence never means success or
cancellation. Old attempts remain separately addressable when the current run
has been rerun. Their detail view identifies the attempt and disables actions
which would otherwise affect the current tracked attempt.

Manual watches, failure acknowledgements and the existing Alerts surface keep
their previous meanings. Watches and acknowledgements retain their existing
session lifetime. Pinning neither creates nor erases them.

## Run completion semantics

A run subscription identifies repository, run ID and attempt. An already
terminal or unknown run cannot be armed from the menu. The server independently
verifies current provider evidence; browser row transitions never create events.
A fresh observation of queued/in-progress work establishes an active baseline.
The exact-attempt API and, for a terminal attempt, its paginated jobs supply
confirmation. A real job `completed_at` after arming can establish a very fast
completion before the first active verification arrives. A later run
`updated_at` alone does not prove that old completed work became new work.

A stale active row which is already terminal when verified is recorded as
already-complete and produces no retrospective sound. Contradictory or
temporally ambiguous evidence remains explicit. A rerun cannot fulfill an
earlier attempt's subscription. Cancellation and rearming use a generation
identity so an in-flight response or stale browser cancellation cannot change
the replacement subscription.

| Verified outcome | Event | Sound when enabled |
| --- | --- | --- |
| Success | success | Soft ascending consonant chords |
| Failure, timeout, action required, startup failure, stale | failure | Soft descending dissonant chords |
| Cancelled | cancelled | Failure chime, explicitly labelled cancelled |
| Skipped or neutral | neutral | Silent; never represented as success |
| Unclassified terminal conclusion | indeterminate | Silent; never represented as success |

Subscriptions continue independently of selected surfaces, visible row limits,
manual watches and repository activity admission. Restart preserves active
subscriptions and their verified baseline. Provider credential/filter changes
discard in-flight provider generations and rebuild verification without mixing
old credentials' responses into the new state.

## PR-check completion semantics

One subscription belongs to a repository and PR number, even when several rows
represent that PR. It follows new pushes until it fires or is cancelled.
Merge/closure alone does not fulfill it. Closed PRs can still have unfinished
checks, which continue to be evaluated as checks.

Verification reads the PR before and after the inventory scan and includes the
current head plus an applicable test-merge SHA. It inventories check suites,
individual check runs, combined commit-status contexts and workflow runs with
bounded pagination. Branch protection and active rulesets supply expected CI
contexts; a required context missing from the observed set prevents completion.
App identity is respected where a requirement specifies it. State from different
head SHAs, attempts or incomplete/changing pages is never combined into a pass.

A terminal result needs two identical, complete inventories separated by at
least 30 seconds, with the same PR head, applicable merge SHA and required
contexts. A new head, check set, pending context or provider error resets the
candidate. An empty set is unknown, not success. Pending/queued suites prevent
their not-yet-created child checks from being mistaken for an empty successful
set. The user can inspect the subscription's reason and cancel it at any time.

This is a conservative polling assessment of GitHub evidence, not a promise
that no integration could ever create more work later. In particular:

- Missing Checks, Commit statuses, Pull requests, Contents or Metadata read
  access leaves the relevant verification incomplete and explains the failure.
- Inventories beyond the bounded page coverage, inconsistent totals, missing
  child checks or unclassified conclusions remain pending/indeterminate.
- Some installed applications leave a check suite queued with no child checks
  indefinitely. Such a suite is named in the pending reason. The monitor does
  not silently assume the application will never run.
- Conditional or dynamically created checks can delay completion. Known
  required contexts must exist, and the two-scan settling interval catches
  ordinary delayed creation. No poll-based client can prove the absence of
  arbitrarily late future work.
- A new push immediately before verification completes invalidates old-head
  evidence. A push after an event has already been durably observed starts new
  work; the one-shot subscription has finished and can be armed again.

Normal live monitoring remains ahead of this additional enrichment. Requests
share the existing global spacing, rate-limit/backoff gate and low-priority
quota with ordinary check summaries. Multi-page scans consume one request per
scheduler slot. ETags and bounded caches are reused. Browser refreshes and
multiple panes do not multiply GitHub requests; the same PR has one subscription.
High request pressure can delay verification, and stale scans are restarted
rather than reported as current.

## Sound and multi-window delivery

Sound starts disabled, at a conservative stored volume of 25%. The Notifications
bell is visible in the full dashboard and minimal/popup footer. It shows the
armed count and opens enable, mute, volume, preview and history controls. Arming
or pressing Enable audio/Preview can resume Web Audio inside the trusted user
gesture. If Firefox keeps audio suspended, the UI provides an explicit blocked
status and asks for the window's enable gesture/site autoplay setting.

Both sounds are synthesized locally from two overlapping three-note sine
chords with soft attack/release, about 0.85 seconds in total. No audio assets,
runtime dependencies or desktop-notification permissions are used. Preview
playback and completion playback share a player, avoiding overlapping previews
and event sounds in one window.

The delivery protocol is deliberately explicit:

1. The server commits the one-shot subscription transition and stable event ID
   together in the same atomic write.
2. After a short 1.2-second coalescing interval, one audio-ready window can claim
   up to 50 recent pending records. Failure/cancellation takes precedence if a
   batch contains mixed outcomes. Every underlying record remains in history.
3. A claim has a 10-second lease. If the window disappears before beginning,
   another window can recover the unstarted claim.
4. Before synthesizing sound, the owner calls **begin**. The server durably
   consumes the attempt. Repeated begin calls fail; a lost response suppresses
   playback rather than risking duplicate sound.
5. The browser acknowledges played, blocked or failed. Played means it observed
   a running AudioContext through the sound envelope; it cannot verify speakers,
   system mute, physical audibility or whether the user heard it.

An attempted event never returns to the playback queue, even after a missing
acknowledgement or server restart. This avoids duplicate chimes at the cost of
a possible missed sound after a crash between durable begin and playback.
The history retains that uncertainty as attempted. Closed/suspended/blocked
browsers leave accurate completion records. Unclaimed audible events older
than two minutes expire so reopening the app cannot produce a backlog of old
chimes. Events observed while sound is disabled/muted are silent and do not
replay when sound is enabled later.

## Storage, permissions and compatibility

`interactions.json` is version 1 of an isolated atomic store, beside the existing
config and timing journal. Missing file means empty pins/subscriptions/history
and sound off. Saves serialize changes, flush a unique temporary file and rename
it before publishing memory state. Failed saves leave accepted state intact.
Recovery advances the revision so already-open clients notice restored statuses.
Unsupported/corrupt data fails visibly while preserving the file.

The bounds are 128 armed subscriptions, 200 retained completion events and 200
finished subscription records, with a 30-day history horizon. Active
subscriptions and pins are not silently evicted by history retention. Run one
local server per data directory; independent server processes are not coordinated.
Existing `config.json`, surface IDs/migrations and `history.jsonl` remain intact.

For private repositories, provide only the relevant read permissions:

| GitHub data | Read permission |
| --- | --- |
| Workflow runs and exact-attempt jobs | Actions |
| PR identity and commit association | Pull requests |
| Check suites and check runs | Checks |
| Commit-status contexts | Commit statuses |
| Base-branch required contexts | Contents |
| Applicable active branch rules | Metadata |

No Actions write, administration write or notification permission is requested.
GitHub credentials stay in the server. The local API retains Host/Origin/Fetch
Metadata checks, JSON-only bounded writes and CSP; run/scope identities are
validated before provider paths are constructed. Delivery claim ownership is
server-controlled, and claim credentials are omitted from general state responses.

## Owner evaluation and repeatable tests

Run `npm run check` and `npm test`. Browser tools are development-only:

```powershell
npm.cmd install --no-save --package-lock=false playwright@1.56.1
npx.cmd playwright install firefox chromium
node tooling/focus-firefox-acceptance.mjs
node tooling/context-menu-acceptance.mjs
$env:CISMON_BROWSER = "chromium"
node tooling/context-menu-acceptance.mjs
Remove-Item Env:CISMON_BROWSER
```

The new suite starts the real local server and substitutes only the external
GitHub transport with deterministic provider responses. Dashboard API reads,
mutations, storage, scheduling and claim/begin/ack endpoints run production code.
Audio synthesis is rendered by native OfflineAudioContext behind an explicitly
labelled output-device fixture. That verifies the actual oscillator/envelope
code and multi-window delivery, without claiming physical audio or autoplay
acceptance. Native autoplay/blocked-audio diagnostics are checked separately.

For the final Windows 11 / Firefox owner pass, start the normal app with your
read-only token and use two browser windows, one optionally a Focus popup:

1. Right-click near the bottom/right edge of Focus and in each Dual/Vert pane.
   Copy both links, verify clipboard destinations, then test Shift+F10, arrows,
   Enter, Escape, outside dismissal and Firefox Shift+right-click.
2. Pin a run in one pane, sort both ways, reduce its row cap and change its
   filters. Verify the other pane is unaffected, the filter notice is accurate
   and Watch remains independent. Restart the local server and verify recovery.
3. Enable sound at low volume, try both previews and confirm they are comfortable
   and clearly distinguishable. Test mute and the blocked-audio recovery hint.
4. Arm an active run and its verified PR. Leave another workflow or external
   status pending: the PR must stay pending. Let all work finish and inspect the
   distinct event outcomes and playback acknowledgement. A run+PR burst should
   produce one coalesced sound, not one per open window.
5. Arm another run, cancel it, then test a rerun/new PR head. The old attempt/head
   must not fulfill the new subscription. Refresh/reopen and confirm no sound
   replays. Inspect any indeterminate/invalidated reason in Notifications.
6. Check ordinary row activation, Run Detail, watch/acknowledgement, Alerts,
   column resizing/reordering/sorting, independent pane scrolling and fullscreen.

Automated browser rendering, Web Audio signal checks and Windows CI cannot
replace the last physical speaker/autoplay acceptance on the owner's machine.
