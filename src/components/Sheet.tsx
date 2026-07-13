import type { ReactNode } from 'react'

export interface SheetProps {
  readonly title: string
  readonly summary?: string
  readonly children: ReactNode
  readonly defaultOpen?: boolean
}

export function Sheet({ title, summary, children, defaultOpen = false }: SheetProps) {
  return (
    <details className="ss-sheet" open={defaultOpen || undefined}>
      <summary>
        <span>{title}</span>
        {summary ? <small>{summary}</small> : null}
      </summary>
      <div className="ss-sheet__body">{children}</div>
    </details>
  )
}
