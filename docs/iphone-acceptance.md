# Physical iPhone acceptance

Release status: **awaiting hardware verification**.

Record device model, iOS build, app commit SHA, audio route, available storage and tester for each run. A Simulator or Playwright result must not be entered as a physical pass.

## Installation and storage

- [ ] Open the live `/singscope/` site in Safari and install to the Home Screen.
- [ ] Create a Safari-mode project, export backup, import into Home Screen mode, and confirm the stores are otherwise separate.
- [ ] Force quit/relaunch, airplane-mode relaunch, update the service worker, and restore a backup.
- [ ] Exercise quota failure, site-data warning, orphan cleanup and interrupted partial-take recovery.
- [ ] Confirm uninstall/clear-data messaging and storage/backup health are understandable.

## Permission and audio routes

- [ ] Allow, deny, and recover microphone permission for both **Record melody** setup capture and practice takes; record actual applied capture settings.
- [ ] Test the built-in microphone and one wired/USB-C headset; label AirPods and speaker tests compatibility-only.
- [ ] Confirm multiple labeled inputs appear only when iOS exposes them.
- [ ] Exercise lock, Home/app switch, Siri/call, route change, mic-track stop, and context interruption during both capture paths. Practice must finalize a partial take; setup melody capture must stop visibly. Neither may auto-resume.
- [ ] Confirm rejected media playback exposes a working “Tap to retry” user action.

## Practice and performance

- [ ] Complete a five-minute take and repeated-loop/separate-take run without losing audio/pitch chunks.
- [ ] Verify countdown, guide tone, loop boundaries, seek/re-anchor, MIDI alignment, manual latency offset, and 1× playback.
- [ ] Use a reference shorter than the three-second countdown; confirm it is re-primed and all notes are audible after countdown. Trigger a brief buffer pause and confirm it recovers without a false retry; confirm a persistent stall finalizes a recoverable partial take.
- [ ] Enable slower rates only if `preservesPitch` works without choppy output on this device/route.
- [ ] Measure microphone-to-display latency and verify the chart sustains at least 30 FPS (DPR capped at 2).

## Files, review and export

- [ ] Import backing audio, isolated monophonic audio, MIDI format 0/1, a malformed/oversized example, and a project backup.
- [ ] In both Safari and the installed Home Screen app, record a short sung, hummed, whistled, and single-note-instrument melody; run local analysis; verify piano-note names/timings; correct the result with touch and exact inputs; then save and relaunch.
- [ ] In **Check what SingScope heard**, play the exact uploaded/recorded source and compare audible note changes with the accepted contour and editable note blocks across low, middle, and high supported pitches.
- [ ] Try a chord/polyphonic or mixed-song source and confirm the product makes no transcription or vocal-isolation claim and continues to label generated notes as estimates requiring review.
- [ ] Select a melody track; transpose/align it; correct overlap with both touch controls and exact form inputs.
- [ ] Review raw/smoothed and pitch/cents views; inspect points, gaps, low-confidence ranges and missed entrances.
- [ ] Prepare/share a <=64 MiB package; Save to Files a larger allowed package; open the ZIP and play the encoded recording.
- [ ] Verify fixed filenames, hashes, CSVs, JSON, chart, script-free report, conditional WAV, rights warning and individual downloads.

## Accessibility and layout

- [ ] Complete primary flows with VoiceOver in portrait and landscape.
- [ ] Verify safe areas, keyboard focus, exact time inputs, 44×44 targets, reduced motion and non-color status labels.

Acceptance requires every applicable item to pass on the current public iOS release. Failures must link to a reproducible issue or an explicitly approved limitation.
