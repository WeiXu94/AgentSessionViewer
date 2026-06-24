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

## Notes / residual

- The estimate only affects *unmeasured* rows; once a row renders it is measured exactly,
  so the few tall assistant-prose outliers (up to 1333px) self-correct on first view.
- `blockOpenMode === 'expanded'` (manual "expand all") makes the collapsed kinds tall;
  the 56px estimate then under-predicts them. That is a deliberate, less-common action
  (not the reported issue) and rows still measure on render. Left as-is.

## Repro tooling (scratch, not committed)

Driven via a CDP-enabled Electron build (`--remote-debugging-port=9222
--disable-backgrounding-occluded-windows`) + `agent-browser`. Note: synthetic
`element.scrollTop = …` sets are authoritative and do **not** reproduce the
compositor-level momentum fight (they always showed 100% efficiency); the discriminating,
reproducible signal was the **scrollHeight collapse**, which the fix removes.
