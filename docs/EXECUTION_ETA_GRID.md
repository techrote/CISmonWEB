# Execution-time ETA and Focus grid sorting/formatting

## Explicit duration scopes

The Focus grid **ETA**, **MED**, **RATIO**, **CONF** and **QTY** always
come from the workflow-run baseline, the same scope as the Run Detail
summary. When a current job or step is running, its separate statistics
can still raise attention and identify stalls, but must not overwrite
the run baseline or its confidence/sample quantity.

The optional **S-ETA** column is explicitly the remaining estimate for
the currently running **step** (or job, if no running step is known).
It is not a prediction for the overall workflow's finishing time.
This distinction avoids mixing the elapsed run duration with the current
stage's historical duration and erroneously reporting a 10-minute total
ETA for a 79-minute workflow with 40 minutes already elapsed.

## Execution clock versus queue waiting

Queue age and execution duration are distinct measurements.

- **Queued:** waitingMs tracks time since GitHub created_at. elapsedMs is zero, ETA is unavailable, and queue age is never treated as runtime or a possible stall. Focus explicitly shows WAIT 4m in the ELAPSED column.
- **Queued to running:** a witnessed transition records the execution start at the first running observation, resetting ELAPSED to zero instead of carrying over queue age.
- **Actual jobs available:** the earliest real job started_at supersedes provisional workflow timestamps. Later jobs belong to the overall workflow execution span.
- **Already running at discovery:** GitHub run_started_at is used when distinct from created_at, until actual jobs arrive. If an execution start cannot be established, no fabricated execution duration is reported. A witnessed queue transition may lag the actual start by the poll interval.
- **Completed:** duration is earliest started job to last completed job, not created_at to updated_at.

### Historical baseline versioning

The run-level baseline key is now **run-exec-v2**. Older history may include queue wait, and is deliberately excluded from the execution-only ETA. New completed runs rebuild the run-level baseline over time. Existing job and step histories remain intact. Some run-level ETA/CONF/QTY cells may initially be blank until valid new samples accumulate.

## Focus grid controls

These options are saved independently for Focus, Dense, Focus Dual and Focus Vert panes.

### Column width locking

**Ctrl-click** a column title or its resize divider to lock/unlock its current width. A lock symbol appears on the header. While locked, pointer and keyboard resizing are disabled. Ctrl-click again to unlock. Other panes retain independent lock settings.

### Primary and secondary sorting

- Click a header for primary sort; click again to reverse.
- **Shift-click** another header for secondary sort; Shift-click again to reverse secondary direction. The secondary header shows a small ²↑ or ²↓ indicator.
- The secondary comparison applies only among equal primary-sort values. For example, primary STATE ascending and secondary ADDED descending displays newest runs first inside each state.
- The Surface editor also exposes secondary field/direction. None removes it.

### Combined confidence and quantity

CONF/QTY is an additional selectable column alongside the independent CONF and QTY columns. It displays values like HIGH / 18 or LOW / 3. The quantity is successful samples of the currently applied timing baseline.

### Added/updated date formatting

ADDED and UPDATED have independent per-surface and per-pane formatting:

| Preset | Example |
| --- | --- |
| Local short | Oct 31, 14:05 |
| Local date | Oct 31, 2026 |
| Local time | 14:05:07 |
| Local date with seconds | Oct 31, 2026, 14:05:07 |
| ISO local | 2026-10-31 14:05:07 |
| ISO UTC | 2026-10-31T14:05:07Z |
| Relative | 2m ago |
| Custom pattern | DD/MM/YYYY HH:mm:ss |

Custom patterns support the tokens YYYY MM DD HH mm ss and use the browser's local timezone; patterns are limited to 64 characters. Sorting always uses underlying epoch timestamps rather than formatted strings.

## Scope

The change preserves existing user configurations, GitHub polling frequency, status classification and all previous source history. It only changes the definition of run-level timing evidence used for ETA.
