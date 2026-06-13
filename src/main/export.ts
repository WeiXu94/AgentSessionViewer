import { Marked } from 'marked'
import type { SessionMeta, TranscriptPayload, ViewNode } from '../shared/ipc.js'

// Session → Markdown / HTML exporters.
// Markdown follows opencode's TUI /export format (header block, `## User` /
// `## Assistant` sections, `**Tool:**` + fenced input/output, `---` between
// sections). HTML follows pi's /export idea of one self-contained file, but is
// rendered ahead of time here — no embedded data blob or client-side renderer.

export interface ExportIdentity {
  source: string
  id: string
}

function exportTitle(meta: SessionMeta | undefined, fallback: ExportIdentity): string {
  const summary = meta?.summary?.trim()
  if (summary) return summary
  return `${meta?.sourceLabel ?? fallback.source} session ${fallback.id}`
}

function fmtDate(ms: number | undefined): string {
  return ms ? new Date(ms).toLocaleString() : ''
}

/** A fence longer than any backtick run in the content, so nothing escapes it. */
function fenceFor(text: string): string {
  let max = 0
  for (const run of text.matchAll(/`+/gu)) max = Math.max(max, run[0].length)
  return '`'.repeat(Math.max(3, max + 1))
}

function fencedBlock(text: string, lang = ''): string {
  const fence = fenceFor(text)
  return `${fence}${lang}\n${text}\n${fence}`
}

interface HeaderField {
  label: string
  value: string
}

function headerFields(meta: SessionMeta | undefined, fallback: ExportIdentity): HeaderField[] {
  const fields: HeaderField[] = [
    { label: 'Source', value: meta ? `${meta.sourceLabel}${meta.variantLabel ? ` (${meta.variantLabel})` : ''}` : fallback.source },
    { label: 'Session ID', value: fallback.id }
  ]
  const project = [meta?.repo, meta?.branch].filter(Boolean).join(' · ')
  if (project) fields.push({ label: 'Project', value: project })
  if (meta?.cwd) fields.push({ label: 'Directory', value: meta.cwd })
  if (meta?.model) fields.push({ label: 'Model', value: meta.model })
  if (meta?.createdAt) fields.push({ label: 'Created', value: fmtDate(meta.createdAt) })
  if (meta?.updatedAt) fields.push({ label: 'Updated', value: fmtDate(meta.updatedAt) })
  if (meta?.forkParentId) fields.push({ label: 'Forked from', value: meta.forkParentId })
  fields.push({ label: 'Exported', value: fmtDate(Date.now()) })
  return fields
}

/**
 * Group the flat node list into user/assistant turns. Tool calls, results and
 * thinking attach to the surrounding assistant turn (matching how every agent
 * actually interleaves them); meta/system nodes are dropped except the Claude
 * fork boundary, which becomes a note of its own.
 */
type TurnPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name: string; input: string; toolUseId?: string; output?: string; isError?: boolean }
  | { type: 'note'; text: string }

interface Turn {
  role: 'user' | 'assistant' | 'note'
  parts: TurnPart[]
}

export function buildTurns(nodes: ViewNode[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null
  let lastUserRawIndex = -1

  const currentRole = (): Turn['role'] | undefined => current?.role

  const open = (role: Turn['role'], forceNew = false): Turn => {
    if (forceNew || current?.role !== role) {
      current = { role, parts: [] }
      turns.push(current)
    }
    return current
  }

  for (const node of nodes) {
    switch (node.kind) {
      case 'user': {
        // Blocks of one user record stay together; a fresh record is a new turn.
        const newRecord = currentRole() === 'user' && node.rawIndex !== lastUserRawIndex
        open('user', newRecord).parts.push({ type: 'text', text: node.text })
        lastUserRawIndex = node.rawIndex
        break
      }
      case 'assistant':
        open('assistant').parts.push({ type: 'text', text: node.text })
        break
      case 'thinking':
        open('assistant').parts.push({ type: 'thinking', text: node.text })
        break
      case 'tool_call':
        open('assistant').parts.push({
          type: 'tool',
          name: node.toolName || node.title || 'tool',
          input: node.text,
          toolUseId: node.toolUseId
        })
        break
      case 'tool_result': {
        const turn = open('assistant')
        const isError = node.title === 'Tool error'
        // Pair by tool-call id when available — parallel calls complete out of
        // call order, so FIFO would attach outputs to the wrong calls. Fall back
        // to the earliest unanswered call only for sources without ids.
        const byId = node.toolUseId
          ? turn.parts.find(
              (p): p is TurnPart & { type: 'tool' } =>
                p.type === 'tool' && p.toolUseId === node.toolUseId && p.output === undefined
            )
          : undefined
        const pending =
          byId ??
          turn.parts.find(
            (p): p is TurnPart & { type: 'tool' } => p.type === 'tool' && p.toolUseId === undefined && p.output === undefined
          )
        if (pending) {
          pending.output = node.text
          pending.isError = isError
        } else {
          turn.parts.push({
            type: 'tool',
            name: node.toolName || node.title || 'tool result',
            input: '',
            toolUseId: node.toolUseId,
            output: node.text,
            isError
          })
        }
        break
      }
      default:
        if (node.id === 'claude-fork-boundary') {
          open('note', true).parts.push({ type: 'note', text: node.text || 'Messages above were inherited from the parent session.' })
          current = null
        }
        break
    }
  }

  return turns
}

export interface ExportOptions {
  includeThinking?: boolean
  includeTools?: boolean
}

const DEFAULT_OPTIONS: Required<ExportOptions> = { includeThinking: true, includeTools: true }

// ── Markdown ─────────────────────────────────────────────────────────

export function buildMarkdownExport(
  meta: SessionMeta | undefined,
  payload: TranscriptPayload,
  fallback: ExportIdentity,
  options?: ExportOptions
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const out: string[] = []

  out.push(`# ${exportTitle(meta, fallback)}`)
  out.push(headerFields(meta, fallback).map((f) => `**${f.label}:** ${f.value}`).join('\n'))
  if (payload.truncated) out.push('> ⚠️ The session file exceeded the size guard; this export is partial.')
  out.push('---')

  for (const turn of buildTurns(payload.nodes)) {
    if (turn.role === 'note') {
      out.push(`> ⑂ ${turn.parts.map((p) => ('text' in p ? p.text : '')).join(' ')}`)
      out.push('---')
      continue
    }

    const blocks: string[] = [turn.role === 'user' ? '## User' : '## Assistant']
    for (const part of turn.parts) {
      if (part.type === 'text') {
        blocks.push(part.text)
      } else if (part.type === 'thinking') {
        if (opts.includeThinking) blocks.push(`_Thinking:_\n\n${part.text}`)
      } else if (part.type === 'tool') {
        if (!opts.includeTools) continue
        const tool: string[] = [`**Tool: ${part.name}**`]
        if (part.input.trim()) tool.push(`**Input:**\n${fencedBlock(part.input, 'json')}`)
        if (part.output !== undefined) {
          tool.push(`**${part.isError ? 'Error' : 'Output'}:**\n${fencedBlock(part.output)}`)
        }
        blocks.push(tool.join('\n\n'))
      }
    }
    if (blocks.length === 1) continue // nothing renderable in this turn
    out.push(blocks.join('\n\n'))
    out.push('---')
  }

  return `${out.join('\n\n')}\n`
}

// ── HTML ─────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

/** Reject script-bearing schemes (javascript:, data:, vbscript:); allow http(s)/mailto/relative. */
function safeUrl(href: string): string | null {
  const url = (href ?? '').trim()
  if (/^(?:https?:|mailto:|#|\/|\.\/|\.\.\/)/iu.test(url)) return url
  if (!/^[a-z][a-z0-9+.-]*:/iu.test(url)) return url // scheme-less → relative, safe
  return null
}

// The exported .html is a standalone file the user may open in any browser, so
// transcript text must never become live markup. This marked instance renders
// raw HTML tokens as escaped text (matching the in-app viewer, which only looks
// safe because it runs sandboxed) and drops javascript:/data: link & image URLs.
const exportMarked = new Marked({ async: false, gfm: true })
exportMarked.use({
  renderer: {
    html(token): string {
      return escapeHtml(typeof token === 'string' ? token : token.text)
    },
    link(token): string {
      const href = safeUrl(token.href)
      const inner = this.parser.parseInline(token.tokens)
      if (!href) return inner
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      return `<a href="${escapeHtml(href)}"${title}>${inner}</a>`
    },
    image(token): string {
      const href = safeUrl(token.href)
      if (!href) return escapeHtml(token.text || '')
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(token.text || '')}"${title}>`
    }
  }
})

function md(text: string): string {
  return exportMarked.parse(text, { async: false }) as string
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const HTML_CSS = `
:root {
  --bg: #f5f5f7; --card: #ffffff; --text: #1d1d1f; --muted: rgb(60 60 67 / 0.6);
  --sep: rgb(0 0 0 / 0.1); --accent: #007aff; --user-bg: rgb(0 122 255 / 0.07);
  --mono: "SF Mono", ui-monospace, Menlo, Monaco, "Cascadia Mono", monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161618; --card: #1e1e20; --text: #f5f5f7; --muted: rgb(235 235 245 / 0.6); --sep: rgb(255 255 255 / 0.12); --user-bg: rgb(10 132 255 / 0.12); }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px 16px 80px; background: var(--bg); color: var(--text);
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 860px; margin: 0 auto; }
header.session { background: var(--card); border: 1px solid var(--sep); border-radius: 12px; padding: 20px 24px; margin-bottom: 24px; }
header.session h1 { margin: 0 0 12px; font-size: 20px; line-height: 1.3; }
table.meta { border-collapse: collapse; font-size: 12.5px; }
table.meta td { padding: 2px 0; vertical-align: top; }
table.meta td.k { color: var(--muted); padding-right: 16px; white-space: nowrap; }
table.meta td.v { font-family: var(--mono); font-size: 12px; word-break: break-all; }
.msg { background: var(--card); border: 1px solid var(--sep); border-radius: 12px; padding: 14px 18px; margin: 14px 0; overflow-wrap: break-word; }
.msg--user { background: var(--user-bg); border-color: color-mix(in srgb, var(--accent) 25%, transparent); }
.msg__role { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
.msg--user .msg__role { color: var(--accent); }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md pre { background: rgb(0 0 0 / 0.05); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
@media (prefers-color-scheme: dark) { .md pre { background: rgb(255 255 255 / 0.06); } }
.md code { font-family: var(--mono); font-size: 12px; }
.md img { max-width: 100%; }
details.block { border: 1px solid var(--sep); border-radius: 10px; margin: 10px 0; background: var(--card); }
details.block > summary { cursor: pointer; padding: 8px 14px; font-size: 12px; color: var(--muted); user-select: none; }
details.block > summary b { color: var(--text); font-weight: 600; }
details.block[open] > summary { border-bottom: 1px solid var(--sep); }
details.block .io { margin: 0; padding: 10px 14px; font-family: var(--mono); font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: break-word; max-height: 480px; overflow-y: auto; }
details.block .io + .io { border-top: 1px dashed var(--sep); }
details.block .io__label { font-family: inherit; font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); display: block; margin-bottom: 4px; }
details.block--error > summary b { color: #c92a1c; }
.fork-note { text-align: center; color: var(--muted); font-size: 12px; margin: 18px 0; }
footer.exported { margin-top: 32px; text-align: center; color: var(--muted); font-size: 11.5px; }
`

export function buildHtmlExport(
  meta: SessionMeta | undefined,
  payload: TranscriptPayload,
  fallback: ExportIdentity,
  options?: ExportOptions
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const title = exportTitle(meta, fallback)
  const body: string[] = []

  const metaRows = headerFields(meta, fallback)
    .map((f) => `<tr><td class="k">${escapeHtml(f.label)}</td><td class="v">${escapeHtml(f.value)}</td></tr>`)
    .join('\n')
  body.push(`<header class="session"><h1>${escapeHtml(title)}</h1><table class="meta">${metaRows}</table></header>`)
  if (payload.truncated) {
    body.push('<p class="fork-note">⚠️ The session file exceeded the size guard; this export is partial.</p>')
  }

  for (const turn of buildTurns(payload.nodes)) {
    if (turn.role === 'note') {
      const text = turn.parts.map((p) => ('text' in p ? p.text : '')).join(' ')
      body.push(`<p class="fork-note">⑂ ${escapeHtml(text)}</p>`)
      continue
    }

    const blocks: string[] = []
    for (const part of turn.parts) {
      if (part.type === 'text') {
        blocks.push(`<div class="md">${md(part.text)}</div>`)
      } else if (part.type === 'thinking') {
        if (!opts.includeThinking) continue
        blocks.push(
          `<details class="block block--thinking"><summary><b>Thinking</b> · ${fmtBytes(Buffer.byteLength(part.text))}</summary><pre class="io">${escapeHtml(part.text)}</pre></details>`
        )
      } else if (part.type === 'tool') {
        if (!opts.includeTools) continue
        const sections: string[] = []
        if (part.input.trim()) {
          sections.push(`<pre class="io"><span class="io__label">Input</span>${escapeHtml(part.input)}</pre>`)
        }
        if (part.output !== undefined) {
          sections.push(
            `<pre class="io"><span class="io__label">${part.isError ? 'Error' : 'Output'}</span>${escapeHtml(part.output)}</pre>`
          )
        }
        const size = Buffer.byteLength(part.input) + Buffer.byteLength(part.output ?? '')
        blocks.push(
          `<details class="block${part.isError ? ' block--error' : ''}"><summary>Tool: <b>${escapeHtml(part.name)}</b> · ${fmtBytes(size)}</summary>${sections.join('')}</details>`
        )
      }
    }
    if (blocks.length === 0) continue

    if (turn.role === 'user') {
      body.push(`<article class="msg msg--user"><div class="msg__role">You</div>${blocks.join('\n')}</article>`)
    } else {
      body.push(`<article class="msg msg--assistant"><div class="msg__role">Assistant</div>${blocks.join('\n')}</article>`)
    }
  }

  body.push(`<footer class="exported">Exported from AgentSessionViewer · ${escapeHtml(fmtDate(Date.now()))}</footer>`)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>${HTML_CSS}</style>
</head>
<body>
<main>
${body.join('\n')}
</main>
</body>
</html>
`
}
