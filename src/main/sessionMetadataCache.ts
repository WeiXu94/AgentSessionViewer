import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import { adapters, ALL_TOOLS } from './sessions/parsers/registry.js'
import type { SessionSource, UnifiedSession } from './sessions/types/index.js'

// v4: claude subagent sessions get filename-derived ids (collision fix).
const CACHE_VERSION = 4
const CACHE_FILE = 'session-metadata-cache.json'
const CACHE_MAX_AGE_MS = 30 * 60 * 1000
const MAX_ANCESTOR_FINGERPRINTS_PER_SESSION = 6
const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'

type PathKind = 'file' | 'directory' | 'other' | 'missing'

interface PathFingerprint {
  kind: PathKind
  mtimeMs: number
  size: number
}

interface CachedUnifiedSession {
  id: string
  source: SessionSource
  cwd: string
  repo?: string
  branch?: string
  gitSha?: string
  summary?: string
  lines: number
  bytes: number
  createdAt: number
  updatedAt: number
  originalPath: string
  model?: string
  variant?: UnifiedSession['variant']
  parentId?: string
  subagentType?: string
  forkParentId?: string
}

interface CacheFile {
  version: number
  writtenAt: number
  envFingerprint: string
  pathFingerprints: Record<string, PathFingerprint>
  sessions: CachedUnifiedSession[]
}

function cachePath(): string {
  try {
    return path.join(app.getPath('userData'), CACHE_FILE)
  } catch {
    return path.join(os.homedir(), '.agentsessionviewer', CACHE_FILE)
  }
}

function adapterEnvFingerprint(): string {
  const seen = new Set<string>()
  const parts: string[] = [`tools=${ALL_TOOLS.join(',')}`]

  for (const name of ALL_TOOLS) {
    const adapter = adapters[name]
    const envVars = [adapter?.envVar, ...(adapter?.extraEnvVars ?? [])].filter((value): value is string => !!value)
    for (const envVar of envVars) {
      if (seen.has(envVar)) continue
      seen.add(envVar)
      parts.push(`${envVar}=${process.env[envVar] ?? ''}`)
    }
  }

  return createHash('sha256').update(parts.sort().join('\n')).digest('hex')
}

function expandStoragePathCandidate(raw: string): string | null {
  let value = raw.trim()
  if (!value) return null

  const globIndex = value.indexOf('*')
  if (globIndex >= 0) value = value.slice(0, globIndex)

  value = value.replace(/\/+$/u, '')
  if (!value) return null

  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2))
  }

  const envMatch = value.match(/^\$([A-Z0-9_]+)(\/.*)?$/u)
  if (envMatch) {
    const envValue = process.env[envMatch[1]]
    if (!envValue) return null
    return path.join(envValue, envMatch[2] ?? '')
  }

  return path.isAbsolute(value) ? value : null
}

function adapterStorageRoots(): string[] {
  const roots = new Set<string>()

  for (const name of ALL_TOOLS) {
    const adapter = adapters[name]
    if (!adapter) continue

    if (adapter.envVar && process.env[adapter.envVar]) {
      roots.add(process.env[adapter.envVar]!)
    }

    const candidates = adapter.storagePath.match(/(?:~|\$[A-Z0-9_]+)[^(),]+/gu) ?? []
    for (const candidate of candidates) {
      const expanded = expandStoragePathCandidate(candidate)
      if (expanded) roots.add(expanded)
    }
  }

  return [...roots]
}

function fingerprintPath(p: string): PathFingerprint {
  try {
    const stat = fs.statSync(p)
    const kind: PathKind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other'
    return { kind, mtimeMs: Math.trunc(stat.mtimeMs), size: stat.size }
  } catch {
    return { kind: 'missing', mtimeMs: 0, size: 0 }
  }
}

function addSessionFingerprintPaths(paths: Set<string>, sessionPath: string): void {
  paths.add(sessionPath)

  let dir = path.dirname(sessionPath)
  for (let i = 0; i < MAX_ANCESTOR_FINGERPRINTS_PER_SESSION; i++) {
    if (!dir || dir === path.dirname(dir) || dir === os.homedir()) break
    paths.add(dir)
    dir = path.dirname(dir)
  }
}

function codexSessionIndexPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), CODEX_SESSION_INDEX_FILE)
}

function collectPathFingerprints(sessions: UnifiedSession[]): Record<string, PathFingerprint> {
  const paths = new Set<string>(adapterStorageRoots())
  if (sessions.some((session) => session.source === 'codex')) {
    paths.add(codexSessionIndexPath())
  }
  for (const session of sessions) {
    if (session.originalPath) addSessionFingerprintPaths(paths, session.originalPath)
  }

  return Object.fromEntries([...paths].sort().map((p) => [p, fingerprintPath(p)]))
}

function sameFingerprint(left: PathFingerprint, right: PathFingerprint): boolean {
  return left.kind === right.kind && left.mtimeMs === right.mtimeMs && left.size === right.size
}

function pathFingerprintsMatch(expected: Record<string, PathFingerprint>): boolean {
  const entries = Object.entries(expected)
  if (entries.length === 0) return false

  for (const [p, cached] of entries) {
    if (!sameFingerprint(cached, fingerprintPath(p))) return false
  }
  return true
}

function serializeSession(session: UnifiedSession): CachedUnifiedSession {
  return {
    id: session.id,
    source: session.source,
    cwd: session.cwd ?? '',
    repo: session.repo,
    branch: session.branch,
    gitSha: session.gitSha,
    summary: session.summary,
    lines: session.lines ?? 0,
    bytes: session.bytes ?? 0,
    createdAt: session.createdAt instanceof Date ? session.createdAt.getTime() : Date.parse(String(session.createdAt)) || 0,
    updatedAt: session.updatedAt instanceof Date ? session.updatedAt.getTime() : Date.parse(String(session.updatedAt)) || 0,
    originalPath: session.originalPath,
    model: session.model,
    variant: session.variant,
    parentId: session.parentId,
    subagentType: session.subagentType,
    forkParentId: session.forkParentId
  }
}

function restoreSession(session: CachedUnifiedSession): UnifiedSession {
  return {
    ...session,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt)
  }
}

function isCacheFile(value: unknown): value is CacheFile {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<CacheFile>
  return (
    record.version === CACHE_VERSION &&
    typeof record.writtenAt === 'number' &&
    typeof record.envFingerprint === 'string' &&
    !!record.pathFingerprints &&
    typeof record.pathFingerprints === 'object' &&
    Array.isArray(record.sessions)
  )
}

export function readSessionMetadataCache(): UnifiedSession[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as unknown
    if (!isCacheFile(parsed)) return null
    if (parsed.envFingerprint !== adapterEnvFingerprint()) return null
    if (Date.now() - parsed.writtenAt > CACHE_MAX_AGE_MS) return null
    if (!pathFingerprintsMatch(parsed.pathFingerprints)) return null
    return parsed.sessions.map(restoreSession)
  } catch {
    return null
  }
}

export function writeSessionMetadataCache(sessions: UnifiedSession[]): void {
  try {
    const filePath = cachePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })

    const payload: CacheFile = {
      version: CACHE_VERSION,
      writtenAt: Date.now(),
      envFingerprint: adapterEnvFingerprint(),
      pathFingerprints: collectPathFingerprints(sessions),
      sessions: sessions.map(serializeSession)
    }

    const tmpPath = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(payload))
    fs.renameSync(tmpPath, filePath)
  } catch {
    // Cache writes are best-effort; session discovery should never fail because of them.
  }
}
