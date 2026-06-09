import type { ReactNode } from 'react'
import { sourceColor, sourceInitials, shadeHex } from '../util'

export const MI: Record<string, ReactNode> = {
  search: (
    <>
      <path d="M11.3 11.3l3 3" />
      <circle cx="7.4" cy="7.4" r="5.1" />
    </>
  ),
  chevDown: <path d="M4.2 6.2 8 9.8l3.8-3.6" />,
  chevUp: <path d="M4.2 9.8 8 6.2l3.8 3.6" />,
  popChev: (
    <>
      <path d="M2.5 4.2 4.5 2l2 2.2" />
      <path d="M2.5 7.8 4.5 10l2-2.2" />
    </>
  ),
  group: (
    <>
      <path d="M3 4.2h10" />
      <path d="M3 8h10" />
      <path d="M3 11.8h6.5" />
    </>
  ),
  reload: (
    <>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7" />
      <path d="M13.4 2.6V5h-2.4" />
    </>
  ),
  repo: (
    <>
      <path d="M4 3.4h7.2a1.4 1.4 0 0 1 1.4 1.4v8.4l-2.8-1.8-2.8 1.8V4.8A1.4 1.4 0 0 0 3.6 3.4H4Z" />
      <path d="M4 3.4v8.6" />
    </>
  ),
  branch: (
    <>
      <circle cx="5" cy="4.4" r="1.5" />
      <circle cx="5" cy="12.4" r="1.5" />
      <circle cx="11.4" cy="6.2" r="1.5" />
      <path d="M5 5.9v5" />
      <path d="M5 9h3.6a2.8 2.8 0 0 0 2.8-2.8" />
    </>
  ),
  cpu: (
    <>
      <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.6" />
      <rect x="6.4" y="6.4" width="3.2" height="3.2" rx="0.6" />
      <path d="M6.4 2.4v1.8M9.6 2.4v1.8M6.4 11.8v1.8M9.6 11.8v1.8M2.4 6.4h1.8M2.4 9.6h1.8M11.8 6.4h1.8M11.8 9.6h1.8" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M8 4.8V8l2.2 1.4" />
    </>
  ),
  weight: (
    <>
      <path d="M3 5h10" />
      <path d="M3 8h10" />
      <path d="M3 11h6.5" />
    </>
  ),
  finder: <path d="M3 5a1.5 1.5 0 0 1 1.5-1.5h2.4l1.2 1.5h4.4A1.5 1.5 0 0 1 14 6.5V12a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 3 12V5Z" />,
  close: (
    <>
      <path d="M4.6 4.6 11.4 11.4" />
      <path d="M11.4 4.6 4.6 11.4" />
    </>
  ),
  outline: (
    <>
      <path d="M6.2 4.4h7.4M6.2 8h7.4M6.2 11.6h7.4" />
      <circle cx="3" cy="4.4" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="11.6" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  collapse: (
    <>
      <path d="M4.5 3h7" />
      <path d="M4.5 6.2h7" />
      <path d="M3.5 9.8h9" />
      <path d="M4.5 13h7" />
    </>
  ),
  collapseAll: (
    <>
      <path d="M6.1 3.6h6.5M6.1 8h6.5M6.1 12.4h6.5" />
      <path d="M2.7 2.2 4.7 3.6 2.7 5Z" fill="currentColor" stroke="none" />
      <path d="M2.7 6.6 4.7 8 2.7 9.4Z" fill="currentColor" stroke="none" />
      <path d="M2.7 11 4.7 12.4 2.7 13.8Z" fill="currentColor" stroke="none" />
    </>
  ),
  expand: (
    <>
      <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="2.2" />
      <path d="M6 6.6h4M6 8.6h4M6 10.6h2.6" />
    </>
  ),
  expandAll: (
    <>
      <path d="M6.1 3.6h6.5M6.1 8h6.5M6.1 12.4h6.5" />
      <path d="M2.2 2.7H5L3.6 4.7Z" fill="currentColor" stroke="none" />
      <path d="M2.2 7.1H5L3.6 9.1Z" fill="currentColor" stroke="none" />
      <path d="M2.2 11.5H5l-1.4 2Z" fill="currentColor" stroke="none" />
    </>
  ),
  brain: (
    <>
      <path d="M8 3c-1.5 0-2.5 1-2.5 2.1-1 .2-1.5 1-1.5 1.8 0 .6.3 1.1.8 1.4-.2.9.4 1.8 1.5 1.8.2.8.9 1.3 1.7 1.3s1.5-.5 1.7-1.3c1.1 0 1.7-.9 1.5-1.8.5-.3.8-.8.8-1.4 0-.8-.5-1.6-1.5-1.8C10.5 4 9.5 3 8 3Z" />
      <path d="M8 3v8.5" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 2v1.5M8 12.5V14M14 8h-1.5M3.5 8H2M12.2 3.8l-1 1M4.8 11.2l-1 1M12.2 12.2l-1-1M4.8 4.8l-1-1" />
    </>
  ),
  returnArrow: <path d="M12.5 4.5v3a2 2 0 0 1-2 2H4M6.4 7 3.8 9.5 6.4 12" />,
  info: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 7.3v3.4M8 5.2v.3" />
    </>
  ),
  hash: <path d="M6.2 2.8 5.2 13.2M11 2.8 10 13.2M3.4 5.8h9.2M3 10.2h9.2" />,
  tray: <path d="M2.8 9.4 4.6 4h6.8l1.8 5.4M2.8 9.4V12a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1V9.4M2.8 9.4h3.1l.9 1.4h2.4l.9-1.4h3.1" />,
  check: <path d="M3.4 8.4 6.4 11.4 12.6 4.8" />,
  bolt: <path d="M9 2.4 4 8.6h3.4L7 13.6l5-6.4H8.6L9 2.4Z" />,
  sidebar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" rx="2" />
      <path d="M6.5 3.6v8.8" />
    </>
  )
}

export function MacIcon({
  name,
  className,
  viewBox = '0 0 16 16'
}: {
  name: keyof typeof MI
  className?: string
  viewBox?: string
}): JSX.Element {
  return (
    <svg className={className} viewBox={viewBox} aria-hidden="true">
      {MI[name]}
    </svg>
  )
}

export function Tri(): JSX.Element {
  return (
    <svg viewBox="0 0 8 8" aria-hidden="true">
      <path d="M2 1l4 3-4 3z" />
    </svg>
  )
}

export function AppIcon({ source, sub = false, size = 30 }: { source: string; sub?: boolean; size?: number }): JSX.Element {
  const color = sourceColor(source)
  return (
    <span
      className={`app-icon${sub ? ' app-icon--sub' : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `linear-gradient(155deg, ${shadeHex(color, 26)}, ${color} 60%, ${shadeHex(color, -16)})`
      }}
      aria-hidden="true"
    >
      {sourceInitials(source)}
    </span>
  )
}
