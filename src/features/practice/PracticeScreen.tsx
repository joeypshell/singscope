import { ExactTimeInput } from '../../components/ExactTimeInput'
import { PitchChartCanvas } from '../../components/PitchChartCanvas'
import { Sheet } from '../../components/Sheet'
import { StatusBanner } from '../../components/StatusBanner'
import { StickyPitchSummary } from '../../components/StickyPitchSummary'
import { TransportControls } from '../../components/TransportControls'
import type { PlaybackRate } from '../../audio/runtime/types'
import type { CaptureProfile } from '../../audio/runtime/microphone'
import type { PitchChartScene } from '../../rendering/pitch-chart'

export interface PracticeLoopView {
  readonly id: string
  readonly name: string
  readonly startSeconds: number
  readonly endSeconds: number
  readonly repetitions: number
  readonly enabled: boolean
}

export interface PracticeSectionView {
  readonly id: string
  readonly name: string
  readonly startSeconds: number
  readonly endSeconds: number
}

export interface MicrophoneView {
  readonly deviceId: string
  readonly label: string
}

export interface PracticeView {
  readonly projectTitle: string
  readonly phase: 'idle' | 'ready' | 'countdown' | 'recording' | 'paused' | 'retry' | 'finalizing'
  readonly currentSeconds: number
  readonly durationSeconds: number
  readonly countdownSeconds: number
  readonly currentNote: string | null
  readonly frequencyHz: number | null
  readonly cents: number | null
  readonly confidence: number | null
  readonly level: number
  readonly scene: PitchChartScene
  readonly loops: readonly PracticeLoopView[]
  readonly sections: readonly PracticeSectionView[]
  readonly selectedLoopId: string | null
  readonly supportedPlaybackRates: readonly PlaybackRate[]
  readonly playbackRate: PlaybackRate
  readonly microphoneInputs: readonly MicrophoneView[]
  readonly selectedMicrophoneId: string | null
  readonly appliedSettings: readonly string[]
  readonly failureMessage: string | null
  readonly noticeMessage: string | null
  readonly storageHealth: string
  readonly guideToneEnabled: boolean
  readonly captureProfile: CaptureProfile
  readonly recordingAvailable?: boolean
}

export interface PracticeScreenProps {
  readonly model: PracticeView
  readonly onBack: () => void
  readonly onStart: () => void
  readonly onPause: () => void
  readonly onStop: () => void
  readonly onSeek: (seconds: number) => void
  readonly onSelectLoop: (id: string | null) => void
  readonly onLoopChange: (loop: PracticeLoopView) => void
  readonly onAddLoop: () => void
  readonly onSelectSection: (id: string) => void
  readonly onPlaybackRateChange: (rate: PlaybackRate) => void
  readonly onMicrophoneChange: (deviceId: string) => void
  readonly onGuideToneChange: (enabled: boolean) => void
  readonly onCaptureProfileChange: (profile: CaptureProfile) => void
}

export function PracticeScreen({
  model,
  onBack,
  onStart,
  onPause,
  onStop,
  onSeek,
  onSelectLoop,
  onLoopChange,
  onAddLoop,
  onSelectSection,
  onPlaybackRateChange,
  onMicrophoneChange,
  onGuideToneChange,
  onCaptureProfileChange,
}: PracticeScreenProps) {
  const transportPhase = model.phase === 'ready' ? 'idle' : model.phase
  const selectedLoop = model.loops.find((loop) => loop.id === model.selectedLoopId)
  const recordingAvailable = model.recordingAvailable !== false
  return (
    <main className="ss-practice-screen">
      <div className="ss-screen__header">
        <div>
          <p className="ss-eyebrow">Practice</p>
          <h1>{model.projectTitle}</h1>
        </div>
        <button className="ss-button" type="button" onClick={onBack}>
          Projects
        </button>
      </div>

      <StickyPitchSummary
        phase={model.phase}
        noteName={model.currentNote}
        frequencyHz={model.frequencyHz}
        cents={model.cents}
        confidence={model.confidence}
        level={model.level}
      />

      {model.failureMessage ? (
        <StatusBanner
          tone="danger"
          title="Practice stopped safely"
          message={model.failureMessage}
          actionLabel={model.phase === 'retry' ? 'Tap to retry' : undefined}
          onAction={model.phase === 'retry' ? onStart : undefined}
        />
      ) : null}

      {model.noticeMessage ? (
        <StatusBanner tone="info" title="Playback buffering" message={model.noticeMessage} />
      ) : null}

      {model.captureProfile === 'raw' ? (
        <StatusBanner
          tone="info"
          title="Best vocal quality selected"
          message="Raw capture preserves sustained notes best with wired or USB-C headphones. If the guide is playing through the iPhone speaker, open Settings and choose iPhone speaker mode to reduce guide bleed; Safari may still lower the guide's quality while the microphone is active."
        />
      ) : (
        <StatusBanner
          tone="warning"
          title="Echo reduction can affect singing"
          message="Use this only when the guide must play through the iPhone speaker. Safari may gate or roughen a voice that matches the guide pitch."
        />
      )}

      {!recordingAvailable ? (
        <StatusBanner
          tone="danger"
          title="Recording unavailable"
          message="SingScope could not verify IndexedDB storage. Recording stays disabled so a take cannot be lost at commit time."
        />
      ) : null}

      <div className="ss-practice-layout ss-stack">
        <PitchChartCanvas
          scene={model.scene}
          label="Live target and detected pitch chart. Hollow points have low confidence; hatched areas are unscored gaps."
        />
        <TransportControls
          phase={transportPhase}
          currentSeconds={model.currentSeconds}
          durationSeconds={model.durationSeconds}
          countdownSeconds={model.countdownSeconds}
          loopEnabled={selectedLoop?.enabled ?? false}
          onStart={onStart}
          onPause={onPause}
          onStop={onStop}
          onSeek={onSeek}
          disabled={!recordingAvailable}
        />

        <div className="ss-stack">
          <Sheet title="Loops" summary={selectedLoop?.name ?? 'Full song'} defaultOpen>
            <div className="ss-button-row">
              <button
                className="ss-button"
                type="button"
                aria-pressed={model.selectedLoopId === null}
                onClick={() => onSelectLoop(null)}
              >
                Full song
              </button>
              {model.loops.map((loop) => (
                <button
                  className="ss-button"
                  type="button"
                  key={loop.id}
                  aria-pressed={loop.id === model.selectedLoopId}
                  onClick={() => onSelectLoop(loop.id)}
                >
                  {loop.enabled ? '↻ ' : ''}
                  {loop.name}
                </button>
              ))}
              <button className="ss-button" type="button" onClick={onAddLoop}>
                New loop
              </button>
            </div>
            {selectedLoop ? (
              <div className="ss-field-grid">
                <ExactTimeInput
                  label="Loop start"
                  valueSeconds={selectedLoop.startSeconds}
                  onChange={(startSeconds) => onLoopChange({ ...selectedLoop, startSeconds })}
                />
                <ExactTimeInput
                  label="Loop end"
                  valueSeconds={selectedLoop.endSeconds}
                  onChange={(endSeconds) => onLoopChange({ ...selectedLoop, endSeconds })}
                />
                <label className="ss-field">
                  <span>Repetitions</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={selectedLoop.repetitions}
                    onChange={(event) =>
                      onLoopChange({
                        ...selectedLoop,
                        repetitions: event.currentTarget.valueAsNumber,
                      })
                    }
                  />
                </label>
                <label className="ss-choice">
                  <input
                    type="checkbox"
                    checked={selectedLoop.enabled}
                    onChange={(event) =>
                      onLoopChange({ ...selectedLoop, enabled: event.currentTarget.checked })
                    }
                  />
                  <span>Repeat automatically as separate takes</span>
                </label>
              </div>
            ) : null}
          </Sheet>

          <Sheet title="Sections" summary={`${model.sections.length} sections`}>
            <ul className="ss-section-list">
              {model.sections.map((section) => (
                <li key={section.id}>
                  <button
                    className="ss-button"
                    type="button"
                    onClick={() => onSelectSection(section.id)}
                  >
                    {section.name} · {section.startSeconds.toFixed(1)}–
                    {section.endSeconds.toFixed(1)}s
                  </button>
                </li>
              ))}
            </ul>
          </Sheet>

          <Sheet title="Settings" summary={`${model.playbackRate}×`}>
            <div className="ss-stack">
              <label className="ss-field">
                <span>Playback rate</span>
                <select
                  value={model.playbackRate}
                  onChange={(event) =>
                    onPlaybackRateChange(Number(event.currentTarget.value) as PlaybackRate)
                  }
                >
                  {model.supportedPlaybackRates.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}×
                    </option>
                  ))}
                </select>
              </label>
              {model.microphoneInputs.length > 1 ? (
                <label className="ss-field">
                  <span>Microphone</span>
                  <select
                    value={model.selectedMicrophoneId ?? ''}
                    onChange={(event) => onMicrophoneChange(event.currentTarget.value)}
                  >
                    {model.microphoneInputs.map((input) => (
                      <option key={input.deviceId} value={input.deviceId}>
                        {input.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <fieldset className="ss-card">
                <legend>Microphone processing request</legend>
                <label className="ss-choice">
                  <input
                    type="radio"
                    name="capture-profile"
                    value="raw"
                    checked={model.captureProfile === 'raw'}
                    onChange={() => onCaptureProfileChange('raw')}
                  />
                  <span>Best vocal quality · processing off where iOS allows</span>
                </label>
                <label className="ss-choice">
                  <input
                    type="radio"
                    name="capture-profile"
                    value="echo-reduced"
                    checked={model.captureProfile === 'echo-reduced'}
                    onChange={() => onCaptureProfileChange('echo-reduced')}
                  />
                  <span>iPhone speaker mode · may gate or roughen singing</span>
                </label>
              </fieldset>
              <label className="ss-choice">
                <input
                  type="checkbox"
                  checked={model.guideToneEnabled}
                  onChange={(event) => onGuideToneChange(event.currentTarget.checked)}
                />
                <span>Guide tone during countdown</span>
              </label>
              <div>
                <h3>Applied capture settings</h3>
                <ul>
                  {model.appliedSettings.map((setting) => (
                    <li key={setting}>{setting}</li>
                  ))}
                </ul>
              </div>
              <StatusBanner tone="info" title="Local storage" message={model.storageHealth} />
            </div>
          </Sheet>
        </div>
      </div>
    </main>
  )
}
