export interface StatusBannerProps {
  readonly tone: 'info' | 'success' | 'warning' | 'danger'
  readonly title: string
  readonly message?: string | undefined
  readonly actionLabel?: string | undefined
  readonly onAction?: (() => void) | undefined
}

export function StatusBanner({ tone, title, message, actionLabel, onAction }: StatusBannerProps) {
  return (
    <div className={`ss-status ss-status--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="ss-status__mark" aria-hidden="true">
        {tone === 'success' ? '✓' : tone === 'warning' || tone === 'danger' ? '!' : 'i'}
      </span>
      <div>
        <strong>{title}</strong>
        {message ? <p>{message}</p> : null}
      </div>
      {actionLabel && onAction ? (
        <button className="ss-button ss-button--quiet" type="button" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  )
}
