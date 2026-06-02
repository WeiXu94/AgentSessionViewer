# Pi support + desk/cli variants + subagent tree

Date: 2026-06-02

## Context
Follow-ups after the initial Electron fork: (1) Pi (`~/.pi/agent/sessions`) was not in cli-continues
and wasn't scanned; (2) parity with Agent Sessions' ability to distinguish Claude/Codex **desktop vs
CLI** variants; (3) a **flat / tree** list toggle that nests **subagent** sessions under their parent.

## Pi
- New vendored parser `src/main/sessions/parsers/pi.ts` (`parsePiSessions` + `extractPiContext`),
  registered in `parsers/registry.ts`, `'pi'` added to `types/tool-names.ts`.
- Format: JSONL under `~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl`. First line `{type:'session',
  id, cwd, timestamp}`. Records: `model_change`, `message` (`message.role` = user/assistant/toolResult,
  blocks `text|thinking|toolCall`), `custom`. Resume: `pi --resume <id>`.
- Dedicated viewer mapper `src/main/mappers/pi.ts`, wired in `transcript.ts`.
- Verified: 35 Pi sessions; largest 1 MB → 5 ms; correct node kinds; model/repo/summary populated.

## Variants (desk / cli / vscode)
- Added optional `variant`, `parentId`, `subagentType` to `UnifiedSession` (`types/index.ts`) and to
  `SessionMeta` (`shared/ipc.ts`, plus a short `variantLabel`).
- **Claude** (`parsers/claude.ts`): captures top-level `entrypoint`; `claude-desktop` → `desktop`,
  else `cli`. Subagents → `subagent`.
- **Codex** (`parsers/codex.ts`): `classifyCodexVariant(originator)` — contains `desktop`/`app` →
  desktop, `vscode` → vscode, else cli. (Local data: "Codex Desktop", "codex-tui".)
- Indexer maps variant → label (`cli`/`desk`/`vscode`/subagent-type) and suppresses the resume command
  for subagents. Renderer shows a clean source badge (`sourceName()`) + a variant chip.

## Codex subagent nesting
- `extractCodexSubagent(payload)` reads `session_meta.payload.source.subagent`: `{thread_spawn:
  {parent_thread_id, agent_role, agent_nickname}}` → `parentId` + `subagentType` (role || nickname);
  bare object like `{other: "guardian"}` → `subagentType` only (no parent); string → type only.
- Codex subagents are already discovered (normal `rollout-*.jsonl`), so only classification changed:
  `variant='subagent'` overrides the originator-based variant. They nest via the same `parentId → id`
  tree logic as Claude. Local data: 14 subagents — 4 thread-spawned (nest under parent), 10 `guardian`
  (parent-less, shown top-level).

## Subagent discovery + tree
- `parsers/claude.ts` `findSessionFiles` now also matches `agent-*.jsonl`; `detectClaudeSubagent()`
  reads `<parentUuid>/subagents/agent-*.jsonl` + adjacent `.meta.json` (`agentType`, `description`) →
  sets `parentId`, `subagentType`, `variant='subagent'`, and uses the description as a summary fallback.
- Renderer: `buildRows()` (`util.ts`) flattens sessions into display rows; in **tree** mode subagents
  nest under the parent matched by `parentId → id` (collapsed by default, ▶ caret to expand). **Flat**
  mode lists everything (subagents inline). Toggle lives in the title bar.
- Verified: 328 sessions total — claude 89 cli / 31 desktop / 97 subagents (all linked to a parent,
  resume suppressed), codex 64 desktop / 5 cli, pi 35. Subagent transcripts load (126 nodes).

## Verification
- `npx electron-vite build` — clean. App boots; screenshots confirm variant chips ("CLAUDE CLI",
  "CLAUDE DESK", "CODEX DESK") and the cleaned viewer header ("CODEX" + "desk" chip).
- Note: vendored parsers (`claude.ts`, `codex.ts`, `types/index.ts`, `tool-names.ts`, `registry.ts`)
  now carry targeted local edits — re-apply when syncing from upstream cli-continues.
