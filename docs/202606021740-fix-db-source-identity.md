# Bugfix: DB-backed sources showed the same transcript for every session

Date: 2026-06-02

## Symptom
Clicking different OpenCode sessions always showed the same transcript (one Russia-project session).

## Root cause
OpenCode and Crush are single-SQLite-db sources: **every** session shares one `originalPath`
(`~/.local/share/opencode/opencode.db`). Session identity was keyed on `originalPath` in several
places, which is not unique for these sources:
- Renderer load effect depended on `selected.originalPath` → never re-fetched when switching between
  OpenCode sessions.
- Main `getSession(originalPath)` (a `Map` keyed by path) → returned one arbitrary OpenCode session
  for all of them.
- List React keys and the selected-row check also used `originalPath` → key collisions + every
  OpenCode row highlighting at once.

## Fix
Key session identity on **source + id** (ids are unique; verified 7 OpenCode sessions → 1 path, 7 ids).
- `indexer.ts`: `byKey: Map<sourceKey,UnifiedSession>`; `getSession(source, id)`.
- IPC `transcript:load` now takes `(originalPath, source, id)`; `loadTranscript` passes `id` to
  `getSession` for the DB reconstruct path. (`shared/ipc.ts`, `preload`, `main/index.ts`, `transcript.ts`.)
- Renderer: load effect depends on `[source, id, originalPath]` and passes `id`; `metaKey(s)` =
  `source␠id` used for the list React key and the selected-row comparison (`util.ts`, `App.tsx`,
  `SessionList.tsx`).

## Verification
`listSessions` + `loadTranscript` over the 7 local OpenCode sessions: 1 distinct `originalPath`,
7 distinct ids, **6 distinct transcripts** for the 6 sampled (distinct node counts / first messages /
repos). Build clean; app boots.
