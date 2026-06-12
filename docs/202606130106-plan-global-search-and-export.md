# Plan: Global FTS search + MD/HTML export

Branch: `feature/global-search-and-export`

## 1. Global search (SQLite FTS5 + bm25)

- **Backend**: `node:sqlite` `DatabaseSync` (already used for opencode/crush/cline; Electron 35 = Node 22.16, FTS5 + bm25 verified working). No new deps.
- **DB**: `<userData>/search-index.db` (same path resolution as sessionMetadataCache). New `src/main/searchIndex.ts`.
- **Schema**: `sessions(session_key PK, source, id, repo, cwd, summary, original_path, updated_at, bytes, …)` fingerprint table + `messages(id PK, session_key, node_index, kind, text)` + external-content FTS5 table `messages_fts(text, content='messages')` synced by triggers. Tokenizer `unicode61 remove_diacritics 2`.
- **Indexed content**: only `ViewNode.kind ∈ {user, assistant}`, skipping `inherited` fork nodes (avoids double-indexing parent content) — tool calls/results/thinking/meta/system excluded (noise). `node_index` = position in the full nodes array → exact jump target, since indexing reuses the same `loadTranscript()` mappers the viewer uses.
- **Incremental sync**: after every `sessions:list`, background-sync (singleton, sequential) — reindex a session only when `updatedAt`/`bytes` fingerprint changed; delete rows for removed sessions. Progress pushed via `searchIndex:progress`.
- **Query**: tokens quoted + prefix-starred → `MATCH`, ranked `bm25()`, `snippet()` with `\x02/\x03` markers, grouped per session (≤5 matches each) in JS, sessions ordered by best rank.
- **IPC**: `search:query (query, scope {repo?|cwd?}) → {available, indexing, groups[]}`; push event for progress.
- **UX (decision)**: search box keeps a **scope switch** (Session ▸ Project ▸ All) and global scopes open a **results overlay/modal** under the toolbar — chosen over filtering the session list because per-match snippet previews + jump-to-message need their own list, and the sidebar filters stay orthogonal/persistent. Debounced 250 ms. Enter/click → select session, seed find-box with query, scroll to the matched node (new `scrollTarget` prop on SessionView reusing `jumpToIndex`), flash highlight. Cmd+F = session scope, Cmd+Shift+F = all-sessions scope.
- **Project scope** = active sidebar project filter, else selected session's repo (cwd fallback).

## 2. Export to Markdown / HTML

- New `src/main/export.ts`, pure (no Electron) builders over `UnifiedSession` + `TranscriptPayload`:
  - **Markdown** (opencode `formatTranscript` style): `# title` + `**Session ID/Created/Updated/Model/Project**` header, `---` separators, `## User` / `## Assistant` sections, `_Thinking:_` blocks, `**Tool: name**` + ` ```json ` Input / ``` Output fences (fence length adapts to content), meta/system skipped, no truncation.
  - **HTML** (pi-style single self-contained file, simplified): server-side rendered — header card, message bubbles, markdown via `marked` (raw HTML escaped), `<details>` collapsed tool/thinking blocks, inline CSS, light/dark via `prefers-color-scheme`. No JS deps inlined.
- **IPC**: `export:session (source, id, originalPath, format)` → `dialog.showSaveDialog` (default `{source}-session-{id8}.{md|html}`) → write → reveal in Finder.
- **UI**: export dropdown button in Viewer header.

## 3. Verification

- esbuild harness in `tmp/` runs searchIndex + export builders against real local sessions under Node.
- `npm run typecheck`; manual run via CDP electron + agent-browser.
