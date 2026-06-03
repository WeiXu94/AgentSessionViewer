import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import type { TranscriptPayload, ViewNode } from '../../shared/ipc.js'
import { cap, formatArgs, NodeBuilder, roleToKind } from './shared.js'

interface SqlitePreparedStatement {
  all(...params: unknown[]): unknown[]
}

interface SqliteDatabase {
  prepare(sql: string): SqlitePreparedStatement
  close(): void
}

interface SqliteMessageRow {
  id: string
  session_id: string
  time_created: number
  data: string
}

interface SqlitePartRow {
  id: string
  message_id: string
  session_id: string
  time_created: number
  data: string
}

interface OpenCodePartRecord {
  id: string
  timeCreated: number
  type?: string
  toolName?: string
  data: unknown
}

interface OpenCodeMessageRecord {
  id: string
  role: 'user' | 'assistant' | 'system'
  timeCreated: number
  data: unknown
  parts: OpenCodePartRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return ''
}

function stringifyToolValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return undefined

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function openDb(dbPath: string): { db: SqliteDatabase; close: () => void } | null {
  try {
    const require = createRequire(import.meta.url)
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (filename: string, options: { open: boolean; readOnly: boolean }) => SqliteDatabase
    }
    const db = new sqlite.DatabaseSync(dbPath, { open: true, readOnly: true })
    return { db, close: () => db.close() }
  } catch {
    return null
  }
}

function roleFromData(data: unknown): OpenCodeMessageRecord['role'] {
  if (!isRecord(data)) return 'user'
  if (data.role === 'assistant') return 'assistant'
  if (data.role === 'system') return 'system'
  return 'user'
}

function recordFromPartRow(row: SqlitePartRow): OpenCodePartRecord {
  const data = parseJson(row.data)
  const type = isRecord(data) && typeof data.type === 'string' ? data.type : undefined
  const toolName = isRecord(data) && typeof data.tool === 'string' ? data.tool : undefined
  return { id: row.id, timeCreated: row.time_created, type, toolName, data }
}

function readSqliteRecords(dbPath: string, sessionId: string): OpenCodeMessageRecord[] | null {
  if (!fs.existsSync(dbPath)) return null

  const handle = openDb(dbPath)
  if (!handle) return null

  const { db, close } = handle
  try {
    const messageRows = db
      .prepare('SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC')
      .all(sessionId) as SqliteMessageRow[]

    if (messageRows.length === 0) return null

    const partStmt = db.prepare(
      'SELECT id, message_id, session_id, time_created, data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC'
    )

    return messageRows.map((row) => {
      const data = parseJson(row.data)
      const partRows = partStmt.all(row.id) as SqlitePartRow[]
      return {
        id: row.id,
        role: roleFromData(data),
        timeCreated: row.time_created,
        data,
        parts: partRows.map(recordFromPartRow)
      }
    })
  } finally {
    close()
  }
}

function findStorageDir(filePath: string): string | null {
  let dir = path.dirname(filePath)
  while (dir && dir !== path.dirname(dir)) {
    if (path.basename(dir) === 'storage') return dir
    dir = path.dirname(dir)
  }
  return null
}

function readJsonFile(filePath: string): unknown {
  return parseJson(fs.readFileSync(filePath, 'utf8'))
}

function readJsonParts(storageDir: string, messageId: string): OpenCodePartRecord[] {
  const partDir = path.join(storageDir, 'part', messageId)
  if (!fs.existsSync(partDir)) return []

  return fs
    .readdirSync(partDir)
    .filter((fileName) => fileName.startsWith('prt_') && fileName.endsWith('.json'))
    .sort()
    .map((fileName) => {
      const filePath = path.join(partDir, fileName)
      const data = readJsonFile(filePath)
      const part = isRecord(data) ? data : {}
      const id = typeof part.id === 'string' ? part.id : path.basename(fileName, '.json')
      const time = isRecord(part.time) && typeof part.time.created === 'number' ? part.time.created : 0
      const type = typeof part.type === 'string' ? part.type : undefined
      const toolName = typeof part.tool === 'string' ? part.tool : undefined
      return { id, timeCreated: time, type, toolName, data }
    })
}

function readJsonRecords(sessionPath: string, sessionId: string): OpenCodeMessageRecord[] | null {
  const storageDir = findStorageDir(sessionPath)
  if (!storageDir) return null

  const messageDir = path.join(storageDir, 'message', sessionId)
  if (!fs.existsSync(messageDir)) return null

  const records = fs
    .readdirSync(messageDir)
    .filter((fileName) => fileName.startsWith('msg_') && fileName.endsWith('.json'))
    .sort()
    .map((fileName) => {
      const filePath = path.join(messageDir, fileName)
      const data = readJsonFile(filePath)
      const message = isRecord(data) ? data : {}
      const id = typeof message.id === 'string' ? message.id : path.basename(fileName, '.json')
      const time = isRecord(message.time) && typeof message.time.created === 'number' ? message.time.created : 0
      return {
        id,
        role: roleFromData(data),
        timeCreated: time,
        data,
        parts: readJsonParts(storageDir, id)
      }
    })

  return records.length > 0 ? records : null
}

function toolResultFromState(state: Record<string, unknown>): { text: string; isError: boolean } | null {
  if (Object.prototype.hasOwnProperty.call(state, 'output')) {
    return { text: stringifyToolValue(state.output) ?? '(no output)', isError: false }
  }
  if (Object.prototype.hasOwnProperty.call(state, 'error')) {
    return { text: stringifyToolValue(state.error) ?? '(no error text)', isError: true }
  }
  return null
}

function addGenericPartNode(b: NodeBuilder, rawIndex: number, role: OpenCodeMessageRecord['role'], part: Record<string, unknown>): void {
  const type = typeof part.type === 'string' ? part.type : 'part'
  const state = isRecord(part.state) ? part.state : undefined
  const text =
    firstString(part, ['text', 'summary', 'message', 'content', 'patch', 'diff']) ||
    (state ? firstString(state, ['output', 'error', 'title', 'input']) : '')

  if (!text) return
  b.add(rawIndex, 'meta', text, { title: cap(type) })
}

function addPartNode(b: NodeBuilder, rawIndex: number, role: OpenCodeMessageRecord['role'], partRecord: OpenCodePartRecord): void {
  if (!isRecord(partRecord.data)) return

  const part = partRecord.data
  const type = typeof part.type === 'string' ? part.type : ''
  switch (type) {
    case 'step-start':
    case 'step-finish':
      return

    case 'text': {
      const text = firstString(part, ['text', 'content'])
      const kind = roleToKind(role)
      if (text) b.add(rawIndex, kind, text, { role: kind === 'system' ? 'system' : role, title: cap(role) })
      return
    }

    case 'reasoning': {
      const text = firstString(part, ['text', 'summary', 'content'])
      if (text) b.add(rawIndex, 'thinking', text, { role: 'assistant', title: 'Reasoning' })
      return
    }

    case 'tool': {
      const toolName = typeof part.tool === 'string' ? part.tool : 'tool'
      const state = isRecord(part.state) ? part.state : {}
      const status = typeof state.status === 'string' ? state.status : ''
      const title = status ? `${toolName} ${status}` : toolName

      b.add(rawIndex, 'tool_call', formatArgs(state.input), {
        role: 'assistant',
        toolName,
        title
      })

      const result = toolResultFromState(state)
      if (result) {
        b.add(rawIndex, 'tool_result', result.text, {
          role: 'assistant',
          title: result.isError ? `${toolName} error` : `${toolName} result`
        })
      }
      return
    }

    default:
      addGenericPartNode(b, rawIndex, role, part)
  }
}

export function opencodeNodes(records: unknown[]): ViewNode[] {
  const b = new NodeBuilder()

  records.forEach((record, i) => {
    if (!isRecord(record) || !Array.isArray(record.parts)) return
    const role = roleFromData(record.data)
    for (const part of record.parts) {
      if (isRecord(part)) addPartNode(b, i, role, part as unknown as OpenCodePartRecord)
    }
  })

  return b.result()
}

export function loadOpenCodePayload(originalPath: string, sessionId: string): TranscriptPayload | null {
  const isDb = originalPath.toLowerCase().endsWith('.db')
  const records = isDb ? readSqliteRecords(originalPath, sessionId) : readJsonRecords(originalPath, sessionId)
  if (!records) return null

  return {
    source: 'opencode',
    originalPath,
    reconstructed: true,
    records,
    nodes: opencodeNodes(records)
  }
}
