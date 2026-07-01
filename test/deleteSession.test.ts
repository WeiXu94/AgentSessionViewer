import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createRequire } from 'node:module'
import { deleteSession } from '../src/main/deleteSession.ts'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string, options?: { open?: boolean; readOnly?: boolean }) => {
    prepare(sql: string): {
      run(...p: unknown[]): unknown
      all(...p: unknown[]): unknown[]
      get(...p: unknown[]): unknown
    }
    exec(sql: string): void
    close(): void
  }
}

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asv-test-')), 'test.db')
}

/** Build a minimal OpenCode schema with the tables our DELETEs touch. */
function makeOpenCodeDb(dbPath: string, sessionId: string): void {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: false })
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE project (id TEXT, worktree TEXT);
  `)
  db.prepare('INSERT INTO session (id, title, time_created, time_updated) VALUES (?, ?, ?, ?)').run(
    sessionId, 'hello', 1, 2
  )
  db.prepare('INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)').run(
    'msg1', sessionId, '{}', 3
  )
  db.prepare('INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)').run(
    'part1', 'msg1', sessionId, '{}', 4
  )
  // A second session that must survive the delete.
  db.prepare('INSERT INTO session (id, title, time_created, time_updated) VALUES (?, ?, ?, ?)').run(
    'other', 'keep me', 5, 6
  )
  db.prepare('INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)').run(
    'msg2', 'other', '{}', 7
  )
  db.close()
}

function count(dbPath: string, table: string, where: string, param: string): number {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(param) as { n: number }
  db.close()
  return row.n
}

describe('deleteSession — opencode DB', () => {
  it('deletes part/message/session rows for the target session only, returns kind=db', async () => {
    const dbPath = tmpDbPath()
    makeOpenCodeDb(dbPath, 'sess-A')
    const res = await deleteSession('opencode', 'sess-A', dbPath)
    assert.equal(res.ok, true)
    assert.equal(res.kind, 'db')
    assert.equal(count(dbPath, 'part', 'session_id = ?', 'sess-A'), 0)
    assert.equal(count(dbPath, 'message', 'session_id = ?', 'sess-A'), 0)
    assert.equal(count(dbPath, 'session', 'id = ?', 'sess-A'), 0)
    // Other session untouched.
    assert.equal(count(dbPath, 'session', 'id = ?', 'other'), 1)
    assert.equal(count(dbPath, 'message', 'session_id = ?', 'other'), 1)
  })
})

/** Crush uses plural table names: `sessions` + `messages`. */
function makeCrushDb(dbPath: string, sessionId: string): void {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: false })
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER);
    CREATE TABLE messages (id TEXT, session_id TEXT, role TEXT, parts TEXT);
  `)
  db.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run(sessionId, 1)
  db.prepare('INSERT INTO messages (id, session_id, role, parts) VALUES (?, ?, ?, ?)').run('m1', sessionId, 'user', '[]')
  db.prepare('INSERT INTO sessions (id, created_at) VALUES (?, ?)').run('keep', 2)
  db.close()
}

describe('deleteSession — crush DB', () => {
  it('deletes messages/sessions rows, leaves other sessions intact', async () => {
    const dbPath = tmpDbPath()
    makeCrushDb(dbPath, 'sess-C')
    const res = await deleteSession('crush', 'sess-C', dbPath)
    assert.equal(res.ok, true)
    assert.equal(res.kind, 'db')
    assert.equal(count(dbPath, 'messages', 'session_id = ?', 'sess-C'), 0)
    assert.equal(count(dbPath, 'sessions', 'id = ?', 'sess-C'), 0)
    assert.equal(count(dbPath, 'sessions', 'id = ?', 'keep'), 1)
  })
})

/** Kilo mirrors opencode table names but parts are linked by message_id. */
function makeKiloDb(dbPath: string, sessionId: string): void {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: false })
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER);
    CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT, message_id TEXT, data TEXT, time_created INTEGER);
  `)
  db.prepare('INSERT INTO session (id, time_created) VALUES (?, ?)').run(sessionId, 1)
  db.prepare('INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)').run('km1', sessionId, '{}', 2)
  db.prepare('INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)').run('kp1', 'km1', '{}', 3)
  db.prepare('INSERT INTO session (id, time_created) VALUES (?, ?)').run('keep', 4)
  db.close()
}

describe('deleteSession — kilo-code DB', () => {
  it('deletes part (via message subquery)/message/session rows', async () => {
    const dbPath = tmpDbPath()
    makeKiloDb(dbPath, 'sess-K')
    const res = await deleteSession('kilo-code', 'sess-K', dbPath)
    assert.equal(res.ok, true)
    assert.equal(res.kind, 'db')
    assert.equal(count(dbPath, 'part', 'message_id = ?', 'km1'), 0)
    assert.equal(count(dbPath, 'message', 'session_id = ?', 'sess-K'), 0)
    assert.equal(count(dbPath, 'session', 'id = ?', 'sess-K'), 0)
    assert.equal(count(dbPath, 'session', 'id = ?', 'keep'), 1)
  })
})

describe('deleteSession — file-backed', () => {
  it('calls the injected trashItem with the path and returns kind=file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asv-file-'))
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, '{}')
    let trashed: string | undefined
    const res = await deleteSession('claude', 'abc', file, {
      trashItem: async (p) => {
        trashed = p
      }
    })
    assert.equal(res.ok, true)
    assert.equal(res.kind, 'file')
    assert.equal(trashed, file)
  })
})

describe('deleteSession — error paths', () => {
  it('returns ok=false when the DB file does not exist', async () => {
    const res = await deleteSession('opencode', 'x', '/nope/missing.db')
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /Database file not found/)
  })

  it('returns ok=false when the session file does not exist', async () => {
    const res = await deleteSession('claude', 'x', '/nope/missing.jsonl', {
      trashItem: async () => {
        throw new Error('should not be called')
      }
    })
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /Session file not found/)
  })
})

describe('deleteSession — file fallback for non-db paths', () => {
  it('a db-backed source with a non-.db path is trashed as a file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asv-oc-json-'))
    const file = path.join(dir, 'session.json')
    fs.writeFileSync(file, '{}')
    let trashed: string | undefined
    const res = await deleteSession('opencode', 'legacy', file, {
      trashItem: async (p) => {
        trashed = p
      }
    })
    assert.equal(res.ok, true)
    assert.equal(res.kind, 'file')
    assert.equal(trashed, file)
  })
})

describe('deleteSession — schema resilience', () => {
  it('tolerates a missing `part` table in an opencode db (safeDelete)', async () => {
    const dbPath = tmpDbPath()
    const db = new DatabaseSync(dbPath, { open: true, readOnly: false })
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT, session_id TEXT);
    `)
    db.prepare('INSERT INTO session (id) VALUES (?)').run('sess-S')
    db.prepare('INSERT INTO message (id, session_id) VALUES (?, ?)').run('m', 'sess-S')
    db.close()

    const res = await deleteSession('opencode', 'sess-S', dbPath)
    assert.equal(res.ok, true)
    assert.equal(res.kind, 'db')
    assert.equal(count(dbPath, 'session', 'id = ?', 'sess-S'), 0)
    assert.equal(count(dbPath, 'message', 'session_id = ?', 'sess-S'), 0)
  })
})
