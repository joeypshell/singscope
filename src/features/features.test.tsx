import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TargetNoteEditor } from '../components/TargetNoteEditor'
import { ReviewScreen, type ReviewView } from './review/ReviewScreen'
import { RecordedMelodyControl, type RecordedMelodyView } from './setup/RecordedMelodyControl'
import { AnalysisDebugPanel } from './setup/AnalysisDebugPanel'
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
      screen.getByRole('img', {
        name: 'Touch piano roll for target note timing and pitch after transpose',
      }),
    ).toBeInTheDocument()
  })

  it('offers local recorded-melody acquisition inside the analyzed-audio target mode', async () => {
    const onStart = vi.fn()
    const onUseAsReference = vi.fn()
    const onExpectedNoteCount = vi.fn()
    const onIssueDescription = vi.fn()
    const onPrepareDebug = vi.fn()
    const onRouteCategory = vi.fn()
    render(
      <ProjectSetupScreen
        model={{
          title: 'Piano melody',
          referenceName: 'reference.m4a',
          targetMode: 'isolated-vocal',
          targetStatus: 'Ready to record locally.',
          notes: [
            { id: 'note-1', startSeconds: 0, endSeconds: 1, midiNote: 60 },
            { id: 'note-2', startSeconds: 1, endSeconds: 2, midiNote: 64 },
          ],
          transpositionSemitones: 2,
          alignmentSeconds: 0,
          validationMessage: null,
          canSave: true,
          recordedMelody: {
            phase: 'idle',
            elapsedSeconds: 0,
            captureSettings: null,
            errorMessage: null,
            hasRecordedSource: false,
          },
          analysisSourceUrl: 'blob:recorded-source',
          analysisDebug: {
            phase: 'idle',
            reportingAvailable: true,
            canSavePackage: false,
            packageSizeLabel: null,
            errorMessage: null,
            reportId: null,
            receivedAt: null,
            expectedNoteCount: null,
            issueDescription: '',
            routeCategory: 'unknown',
          },
          analysisScene: {
            viewport: { startSeconds: 0, endSeconds: 2, minMidi: 58, maxMidi: 70 },
            targets: [{ startSeconds: 0, endSeconds: 1, frequencyHz: 293.66, label: 'D4' }],
            source: [{ timeSeconds: 0.5, frequencyHz: 261.63, confidence: 0.94 }],
            raw: [{ timeSeconds: 0.45, frequencyHz: 130.81, confidence: 0.58 }],
            smoothed: [],
            gaps: [],
          },
        }}
        onBack={vi.fn()}
        onTitleChange={vi.fn()}
        onReferenceFile={vi.fn()}
        onTargetModeChange={vi.fn()}
        onMidiFile={vi.fn()}
        onIsolatedVocalFile={vi.fn()}
        onStartRecordedMelody={onStart}
        onStopRecordedMelody={vi.fn()}
        onRecordMelodyAgain={vi.fn()}
        useRecordedSourceAsReference={false}
        onUseRecordedSourceAsReferenceChange={onUseAsReference}
        onAnalysisDebugExpectedNoteCountChange={onExpectedNoteCount}
        onAnalysisDebugIssueDescriptionChange={onIssueDescription}
        onAnalysisDebugRouteCategoryChange={onRouteCategory}
        onSendAnalysisDebug={onPrepareDebug}
        onSaveAnalysisDebugPackage={vi.fn()}
        onTranspositionChange={vi.fn()}
        onAlignmentChange={vi.fn()}
        onNoteChange={vi.fn()}
        onAddNote={vi.fn()}
        onRemoveNote={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    const sources = screen.getByRole('group', { name: 'Target source' })
    expect(within(sources).getByRole('button', { name: 'Audio / record' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const recording = screen.getByRole('region', { name: 'Record a melody' })
    expect(
      within(recording).getByText(/unless you explicitly tap.*Send bug report/),
    ).toBeInTheDocument()
    await userEvent.click(within(recording).getByRole('button', { name: 'Start recording' }))
    expect(onStart).toHaveBeenCalledOnce()
    await userEvent.click(
      within(recording).getByLabelText('Also use this melody audio as the backing audio'),
    )
    expect(onUseAsReference).toHaveBeenCalledWith(true)
    expect(screen.getByLabelText('Piano note sequence')).toHaveTextContent('D4 · F♯4')
    expect(screen.getByLabelText('Piano note 1')).toHaveTextContent('D4')
    expect(screen.getByLabelText('Piano note 2')).toHaveTextContent('F♯4')
    const verifier = screen.getByRole('region', { name: 'Check what SingScope heard' })
    expect(within(verifier).getByLabelText('Play the exact analyzed source')).toHaveAttribute(
      'src',
      'blob:recorded-source',
    )
    expect(within(verifier).getByText('Analyzed source contour')).toBeInTheDocument()
    expect(within(verifier).getByText('Raw candidates')).toBeInTheDocument()
    expect(within(verifier).getByText(/stores accepted pitch, raw candidates/)).toBeInTheDocument()
    expect(within(verifier).getByText(/note list below is authoritative/)).toBeInTheDocument()
    expect(within(verifier).getByText(/exact analyzed source audio/)).toBeInTheDocument()
    await userEvent.type(
      within(verifier).getByLabelText('Number of notes you played (optional)'),
      '7',
    )
    expect(onExpectedNoteCount).toHaveBeenLastCalledWith(7)
    await userEvent.selectOptions(within(verifier).getByLabelText('Microphone route'), 'built-in')
    expect(onRouteCategory).toHaveBeenLastCalledWith('built-in')
    fireEvent.change(within(verifier).getByLabelText('What went wrong? (optional)'), {
      target: { value: 'Only four appeared.' },
    })
    expect(onIssueDescription).toHaveBeenLastCalledWith('Only four appeared.')
    await userEvent.click(within(verifier).getByRole('button', { name: 'Send bug report' }))
    expect(onPrepareDebug).toHaveBeenCalledOnce()
  })

  it('sends a report in one explicit action and offers a local fallback after upload failure', async () => {
    const onSend = vi.fn()
    const onSavePackage = vi.fn()
    const base = {
      reportingAvailable: true,
      canSavePackage: false,
      packageSizeLabel: '2.4 MiB',
      errorMessage: null,
      reportId: null,
      receivedAt: null,
      expectedNoteCount: 7,
      issueDescription: 'Four notes appeared.',
      routeCategory: 'built-in',
    } as const
    const { rerender } = render(
      <AnalysisDebugPanel
        model={{ ...base, phase: 'idle' }}
        onExpectedNoteCountChange={vi.fn()}
        onIssueDescriptionChange={vi.fn()}
        onRouteCategoryChange={vi.fn()}
        onSend={onSend}
        onSavePackage={onSavePackage}
      />,
    )
    expect(screen.getByText(/does not send a report until you tap/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Send bug report' }))
    expect(onSend).toHaveBeenCalledOnce()

    rerender(
      <AnalysisDebugPanel
        model={{
          ...base,
          phase: 'error',
          canSavePackage: true,
          errorMessage: 'The report service could not be reached.',
        }}
        onExpectedNoteCountChange={vi.fn()}
        onIssueDescriptionChange={vi.fn()}
        onRouteCategoryChange={vi.fn()}
        onSend={onSend}
        onSavePackage={onSavePackage}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Bug report delivery not confirmed')
    await userEvent.click(screen.getByRole('button', { name: 'Retry sending report · 2.4 MiB' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save debug package' }))
    expect(onSend).toHaveBeenCalledTimes(2)
    expect(onSavePackage).toHaveBeenCalledOnce()
  })

  it('shows the validated report receipt after a direct upload', () => {
    render(
      <AnalysisDebugPanel
        model={{
          phase: 'complete',
          reportingAvailable: true,
          canSavePackage: false,
          packageSizeLabel: '2.4 MiB',
          errorMessage: null,
          reportId: 'SS-7f034c18',
          receivedAt: '2026-07-14T18:30:00.000Z',
          expectedNoteCount: 7,
          issueDescription: 'Four notes appeared.',
          routeCategory: 'built-in',
        }}
        onExpectedNoteCountChange={vi.fn()}
        onIssueDescriptionChange={vi.fn()}
        onRouteCategoryChange={vi.fn()}
        onSend={vi.fn()}
        onSavePackage={vi.fn()}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Bug report sent')
    expect(screen.getByRole('status')).toHaveTextContent('Report ID: SS-7f034c18')
  })

  it('shows recording status, elapsed context time, applied settings, and stop', async () => {
    const onStop = vi.fn()
    render(
      <RecordedMelodyControl
        model={{
          phase: 'recording',
          elapsedSeconds: 12.4,
          captureSettings: {
            deviceId: 'built-in',
            label: 'iPhone Microphone',
            sampleRate: 48_000,
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: null,
          },
          errorMessage: null,
          hasRecordedSource: false,
        }}
        onStart={vi.fn()}
        onStop={onStop}
        onRecordAgain={vi.fn()}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('● Recording melody')
    expect(screen.getByLabelText('Recording elapsed time')).toHaveTextContent('0:12.4')
    const settings = screen.getByRole('region', { name: 'Settings actually applied' })
    expect(settings).toHaveTextContent('iPhone Microphone')
    expect(settings).toHaveTextContent('48000 Hz')
    expect(settings).toHaveTextContent('Not reported')
    await userEvent.click(screen.getByRole('button', { name: 'Stop and analyze' }))
    expect(onStop).toHaveBeenCalledOnce()
  })

  it.each([
    ['requesting', 'Waiting for microphone permission…'],
    ['finalizing', 'Finishing local recording…'],
    ['analyzing', 'Analyzing recording on this device…'],
  ] as const)('announces the %s recorded-melody state', (phase, status) => {
    const model: RecordedMelodyView = {
      phase,
      elapsedSeconds: 0,
      captureSettings: null,
      errorMessage: null,
      hasRecordedSource: false,
    }
    render(
      <RecordedMelodyControl
        model={model}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRecordAgain={vi.fn()}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(status)
  })

  it('exposes retry for errors and completed recording drafts', async () => {
    const onRecordAgain = vi.fn()
    const { rerender } = render(
      <RecordedMelodyControl
        model={{
          phase: 'error',
          elapsedSeconds: 0,
          captureSettings: null,
          errorMessage: 'Microphone permission was denied.',
          hasRecordedSource: false,
        }}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRecordAgain={onRecordAgain}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Microphone permission was denied.')
    await userEvent.click(screen.getByRole('button', { name: 'Record again' }))

    rerender(
      <RecordedMelodyControl
        model={{
          phase: 'idle',
          elapsedSeconds: 5,
          captureSettings: null,
          errorMessage: null,
          hasRecordedSource: true,
        }}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRecordAgain={onRecordAgain}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Record again' }))
    expect(onRecordAgain).toHaveBeenCalledTimes(2)
  })

  it('shows piano note names after transposition in the authoritative editor', () => {
    render(
      <TargetNoteEditor
        notes={[
          { id: 'note-1', startSeconds: 0, endSeconds: 1, midiNote: 60 },
          { id: 'note-2', startSeconds: 1, endSeconds: 2, midiNote: 66 },
        ]}
        transpositionSemitones={-1}
        onChange={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('Piano note sequence')).toHaveTextContent('B3 · F4')
    expect(screen.getByLabelText('Piano note 1')).toHaveTextContent('B3')
    expect(screen.getAllByLabelText('MIDI note')).toHaveLength(2)
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
        source: [],
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
