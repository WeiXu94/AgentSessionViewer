# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A fast Electron viewer for local AI coding-agent sessions (Claude, Codex, Pi, OpenCode, + others).
A lean fork of `agent-sessions/` (Swift) that reuses the session parsers from `cli-continues/` (TS).
Those two subfolders are **reference repos only** — git-ignored, not built. Don't edit them; port logic
from them into this app instead.

## Commands

```bash
npm run dev        # electron-vite dev with hot reload
npm run build      # bundle main/preload/renderer into out/
npm run typecheck  # tsc on node + web projects
```

There is no test runner. To exercise the parsing/indexing pipeline against real local data, bundle a
throwaway harness with esbuild (it resolves the vendored `.js`→`.ts` imports like Vite does) and run it
under Node — `src/main/indexer.ts` and `transcript.ts` have no Electron dependency:

```bash
# harness imports from ../src/main/indexer.js etc.; ESM + top-level await
npx esbuild scripts/x.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/x.mjs && node scripts/x.mjs
```

## Lessons

- Use `agent-browser` to test and debug this Electron app, not only the plain Vite renderer URL. Start with `agent-browser skills get electron --full`.
- To test the real Electron preload/main integration, launch a CDP-enabled Electron instance:
  `ELECTRON_RENDERER_URL=http://localhost:5173 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9222`
- Then drive it with per-command CDP flags, for example:
  `agent-browser --session asv-electron --cdp 9222 snapshot -i`
- If `agent-browser connect 9222` fails with `Target.createTarget: Not supported`, keep using `--cdp 9222` on each command.
- Confirm the target is the real Electron app before trusting UI results: `agent-browser --session asv-electron --cdp 9222 eval "JSON.stringify({ hasApi: !!window.api, keys: window.api ? Object.keys(window.api) : [] })"` should show `window.api`.
- Stop any temporary CDP Electron process after testing; leave the user's existing dev app alone unless asked.
- For new agent support, keep the split clear: parsers in `src/main/sessions/` come from / should be compared against `cli-continues` and discover/index normalized `UnifiedSession` metadata; mappers in `src/main/mappers/` are this app's raw-record-to-`ViewNode` transcript renderer and should refer to `agent-sessions` UI/viewer logic plus existing mappers when adding full-fidelity display. Pi is the known parser exception ported from `agent-sessions`.

## Architecture

electron-vite, three layers; the renderer has no Node access and talks only over IPC.

- `src/main/` — all file I/O. `indexer.ts` merges every adapter's `parseSessions({lightweight:true})`
  (each wrapped in try/catch so one failing source can't break the rest) into `SessionMeta[]`.
  `transcript.ts` loads a full transcript on demand. `mappers/` turn raw records into display nodes.
  `searchIndex.ts` keeps an FTS5 index (node:sqlite, `<userData>/search-index.db`) of user+assistant
  text for cross-session search; synced in the background after every `sessions:list`. `export.ts`
  holds the pure markdown/HTML transcript exporters (dialog + file write live in `index.ts`).
- `src/main/sessions/` — **vendored** from `cli-continues/src` (parsers, types, utils, config). Carries
  targeted local edits (Pi parser; variant + subagent detection in `claude.ts`/`codex.ts`; `variant`/
  `parentId`/`subagentType` on `UnifiedSession`). Re-apply these when syncing from upstream.
- `src/preload/index.ts` — exposes `window.api` (the `SessionsAPI` in `src/shared/ipc.ts`).
- `src/renderer/` — React. Both the session list and the transcript are **virtualized**
  (`@tanstack/react-virtual`); never render a whole file/list into the DOM.
- `src/shared/ipc.ts` — the typed IPC contract shared by main and renderer (type-only; erased at build).

### Non-obvious invariants

- **Transcripts read raw records, not `extractContext`.** `extractContext().timeline` is
  verbosity-truncated and only some parsers emit it — wrong for a full viewer. `transcript.ts` streams
  `.jsonl`/`.json` files itself: `records` (raw, powers the JSON tab) is index-aligned with `nodes`
  (normalized, powers the Session tab). SQLite-backed sources (opencode, crush) have no per-session file,
  so they fall back to `extractContext('full')` (preset-capped) and are flagged `reconstructed`.
- **Session identity is `source + id`, never `originalPath`.** DB-backed sources share one
  `originalPath` (`…/opencode.db`) across all sessions. Use `metaKey()` (renderer) / `getSession(source,id)`
  (main); `loadTranscript` takes `id` for this reason.
- **Per-source mappers** in `src/main/mappers/` are dispatched by `nodesFor()` in `transcript.ts`
  (`claude`, `codex`, `pi`, else `generic`). Adding a first-class JSONL source = new mapper + dispatch.
- **Variants & subagents.** Each session has a `variant` (`cli`/`desktop`/`vscode`/`subagent`): Claude from
  `entrypoint`, Codex from `originator` / `source.subagent`; Claude subagents are discovered from
  `<parentUuid>/subagents/**/agent-*.jsonl` (incl. `workflows/wf_*/` nesting) and get their **id from the
  filename**, not from records — subagent records carry the parent's sessionId, which would collide.
  Tree mode (`buildRows` in `util.ts`) nests subagents under the parent matched by `parentId → id`.
- **node:sqlite truncates TEXT at embedded NUL on read.** Never store the renderer's NUL-separated
  `metaKey` in SQLite — `searchIndex.ts` keys rows by `source:id:originalPath` and reads identity from
  dedicated columns instead of splitting keys.
- **Search indexes only `kind ∈ {user, assistant}`, skipping `inherited` fork nodes** (tool noise and
  duplicated parent content stay out). `node_index` stored per message = index into the same
  `loadTranscript().nodes` array the viewer renders, so search hits can jump straight to a node.
- **Search is one unified modal** (`GlobalSearch.tsx`, ChatGPT-style), not two bars. Scopes: All
  (default) / This project / This session. All/Project hit the FTS index (debounced); This session
  searches the open transcript locally over *all* node kinds. **Title hits are weighted above body
  hits** — `searchSessions` takes the live `SessionMeta[]` (fresh titles, not the possibly-stale
  indexed `summary` column) and `titleSnippet()` tokenizes the query AND-of-tokens like the FTS path.
  Whole-word toggle drops the FTS prefix-`*` and uses `\b` regex boundaries.
- **Claude session titles come from `ai-title` records** (`{"type":"ai-title","aiTitle":…}` — Claude's
  own generated title, on ~⅔ of sessions). The vendored TS parser never read it (the Swift
  `agent-sessions` original did), so titles had regressed to the first user message. Precedence in
  `claude.ts`: explicit `customTitle` (manual rename) > `aiTitle` (last/most-current; its record
  `sessionId` can differ from the file's in fork chains) > first user message > subagent desc.

### Adding a new agent/tool

Create `src/main/sessions/parsers/<tool>.ts` (`parse<Tool>Sessions` + `extract<Tool>Context`), add the
name to `types/tool-names.ts`, and register it in `parsers/registry.ts` (a load-time assertion fails if a
tool name has no adapter). Add a color in `src/renderer/src/util.ts`. For full-fidelity rendering of a
JSONL source, also add a mapper + `nodesFor()` case.
