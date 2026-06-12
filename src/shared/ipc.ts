// Shared IPC contract between main and renderer.
// Type-only — erased at build time, so the renderer never imports main code at runtime.

export interface SessionMeta {
  id: string
  source: string
  sourceLabel: string
  cwd: string
  repo?: string
  branch?: string
  summary?: string
  lines: number
  bytes: number
  /** epoch ms */
  createdAt: number
  /** epoch ms */
  updatedAt: number
  originalPath: string
  model?: string
  /** Display string for the native resume command, or '' if unavailable. */
  resumeCommand: string
  /** Origin variant: terminal CLI, desktop app, IDE extension, or a spawned subagent. */
  variant?: 'cli' | 'desktop' | 'vscode' | 'subagent'
  /** Short chip label for the variant (e.g. "cli", "desk", "vscode", or the subagent type). */
  variantLabel?: string
  /** For subagents: the parent session id. */
  parentId?: string
  /** For subagents: the agent type (e.g. "Explore"). */
  subagentType?: string
  /** For forked sessions: the source session id this session branched from. */
  forkParentId?: string
}

export type NodeKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'meta'
  | 'system'

export interface ViewNode {
  id: string
  seq: number
  kind: NodeKind
  role?: 'user' | 'assistant' | 'system'
  /** Header label, e.g. tool name or "User"/"Assistant". */
  title?: string
  text: string
  toolName?: string
  /** Index into TranscriptPayload.records this node was derived from. */
  rawIndex: number
  /** UTF-8 byte length of `text` (renderer collapses oversized nodes). */
  bytes: number
  /** True when this node came from copied parent history in a forked transcript. */
  inherited?: boolean
  /** Parent session id for inherited fork nodes. */
  inheritedFromId?: string
}

export interface TranscriptPayload {
  source: string
  originalPath: string
  /** True for SQLite/DB-backed sources where records are reconstructed, not raw file lines. */
  reconstructed: boolean
  /** Raw JSONL objects (index-aligned with ViewNode.rawIndex), or normalized records when reconstructed. */
  records: unknown[]
  nodes: ViewNode[]
  /** True when the file exceeded the size guard and was read only partially. */
  truncated?: boolean
  error?: string
}

/** Restricts a global search to one project (matched against the indexed session metadata). */
export interface SearchScopeFilter {
  repo?: string
  cwd?: string
}

/** Snippet text is split on \x02 (match start) and \x03 (match end) markers for highlighting. */
export interface GlobalSearchMatch {
  nodeIndex: number
  kind: 'user' | 'assistant'
  snippet: string
}

export interface GlobalSearchGroup {
  session: SessionMeta
  matches: GlobalSearchMatch[]
  totalMatches: number
}

export interface GlobalSearchResponse {
  /** False when node:sqlite (and thus the index) is unavailable. */
  available: boolean
  /** True while the background indexer is still catching up — results may be incomplete. */
  indexing: boolean
  groups: GlobalSearchGroup[]
  totalSessions: number
}

export interface SearchIndexProgress {
  indexed: number
  total: number
  done: boolean
}

export type ExportFormat = 'markdown' | 'html'

export interface ExportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  error?: string
}

export interface SessionsAPI {
  list: (force?: boolean) => Promise<SessionMeta[]>
  /** `id` is required to disambiguate DB-backed sources where many sessions share one originalPath. */
  loadTranscript: (originalPath: string, source: string, id: string) => Promise<TranscriptPayload>
  searchSessions: (query: string, scope?: SearchScopeFilter) => Promise<GlobalSearchResponse>
  onSearchIndexProgress: (callback: (progress: SearchIndexProgress) => void) => () => void
  exportSession: (originalPath: string, source: string, id: string, format: ExportFormat) => Promise<ExportResult>
  reveal: (path: string) => Promise<void>
  openPath: (path: string) => Promise<void>
  copy: (text: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  getAccentColor: () => Promise<string>
  onAccentColorChanged: (callback: (accent: string) => void) => () => void
}
