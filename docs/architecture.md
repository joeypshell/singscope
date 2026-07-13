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
```

The production URL uses hash routing and the Vite base `/singscope/`. The manifest identity and scope are `/singscope/`, and its launch URL is `/singscope/#/`, so GitHub Pages does not need rewrite rules. Databases, OPFS paths, caches, and events use a `singscope` namespace because Pages project sites under `joeypshell.github.io` share an origin. Workbox uses the explicit `singscope-app-shell-v1` cache ID.

## Version contracts

Versions are intentionally independent:

- IndexedDB schema: database migrations and repository records.
- Project backup schema: validation and migration of portable project archives.
- Feedback package schema: coach/collaborator export contract.
- Pitch detector: changes to candidate generation and confidence.
- Metrics formulas: changes to scoring eligibility or calculations.

IDs are UUIDs. Metadata dates are UTC ISO-8601 values. Timeline values are finite seconds. Unvoiced or unavailable measurements are `null`, never zero, `NaN`, or infinity. Target revisions are immutable; manual edits create a new authoritative revision and re-analysis creates a draft.

## Timing and audio

`AudioContext.currentTime` is the canonical monotonic clock. `TransportClockSegment` records the mapping between context time, project time, take time, rate, and valid/scorable state. Playback, seek, loop, rate change, and material drift append/re-anchor a segment. Stalls, interruptions, and invalid media time ranges are preserved as analysis gaps.

The first Start tap resumes the context, requests wake lock, and invokes `HTMLMediaElement.play()` in the same user activation. The single persistent media element stays silent through countdown, then seeks/re-anchors at the loop boundary and its Web Audio gain ramps in. A rejected play is surfaced as “Tap to retry.”

The microphone stream is split. `MediaRecorder` writes supported encoded one-second chunks to temporary binary storage. An `AudioWorklet` only batches PCM, sample-clock stamps, RMS, and peaks; pooled transferable buffers enter a bounded worker queue. Heavy pitch work never runs in a React render or the worklet. Foreground loss/interruption finalizes a recoverable partial take and never auto-resumes.

## Pitch detector decision

The bundled detector is an internal YIN implementation rather than a runtime library. This keeps the algorithm independently testable, avoids network/CDN/runtime code, and exposes raw candidates and confidence. Input is normalized to 24 kHz; analysis uses 1,536-sample (64 ms) frames every 480 samples (20 ms), an 80–1,200 Hz range, adaptive RMS/noise gating, and a default confidence eligibility threshold of 0.75.

YIN's cumulative mean normalized difference provides the candidate lag. Guardrails reject invalid and out-of-range frequencies. No target-assisted octave rewriting is performed. Every candidate and gap is retained. Only the live display receives a three-frame median followed by EMA smoothing; exports and metrics retain raw detections.

## Reference targets

MIDI parsing uses statically bundled same-origin `midi-json-parser-broker` and `midi-json-parser-worker` entrypoints. Format 0/1 PPQN files receive a merged tempo map. Format 2 and SMPTE division are rejected. Track/event/file limits apply before commit. Note overlap is preserved and flagged unscorable until corrected.

Manual editing offers pointer interaction and an authoritative form/list path. Isolated monophonic analysis reuses the detector and produces a draft candidate revision. Whole-file decoding is limited by an explicit memory budget. The DSP layer defines a bounded, cancellable foreground media-pass contract for larger accepted sources, but the current browser UI does not yet connect that adapter and asks for a shorter source instead. Mixed-song source separation is outside this MVP.

## Persistence and recovery

Dexie stores versioned structured records. `BinaryStore` selects OPFS after a write/read/delete probe and otherwise uses bounded IndexedDB chunks. Recording appends to a temporary logical asset. Finalization computes length, MIME and SHA-256, then commits the logical asset and metadata transactionally. Startup recovery exposes interrupted partial takes and removes unreferenced temporary assets.

Storage probes run before recording. Persistent-storage permission is requested only after an explicit first save. Quota errors become user-facing recovery/backup actions.

## Export

Export preparation is separate from the fresh Share/Save user tap required by iOS. A static worker writes safe fixed paths, incrementally hashes entries, stores already-compressed audio, and deflates text. Scratch output uses OPFS where available. The ZIP contains encoded recording, conditional WAV, CSV/JSON, a 1600×900 chart, script-free report, manifest and README. Reference audio is excluded unless the user explicitly accepts a rights warning.
