import { listSessions } from '../src/main/indexer.js'
import { loadTranscript } from '../src/main/transcript.js'

const t0 = Date.now()
const sessions = await listSessions(true)
console.log(`indexed ${sessions.length} sessions in ${Date.now() - t0} ms`)

const bySource: Record<string, number> = {}
for (const s of sessions) bySource[s.source] = (bySource[s.source] ?? 0) + 1
console.log('by source:', bySource)

async function probe(source: string): Promise<void> {
  const list = sessions.filter((s) => s.source === source).sort((a, b) => b.bytes - a.bytes)
  const s = list[0]
  if (!s) {
    console.log(`\n[${source}] none found`)
    return
  }
  const t1 = Date.now()
  const tx = await loadTranscript(s.originalPath, source, s.id)
  console.log(
    `\n[${source}] ${s.bytes} bytes ${s.originalPath.split('/').pop()}\n  loaded in ${Date.now() - t1} ms · records=${tx.records.length} nodes=${tx.nodes.length} truncated=${!!tx.truncated} reconstructed=${tx.reconstructed} err=${tx.error ?? '-'}`
  )
  const kinds: Record<string, number> = {}
  for (const n of tx.nodes) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1
  console.log('  node kinds:', kinds)
  console.log('  resume:', s.resumeCommand)
  for (const n of tx.nodes.slice(0, 4)) {
    console.log(`   • ${n.kind}/${n.title ?? ''}: ${JSON.stringify(n.text.slice(0, 70))}`)
  }
}

await probe('claude')
await probe('codex')
console.log('\nsmoke done')
