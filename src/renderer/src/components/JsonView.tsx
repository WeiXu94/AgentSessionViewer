import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'

const MAX_DISPLAY = 200_000

function stringify(value: unknown): string {
  let s: string
  try {
    s = JSON.stringify(value, null, 2)
  } catch {
    s = String(value)
  }
  if (s.length > MAX_DISPLAY) s = `${s.slice(0, MAX_DISPLAY)}\n…(truncated)`
  return s
}

interface Props {
  records: unknown[]
  reconstructed: boolean
}

export function JsonView({ records, reconstructed }: Props): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({
    count: records.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 160,
    overscan: 6,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 160
  })

  return (
    <div className="json" ref={parentRef}>
      {reconstructed ? (
        <div className="banner">
          Reconstructed from a database — these records are normalized, not the raw on-disk file.
        </div>
      ) : null}
      {records.length === 0 ? (
        <div className="transcript--empty">No records.</div>
      ) : (
        <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
          {virt.getVirtualItems().map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virt.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start}px)`
              }}
            >
              <div className="json__record">
                <span className="json__idx">{item.index}</span>
                <pre className="json__pre">{stringify(records[item.index])}</pre>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
