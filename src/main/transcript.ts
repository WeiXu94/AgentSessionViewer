import * as fs from 'node:fs'
import type { TranscriptPayload, ViewNode } from '../shared/ipc.js'
import { getSession } from './indexer.js'
import { claudeNodes, claudeTranscriptNodes } from './mappers/claude.js'
import { codexNodes } from './mappers/codex.js'
import { genericNodes, reconstructPayload } from './mappers/generic.js'
import { loadOpenCodePayload } from './mappers/opencode.js'
import { piNodes } from './mappers/pi.js'
import { scanJsonlLines } from './sessions/utils/jsonl.js'

const MAX_BYTES = 96 * 1024 * 1024 // hard guard against pathological files

async function readJsonlRecords(p: string): Promise<{ records: unknown[]; truncated: boolean }> {
  const records: unknown[] = []
  const size = fs.statSync(p).size
  const truncated = size > MAX_BYTES
  await scanJsonlLines(
    p,
    (line) => {
      const t = line.trim()
      if (!t) return 'continue'
      try {
        records.push(JSON.parse(t))
      } catch {
        /* skip malformed line */
      }
      return 'continue'
    },
    truncated ? { maxBytes: MAX_BYTES } : undefined
  )
  return { records, truncated }
}

function toRecordArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    for (const key of ['messages', 'history', 'events', 'turns', 'conversation', 'entries', 'chunkedMessages']) {
      if (Array.isArray(o[key])) return o[key] as unknown[]
    }
    return [raw]
  }
  return []
}

function nodesFor(source: string, records: unknown[], id = ''): ViewNode[] {
  if (source === 'claude') return claudeNodes(records)
  if (source === 'codex') return codexNodes(records)
  if (source === 'pi') return piNodes(records)
  return genericNodes(records)
}

/**
 * Load a full-fidelity transcript for the viewer.
 * - `.jsonl` / `.json` files → raw records (powers JSON view) + normalized nodes (Session view).
 * - directories / SQLite → reconstructed from the adapter's extractContext.
 */
export async function loadTranscript(originalPath: string, source: string, id: string): Promise<TranscriptPayload> {
  try {
    if (source === 'opencode') {
      const payload = loadOpenCodePayload(originalPath, id)
      if (payload) return payload
    }

    const stat = fs.existsSync(originalPath) ? fs.statSync(originalPath) : null
    const isFile = !!stat?.isFile()
    const lower = originalPath.toLowerCase()

    // File-based sources keep one file per session; only read raw lines when the path
    // is a per-session text file (not a shared SQLite db like opencode/crush).
    if (isFile && lower.endsWith('.jsonl')) {
      const { records, truncated } = await readJsonlRecords(originalPath)
      const nodes = source === 'claude' ? claudeTranscriptNodes(records, id) : nodesFor(source, records, id)
      return { source, originalPath, reconstructed: false, records, nodes, truncated }
    }

    if (isFile && lower.endsWith('.json')) {
      const raw = JSON.parse(fs.readFileSync(originalPath, 'utf8'))
      const records = toRecordArray(raw)
      return { source, originalPath, reconstructed: false, records, nodes: nodesFor(source, records, id) }
    }

    return await reconstructPayload(source, originalPath, getSession(source, id))
  } catch (err) {
    return {
      source,
      originalPath,
      reconstructed: false,
      records: [],
      nodes: [],
      error: (err as Error)?.message ?? String(err)
    }
  }
}
