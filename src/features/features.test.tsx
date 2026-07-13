import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewScreen, type ReviewView } from './review/ReviewScreen'
import { ProjectSetupScreen } from './setup/ProjectSetupScreen'
import { DashboardScreen } from './dashboard/DashboardScreen'

describe('dashboard', () => {
  it('keeps the synthetic demo available when projects exist', async () => {
    const onOpenDemo = vi.fn()
    render(
      <DashboardScreen
        projects={[
          {
            id: 'project-1',
            title: 'Warmup',
            updatedLabel: 'Today',
            takeCount: 2,
            backupState: 'current',
          },
        ]}
        storageMessage="Storage ready"
        installed
        onCreateProject={vi.fn()}
        onOpenProject={vi.fn()}
        onImportBackup={vi.fn()}
        onExportBackup={vi.fn()}
        onDeleteProject={vi.fn()}
        onOpenDemo={onOpenDemo}
      />,
    )
    await userEvent.click(screen.getByTestId('open-demo'))
    expect(onOpenDemo).toHaveBeenCalledOnce()
  })
})

describe('project setup', () => {
  it('offers an authoritative MIDI melody-track selector', async () => {
    const onTrack = vi.fn()
    render(
      <ProjectSetupScreen
        model={{
          title: 'Warmup',
          referenceName: 'reference.m4a',
          targetMode: 'midi',
          targetStatus: 'Two tracks found',
          notes: [],
          transpositionSemitones: 0,
          alignmentSeconds: 0,
          validationMessage: null,
          canSave: true,
          midiTracks: [
            { id: '0', name: 'Piano', noteCount: 80 },
            { id: '1', name: 'Lead', noteCount: 42 },
          ],
          selectedMidiTrackId: '0',
        }}
        onBack={vi.fn()}
        onTitleChange={vi.fn()}
        onReferenceFile={vi.fn()}
        onTargetModeChange={vi.fn()}
        onMidiFile={vi.fn()}
        onMidiTrackChange={onTrack}
        onIsolatedVocalFile={vi.fn()}
        onTranspositionChange={vi.fn()}
        onAlignmentChange={vi.fn()}
        onNoteChange={vi.fn()}
        onAddNote={vi.fn()}
        onRemoveNote={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    await userEvent.selectOptions(screen.getByLabelText('Melody track'), '1')
    expect(onTrack).toHaveBeenCalledWith('1')
    expect(
      screen.getByRole('img', { name: 'Touch piano roll for target note timing' }),
    ).toBeInTheDocument()
  })
})

describe('review controls', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => vi.unstubAllGlobals())

  it('exposes trace, cents, zoom, and loop replay controls', async () => {
    const onMode = vi.fn()
    const onZoom = vi.fn()
    const onLoop = vi.fn()
    const model: ReviewView = {
      projectTitle: 'Warmup',
      takeLabel: 'Take 1',
      playbackPhase: 'idle',
      currentSeconds: 0,
      durationSeconds: 10,
      scene: {
        viewport: { startSeconds: 0, endSeconds: 10, minMidi: 48, maxMidi: 84 },
        targets: [],
        raw: [],
        smoothed: [],
        gaps: [],
        playheadSeconds: 0,
      },
      metrics: [],
      sectionMetrics: [],
      selectedPoint: null,
      timingOffsetSeconds: 0,
      partialReason: null,
      export: {
        phase: 'idle',
        packageSizeLabel: null,
        shareSheetEligible: true,
        includeReference: false,
        includeWav: false,
        omissions: [],
        errorMessage: null,
        individualFiles: {
          recording: true,
          pitchCsv: true,
          targetCsv: true,
          chartPng: true,
          sessionJson: true,
          reportHtml: true,
          manifestJson: true,
          readme: true,
        },
      },
      traceDisplay: 'both',
      pitchMode: 'pitch',
      zoomLevel: 1,
      loopPlayback: false,
    }
    render(
      <ReviewScreen
        model={model}
        onBack={vi.fn()}
        onPlay={vi.fn()}
        onPause={vi.fn()}
        onStop={vi.fn()}
        onSeek={vi.fn()}
        onTimingOffsetChange={vi.fn()}
        onPrepareExport={vi.fn()}
        onShareExport={vi.fn()}
        onIncludeReferenceChange={vi.fn()}
        onIncludeWavChange={vi.fn()}
        onTraceDisplayChange={vi.fn()}
        onPitchModeChange={onMode}
        onZoomIn={onZoom}
        onZoomOut={vi.fn()}
        onLoopPlaybackChange={onLoop}
        onSaveRecording={vi.fn()}
        onSavePitchCsv={vi.fn()}
        onSaveChartPng={vi.fn()}
        onSaveSessionJson={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cents view' }))
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    await userEvent.click(screen.getByLabelText('Loop the visible review range'))
    expect(onMode).toHaveBeenCalledWith('cents')
    expect(onZoom).toHaveBeenCalledOnce()
    expect(onLoop).toHaveBeenCalledWith(true)
    expect(screen.getByRole('button', { name: 'Save recording' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save pitch CSV' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save chart PNG' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save session JSON' })).toBeEnabled()
  })
})
