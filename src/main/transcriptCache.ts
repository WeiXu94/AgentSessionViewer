import type { TranscriptPayload } from '../shared/ipc.js'

/**
 * LRU cache for loaded transcripts, keyed by session identity.
 *
 * `loadTranscript` is the one expensive, frequently re-accessed operation in the
 * main process: it streams a whole `.jsonl`/`.json` file off disk and runs the
 * per-source mapper to rebuild `records` + `nodes`. Users revisit a small hot set
 * of sessions (search → open → back → reopen), so a bounded LRU turns a reopen
 * from "read + parse" (tens of ms to seconds) into a `statSync` + map lookup.
 *
 * Two invariants shape the design:
 * - **Key by `source:id:originalPath`, never the path alone.** DB-backed sources
 *   (opencode/crush) share one `originalPath` across every session, so a
 *   path-keyed cache would serve one session's transcript for another. Only
 *   file-based sources (one file per session) are cached here; the caller skips
 *   reconstructed/DB payloads, which have no clean single-file fingerprint.
 * - **Validate against the file fingerprint on every hit.** Claude appends to
 *   live session files, so a cached payload can go stale. We store `{mtimeMs,
 *   size}` and re-`stat` on read; a mismatch is treated as a miss. (Same
 *   fingerprint signal `sessionMetadataCache.ts` already trusts.)
 *
 * Eviction is bounded by *bytes*, not entry count: payloads vary from tens of KB
 * to tens of MB (each holds the full raw `records` plus normalized `nodes`), so a
 * count cap could pin hundreds of MB. Individual transcripts above `MAX_ENTRY`
 * are not cached at all — they're rare and one would dominate the budget (and
 * flushing the hot set to hold a single giant session is the classic LRU
 * pathology).
 *
 * A single-flight map coalesces concurrent loads of the same session: if a read
 * is already in progress, additional callers share its promise instead of
 * starting a second file read + mapper pass. `getOrLoadTranscript` is the entry
 * point that ties the resolved cache, the in-flight map, and the loader together.
 */

interface Entry {
  payload: TranscriptPayload
  mtimeMs: number
  size: number
  /** Approximate memory weight; the file size is a cheap, monotone proxy. */
  bytes: number
}

export interface Fingerprint {
  mtimeMs: number
  size: number
}

const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_ENTRY_BYTES = 32 * 1024 * 1024

// JS Map preserves insertion order, so it doubles as the recency list: the first
// key is the least-recently-used, and delete+set moves a key to the MRU end.
const cache = new Map<string, Entry>()
let totalBytes = 0

// Loads currently in progress, keyed the same way. Lets concurrent callers share
// one read+parse instead of each doing their own (request coalescing).
const inFlight = new Map<string, Promise<TranscriptPayload>>()

export function transcriptCacheKey(source: string, id: string, originalPath: string): string {
  return `${source}:${id}:${originalPath}`
}

/**
 * Return the cached payload if present and still fresh, else null. A stale entry
 * (file appended/rewritten since it was cached) is evicted and reported as a miss.
 * On a hit the entry is promoted to most-recently-used.
 */
export function getCachedTranscript(key: string, fp: Fingerprint): TranscriptPayload | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.mtimeMs !== fp.mtimeMs || entry.size !== fp.size) {
    cache.delete(key)
    totalBytes -= entry.bytes
    return null
  }
  cache.delete(key)
  cache.set(key, entry) // re-insert at the MRU end
  return entry.payload
}

/**
 * Store a freshly loaded payload, evicting LRU entries until under the byte
 * budget. Error payloads and transcripts larger than `MAX_ENTRY_BYTES` are not
 * cached.
 */
export function putCachedTranscript(
  key: string,
  payload: TranscriptPayload,
  fp: Fingerprint,
  bytes: number
): void {
  if (payload.error || bytes > MAX_ENTRY_BYTES) return

  const existing = cache.get(key)
  if (existing) totalBytes -= existing.bytes
  cache.set(key, { payload, mtimeMs: fp.mtimeMs, size: fp.size, bytes })
  totalBytes += bytes

  while (totalBytes > MAX_TOTAL_BYTES && cache.size > 1) {
    const lruKey = cache.keys().next().value as string
    const lru = cache.get(lruKey)!
    cache.delete(lruKey)
    totalBytes -= lru.bytes
  }
}

/**
 * Resolve a transcript through the cache: serve a fresh cached payload, join an
 * in-progress load for the same session, or run `loader` and cache its result.
 *
 * Coalescing keys on session identity, so a burst of `loadTranscript` calls (a
 * double-click, rapid navigation) triggers a single file read + mapper pass and
 * everyone awaits it. A rejected load is not cached and clears the in-flight slot
 * so the next call retries cleanly.
 */
export function getOrLoadTranscript(
  key: string,
  fp: Fingerprint,
  loader: () => Promise<TranscriptPayload>
): Promise<TranscriptPayload> {
  const cached = getCachedTranscript(key, fp)
  if (cached) return Promise.resolve(cached)

  const pending = inFlight.get(key)
  if (pending) return pending

  const promise = (async () => {
    const payload = await loader()
    putCachedTranscript(key, payload, fp, fp.size)
    return payload
  })()
  // Clear the slot once settled (resolved or rejected) so failures don't stick.
  void promise.catch(() => undefined).finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

/** Test/utility hook: drop everything. */
export function clearTranscriptCache(): void {
  cache.clear()
  totalBytes = 0
  inFlight.clear()
}
