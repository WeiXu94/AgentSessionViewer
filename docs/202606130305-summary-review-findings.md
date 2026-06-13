# Adversarial review findings — global search + export (commit 5fdf605)

Run `wf_92b2cb42-4f1`, 4 review dimensions + per-finding adversarial verification. **25 confirmed, 0 rejected** (some are the same bug found by multiple dimensions).

## Status

**Fixed** (the 4 distinct majors, commit after this doc):
- Index eviction on transient transcript-load error (#1) — `searchIndex.ts` now skips the delete/upsert when `payload.error`, keeping the stale fingerprint so the next sync retries. Verified: rows survive a forced load error.
- HTML export raw-HTML/XSS + `javascript:` URL passthrough (#5/#6) — `export.ts` now renders markdown via a dedicated `marked` instance that escapes raw HTML tokens and drops `javascript:`/`data:` link & image URLs. Verified: 7/7 escaping checks.
- Tool call/result mispairing (#3/#4/#24) — added `ViewNode.toolUseId` (Anthropic `tool_use_id` / OpenAI `call_id` / Pi `id`), populated in the claude/codex/pi mappers; `buildTurns` pairs by id with FIFO fallback for id-less sources. Verified: 6052/6052 Claude tool outputs paired correctly (was ~71% mispaired).
- Stale `pendingJump` on cross-session jump (#2) — `App.tsx` gates jump application on a new `transcriptKey` stamp so it only fires once the *target* transcript is in state. Verified live via CDP: cross-session result click lands on the right session/node.

**Not yet addressed** — the ~15 minors below (CJK tokenizer, incremental tail-append indexing, progress-IPC throttle, active-session re-index, error-label, meta-content export, scope-dropdown z-index, search req-race, select-wipes-query, dead re-click, etc.). Left for a follow-up pass.

---


## 1. [MAJOR] Sessions whose transcript fails to load are indexed as empty with a current fingerprint — previously-indexed content is deleted and never re-indexed
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/searchIndex.ts:220-257`  ·  dimension: sql-index

**Problem:** loadTranscript never throws; on any I/O failure it returns `{ error, nodes: [] }` (transcript.ts:84-93). In runSync, the `if (!payload.error)` guard only skips building `rows`, but the transaction still executes: `deleteMessages.run(key)` wipes the session's existing index rows, then `upsertSession.run(...)` records the CURRENT `meta.updatedAt`/`meta.bytes` fingerprint with message_count 0. Concrete scenario: an opencode/crush session whose shared SQLite db is momentarily locked by the running CLI (confirmed: node:sqlite throws 'database is locked' immediately with no busy_timeout), or a claude .jsonl hit by transient EBUSY/ENOENT. The session is now permanently absent from global search — the stale check `row.updated_at !== m.updatedAt || row.bytes !== m.bytes` matches, so it is never retried until the file changes, which for idle/completed sessions is never. This directly violates the 'search index stays consistent with what the viewer renders' invariant (the viewer would load the transcript fine on the next attempt). Note the asymmetry: a thrown error in the same loop body (caught at line 258) correctly skips the upsert and retries next pass. Fix: on `payload.error`, skip the delete/upsert entirely (leave the old rows and stale fingerprint so the next sync retries).

**Suggested fix:** Skip the delete/upsert entirely when loadTranscript reports an error, so the old rows and stale fingerprint survive and the next sync retries. In src/main/searchIndex.ts runSync, wrap the per-session transaction in a payload.error guard. Replace lines ~222-260 so the body becomes:

  try {
    const payload = await loadTranscript(meta.originalPath, meta.source, meta.id)
    if (payload.error) {
      // Transient read failure (locked db, EBUSY/ENOENT race, etc.): leave the
      // existing index rows and the old fingerprint untouched so the next sync
      // retries. Do NOT delete/upsert — that would record a current fingerprint
      // with zero messages and never re-index this idle session.
      console.warn(`[searchIndex] skipping ${meta.source}/${meta.id} (transcript error): ${payload.error}`)
    } else {
      const rows: Array<{ nodeIndex: number; kind: string; text: string }> = []
      payload.nodes.forEach((node, nodeIndex) => {
        if (node.kind !== 'user' && node.kind !== 'assistant') return
        if (node.inherited) return
        const text = node.text.trim()
        if (!text) return
        rows.push({ nodeIndex, kind: node.kind, text: text.slice(0, MAX_MESSAGE_CHARS) })
      })

      handle.exec('BEGIN')
      try {
        deleteMessages.run(key)
        for (const row of rows) insertMessage.run(key, row.nodeIndex, row.kind, row.text)
        upsertSession.run(key, meta.source, meta.id, meta.repo ?? '', meta.cwd ?? '', meta.summary ?? '',
          meta.originalPath, meta.updatedAt, meta.bytes, rows.length, Date.now())
        handle.exec('COMMIT')
      } catch (err) {
        handle.exec('ROLLBACK')
        throw err
      }
    }
  } catch (err) {
    console.warn(`[searchIndex] failed to index ${meta.source}/${meta.id}:`, (err as Error)?.message ?? err)
  }

Note: a legitimately empty transcript (no user/assistant nodes) with no error still upserts message_count 0 with the current fingerprint, which is correct (nothing to re-read). Only the payload.error case must be skipped.

(Optional, separate from this bug: the opencode/crush parsers swallow a locked-db error and return empty nodes with NO payload.error, so this guard won't cover them. If desired, have reconstructPayload/loadOpenCodePayload surface a "could not read db" error so DB-backed sources also benefit from the retry — but that is a distinct change.)

<details><summary>Verifier reasoning</summary>

CONFIRMED REAL (traced concrete failing path).

Code mechanism (searchIndex.ts:220-257) is exactly as claimed. loadTranscript (transcript.ts:84-93) never throws — on any caught I/O error it RETURNS { error, nodes: [] }. In runSync, the `if (!payload.error)` guard at line 225 only skips populating `rows`; the transaction at lines 236-253 then runs UNCONDITIONALLY: deleteMessages.run(key) wipes the session's existing index rows (line 238), no inserts happen (rows is empty), and upsertSession.run(...) (line 240) writes the CURRENT meta.updatedAt/meta.bytes fingerprint with message_count = rows.length = 0, then COMMIT. On the next runSync the stale filter (lines 196-199: `!row || row.updated_at !== m.updatedAt || row.bytes !== m.bytes`) now matches — the fingerprint is current — so the session is NEVER re-indexed until its file's updatedAt/bytes change, which for an idle/completed session never happens. The session is thus permanently absent from global search even though the viewer would load its transcript fine on a later attempt, violating the "index stays consistent with what the viewer renders" invariant. The asymmetry the reviewer notes is also real: had loadTranscript thrown, the catch at line 258 would skip the whole transaction (no delete, no upsert) and the stale fingerprint would survive for a retry — confirming the intended-but-unreached "skip on failure" behavior.

REACHABILITY — partially corrected vs. the claim:
- The claim's headline opencode/crush "database is locked -> thrown error -> payload.error" scenario is INACCURATE. Those parsers swallow locked-db errors at every level: opencode openDb() catches and returns null (opencode.ts:521); readMessagesFromSqlite wraps the query in try/catch and `continue`s on failure (opencode.ts:856), then readAllMessages falls back to readMessagesFromJson. A locked opencode db yields nodes:[] WITHOUT payload.error (a different, pre-existing parser issue), so it does not trigger THIS delete/upsert-on-error bug via payload.error.
- But the bug IS reachable on the file-based JSONL path, which is the dominant source (Claude/Codex/Pi). In loadTranscript, `fs.statSync(originalPath)` at transcript.ts:65 and again inside readJsonlRecords at transcript.ts:15 are OUTSIDE scanJsonlLines' error-swallowing try/catch. A transient EACCES/EBUSY/EIO, or an ENOENT race between fs.existsSync (line 65) and fs.statSync, throws synchronously out to the loadTranscript catch (line 84) -> { error, nodes: [] } -> triggers the unconditional delete+empty-upsert. So a concrete failing path exists for a real session; the defect is genuine even though one of the two cited triggers is wrong.

Severity: a transient, recoverable I/O blip permanently evicts a session from cross-session search with no self-healing. Major is justified.

</details>

## 2. [MAJOR] pendingJump is applied against the stale previous transcript on cross-session jumps, losing or misdirecting the jump
**File:** `/Users/weixu/dev/AgentSessionViewer/src/renderer/src/App.tsx:281-292`  ·  dimension: renderer-state

**Problem:** openSearchResult batches setPendingJump({key:B,nodeIndex:n}) and setSelected(B) into one commit. In that commit's effect pass, the transcript-load effect (line 175) only SCHEDULES setLoadingTx(true)/setTranscript(null) for the next render; the jump-apply effect (line 281) then runs in the same pass with the closure snapshot of the CURRENT render: transcript = session A's loaded payload (non-null, no error), loadingTx = false, selected = B, pendingJump.key = metaKey(B). Every guard passes, so the jump is resolved against session A's searchMatches (the global query stays in the box, so A's in-session matches are non-empty for any common term). If A happens to have a substring match at nodeIndex n — near-certain for short common queries like 'the' or 'file', since buildSearchMatches scans every node — the effect does setActiveMatchIndex(matchIdx) and setPendingJump(null), consuming the jump. When B's transcript lands, the reset effect (line 275) sets activeMatchIndex to 0 and the jump effect no longer fires (pendingJump is null): the user lands on B's FIRST in-session match (or the top) instead of the clicked node, with no flash, silently. Repro: open any session A, Cmd+Shift+F, type a common single word, click a result in a different session B whose nodeIndex collides with any of A's match node indexes. The findIndex===-1 branch only works by accident (scrollTarget survives because SessionView remounts after loading and its mount effect re-fires). Fix needs the jump effect to verify the loaded transcript actually belongs to pendingJump.key (e.g. track the metaKey the transcript was loaded for) instead of relying on loadingTx, which is stale in this effect pass.

**Suggested fix:** Track the metaKey the current transcript was actually loaded for, and gate the jump effect on it instead of the stale loadingTx.

1) Add state: const [loadedKey, setLoadedKey] = useState<string | null>(null)

2) In the load effect (App.tsx ~line 175-189), clear it on (re)load and set it when the load resolves:
   ```
   const reqId = ++reqRef.current
   setLoadingTx(true)
   setTranscript(null)
   setLoadedKey(null)            // <-- transcript no longer matches any key
   window.api.loadTranscript(selected.originalPath, selected.source, selected.id).then((tx) => {
     if (reqRef.current === reqId) {
       setTranscript(tx)
       setLoadedKey(metaKey(selected))   // <-- record what was loaded
       setLoadingTx(false)
     }
   })
   ```
   (Also set setLoadedKey(null) in the `if (!selected)` branch.)

3) In the jump effect (App.tsx line 281-292), require the loaded transcript to belong to the pending key, and add loadedKey to deps:
   ```
   useEffect(() => {
     if (!pendingJump || !transcript) return
     if (!selected || metaKey(selected) !== pendingJump.key) return
     if (loadedKey !== pendingJump.key) return   // <-- transcript is still session A's; wait for B
     if (transcript.error) { setPendingJump(null); return }
     const matchIdx = searchMatches.findIndex((m) => m.nodeIndex === pendingJump.nodeIndex)
     if (matchIdx >= 0) setActiveMatchIndex(matchIdx)
     else setScrollTarget({ index: pendingJump.nodeIndex, token: ++scrollTokenRef.current })
     setPendingJump(null)
   }, [pendingJump, transcript, loadedKey, selected, searchMatches])
   ```

Because loadedKey is nulled on every (re)load and only set to metaKey(B) once B's transcript actually arrives, the effect no longer fires against session A's payload, so the jump survives and applies to B's node n. Using a dedicated key (not transcript.originalPath/source) is required since DB-backed sources share originalPath+source across sessions.

<details><summary>Verifier reasoning</summary>

VERIFIED REAL. I traced the exact React commit/effect sequence in /Users/weixu/dev/AgentSessionViewer/src/renderer/src/App.tsx.

Setup: session A loaded (selected=A, transcript=A's payload non-null/no-error, loadingTx=false, pendingJump=null), searchScope='all', and a common query like "the" sitting in the box.

User clicks a result in session B. openSearchResult (line 341) batches into one commit: setGlobalOpen(false), setTab('session'), setPendingJump({key:metaKey(B),nodeIndex:n}), setSelected(B). Note the click handler does NOT touch transcript or loadingTx.

Render N+1 then has: selected=B, transcript=A (unchanged), loadingTx=false (unchanged), pendingJump={key:B,nodeIndex:n}. React commits, then flushes ALL passive effects in declaration order in one pass; setState calls inside those effects are batched for Render N+2 and do NOT mutate the current closure. In this pass:
- Load effect (line 175) runs (selected changed): it calls setLoadingTx(true)/setTranscript(null) — scheduled for N+2 only, invisible to the rest of this pass.
- Reset effect (line 191) runs: pendingJumpRef.current.key===metaKey(B) (the ref is set synchronously during render at line 120), so it returns early and preserves sessionSearchText="the".
- activeMatchIndex-reset (line 275) does NOT run (transcript.nodes/searchQuery unchanged since transcript is still A).
- Jump effect (line 281) RUNS (pendingJump and selected changed). Its closure: pendingJump truthy, transcript=A truthy, loadingTx=false → guard1 passes. selected=B and metaKey(B)===pendingJump.key → guard2 passes (NOT returned). transcript.error falsy → skip. searchMatches is A's memoized matches for "the" (line 248 deps only on transcript?.nodes/error/searchQuery, all still A). matchIdx = A's matches.findIndex(m=>m.nodeIndex===n).

The ONLY identity guard is metaKey(selected)!==pendingJump.key, which passes because selected is already B. There is no check that the loaded transcript belongs to B; loadingTx is the intended proxy but is stale-false in this pass. TranscriptPayload (ipc.ts) carries source/originalPath but not id, and DB-backed sources share both, so no field on transcript even exists to cross-check id.

Case A-has-match-at-n (matchIdx>=0): the effect does setActiveMatchIndex(matchIdx) and setPendingJump(null), CONSUMING the jump against the wrong session. When B's transcript later lands, line 275 resets activeMatchIndex to 0 and the jump effect no longer fires (pendingJump null). With query "the" still active in 'all' scope, activeMatch (line 252-253) = B's searchMatches[0], passed unconditionally to Viewer; SessionView's effect (SessionView.tsx line 137-140) scrolls to activeMatch.nodeIndex = B's FIRST match, not clicked node n. Silent misdirection, no flash.

Likelihood is high, not a corner case: for a common word the set of A's match-nodeIndexes is dense (most user/assistant nodes contain "the"), so P(A has a hit at index n) is large whenever n < A.nodes.length. The escape (case matchIdx===-1 → scrollTarget path landing correctly on n) only works because A happened to lack a match at n and scrollTarget survives to B's remount — exactly the "works by accident" the claim describes.

Confirmed against React 18 automatic batching (event handlers), single passive-effect flush per commit in declaration order, and the actual guards/deps in the code. The claim's diagnosis and the location of the missing transcript-identity check are correct.

</details>

## 3. [MAJOR] Codex web_search_call never receives an output, so FIFO pairing attaches later tool outputs to the wrong calls
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/export.ts:117 (with /Users/weixu/dev/AgentSessionViewer/src/main/mappers/codex.ts:111-114):117`  ·  dimension: export-fidelity

**Problem:** buildTurns pairs each tool_result with the earliest tool part whose output is undefined in the current assistant turn. The codex mapper emits web_search_call as a tool_call node but never emits a matching tool_result (codex rollouts have no function_call_output for web searches), so that part stays 'unanswered' forever. The next real tool output in the same assistant turn is then assigned to the web_search part, and every subsequent result cascades one slot off. Verified with a harness: for records [web_search_call, function_call shell, function_call_output 'CONTENTS-OF-A'], the export shows tool=web_search output="CONTENTS-OF-A" and tool=shell output=undefined. Any codex session with a web search followed by tool calls before the next user message produces a corrupted export: outputs displayed under the wrong tool name/input, and the real call rendered as unanswered.

**Suggested fix:** Make web_search_call self-contained so it never leaves an unanswered tool part. In src/main/mappers/codex.ts, emit a placeholder tool_result right after the web_search tool_call (mirroring the function_call branch):

    case 'web_search_call': {
      const query = String(p.action?.query || p.action?.queries?.[0] || '')
      b.add(i, 'tool_call', query, { role: 'assistant', toolName: 'web_search', title: 'web_search' })
      b.add(i, 'tool_result', '(web search performed)', { title: 'Tool result' })
      break
    }

This keeps the FIFO invariant in buildTurns intact (every emitted tool_call has a matching tool_result), so later results pair with the correct calls. It adds one node to the viewer's transcript for web searches, which is consistent with how other tools render and is index-aligned with loadTranscript().nodes.

Alternative (export-only, if changing the viewer node array is undesirable): in buildTurns, exclude tool parts known to be output-less from the FIFO `find` — e.g. skip parts whose name is 'web_search' when pairing — but the mapper-side fix is cleaner and keeps a single source of truth.

<details><summary>Verifier reasoning</summary>

CONFIRMED REAL via code trace + executed harness against the actual code.

Root cause: the codex mapper (src/main/mappers/codex.ts) emits a `tool_result` node immediately after every `function_call`/`custom_tool_call` whose call_id has an output (lines 95-109), so for those, a tool_call is always followed by its result in the node array. But the `web_search_call` case (lines 111-114) emits ONLY a `tool_call` node and never a matching `tool_result` — correctly so, because Codex rollouts carry the web-search results inline in the call's `action` payload and produce no `function_call_output` record (confirmed in src/main/sessions/parsers/codex.ts:564-570, which handles web_search_call standalone).

buildTurns in src/main/export.ts:117 pairs each `tool_result` with `turn.parts.find(p => p.type==='tool' && p.output===undefined)` — the EARLIEST unanswered tool part. The export comment (lines 115-116) shows the design assumes every emitted tool_call eventually gets a result (so FIFO-by-call-order holds for parallel calls). The output-less web_search part breaks that invariant: it stays unanswered forever and greedily captures the NEXT real tool output in the same assistant turn, shifting every subsequent result one slot off.

Executed harness for records [web_search_call ws1, function_call shell shell1, function_call_output shell1='CONTENTS-OF-A']:
NODES: tool_call web_search; tool_call shell; tool_result 'CONTENTS-OF-A'.
TURNS: TOOL web_search output='CONTENTS-OF-A'; TOOL shell output=undefined.

So the export shows the shell command's output under the web_search tool name/input, and the real shell call rendered as unanswered — exactly the reviewer's claim. This is reachable in any real Codex session where a web search is followed by one or more tool calls before the next user message (a common pattern). The viewer's transcript is unaffected (it renders nodes flat, not paired), but the Markdown/HTML export silently misattributes tool outputs, violating the stated export invariant.

Files: /Users/weixu/dev/AgentSessionViewer/src/main/export.ts:117 (FIFO pairing) and /Users/weixu/dev/AgentSessionViewer/src/main/mappers/codex.ts:111-114 (web_search_call emits no tool_result). Verified the fix below realigns pairing (web_search gets the placeholder, shell correctly gets 'CONTENTS-OF-A').

</details>

## 4. [MAJOR] Claude parallel tool calls are paired FIFO without tool_use_id, mis-attributing out-of-completion-order results and swapping error flags
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/export.ts:112-125:112-125`  ·  dimension: export-fidelity

**Problem:** Claude tool_result blocks carry tool_use_id in the raw record, but the mapper (src/main/mappers/claude.ts:139-146) does not put it on ViewNode, so buildTurns can only pair positionally ('earliest unanswered call'). The comment asserts results arrive in call order, but Claude Code writes each tool_result as a separate user-role record in completion order — parallel Task subagents (and other concurrent tools) routinely finish out of call order. Harness verification: with calls [Task A, Task B] and results arriving B-then-A (B errored), the export shows Task A input paired with RESULT-B and isError=true, and Task B paired with RESULT-A. The exported document attributes each subagent's output (and the failure flag) to the wrong task — silent content mis-attribution that the in-app viewer (which renders nodes sequentially without pairing) does not exhibit.

**Suggested fix:** Pair tool results by id instead of FIFO. (1) Add an optional `toolId?: string` to ViewNode (src/shared/ipc.ts) and accept it in NodeBuilder.add's `extra` pick (src/main/mappers/shared.ts). (2) In src/main/mappers/claude.ts, set it from the raw block: tool_use → `toolId: blk.id`, tool_result → `toolId: blk.tool_use_id`. (3) In buildTurns (export.ts), give the TurnPart tool variant a `toolId?` and, on tool_call, store `toolId: node.toolId`. On tool_result, prefer an id match: `const pending = (node.toolId && turn.parts.find(p => p.type==='tool' && p.toolId===node.toolId && p.output===undefined)) || turn.parts.find(p => p.type==='tool' && p.output===undefined)` — i.e. match by toolId when present, fall back to the existing FIFO for sources without ids (codex/generic). This restores correct output and isError attribution while preserving current behavior for sources that lack tool ids.

<details><summary>Verifier reasoning</summary>

VERIFIED REAL against real Claude session data (334 JSONL files, ~12,290 tool calls).

Root cause confirmed in code:
- src/main/mappers/claude.ts:132-146 — the raw tool_use block carries `id` and the raw tool_result block carries `tool_use_id` + `is_error` (confirmed block keys: tool_use ['type','id','name','input','caller']; tool_result ['tool_use_id','type','content','is_error']), but neither is propagated to the ViewNode. NodeBuilder.add (shared.ts) doesn't even accept such a field.
- src/main/export.ts:112-125 — `buildTurns` therefore pairs each tool_result with the *earliest unanswered* tool part (FIFO by position). The comment at line 115-116 asserts "results arrive in call order," which is false.

Empirical proof that Claude writes results out of call order:
- Each assistant record has exactly one tool_use block and each user record exactly one tool_result block (histograms: tool_use {1:12290}, tool_result {1:12287}). Parallel calls are thus separate consecutive records, written back in COMPLETION order.
- Within contiguous parallel batches, 37 genuine Anthropic (`toolu_*`) batches had results written in an order different from call order (plus 49 more in OpenAI-compatible `chatcmpl-tool-*` sessions).

End-to-end trace through the real pipeline (claudeNodes → buildTurns) on session c498d207 reproduced silent content mis-attribution: a WebFetch (slow, finished last) was paired with a Bash directory-listing output, and that Bash call was paired with WebFetch's "I cannot extract..." text — outputs genuinely swapped in the export.

Error-flag swap also reproduced on real data (incl. subagent agent-*.jsonl): e.g. agent-a57a979 startIdx 28 — FIFO marks Read toolu_01Nhrc as errored when toolu_01GwQZ actually failed; startIdx 84 has 6 errored Bash results all shuffled onto the wrong calls. The Markdown/HTML export thus emits the wrong tool's output under each call, and flips the Error/Output label and block--error styling — silently losing/misassigning user-visible content.

Export-specific: NodeBubble (renderer) renders each tool_call / tool_result node independently by its own kind with its own is_error-derived title, never pairing, so the in-app viewer is correct. This is purely a buildTurns regression, matching the claim exactly.

</details>

## 5. [MAJOR] HTML export feeds user/assistant text through marked with raw-HTML passthrough: script execution and angle-bracket content distortion in the exported file
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/export.ts:202-204 (md(), used at line 285):202-204, 285`  ·  dimension: export-fidelity

**Problem:** md() calls marked.parse with no sanitization, and the result is embedded verbatim in the standalone HTML file. Verified: a user message containing <script>alert(2)</script> and <img src=x onerror=alert(1)> survives byte-for-byte into the export and executes when the file is opened in a browser (file:// context). This is strictly worse than the in-app viewer: React's dangerouslySetInnerHTML never executes <script> tags, but a browser parsing the exported document does. Transcript text is not trustworthy — assistant messages quote fetched web content and tool output. Additionally, ordinary angle-bracket text that agent transcripts are full of (<system-reminder>, pasted XML/HTML outside code fences) is parsed as raw HTML: tags vanish and <script>/<style> bodies are swallowed, so the rendered export silently loses/distorts user message content. Thinking/tool blocks correctly use escapeHtml; only the 'text' parts are affected. Fix: escape or sanitize HTML in md() (e.g., a marked renderer that escapes raw html tokens, or DOMPurify-equivalent post-processing).

**Suggested fix:** Make `md()` escape raw HTML tokens so transcript angle-brackets are rendered as literal text (matching what users see) and no script/style/img is interpreted, while still rendering real Markdown. Use a marked override that escapes the `html` token type:

  import { marked, Renderer } from 'marked'

  const exportRenderer = new Renderer()
  // Inline/block raw HTML tokens (e.g. <script>, <system-reminder>, pasted XML)
  // become literal escaped text instead of live markup.
  exportRenderer.html = ({ text }: { text: string }) => escapeHtml(text)

  function md(text: string): string {
    return marked.parse(text, { async: false, renderer: exportRenderer }) as string
  }

(`escapeHtml` already exists in this file at lines 194-200.) marked's tokenizer still strips/normalizes `<` inside autolinks and code spans correctly, so fenced code and inline code continue to render. Verify the renderer hook signature against marked 18's `Tokens.HTML` shape; if `text` isn't the field name, use the token's raw HTML string. Alternatively, post-process the `md()` output with a DOMPurify-equivalent (e.g. `isomorphic-dompurify`) to strip scripts/event handlers — but escaping the html token is the lighter, dependency-free fix and also restores fidelity for the content-distortion case.

<details><summary>Verifier reasoning</summary>

CONFIRMED REAL on both halves of the claim.

Code path (all verified by reading the files, not speculation):
- export.ts:202-204 `md()` = `marked.parse(text, { async: false })` with no sanitizer. I checked: there is no global `marked.use`/`setOptions`/sanitize/DOMPurify anywhere in src/ (grep returned nothing). Installed marked is v18.0.5, whose default keeps raw HTML inline.
- export.ts:284-285 in `buildHtmlExport`: for every `part.type === 'text'`, it pushes `<div class="md">${md(part.text)}</div>` directly into the body. `part.text` comes from `buildTurns` (export.ts:95, :100), which pushes raw `node.text` of `user`/`assistant` ViewNodes — untrusted transcript content (web-fetched text, pasted XML/HTML, assistant-quoted tool output).
- index.ts:152-154: that string is written verbatim with `fs.writeFileSync(result.filePath, content, 'utf8')` to a user-chosen `.html` file and revealed in Finder. Opening it in a browser parses it as a fresh document.

Reproduced behavior with marked 18.0.5:
- Input `<script>alert(2)</script>` → output `<script>alert(2)</script>` (byte-for-byte).
- Input `<img src=x onerror=alert(1)>` → output `<img src=x onerror=alert(1)>` (byte-for-byte).
- Input containing `<style>body{display:none}</style>` and `<title>Login</title>` → emitted verbatim as real elements; opened in a browser the `<style>` rule blanks the whole exported page and `<title>` content is swallowed from the visible flow. `<system-reminder>...</system-reminder>` is emitted as an unknown element.

Script-execution escalation is genuine and strictly worse than the in-app viewer. NodeBubble.tsx:14-19 renders the same `marked.parse` output via React `dangerouslySetInnerHTML`, i.e. via `innerHTML`. Per the HTML spec, `<script>` inserted through `innerHTML` is flagged non-executing and never runs — so in the app a transcript `<script>` is inert. In the exported standalone `.html` file the `<script>` tag is part of the initial document parse (file:// load), so it DOES execute. The `<img onerror>` vector fires in both contexts, but the `<script>` vector is a real new code-execution path created by the export.

Content-distortion half is also real and independent of any security framing: ordinary angle-bracket content that agent transcripts are full of (`<system-reminder>`, pasted XML/HTML outside code fences) is parsed as raw HTML on open — tags vanish from visible text and `<style>`/`<title>`/`<script>` bodies are interpreted/swallowed, silently losing or breaking user/assistant content. This violates the stated export invariant that user/assistant content must never be lost. Thinking/tool blocks correctly use `escapeHtml` (export.ts:289, :295, :299); only the `text` parts at line 285 bypass escaping. So the defect is precisely scoped as the reviewer states.

</details>

## 6. [MAJOR] HTML export embeds unsanitized transcript HTML — script execution and silent content loss in exported files
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/export.ts:202-204, 285`  ·  dimension: integration-perf

**Problem:** buildHtmlExport renders user/assistant text parts via md() = marked.parse(), and marked passes raw inline HTML through unescaped (verified: only tool/thinking parts go through escapeHtml). Failure scenario 1 (content loss, violates 'exports must never lose user/assistant content'): an assistant message saying 'wrap it in <FilterBar> here' exports with <FilterBar> swallowed as an unknown element — the tag text disappears from the rendered HTML. Failure scenario 2 (XSS): transcript text containing <script> or <img src=x onerror=...> (agent transcripts routinely quote fetched web content/tool output into assistant text) executes when the user opens the exported file — a standalone file:// page in their default browser with no CSP, unlike the in-app NodeBubble which at least runs inside the context-isolated renderer. Markdown export is unaffected. Fix: escape or sanitize marked output (or render text parts with the same escaping as tool blocks).

**Suggested fix:** Route the text-part markdown through a Marked instance whose `html` renderer escapes raw HTML tokens, so genuine markdown still renders but embedded tags are escaped (fixes both content loss and XSS). In src/main/export.ts, replace the `md()` helper:

import { Marked } from 'marked'

const safeMarked = new Marked({
  renderer: {
    html({ text }: { text: string }): string {
      return escapeHtml(text)
    }
  }
})

function md(text: string): string {
  return safeMarked.parse(text, { async: false }) as string
}

(escapeHtml already exists at export.ts:194.) Verified against marked 18.0.5: this escapes both inline (<FilterBar>, <script>, <img>) and block-level (<div>) raw HTML while preserving bold/code/links and code-fence escaping. Output for 'wrap it in <FilterBar> here' becomes '<p>wrap it in &lt;FilterBar&gt; here</p>', so the literal text is preserved and no script executes. (The same hardening could optionally be applied to NodeBubble.tsx for defense-in-depth, though that runs in the context-isolated renderer and is out of scope for this claim.)

<details><summary>Verifier reasoning</summary>

VERIFIED REAL. Traced the full path against the actual code (export.ts, index.ts, NodeBubble.tsx) and confirmed marked's behavior empirically with the installed version (marked 18.0.5).

Technical core confirmed: In src/main/export.ts, `md()` (line 202-204) is `marked.parse(text, { async: false })` with no sanitizer. There is no global marked configuration anywhere in the repo (only two callsites: export.ts and NodeBubble.tsx, neither configures sanitization; marked's built-in `sanitize` option was removed in v0.7 and does not exist in v18). Empirical test of marked 18.0.5 with the exact options used:
- 'wrap it in <FilterBar> here' → '<p>wrap it in <FilterBar> here</p>' (raw tag passed through)
- 'text with <script>alert(1)</script> inline' → emitted verbatim
- '<img src=x onerror=alert(1)>' → emitted verbatim
marked only escapes angle brackets that don't lex as tags (e.g. 'a < b' → '&lt;') and content inside code fences, but anything that parses as an HTML tag is passed through unescaped.

Reachability confirmed:
1. md() is invoked ONLY for `part.type === 'text'`, i.e. user/assistant message text (export.ts:284-285). Thinking (line 289) and tool input/output (295,299,304) correctly use escapeHtml. So the unescaped path is exactly the user/assistant content the spec says 'exports must never lose'.
2. The output is written to a standalone .html file (index.ts:153 fs.writeFileSync) and revealed in Finder (line 154). Opening it loads a file:// page in the default browser — no CSP, no context isolation — materially different from the in-app NodeBubble, which renders inside Electron's context-isolated renderer (the claim's distinction is accurate).

Both failure modes are concrete:
- Content loss (scenario 1): an assistant message 'wrap it in <FilterBar> here' renders in the browser with <FilterBar> parsed as an unknown custom element that produces no visible text, so the token disappears. Markdown export is unaffected because buildMarkdownExport pushes part.text raw into the .md string (line 171), preserving the literal characters. This exactly matches the claim (MD safe, HTML loses content).
- XSS (scenario 2): <script>/<img onerror> in assistant text — common when agents quote fetched web pages or tool output into their replies — executes when the exported file is opened. Reachable with ordinary (non-malicious-user) data, and a fetched web page could even plant it.

This is not defensive speculation: the failing path is fully traced from transcript text → buildHtmlExport → md() → unescaped HTML → file → browser execution.

</details>

## 7. [MINOR] getSessionMeta's `?? meta` fallback defeats searchSessions' stale-row guard, attributing matches to the wrong session
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/indexer.ts:125-129`  ·  dimension: sql-index

**Problem:** searchSessions (searchIndex.ts:363-365) relies on resolveMeta returning undefined for index rows whose session vanished: `if (!meta) continue // session disappeared since indexing; sync will prune it`. But getSessionMeta ends with `return cache?.find((m) => ... m.originalPath === originalPath) ?? meta` — when the exact (source,id,originalPath) triple is gone but another session with the same source+id exists (precisely the collision case the searchIndex.ts:47-54 comment says motivated putting originalPath in the key, e.g. two subagent files whose filename-derived basenames collide across parents, such as identical `agent-<hex>.jsonl` names under different `<parentUuid>/subagents/` dirs), it returns the OTHER session's SessionMeta instead of undefined. The search result group is then displayed under the wrong session, and clicking jumps via pendingJump/scrollTarget using a node_index from a different transcript — landing on an arbitrary wrong node (SessionView only guards `index >= nodes.length`). Fix: when originalPath is provided and matches nothing, return undefined (or add a separate strict resolver for search) instead of falling back to the same-id meta.

**Suggested fix:** In src/main/indexer.ts getSessionMeta (lines 125-129): when originalPath is provided, resolve strictly and do not fall back to the same-id meta. Replace:

  export function getSessionMeta(source: string, id: string, originalPath?: string): SessionMeta | undefined {
    const meta = metaByKey.get(sessionKey(source, id))
    if (!originalPath || meta?.originalPath === originalPath) return meta
    return cache?.find((m) => m.source === source && m.id === id && m.originalPath === originalPath) ?? meta
  }

with:

  export function getSessionMeta(source: string, id: string, originalPath?: string): SessionMeta | undefined {
    const meta = metaByKey.get(sessionKey(source, id))
    if (!originalPath || meta?.originalPath === originalPath) return meta
    // originalPath given but doesn't match the by-key meta: resolve the exact
    // triple. Return undefined (not the same-id twin) when it's gone, so
    // searchSessions' stale-row guard prunes the match instead of mis-attributing it.
    return cache?.find((m) => m.source === source && m.id === id && m.originalPath === originalPath)
  }

(Dropping only the `?? meta` tail. The export caller always passes a live session's exact path, so its happy path is unaffected.)

<details><summary>Verifier reasoning</summary>

Traced the full path and the defect is real, though minor (needs a specific coincidence).

Data model: subagent ids derive from the filename basename (claude.ts:240-241: `id = subagent && info.sessionId !== fileBase ? fileBase : info.sessionId`, fileBase = `agent-<id>`). Two subagent transcripts with identical basenames under different `<parentUuid>/subagents/...` dirs therefore produce two distinct sessions that share `source+id` ('claude' + 'agent-<id>') but differ in `originalPath`. There is no dedup in indexer.ts/registry, so both live in `cache` (the array). `metaByKey` (indexer.ts:73-74) is a Map keyed by `source id`, so it collapses the pair to whichever is iterated last. The search index (searchIndex.ts:52-54) keys by `source:id:originalPath`, so it keeps both as separate rows with their own node_index values — exactly the collision the key comment cites.

Failing scenario: session A (originalPath PathA) is deleted/moved after indexing but before the next sessions:list+sync prunes it; session B (same source+id, PathB) is still live. syncSearchIndex runs in the background and only prunes during runSync, while search:query (index.ts:123-126) reads the index immediately — so a stale PathA row is returned. searchSessions (searchIndex.ts:363-365) relies on `resolveMeta` returning undefined for the vanished session (`if (!meta) continue`). But getSessionMeta('claude','agent-X',PathA) at indexer.ts:126-128: meta = metaByKey.get(...) = meta_B (B is the surviving/last-written one); PathA !== meta_B.originalPath so it falls to `cache.find(... originalPath===PathA)` which is undefined (A is gone); then `?? meta` returns meta_B. So the guard is defeated and the PathA match group is attributed to session B.

Renderer impact: openSearchResult (App.tsx:341-347) does setSelected(row.group.session = meta_B) and setPendingJump({key: metaKey(meta_B), nodeIndex: PathA_nodeIndex}). B's transcript loads, the jump fires scrollTarget={index: PathA_nodeIndex} (SessionView.tsx:144 only guards `index >= nodes.length`), so as long as PathA's node index is within B's node count it scrolls/flashes an arbitrary unrelated node. The snippet shown in the results list also belongs to the deleted A. Wrong attribution + wrong-node jump — exactly as claimed.

When both A and B are live, the `cache.find` succeeds and `?? meta` is never reached, so attribution is correct; the bug is specifically the vanished-session-with-surviving-id-twin case. The export caller (index.ts:131) always passes a just-listed session's exact path, so cache.find succeeds there and the fallback is never exercised — removing it is safe.

Severity is genuinely minor: it requires (1) a filename-basename collision across two subagent transcripts and (2) one of the colliding pair to disappear between indexing and querying. Rare, but reachable and not unreachable/defensive-only, so this is a real defect.

</details>

## 8. [MINOR] syncSearchIndex runner has no catch; the prune section runs outside any try and outside a transaction — 'database is locked' aborts the pass as an unhandled rejection and a partial prune creates a permanent un-reindexable session
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/searchIndex.ts:146-161, 176-194`  ·  dimension: sql-index

**Problem:** The async IIFE in syncSearchIndex has try/finally but no catch, and runSync's setup (the `SELECT session_key...` scan, the prune loop's `deleteMessages.run`/`deleteSession.run`, and the prepare calls at lines 205-215) is not covered by the per-session try/catch. node:sqlite has no busy_timeout configured, and a concurrent writer makes statements throw 'database is locked' immediately (verified empirically). This is a realistic scenario for this project: CLAUDE.md's documented testing workflow launches a second Electron instance of this app against the same userData, so two processes run syncSearchIndex on the same search-index.db; there is no requestSingleInstanceLock in src/main/index.ts. Consequences: (1) the whole sync pass dies as an unhandled promise rejection (logged, pass skipped until the next sessions:list); (2) worse, the per-key prune is two separate autocommit statements — if deleteMessages succeeds and deleteSession throws (or the process is force-killed between them), the sessions row survives with its old fingerprint while its messages rows are gone; since pruning happens exactly when a session transiently disappears from `metas` (e.g. an adapter hiccup, see separate finding), the session can reappear with an unchanged updatedAt/bytes fingerprint and will then never be re-indexed — a permanent silent hole in search. Fix: wrap the prune in one transaction (or delete sessions row first), add a catch around runSync, and set PRAGMA busy_timeout. Related: openDb (lines 59-76) caches `db = null` forever on any open-time error, so a transient lock during first-ever WAL creation disables search for the entire app run.

**Suggested fix:** In src/main/searchIndex.ts:

1) Set busy_timeout in migrate() (or right after open) so concurrent writers wait instead of throwing immediately:
   handle.exec('PRAGMA busy_timeout = 5000')
   handle.exec('PRAGMA journal_mode = WAL')

2) Make the prune atomic so it can never half-apply. Wrap the prune loop in one transaction (and delete the sessions row first so a survivor never outlives its messages):
   handle.exec('BEGIN')
   try {
     for (const key of known.keys()) {
       if (!liveKeys.has(key)) {
         deleteSession.run(key)
         deleteMessages.run(key)
         known.delete(key)
       }
     }
     handle.exec('COMMIT')
   } catch (err) {
     handle.exec('ROLLBACK')
     throw err
   }

3) Add a catch in the IIFE so a sync pass failure is logged, not an unhandled rejection:
   void (async () => {
     try {
       while (pendingMetas) { const batch = pendingMetas; pendingMetas = null; await runSync(batch, onProgress) }
     } catch (err) {
       console.warn('[searchIndex] sync pass failed:', (err as Error)?.message ?? err)
     } finally {
       syncRunning = false
     }
   })()

4) (Optional, defense-in-depth) In openDb, do not permanently cache db=null on a transient open error — leave db as undefined on failure so a later sessions:list can retry, e.g. set db = null only when require('node:sqlite') itself is missing, and leave db undefined for lock/IO errors.

<details><summary>Verifier reasoning</summary>

Traced and verified every link of the claim against the real code (and empirically for the lock behavior).

CONFIRMED FACTS:
1. No try/catch in IIFE: src/main/searchIndex.ts:150-160 — the async IIFE has try/finally but NO catch; the prune loop (188-194) runs OUTSIDE the per-session try (which only spans the stale loop at 220-260). No global unhandledRejection/uncaughtException handler exists anywhere in src/main.
2. Non-atomic prune: lines 186-191 run two separate autocommit statements — deleteMessages.run(key) then deleteSession.run(key) — with NO surrounding BEGIN/COMMIT. deleteMessages durably commits before deleteSession is attempted. (Contrast: the per-session reindex at 236-257 IS wrapped in BEGIN/COMMIT/ROLLBACK — the prune deliberately is not.)
3. 'database is locked' throws immediately: verified empirically with node:sqlite v25.2.1 — a concurrent writer holding BEGIN IMMEDIATE makes the second process's statements throw errcode 5 'database is locked' instantly, even under WAL. migrate() only sets journal_mode=WAL; no busy_timeout PRAGMA anywhere.
4. Concurrent writers realistic: no requestSingleInstanceLock in src/main/index.ts; the CLAUDE.md-documented testing workflow launches a 2nd Electron instance with no --user-data-dir, so both processes sync the same userData/search-index.db. syncSearchIndex is fired after every sessions:list (index.ts:115).
5. Prune trigger realistic: indexer.ts:91-99 wraps each adapter's parseSessions in catch→return [], so a transient adapter error (e.g. a sqlite/file lock) drops that whole source's sessions from `metas` for one listing; they reappear with UNCHANGED updatedAt/bytes next listing.
6. Permanence (the linchpin): the staleness check at 196-199 compares ONLY the surviving sessions-row fingerprint (updated_at/bytes) against m.updatedAt/m.bytes — it never checks whether messages rows exist. So a partial prune (deleteMessages commits, then deleteSession throws 'database is locked' OR the process is force-killed between the two statements) leaves an orphan sessions row with the old fingerprint and zero messages. On reappearance the session is judged not-stale and is NEVER re-indexed; the messages_ad FTS trigger keeps FTS consistent with the now-empty messages, so the session permanently returns zero search hits — a silent search hole.

Also confirmed the secondary point: openDb (59-76) caches db=null on any open/migrate error and line 60 (`if (db !== undefined) return db`) returns null forever for the app run, so a transient lock during first-ever WAL creation/CREATE TABLE in migrate() disables search for the whole session.

CAVEAT (why narrow, not catastrophic): consequence (1) alone — the whole pass dying as an unhandled rejection — is self-healing because the finally resets syncRunning=false and the next sessions:list retries. The severe consequence (2) requires the throw to land precisely between the two autocommit prune statements (a one-statement window) or a kill between them. That is a real but lower-frequency interleaving rather than a guaranteed failure. Still, it is a concrete, code-traceable path with permanent data consequences in the project's own documented dev workflow, so isReal=true. The proposed fixes are all correct and minimal.

</details>

## 9. [MINOR] A transient adapter failure mass-prunes that source's entire search index
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/searchIndex.ts:185-194`  ·  dimension: sql-index

**Problem:** runSync deletes every indexed session whose key is absent from the incoming `metas`, but listSessions (indexer.ts:91-99) converts a throwing adapter into an empty array by design ('one failing source can't break the rest'). One transient parseSessions failure — e.g. the opencode SQLite db locked while the opencode CLI is writing, exactly the situation node:sqlite throws on immediately — produces a listing with zero sessions for that source, and the very next sync run irreversibly deletes all of that source's messages from the FTS index. Until the next successful listing completes a full re-read and re-tokenization of every transcript for that source (which itself blocks the main process per the indexing design and can take minutes for large histories), global search silently returns no results for those sessions while reporting indexing done. Fix: have adapters/listSessions distinguish 'source failed' from 'source has zero sessions' (e.g. skip pruning keys belonging to sources that errored), or only prune keys whose source appears with at least one live session plus an explicit empty-success marker.

**Suggested fix:** Make listSessions report which sources were successfully listed, and have runSync prune only keys belonging to those sources.

In src/main/indexer.ts, capture per-source success while merging (a source "succeeded" if its parseSessions did not throw — note even a legitimately empty successful source must be included so its stale keys still get pruned):

  const okSources = new Set<SessionSource>()
  const groups = await Promise.all(
    ALL_TOOLS.map(async (name) => {
      try {
        const g = await adapters[name].parseSessions({ lightweight: true })
        okSources.add(name)
        return g
      } catch (err) {
        console.warn(`[indexer] ${name} failed:`, (err as Error)?.message ?? err)
        return [] as UnifiedSession[]
      }
    })
  )

Expose okSources to callers (e.g. store it in a module-level `lastOkSources` set and export a getter, or return it alongside metas). Then in src/main/index.ts pass it through:

  syncSearchIndex(metas, getOkSources(), sendSearchIndexProgress)

And in src/main/searchIndex.ts runSync, guard the prune so only successfully-listed sources are pruned (the source lives in its own column, so read it from `known`/sessions, not by splitting the key):

  // load source alongside key:
  // SELECT session_key, source, updated_at, bytes FROM sessions
  for (const [key, row] of known) {
    if (okSources && !okSources.has(row.source as SessionSource)) continue // source failed this pass — keep its index
    if (!liveKeys.has(key)) {
      deleteMessages.run(key)
      deleteSession.run(key)
      known.delete(key)
    }
  }

This keeps a transiently-failed source's index intact (search still works for it), and a later successful empty/normal listing for that source still prunes genuinely-deleted sessions. Optionally also avoid persisting the degraded listing to the metadata cache when any source failed, so the cached metas don't omit the failed source.

<details><summary>Verifier reasoning</summary>

REAL. The failing path traces concretely end-to-end:

1. An adapter's parseSessions throws transiently (e.g. opencode SQLite db locked while the opencode CLI writes — node:sqlite throws immediately on a locked db; but ANY transient throw from ANY adapter triggers this). listSessions (src/main/indexer.ts:91-99) catches it and returns [] for that source by design ("one failing source can't break the rest"). The merged `metas` therefore contains zero sessions for that source.

2. sessions:list (src/main/index.ts:112-116) unconditionally calls syncSearchIndex(metas, ...) with that listing.

3. runSync (src/main/searchIndex.ts:185-194) builds liveKeys = new Set(metas.map(sessionKey)). The failed source contributes no keys, so every previously-indexed key for that source satisfies `!liveKeys.has(key)` and is deleted from both `messages` (FTS rows cascade via the messages_ad delete trigger) and `sessions`. The entire source's search index is irreversibly purged.

4. Recovery is expensive and silent: once the rows are gone, the next successful listing's stale filter (searchIndex.ts:196-199) finds `known.get(key)` undefined for every session of that source, marking all of them stale, forcing a full loadTranscript() re-read + re-tokenize of every transcript (extractContext('full') for DB-backed opencode/crush). Until that completes, global search silently returns no results for those sessions, while progress still reports done:true (searchIndex.ts:267) and the viewer's session list still shows them — violating the stated invariant that the search index stays consistent with what the viewer renders.

Reachability is solid, not speculative. The refresh button calls refresh(true) → listSessions(force=true), which bypasses the metadata cache (indexer.ts:84-89 only reads cache when !force) and runs the real parseSessions, so a lock/throw at that instant directly produces the empty listing. Non-forced lists also hit the real parser whenever the metadata cache is expired (>30 min) or its path fingerprints changed — and the opencode db's mtime moving (because the CLI is writing, i.e. exactly when it's locked) invalidates those fingerprints, making cache-miss + parse-failure coincide. There is no existing signal anywhere (checked src/shared/ipc.ts, indexer.ts) distinguishing "source failed" from "source has zero sessions"; the merged metas array is flat, so runSync genuinely cannot tell the difference. The defect is correctly characterized as minor severity (transient, self-heals after a slow rebuild) but it is a real data-integrity/UX regression, not defensive speculation.

</details>

## 10. [MINOR] Per-session indexing runs as one synchronous block on the main process — giant sessions freeze all IPC for seconds during backfill
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/searchIndex.ts:236-264`  ·  dimension: sql-index

**Problem:** The `setImmediate` yield only happens BETWEEN sessions; within one session the BEGIN→N×insertMessage.run→COMMIT loop is fully synchronous, and each insert pays FTS5 tokenization of up to MAX_MESSAGE_CHARS (256 KB) of text. transcript.ts allows files up to 96 MB; a single large claude session with thousands of user/assistant nodes therefore blocks the Electron main process event loop for multiple seconds inside one transaction (on top of the synchronous JSON.parse cost loadTranscript already incurs). During that window every IPC handler stalls — transcript:load, search:query, sessions:list — so the first-launch backfill makes the app visibly hang when it hits big sessions, contradicting the 'never blocks the listing' comment in src/main/index.ts:114. Fix: chunk inserts with yields inside a session (SQLite allows committing in batches keyed by session_key, deleting first in the same pass), or move indexing to a worker thread with its own DatabaseSync handle.

**Suggested fix:** Chunk the inserts with event-loop yields inside a session instead of one monolithic transaction. SQLite lets you commit in batches keyed by session_key, deleting first in the same pass. Replace the single BEGIN→loop→COMMIT block (searchIndex.ts ~236-257) with batched commits:

```ts
const BATCH = 200 // rows per transaction; yield between batches
// delete old rows for this session up front
handle.exec('BEGIN')
deleteMessages.run(key)
handle.exec('COMMIT')

for (let i = 0; i < rows.length; i += BATCH) {
  handle.exec('BEGIN')
  try {
    for (const row of rows.slice(i, i + BATCH)) insertMessage.run(key, row.nodeIndex, row.kind, row.text)
    handle.exec('COMMIT')
  } catch (err) {
    handle.exec('ROLLBACK'); throw err
  }
  await new Promise((resolve) => setImmediate(resolve)) // let IPC handlers run
}

handle.exec('BEGIN')
upsertSession.run(key, meta.source, meta.id, meta.repo ?? '', meta.cwd ?? '', meta.summary ?? '', meta.originalPath, meta.updatedAt, meta.bytes, rows.length, Date.now())
handle.exec('COMMIT')
```

This bounds each event-loop stall to ~one BATCH of FTS5 tokenization (tens of ms) regardless of session size. (upsertSession is written last so an interrupted backfill leaves the session marked stale and is re-indexed next pass; with WAL the partial messages are harmless — the session row's absence/old fingerprint forces a redo.) A more thorough fix is to move indexing to a worker_threads worker with its own DatabaseSync handle, off the main event loop entirely.

<details><summary>Verifier reasoning</summary>

VERIFIED REAL. I traced the full path and benchmarked the actual node:sqlite/FTS5 cost.

What the code does (searchIndex.ts:220-265):
- runSync loops over stale sessions. Per session it builds `rows` from loadTranscript().nodes, then runs ONE synchronous transaction: `handle.exec('BEGIN')` → `deleteMessages.run(key)` → `for (row of rows) insertMessage.run(...)` → `upsertSession.run(...)` → `handle.exec('COMMIT')`.
- The only yield is `await new Promise(r => setImmediate(r))` at line 264, which fires BETWEEN sessions (after the COMMIT), never within the insert loop. So one session's entire transaction blocks the event loop in a single shot.

Why it blocks the main process:
- node:sqlite DatabaseSync is fully synchronous (confirmed: only call site is index.ts:115 inside the `sessions:list` handler; no worker_threads anywhere in src/main). Every .run()/.exec() runs on the Electron main event loop.
- The messages_ai AFTER INSERT trigger writes into messages_fts, so each insert pays FTS5 unicode61 tokenization synchronously.

Measured cost (node v25.2.1, same schema/tokenizer as the code) with realistic high-cardinality (unique-token) text like real code/chat transcripts:
- 3000 × 2KB messages -> 225 ms
- 1000 × 64KB messages -> ~2.5 s
- 500 × 256KB messages (the MAX_MESSAGE_CHARS cap) -> ~6 s
(Low-cardinality/repetitive text is much cheaper — ~0.9s for 1000×256KB — because FTS5 dedupes tokens per doc, but real transcripts are high-cardinality.)

Feasibility of the scenario:
- transcript.ts MAX_BYTES = 96 MB; MAX_MESSAGE_CHARS caps per-message text at 256 KB but there is NO cap on message count. A single large Claude session with hundreds/thousands of sizable user/assistant nodes (pasted logs, long code/diffs, big tool-free assistant prose) easily lands in the multi-hundred-MB-of-indexed-text range.
- First launch: App.tsx mount (line 134-136) → refresh(false) → window.api.list() → sessions:list IPC → syncSearchIndex(metas). Index is empty, so EVERY session is stale and backfilled. Hitting a big session blocks the loop for seconds.

During that window, transcript:load (index.ts:119), search:query (123), and a subsequent sessions:list (112) all stall, so the user sees the app hang when they click a session or type a search mid-backfill — directly contradicting the "never blocks the listing" comment at index.ts:114 (true only for the immediate return; false for concurrent IPC during sync).

Severity is correctly 'minor': it's a one-time/incremental background backfill, per-message text is capped, and incremental syncs only touch changed sessions. But the multi-second main-process stall on big sessions is genuine, not speculative — I reproduced the blocking cost.

</details>

## 11. [MINOR] Stale scrollTarget re-fires on SessionView remount: switching JSON tab and back jumps the transcript back to the old global-search target
**File:** `/Users/weixu/dev/AgentSessionViewer/src/renderer/src/components/SessionView.tsx:143-149 (with App.tsx 193 the only clear site)`  ·  dimension: renderer-state

**Problem:** App never clears scrollTarget after SessionView consumes it — it is only nulled on session change (App.tsx line 193). SessionView's scroll effect depends on [scrollTarget?.token] but effects always run on mount, and Viewer unmounts/remounts SessionView whenever tab toggles between 'session' and 'json'. Repro: in All scope search a multi-word query (FTS5 matches tokens anywhere, while buildSearchMatches needs the literal substring, so findIndex returns -1 and the scrollTarget path is taken), click a result — you land on the node with a flash. Scroll elsewhere to read, click the JSON tab, then click Session again: SessionView remounts, the mount run of the scrollTarget effect re-executes jumpToIndex(scrollTarget.index) and re-flashes the old target, yanking the user away from where they were reading. App should clear scrollTarget once consumed (e.g. an onConsumed callback or clearing it alongside the flash timeout), or SessionView should record the last-handled token.

**Suggested fix:** Have App clear scrollTarget once SessionView consumes it, via an onConsumed callback (parent state survives the tab-toggle remount, so this is robust).

In SessionView, add the prop and call it after the jump:

  interface Props {
    ...
    scrollTarget?: { index: number; token: number } | null
    onScrollTargetConsumed?: () => void   // NEW
  }

  useEffect(() => {
    if (!scrollTarget || scrollTarget.index >= nodes.length) return
    jumpToIndex(scrollTarget.index, 'center')
    setFlashIndex(scrollTarget.index)
    onScrollTargetConsumed?.()            // NEW: tell App it's handled
    const timer = window.setTimeout(() => setFlashIndex(null), 1800)
    return () => window.clearTimeout(timer)
  }, [scrollTarget?.token])

Thread it through Viewer (add onScrollTargetConsumed to Props and pass to <SessionView .../>), and in App pass:

  onScrollTargetConsumed={() => setScrollTarget(null)}

Now scrollTarget is nulled the first time it is applied, so the SessionView remount on tab switch-back sees a null prop and the effect early-returns (no stale re-jump/flash). The token-bumping in App.tsx:290 still retriggers genuinely new same-index jumps.

(Alternative, equivalent: in App, clear scrollTarget alongside the flash lifetime, e.g. setScrollTarget(null) right after setting it once the jump has been issued — but the onConsumed callback is cleaner because it ties the clear to the actual consumption rather than a guessed delay.)

<details><summary>Verifier reasoning</summary>

Confirmed REAL by tracing the actual code.

Structural facts (verified):
- App.tsx owns `scrollTarget` state and clears it (`setScrollTarget(null)`) at ONLY one site, App.tsx:193, inside the effect keyed on `[selected?.source, selected?.id]` — i.e. only on session change. Tab toggling does not change `selected`, so scrollTarget stays at its old non-null value across a JSON→Session toggle. (grep confirms the only setScrollTarget calls are line 193 reset and line 290 set.)
- Viewer.tsx:222 renders `tab === 'session' ? <SessionView .../> : <JsonView .../>` — a ternary at the same JSX position with no shared key. Switching `tab` between 'session' and 'json' (buttons at App.tsx:662/666 → setTab) genuinely unmounts SessionView and remounts a fresh instance on switch-back.
- SessionView.tsx:143-149 is the scrollTarget effect with deps `[scrollTarget?.token]`. On a fresh mount React runs every effect regardless of the dep array (dep comparison only gates re-runs of a continuously-mounted instance; a remounted instance has no prior deps to compare, so the mount run always executes). So on remount, with scrollTarget still non-null, it re-runs jumpToIndex(scrollTarget.index, 'center') + re-flash.

The multi-word premise in the claim is valid and correctly explains how the scrollTarget branch (vs the activeMatch branch) is reached: App.tsx:288 does `searchMatches.findIndex(m => m.nodeIndex === pendingJump.nodeIndex)`, and searchMatches comes from buildSearchMatches (App.tsx:71-82) which uses `lower.indexOf(query)` (countPartMatches line 61) — a literal contiguous-substring match of the full query. The FTS5 global index matches tokens independently/anywhere, so a multi-word query (e.g. tokens that never appear adjacent in the target node) yields findIndex === -1, taking the `else setScrollTarget(...)` path at line 290. (Any query whose tokens don't form a contiguous substring in the matched node hits this path; multi-word is just the clearest trigger.)

Concrete failing path: All-scope multi-word search → click result → openSearchResult sets pendingJump + selects session → pendingJump effect (281-292) finds no literal substring → setScrollTarget({index, token}) → SessionView jumps+flashes; scrollTarget remains non-null in App. User scrolls away. Click JSON tab (SessionView unmounts, its 1800ms flash timer cleanup fires). Click Session tab → SessionView remounts → the 143-149 effect runs on mount with the stale non-null scrollTarget → jumpToIndex re-fires + re-flash, yanking the user back to the old target. This is user-observable misbehavior, not defensive speculation.

Note: a fix placed inside SessionView via a "last-handled token" ref would NOT work, because the ref is reset on remount (fresh instance), so it would still re-fire. The fix must clear/own the consumption in App (the parent that survives the remount).

</details>

## 12. [MINOR] Clicking a global search result that maps to the already-active in-session match does nothing (no re-scroll)
**File:** `/Users/weixu/dev/AgentSessionViewer/src/renderer/src/App.tsx:288-289`  ·  dimension: renderer-state

**Problem:** The matchIdx >= 0 branch of the jump effect uses plain setActiveMatchIndex(matchIdx) with no token semantics (unlike the scrollTarget branch, which bumps scrollTokenRef precisely to allow same-index re-jumps). If activeMatchIndex already equals matchIdx, the state doesn't change, no re-render happens, and SessionView's activeMatch effect (deps [activeMatch?.nodeIndex, ...]) never re-fires. Concrete repro: with session B open in All scope, typing the query already drives activeMatch to match 0 and centers it; the user scrolls away, reopens the overlay (focusing the input reopens it since text is non-empty) and clicks the result row corresponding to that same first match — the overlay closes and nothing scrolls. Same for clicking any result row twice in a row within the open session. The activeMatchIndex path needs the same one-shot token treatment as scrollTarget, or should fall back to setScrollTarget when the index is unchanged.

**Suggested fix:** Give the matched-index branch the same one-shot guarantee as the scrollTarget branch by always issuing a token-bumped scrollTarget to the resolved node, in addition to setting the active match index (so highlighting stays correct). In App.tsx replace lines 288-290:

```ts
const matchIdx = searchMatches.findIndex((m) => m.nodeIndex === pendingJump.nodeIndex)
if (matchIdx >= 0) setActiveMatchIndex(matchIdx)
else setScrollTarget({ index: pendingJump.nodeIndex, token: ++scrollTokenRef.current })
```

with:

```ts
const matchIdx = searchMatches.findIndex((m) => m.nodeIndex === pendingJump.nodeIndex)
if (matchIdx >= 0) setActiveMatchIndex(matchIdx)
// Always issue a one-shot scroll so a jump to the already-active match still
// re-centers (setActiveMatchIndex no-ops when the index is unchanged, which
// would otherwise skip SessionView's activeMatch scroll effect).
setScrollTarget({ index: pendingJump.nodeIndex, token: ++scrollTokenRef.current })
```

This guarantees a re-scroll on every jump regardless of whether activeMatchIndex changed, mirroring the existing token semantics. (The two scroll effects in SessionView both call jumpToIndex(..., 'center') for the same node, which is idempotent.)

<details><summary>Verifier reasoning</summary>

CONFIRMED REAL by tracing the code.

The jump effect (App.tsx:281-292):
```
const matchIdx = searchMatches.findIndex((m) => m.nodeIndex === pendingJump.nodeIndex)
if (matchIdx >= 0) setActiveMatchIndex(matchIdx)
else setScrollTarget({ index: pendingJump.nodeIndex, token: ++scrollTokenRef.current })
setPendingJump(null)
```

The `else` (scrollTarget) branch bumps a monotonic token, and SessionView's scroll effect keys on `[scrollTarget?.token]` (SessionView.tsx:149), so it always re-fires even for the same index. The `matchIdx >= 0` branch has no such mechanism: it relies solely on `setActiveMatchIndex(matchIdx)`. When `activeMatchIndex` already equals `matchIdx`, React bails out of the state update — no re-render — so `activeMatch` (= `searchMatches[Math.min(activeMatchIndex, len-1)]`, App.tsx:252-253) keeps the same reference and same `nodeIndex`. SessionView's active-match scroll effect has deps `[activeMatch?.nodeIndex, jumpToIndex, searchQuery]` (SessionView.tsx:137-140), none of which changed, so it never re-fires and no re-scroll occurs.

Reachability is concrete and the scenario is realistic, not speculative:

1) "Click the same result row twice (with a scroll between)" — needs no special alignment. First click sets activeMatchIndex=k and scrolls. User scrolls away. Second click on the SAME row sets pendingJump again; the jump effect computes the same matchIdx=k; setActiveMatchIndex(k) is a no-op; activeMatch is unchanged; SessionView does not re-scroll. The overlay can be reopened between clicks because onFocus reopens it while sessionSearchText is non-empty (App.tsx:548-551), and the pointerdown-outside handler (App.tsx:360-370) closes it when the user interacts with the transcript.

2) The claim's match-0 variant also holds: in All scope, typing the query still computes in-session `searchMatches` (App.tsx:248-251 depends only on transcript + searchQuery, not scope) and auto-centers match 0 via SessionView's activeMatch effect. searchIndex.ts:366 sorts each session's result matches by ascending nodeIndex, and buildSearchMatches (App.tsx:71-82) also yields the lowest-nodeIndex hit first, so the first global result row for the open session commonly maps to the same node as in-session match 0 (activeMatchIndex already 0). Clicking it is a no-op for the same reason.

The `else` branch was deliberately given one-shot token semantics ("`token` retriggers same-index jumps", SessionView.tsx:22) precisely to avoid this no-re-render trap; the `matchIdx >= 0` branch was not given the equivalent treatment. This is a real same-index re-jump failure, severity minor (cosmetic: highlight stays correct, only the scroll-to-center is skipped).

</details>

## 13. [MINOR] Typing a global-scope query live-scrolls the open transcript on every keystroke
**File:** `/Users/weixu/dev/AgentSessionViewer/src/renderer/src/App.tsx:721-724 (searchQuery/activeMatch passed to Viewer regardless of scope); SessionView.tsx 137-140`  ·  dimension: renderer-state

**Problem:** sessionSearchText feeds both the global query and the in-session find unconditionally: searchQuery, searchHitsByNode and activeMatch are passed to Viewer/SessionView even when searchScope is 'all'/'project'. SessionView's effect [activeMatch?.nodeIndex, jumpToIndex, searchQuery] re-runs on every keystroke (searchQuery changes each time), calling jumpToIndex(...,'center'). Repro: open a long session, press Cmd+Shift+F, start typing a cross-session query — the transcript behind the overlay repeatedly recenters itself on its first local match while the user is still composing the global query, losing their reading position before they ever pick a result. Highlights surviving a jump is the stated intent, but the auto-scroll-as-you-type behavior of find-in-session should be suppressed while scope is not 'session' (e.g. pass activeMatch only when searchScope === 'session' or after a jump landed).

**Suggested fix:** Suppress in-session find matches while the user is composing a global query (overlay open in non-session scope), but keep them for normal in-session search and after a global jump lands. In App.tsx, gate the derived searchQuery on whether the in-session find is actually active:

  // In-session find is "active" for session scope, or after a global jump landed
  // (overlay closed) so the highlight/center survives. Suppress it while composing
  // a global query so each keystroke doesn't recenter the transcript behind the overlay.
  const inSessionFindActive = searchScope === 'session' || !globalOpen
  const searchQuery = inSessionFindActive ? sessionSearchText.trim() : ''

searchMatches/activeMatch/searchHitsByNode already key off searchQuery (App.tsx:248-262), so they collapse to empty while composing, and SessionView's effect (137-140) bails on the empty searchQuery — no auto-scroll. When openSearchResult sets globalOpen=false (App.tsx:344), searchQuery becomes non-empty again and the jumped node centers + highlights as intended. (Equivalently, gate the props at App.tsx:721-724: pass searchQuery=''/activeMatch=null/empty hits when `searchScope !== 'session' && globalOpen`.)

<details><summary>Verifier reasoning</summary>

CONFIRMED REAL. Traced the exact path:

1. One input drives both modes. The toolbar input (App.tsx:544-566) has value={sessionSearchText} and its onChange sets setSessionSearchText(...) regardless of scope. So while typing a cross-session query in 'all'/'project' scope, sessionSearchText (and thus searchQuery = sessionSearchText.trim(), App.tsx:247) holds the global query.

2. In-session match state is computed unconditionally from the open transcript. searchMatches = buildSearchMatches(transcript.nodes, searchQuery) (App.tsx:248-251) and activeMatch = searchMatches[...] (App.tsx:253) are derived from the CURRENTLY OPEN session's nodes against searchQuery, with no scope guard. When the typed substring occurs in the open transcript (very common for short prefixes like "the"/"import"/"function" in a long session), searchMatches is non-empty and activeMatch is non-null.

3. Props passed to Viewer/SessionView with no scope gate (App.tsx:721-724 -> Viewer.tsx:225-227 -> SessionView). searchQuery, searchHitsByNode, activeMatch are forwarded straight through even when searchScope is 'all'/'project'.

4. Pre-existing auto-scroll effect re-fires every keystroke. SessionView.tsx:137-140:
   useEffect(() => { if (!activeMatch || !searchQuery) return; jumpToIndex(activeMatch.nodeIndex,'center') }, [activeMatch?.nodeIndex, jumpToIndex, searchQuery])
   The dep array includes searchQuery, which changes on every keystroke, so the effect re-runs each keystroke; the guard only checks activeMatch+searchQuery (no scope), and jumpToIndex(...,'center') (SessionView.tsx:101-124) sets parentRef.scrollTop, recentering the transcript. As more characters are typed, activeMatch.nodeIndex also shifts to whatever the new substring matches, so the transcript repeatedly recenters.

5. SessionView stays mounted during global typing. The GlobalSearch overlay (App.tsx:648-659) is an absolutely-positioned dropdown inside findWrap; the main <Viewer> (713-729) is always rendered, and Viewer renders SessionView when tab==='session' (Viewer.tsx:222-223). Cmd+Shift+F (App.tsx:375-389) sets scope 'all' + opens overlay but does NOT change tab; onChange in global scope also leaves tab untouched. So if the Session tab is active (the natural state when reading a long session) the effect is live.

Repro confirmed: open a long session on the Session tab, Cmd+Shift+F, start typing a query whose growing prefix matches text in the open transcript -> the transcript behind the overlay recenters on its first/changing local match on each keystroke, losing the user's reading position before they pick a result.

Note on scope of the regression: the auto-scroll effect itself (SessionView.tsx:137-140) is PRE-EXISTING (the diff `git show HEAD -- SessionView.tsx` only adds scrollTarget/flashIndex, not this effect). What this feature commit introduced is routing the GLOBAL query through the same sessionSearchText and passing the resulting in-session activeMatch/searchQuery down unconditionally — turning the intended in-session find behavior into an unwanted side effect during global composition.

Why a naive fix is wrong: after a global jump (openSearchResult, App.tsx:341-350), the post-jump-highlight path deliberately sets activeMatchIndex (App.tsx:288-289) so the same SessionView effect centers + highlights the jumped node — the stated intent (App.tsx:194-195). At that point scope is still 'all' but globalOpen is false. So gating activeMatch/searchQuery on `searchScope === 'session'` would break global jump-to-node centering and post-jump highlight. The correct discriminator is the overlay-open state (globalOpen): suppress in-session matches only WHILE composing in non-session scope (overlay open); restore them once a result is opened (globalOpen flips false, App.tsx:344).

</details>

## 14. [MINOR] Late global-search response resurrects cleared results: the clear branches never bump globalReqRef
**File:** `/Users/weixu/dev/AgentSessionViewer/src/renderer/src/App.tsx:310-334`  ·  dimension: renderer-state

**Problem:** The stale-response guard (globalReqRef.current !== reqId) only protects against a NEWER request superseding an older one. The two early-return branches — scope switched to 'session', or query trimmed below 2 chars — call setGlobalResults(null) but do not increment globalReqRef, so an already-dispatched window.api.searchSessions promise (timer fired before the change) still passes the guard when it resolves and re-populates globalResults/activeResultIndex after they were cleared. Repro: in All scope type 'ab' and wait >250ms so the IPC call is in flight (slow on first query while indexing), then backspace to 'a' — results are cleared, the overlay shows 'Type at least 2 characters', but when the stale response lands flatRows silently refill with the 'ab' results. Pressing Enter then calls openSearchResult on flatRows[0], jumping to a result the overlay never displays (the tooShort branch hides the list). Both clear branches should bump globalReqRef.current (or set it to a sentinel) to invalidate in-flight requests.

**Suggested fix:** Bump `globalReqRef.current` in both early-return clear branches so any in-flight request is invalidated by the staleness guard. In App.tsx:310-321:

  useEffect(() => {
    if (searchScope === 'session') {
      globalReqRef.current++ // invalidate any in-flight global request
      setGlobalResults(null)
      setGlobalLoading(false)
      return
    }
    const q = sessionSearchText.trim()
    if (q.length < 2) {
      globalReqRef.current++ // invalidate any in-flight global request
      setGlobalResults(null)
      setGlobalLoading(false)
      return
    }
    ...

Now when the dispatched `searchSessions('ab')` promise resolves, its captured `reqId` no longer equals `globalReqRef.current`, so the guard (line 326) bails and the cleared results stay cleared. This only changes the staleness counter (a ref, no re-render); the next valid query still computes a fresh unique `++globalReqRef.current`.

<details><summary>Verifier reasoning</summary>

Traced the effect at /Users/weixu/dev/AgentSessionViewer/src/renderer/src/App.tsx:310-334 against the exact repro.

The only staleness guard on the in-flight IPC response is `if (globalReqRef.current !== reqId) return` (line 326). `globalReqRef.current` is incremented ONLY on the success path (line 323, `++globalReqRef.current`), never in the two early-return clear branches (scope==='session' at 311-314, or `q.length < 2` at 317-320). Both clear branches call `setGlobalResults(null)` and bare `return`.

Concrete failing path (All scope, type 'ab', pause >250ms, backspace to 'a'):
1. Typing 'ab' runs the effect: reqId = globalReqRef.current = 1, schedules the 250ms timer.
2. Timer fires -> `window.api.searchSessions('ab', ...)` promise is in-flight; globalReqRef.current still 1.
3. Backspace to 'a': React runs cleanup `clearTimeout(timer)` (no-op, already fired), then the effect body hits `q.length < 2`, calls `setGlobalResults(null)`/`setGlobalLoading(false)` and returns WITHOUT bumping globalReqRef. globalReqRef.current stays 1.
4. In-flight promise resolves -> guard `globalReqRef.current(1) !== reqId(1)` is false, so it does NOT bail. It runs `setGlobalResults(res)` (the 'ab' results), `setGlobalLoading(false)`, `setActiveResultIndex(0)`.

User-visible consequences both confirmed:
- The overlay shows "Type at least 2 characters" because GlobalSearch.tsx:56-65 derives `tooShort` from the `query` prop (= `searchQuery` = `sessionSearchText.trim()` = 'a', App.tsx:247/652), hiding the result list regardless of `response`.
- But `flatRows` (App.tsx:336-339) recomputes from the now-repopulated `globalResults` and refills with the 'ab' rows. Pressing Enter (onSearchKeyDown, App.tsx:407-414, globalOpen still true via the onChange handler at 555) reads `flatRows[0]` and calls `openSearchResult`, jumping to a result the overlay never displayed.

The asymmetry is exactly as claimed: a newer valid query DOES `++globalReqRef.current` (line 323) and so invalidates older reqIds, but the two clear branches don't, so an already-dispatched promise resurrects cleared results. The 250ms-elapsed assumption is naturally satisfied by a type-pause-refine flow, and the IPC round-trip (renderer->main->SQLite, slower on a cold/background-syncing index) reliably leaves the promise pending across the synchronous keystroke handling. Bug is minor (cosmetic + a surprising jump) but real and reproducible.

</details>

## 15. [MINOR] Selecting any session in the sidebar wipes an in-progress global query
**File:** `/Users/weixu/dev/AgentSessionViewer/src/renderer/src/App.tsx:191-199`  ·  dimension: renderer-state

**Problem:** The session-change effect clears sessionSearchText unless arriving via a pendingJump whose key matches the new selection. That rule is correct for the session-scoped find (pre-existing behavior), but it now also runs while searchScope is 'all'/'project', where the query is by definition cross-session. Repro: press Cmd+Shift+F, type a query, see results; then click any session row in the sidebar (e.g. to peek at it, or to establish project context before narrowing scope) — sessionSearchText is reset to '', the query effect sees q.length < 2 and nulls globalResults, and the overlay/query the user was working with is gone. The clear of sessionSearchText/activeMatchIndex should be conditional on searchScope === 'session' (scrollTarget/pendingJump clearing can stay unconditional).

**Suggested fix:** Gate the query/match-index reset on session scope, leaving the jump/scroll clears unconditional. In src/renderer/src/App.tsx, change the effect at lines 191-199 to:

  useEffect(() => {
    setTab('session')
    setScrollTarget(null)
    // Arriving via a global-search jump keeps the query so highlights survive.
    if (selected && pendingJumpRef.current?.key === metaKey(selected)) return
    setPendingJump(null) // navigating elsewhere voids any queued jump
    if (searchScope === 'session') {
      // Only the find-in-session query is transcript-bound; a cross-session
      // (project/all) query must survive selecting a different session.
      setSessionSearchText('')
      setActiveMatchIndex(0)
    }
  }, [selected?.source, selected?.id])

Add `searchScope` to the dependency array (or accept the stale-closure read since searchScope rarely changes between selections; adding it to deps is cleaner). This preserves the global query/overlay when peeking at a session in the sidebar while keeping scrollTarget/pendingJump clearing and the pre-existing session-scoped clear intact.

<details><summary>Verifier reasoning</summary>

VERIFIED REAL. Traced the exact scenario against src/renderer/src/App.tsx and components/GlobalSearch.tsx.

Setup: The toolbar search `<input>` is bound to `value={sessionSearchText}` for ALL scopes (line 546). In global scope it doubles as the cross-session query: `onChange` calls `setSessionSearchText(...)` regardless of scope (line 553), and the global-search effect (lines 310-334) reads `sessionSearchText.trim()` as its query.

Failing path:
1. Cmd+Shift+F → `setSearchScope('all')`, `setGlobalOpen(true)` (lines 376-379).
2. User types a query → `sessionSearchText` populated; effect at 310-334 fires `searchSessions`, sets `globalResults`; GlobalSearch overlay shows snippets.
3. User clicks a sidebar row → `onSelect={setSelected}` (line 702) → `setSelected(row.session)`. This is the ONLY thing that path does; nothing resets `searchScope` or `globalOpen` (confirmed via grep).
4. Session-change effect (lines 191-199) runs. `pendingJumpRef.current` is null (no jump was queued — user typed+clicked, never opened a result), so the guard `if (selected && pendingJumpRef.current?.key === metaKey(selected)) return` is false and does NOT early-return.
5. `setSessionSearchText('')` executes (line 197), wiping the query text.
6. With `sessionSearchText === ''`, the global-search effect re-runs (it depends on `sessionSearchText`), hits `q.length < 2`, and calls `setGlobalResults(null)` (line 318-319).
7. `searchScope`/`globalOpen` are untouched, so the overlay stays mounted (line 648: `searchScope !== 'session' && globalOpen`) but now `query=''` and `response=null`; GlobalSearch renders `tooShort` body: "Type at least 2 characters to search all sessions." (GlobalSearch.tsx lines 56,64-65). The user's in-progress cross-session query and results are gone.

The clear is correct for the pre-existing find-in-session case (scope 'session': `sessionSearchText` IS transcript-bound), but wrong for cross-session scope. Distinguishing the legit jump-from-result path: `openSearchResult` (lines 341-350) sets `pendingJump` BEFORE `setSelected`, so the guard early-returns and preserves the text — that path is unaffected by the fix because it returns before reaching the clear lines. `activeMatchIndex` is also reset by the dedicated effect at lines 275-277 on transcript change, so gating its reset in this effect causes no stale-index regression. `setScrollTarget(null)` (line 193) and `setPendingJump(null)` (line 196) must stay unconditional. The bug is a genuine, user-reachable data-loss-of-in-flight-query defect; severity minor as the user can retype.

</details>

## 16. [MINOR] Claude user-pasted images and Pi 'custom' records are emitted as tool_result and get mis-routed into assistant turns / steal pending tool-call output slots
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/export.ts:113-123 (with src/main/mappers/claude.ts:147-148 and src/main/mappers/pi.ts:26-34):113-123`  ·  dimension: export-fidelity

**Problem:** buildTurns assumes every tool_result node answers a tool call, but two mappers emit tool_result for things that are not call answers: (1) claude maps an 'image' content block in a user message to kind tool_result title 'Image' — a user's pasted screenshot is exported inside an assistant turn as a tool block ('[image]'), mis-attributed to the assistant, and if it lands while the current assistant turn still has an unanswered call it fills that call's output; (2) pi maps type:'custom' records to tool_result with an arbitrary title — a custom event between a toolCall and its toolResult steals the call's output slot and shifts the real result to a standalone block. Content is not lost but attribution is wrong; the viewer renders these sequentially and is unaffected.

**Suggested fix:** Make buildTurns stop treating non-answer tool_result nodes as assistant-side tool answers. The reliable discriminator already present: a real tool answer carries `node.role === 'user'` (Claude, set at claude.ts:143) or a `node.toolName` (Pi tool results), whereas the Claude image node has role undefined + title 'Image' + no toolName, and the Pi custom node has no toolName. Minimal export-local fix in export.ts, case 'tool_result':

  case 'tool_result': {
    const isToolAnswer = node.role === 'user' || !!node.toolName
    if (!isToolAnswer) {
      // user-pasted image / pi custom event — not a tool-call output.
      // Route to a user turn as text so attribution stays correct and no slot is stolen.
      open('user').parts.push({ type: 'text', text: node.text })
      break
    }
    const turn = open('assistant')
    const isError = node.title === 'Tool error'
    const pending = turn.parts.find((p): p is TurnPart & { type: 'tool' } => p.type === 'tool' && p.output === undefined)
    if (pending) { pending.output = node.text; pending.isError = isError }
    else { turn.parts.push({ type: 'tool', name: node.toolName || node.title || 'tool result', input: '', output: node.text, isError }) }
    break
  }

(Note: real Pi tool results set toolName; Pi tool errors use title 'Tool error' but msg.isError path still carries toolName, so the `!!node.toolName` check holds. If any error path lacks toolName, also OR `node.title === 'Tool error'` into isToolAnswer.) A cleaner root-cause alternative is to stop overloading kind 'tool_result' in the two mappers — emit the pasted image as a user node and the pi custom event as a meta node — but that touches viewer rendering, so the export-local guard above is the safer minimal change.

<details><summary>Verifier reasoning</summary>

I verified against the actual code and 338 real Claude session files.

WHAT'S CONFIRMED REAL (the mis-attribution half):
- claude.ts:147-148 maps a top-level `image` content block to `kind: 'tool_result'`, `title: 'Image'`, with NO role set. These are user-pasted screenshots (the block lives in a `role: user` message — verified: all 82 image records in real data are role=user).
- buildTurns (export.ts:112-125) ignores node.role and unconditionally does `open('assistant')` for every tool_result, then either fills a pending call slot or pushes a standalone tool block.
- Real-data structure: 69/82 pasted-image records are `[image, text]` and 13/82 are `[image]` only. claudeNodes emits them as `[tool_result(Image, role=undef), user(text)]` (same rawIndex). Tracing buildTurns: the image node gets appended to the PREVIOUS assistant turn as a tool block named "Image" with output "[image]", while the user's accompanying text starts a fresh user turn. For the 13 pure-image messages the entire user message is swallowed into the prior assistant turn and NO user turn is produced for it. So a user's image content is exported attributed to the assistant — exactly the defect claimed, and the export claims to preserve user/assistant content with correct attribution. This is reachable, common, and user-visible.

WHAT'S NOT REAL (the headline "steal pending tool-call output slot" half — for Claude):
- Empirically, 0/82 image records co-occur with a tool_result block in the same record (imageWithToolResult=0), and 0 image records immediately follow an assistant tool_use record (pendingCallScenario=0). Images that ARE tool outputs (108 cases) are nested inside tool_result.content and handled by toolResultText() returning "[image]" text — they hit case 'tool_result', not case 'image', and correctly fill the slot. So a Claude pasted image never lands while a tool call is pending; it cannot steal a slot. That specific sub-claim is unreachable for Claude.

PI HALF: pi.ts:26-34 does emit type:'custom' as tool_result with an arbitrary title and no toolName, and the scenario-2 trace confirms a custom record between a toolCall and toolResult would steal the slot. But there's no Pi data on this machine to confirm, and custom (extension/UI) events realistically sit between turns, not mid-tool-call (a call and its result are adjacent records). So the Pi slot-steal is plausible-but-speculative, not proven.

Net: the claim is REAL because its mis-attribution component is concretely reachable and proven (user image content rendered inside/attributed to the assistant; pure-image user turns lost as standalone turns). The slot-stealing framing overstates it (unreachable for Claude, unproven for Pi), but a genuine user-visible export defect exists.

</details>

## 17. [MINOR] opencode and codex tool errors are exported as 'Output' instead of 'Error'
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/export.ts:114 (with src/main/mappers/opencode.ts:263 and src/main/mappers/codex.ts:98):114`  ·  dimension: export-fidelity

**Problem:** buildTurns detects errors only via node.title === 'Tool error'. The claude and pi mappers use exactly that title, but the opencode mapper titles error results `${toolName} error` (e.g. 'bash error') and the codex mapper always uses 'Tool result' even for failed calls. In exports of opencode (and codex) sessions, failed tool runs are labeled '**Output:**' in markdown and lose the block--error styling/'Error' label in HTML, misrepresenting failures as successes. The in-app viewer shows the original titles, so the export diverges from what the viewer renders.

**Suggested fix:** Make buildTurns' error detection match the per-source title conventions instead of only the claude/pi literal. In src/main/export.ts:114 (and the same logic should cover the fallback-push at line 122), replace:

  const isError = node.title === 'Tool error'

with a check that also catches the opencode `"<tool> error"` form, e.g.:

  const t = node.title ?? ''
  const isError = t === 'Tool error' || /\berror$/iu.test(t)

This keeps the existing claude/pi behavior (exact 'Tool error') and additionally flags opencode's `${toolName} error` titles (e.g. 'bash error') as errors, so failed opencode tool runs export under '**Error:**' / the `block--error` HTML styling. (Codex is unaffected — it emits no error signal at all, so no export change is possible there without first teaching codex.ts to mark failed function_call_output as errors.)

<details><summary>Verifier reasoning</summary>

REAL for opencode (the headline case). Verified by reading the actual code:

1. export.ts:114 (buildTurns, tool_result case): `const isError = node.title === 'Tool error'` — an exact-string match. This flows into `pending.isError`/the pushed tool part, and downstream selects the label: markdown export.ts:179 `**${part.isError ? 'Error' : 'Output'}:**`, HTML export.ts:299 `${part.isError ? 'Error' : 'Output'}` plus export.ts:304 the `block--error` class (which the CSS at export.ts:252 colors red).

2. opencode.ts:259-263: a genuinely failed tool (toolResultFromState returns `isError:true` when `state.status === 'error'`, line 208) is emitted as a tool_result node with `title: `${toolName} error`` (e.g. `"bash error"`). In buildTurns, `"bash error" === 'Tool error'` is FALSE, so isError stays false. A real opencode failure is therefore exported as `**Output:**` (markdown) and a plain non-error block (HTML), misrepresenting the failure as a success and losing the error information. Reachable with ordinary opencode session data.

3. claude.ts:143 and pi.ts:45 do use the exact literal `'Tool error'`, so the export label is correct only for those two sources — confirming the title convention is source-specific and buildTurns hardcodes the claude/pi spelling.

4. The "diverges from what the viewer renders" framing holds for opencode: NodeBubble.tsx:113-124 renders the node's title verbatim as the block title, so the viewer shows the literal text "bash error" (the word "error" is visible to the user), while the export drops any error indication. (Note: the viewer has no special red/error styling keyed on title either — both viewer and export rely on the title string — so the divergence is specifically "viewer title contains 'error', export label says 'Output'", not a styling-vs-styling mismatch. Still a real loss of fidelity.)

The codex half of the claim is weaker/partly inaccurate: codex.ts:98/108 hardcodes `title: 'Tool result'` for ALL function_call outputs and never sets any error flag even for failures — so codex has no error signal at all, in the viewer or the export. There is no divergence-from-viewer for codex (the viewer also shows "Tool result"), and buildTurns could not do better without codex itself distinguishing errors. So codex is not a defect introduced by this commit. But the claim's core assertion — opencode failed tool runs are exported as 'Output' instead of 'Error', losing the failure indication — is concretely real.

Severity: minor, as labeled. It mislabels failures in exports of opencode sessions but loses no actual content (the error text is still present, just under the wrong label).

</details>

## 18. [MINOR] Meta-carried content (generic-source records, opencode patch/diff/file parts) is silently dropped; an all-meta session exports a header-only document
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/export.ts:126-131 (with src/main/mappers/generic.ts:51-56, src/main/mappers/opencode.ts:213-222, src/main/index.ts:134):126-131`  ·  dimension: export-fidelity

**Problem:** buildTurns drops every node kind outside user/assistant/thinking/tool_call/tool_result (except the fork boundary). That is intentional for true meta/system chrome, but two mappers use 'meta' as the carrier for substantive content the viewer displays: genericNodes puts entire non-text records (tool invocations of sources without a dedicated mapper) into meta nodes, and opencode's addGenericPartNode routes patch/diff/file part text into meta. Exports of those sessions silently omit content visible in the Session view. Compounding it, the export:session handler only rejects when payload.nodes.length === 0 — a session whose nodes are all meta passes the guard and writes a document containing nothing but the header, with no warning to the user.

**Suggested fix:** Stop dropping substantive meta/system content in buildTurns, and tighten the guard so an all-meta session warns instead of writing an empty doc.

In src/main/export.ts buildTurns, change the `default` branch so non-boundary meta/system nodes carry their text into the export instead of being discarded. Minimal version — render them as their own labeled blocks (reuse the existing TurnPart shape, e.g. a `tool` part used as a generic titled block, or add a `meta` TurnPart):

  default:
    if (node.id === 'claude-fork-boundary') {
      open('note', true).parts.push({ type: 'note', text: node.text || 'Messages above were inherited from the parent session.' })
      current = null
    } else if ((node.kind === 'meta' || node.kind === 'system') && node.text?.trim()) {
      // Substantive carrier content (generic-source records, opencode patch/diff/file parts,
      // system notes) is shown collapsed in the viewer — keep it in exports too.
      open('assistant').parts.push({
        type: 'tool',                       // reuse the collapsible tool block path
        name: node.title || node.kind,
        input: node.text
      })
    }
    break

(If you prefer not to label them as tools, add a `{ type: 'meta'; title: string; text: string }` TurnPart and a corresponding branch in buildMarkdownExport/buildHtmlExport.)

Then in src/main/index.ts export:session, replace the node-count guard with a renderable-turns guard so an all-meta/empty-render session is reported rather than written:

  const payload = await loadTranscript(originalPath, source, id)
  if (payload.error) return { ok: false, error: payload.error }
  if (buildTurns(payload.nodes).length === 0) {
    return { ok: false, error: 'Nothing to export — no renderable messages.' }
  }

(import buildTurns alongside buildHtmlExport/buildMarkdownExport). With the buildTurns change above, meta/system nodes now produce turns, so this guard only fires for truly empty transcripts; without it, at minimum keep the node-count guard but warn the user when buildTurns yields no turns.

<details><summary>Verifier reasoning</summary>

Traced the full path and the claim holds.

1) buildTurns drops meta/system nodes. In src/main/export.ts:90-133 the `switch (node.kind)` has cases only for user/assistant/thinking/tool_call/tool_result; `meta` and `system` (both valid NodeKinds per src/shared/ipc.ts:34-42) fall to `default` (lines 126-131), which emits output ONLY when `node.id === 'claude-fork-boundary'`. Every other meta/system node is silently discarded by both buildMarkdownExport and buildHtmlExport.

2) Two mappers use meta as the carrier for substantive, viewer-displayed content:
   - generic.ts:51-56 (genericNodes): when no text can be extracted from a record it emits `b.add(i, 'meta', safeJson(r), ...)` — the whole record as JSON. genericNodes is the dispatch fallback in transcript.ts:46-51 for every file-based source without a dedicated mapper (claude/codex/pi/opencode are the only special-cased ones; copilot, gemini, droid, cursor, amp, kiro, cline, roo-code, kilo-code, antigravity, kimi, qwen-code all fall through to it).
   - opencode.ts:213-222 (addGenericPartNode): reached via addPartNode's default branch (line 270) for any part type outside {step-start, step-finish, text, reasoning, tool}; it pulls patch/diff/file/summary/message/state-output text and emits `b.add(rawIndex, 'meta', text, ...)`. opencode parts of type patch/file are routine, so this is hit in normal sessions.

3) The viewer DOES render these meta nodes, so there is a real discrepancy. NodeBubble.tsx:112-131 explicitly renders meta/system as a collapsible <details> block with title+body (its own comment lists "meta / system / thinking / tool_call / tool_result — collapsible"). SessionView.tsx renders every entry of the nodes array (counts nodes.length, indexes nodes[item.index]) with no kind filtering. So content visible (and expandable, full-text) in the Session view is omitted from the export.

4) The guard is too weak. index.ts:134 rejects only when `payload.nodes.length === 0`. A session whose nodes are entirely meta (e.g. a generic source whose records never match the text heuristics, or an opencode session that is all patch/file parts with no text part) passes the guard; buildMarkdownExport/buildHtmlExport then iterate buildTurns, produce zero turns, and write a document containing only the header/meta table and footer — no warning. The export menu has no source restriction (Viewer.tsx:150 canExport only checks nodes.length > 0), so users can trigger this.

Realism: the "header-only document" is the extreme edge (zero text parts), but the common, realistic failure is partial silent content loss — an ordinary opencode session that also has text parts will export the conversation while silently dropping its patch/diff/file blocks, and any generic-source session loses every record the viewer shows as a JSON block. This contradicts the feature's stated invariant that exports must never lose content the viewer renders. Correctly rated minor.

</details>

## 19. [MINOR] Scope dropdown opens underneath the global-search results overlay and is unusable
**File:** `/Users/weixu/dev/AgentSessionViewer/src/renderer/src/App.tsx:604-659 (plus styles.css .find__scopeMenu z-index 60 vs .globalSearch z-index 70)`  ·  dimension: integration-perf

**Problem:** Both .find__scopeMenu (z-index 60 via .menu, anchored left:0, min-width 230px) and .globalSearch (z-index 70, right:0, width min(640px,100vw-48px)) are absolutely positioned siblings inside .findWrap, so the overlay paints above the menu and horizontally covers its full extent (findWrap is ~300px wide, far less than 640px) except a 2px sliver at the top edge. The outside-pointerdown closer ignores clicks on the scope chip because it is inside findWrapRef. Repro: scope = All, type 2+ characters (results overlay opens), click the scope chip — the menu opens invisibly beneath the overlay and its items cannot be seen or clicked; the user must press Escape or click elsewhere first. Fix: close the overlay when opening the scope menu (or give the menu a higher z-index than 70).

**Suggested fix:** When opening the scope menu, close the global-search overlay so they are never shown together. In src/renderer/src/App.tsx, change the scope chip handler (line 538) from:

  onClick={() => setScopeMenuOpen((open) => !open)}

to:

  onClick={() =>
    setScopeMenuOpen((open) => {
      const next = !open
      if (next) setGlobalOpen(false)
      return next
    })
  }

(Alternatively/additionally, give the scope menu a higher z-index than the overlay, e.g. add `z-index: 80` to `.find__scopeMenu` in styles.css, but closing the overlay is the more user-correct behavior since the two popovers otherwise overlap and fight for the same space.)

<details><summary>Verifier reasoning</summary>

Verified REAL by tracing both the CSS geometry and the React state flow.

DOM/CSS (src/renderer/src/styles.css):
- `.find__scopeMenu` (App.tsx:605, classes `dropdownMenu menu find__scopeMenu`, no `--right`/`--under` modifier) inherits `position:absolute; z-index:60` from `.menu` (styles.css:625-627) and adds `top:calc(100%+6px); left:0; min-width:230px` (styles.css:2028-2032).
- `.globalSearch` (styles.css:2034-2050) is `position:absolute; top:calc(100%+8px); right:0; z-index:70; width:min(640px, calc(100vw-48px)); background:var(--pop)` (opaque popover bg).
- Both are absolutely-positioned siblings inside `.findWrap` (`position:relative`, styles.css:1986-1989). `.find` is only `clamp(180px,24vw,280px)` wide (styles.css:218-221), so `.findWrap` is ~180-280px. The overlay anchored `right:0` spans ~640px leftward, fully covering the menu's 230px left-anchored span. Vertically they overlap from `100%+8px` down (only a ~2px menu-top sliver shows). Higher z-index (70 vs 60) means the opaque overlay paints over the menu. GlobalSearch always renders the opaque `.globalSearch` container even while empty/loading.

State flow (src/renderer/src/App.tsx):
- Scope chip onClick (line 538) is `setScopeMenuOpen((open) => !open)` only — it never touches `globalOpen`.
- Overlay renders when `searchScope !== 'session' && globalOpen` (line 648); menu renders when `scopeMenuOpen` (line 604). They are independent.
- The outside-pointerdown closer (lines 360-370) bails when `findWrapRef.current.contains(event.target)`. The chip lives inside `.find` inside `.findWrap` (findWrapRef, line 528), so clicking the chip does NOT close the overlay.

Concrete repro (matches claim exactly): scope='all'; typing 2+ chars fires onChange -> setGlobalOpen(true) (line 555) and the overlay opens (query length >= 2 so GlobalSearch shows results). Clicking the chip sets scopeMenuOpen=true while globalOpen stays true -> the scope menu opens underneath the opaque, higher-z-index, wider overlay and is invisible/unclickable. The user must Escape or click outside first. This is a real (minor) usability defect, not speculation or unreachable.

</details>

## 20. [MINOR] Transient adapter failure deletes that source's entire search index, forcing a full re-backfill
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/searchIndex.ts:185-194`  ·  dimension: integration-perf

**Problem:** runSync prunes every indexed session whose key is absent from the latest listing. But indexer.ts deliberately maps a failing adapter to [] ('one failing source can't break the rest' — e.g. node:sqlite unavailable for opencode/crush, or a transient FS error on a source's directory). On that listing, syncSearchIndex sees all of that source's sessions as deleted, runs DELETE FROM messages/sessions for each, and on the next successful listing re-reads every transcript of that source from scratch (each a full loadTranscript). Concrete scenario: opencode's DB is briefly locked during one sessions:list → hundreds of indexed sessions are dropped and fully re-indexed minutes later. The prune step needs a per-source success signal (skip pruning keys belonging to sources that returned an error/empty-from-exception) rather than treating absence as deletion.

**Suggested fix:** Make the prune source-aware: only prune keys belonging to sources that are actually present in the current listing, so a source that reported zero sessions (whether from a thrown adapter mapped to [] or a graceful empty read) does not nuke its existing index. Minimal change in runSync (searchIndex.ts, replacing the prune block at ~185-194):

    const liveKeys = new Set(metas.map(sessionKey))
    // Only prune within sources that this listing actually reported. A source
    // that returned nothing (transient adapter/DB failure mapped to []) must not
    // be treated as "all its sessions deleted" — that would destroy and force a
    // full re-backfill of an otherwise-valid index.
    const reportedSources = new Set(metas.map((m) => m.source))
    const deleteMessages = handle.prepare('DELETE FROM messages WHERE session_key = ?')
    const deleteSession = handle.prepare('DELETE FROM sessions WHERE session_key = ?')
    for (const key of [...known.keys()]) {
      if (liveKeys.has(key)) continue
      const source = key.slice(0, key.indexOf(':')) // session_key = `${source}:${id}:${path}`
      if (!reportedSources.has(source)) continue // source absent this pass — leave its rows intact
      deleteMessages.run(key)
      deleteSession.run(key)
      known.delete(key)
    }

This still prunes genuinely deleted sessions of any source that did report, but skips entire sources that returned empty. (Deriving source by slicing to the first ':' is safe: source names contain no ':'. Alternatively store/read the `source` column already on the sessions row instead of re-parsing the key, which is cleaner and avoids relying on key structure.) For a fully robust signal, pass the set of successfully-parsed sources from listSessions/the IPC layer into syncSearchIndex rather than inferring "reported" from a non-empty result, so a source that legitimately has zero sessions is distinguished from one that failed.

<details><summary>Verifier reasoning</summary>

VERDICT: REAL (minor, self-healing but a genuine destructive-prune + wasteful full re-backfill).

Traced the full path:

1. Prune logic confirmed (searchIndex.ts:185-194): runSync builds `liveKeys` from the passed metas and DELETEs messages+sessions for every previously-indexed key not in that set — with no notion of which sources actually reported successfully.

2. The empty-listing-for-a-source state is reachable. index.ts:112-116 calls `listSessions(force)` then `syncSearchIndex(metas, ...)`, passing whatever listing was produced. When listSessions actually re-runs adapters (cache miss / 30-min TTL expiry / fingerprint change / force refresh — sessionMetadataCache.ts:12,216-227), a per-source failure yields an empty group for that source. indexer.ts:91-100 wraps each parseSessions in try/catch and substitutes [] on throw.

3. Note on mechanism (minor inaccuracy in the claim, same outcome): for the cited opencode/crush sources a "briefly locked DB" does NOT actually throw out of parseSessions. opencode openDb (opencode.ts:514-525) and crush openReadOnlyDatabase catch the DatabaseSync open error internally and return null → the loop `continue`s → parseOpenCodeSessions even falls through to the JSON path (opencode.ts:657) → returns [] gracefully, never reaching indexer's catch. The query body is also try/wrapped (opencode.ts:730). So the source degrades silently to an empty array rather than via the indexer's catch — but the merged metas are still missing that source's sessions, which is the only thing the prune cares about. The reviewer's root-cause diagnosis (absence treated as deletion) is correct; only the throw-vs-graceful-empty detail is imprecise.

4. Consequence confirmed: on that listing every one of the source's keys is absent from liveKeys → DELETE messages + sessions (lines 188-194). On the next successful listing those keys are gone from `known`, so the stale filter (lines 196-199, `!row` ⇒ stale) re-reads every one via a full loadTranscript (line 223). For opencode/crush that is extractContext('full') reconstruction — non-trivial I/O. Until the re-backfill finishes, global search returns nothing for that source.

No guard exists: there is no per-source success signal; absence is unconditionally treated as deletion. It self-heals and loses no permanent data (index is reconstructable), which justifies the [minor] severity, but it does cause an unnecessary destructive prune + full re-backfill and a transient search blind-spot for a real user whenever a transient read failure coincides with an adapter re-run. That is a concrete misbehavior, not defensive speculation.

</details>

## 21. [MINOR] Unthrottled per-session progress IPC re-renders the whole App for every indexed session during backfill
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/index.ts:106-110 (with searchIndex.ts:261-262 and App.tsx:201)`  ·  dimension: integration-perf

**Problem:** report() fires onProgress after every session, and sendSearchIndexProgress sends a 'searchIndex:progress' webContents message each time; the renderer's setIndexProgress then re-renders the entire App tree (SessionList, Viewer, toolbar — none are React.memo'd). Measured on this machine with the real pipeline: the first-launch backfill indexes 501 sessions in ~1.7s, i.e. ~300 IPC messages and ~300 full App re-renders per second, exactly while the freshly-loaded session list is also rendering. This is sustained renderer churn at app startup for zero visible benefit (the indexing counter is only shown inside the GlobalSearch overlay, which is closed at launch). Throttle progress emission in main (e.g. every 100ms or every N sessions, plus the final done report).

**Suggested fix:** Throttle progress emission in main. Coalesce per-session reports to at most one every ~100ms, always emitting the final done=true. Minimal change in searchIndex.ts runSync:

- Replace the unconditional per-session call at line 262 with a time-gated one, keeping the final report at line 267 unconditional. For example, near the top of runSync add `let lastReport = 0` and replace line 262 with:

```ts
done++
const now = Date.now()
if (now - lastReport >= 100) {
  lastReport = now
  report(onProgress, { indexed: done, total: metas.length, done: false })
}
```

The terminal `report(onProgress, { indexed: metas.length, total: metas.length, done: true })` at line 267 stays as-is so the renderer always lands on the correct final count and the `indexProgress.done` requery still fires exactly once. This caps startup renderer churn at ~10 re-renders/sec regardless of session count, with no change to observable behavior (the counter is only shown in the closed overlay).

Alternatively (or additionally) wrap SessionList/Viewer in React.memo, but the main-side throttle is the smaller, targeted fix and addresses the root cause (message volume).

<details><summary>Verifier reasoning</summary>

The mechanism the reviewer describes is real and fully traceable in the code; it is a genuine (correctly self-labeled "minor") inefficiency, not speculation or an unreachable path.

Exact path traced:
1. searchIndex.ts:262 — inside the per-session backfill loop, `report(onProgress, { indexed: done, total: metas.length, done: false })` fires unconditionally once per session. There is no throttle anywhere in the loop (the only spacing is the `setImmediate` yield on line 264, which spreads the calls across macrotasks but does not reduce their count).
2. report() (searchIndex.ts:167-170) calls `onProgress?.(p)` = `sendSearchIndexProgress`.
3. index.ts:106-110 — `sendSearchIndexProgress` calls `win.webContents.send('searchIndex:progress', progress)` for every window, once per call, no throttle.
4. preload/index.ts:9-13 — forwards every IPC message to the renderer callback.
5. App.tsx:201 — that callback is `setIndexProgress`. The payload `{ indexed, total, done }` is a NEW object literal each time, so React never bails out via Object.is, and the App function component re-renders on every message.
6. App's children (SessionList, Viewer, SessionView, toolbar JSX) are rendered inline and NONE are React.memo'd (grep confirmed zero memo in those files), so each re-render reconciles the whole tree.

First-launch scenario is reachable and the worst case: the DB is empty, so `known` is empty and every meta is `stale` (searchIndex.ts:196-199) — all sessions go through the loop, producing ~one IPC message + one full App re-render per indexed session. With ~500 sessions that is ~500 no-op full-tree reconciliations clustered at startup.

The benefit is genuinely zero at launch: indexProgress is only visibly consumed inside <GlobalSearch> (App.tsx:648-659), which is gated on `globalOpen` and closed at startup, so the churn produces no visible change.

Why it is correctly "minor" rather than severe: each re-render is cheap because the session list and transcript are both virtualized (only visible rows reconcile), and the search-requery effect keys on `indexProgress.done` (App.tsx:334) which stays false during backfill, so there is no per-session search-query storm — only React reconciliation overhead. But the wasted, unthrottled renderer churn at startup is real and matches the claim's mechanism and cited lines (index.ts:106-110, searchIndex.ts:262, App.tsx:201). The "~300/s" figure depends on the machine and is dominated by loadTranscript I/O per session, but the qualitative claim (one render per indexed session, hundreds at first launch, no visible benefit) holds.

</details>

## 22. [MINOR] Every list refresh fully re-reads and FTS-rebuilds any changed session — including the user's always-changing active session
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/searchIndex.ts:196-265`  ·  dimension: integration-perf

**Problem:** The staleness fingerprint is whole-file updatedAt/bytes, and re-indexing is loadTranscript (materializing the full records array plus all nodes including tool results, though only user/assistant text is indexed) followed by DELETE of all the session's rows and reinsert. The session the user is actively working in changes on every agent turn, so every app launch and every refresh-button press repeats this for it. Quantified with the real pipeline on this machine: a 107MB claude session costs ~290ms of background work and a ~310MB transient RSS spike in the main process per refresh, and the delete+reinsert churns the FTS index/WAL; event-loop blocking itself measured benign (max 77ms gap on the 107MB file, 28ms across a 501-session backfill), so the defect is repeated wasted work and memory spikes that grow linearly with active-session size, not stalls. A tail-append path for .jsonl sources (store last indexed byte offset/node count) would make refreshes O(delta).

**Suggested fix:** Add an incremental tail-append path for per-session .jsonl sources so refreshes are O(delta) instead of O(file).

In the `sessions` table, store the last-indexed byte offset and node count (and a small prefix fingerprint to detect non-append rewrites): add columns `indexed_bytes INTEGER`, `indexed_node_count INTEGER`, and `head_fingerprint TEXT` (e.g. hash of the first record line / first ~4KB).

In `runSync`, for a stale meta whose source is file-based JSONL and whose `originalPath` is a single .jsonl file:
1. Stat the file and recompute the head fingerprint of the existing prefix. If `head_fingerprint` matches the stored value AND `meta.bytes >= row.indexed_bytes` (pure append — covers the active-session-grew-by-one-turn case), read ONLY the bytes from `row.indexed_bytes` to EOF (the streaming line scanner already supports byte ranges), build nodes for just those records, and INSERT new user/assistant rows with `node_index` offset by `row.indexed_node_count`. Do NOT delete existing rows. Then update `sessions` with new bytes/updatedAt/indexed_bytes/indexed_node_count/message_count.
2. If the head fingerprint changed, the file shrank, or the source is not a plain .jsonl (opencode/crush reconstructed, .json, forks/compaction that rewrite history), fall back to the current full delete + reinsert path.

This keeps node_index aligned with `loadTranscript().nodes` (since claude .jsonl nodes are append-stable when the head is unchanged) and turns the recurring active-session re-index into reading only the newly appended turn(s). Guard the fast path strictly on the head-fingerprint match so any history rewrite degrades safely to a full reindex.

<details><summary>Verifier reasoning</summary>

Verified against the actual code; every claimed mechanic is accurate.

PATH TRACED:
1. `src/main/index.ts:112-116` — the `sessions:list` IPC handler calls `syncSearchIndex(metas, ...)` after every listing. The renderer fires this on app launch (`App.tsx:134-136` refresh(false)) and on every manual refresh-button click (`App.tsx:673` refresh(true)). No auto-poll, so it is per-launch + per-manual-refresh, exactly as claimed.
2. `searchIndex.ts:196-199` — staleness is a whole-file fingerprint: `row.updated_at !== m.updatedAt || row.bytes !== m.bytes`.
3. For a claude session, lightweight listing sets `bytes: fileStats.size` and `updatedAt: fileStats.mtime` (`claude.ts:250,252`). When the active session receives a new agent turn, the file's size and mtime both move, so its fingerprint always differs from the indexed value → it is marked stale on the next refresh.
4. Re-indexing the stale session calls `loadTranscript(...)` (`searchIndex.ts:223`). For a `.jsonl` claude source this hits `transcript.ts:71-74`, which calls `readJsonlRecords` (`transcript.ts:13-32`) — materializing the ENTIRE records array in memory (capped only at MAX_BYTES = 96MB) — and then builds the full nodes array via `claudeTranscriptNodes`, including tool-result nodes that are never indexed. Only `kind ∈ {user, assistant}` non-inherited nodes are then kept (`searchIndex.ts:226-233`).
5. The session's existing rows are then DELETE'd and every kept row reinserted inside a transaction (`searchIndex.ts:236-253`), with the FTS5 delete/insert triggers (`searchIndex.ts:124-129`) churning the FTS index + WAL.

So for a user actively working in a large, growing session, every app launch and every refresh repeats a full file read + full node materialization + delete/reinsert for that session, with cost and transient RSS scaling linearly with session size. This is concretely reachable real wasted work, not speculation.

CAVEATS (why it is only minor, and the claim is honest about this):
- It runs in the background and never blocks the IPC reply (index.ts:114 comment + fire-and-forget); the loop yields via `setImmediate` between sessions (searchIndex.ts:264). The claim itself states event-loop blocking is benign (max ~77ms gap), so this is an efficiency/memory defect, not a stall or correctness bug.
- Minor inaccuracy in the claim's numbers: MAX_BYTES is 96MB, so a 107MB file is truncated to 96MB rather than fully read — the per-refresh cost is real but capped at ~96MB, not unbounded. This does not change the verdict.

The diagnosis is correct and the path is concrete, so isReal=true (a real, minor inefficiency).

</details>

## 23. [MINOR] Global search cannot find CJK text except at token-run prefixes (unicode61 tokenizer)
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/searchIndex.ts:118-123, 276-283`  ·  dimension: integration-perf

**Problem:** The FTS table uses tokenize='unicode61', which treats an unbroken CJK run as a single token. Verified empirically against node:sqlite: with the indexed text 我们今天讨论了搜索索引的实现细节, the query "我们"* matches (run prefix) but "搜索"* and "索引"* return 0 rows. Concrete failure: a user searching All-sessions for a Chinese word that appears mid-sentence gets 'No matches' even though the text is in the index — while the Session-scope find (plain substring) finds it in the open transcript, making the scopes behave inconsistently and the miss look like missing data. Needs the trigram tokenizer or per-character segmentation of CJK runs at index/query time.

**Suggested fix:** Switch the FTS tokenizer to trigram, which makes any substring of length >= 3 matchable and works for CJK regardless of whitespace, OR keep unicode61 but segment CJK at index+query time into per-character tokens. Lowest-risk minimal fix that also matches the substring semantics of the Session scope is trigram:

1) In migrate() (searchIndex.ts:118-123) change the tokenizer to:
   tokenize='trigram'
   Note: trigram is case-sensitive by default; add `remove_diacritics 1` is not supported, but you can use `tokenize='trigram case_sensitive 0'` (SQLite >= 3.45) to keep case-insensitive matching for Latin text.
2) Bump SCHEMA_VERSION from 1 to 2 (line 21) so the existing index is dropped and rebuilt with the new tokenizer (migrate() already drops/recreates on version mismatch).
3) Trigram requires the LIKE/substring match form, not prefix tokens. In ftsExpression() (lines 276-283), stop appending `*`; emit each token quoted as a phrase, e.g. tokens.map((t) => `"${t.replace(/\\/gu,'')}"`).join(' '). Trigram MATCH with a quoted phrase performs a substring search (needs >= 3 chars; for 1–2 char queries fall back gracefully — trigram returns nothing for <3 chars, so optionally keep a min-length note in the UI).

This makes mid-sentence CJK ("搜索", "索引") and arbitrary substrings findable in All/Project scope, aligning it with the Session-scope indexOf behavior. Trade-off: a larger index and slightly different ranking; acceptable for a local viewer. Test with the same row 我们今天讨论了搜索索引的实现细节 and confirm "搜索"/"索引" now return the row.

<details><summary>Verifier reasoning</summary>

VERIFIED REAL, reproduced empirically with node:sqlite v25.2.1 using the app's exact schema and query builder.

The FTS table at src/main/searchIndex.ts:118-123 uses tokenize='unicode61 remove_diacritics 2'. unicode61 does NOT segment CJK; an unbroken Han run is one token. ftsExpression (lines 276-283) wraps each whitespace-split token in quotes and a trailing `*` (prefix match). For CJK there are no spaces, so the whole word/phrase becomes one starred prefix term.

Empirical test — indexed text 我们今天讨论了搜索索引的实现细节 (one row). The fts5vocab dump shows the entire run stored as a SINGLE token: 我们今天讨论了搜索索引的实现细节. Query results (built via the app's ftsExpression):
- "我们"* → 1 hit (it is the prefix of the single token)
- "搜索"* → 0 hits
- "索引"* → 0 hits
- "细节"* → 0 hits
- "实现细节"* → 0 hits
- "今天讨论" → 0 hits
English (we discussed the search index implementation today) tokenizes per-word and matches normally.

So: a user searching All- or Project-scope for a Chinese word that appears mid-sentence gets zero hits even though the text is indexed. Inconsistency confirmed by code trace: the Session scope (App.tsx:56-66, buildSearchMatches) uses lower.indexOf(query) — a plain JS substring match — so the same word IS found in the open transcript. The scope wiring (App.tsx:310-334) routes Session → indexOf and Project/All → window.api.searchSessions (the FTS path). The user sees the open session highlight the word but All-sessions report 'No matches', making real indexed data look missing. The `2` in remove_diacritics is a diacritics flag only and has no effect on CJK segmentation.

Severity is genuinely minor (CJK-only, affects mid-token queries; first-character/word-prefix CJK queries still work), but it is a real, reachable user-facing defect, not speculation.

</details>

## 24. [MINOR] Export pairs parallel tool outputs to the wrong tool calls (FIFO pairing ignores tool_use_id)
**File:** `/Users/weixu/dev/AgentSessionViewer/src/main/export.ts:112-125`  ·  dimension: integration-perf

**Problem:** buildTurns attaches each tool_result to the earliest tool part with output === undefined. Verified with a direct test: calls A,B whose results arrive B-first produce 'BashA -> OUTPUT-OF-B' and 'BashB -> OUTPUT-OF-A'. Claude/codex JSONL records tool results as separate records in completion order, not call order, so any parallel tool_use batch with different runtimes (two parallel Bash calls is the common case) exports with outputs misattributed in both Markdown and HTML. The raw records carry tool_use_id but ViewNode does not, so the exporter cannot pair exactly; either surface the id on ViewNode (also useful to the viewer) or label unpaired results separately instead of guessing.

**Suggested fix:** Surface the tool-call id on ViewNode and pair by it instead of FIFO.

1) Add an optional field to ViewNode (src/shared/ipc.ts): `toolUseId?: string`.

2) Populate it in the mappers where the id is known:
   - claude.ts tool_use: `b.add(rawIndex, 'tool_call', formatArgs(blk.input), { role:'assistant', toolName: blk.name, title: blk.name||'tool', toolUseId: blk.id })`
   - claude.ts tool_result: `b.add(rawIndex, 'tool_result', text||'(no output)', { role:'user', title: blk.is_error?'Tool error':'Tool result', toolUseId: blk.tool_use_id })`
   (codex already pairs by call_id inline, so it's optional there but harmless to add p.call_id.)
   Ensure NodeBuilder.add threads the extra option through to the node.

3) In export.ts buildTurns, carry the id on the tool part and pair by id, FIFO only as fallback:
   - add `toolUseId?: string` to the `tool` TurnPart and set it from `node.toolUseId` in the tool_call case.
   - tool_result case:
     ```ts
     const resId = (node as ViewNode).toolUseId
     let pending = resId
       ? turn.parts.find((p): p is TurnPart & {type:'tool'} => p.type==='tool' && p.toolUseId===resId && p.output===undefined)
       : undefined
     if (!pending) pending = turn.parts.find((p): p is TurnPart & {type:'tool'} => p.type==='tool' && p.output===undefined) // fallback for sources without ids
     if (pending) { pending.output = node.text; pending.isError = isError }
     else { turn.parts.push({ type:'tool', name: node.toolName||node.title||'tool result', input:'', output: node.text, isError }) }
     ```
   This pairs exactly when ids are present (Claude/codex) and degrades to the existing FIFO behavior for sources that don't carry ids. Bonus: the id is also useful to the viewer if it later wants to link calls and results.

<details><summary>Verifier reasoning</summary>

CONFIRMED REAL via end-to-end trace against the user's real Claude sessions.

The bug (export.ts:112-125): on each `tool_result` node, `buildTurns` attaches the output to the first tool part in the current turn with `output === undefined` (pure FIFO), ignoring tool-call identity. `ViewNode` (src/shared/ipc.ts:43-60) carries no `tool_use_id`, so the exporter has nothing to pair on.

Why the data triggers it: Claude Code emits each parallel tool call as its own assistant record and each result as its own user record. The claude mapper (mappers/claude.ts:132-146) turns these into consecutive `tool_call` nodes (call order) followed by `tool_result` nodes; tool_result nodes call `open('assistant')` (export.ts:113), not a user turn, so every parallel call+result lives in ONE assistant turn — exactly where FIFO ambiguity bites. Crucially, results arrive in COMPLETION order, not call order.

Empirical verification (importing the real `buildTurns` + `claudeTranscriptNodes`, reconstructing ground-truth `tool_use_id` per node from raw records, replicating buildTurns' exact turn-reset/FIFO logic over all 340 local Claude sessions):
- 631 result nodes are paired while >=2 calls are pending in the same turn (genuinely ambiguous).
- 447 of those (71%) are paired to the WRONG tool call.
- Canonical case reproduced: two parallel Bash calls (904d317f...jsonl) -> result for Bash(6cswe) gets attached to Bash(5xnF9). Cross-tool scrambles too: an Edit part shows a Read's output, a Bash part shows a TaskUpdate's output, etc. Mispairing cascades: one wrong pairing shifts every later result in the batch.

It surfaces in BOTH exporters: Markdown renders `**Tool: ${part.name}**` then the (wrong) output (export.ts:176-181); HTML renders `Tool: <b>${name}</b>` summary over the (wrong) output sections (export.ts:303-305). The viewer itself renders nodes flat and never pairs, so this is export-specific and does not regress find-in-session.

Claim's codex assertion is the only inaccurate part: the codex mapper (mappers/codex.ts:96-98,116-119) pairs results by `call_id` and emits each tool_result inline immediately after its own tool_call, so no two codex tool parts are ever pending simultaneously — FIFO is harmless there. But the Claude case alone makes the defect real and common.

Severity is fairly assessed as minor (outputs are not lost, only misattributed), but it does violate "exports must never lose user/assistant content" in spirit for tool I/O and produces confidently-wrong output.

</details>

## 25. [MINOR] Clicking a global-search result that is already the active in-session match does nothing
**File:** `/Users/weixu/dev/AgentSessionViewer/src/renderer/src/App.tsx:281-292`  ·  dimension: integration-perf

**Problem:** For a jump into the already-open session, the pendingJump effect calls setActiveMatchIndex(matchIdx) when the target node is a substring match of the query. If matchIdx equals the current activeMatchIndex (typical: the top result, index 0, immediately after a previous jump), activeMatch is unchanged, so SessionView's scroll effect (dependency [activeMatch?.nodeIndex]) never fires — after the user scrolls away and re-clicks the same result row in the overlay, nothing happens: no scroll, no flash. The scrollTarget/token mechanism exists precisely to re-trigger same-index jumps but is only used in the matchIdx === -1 branch; using it (or bumping the token) in both branches fixes the dead click.

**Suggested fix:** Bump the scroll token in BOTH branches so a same-index re-click always retriggers the scroll+flash, while still setting the active match for in-session highlighting. In App.tsx:288-290 replace:

    const matchIdx = searchMatches.findIndex((m) => m.nodeIndex === pendingJump.nodeIndex)
    if (matchIdx >= 0) setActiveMatchIndex(matchIdx)
    else setScrollTarget({ index: pendingJump.nodeIndex, token: ++scrollTokenRef.current })

with:

    const matchIdx = searchMatches.findIndex((m) => m.nodeIndex === pendingJump.nodeIndex)
    if (matchIdx >= 0) setActiveMatchIndex(matchIdx)
    setScrollTarget({ index: pendingJump.nodeIndex, token: ++scrollTokenRef.current })

Both paths land on the same node (matchIdx is found by matching pendingJump.nodeIndex, so searchMatches[matchIdx].nodeIndex === pendingJump.nodeIndex), and the two SessionView effects (activeMatch scroll + scrollTarget scroll/flash) both call jumpToIndex(index,'center') on the same row, so it is idempotent. The token changing every click guarantees the scrollTarget effect (dep [scrollTarget?.token]) re-fires even when activeMatchIndex is unchanged, and the user also gets the flash on the matched-substring path.

<details><summary>Verifier reasoning</summary>

Traced the exact path and the claim holds.

WHERE THE matchIdx>=0 BRANCH IS REACHABLE: `sessionSearchText` is the single shared input used by both in-session and global search. In global scope ('all'/'project'), the typed query (e.g. "foo") still flows into `searchMatches = buildSearchMatches(transcript.nodes, searchQuery)` (App.tsx:247-251), which runs unconditionally regardless of scope. When a global-search result points at the currently-open session, `openSearchResult` (App.tsx:341-350) sets `pendingJump` and does NOT call setSelected (same session), so the transcript stays. The pendingJump effect (App.tsx:281-292) then computes `matchIdx = searchMatches.findIndex(m => m.nodeIndex === pendingJump.nodeIndex)`. Since the clicked node contains the query substring (that's why it's a hit), matchIdx >= 0 and the branch runs `setActiveMatchIndex(matchIdx)`.

WHY THE RE-CLICK IS DEAD: The scroll in SessionView is driven solely by `useEffect(..., [activeMatch?.nodeIndex, jumpToIndex, searchQuery])` (SessionView.tsx:137-140). `activeMatch` = `searchMatches[activeSearchIndex]` (App.tsx:252-253), memoized on [transcript?.nodes, error, searchQuery]. When the user re-clicks a row whose match index equals the current `activeMatchIndex` (e.g. the single-occurrence case where matchIdx=0 and activeMatchIndex is already 0 from the reset effect at lines 275-277, or any case where they re-click the same row), `setActiveMatchIndex(matchIdx)` sets the same value → React bails out → `activeMatch` is the same object reference → `activeMatch?.nodeIndex` unchanged → the scroll effect never re-fires. No scroll, no flash.

REACHABILITY CONFIRMED: In global scope the find next/prev step buttons are not rendered (App.tsx:567 ternary renders the global count, not moveSearch buttons), and Enter calls openSearchResult, not moveSearch — so while in global scope there is no UI that changes activeMatchIndex. After a first jump sets activeMatchIndex, the user can manually scroll away, reopen the overlay (openSearchResult closed it via setGlobalOpen(false)), and re-click the SAME row: matchIdx == activeMatchIndex, dead click. In the single-hit case it is dead even on the first click. This is the precise opposite of what scrollTarget/token was built for (it intentionally bumps a token to retrigger same-index jumps), but the token path is only used in the matchIdx === -1 branch.

The claim is accurate (a real, if minor, UX dead-click). Not unreachable, not pure speculation.

</details>
