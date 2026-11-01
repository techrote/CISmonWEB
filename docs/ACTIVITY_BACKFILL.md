# Workflow activity-based repository admission

**Default:** Activity-based backfill, with an Age of active window of 7 days.

Configure → GitHub access → Repository selection mechanism controls whether
CISmonWEB monitors every eligible repository or **only repositories with
recent GitHub Actions workflow activity**.

## Selection and re-admission

1. Discover up to the configured maximum repositories with GitHub's normal
   authenticated repository-list endpoint (respecting owner/include/exclude).
2. In activity mode, each candidate is probed with its recent GitHub Actions
   workflow runs (ten entries). A repository is admitted if a workflow was
   updated inside the age window, or if a queued/running workflow is still live.
   A repository's pushed_at field is **not** used.
3. Once admitted, the normal workflow summary polling, job detail and
   historical timing backfill operate as before.
4. If the latest activity ages outside the window and no live workflow
   remains, stop polling that repository. Its timing-history journal is
   preserved.
5. Inactive repositories are rechecked every 10 minutes using a bounded
   scheduler slot; activity can cause admission without restarting the app.
6. Changing the mode or age and saving Configure rebuilds admission from the
   new policy. The **Watched repositories** section lists currently admitted
   names separately from the discovered candidate catalogue.

This is intentionally a light activity probe of the first ten workflow runs
rather than an exhaustive history scan for each candidate. Extremely old
workflow reruns may be missed if they are not returned among those ten;
ordinary newly created/updated runs are detected. A transient API failure
neither proves inactivity nor removes an already watched repository.

## Rate budget and latency

Activity probes share the normal GitHub API client and its rate-limit handling.
They do not run in the browser. After startup, up to one activity probe is
scheduled per six normal requests when current activity needs service, while
idle scheduler slots are used when no live work is due. Initial discovery
can therefore take longer with many candidates; the UI explicitly reports
eligible, admitted and pending counts. Live workflow summary and job polling
remain higher priority than background probes.

This policy is **repo admission**, not manual per-run watching; the separate
manual Watch run flag retains its original meaning.

## Configuration

- repositorySelectionMode: activity (default) or all
- activeAgeDays: integer between 1 and 365, default 7
- maxRepositories: cap on eligible candidates, not a guarantee that all are
  actively monitored under activity selection

Older saved configurations lacking these settings migrate to the new default
without losing tokens, surface profiles or historic timing data. Switching to
All eligible repositories restores the previous admission behaviour.
