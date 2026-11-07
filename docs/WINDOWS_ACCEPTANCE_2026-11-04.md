# PR #18 Windows qualification — 4 November 2026

## Source and disposition

Examined main `ccdf883fbdf9f45567acef7a0d73f5982745addb`, PR #17
`b32db852a06f8d0e50add761d78a2dde1b5f9307`, and PR #18
`c4b626e705538d29aa0fdc514d3dc71c308f99fe`. Both earlier commits are
ancestors of #18. Remote refs were rechecked before this follow-up.
The dedicated detached worktree contains only acceptance follow-up changes.
No AGENTS.md exists in the checked-out tree or workspace ancestors inspected.
The audit authority remains [AUDIT_2026-11-04.md](AUDIT_2026-11-04.md).

Keep #18 draft. Do not merge: native Firefox acceptance remains incomplete.
Main and #17 are unchanged; #17 must only be closed as superseded after #18
is safely integrated. HIST-PAGE-001 implementation and issue creation remain
deferred until integration, as requested.

## Discovered defects and repairs

1. Windows locks a running child process's working directory. The missing-art
   HTTP test registered removal before child shutdown, producing EBUSY and
   leaving the suite running. Register removal after server cleanup. The same
   HTTP assertions now complete; no application behavior changes.
2. With core.autocrlf=true, browser sources are checked out with CRLF. The VM
   harness's LF-only import removal left imports inside vm.Script and failed
   eleven UI tests. Normalize the harness input to LF; preserve all assertions.
3. Independent source review reproduced a delayed ACK crossing a rerun: an
   attempt-1 dialog could acknowledge attempt 2 after tracker reset and hide
   its later failure. ACK now carries the displayed runAttempt, validates a
   positive integer at HTTP entry, and rejects mismatches with HTTP 409 before
   mutation. The dialog stays open and displays the error. Legacy callers
   omitting runAttempt can acknowledge attempt 1 only. Watch remains run-level.
   New tracker and browser tests failed before repair and pass afterward;
   a real HTTP test also qualifies invalid-attempt and missing-run responses.

## Windows non-graphical results

- Node 24.20.0: npm test — 169 passed, zero failed/cancelled/skipped.
- Node 22.23.4: node --test — 169 passed, zero failed/cancelled/skipped.
  The official Windows x64 Node archive was verified against its SHA256 manifest
  and extracted inside the task workspace, without replacing installed Node.
- npm run check / Node 22 syntax command: all 28 runtime JavaScript files pass.
- git diff --check: passes.
- Actual Windows temporary-file tests qualify ordered concurrent config saves,
  replacement failure rollback and queue recovery, runtime-token isolation,
  configuration reload, journal restart/legacy reading and torn-tail recovery.
  Actual local HTTP subprocess tests qualify Host/Origin/media/UTF-8/body limits
  and survival of missing assets. Original user data/configuration was not read.
- VM/DOM tests qualify selection, Watch/ACK and configuration response ordering.
  These are not graphical browser acceptance.
- Independent bounded review covered scheduler fairness, omitted-run freshness,
  attempt transitions, persistence, credential handling, HTTP boundaries and UI
  races; its one material ACK finding is repaired and independently re-reviewed.
- Small test-hygiene limit: package setup failure before its late removal hook
  can leave a disposable temporary directory; normal cleanup is qualified.

The original exact-head Node 22 CI runs were reconfirmed successful:
[pull_request](https://github.com/techrote/CISmonWEB/actions/runs/41755591293)
and [push](https://github.com/techrote/CISmonWEB/actions/runs/41755587882).
They apply to c4b626e, not to this follow-up. New-head CI must pass before any
later integration; pushing these source changes justifies its normal CI runs.
No external workflows were changed, cancelled or manually rerun.

## Bounded live observations

2026-11-04 09:28:37–09:28:38 UTC: six unauthenticated, read-only public GitHub
API requests, with remaining request allowance decreasing from 59 to 54.
No environment token, private monitoring configuration or original data was used.

- Latest 100 CISmonWEB runs: no run_attempt greater than 1.
- Separate status filters: queued=0; in_progress=0.
- Authoritative run 41755591293: completed/success, attempt 1.
- Actual Monitor.pollRepository and attempt-pinned fetchRunDetails agree with
  the authoritative response: completed/success, one expected and observed job,
  complete coverage, zero observed running jobs, possiblyStalled=false.
- The completed run was explicitly retained for comparison outside the normal
  one-hour import window; its provider state was not modified or fabricated.

No live discrepancy was observed for the available completed case. No genuine
queued/running/rerun transition or displaced-live-run example was available;
these, stale evidence, rate pauses and fairness remain deterministic-test
evidence, not claims of live acceptance. No workflows were triggered.

## Native Firefox blocker and remaining procedure

Firefox was listed by the Windows computer-use tool, but the tool stopped:
“browser URL policy enforcement is not yet supported for the current Windows
browser.” It required stopping browser interaction. No browser policy or
sandbox was bypassed. No native acceptance pass is claimed.

On an allowed native Firefox/Windows session, launch this exact qualified head
with CISMON_DATA_DIR pointing to a disposable directory and isolated credentials.
Record Firefox/Windows versions, tested SHA and timestamp, screenshots and results:

1. At 40px and narrower duration widths, inspect ELAPSED/MED/ETA/S-ETA. Verify
   22m16s wraps between 22m and 16s, with complete units intact. Include 1h16m,
   2d3h4m5s, WAIT, ≥ and zero duration. Verify each Clip mode independently of
   Wrap, and ordinary separator-aware text wrapping.
2. Click Surface fullscreen. Test Escape, Exit surface-only, window resize,
   surface switching and restoration. Check ordinary Popup and its honest
   browser-controlled decoration labeling.
3. Resize columns while rapidly switching surfaces; revisit and reload to
   confirm persistence. Exercise delayed detail selections, close/reopen,
   Watch and ACK, including an old-attempt ACK rejected after rerun.
4. With disposable data, make configuration replacement fail, verify visible
   failure without false success, restore writing and retry. Restart to verify
   accepted configuration and timing history; confirm runtime-only credentials
   remain absent from the saved settings without displaying their contents.

After native acceptance, recheck current main and PR heads, exact-head CI,
review findings and clean worktree, then follow the original guarded integration
instructions. Preserve the audit's historical pagination/downgrade/storage and
cross-window limits; do not implement HIST-PAGE-001 on this branch.
