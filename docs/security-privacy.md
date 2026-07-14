# Security and privacy

## Promise and scope

Microphone practice takes, directly recorded melody sources, imported references, targets, pitch traces, metrics, backups, and prepared packages are processed locally. SingScope has no upload endpoint, analytics, telemetry, ad/tracking code, account, external AI, or CDN. Loading or updating the application still makes ordinary HTTPS requests to GitHub Pages, which GitHub may log.

## Data flow and trust boundaries

```text
[untrusted local files] ──validation/staging──┐
                                             v
[microphone permission: take or target] ──MediaStream──> [browser sandbox]
                                             │
         [same-origin bundled workers] <─────┤
                                             │
                   ┌─────────────────────────┴────────────┐
                   v                                      v
       [IndexedDB / OPFS local data]              [user-triggered export]
                   │                                      │
           [backup chosen by user]                 [Share Sheet / Files]
```

Trust boundaries are the local-file importer, microphone and device APIs, browser storage, same-origin worker messages, service-worker updates, rendered metadata, ZIP extraction/generation, and the final user-selected share destination.

## Sensitive assets

- microphone audio and voice-derived biometric-like characteristics;
- project names, note labels, lyrics, timestamps, coach observations, and filenames;
- imported backing/reference audio that may be copyrighted;
- device labels, sample-rate/constraint settings, and calibration offsets;
- backup and feedback archives once saved outside browser storage.
- opt-in analysis-debug archives containing the exact analyzed audio, full raw detector evidence, capture settings, and browser user-agent/viewport metadata.

## Abuse cases and mitigations

| Case                                                                  | Mitigation                                                                                                                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oversized or malformed MIDI/audio/backup/ZIP exhausts memory or quota | Validate magic/type, compressed and expanded bytes, duration, counts, arrays/depth and paths before commit; stage imports; cancel foreground analysis; conservative iPhone limits. |
| ZIP slip, duplicate/confusable paths, active report content           | Fixed allowlist, normalized safe paths, duplicate rejection, script-free report, escaped metadata, no imported executable content.                                                 |
| CSV formula injection                                                 | Prefix spreadsheet-significant cells and quote RFC 4180 fields.                                                                                                                    |
| Script or worker injection                                            | Bundled same-origin assets only, no `eval`/dynamic imported code/blob workers, strict production meta CSP.                                                                         |
| Recording without clear intent                                        | Explicit microphone grant and Start/Record taps, persistent non-color recording indicator, foreground-only capture, interruption disclosure, and no auto-resume.                   |
| Partial or corrupt take after interruption                            | One-second temporary chunks, journal/commit state, hash/length/MIME commit, recoverable partial finalization, startup orphan cleanup.                                              |
| Accidental reference redistribution                                   | Reference audio excluded by default; explicit rights warning and package-size checks before opt-in.                                                                                |
| Accidental diagnostic-audio disclosure                                | Two separate Prepare and Share/Save gestures, explicit exact-audio/recipient warning, fixed 16 MiB package bound, sanitized metadata, and no application upload endpoint.          |
| Cross-project-site origin collision                                   | `singscope`-namespaced IndexedDB, OPFS paths, caches, events, and download names.                                                                                                  |
| Stale vulnerable dependency                                           | Exact direct versions, committed pnpm lockfile, Dependabot, production-dependency audit in CI, no remote runtime assets.                                                           |
| User assumes “local” means durable                                    | Onboarding, storage/backup health, first-take backup prompt, and explicit deletion/storage-pressure warnings.                                                                      |

## Production policy

The built HTML injects a CSP that denies everything by default and permits only same-origin scripts, stylesheets, connections, manifest and workers; `blob:` is limited to local media/images. Inline script and style attributes are not permitted. The explicitly namespaced service worker precaches only build output matching its shell allowlist, including static workers/worklet, icons, manifest and synthetic demo—not user imports or recordings.

GitHub Pages cannot provide `Permissions-Policy` or CSP `frame-ancestors` response headers. A meta CSP cannot express `frame-ancestors`. Residual clickjacking and broad origin-level permission policy are hosting limitations; a dedicated custom domain on a header-capable static host is the recommended hardening step.

## Residual risks

- Browser/iOS bugs or another compromised sibling project on the shared Pages origin could cross intended application boundaries.
- Local files are available to anyone with access to the unlocked device/browser profile; SingScope does not encrypt at rest.
- iOS may evict site data, reroute audio, stop background work, or terminate the process without notice.
- Export recipients and share destinations are outside SingScope's control.
- Monophonic pitch detection can produce octave and confidence errors in uploaded or directly recorded sources; it is an editable coaching aid, not chord transcription or a medical/diagnostic instrument.
