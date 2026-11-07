# Workflow state, matrix jobs and active runner counts

## Why these values differ

A GitHub Actions workflow is a *container of jobs*, not necessarily one
runner. A run marked `in_progress` can still have queued jobs and no
currently assigned runner. Conversely, GitHub can report a parent run as
`queued` while several matrix child jobs are actually executing.

CISmonWEB therefore exposes three independent observations:

| Metric | Source | Meaning |
| --- | --- | --- |
| GitHub workflow state | Actions workflow-run status endpoint | Authoritative `queued`, `in_progress` or `completed` parent state; never overridden by child jobs |
| Job activity | Workflow-run jobs endpoint (fresh ≤120 s) | Confirmed executing, waiting and completed matrix children |
| Active workers (assigned slots) | In-progress jobs with assigned `runner_id` or `runner_name` | Confirmed occupied runner slots, across all monitored repositories |

These counts **must not be compared as equal**. For example, a real-world
matrix may have one GitHub-queued parent with sixteen executing jobs assigned
to runners, seven queued jobs and 23 finished jobs.

## What changed in Focus

- The **STATE** column always shows GitHub's parent status, in its own text.
  Below it, a separate smaller line shows `16 JOBS EXECUTING`,
  `7 JOBS WAITING`, or `JOBS UNKNOWN`, with distinct styling.
- The optional **JOBS R/Q** column reports fresh executing/waiting job counts
  such as `16R/7Q`. Its `+` suffix means incomplete job-page coverage.
- The optional **SOURCE AGE** column reports how long since GitHub last
  confirmed the parent workflow status. The STATE cell marks stale provider
  data if that age exceeds two minutes. A cached job name is not presented
  as the current stage after its detail snapshot expires.
- The **WORKFLOW** column includes the GitHub run number (and rerun attempt
  when applicable), making otherwise identical workflow names distinguishable.
- The Focus summary now uses precise labels:
  `X active workers (assigned runner slots) · Y shown · Z GitHub in-progress
  · Q GitHub queued`. If some queued parents have running children, they are
  shown separately as `N queued with executing jobs`.
- The top LIVE counter is GitHub-reported `in_progress/queued`, not an
  inferred number of occupied workers; its tooltip explains that difference.

The UI never promotes `queued` to `in_progress` based on child-job status.
For *execution timing only*, a queued parent with an executing child can
still use the job's actual start timestamp, rather than counting queue age.
Run ETA, job-specific ETA and attention calculations remain separate.

## Truthfulness and refresh coverage

- Only job-detail snapshots acquired in the past 120 seconds are used to
  claim current job activity. Missing or stale details display `JOBS
  UNKNOWN`, not zero.
- Partially paginated matrices are explicitly marked incomplete.
- For **active workers**, a job must be both in-progress and assigned a
  runner. In-progress jobs without a confirmed assignment are counted as
  observed jobs, but **not** as occupied runner slots.
- The worker total has a `+` suffix whenever any relevant run lacks fresh
  complete detail or any executing job lacks confirmed runner assignment.
- The latest authoritative run-summary confirmation is tracked separately
  from job-detail timestamps. An ETag 304 refreshes confirmation only for
  runs that actually belonged to the last returned workflow page.

No additional GitHub requests or higher polling frequencies are introduced
by these presentation changes. Real-world freshness depends on the existing
scheduler, API availability and repository admission.

## Existing integration work

Open PR #18 separately addresses stale/omitted workflows, run-attempt
provenance and configuration/history robustness. This presentation repair
does **not** substitute for that still-unmerged code. When #18 is integrated,
retain the explicit provider/job/runner separation and reconcile its changes
to tracker and monitor files rather than silently restoring the old
state-promotion behavior.

## Validation

The new `test/workflow-presentation.test.js` asserts provider state,
matrix job distribution, confirmed runner assignment, incomplete coverage,
freshness and stable run identity, including a 46-job representative matrix
with sixteen assigned executing runners under a GitHub-queued parent.
Existing job activity and ETA tests now explicitly distinguish fresh
job detail from unavailable/stale observations.


## Evidence-first Focus presentation (2026-11-07)

Focus uses workflow-provider status, recently fetched job evidence and
source-confirmation age before historical timing diagnostics. New/default
Focus profiles include JOBS R/Q and SOURCE AGE; existing customized profiles
are preserved and can enable those fields manually.

The assigned-job summary is **not** an instantaneous occupancy counter.
In-progress, runner-assigned job IDs come from snapshots of different
repositories and times (up to 120 seconds old). Jobs can finish between polls;
the number may be higher or lower than actual concurrent occupancy now.
Coverage-incomplete is a separate label, not a mathematical lower bound
on real-time runner occupancy.

Focus Dual / Vert report pane appearances and unique run identities
separately. Workflow state and attention counts deduplicate by repository,
run ID and attempt; the same workflow shown in two panes is counted once.
Filter/truncation scope stays visible: these are *displayed* workflows, not
the complete monitored/GitHub-wide inventory.

Timing CONF ranks only historical sample sufficiency (LOW 1–4,
MEDIUM 5–15, HIGH 16+). HIGH does not mean calibrated prediction quality.
Once a running workflow passes its historical median and no positive run ETA
exists, the grid reports PAST MED rather than a silently blank ETA.
