# Electron fork of Agent Sessions — build record

Date: 2026-06-02

## Context
`agent-sessions` (Swift) stuttered rendering large sessions / raw JSONL even at ~7 MB. Goal: a lean
Electron rewrite keeping only the core — list (left) + viewer (right) with Session + JSON tabs and a
right-click row menu — reading from many AI agents, fast. Reuse `cli-continues`' JS parsers; reuse
`agent-sessions`' UX.

## Decisions
- App scaffolded **at repo root** (`/Users/weixu/dev/AgentSessionViewer/`); the two reference repos
  stay as subfolders (git-ignored).
- **Vendored** `cli-continues/src` parsers/types/utils/config into `src/main/sessions/` (true fork).
- Context menu is **copy/reveal only** (no terminal launching).
- Stack: **electron-vite + React + @tanstack/react-virtual**, Electron 35 (Node 22).

## What was built
- `src/main/indexer.ts` — merges `adapters[t].parseSessions({lightweight:true})` for all 16 tools,
  each wrapped in try/catch (one failing source never breaks the rest). Returns `SessionMeta[]`.
- `src/main/transcript.ts` — reads raw records itself (NOT `extractContext`, whose timeline is
  preset-truncated). `.jsonl` → stream via vendored `scanJsonlLines`; `.json` → parse + walk;
  directory/SQLite → reconstruct via `extractContext('full')` (flagged `reconstructed`).
- `src/main/mappers/{claude,codex,generic}.ts` — record → `ViewNode` (kind: user/assistant/thinking/
  tool_call/tool_result/meta/system). Codex mapper mirrors the parser's dedup (prefer `response_item`
  messages, separate system-injected context, pair tool calls with outputs via `call_id`).
- `src/main/index.ts` — window, IPC, native `Menu` for the row context menu.
- `src/preload/index.ts` — `window.api` bridge (list, loadTranscript, showRowMenu, reveal, openPath, copy).
- `src/renderer/` — React: virtualized `SessionList`, `FilterBar`, `Viewer` (tabs), virtualized
  `SessionView` (collapsible tool/thinking bubbles) and `JsonView` (index-aligned raw records).
  System light/dark via CSS vars.

## Performance (measured via scripts/smoke.ts on real local data)
- Indexed **195 sessions in 83 ms** (claude 120, codex 69, opencode 6).
- Largest Claude **7.6 MB → 16 ms** (1320 records → 823 nodes).
- Largest Codex **18.7 MB → 33 ms** (1147 records → 615 nodes).

The speed comes from: parsing in the main process (off the UI thread) + windowed rendering (only
visible rows in the DOM) + lightweight head-scan metadata for the list + collapsed large tool outputs.

## Verification
- `npm run build` — all three bundles compile (main 550 KB incl. vendored parsers).
- `scripts/smoke.ts` — indexer + transcript loader correct on real Claude/Codex/OpenCode data.
- `npm run dev` — app boots; screenshot confirmed the list, header, Session/JSON tabs, and bubble
  rendering (user/assistant/thinking/Bash tool call/Tool result) all display correctly.

## Known limitations / next steps
- Non-JSONL file sources (gemini/cursor/copilot/etc.) use the **generic** mapper (best-effort role+text);
  Claude & Codex are first-class. SQLite sources (opencode/crush) show a "reconstructed" banner.
- `node:sqlite` is experimental in the bundled Node; opencode/crush degrade gracefully if unavailable.
- No packaging yet (dev-run / `out/` only) — add `electron-builder` for a .dmg when desired.
- Possible polish: dedicated mappers for gemini/cursor, in-transcript find, persisted index for instant
  cold start, keyboard nav.
