# Focus Grid and Focus Dual

Focus, Alerts and Dense now use the same native browser data-grid component when their layout is Rows or Table. **Focus Dual** uses two copies of the grid within one surface, with independent pane settings. GitHub polling and server-side ranking remain unchanged.

## Surface-only and browser popup

**Surface only** hides the header, navigation tabs, summary and diagnostics, leaving only the selected display surface. A discreet **Exit surface-only** button restores the full app.

**Popup** requests a browser window with no toolbar, location bar, menubar or status bar using window.open popup features. Browser preferences and operating-system decorations always take precedence: a web page cannot guarantee a truly borderless OS window.

Direct URL: http://127.0.0.1:8787/?surface=focus&minimal=1

Popup selection is local to that window: opening it does not change the active profile in the main browser window. Fullscreen remains a separate option.

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
`HIGH/18`).

The old Wrap checkbox is now a **Cell overflow** dropdown with:
1. Clip with ellipsis — truncate with a visible ellipsis glyph.
2. Clip without ellipsis (to border) — use the entire column width, with
   zero inline padding and no ellipsis glyph.
3. Wrap — wrap long values onto additional lines.

Existing saved `gridWrap` booleans migrate transparently. Focus, Dense,
Dual and Vert panes can choose independent modes. The horizontal scrollbar
is enabled only after the columns exceed the measured content width, so
it does not flash on every refresh when all columns fit.

The summary now begins with **active workers**, meaning the count of
distinct currently in-progress Actions jobs with fresh job detail. This
represents occupied runner slots, not running workflows. The count can be
smaller than the number of workflows or larger when workflows have multiple
parallel jobs. A `+` indicates a lower bound because one or more running
workflows are still missing recent job detail. This indicator uses existing
polling and does not add any API calls.

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
