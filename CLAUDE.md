# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

A fast Electron viewer for local AI coding-agent sessions (Claude, Codex, Pi, OpenCode, + others).
A lean fork of `agent-sessions/` (Swift) reusing parsers from `cli-continues/` (TS). Both subfolders
are **reference repos only** — git-ignored, not built. Port logic from them; don't edit them.

## Commands

**bun** is the dev/ package manager. The app runs on Electron's bundled Node; the system runtime only
matters for scripts, tests, and harnesses.

```bash
bun install        # deps
bun run dev        # electron-vite dev, hot reload
bun run build      # bundle main/preload/renderer into out/
bun run typecheck  # tsc on node + web + test projects
bun run test       # node --test — must run on Node, not bun (Bun has no node:sqlite)
```

```bash
bun scripts/smoke.ts   # index real sessions + time transcript loading (no bundling needed)
```

## Lessons

- **Test/debug the real Electron app, not just the Vite renderer URL**, via `agent-browser` + CDP. Start
  with `agent-browser skills get electron --full`. Launch a CDP instance:
  `ELECTRON_RENDERER_URL=http://localhost:5173 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9222`,
  then `agent-browser --session asv-electron --cdp 9222 snapshot -i`. If `connect 9222` fails with
  `Target.createTarget: Not supported`, keep `--cdp 9222` per command. Confirm the target is real with
  `… eval "JSON.stringify({ hasApi: !!window.api, … })"` (should show `window.api`). Stop any temp CDP
  process after testing; leave the user's dev app alone unless asked.
- **New agent support = parser + mapper.** Parsers (`src/main/sessions/`, from `cli-continues`) discover
  and index normalized `UnifiedSession` metadata; mappers (`src/main/mappers/`, this app's, refer to
  `agent-sessions` + existing mappers) render raw records to `ViewNode`. Pi is the parser exception
  ported from `agent-sessions`.

## Architecture

electron-vite, three layers; the renderer has no Node access and talks only over IPC.

- `src/main/` — all file I/O. `indexer.ts` merges every adapter's `parseSessions({lightweight:true})`
  (each in try/catch so one failing source can't break the rest) into `SessionMeta[]`. `transcript.ts`
  loads a full transcript on demand. `mappers/` turn raw records into display nodes. `searchIndex.ts`
  keeps an FTS5 index (`<userData>/search-index.db`) of user+assistant text, synced in the background
  after every `sessions:list`. `export.ts` holds the pure markdown/HTML exporters (dialog + file write
  live in `index.ts`).
- `src/main/sessions/` — **vendored** from `cli-continues/src`. Carries targeted local edits (Pi parser;
  variant + subagent detection in `claude.ts`/`codex.ts`; `variant`/`parentId`/`subagentType` on
  `UnifiedSession`). Re-apply these when syncing from upstream.
- `src/preload/index.ts` — exposes `window.api` (the `SessionsAPI` in `src/shared/ipc.ts`).
- `src/renderer/` — React. The session list and transcript are both **virtualized**
  (`@tanstack/react-virtual`); never render a whole file/list into the DOM.
- `src/shared/ipc.ts` — typed IPC contract shared by main and renderer (type-only; erased at build).

### Non-obvious invariants

- **Transcripts read raw records, not `extractContext`.** `extractContext().timeline` is
  verbosity-truncated and only some parsers emit it. `transcript.ts` streams `.jsonl`/`.json` itself:
  `records` (raw, JSON tab) is index-aligned with `nodes` (normalized, Session tab). SQLite-backed
  sources (opencode, crush) have no per-session file, so they fall back to `extractContext('full')`
  (preset-capped) and are flagged `reconstructed`.
- **Session identity is `source + id`, never `originalPath`.** DB-backed sources share one
  `originalPath` (`…/opencode.db`) across all sessions. Use `metaKey()` (renderer) /
  `getSession(source,id)` (main); `loadTranscript` takes `id` for this reason.
- **Mappers** in `src/main/mappers/` are dispatched by `nodesFor()` in `transcript.ts`
  (`claude`, `codex`, `pi`, else `generic`). A first-class JSONL source = new mapper + dispatch.
- **Variants & subagents.** Each session has a `variant` (`cli`/`desktop`/`vscode`/`subagent`): Claude
  from `entrypoint`, Codex from `originator` / `source.subagent`. Claude subagents are discovered from
  `<parentUuid>/subagents/**/agent-*.jsonl` (incl. `workflows/wf_*/`) and take their **id from the
  filename**, not records — subagent records carry the parent's sessionId, which would collide. Tree
  mode (`buildRows` in `util.ts`) nests subagents under the parent matched by `parentId → id`.
- **node:sqlite truncates TEXT at embedded NUL on read.** Never store the renderer's NUL-separated
  `metaKey` in SQLite — `searchIndex.ts` keys rows by `source:id:originalPath` and reads identity from
  dedicated columns instead of splitting keys.
- **Search** indexes only `kind ∈ {user, assistant}`, skipping `inherited` fork nodes. `node_index` per
  hit = index into `loadTranscript().nodes`, so hits jump straight to a node. One unified modal
  (`GlobalSearch.tsx`, ChatGPT-style), not two bars. Scopes: All (default) / This project / This session
  — All/Project hit the FTS index (debounced), This session searches the open transcript over *all*
  node kinds. **Title hits weighted above body** — `searchSessions` takes live `SessionMeta[]` (fresh
  titles, not the stale indexed `summary` column) and `titleSnippet()` tokenizes the query
  AND-of-tokens like the FTS path. Whole-word toggle drops the FTS prefix-`*` and uses `\b` regex.
- **Claude session titles come from `ai-title` records** (`{"type":"ai-title","aiTitle":…}`, ~⅔ of
  sessions). Precedence in `claude.ts`: `customTitle` (manual rename) > `aiTitle` (last/most-current;
  its record `sessionId` can differ from the file's in fork chains) > first user message > subagent desc.

### Adding a new agent/tool

Create `src/main/sessions/parsers/<tool>.ts` (`parse<Tool>Sessions` + `extract<Tool>Context`), add the
name to `types/tool-names.ts`, register it in `parsers/registry.ts` (a load-time assertion fails if a
tool name has no adapter), and add a color in `src/renderer/src/util.ts`. For full-fidelity rendering of
a JSONL source, also add a mapper + `nodesFor()` case.
