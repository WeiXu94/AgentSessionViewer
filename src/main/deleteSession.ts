import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { shell } from 'electron'

/**
 * Deleting a session differs by storage model:
 *
 * - File-based sources (claude, codex, pi, gemini, …) keep one file per
 *   session → `shell.trashItem` moves it to the OS trash.
 * - DB-backed sources (opencode, crush, kilo-code) share a single SQLite .db
 *   across all sessions → we DELETE the session's rows from the database.
 *
 * The kind is returned so the renderer can show an accurate toast and decide
 * whether a full rescan is needed (DB deletes change the shared file, so the
 * in-memory + on-disk metadata caches must be invalidated).
 */

export interface DeleteSessionResult {
  ok: boolean
  /** 'file' = trashed a file/dir, 'db' = deleted rows from a SQLite db. */
  kind?: 'file' | 'db'
  error?: string
}

/** Sources whose `originalPath` is a shared SQLite database, not a per-session file. */
const DB_BACKED_SOURCES = new Set(['opencode', 'crush', 'kilo-code'])

interface SqliteDatabase {
  prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] }
  close(): void
  exec(sql: string): void
}

function isDbBacked(source: string, originalPath: string): boolean {
  return DB_BACKED_SOURCES.has(source) && originalPath.toLowerCase().endsWith('.db')
}

function openReadWrite(dbPath: string): SqliteDatabase | null {
  try {
    const require = createRequire(import.meta.url)
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (filename: string, options?: { open?: boolean; readOnly?: boolean }) => SqliteDatabase
    }
    return new sqlite.DatabaseSync(dbPath, { open: true, readOnly: false })
  } catch {
    return null
  }
}

/** Run a DELETE, tolerating a missing table (older schemas). */
function safeDelete(db: SqliteDatabase, sql: string, sessionId: string): void {
  try {
    db.prepare(sql).run(sessionId)
  } catch (err) {
    // Table or column may not exist on older schemas — non-fatal; the session
    // row itself is what matters most.
    console.debug('[deleteSession] non-fatal DELETE failed:', sql, (err as Error)?.message ?? err)
  }
}

function deleteFromOpenCodeDb(dbPath: string, sessionId: string): void {
  const db = openReadWrite(dbPath)
  if (!db) throw new Error('Could not open OpenCode database for writing.')
  try {
    safeDelete(db, 'DELETE FROM part WHERE session_id = ?', sessionId)
    safeDelete(db, 'DELETE FROM message WHERE session_id = ?', sessionId)
    safeDelete(db, 'DELETE FROM session WHERE id = ?', sessionId)
  } finally {
    db.close()
  }
}

function deleteFromCrushDb(dbPath: string, sessionId: string): void {
  const db = openReadWrite(dbPath)
  if (!db) throw new Error('Could not open Crush database for writing.')
  try {
    safeDelete(db, 'DELETE FROM messages WHERE session_id = ?', sessionId)
    safeDelete(db, 'DELETE FROM sessions WHERE id = ?', sessionId)
  } finally {
    db.close()
  }
}

function deleteFromKiloDb(dbPath: string, sessionId: string): void {
  const db = openReadWrite(dbPath)
  if (!db) throw new Error('Could not open Kilo database for writing.')
  try {
    safeDelete(db, 'DELETE FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id = ?)', sessionId)
    safeDelete(db, 'DELETE FROM message WHERE session_id = ?', sessionId)
    safeDelete(db, 'DELETE FROM session WHERE id = ?', sessionId)
  } finally {
    db.close()
  }
}

export async function deleteSession(source: string, id: string, originalPath: string): Promise<DeleteSessionResult> {
  try {
    if (isDbBacked(source, originalPath)) {
      if (!fs.existsSync(originalPath)) {
        return { ok: false, error: 'Database file not found.' }
      }
      if (source === 'opencode') deleteFromOpenCodeDb(originalPath, id)
      else if (source === 'crush') deleteFromCrushDb(originalPath, id)
      else if (source === 'kilo-code') deleteFromKiloDb(originalPath, id)
      else return { ok: false, error: `DB deletion not supported for source "${source}".` }
      return { ok: true, kind: 'db' }
    }

    // File- or directory-backed session → OS trash.
    if (!originalPath || !fs.existsSync(originalPath)) {
      return { ok: false, error: 'Session file not found.' }
    }
    await shell.trashItem(originalPath)
    return { ok: true, kind: 'file' }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) }
  }
}
