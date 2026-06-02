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

## Architecture

electron-vite, three layers; the renderer has no Node access and talks only over IPC.

- `src/main/` — all file I/O. `indexer.ts` merges every adapter's `parseSessions({lightweight:true})`
  (each wrapped in try/catch so one failing source can't break the rest) into `SessionMeta[]`.
  `transcript.ts` loads a full transcript on demand. `mappers/` turn raw records into display nodes.
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
  `<parentUuid>/subagents/agent-*.jsonl`. Tree mode (`buildRows` in `util.ts`) nests subagents under the
  parent matched by `parentId → id`.

### Adding a new agent/tool

Create `src/main/sessions/parsers/<tool>.ts` (`parse<Tool>Sessions` + `extract<Tool>Context`), add the
name to `types/tool-names.ts`, and register it in `parsers/registry.ts` (a load-time assertion fails if a
tool name has no adapter). Add a color in `src/renderer/src/util.ts`. For full-fidelity rendering of a
JSONL source, also add a mapper + `nodesFor()` case.
