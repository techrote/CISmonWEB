# Focus popup, row heights and PR check progress

## Popup/minimal layout

The Popup button uses Firefox window.open popup features. Browsers may still
display a read-only address bar, titlebar and native controls. CISmonWEB
cannot override Firefox's permission to display them. For a genuinely
address-bar-free app window, use an installed web-app runtime such as
PWAsForFirefox or browser fullscreen/kiosk mode.

In minimal=1 mode the surface-only summary is centred in a footer immediately
beneath the surface. The footer also contains a subdued Exit surface-only
button to the right. Neither is positioned on top of the table. Nonminimal
surfaces retain their previous header and summary.

## Row alignment and fixed height

Focus, Dense, Focus Dual and Focus Vert horizontally and vertically centre
table values; headers are centred.

Open Surface -> Focus grid -> Fixed row height, or edit the individual
Dual/Vert pane's Fixed row height:

- 0: automatic height based on content
- 18–160: fixed pixel height
- A fixed row clips text that does not fit vertically, even with Wrap enabled
- Per-pane row height is independent of Focus Vert's outer px/vh pane height

## PR check progress

The optional CHECKS grid column reports GitHub commit check runs
for the pull request's actual head SHA, not steps inside one workflow.

It renders:

| Colour | Value |
| --- | --- |
| Green | Successful checks |
| Yellow | Total checks reported |
| Red | Failed, timed-out, action-required, startup-failed or stale checks |

Example 37/60/2 = 37 passed, 60 total, 2 failed. Hover for pending,
skipped/cancelled and partial-coverage details. A + on the total means
some check-run pages have not yet been acquired. Missing access and
unknown PR commit data show unavailable, not zero completed checks.

Source: GET /repos/{owner}/{repo}/commits/{ref}/check-runs with filter=latest.
Private repositories require a fine-grained token with Checks: read.

The monitor prioritises live summary and job polling over check-run
enrichment. It spends at most one check request per five normal scheduled
requests, refreshes active check snapshots every 90 seconds, reads up to
100 per page with up to 10 pages and backs off access failures for 15
minutes. GitHub API rate-limiting remains respected.

This is a best-effort check-run rollup, not a guarantee of matching every
GitHub PR Checks indicator: commit status contexts, forked refs and
synthetic merge refs can differ. Coverage is explicitly labelled.

## Configuration compatibility

Existing columns, widths, sorting, filters, ETA history and surface
profiles remain intact. CHECKS is available in the field list rather
than forcibly added to existing customized layouts. Row height defaults
to auto.
