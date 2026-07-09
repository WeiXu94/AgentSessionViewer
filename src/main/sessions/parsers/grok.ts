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
import { cleanUserQueryText, extractRepoFromGitUrl, isSystemContent } from '../utils/content.js'
import { listSubdirectories, mapConcurrent } from '../utils/fs-helpers.js'
import { getFileStats, readJsonlFile } from '../utils/jsonl.js'
import { generateHandoffMarkdown } from '../utils/markdown.js'
import { cleanSummary, extractRepoFromCwd, homeDir, trimMessages } from '../utils/parser-helpers.js'
import { matchesCwd } from '../utils/slug.js'

/**
 * Grok Build sessions live under:
 *   $GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/
 *     summary.json        — metadata index
 *     chat_history.jsonl  — raw model chat (primary transcript for the viewer)
 *     updates.jsonl       — ACP stream (not used for full-fidelity display)
 *     subagents/<id>/meta.json — parent linkage for spawned children
 *
 * Default home is ~/.grok; override with GROK_HOME.
 */

function getGrokHome(): string {
  const configured = process.env.GROK_HOME?.trim()
  return configured ? path.resolve(configured) : path.join(homeDir(), '.grok')
}

function getGrokSessionsDir(): string {
  return path.join(getGrokHome(), 'sessions')
}

interface GrokSummary {
  id: string
  cwd: string
  summary?: string
  model?: string
  branch?: string
  gitSha?: string
  createdAt?: Date
  updatedAt?: Date
  parentSessionId?: string
  sessionKind?: string
  agentName?: string
  gitRemote?: string
  numChatMessages?: number
}

interface SubagentLink {
  parentId: string
  subagentType?: string
  description?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) return undefined
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

function readJsonObjectSync(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch (err) {
    logger.debug('grok: failed to parse json', filePath, err)
    return null
  }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (!isRecord(block)) return ''
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      if (block.type === 'image') return '[image]'
      if (typeof block.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function reasoningText(record: Record<string, unknown>): string {
  const summary = record.summary
  if (Array.isArray(summary)) {
    return summary
      .map((part) => {
        if (!isRecord(part)) return ''
        if (part.type === 'summary_text' && typeof part.text === 'string') return part.text
        if (typeof part.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (typeof record.content === 'string') return record.content
  return contentToText(record.content)
}

function isGrokUserNoise(raw: string, cleaned: string): boolean {
  if (!cleaned) return true
  if (isSystemContent(raw) || isSystemContent(cleaned)) return true
  // Synthetic system envelopes without a real user prompt.
  if (!raw.includes('<user_query>')) {
    if (raw.includes('<user_info>') || raw.includes('<git_status>')) return true
    if (raw.includes('<system-reminder>') || raw.includes('<system_reminder>')) return true
    if (raw.trimStart().startsWith('<')) return true
  }
  if (cleaned.startsWith('<system-reminder>') || cleaned.startsWith('<system_reminder>')) return true
  if (cleaned.startsWith('<user_info>')) return true
  return false
}

/**
 * Extract the human-facing portion of a Grok user content field.
 * Strips `<user_query>` wrappers and drops synthetic system noise.
 * Exported for the transcript mapper.
 */
export function extractUserFacingText(record: Record<string, unknown> | null | undefined): string {
  if (!record) return ''
  if (record.synthetic_reason != null && String(record.synthetic_reason).length > 0) return ''

  const raw = contentToText(record.content).trim()
  if (!raw) return ''

  const cleaned = cleanUserQueryText(raw).trim()
  if (isGrokUserNoise(raw, cleaned)) return ''
  return cleaned
}

function parseToolArguments(raw: unknown): Record<string, unknown> | undefined {
  if (raw == null) return undefined
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return isRecord(parsed) ? parsed : { value: parsed }
    } catch {
      return { raw }
    }
  }
  if (isRecord(raw)) return raw
  return undefined
}

function parseSummary(summaryPath: string): GrokSummary | null {
  const raw = readJsonObjectSync(summaryPath)
  if (!raw) return null

  const info = isRecord(raw.info) ? raw.info : undefined
  const id = stringField(info, 'id') || stringField(raw, 'id') || path.basename(path.dirname(summaryPath))
  const cwd = stringField(info, 'cwd') || stringField(raw, 'cwd') || ''
  if (!id) return null

  const title = stringField(raw, 'generated_title') || stringField(raw, 'session_summary')
  const remotes = Array.isArray(raw.git_remotes) ? raw.git_remotes : []
  const firstRemote = remotes.find((r): r is string => typeof r === 'string' && r.length > 0)

  return {
    id,
    cwd,
    summary: title,
    model: stringField(raw, 'current_model_id'),
    branch: stringField(raw, 'head_branch'),
    gitSha: stringField(raw, 'head_commit'),
    createdAt: parseDate(raw.created_at),
    updatedAt: parseDate(raw.updated_at) ?? parseDate(raw.last_active_at),
    parentSessionId: stringField(raw, 'parent_session_id'),
    sessionKind: stringField(raw, 'session_kind'),
    agentName: stringField(raw, 'agent_name'),
    gitRemote: firstRemote,
    numChatMessages: typeof raw.num_chat_messages === 'number' ? raw.num_chat_messages : undefined
  }
}

function readSubagentLink(metaPath: string): { childId: string; link: SubagentLink } | null {
  const raw = readJsonObjectSync(metaPath)
  if (!raw) return null
  const childId =
    stringField(raw, 'child_session_id') || stringField(raw, 'subagent_id') || path.basename(path.dirname(metaPath))
  const parentId = stringField(raw, 'parent_session_id')
  if (!childId || !parentId) return null
  return {
    childId,
    link: {
      parentId,
      subagentType: stringField(raw, 'subagent_type'),
      description: stringField(raw, 'description')
    }
  }
}

/** Resolve cwd for a workdir group folder (url-encoded path, or .cwd for hashed long names). */
function resolveWorkdirCwd(workdirDir: string): string {
  const cwdFile = path.join(workdirDir, '.cwd')
  if (fs.existsSync(cwdFile)) {
    try {
      const text = fs.readFileSync(cwdFile, 'utf8').trim()
      if (text) return text
    } catch (err) {
      logger.debug('grok: failed to read .cwd', cwdFile, err)
    }
  }
  const name = path.basename(workdirDir)
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function workdirDirForCwd(sessionsDir: string, cwd: string): string | null {
  const encoded = path.join(sessionsDir, encodeURIComponent(cwd))
  if (fs.existsSync(encoded)) return encoded

  // Long-path hash/slug folders store the original path in .cwd.
  for (const dir of listSubdirectories(sessionsDir)) {
    const resolved = resolveWorkdirCwd(dir)
    if (matchesCwd(resolved, cwd)) return dir
  }
  return null
}

function findSessionDirs(options: SessionParseOptions = {}): string[] {
  const sessionsDir = getGrokSessionsDir()
  if (!fs.existsSync(sessionsDir)) return []

  const workdirs = options.cwd
    ? (() => {
        const hit = workdirDirForCwd(sessionsDir, options.cwd)
        return hit ? [hit] : listSubdirectories(sessionsDir)
      })()
    : listSubdirectories(sessionsDir)

  const results: string[] = []
  for (const workdir of workdirs) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(workdir, { withFileTypes: true })
    } catch (err) {
      logger.debug('grok: cannot list workdir', workdir, err)
      continue
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(workdir, entry.name)
      let isDir = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(fullPath).isDirectory()
        } catch {
          continue
        }
      }
      if (!isDir) continue
      if (fs.existsSync(path.join(fullPath, 'summary.json'))) {
        results.push(fullPath)
      }
    }
  }
  return results
}

/** Index parent→child links from every session's subagents/<id>/meta.json. */
function buildSubagentIndex(sessionDirs: string[]): Map<string, SubagentLink> {
  const index = new Map<string, SubagentLink>()
  for (const sessionDir of sessionDirs) {
    const subagentsDir = path.join(sessionDir, 'subagents')
    if (!fs.existsSync(subagentsDir)) continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(subagentsDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const metaPath = path.join(subagentsDir, entry.name, 'meta.json')
      const parsed = readSubagentLink(metaPath)
      if (parsed) index.set(parsed.childId, parsed.link)
    }
  }
  return index
}

export async function parseGrokSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const sessionDirs = findSessionDirs(options)
  const subagentIndex = buildSubagentIndex(sessionDirs)

  const parsed = await mapConcurrent(sessionDirs, 16, async (sessionDir): Promise<UnifiedSession | null> => {
    try {
      const summaryPath = path.join(sessionDir, 'summary.json')
      const summary = parseSummary(summaryPath)
      if (!summary) return null

      // Prefer summary.cwd; fall back to decoding the parent workdir name / .cwd.
      const cwd = summary.cwd || resolveWorkdirCwd(path.dirname(sessionDir))
      if (options.cwd && cwd && !matchesCwd(cwd, options.cwd)) return null

      const chatPath = path.join(sessionDir, 'chat_history.jsonl')
      const hasChat = fs.existsSync(chatPath)
      const originalPath = hasChat ? chatPath : summaryPath

      let lines = 0
      let bytes = 0
      if (hasChat) {
        if (options.lightweight) {
          bytes = fs.statSync(chatPath).size
          lines = summary.numChatMessages ?? 0
        } else {
          const stats = await getFileStats(chatPath)
          lines = stats.lines
          bytes = stats.bytes
        }
      } else {
        try {
          bytes = fs.statSync(summaryPath).size
        } catch {
          bytes = 0
        }
      }

      const fileStats = fs.statSync(hasChat ? chatPath : summaryPath)
      const createdAt = summary.createdAt ?? fileStats.birthtime
      const updatedAt = summary.updatedAt ?? fileStats.mtime

      const subLink = subagentIndex.get(summary.id)
      const parentFromSummary = summary.parentSessionId
      const isSubagent = summary.sessionKind === 'subagent' || Boolean(subLink)
      const parentId = subLink?.parentId || (isSubagent ? parentFromSummary : undefined)
      const forkParentId = !isSubagent && parentFromSummary ? parentFromSummary : undefined
      const subagentType = isSubagent
        ? subLink?.subagentType || summary.agentName || undefined
        : undefined

      const title = summary.summary || subLink?.description || ''
      const repo =
        extractRepoFromGitUrl(summary.gitRemote || '') || (cwd ? extractRepoFromCwd(cwd) : '') || undefined

      return {
        id: summary.id,
        source: 'grok',
        cwd,
        repo,
        branch: summary.branch,
        gitSha: summary.gitSha,
        lines,
        bytes,
        createdAt,
        updatedAt,
        originalPath,
        summary: title ? cleanSummary(title, 80) : undefined,
        model: summary.model,
        variant: isSubagent ? 'subagent' : 'cli',
        parentId,
        subagentType,
        forkParentId
      }
    } catch (err) {
      logger.debug('grok: skipping unparseable session', sessionDir, err)
      return null
    }
  })

  const sessions = parsed.filter((s): s is UnifiedSession => s !== null)
  const sorted = sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  return options.limit ? sorted.slice(0, options.limit) : sorted
}

export async function extractGrokContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard')
  const chatPath = session.originalPath.endsWith('.jsonl')
    ? session.originalPath
    : path.join(path.dirname(session.originalPath), 'chat_history.jsonl')

  const records = await readJsonlFile<Record<string, unknown>>(chatPath)

  const messages: ConversationMessage[] = []
  const timeline: SessionEvent[] = []
  const filesModified = new Set<string>()
  let seq = 0

  for (const rec of records) {
    if (!isRecord(rec)) continue
    const type = stringField(rec, 'type')

    if (type === 'user') {
      const text = extractUserFacingText(rec)
      if (!text) continue
      messages.push({ role: 'user', content: text })
      timeline.push({ kind: 'message', sequence: seq++, role: 'user', content: text })
      continue
    }

    if (type === 'assistant') {
      const text = typeof rec.content === 'string' ? rec.content : contentToText(rec.content)
      const toolCalls: ToolCall[] = []
      const rawCalls = Array.isArray(rec.tool_calls) ? rec.tool_calls : []

      for (const call of rawCalls) {
        if (!isRecord(call)) continue
        const name = stringField(call, 'name') || 'tool'
        const id = stringField(call, 'id')
        const args = parseToolArguments(call.arguments)
        toolCalls.push({ name, id, arguments: args })

        const filePath =
          (args && (stringField(args, 'path') || stringField(args, 'file_path') || stringField(args, 'target_file'))) ||
          undefined
        if (filePath && (name === 'search_replace' || name === 'Write' || name === 'write' || name === 'Edit')) {
          filesModified.add(filePath)
        }

        timeline.push({
          kind: 'tool_call',
          sequence: seq++,
          toolName: name,
          toolCallId: id,
          arguments: args,
          role: 'assistant'
        })
      }

      if (text || toolCalls.length) {
        messages.push({
          role: 'assistant',
          content: text || (toolCalls.length ? `[Used tools: ${toolCalls.map((t) => t.name).join(', ')}]` : ''),
          toolCalls: toolCalls.length ? toolCalls : undefined
        })
        if (text) timeline.push({ kind: 'message', sequence: seq++, role: 'assistant', content: text })
      }
      continue
    }

    if (type === 'reasoning') {
      const text = reasoningText(rec)
      if (text) timeline.push({ kind: 'reasoning', sequence: seq++, content: text, role: 'assistant' })
      continue
    }

    if (type === 'tool_result') {
      const result = typeof rec.content === 'string' ? rec.content : contentToText(rec.content)
      timeline.push({
        kind: 'tool_result',
        sequence: seq++,
        toolCallId: stringField(rec, 'tool_call_id'),
        result
      })
      continue
    }

    if (type === 'backend_tool_call') {
      const kind = isRecord(rec.kind) ? rec.kind : undefined
      const toolType = stringField(kind, 'tool_type') || 'backend_tool'
      const action = isRecord(kind?.action) ? kind.action : undefined
      timeline.push({
        kind: 'tool_call',
        sequence: seq++,
        toolName: toolType,
        toolCallId: stringField(kind, 'id') || stringField(rec, 'id'),
        arguments: action,
        role: 'assistant'
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
