# Architecture

## System shape

SingScope is a static React PWA. Feature screens depend on pure domain modules and injected browser adapters; the DSP, timeline, storage, and export code do not depend on React.

```text
React routes and mobile feature screens
        │
        ├── Canvas renderer (bounded viewport/LOD)
        ├── application store and repositories
        │       ├── Dexie metadata, targets, chunks, journals
        │       └── BinaryStore: OPFS → chunked IndexedDB fallback
        ├── audio runtime
        │       ├── persistent HTMLAudioElement → GainNode
        │       ├── MediaRecorder (encoded mic chunks)
        │       └── AudioWorklet (PCM stamps/level) → DSP worker
        └── static workers
                ├── YIN pitch analysis
                ├── MIDI parser
                └── export/ZIP preparation

Explicit diagnostic-report path (never automatic)
        └── local debug ZIP → Supabase Edge Function
                                    ├── private Storage object
                                    └── minimal report receipt/expiry metadata
```

The application shell remains a static PWA. The production URL uses hash routing and the Vite base `/singscope/`. The manifest identity and scope are `/singscope/`, and its launch URL is `/singscope/#/`, so GitHub Pages does not need rewrite rules. Databases, OPFS paths, caches, and events use a `singscope` namespace because Pages project sites under `joeypshell.github.io` share an origin. Workbox uses the explicit `singscope-app-shell-v1` cache ID. A deployment may additionally configure one narrowly scoped cross-origin Supabase report endpoint; it is not used for project persistence, authentication, sync, or routine analysis.

## Version contracts

Versions are intentionally independent:

- IndexedDB schema: database migrations and repository records.
- Project backup schema: validation and migration of portable project archives.
- Feedback package schema: coach/collaborator export contract.
- Analysis-debug package and report-receipt schemas: opt-in diagnostic upload contract.
- Pitch detector: changes to candidate generation and confidence.
- Metrics formulas: changes to scoring eligibility or calculations.

IDs are UUIDs. Metadata dates are UTC ISO-8601 values. Timeline values are finite seconds. Unvoiced or unavailable measurements are `null`, never zero, `NaN`, or infinity. Target revisions are immutable; manual edits create a new authoritative revision and re-analysis creates a draft.

## Timing and audio

`AudioContext.currentTime` is the canonical monotonic clock. `TransportClockSegment` records the mapping between context time, project time, take time, rate, and valid/scorable state. Playback, seek, loop, rate change, and material drift append/re-anchor a segment. Stalls, interruptions, and invalid media time ranges are preserved as analysis gaps.

The first Start tap resumes the context, requests wake lock, and invokes `HTMLMediaElement.play()` in the same user activation. The single persistent media element stays silent through countdown, then settles its loop-start seek before capture begins, re-anchors, and ramps in its Web Audio gain. A short reference that reaches its normal end during countdown is re-primed at the loop start. Transient `waiting`/`stalled` events mute output, invalidate scoring, and pause encoded capture until `playing`/`canplay`; only a continuous four-second stall becomes “Tap to retry” and a recoverable partial. A rejected play is surfaced immediately, and late failures from an older attempt cannot invalidate a newer retry.

The practice microphone stream is split. `MediaRecorder` writes supported encoded one-second chunks to temporary binary storage. Each committed take stores the project-time origin corresponding to encoded-media time zero, so a nonzero loop remains aligned when review playback starts at zero. An `AudioWorklet` only batches PCM, sample-clock stamps, RMS, and peaks; pooled transferable buffers enter a bounded worker queue. Heavy pitch work never runs in a React render or the worklet. Foreground loss, persistent reference failure, or interruption finalizes a recoverable partial take and never auto-resumes.

Project setup also offers a direct **Record melody** path for short, dry monophonic sources. It invokes microphone access from an explicit user action, records locally, and feeds the completed source into the same validation, memory-admission, YIN analysis, and candidate-note pipeline used by an uploaded isolated source. An interruption stops this capture and is surfaced to the user; it is never resumed automatically.

## Pitch detector decision

The bundled detector is an internal YIN implementation rather than a runtime library. This keeps the algorithm independently testable, avoids network/CDN/runtime code, and exposes raw candidates and confidence. Input is normalized to 24 kHz; analysis uses 1,536-sample (64 ms) frames every 480 samples (20 ms), an 80–1,200 Hz range, adaptive RMS/noise gating, and a default confidence eligibility threshold of 0.75.

YIN's cumulative mean normalized difference provides the candidate lag. Guardrails reject invalid and out-of-range frequencies. No target-assisted octave rewriting is performed. Every candidate and gap is retained. Only the live display receives a three-frame median followed by EMA smoothing; exports and metrics retain raw detections.

## Reference targets

MIDI parsing uses statically bundled same-origin `midi-json-parser-broker` and `midi-json-parser-worker` entrypoints. Format 0/1 PPQN files receive a merged tempo map. Format 2 and SMPTE division are rejected. Track/event/file limits apply before commit. Note overlap is preserved and flagged unscorable until corrected.

Manual editing offers pointer interaction and an authoritative form/list path. Uploaded or directly recorded isolated monophonic analysis reuses the detector and produces a draft candidate revision whose source-asset link is retained. Setup plays the exact analyzed source and overlays its accepted contour with the editable, quantized note blocks on a dynamically ranged, labeled pitch chart. Intended direct recordings are short phrases sung, hummed, whistled, or played one note at a time on a single-note instrument. Candidate pitches appear as editable piano-note names and timings; they are estimates, not an authoritative transcription. Once note blocks exist, that visible list is authoritative for scoring; a removed block cannot remain active through an invisible contour fallback.

Whole-file decoding is limited by an explicit memory budget. The DSP layer defines a bounded, cancellable foreground media-pass contract for larger accepted sources, but the current browser UI does not yet connect that adapter and asks for a shorter source instead. Chord/polyphonic transcription and mixed-song source separation are outside this MVP.

## Persistence and recovery

Dexie stores versioned structured records. `BinaryStore` selects OPFS after a write/read/delete probe and otherwise uses bounded IndexedDB chunks. Recording appends to a temporary logical asset. Finalization computes length, MIME and SHA-256, then commits the logical asset and metadata transactionally. Startup recovery exposes interrupted partial takes and removes unreferenced temporary assets.

Storage probes run before recording. Persistent-storage permission is requested only after an explicit first save. Quota errors become user-facing recovery/backup actions.

## Export

Export preparation is separate from the fresh Share/Save user tap required by iOS. A static worker writes safe fixed paths, incrementally hashes entries, stores already-compressed audio, and deflates text. Scratch output uses OPFS where available. The ZIP contains encoded recording, conditional WAV, CSV/JSON, a 1600×900 chart, script-free report, manifest and README. Reference audio is excluded unless the user explicitly accepts a rights warning.

## Direct diagnostic reporting

The missed-note diagnostic flow reuses the static export worker to build a bounded `singscope-analysis-debug.zip` in local scratch storage. Merely recording, analyzing, opening the panel, or filling its fields makes no remote request. One explicit **Send bug report** action prepares the package, requests a short-lived ticket bound to its package ID/hash/length, solves a small cancellable WebCrypto proof of work locally, and then posts the ZIP bytes as `application/zip` to the configured Supabase Edge Function. The response is a small versioned receipt containing the opaque report ID and receipt time.

The Edge Function is the only trusted writer. Before reading ZIP bytes it verifies the signed ticket/proof and atomically claims a single-use private reservation subject to concurrent and daily ceilings. It then validates the archive, writes it to a private Storage bucket, and records only the metadata needed to find and expire it. Any Supabase secret/service credential stays in the function environment; the public PWA contains only the endpoint and an optional publishable key. The client receives no bucket path, read credential, or public URL. Failed requests leave projects unchanged and expose retry plus a local **Save debug package** fallback when preparation succeeded.
