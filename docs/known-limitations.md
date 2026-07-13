# Known limitations

- Physical-iPhone acceptance is pending until every item in `iphone-acceptance.md` is completed on the target public iOS release. Playwright WebKit and Simulator Safari are not shipping-device substitutes.
- The automated SafariDriver job is pinned to the iPhone 17 / iOS 26.4 simulator supplied by the `macos-26` runner. It is a simulator compatibility signal, not evidence for the initial physical iOS 26.5.2 target.
- iOS releases older than the current public version and iPadOS, macOS, Android, Chrome, Edge, and Firefox receive best-effort compatibility only.
- No chord/polyphonic transcription, mixed-song vocal isolation, or reliable melody extraction from a mastered track is provided. Imported backing audio is playback material, not an authoritative target.
- Home Screen and Safari projects may live in different storage containers; transfer requires backup/export and import.
- Capture is foreground-only. Lock, app switch, Siri/call, route loss, stopped mic track, or AudioContext interruption ends a practice take as recoverable partial data and stops a setup melody recording. Neither capture mode auto-resumes.
- AirPods and speaker-only capture may reroute, duck, or leak the backing track. Wired/USB-C headphones are the acceptance configuration.
- 0.5×, 0.75×, and 0.9× appear only after device capability/quality verification; 1× is always supported.
- MediaRecorder format is runtime-selected for practice takes and direct melody sources. iPhone usually provides encoded MP4/AAC, but actual browser support is authoritative.
- Direct **Record melody** analysis is capped at 60 seconds and 8 MiB and is intended for a short sing, hum, whistle, or single-note instrument phrase. YIN is monophonic and may misread breath noise, consonants, vibrato extremes, chords/polyphony, room echo, accompaniment bleed, or tones near range boundaries. Low-confidence ranges are not scored, and every candidate note requires review.
- Isolated-source whole-file analysis is memory-budgeted. A bounded foreground-pass DSP contract exists, but its browser media-element adapter is not connected in the current UI; sources over the whole-file budget are rejected with guidance to choose a shorter source.
- Latency depends on iPhone model, route, constraints and OS. A manual timing offset is available; no unmeasured sub-200 ms claim is made.
- The MVP does not encrypt browser storage, sync devices, recover deleted site data, or provide accounts/cloud backup.
- GitHub Pages cannot set `Permissions-Policy` or CSP `frame-ancestors` headers; see the security document.
- WAV and reference inclusion are omitted when size/peak-memory limits would be exceeded. Required non-WAV artifacts remain separately available.
