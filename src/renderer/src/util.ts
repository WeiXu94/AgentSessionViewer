import type { SessionMeta } from '../../shared/ipc'

export const SOURCE_COLORS: Record<string, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  copilot: '#8b949e',
  gemini: '#4285f4',
  opencode: '#eab308',
  droid: '#ef4444',
  cursor: '#3b82f6',
  amp: '#ff6b35',
  kiro: '#7b68ee',
  crush: '#e63946',
  cline: '#00d4aa',
  'roo-code': '#ff8c42',
  'kilo-code': '#6c5ce7',
  antigravity: '#a8dadc',
  kimi: '#16a34a',
  'qwen-code': '#6366f1',
  pi: '#ff4d8d',
  grok: '#00d4ff'
}

export function sourceColor(source: string): string {
  return SOURCE_COLORS[source] ?? '#8b949e'
}

export function shadeHex(hex: string, amount: number): string {
  const normalized = /^#[\da-f]{6}$/iu.test(hex) ? hex : '#8b949e'
  const n = Number.parseInt(normalized.slice(1), 16)
  const clamp = (value: number): number => Math.max(0, Math.min(255, value))
  const r = clamp((n >> 16) + amount)
  const g = clamp(((n >> 8) & 255) + amount)
  const b = clamp((n & 255) + amount)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

const SOURCE_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  droid: 'Droid',
  cursor: 'Cursor',
  amp: 'Amp',
  kiro: 'Kiro',
  crush: 'Crush',
  cline: 'Cline',
  'roo-code': 'Roo',
  'kilo-code': 'Kilo',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  'qwen-code': 'Qwen',
  pi: 'Pi',
  grok: 'Grok'
}

/** Clean base name for the badge — variant (cli/desk) is shown as a separate chip. */
export function sourceName(source: string): string {
  return SOURCE_NAMES[source] ?? source
}

export function sourceInitials(source: string): string {
  const name = sourceName(source)
  const words = name.split(/[\s-]+/u).filter(Boolean)
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  return name.slice(0, Math.min(2, name.length)).toUpperCase()
}

export function accentForeground(accent: string): string {
  const hex = /^#[\da-f]{6}$/iu.test(accent) ? accent.slice(1) : '007aff'
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return luminance > 0.68 ? '#1d1d1f' : '#ffffff'
}

export function fmtTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** Clock time only — used in the compact session list. */
export function fmtTimeShort(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function fmtBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function sessionTitle(s: SessionMeta): string {
  const t = s.summary?.trim()
  return t && t.length ? t : s.id
}

/** Stable unique identity for a session (originalPath isn't unique for DB-backed sources). */
export function metaKey(s: SessionMeta): string {
  return `${s.source}\u0000${s.id}`
}

const STARRED_KEY = 'asv.starredSessions'

function readStarredKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(STARRED_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((k): k is string => typeof k === 'string'))
  } catch {
    return new Set()
  }
}

function writeStarredKeys(keys: Set<string>): void {
  try {
    localStorage.setItem(STARRED_KEY, JSON.stringify([...keys]))
  } catch {
    /* storage may be unavailable — ignore. */
  }
}

export function isSessionStarred(s: SessionMeta): boolean {
  return readStarredKeys().has(metaKey(s))
}

export function setSessionStarred(s: SessionMeta, starred: boolean): void {
  const keys = readStarredKeys()
  const key = metaKey(s)
  if (starred) keys.add(key)
  else keys.delete(key)
  writeStarredKeys(keys)
}

export type ListMode = 'flat' | 'tree'
export type GroupMode = 'chronological' | 'date' | 'project-recent' | 'project-alpha'

export const GROUP_MODES: GroupMode[] = ['chronological', 'date', 'project-recent', 'project-alpha']

const GROUP_MODE_KEY = 'asv.groupMode'

/** Read the saved group-by mode, falling back to 'chronological'. */
export function loadGroupMode(): GroupMode {
  try {
    const v = localStorage.getItem(GROUP_MODE_KEY)
    return GROUP_MODES.includes(v as GroupMode) ? (v as GroupMode) : 'chronological'
  } catch {
    return 'chronological'
  }
}

/** Persist the group-by mode for the next launch. */
export function saveGroupMode(mode: GroupMode): void {
  try {
    localStorage.setItem(GROUP_MODE_KEY, mode)
  } catch {
    /* storage may be unavailable (private mode) — ignore. */
  }
}

export interface SessionDisplayRow {
  kind: 'session'
  session: SessionMeta
  depth: number
  hasChildren: boolean
  expanded: boolean
}

export interface GroupDisplayRow {
  kind: 'group'
  id: string
  title: string
  count: number
  collapsed: boolean
}

export type DisplayRow = SessionDisplayRow | GroupDisplayRow

interface SessionGroup {
  key: string
  title: string
  latestAt: number
  sessions: SessionMeta[]
}

/**
 * Build the flat array of rows to render. In tree mode, subagent sessions nest
 * under the parent session that spawned them (matched by parentId → id).
 */
export function buildRows(
  filtered: SessionMeta[],
  all: SessionMeta[],
  mode: ListMode,
  expanded: Set<string>,
  groupMode: GroupMode = 'chronological',
  collapsedGroups: Set<string> = new Set()
): DisplayRow[] {
  if (groupMode !== 'chronological') {
    const rows: DisplayRow[] = []
    for (const group of groupSessions(filtered, groupMode)) {
      const id = `group:${groupMode}:${group.key}`
      const collapsed = collapsedGroups.has(id)
      rows.push({ kind: 'group', id, title: group.title, count: group.sessions.length, collapsed })
      if (collapsed) continue
      rows.push(...buildSessionRows(group.sessions, group.sessions, mode, expanded))
    }
    return rows
  }

  return buildSessionRows(filtered, all, mode, expanded)
}

function buildSessionRows(
  filtered: SessionMeta[],
  all: SessionMeta[],
  mode: ListMode,
  expanded: Set<string>
): SessionDisplayRow[] {
  if (mode === 'flat') {
    return filtered.map((session) => ({ kind: 'session', session, depth: 0, hasChildren: false, expanded: false }))
  }

  const childrenByParent = new Map<string, SessionMeta[]>()
  for (const s of all) {
    if (s.variant === 'subagent' && s.parentId) {
      const arr = childrenByParent.get(s.parentId) ?? []
      arr.push(s)
      childrenByParent.set(s.parentId, arr)
    }
  }
  for (const arr of childrenByParent.values()) arr.sort((a, b) => a.createdAt - b.createdAt)

  const mains = filtered.filter((s) => s.variant !== 'subagent')
  const mainIds = new Set(mains.map((s) => s.id))
  const rows: SessionDisplayRow[] = []
  for (const m of mains) {
    const kids = childrenByParent.get(m.id) ?? []
    const isExpanded = expanded.has(m.id)
    rows.push({ kind: 'session', session: m, depth: 0, hasChildren: kids.length > 0, expanded: isExpanded })
    if (isExpanded) {
      for (const k of kids) rows.push({ kind: 'session', session: k, depth: 1, hasChildren: false, expanded: false })
    }
  }
  // Subagents whose parent isn't displayed (e.g. matched by search) — surface them flat.
  for (const s of filtered) {
    if (s.variant === 'subagent' && (!s.parentId || !mainIds.has(s.parentId))) {
      rows.push({ kind: 'session', session: s, depth: 0, hasChildren: false, expanded: false })
    }
  }
  return rows
}

function groupSessions(sessions: SessionMeta[], groupMode: Exclude<GroupMode, 'chronological'>): SessionGroup[] {
  const byKey = new Map<string, SessionGroup>()

  for (const session of sessions) {
    const key = groupMode === 'date' ? dateGroupKey(session.updatedAt) : projectGroupKey(session)
    const title = groupMode === 'date' ? dateGroupTitle(session.updatedAt) : projectGroupTitle(session)
    const group = byKey.get(key) ?? { key, title, latestAt: 0, sessions: [] }
    group.latestAt = Math.max(group.latestAt, session.updatedAt)
    group.sessions.push(session)
    byKey.set(key, group)
  }

  return [...byKey.values()].sort((a, b) => {
    if (groupMode === 'project-alpha') {
      const byTitle = a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })
      if (byTitle !== 0) return byTitle
    }
    return b.latestAt - a.latestAt
  })
}

function projectGroupKey(session: SessionMeta): string {
  const repo = session.repo?.trim()
  if (repo) return `repo:${repo}`
  const cwd = session.cwd.trim()
  if (cwd) return `cwd:${cwd}`
  return 'none'
}

function projectGroupTitle(session: SessionMeta): string {
  const repo = session.repo?.trim()
  if (repo) return repo
  const cwd = session.cwd.trim().replace(/\/+$/, '')
  if (!cwd) return 'No project'
  return cwd.split('/').filter(Boolean).at(-1) ?? cwd
}

function dateGroupKey(ms: number): string {
  if (!ms) return 'unknown'
  const d = new Date(ms)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateGroupTitle(ms: number): string {
  if (!ms) return 'Unknown date'

  const d = new Date(ms)
  const now = new Date()
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayDelta = Math.round((todayStart - dayStart) / 86_400_000)

  if (dayDelta === 0) return 'Today'
  if (dayDelta === 1) return 'Yesterday'

  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { weekday: 'short', month: 'short', day: 'numeric' }
      : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
  return d.toLocaleDateString(undefined, opts)
}
