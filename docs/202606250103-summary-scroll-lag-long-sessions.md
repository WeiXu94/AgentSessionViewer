# Fix: scroll lag when jumping to a late message then scrolling up

## Symptom

In long sessions (dozens of turns), clicking a *late* user-message in the outline
indicator to jump there, then scrolling back **up**, was laggy: "scroll a lot but
the viewport only moves a little, it first rolls back then goes up."

## Root cause (measured, not guessed)

The transcript virtualizer (`@tanstack/react-virtual` in `SessionView.tsx`) used a
flat `estimateSize: () => 140` for every unmeasured row. Measured against a real
596-node session (`agent-browser` driving a CDP Electron build):

| kind        | count | median | mean | max  |
|-------------|------:|-------:|-----:|-----:|
| thinking    |   124 |     53 |   53 |   53 |
| tool_call   |   169 |     53 |   53 |   53 |
| tool_result |   171 |     53 |   53 |   53 |
| meta        |     2 |     53 |   53 |   53 |
| user        |    16 |    105 |  108 |  218 |
| assistant   |   114 |    105 |  193 | 1333 |

**466 of 596 rows (78%) are collapsed structural nodes that render as a single
~53px header**, yet each was estimated at 140px. The all-estimate total height was
**83,440px vs a true measured 48,368px — a 73% overshoot.**

Consequence chain:
1. Outline jump → `virt.getOffsetForIndex(index, 'start')` sums the 140px estimate
   over all the (unmeasured) rows above the target, placing the scroll **far deeper**
   than the target's true position (jump landed at offset 76,155 in an 82,722px space).
2. Scrolling up then measures those rows to their true (much smaller) heights, so the
   content above **collapses by ~34,000px**. react-virtual reconciles the scroll
   offset on every scroll-settle (and the app's own `remeasureRendered` forces it
   every 200ms), and with real trackpad momentum these corrections fight the user's
   upward scroll → the "rollback then crawl" lag.

This is the classic dynamic-virtualization failure: a size estimate far from reality,
made acute by jumping into never-measured territory.

## Fix

`src/renderer/src/components/SessionView.tsx` — replace the flat estimate with a
per-kind one:

```ts
const estimateSize = useCallback((index: number): number => {
  switch (nodes[index]?.kind) {
    case 'user': return 110
    case 'assistant': return 175
    default: return 56   // thinking / tool_call / tool_result / meta / system → 1-line header
  }
}, [nodes])
```

## Verification (same session, same jump+scroll-up)

| metric                              | before  | after        |
|-------------------------------------|--------:|-------------:|
| fresh all-estimate total height     | 82,257  | 47,640 (≈ true 48,368, −1.5%) |
| jump landing offset                 | 76,155  | 43,917 (realistic) |
| height drift over 16 scroll-up gestures | 4,149px | 548px |
| full top→bottom phantom collapse    | ~34,000px | ~0 (stable) |
| rendered-row overlaps / gaps        | 0 / 0   | 0 / 0 |

Typecheck passes. No visual regression (collapsed blocks, thinking, prose all lay out
cleanly; the smaller estimate does not introduce overlap because measured heights still
replace estimates on render).

## Hardening (follow-up): runtime-probed, content-based estimate

The per-kind constants above fix the *common* (tool-heavy) session but are still
session-tuned: a prose-heavy session under-predicts (every assistant guessed at 175
when each is ~800px) and re-introduces the same lag in the other direction, and the
collapsed `56` is a theme-dependent literal. Replaced the constants with a
content-derived estimate, computed from metrics **probed from the live DOM**:

- A hidden sample bubble is measured on mount / session-change / resize →
  `collapsedH`, prose base + per-line height, and chars-per-line for prose and the
  monospace block body (`measureRowMetrics`). Theme/font/zoom-proof; no literals.
- Each row's height is estimated from its own text (`wrappedLines × lineHeight +
  base`), and **expanded** collapsible blocks are estimated too (summary +
  body capped at the `.block__body` `max-height: 420px`), keyed on `blockOpenMode`.
- Estimates are **precomputed once** per `(nodes, metrics, blockOpenMode)` into an
  array; `estimateSize` is an O(1) lookup — the per-row text scan never runs in the
  hot path (it would otherwise fire O(N) per layout recompute while scrolling).

### Why not other approaches
- **Freeze the offset / never re-measure** — can't: the offset *is* the layout, so a
  frozen-but-wrong height overflows/overlaps the next row. The only correct form is
  pre-measuring every row once up front, which spikes CPU/memory and doesn't scale to
  huge sessions. Content-based estimation is the scalable approximation.
- **Running-average estimate (adaptive over time)** — fragile: react-virtual only
  re-anchors scroll for *measured-row* resizes, not for estimate changes on unmeasured
  rows, so a drifting estimate causes *uncompensated* mid-session jumps. A per-row,
  time-invariant content estimate avoids this.

### Verification of the hardened version (same jump+scroll-up)
| metric | flat 140 | per-kind const | content-based |
|---|--:|--:|--:|
| fresh estimate total (true 48,368) | 82,257 (+70%) | 47,640 (−1.5%) | 49,734 (+2.8%) |
| height drift over 16 scroll-up gestures | 4,149px | 548px | **184px** |
| **expand-all** estimate total (true 127,755) | ~83,440 (−35%) | ~49,734 (−61%) | **127,056 (−1%)** |
| overlaps / gaps (collapsed & expanded) | — | 0 / 0 | 0 / 0 |

## Notes / residual

- The estimate only affects *unmeasured* rows; once a row renders it is measured exactly,
  so any individual mis-estimate (e.g. a node dominated by a code block or table) self-
  corrects on first view.
- Content→pixel mapping for prose uses an average char width (~0.5em proportional,
  ~0.6em monospace); markdown reflow (headers, tables, images) makes it approximate, but
  it is content-*proportional* (long → tall), which is what keeps reconciliation small.

## Repro tooling (scratch, not committed)

Driven via a CDP-enabled Electron build (`--remote-debugging-port=9222
--disable-backgrounding-occluded-windows`) + `agent-browser`. Note: synthetic
`element.scrollTop = …` sets are authoritative and do **not** reproduce the
compositor-level momentum fight (they always showed 100% efficiency); the discriminating,
reproducible signal was the **scrollHeight collapse**, which the fix removes.
