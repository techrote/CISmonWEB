# Focus Grid and Focus Dual

Focus, Alerts and Dense now use the same native browser data-grid component when their layout is Rows or Table. **Focus Dual** uses two copies of the grid within one surface, with independent pane settings. GitHub polling and server-side ranking remain unchanged.

## Surface-only and browser popup

**Surface only** hides the header, navigation tabs, summary and diagnostics, leaving only the selected display surface. A discreet **Exit surface-only** button restores the full app.

**Popup** opens a toolbar-minimal browser window. Modern Firefox can retain a read-only address bar even when the page requests `location=no`. No JavaScript sequence, including opening `about:blank` and then navigating, can force Firefox to hide it. The misleading experimental **JS popup (no address)** button was removed.

**Surface fullscreen** is an explicitly user-initiated alternative: it enters browser fullscreen (requesting hidden navigation UI) and activates surface-only mode. The address bar is hidden, but the view **fills the monitor**, rather than remaining a small popup. Press Esc (or **Exit surface-only**) to restore the main UI. Ordinary **Fullscreen** remains available separately. For a *resizable independent window without an address bar*, use a supported installed-app runtime rather than ordinary browser JavaScript.

Direct URL: http://127.0.0.1:8787/?surface=focus&minimal=1

Popup selection is local to that window: opening it does not change the active profile in the main browser window.

## Execution-only timing and advanced grid controls

Queue waiting and run execution are now separate. Queued workflows show WAIT
duration while execution ELAPSED stays zero. The execution clock starts when
processing begins; ETA relies only on execution-duration history. Previous
queue-contaminated run-level baselines are no longer used (run-exec-v2).

**Ctrl-click** a column title or divider to lock/unlock its width.
**Shift-click** a title to set a secondary sort among equal primary values.
CONF/QTY combines baseline confidence and successful sample count.
ADDED/UPDATED have independent local, UTC, relative and custom date formats.
These settings persist separately for Focus, Dense and each Dual/Vert pane.

See [EXECUTION_ETA_GRID.md](EXECUTION_ETA_GRID.md) for details.

## Overflow, column presentation and active workers

Column headings are centred; all table cell text is vertically centred.
Ctrl-click still locks widths but the lock indication is a **darker header**,
not an additional padlock character. Minimum width is 40px. Duration
strings and the combined CONF/QTY field are compact (e.g. `1h16m`,
`HIGH/18`). In **Wrap** mode, each time unit remains indivisible:
`22m16s` may wrap as `22m` / `16s`, never `22m1` / `6s`.
This applies to ELAPSED, MED, ETA and S-ETA even when the optional
underscore/dash/dot break preference is off. Very narrow cells clip rather
than splitting a unit; clipping modes are otherwise unchanged.

The old Wrap checkbox is now a **Cell overflow** dropdown with:
1. Clip with ellipsis — truncate with a visible ellipsis glyph.
2. Clip without ellipsis (to border) — use the entire column width, with
   zero inline padding and no ellipsis glyph.
3. Wrap — wrap long values onto additional lines.

Existing saved `gridWrap` booleans migrate transparently. Focus, Dense,
Dual and Vert panes can choose independent modes. The horizontal scrollbar
is enabled only after the columns exceed the measured content width, so
it does not flash on every refresh when all columns fit.

The summary begins with recently observed **assigned executing jobs** from
job-detail snapshots no older than 120 seconds, not an instantaneous runner
count. Incomplete job/runner coverage is labeled rather than represented as
an exact live lower bound. GitHub's parent workflow state remains authoritative
for STATE, LIVE and filters: a parent marked queued remains queued even when
executing matrix children are detected. The second STATE line and JOBS R/Q
show child activity without overriding the parent. Filters/row limits that
hide queued parents with freshly observed executing jobs are disclosed in the
summary.

The JOBS R/Q suffix indicates a partially scanned matrix. Individual
job-detail pages are bounded and rate-limited; missing/stale job data means
unknown, not zero. Worker and provider aggregates cover monitored/admitted
repositories, not GitHub account-wide runner capacity. Distinct pane
appearances may exceed unique displayed workflows: only the latter contribute
to GitHub state and attention counts.

## Field and column controls

The Surface editor includes the **Focus grid** area for drag-reordered column chips, field visibility, Wrap versus Clip, sorting and direction. On the displayed grid:

- Click a header to sort, click again to reverse the direction.
- Drag a column header to another header to reorder.
- Drag the right-edge header divider to resize, or focus it and press Left/Right for 15-pixel increments.
- The field set, order, widths, wrapping and sort settings persist with the local surface profile.
- Horizontal scroll is retained across browser updates; a column is not destroyed during an active resize.

| Column | Meaning |
|---|---|
| OWNER | GitHub repository owner, separately sortable |
| REPO | Repository name without the owner |
| WORKFLOW | Workflow display name |
| # | GitHub Actions run number |
| ATTN | Normal / interesting / suspicious / action required |
| STAGE | Current job or step |
| STATE | Queued, running or terminal conclusion |
| ELAPSED | Execution duration only; queued rows show WAIT age separately |
| MED | Successful-history median |
| RATIO | Elapsed/median |
| ETA | Estimated remaining duration when available |
| CONF | Confidence in learned timing baseline |
| QTY | Successful timing samples supporting the shown baseline |
| CONF/QTY | Combined confidence and successful sample count |
| ADDED | GitHub workflow-run creation timestamp |
| UPDATED | GitHub workflow-run last-update timestamp |
| BRANCH | Head branch |
| EVENT | GitHub Actions trigger |

QTY is not a percentage or a total across all repositories. It is the number of successful samples in the currently applied timing baseline, which may be run-level or current job/step-level.

## Focus Dual

Choose the **Focus Dual** tab (or change any surface's layout to Focus Dual). In the Surface editor, switch between **Left pane** and **Right pane** to independently configure names, repository/workflow/event glob filters, state and attention visibility, watched/stalled filters, max items, density, wrap policy, visible columns, column order/width and sorting.

The parent surface controls theme, browser data refresh and chrome. Both panes share a single normalized monitor response, so there is no extra GitHub polling or duplicate history acquisition. They scroll independently and stack on narrow viewports.

## Migration and compatibility

Existing Focus remains stored as Rows and is automatically rendered by the new grid component. Existing custom profile settings and credentials are preserved. Focus Dual is appended once for older configurations; deleting it and saving does not resurrect it on later restarts.

The only normalized data additions are the existing GitHub created/updated timestamps and the successful timing-baseline sample count. Source monitoring semantics and CI processing gates are unchanged.


## Evidence-first columns

New Focus surfaces default to GitHub parent STATE, JOBS R/Q, SOURCE AGE,
ATTN, STAGE, ELAPSED and UPDATED. MED, ETA, CONF and QTY remain optional
diagnostic fields. Existing customized surfaces are not automatically
overwritten. In **Surface profiles → Focus grid**, use **Use evidence-first
columns** to stage the recommended visible-column order for that surface;
Focus Dual and Focus Vert have a separate **Use evidence-first columns for
this pane** button. Both affect only the selected field order; save the
surface settings explicitly to persist the draft.

## Focus operational history (7 November 2026)

The default single-grid **Focus** surface now has **Focus: condense previous
failures** enabled. This affects the **display only** when using priority
sorting and ordinary (unfiltered) attention; it does not alter the monitor,
GitHub statuses, acknowledgement, polling, stored history or other surfaces.

- Live GitHub in-progress and queued workflows always take first priority,
  up to the configured maximum visible rows.
- Manually watched completed runs are retained ahead of other terminal runs.
- Remaining terminal failure entries are limited to at most **four distinct
  latest failing workflows** (or fewer when the row limit is very small).
  Workflow/branch/event/PR identities are kept separate. When a newer success
  exists in the same identity, an older failure is no longer selected for
  the operational display.
- Other slots are filled by the latest successful or other terminal outcome
  for each identity. The summary reports how many failed runs remain outside
  this Focus selection; **Alerts** and **Dense** retain their independent
  filters and can display older attempts by increasing their item limits.
- Disable the **Focus: condense previous failures** checkbox in Surface
  profiles to restore the original ordered run list. Manual-watches-only,
  stalls-only and non-normal attention views are never condensed.

The **PARENT STALE** marker is now reserved for live GitHub-queued or
in-progress workflows whose authoritative status confirmation exceeds the
freshness threshold. Completed workflow results retain SOURCE AGE but do not
carry a misleading live freshness warning merely because their historical
confirmation is more than two minutes old.
