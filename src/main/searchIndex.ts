import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { app } from 'electron'
import type {
  GlobalSearchGroup,
  GlobalSearchMatch,
  GlobalSearchResponse,
  SearchIndexProgress,
  SearchScopeFilter,
  SessionMeta
} from '../shared/ipc.js'
import { loadTranscript } from './transcript.js'

// Full-text index over user messages and assistant text across every session.
// Backed by node:sqlite FTS5 (bm25 ranking) — same built-in module the
// opencode/crush/cline parsers already rely on, so no native dependency.

const DB_FILE = 'search-index.db'
const SCHEMA_VERSION = 1
/** Per-message cap keeps pathological pastes from bloating the index. */
const MAX_MESSAGE_CHARS = 256 * 1024
const MATCH_LIMIT = 300
const MATCHES_PER_SESSION = 5

interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

function dbPath(): string {
  try {
    return path.join(app.getPath('userData'), DB_FILE)
  } catch {
    return path.join(os.homedir(), '.agentsessionviewer', DB_FILE)
  }
}

// NOT the indexer's NUL separator: node:sqlite truncates TEXT at embedded NUL
// bytes when reading values back. The key includes originalPath because
// source+id alone can collide (e.g. Claude subagent transcripts that carry the
// parent's session id); it is never split — source/id/path live in their own
// columns and queries read those.
function sessionKey(meta: SessionMeta): string {
  return `${meta.source}:${meta.id}:${meta.originalPath}`
}

// undefined = not opened yet, null = node:sqlite unavailable / open failed
let db: SqliteDatabase | null | undefined

function openDb(): SqliteDatabase | null {
  if (db !== undefined) return db
  try {
    const require = createRequire(import.meta.url)
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (filename: string) => SqliteDatabase
    }
    const file = dbPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const handle = new sqlite.DatabaseSync(file)
    migrate(handle)
    db = handle
  } catch (err) {
    console.warn('[searchIndex] unavailable:', (err as Error)?.message ?? err)
    db = null
  }
  return db
}

function migrate(handle: SqliteDatabase): void {
  handle.exec('PRAGMA journal_mode = WAL')
  const row = (() => {
    try {
      return handle.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined
    } catch {
      return undefined
    }
  })()
  if (row && Number(row.value) === SCHEMA_VERSION) return

  handle.exec(`
    DROP TABLE IF EXISTS messages_fts;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS meta;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (
      session_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      id TEXT NOT NULL,
      repo TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      original_path TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_key TEXT NOT NULL,
      node_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX idx_messages_session ON messages(session_key);
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    INSERT INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
  `)
}

// ── Background sync ──────────────────────────────────────────────────

let syncRunning = false
let pendingMetas: SessionMeta[] | null = null
let lastProgress: SearchIndexProgress = { indexed: 0, total: 0, done: true }

/**
 * Bring the index up to date with the latest session listing. Cheap when
 * nothing changed (fingerprint check per session); only re-reads transcripts
 * whose updatedAt/bytes moved. Safe to call repeatedly — runs are serialized
 * and a call during a run queues the newest metas for one follow-up pass.
 */
export function syncSearchIndex(metas: SessionMeta[], onProgress?: (p: SearchIndexProgress) => void): void {
  pendingMetas = metas
  if (syncRunning) return
  syncRunning = true
  void (async () => {
    try {
      while (pendingMetas) {
        const batch = pendingMetas
        pendingMetas = null
        await runSync(batch, onProgress)
      }
    } finally {
      syncRunning = false
    }
  })()
}

export function searchIndexProgress(): SearchIndexProgress {
  return lastProgress
}

function report(onProgress: ((p: SearchIndexProgress) => void) | undefined, p: SearchIndexProgress): void {
  lastProgress = p
  onProgress?.(p)
}

async function runSync(metas: SessionMeta[], onProgress?: (p: SearchIndexProgress) => void): Promise<void> {
  const handle = openDb()
  if (!handle) return

  const known = new Map<string, { updated_at: number; bytes: number }>()
  for (const row of handle.prepare('SELECT session_key, updated_at, bytes FROM sessions').all() as Array<{
    session_key: string
    updated_at: number
    bytes: number
  }>) {
    known.set(row.session_key, row)
  }

  const liveKeys = new Set(metas.map(sessionKey))
  const deleteMessages = handle.prepare('DELETE FROM messages WHERE session_key = ?')
  const deleteSession = handle.prepare('DELETE FROM sessions WHERE session_key = ?')
  for (const key of known.keys()) {
    if (!liveKeys.has(key)) {
      deleteMessages.run(key)
      deleteSession.run(key)
      known.delete(key)
    }
  }

  const stale = metas.filter((m) => {
    const row = known.get(sessionKey(m))
    return !row || row.updated_at !== m.updatedAt || row.bytes !== m.bytes
  })
  if (stale.length === 0) {
    report(onProgress, { indexed: metas.length, total: metas.length, done: true })
    return
  }

  const insertMessage = handle.prepare(
    'INSERT INTO messages (session_key, node_index, kind, text) VALUES (?, ?, ?, ?)'
  )
  const upsertSession = handle.prepare(`
    INSERT INTO sessions (session_key, source, id, repo, cwd, summary, original_path, updated_at, bytes, message_count, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      repo = excluded.repo, cwd = excluded.cwd, summary = excluded.summary,
      original_path = excluded.original_path, updated_at = excluded.updated_at,
      bytes = excluded.bytes, message_count = excluded.message_count, indexed_at = excluded.indexed_at
  `)

  let done = metas.length - stale.length
  report(onProgress, { indexed: done, total: metas.length, done: false })

  for (const meta of stale) {
    const key = sessionKey(meta)
    try {
      const payload = await loadTranscript(meta.originalPath, meta.source, meta.id)
      const rows: Array<{ nodeIndex: number; kind: string; text: string }> = []
      if (!payload.error) {
        payload.nodes.forEach((node, nodeIndex) => {
          if (node.kind !== 'user' && node.kind !== 'assistant') return
          // Inherited fork nodes duplicate the parent session's content.
          if (node.inherited) return
          const text = node.text.trim()
          if (!text) return
          rows.push({ nodeIndex, kind: node.kind, text: text.slice(0, MAX_MESSAGE_CHARS) })
        })
      }

      handle.exec('BEGIN')
      try {
        deleteMessages.run(key)
        for (const row of rows) insertMessage.run(key, row.nodeIndex, row.kind, row.text)
        upsertSession.run(
          key,
          meta.source,
          meta.id,
          meta.repo ?? '',
          meta.cwd ?? '',
          meta.summary ?? '',
          meta.originalPath,
          meta.updatedAt,
          meta.bytes,
          rows.length,
          Date.now()
        )
        handle.exec('COMMIT')
      } catch (err) {
        handle.exec('ROLLBACK')
        throw err
      }
    } catch (err) {
      console.warn(`[searchIndex] failed to index ${meta.source}/${meta.id}:`, (err as Error)?.message ?? err)
    }
    done++
    report(onProgress, { indexed: done, total: metas.length, done: false })
    // Yield between sessions so IPC handlers stay responsive during a big backfill.
    await new Promise((resolve) => setImmediate(resolve))
  }

  report(onProgress, { indexed: metas.length, total: metas.length, done: true })
}

// ── Query ────────────────────────────────────────────────────────────

/**
 * Build an FTS5 MATCH expression from free text: each token quoted (so user
 * input can't break the query syntax) and prefix-starred for find-as-you-type.
 */
function ftsExpression(query: string): string {
  const tokens = query
    .split(/\s+/u)
    .map((t) => t.replace(/"/gu, '').trim())
    .filter(Boolean)
  if (tokens.length === 0) return ''
  return tokens.map((t) => `"${t.replace(/\\/gu, '')}"*`).join(' ')
}

interface MatchRow {
  session_key: string
  source: string
  id: string
  original_path: string
  node_index: number
  kind: string
  snippet: string
  rank: number
}

export function searchSessions(
  query: string,
  scope: SearchScopeFilter | undefined,
  resolveMeta: (source: string, id: string, originalPath: string) => SessionMeta | undefined
): GlobalSearchResponse {
  const handle = openDb()
  const indexing = !lastProgress.done
  if (!handle) return { available: false, indexing, groups: [], totalSessions: 0 }

  const expression = ftsExpression(query)
  if (!expression) return { available: true, indexing, groups: [], totalSessions: 0 }

  const where: string[] = ['messages_fts MATCH ?']
  const params: unknown[] = [expression]
  if (scope?.repo) {
    where.push('s.repo = ?')
    params.push(scope.repo)
  } else if (scope?.cwd) {
    where.push('s.cwd = ?')
    params.push(scope.cwd)
  }

  let rows: MatchRow[]
  try {
    rows = handle
      .prepare(
        `SELECT m.session_key, s.source, s.id, s.original_path, m.node_index, m.kind,
                snippet(messages_fts, 0, char(2), char(3), ' … ', 14) AS snippet,
                bm25(messages_fts) AS rank
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.session_key = m.session_key
         WHERE ${where.join(' AND ')}
         ORDER BY rank
         LIMIT ${MATCH_LIMIT}`
      )
      .all(...params) as MatchRow[]
  } catch (err) {
    console.warn('[searchIndex] query failed:', (err as Error)?.message ?? err)
    return { available: true, indexing, groups: [], totalSessions: 0 }
  }

  // Group by session, keep result order (= best bm25 rank first).
  interface GroupAcc {
    source: string
    id: string
    originalPath: string
    matches: GlobalSearchMatch[]
    totalMatches: number
  }
  const groups = new Map<string, GroupAcc>()
  for (const row of rows) {
    const group =
      groups.get(row.session_key) ??
      ({ source: row.source, id: row.id, originalPath: row.original_path, matches: [], totalMatches: 0 } as GroupAcc)
    group.totalMatches++
    if (group.matches.length < MATCHES_PER_SESSION) {
      group.matches.push({
        nodeIndex: row.node_index,
        kind: row.kind === 'assistant' ? 'assistant' : 'user',
        snippet: row.snippet
      })
    }
    groups.set(row.session_key, group)
  }

  const out: GlobalSearchGroup[] = []
  for (const group of groups.values()) {
    const meta = resolveMeta(group.source, group.id, group.originalPath)
    if (!meta) continue // session disappeared since indexing; sync will prune it
    group.matches.sort((a, b) => a.nodeIndex - b.nodeIndex)
    out.push({ session: meta, matches: group.matches, totalMatches: group.totalMatches })
  }

  return { available: true, indexing, groups: out, totalSessions: out.length }
}
