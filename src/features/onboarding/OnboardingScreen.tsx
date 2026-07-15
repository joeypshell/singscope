import { StatusBanner } from '../../components/StatusBanner'

export interface OnboardingScreenProps {
  readonly installed: boolean
  readonly storageProbe: 'checking' | 'ready' | 'limited' | 'failed'
  readonly onContinue: () => void
  readonly onImportBackup: (file: File) => void
}

export function OnboardingScreen({
  installed,
  storageProbe,
  onContinue,
  onImportBackup,
}: OnboardingScreenProps) {
  return (
    <main className="ss-screen">
      <article className="ss-card ss-card--hero ss-stack">
        <div>
          <p className="ss-eyebrow">iPhone-first local practice</p>
          <h1>Before your first project</h1>
          <p>
            SingScope records and analyzes on this device. Nothing is uploaded automatically. If you
            explicitly send a bug report, the app warns you first because that report includes the
            exact analyzed audio.
          </p>
        </div>

        <StatusBanner
          tone="warning"
          title={
            installed
              ? 'This Home Screen app has its own storage'
              : 'Install before creating long-term projects'
          }
          message={
            installed
              ? 'Safari projects do not appear here automatically. Export a backup in Safari, then import it here.'
              : 'Safari and the installed Home Screen app use separate project stores. Transfer with a backup after installation.'
          }
        />

        <ol className="ss-stack">
          <li>
            <strong>Use headphones.</strong> Wired or USB-C is preferred for dependable playback and
            capture.
          </li>
          <li>
            <strong>Keep the app in front.</strong> Locking or switching apps safely ends the
            current take as partial.
          </li>
          <li>
            <strong>Back up often.</strong> Uninstalling, clearing site data, or storage pressure
            can remove local projects.
          </li>
        </ol>

        <StatusBanner
          tone={
            storageProbe === 'ready'
              ? 'success'
              : storageProbe === 'limited'
                ? 'warning'
                : storageProbe === 'checking'
                  ? 'info'
                  : 'danger'
          }
          title={
            storageProbe === 'checking'
              ? 'Checking local storage…'
              : storageProbe === 'ready'
                ? 'Local storage is ready'
                : storageProbe === 'limited'
                  ? 'IndexedDB fallback is ready'
                  : 'Storage check failed'
          }
          message={
            storageProbe === 'limited'
              ? 'OPFS is unavailable, so SingScope will use bounded IndexedDB binary chunks. Back up important takes promptly.'
              : storageProbe === 'failed'
                ? 'Recording stays disabled until the storage check passes.'
                : undefined
          }
        />

        <div className="ss-button-row">
          <button
            className="ss-button ss-button--primary"
            type="button"
            onClick={onContinue}
            disabled={storageProbe === 'checking' || storageProbe === 'failed'}
          >
            Continue
          </button>
          <label className="ss-button" htmlFor="onboarding-backup-import">
            Import a backup
          </label>
          <input
            className="ss-visually-hidden"
            id="onboarding-backup-import"
            type="file"
            accept=".singscope.zip,.zip,application/zip"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              if (file) onImportBackup(file)
              event.currentTarget.value = ''
            }}
          />
        </div>
      </article>
    </main>
  )
}
