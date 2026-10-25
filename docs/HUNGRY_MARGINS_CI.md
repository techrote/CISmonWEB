# Hungry Margins 037 — original artwork integration

CISmonWEB imports the **original, user-supplied 037 / Hungry Margins** HTML artwork rather than approximating it with a replacement renderer.

## Exact visual source

- public/art/037-hungry-margins3.html retains the self-contained original source, with line endings normalized.
- Original generation 037's Canvas pipeline, ancestry effects, living resonance, chromatic slug, contamination, quiet substrate, broken seals and defensive hungry margins remain intact.
- The server inserts a small bridge script **after all original artwork scripts**, along with a rule hiding duplicate inner controls. It does not rewrite the original visual logic.
- The source can be audited at /art/037-hungry-margins3.html (served safely as plain text). The live frame uses /art/hungry-frame.

## What CI events do visually

| Normalized data | Meaning inside the original artwork |
| --- | --- |
| Running | A central chromatic slug and pressure-wave paths; pulses at stable run anchors |
| Queued | Margins feed inward; queue size affects the feeder path and pressure |
| Existing failed runs | One subtle contamination deposit per current failed run, without inventing a new transition |
| Newly observed failure | A concentrated scar/feeding pulse with local contamination |
| Newly observed success | Local release/relaxation of the source contamination grid |
| Possible stall | Periodic stronger unstable local pulses and more strain |
| No active runs | Slow, continuing autonomous edge and interior movement — without fake run events |

Events marked as observed arise **only** when the browser actually sees a state transition between two successive normalized snapshots. A historical failure fetched at startup is not falsely reported as a new failure.

The backdrop reads all monitor dashboard candidates, not just the currently filtered/limited run list. Global running and queued counts are reconciled with server tracking totals.

## Autonomous mouse-derived movement

The two paths in shared/hungry-ci.js are deterministic, finite and bounded:

1. A slowly moving shoreline feeder that patrols the edges.
2. A central wandering slug that crosses the field in smooth arcs.

The browser alternates the two agents in multi-second periods, because generation 037 has a **single memory-bearing pointer**. It sends at most one visual brush stroke every 200 milliseconds, plus an occasional pulse near a real run anchor.

public/art/hungry-bridge.js feeds those strokes through the **original artwork's input callbacks**, rather than drawing its own imitation. The original pressure, slug, contamination and hungry-margin code produces the effect directly.

Actual pointer movement and holds still work via the original event handlers. Autonomous movement backs off for three seconds after human pointer input, preventing contention.

## Controls and safety

The existing Surface editor controls animation (Off/Subtle/Normal/Intense), pointer reactivity (0–100), visible fields, grouping and filters. Pause, Reseed and Collect PNG operate on the art only. Hidden tabs and reduced-motion settings stop autonomous input and pause the original animation.

The imported source runs in an opaque-origin sandboxed iframe. Its child-only CSP permits the original inline artwork scripts/styles but forbids network connections. The parent app retains its strict policy. Only normalized status counts, short status labels, hashed positions and visual commands cross the message bridge — never credentials or repository source.

The COHERENCE figure is explicitly an **illustrative artistic index** rather than a health or performance metric. The queue-pressure readout is a derived visual encoding. Actual CI statuses and counts remain available in the HTML overlay.

The original artwork's internal rendering rate is unchanged when animation is enabled; it can be more demanding than the previous lightweight approximation. Off and browser reduced-motion pause it completely.

## Verification

- test/hungry-ci.test.js: deterministic idle movement, no fake transitions, run-status pressure mapping, bounded anchors and stalled pulses.
- test/fun-server.test.js: full original hook availability, source-route equivalence, instrumented frame ordering, and strict child/parent CSP isolation.
- Existing CI tests: monitoring, persistence, HTTP startup and other surface layouts.

The GitHub API polling engine, token storage, run-tracker semantics, scheduling and history journal are unchanged.
