import { StatusBanner } from '../../components/StatusBanner'

export interface ProjectSummaryView {
  readonly id: string
  readonly title: string
  readonly updatedLabel: string
  readonly takeCount: number
  readonly backupState: 'current' | 'due' | 'never'
}

export interface DashboardScreenProps {
  readonly projects: readonly ProjectSummaryView[]
  readonly storageMessage: string
  readonly installed: boolean
  readonly onCreateProject: () => void
  readonly onOpenProject: (id: string) => void
  readonly onImportBackup: (file: File) => void
  readonly onExportBackup: (id: string) => void
  readonly onDeleteProject: (id: string) => void
  readonly onOpenDemo?: (() => void) | undefined
}

export function DashboardScreen({
  projects,
  storageMessage,
  installed,
  onCreateProject,
  onOpenProject,
  onImportBackup,
  onExportBackup,
  onDeleteProject,
  onOpenDemo,
}: DashboardScreenProps) {
  return (
    <main className="ss-screen">
      <header className="ss-screen__header">
        <div>
          <p className="ss-eyebrow">Private, on-device practice</p>
          <h1>SingScope</h1>
          <p>
            Your projects and recordings stay in this{' '}
            {installed ? 'Home Screen app' : 'Safari context'}.
          </p>
        </div>
        <div className="ss-button-row">
          {onOpenDemo ? (
            <button
              className="ss-button"
              type="button"
              data-testid="open-demo"
              onClick={onOpenDemo}
            >
              Open synthetic demo
            </button>
          ) : null}
          <button className="ss-button ss-button--primary" type="button" onClick={onCreateProject}>
            New project
          </button>
        </div>
      </header>

      <StatusBanner
        tone={projects.some((project) => project.backupState !== 'current') ? 'warning' : 'success'}
        title="Storage & backup health"
        message={storageMessage}
      />

      <section aria-labelledby="projects-heading">
        <div className="ss-section-heading">
          <div>
            <h2 id="projects-heading">Projects</h2>
            <p>
              {projects.length === 0
                ? 'Start with a reference and target melody.'
                : `${projects.length} saved locally`}
            </p>
          </div>
          <label className="ss-button" htmlFor="backup-import">
            Import backup
          </label>
          <input
            className="ss-visually-hidden"
            id="backup-import"
            type="file"
            accept=".singscope.zip,.zip,application/zip"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              if (file) onImportBackup(file)
              event.currentTarget.value = ''
            }}
          />
        </div>
        {projects.length === 0 ? (
          <article className="ss-card ss-card--hero">
            <h3>Hear it. See it. Shape it.</h3>
            <p>Practice against MIDI, manually entered notes, or an isolated monophonic vocal.</p>
            <button
              className="ss-button ss-button--primary"
              type="button"
              onClick={onCreateProject}
            >
              Create your first project
            </button>
          </article>
        ) : (
          <ul className="ss-project-list ss-grid">
            {projects.map((project) => (
              <li className="ss-card" key={project.id}>
                <div className="ss-card__row">
                  <div>
                    <h3>{project.title}</h3>
                    <p>
                      {project.updatedLabel} · {project.takeCount} takes
                    </p>
                  </div>
                  <span aria-label={`Backup ${project.backupState}`}>
                    {project.backupState === 'current' ? '✓ Backed up' : '⚠ Backup due'}
                  </span>
                </div>
                <div className="ss-button-row">
                  <button
                    className="ss-button ss-button--primary"
                    type="button"
                    onClick={() => onOpenProject(project.id)}
                  >
                    Open
                  </button>
                  <button
                    className="ss-button"
                    type="button"
                    onClick={() => onExportBackup(project.id)}
                  >
                    Back up
                  </button>
                  <button
                    className="ss-button ss-button--danger"
                    type="button"
                    onClick={() => onDeleteProject(project.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
