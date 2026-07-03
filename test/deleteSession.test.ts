import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { deleteSession } from '../src/main/deleteSession.ts'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string, options?: { open?: boolean; readOnly?: boolean }) => {
    exec(sql: string): void
    prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown }
    close(): void
  }
}

let tmpDir: string

function tmpPath(name: string): string {
  return path.join(tmpDir, name)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asv-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Count rows in `table` where `col = value`. */
function countRows(dbPath: string, table: string, col: string, value: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const stmt = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`)
    const row = stmt.get(value) as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

describe('deleteSession — edge cases', () => {
  it('tolerates a missing part table (older opencode schema)', async () => {
    const dbPath = tmpPath('opencode-nopart.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, role TEXT);
    `)
    db.prepare('INSERT INTO session (id, title) VALUES (?, ?)').run('s1', 'hello')
    db.prepare('INSERT INTO message (id, session_id, role) VALUES (?, ?, ?)').run('m1', 's1', 'user')
    db.close()

    const res = await deleteSession('opencode', 's1', dbPath)

    assert.equal(res.ok, true)
    assert.equal(res.kind, 'db')
    assert.equal(countRows(dbPath, 'message', 'session_id', 's1'), 0)
    assert.equal(countRows(dbPath, 'session', 'id', 's1'), 0)
  })

  it('routes an opencode JSON path (non-.db) to file trash', async () => {
    // opencode is db-backed only when originalPath ends with .db; the legacy
    // JSON-file mode should be trashed like any other file source.
    const filePath = tmpPath('session.json')
    fs.writeFileSync(filePath, '{}')
    let received: string | null = null
    const res = await deleteSession('opencode', 'x', filePath, {
      trashItem: async (p) => {
        received = p
      }
    })
    assert.equal(res.ok, true)
    assert.equal(res.kind, 'file')
    assert.equal(received, filePath)
  })

  it('routes a non-db-backed source with a .db path to file trash', async () => {
    // A source not in the DB_BACKED set is always treated as file-backed,
    // even if the path happens to end in .db.
    const filePath = tmpPath('weird.db')
    fs.writeFileSync(filePath, 'x')
    let received: string | null = null
    const res = await deleteSession('claude', 'x', filePath, {
      trashItem: async (p) => {
        received = p
      }
    })
    assert.equal(res.ok, true)
    assert.equal(res.kind, 'file')
    assert.equal(received, filePath)
  })
})

describe('deleteSession — missing targets', () => {
  it('returns ok:false when the DB file does not exist', async () => {
    const res = await deleteSession('opencode', 's1', tmpPath('nope.db'))
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /Database file not found/)
  })

  it('returns ok:false when the source file does not exist', async () => {
    const res = await deleteSession('claude', 'x', tmpPath('missing.jsonl'))
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /Session file not found/)
  })
})

describe('deleteSession — file-backed trash', () => {
  it('calls the injected trashItem with the path and reports kind=file', async () => {
    const filePath = tmpPath('session.jsonl')
    fs.writeFileSync(filePath, '{}')
    let received: string | null = null

    const res = await deleteSession('claude', 'abc', filePath, {
      trashItem: async (p) => {
        received = p
      }
    })

    assert.equal(res.ok, true)
    assert.equal(res.kind, 'file')
    assert.equal(received, filePath)
  })
})

describe('deleteSession — kilo-code DB', () => {
  it('deletes part (via message subquery), message, and session rows', async () => {
    const dbPath = tmpPath('kilo.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, role TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, type TEXT);
    `)
    db.prepare('INSERT INTO session (id, title) VALUES (?, ?)').run('k1', 'kilo s')
    db.prepare('INSERT INTO message (id, session_id, role) VALUES (?, ?, ?)').run('km1', 'k1', 'user')
    db.prepare('INSERT INTO part (id, message_id, type) VALUES (?, ?, ?)').run('kp1', 'km1', 'text')
    db.prepare('INSERT INTO session (id, title) VALUES (?, ?)').run('k2', 'keep')
    db.close()

    const res = await deleteSession('kilo-code', 'k1', dbPath)

    assert.equal(res.ok, true)
    assert.equal(res.kind, 'db')
    // part has no session_id; verify via the message that belonged to k1.
    const db2 = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db2.prepare('SELECT COUNT(*) AS n FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id = ?)').get('k1') as { n: number }
      assert.equal(row.n, 0)
    } finally {
      db2.close()
    }
    assert.equal(countRows(dbPath, 'message', 'session_id', 'k1'), 0)
    assert.equal(countRows(dbPath, 'session', 'id', 'k1'), 0)
    assert.equal(countRows(dbPath, 'session', 'id', 'k2'), 1)
  })
})

describe('deleteSession — crush DB', () => {
  it('deletes messages and sessions rows for the session', async () => {
    const dbPath = tmpPath('crush.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE messages (id TEXT, session_id TEXT, role TEXT);
    `)
    db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run('c1', 'crush s')
    db.prepare('INSERT INTO messages (id, session_id, role) VALUES (?, ?, ?)').run('cm1', 'c1', 'user')
    db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run('c2', 'keep')
    db.close()

    const res = await deleteSession('crush', 'c1', dbPath)

    assert.equal(res.ok, true)
    assert.equal(res.kind, 'db')
    assert.equal(countRows(dbPath, 'messages', 'session_id', 'c1'), 0)
    assert.equal(countRows(dbPath, 'sessions', 'id', 'c1'), 0)
    assert.equal(countRows(dbPath, 'sessions', 'id', 'c2'), 1)
  })
})

describe('deleteSession — opencode DB', () => {
  it('deletes part, message, and session rows for the session', async () => {
    const dbPath = tmpPath('opencode.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, role TEXT);
      CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, type TEXT);
    `)
    db.prepare('INSERT INTO session (id, title) VALUES (?, ?)').run('s1', 'hello')
    db.prepare('INSERT INTO message (id, session_id, role) VALUES (?, ?, ?)').run('m1', 's1', 'user')
    db.prepare('INSERT INTO part (id, session_id, message_id, type) VALUES (?, ?, ?, ?)').run('p1', 's1', 'm1', 'text')
    // An unrelated session that must survive.
    db.prepare('INSERT INTO session (id, title) VALUES (?, ?)').run('s2', 'keep me')
    db.close()

    const res = await deleteSession('opencode', 's1', dbPath)

    assert.equal(res.ok, true)
    assert.equal(res.kind, 'db')
    assert.equal(countRows(dbPath, 'part', 'session_id', 's1'), 0)
    assert.equal(countRows(dbPath, 'message', 'session_id', 's1'), 0)
    assert.equal(countRows(dbPath, 'session', 'id', 's1'), 0)
    assert.equal(countRows(dbPath, 'session', 'id', 's2'), 1)
  })
})
