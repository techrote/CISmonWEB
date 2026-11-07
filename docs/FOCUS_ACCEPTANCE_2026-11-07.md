# CISmonWEB Focus evidence-first candidate — independent acceptance

Candidate: branch `fix/focus-truth-visibility-20261107` (PR submitted separately).
Source: GitHub Actions workflows/jobs; the local monitor and browser require
the user's own read-only GitHub authentication. Never publish credentials.

## Automated acceptance

- Exact branch-head `npm test` and `npm run check` must both pass in
  GitHub-hosted CI. The regression suite covers missed/old workflow run
  reconciliation, attempt-bound job history, full and partial matrix job
  pages, runner assignment, provider source age, duplicated pane runs,
  first-normal/later-stalled matrix children, and stale browser responses.
- Confirm that main has not advanced before guarded integration.
- Keep original PR #18 and PR #17 as historical work; do not merge either
  on top of this combined candidate without source-authority reconciliation.

## Physical Firefox / Windows acceptance — outstanding

1. On a local Windows system with Firefox, start CISmonWEB from the candidate
   checkout (`npm start`), using a token with least-privilege read scopes.
   Confirm that GitHub activity and watched repositories load normally.
2. In **Focus**, apply **Use evidence-first columns**, save surfaces and
   reload. Confirm STATE, JOBS R/Q and SOURCE AGE are visibly distinct;
   previously configured filters, widths and other panes remain intact.
3. In Focus Dual and Focus Vert, deliberately display the same workflow in
   multiple panes. Confirm the summary reports appearances versus unique
   run count and does not double-count GitHub queued/in-progress/attention.
4. For a large Actions matrix, compare the exact run ID and attempt to
   GitHub's workflow-run and job endpoints. A GitHub-queued parent must
   remain QUEUED even if a child is executing; job activity may be partial
   or stale, but never fabricated. Check that a later stalled child can
   increase aggregate attention rather than the first child masking it.
5. Disable queued rows in a pane containing a queued parent with executing
   children; confirm the summary reports the hidden candidate without
   secretly promoting GitHub's queued parent into in-progress filtering.
6. At narrow Focus widths (down to 40px), confirm Wrap respects complete
   duration units (e.g. 22m + 16s, never 22m1 + 6s); check tooltip
   accessibility and no clipped status-label overlap.
7. Verify CONF's tooltip describes sample sufficiency, not forecast
   accuracy; when a workflow passes its learned median, ETA shows
   PAST MED rather than fabricating a remaining time.
8. Test Surface fullscreen and Escape restoration. Firefox may retain a
   browser address bar in a normal popup: no webpage code can promise a
   chrome-free independent browser window.
9. Compare top LIVE with GitHub parent workflows; compare assigned-job
   observations with GitHub jobs only within the displayed age/coverage
   scope. It is not a synchronized real-time concurrency meter.
10. On Windows, verify configuration save/backup, failed write recovery,
    history replay and process restart. No token should be leaked to
    the browser or into committed repo artifacts.

GitHub-hosted Node CI cannot prove actual Firefox window chrome, native
fullscreen behaviour or local Windows filesystem semantics. Do not
claim these gates have passed merely because JavaScript/VM tests are green.
