import * as fs from 'node:fs'
import * as path from 'node:path'
import type { VerbosityConfig } from '../config/index.js'
import { getPreset } from '../config/index.js'
import { logger } from '../logger.js'
import type {
  ConversationMessage,
  SessionContext,
  SessionEvent,
  SessionParseOptions,
  ToolCall,
  UnifiedSession
} from '../types/index.js'
import { findFiles, mapConcurrent } from '../utils/fs-helpers.js'
import { getFileStats, readJsonlFile, scanJsonlFile, scanJsonlHead } from '../utils/jsonl.js'
import { generateHandoffMarkdown } from '../utils/markdown.js'
import { cleanSummary, extractRepoFromCwd, homeDir, trimMessages } from '../utils/parser-helpers.js'
import { matchesCwd } from '../utils/slug.js'

// Pi stores canonical session JSONL under ~/.pi/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl.
// First line: { type: 'session', id, cwd, timestamp }.
const PI_SESSIONS_DIR = process.env.PI_SESSIONS_DIR
  ? process.env.PI_SESSIONS_DIR
  : process.env.PI_HOME
    ? path.join(process.env.PI_HOME, 'agent', 'sessions')
    : path.join(homeDir(), '.pi', 'agent', 'sessions')

/** Join the `text` blocks of a Pi message content array. */
function piContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as Record<string, unknown>
      if (b?.type === 'text' && typeof b.text === 'string') return b.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function findSessionFiles(options: SessionParseOptions = {}): string[] {
  return findFiles(PI_SESSIONS_DIR, {
    match: (entry) => entry.name.endsWith('.jsonl')
  })
}

interface PiInfo {
  sessionId: string
  cwd: string
  firstUserMessage: string
  model: string
  firstTimestamp: string
  lastTimestamp: string
}

function parseSessionInfo(filePath: string, options: SessionParseOptions): Promise<PiInfo> {
  let sessionId = ''
  let cwd = ''
  let firstUserMessage = ''
  let model = ''
  let firstTimestamp = ''
  let lastTimestamp = ''

  const visitor = (parsed: unknown): 'continue' | 'stop' => {
    const o = parsed as Record<string, any>
    if (!o || typeof o !== 'object') return 'continue'

    if (o.type === 'session') {
      if (o.id && !sessionId) sessionId = String(o.id)
      if (o.cwd && !cwd) cwd = String(o.cwd)
      if (o.timestamp && !firstTimestamp) firstTimestamp = String(o.timestamp)
    } else if (o.type === 'model_change') {
      if (o.modelId) model = String(o.modelId)
    } else if (o.type === 'message') {
      const msg = o.message as Record<string, any> | undefined
      const ts = msg?.timestamp || o.timestamp
      if (typeof ts === 'string') {
        if (!firstTimestamp) firstTimestamp = ts
        lastTimestamp = ts
      }
      if (!firstUserMessage && msg?.role === 'user') {
        firstUserMessage = piContentText(msg.content)
      }
    }

    if (options.lightweight && sessionId && cwd && firstUserMessage) return 'stop'
    return 'continue'
  }

  const run = options.lightweight ? scanJsonlHead(filePath, 80, visitor) : scanJsonlFile(filePath, visitor)
  return run.then(() => {
    if (!sessionId) {
      const base = path.basename(filePath, '.jsonl')
      sessionId = base.includes('_') ? base.slice(base.indexOf('_') + 1) : base
    }
    return { sessionId, cwd, firstUserMessage, model, firstTimestamp, lastTimestamp }
  })
}

export async function parsePiSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const files = findSessionFiles(options)
  const parsed = await mapConcurrent(files, 16, async (filePath): Promise<UnifiedSession | null> => {
    try {
      const info = await parseSessionInfo(filePath, options)
      if (options.cwd && info.cwd && !matchesCwd(info.cwd, options.cwd)) return null

      const fileStats = fs.statSync(filePath)
      const stats = options.lightweight ? { lines: 0, bytes: fileStats.size } : await getFileStats(filePath)

      return {
        id: info.sessionId,
        source: 'pi',
        cwd: info.cwd,
        repo: extractRepoFromCwd(info.cwd),
        lines: stats.lines,
        bytes: stats.bytes,
        createdAt: info.firstTimestamp ? new Date(info.firstTimestamp) : fileStats.birthtime,
        updatedAt: !options.lightweight && info.lastTimestamp ? new Date(info.lastTimestamp) : fileStats.mtime,
        originalPath: filePath,
        summary: cleanSummary(info.firstUserMessage) || undefined,
        model: info.model || undefined
      }
    } catch (err) {
      logger.debug('pi: skipping unparseable session', filePath, err)
      return null
    }
  })

  const sessions = parsed.filter((s): s is UnifiedSession => s !== null)
  const sorted = sessions.filter((s) => s.bytes > 200).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  return options.limit ? sorted.slice(0, options.limit) : sorted
}

export async function extractPiContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard')
  const records = await readJsonlFile<Record<string, any>>(session.originalPath)

  const messages: ConversationMessage[] = []
  const timeline: SessionEvent[] = []
  const filesModified = new Set<string>()
  let seq = 0

  for (const rec of records) {
    if (rec?.type !== 'message') continue
    const msg = rec.message as Record<string, any> | undefined
    if (!msg) continue
    const ts = typeof msg.timestamp === 'string' ? new Date(msg.timestamp) : undefined

    if (msg.role === 'user' || msg.role === 'assistant') {
      const text = piContentText(msg.content)
      const toolCalls: ToolCall[] = []
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, any>>) {
          if (block?.type === 'toolCall') {
            toolCalls.push({ name: String(block.name ?? 'tool'), id: block.id, arguments: block.arguments })
            const p = block.arguments?.path || block.arguments?.file_path
            if (typeof p === 'string') filesModified.add(p)
            timeline.push({
              kind: 'tool_call',
              sequence: seq++,
              timestamp: ts,
              toolName: String(block.name ?? 'tool'),
              toolCallId: block.id,
              arguments: block.arguments,
              role: 'assistant'
            })
          } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
            timeline.push({ kind: 'reasoning', sequence: seq++, timestamp: ts, content: block.thinking, role: 'assistant' })
          }
        }
      }
      if (text || toolCalls.length) {
        messages.push({ role: msg.role, content: text, timestamp: ts, toolCalls: toolCalls.length ? toolCalls : undefined })
        if (text) timeline.push({ kind: 'message', sequence: seq++, timestamp: ts, role: msg.role, content: text })
      }
    } else if (msg.role === 'toolResult') {
      const text = piContentText(msg.content)
      timeline.push({
        kind: 'tool_result',
        sequence: seq++,
        timestamp: ts,
        toolName: msg.toolName,
        toolCallId: msg.toolCallId,
        result: text,
        status: msg.isError ? 'error' : undefined
      })
    }
  }

  const recentMessages = trimMessages(messages, cfg.recentMessages)
  const markdown = generateHandoffMarkdown(
    session,
    recentMessages,
    [...filesModified],
    [],
    [],
    undefined,
    cfg,
    'inline',
    timeline
  )

  return {
    session,
    recentMessages,
    filesModified: [...filesModified],
    pendingTasks: [],
    toolSummaries: [],
    timeline,
    markdown
  }
}
