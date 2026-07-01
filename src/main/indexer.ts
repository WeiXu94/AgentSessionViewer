import { adapters, ALL_TOOLS } from './sessions/parsers/registry.js'
import type { SessionSource, UnifiedSession } from './sessions/types/index.js'
import type { SessionMeta } from '../shared/ipc.js'
import {
  invalidateSessionMetadataCache,
  readSessionMetadataCache,
  writeSessionMetadataCache
} from './sessionMetadataCache.js'

let cache: SessionMeta[] | null = null
// Keyed by source+id, not originalPath: DB-backed sources (opencode, crush) share
// one originalPath across all their sessions.
const byKey = new Map<string, UnifiedSession>()
const metaByKey = new Map<string, SessionMeta>()

function sessionKey(source: string, id: string): string {
  return `${source}\u0000${id}`
}

function epoch(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') return Date.parse(value) || 0
  if (typeof value === 'number') return value
  return 0
}

const VARIANT_LABELS: Record<string, string> = {
  cli: 'cli',
  desktop: 'desk',
  vscode: 'vscode',
  subagent: 'sub'
}

function toMeta(s: UnifiedSession): SessionMeta {
  const adapter = adapters[s.source]
  // Subagents aren't independently resumable.
  let resumeCommand = ''
  if (s.variant !== 'subagent') {
    try {
      resumeCommand = adapter?.resumeCommandDisplay?.(s) ?? ''
    } catch {
      resumeCommand = ''
    }
  }
  const variantLabel =
    s.variant === 'subagent' ? s.subagentType || 'subagent' : s.variant ? VARIANT_LABELS[s.variant] : undefined
  return {
    id: s.id,
    source: s.source,
    sourceLabel: adapter?.label ?? s.source,
    cwd: s.cwd ?? '',
    repo: s.repo,
    branch: s.branch,
    summary: s.summary,
    lines: s.lines ?? 0,
    bytes: s.bytes ?? 0,
    createdAt: epoch(s.createdAt),
    updatedAt: epoch(s.updatedAt),
    originalPath: s.originalPath,
    model: s.model,
    resumeCommand,
    variant: s.variant,
    variantLabel,
    parentId: s.parentId,
    subagentType: s.subagentType,
    forkParentId: s.forkParentId
  }
}

function setSessionCache(sessions: UnifiedSession[]): SessionMeta[] {
  byKey.clear()
  metaByKey.clear()
  for (const s of sessions) {
    byKey.set(sessionKey(s.source, s.id), s)
  }
  cache = sessions.map(toMeta)
  for (const m of cache) {
    metaByKey.set(sessionKey(m.source, m.id), m)
  }
  return cache
}

/**
 * Discover sessions across every supported tool. Each adapter is wrapped so one
 * failing source (e.g. node:sqlite unavailable) never breaks the rest.
 */
export async function listSessions(force = false): Promise<SessionMeta[]> {
  if (cache && !force) return cache

  if (!force) {
    const cachedSessions = readSessionMetadataCache()
    if (cachedSessions) return setSessionCache(cachedSessions)
  }

  const groups = await Promise.all(
    ALL_TOOLS.map(async (name: SessionSource) => {
      try {
        return await adapters[name].parseSessions({ lightweight: true })
      } catch (err) {
        console.warn(`[indexer] ${name} failed:`, (err as Error)?.message ?? err)
        return [] as UnifiedSession[]
      }
    })
  )

  const all: UnifiedSession[] = []
  for (const group of groups) {
    for (const s of group) {
      all.push(s)
    }
  }
  all.sort((a, b) => epoch(b.updatedAt) - epoch(a.updatedAt))

  const metas = setSessionCache(all)
  writeSessionMetadataCache(all)
  return metas
}

/**
 * Drop the in-memory + on-disk session caches so the next `listSessions` rescans.
 * Called after a session is deleted (DB-backed deletes mutate a shared file the
 * cache fingerprint can't detect, so we force a fresh scan).
 */
export function invalidateSessionCache(): void {
  cache = null
  byKey.clear()
  metaByKey.clear()
  invalidateSessionMetadataCache()
}

/** Look up the full UnifiedSession (needed for DB-backed transcript reconstruction). */
export function getSession(source: string, id: string): UnifiedSession | undefined {
  return byKey.get(sessionKey(source, id))
}

/**
 * Look up the renderer-facing SessionMeta from the last listing. When
 * `originalPath` is given it disambiguates source+id collisions (e.g. Claude
 * subagent transcripts that share the parent's session id).
 */
export function getSessionMeta(source: string, id: string, originalPath?: string): SessionMeta | undefined {
  const meta = metaByKey.get(sessionKey(source, id))
  if (!originalPath || meta?.originalPath === originalPath) return meta
  return cache?.find((m) => m.source === source && m.id === id && m.originalPath === originalPath) ?? meta
}
