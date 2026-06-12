# Summary: Global FTS search + MD/HTML export

Branch: `feature/global-search-and-export`. Plan: `202606130106-plan-global-search-and-export.md`.

## What shipped

### 1. Cross-session full-text search (FTS5 + bm25)

- **`src/main/searchIndex.ts`** — FTS5 index over user messages + assistant text only (no tool
  calls/results/thinking/meta — noise excluded by design). `node:sqlite` `DatabaseSync` (built into
  Electron 35's Node 22.16, FTS5 + bm25 verified) — zero new dependencies. DB at
  `<userData>/search-index.db`, external-content FTS table synced by triggers, `unicode61
  remove_diacritics 2` tokenizer.
- **Incremental background sync** after every `sessions:list`: per-session `updatedAt+bytes`
  fingerprint, only changed sessions re-read (via the same `loadTranscript()` mappers the viewer
  uses, so stored `node_index` always aligns with rendered nodes). Full first run over 474
  sessions / 411 MB: **~2 s, 13.7 MB DB**; later no-op syncs ~50 ms; queries 1–10 ms.
- **Search box scopes** (chip dropdown in the toolbar find box): *This session* (existing
  find-in-session, unchanged), *This project* (active project filter, else selected session's
  repo/cwd), *All sessions*. ⌘F = session scope, ⌘⇧F = all sessions.
- **Results overlay** (decided over filtering the sidebar): anchored under the find box, debounced
  250 ms, grouped per session (≤5 snippets each, bm25-ordered, `\x02/\x03` snippet markers →
  `<mark>`), keyboard nav (↑/↓/Enter/Esc), live "Indexing m/n…" footer that re-queries when the
  background index pass lands. Clicking a hit opens the session, seeds find-in-session with the
  query, scrolls to the exact node (existing `activeMatch` path when the substring matches; new
  `scrollTarget` + flash ring fallback for multi-token queries).

### 2. Export to Markdown / HTML

- **`src/main/export.ts`** (pure, harness-testable): `buildTurns()` groups ViewNodes into
  user/assistant turns (FIFO pairing of parallel tool calls with their results; Claude fork
  boundary → note). Markdown follows opencode's TUI `/export` format (`# title` + bold header
  fields, `## User`/`## Assistant`, `_Thinking:_`, `**Tool: name**` + adaptive-length fences so
  embedded backticks can't break out). HTML follows pi's single self-contained file idea,
  server-rendered: header card, bubbles, `marked` for message markdown, collapsed `<details>` for
  thinking/tools (errors tinted), inline CSS, light/dark via `prefers-color-scheme`.
- **IPC `export:session`** → native save dialog (default `<source>-session-<id>.md|html` in
  Downloads) → write → reveal in Finder. Export dropdown button in the viewer header.

### Bonus fixes found along the way

- **Claude workflow subagents** (`subagents/workflows/wf_*/agent-*.jsonl`) are now detected as
  subagents (nested in tree mode) instead of appearing as duplicate top-level cli sessions.
- **Subagent ids derive from filenames** — their records carry the *parent's* sessionId, which
  collided in `source+id` identity (`metaKey`, `getSession`, React keys). Metadata cache bumped to
  v4 to invalidate stale ids.

## Gotchas discovered (now in CLAUDE.md)

- `node:sqlite` truncates TEXT at embedded NUL on **read** — the renderer's NUL-separated
  `metaKey` cannot round-trip through SQLite. Index keys use `source:id:originalPath` and identity
  is read from dedicated columns.
- A `*/` inside a JSDoc example path (`wf_*/agent`) terminates the comment — tsc errors appear far
  downstream.

## Verification

- Node harness (`tmp/test-search-export.ts`, `tmp/test-full-index.ts`, electron stubbed via esbuild
  alias) against all real local sessions: index counts, scoped queries (0 scope violations),
  no-op resync, md/html exports for claude/codex/opencode/pi, fence-balance check.
- Live app via CDP + agent-browser: scope menu, all-sessions + project-scoped overlay, result click
  → jump-to-node with highlight verified by screenshot, export menu render.
- `npm run typecheck`, `npm run build` clean. Multi-agent adversarial review run on the diff.
