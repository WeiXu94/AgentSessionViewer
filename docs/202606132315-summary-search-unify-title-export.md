# Summary — Unified search modal, title fix, export header

Date: 2026-06-13. Branch: `feature/global-search-and-export`.

Three user-requested changes, implemented inline and adversarially verified by a
sonnet workflow (`wf_be8189bb-b90`).

## 1. Export Markdown header → bullet list
`buildMarkdownExport` joined the header meta fields with soft line breaks, so
renderers collapsed them into one wrapped paragraph. Now each field is a
`- **Label:** value` list item (block-level → one line per field), mirroring the
HTML export's `<table class="meta">`. HTML export untouched. (`export.ts`)

## 2. Session title regression → read Claude `ai-title`
Root cause: Claude Code writes its generated title as a `{"type":"ai-title",
"aiTitle":…}` record (present on 103/157 local sessions). The Swift
`agent-sessions` original read it; the vendored `cli-continues` TS parser this app
forked never did, so titles fell back to the first user message.

Fix (`claude.ts`): capture `aiTitle` (last/most-current; record `sessionId` can
differ from the file's in fork/continue chains, so a fallback ignores the
target-session match). Precedence: `customTitle` (manual rename) > `aiTitle` >
first user message > subagent description. Metadata cache bumped v4 → v5.
Codex titles already worked (thread names from `session_index.jsonl`, 80/101).

## 3. Unify the two search bars → one ChatGPT-style modal
Removed the sidebar list-filter input and the toolbar in-place find box. Added a
search icon in the toolbar lead (next to the collapse toggle); opens a centered
modal (also ⌘F / ⌘K).

- Scope tabs: **All sessions (default)** / This project / This session
  (project/session disabled when unavailable).
- **Whole word** toggle — drops FTS prefix-`*`, uses `\b` regex for title/local.
- **Title matches weighted above body** — `searchSessions` now also takes the live
  `SessionMeta[]` and matches titles against fresh metadata (not the stale indexed
  `summary` column); title hits get a `TITLE` row sorted to the top. Multi-word
  title matching is AND-of-tokens, consistent with the FTS body path.
- All/Project → FTS index (debounced 250 ms); This session → local transcript scan
  over all node kinds. Click → jump-to-node; Esc clears then closes; backdrop closes.

Files: `App.tsx`, `GlobalSearch.tsx`, `FilterBar.tsx`, `searchIndex.ts`,
`index.ts`, `preload/index.ts`, `ipc.ts`, `styles.css`.

## Verification
- Logic harnesses (real data): title fix, title weighting, whole-word counts,
  multi-word/out-of-order title match, markdown header list.
- Live CDP Electron: modal open via icon, title-weighting (`tailscale` → TITLE row
  first), scope enable/switch, whole-word (113 → 106 sessions), result jump, Esc
  (clear then close from non-input focus), backdrop close.
- Sonnet review verdicts: title fix **pass**; export + search had findings. Fixed
  the two real ones (Esc-off-input; multi-word title semantics). Rejected: a
  pre-existing tool-pairing fallback note (out of scope; the suggested broadening
  would re-introduce the FIFO cross-pairing bug a prior fix prevents). Left the
  `totalMatches` accounting note (arithmetic nets out correct in every case).
