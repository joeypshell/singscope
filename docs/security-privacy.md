# Security and privacy

## Promise and scope

Microphone practice takes, directly recorded melody sources, imported references, targets, pitch traces, metrics, backups, and prepared packages are processed locally during normal use. SingScope has no analytics, telemetry, ad/tracking code, account, external AI, runtime CDN, project sync, or cloud backup. Nothing is uploaded automatically.

There is one deliberate exception: after local source analysis, a user can read an exact-audio warning and explicitly press **Send bug report**. That action prepares and uploads one bounded diagnostic ZIP to the configured Supabase report endpoint. Loading or updating the application still makes ordinary HTTPS requests to GitHub Pages, which GitHub may log. Sending a report makes an HTTPS request to Supabase, which may likewise retain ordinary platform/request logs.

## Data flow and trust boundaries

```text
[untrusted local files] ──validation/staging──┐
                                             v
[microphone permission: take or target] ──MediaStream──> [browser sandbox]
                                             │
         [same-origin bundled workers] <─────┤
                                             │
                   ┌─────────────────────────┴─────────────────────┐
                   v                                               v
       [IndexedDB / OPFS local data]                  [user-triggered outputs]
                   │                                  │            │
           [backup chosen by user]       [Share Sheet / Files]     │
                                                                    │
                                                    explicit Send bug report
                                                                    │
                                                                    v
                                                     [Supabase Edge Function]
                                                        │          │
                                                        v          v
                                               [private Storage] [receipt/expiry row]
```

Trust boundaries are the local-file importer, microphone and device APIs, browser storage, same-origin worker messages, service-worker updates, rendered metadata, ZIP extraction/generation, final user-selected share destinations, the cross-origin report endpoint, private cloud storage, and operator access to submitted reports.

## Sensitive assets

- microphone audio and voice-derived biometric-like characteristics;
- project names, note labels, lyrics, timestamps, coach observations, and filenames;
- imported backing/reference audio that may be copyrighted;
- device labels, sample-rate/constraint settings, and calibration offsets;
- backup and feedback archives once saved outside browser storage.
- opt-in analysis-debug archives containing the exact analyzed audio, the user's optional issue description and expected note count, full raw detector evidence, capture settings, and browser user-agent/viewport metadata;
- opaque report/package IDs, archive hashes, byte counts, receipt times, expiry times, and ordinary Supabase request/Storage logs; infrastructure logs may include the deterministic UUID/hash object path but not the ZIP body.

## Abuse cases and mitigations

| Case                                                                  | Mitigation                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Oversized or malformed MIDI/audio/backup/ZIP exhausts memory or quota | Validate magic/type, compressed and expanded bytes, duration, counts, arrays/depth and paths before commit; stage imports; cancel foreground analysis; conservative iPhone limits.               |
| ZIP slip, duplicate/confusable paths, active report content           | Fixed allowlist, normalized safe paths, duplicate rejection, script-free report, escaped metadata, no imported executable content.                                                               |
| CSV formula injection                                                 | Prefix spreadsheet-significant cells and quote RFC 4180 fields.                                                                                                                                  |
| Script or worker injection                                            | Bundled same-origin assets only, no `eval`/dynamic imported code/blob workers, strict production meta CSP.                                                                                       |
| Recording without clear intent                                        | Explicit microphone grant and Start/Record taps, persistent non-color recording indicator, foreground-only capture, interruption disclosure, and no auto-resume.                                 |
| Partial or corrupt take after interruption                            | One-second temporary chunks, journal/commit state, hash/length/MIME commit, recoverable partial finalization, startup orphan cleanup.                                                            |
| Accidental reference redistribution                                   | Reference audio excluded by default; explicit rights warning and package-size checks before opt-in.                                                                                              |
| Accidental diagnostic-audio disclosure                                | No background send; one explicit **Send bug report** action after an exact-audio/cloud-retention warning; fixed 16 MiB package bound; sanitized metadata; report-ID confirmation.                |
| Public or cross-user report access                                    | Dedicated Supabase project, private Storage bucket, no public object URL or client policy, explicit anonymous read/list denial test, opaque report IDs, and operator-only reads.                 |
| Browser credential disclosure                                         | The bundle contains at most an optional Supabase publishable key. Secret/service-role credentials remain in Edge Function environment variables and must never use a `VITE_` name.               |
| Forged, corrupt, or oversized report requests                         | Edge validation of method, content type, bounded headers/body, schema version and SHA-256; server-issued paths; archives are stored as opaque data rather than executed.                         |
| Anonymous endpoint abuse or storage exhaustion                        | Signed 120-second identity tickets, bundled proof of work, atomic single-use reservations, four active uploads, 30 claims/96 MiB declared attempts, plus 10 accepted reports/32 MiB per UTC day. |
| Reports retained longer than expected                                 | Accepted rows receive a 30-day default expiry; a privileged cleanup task must delete both the private object and receipt row, with deletion failures monitored and retried.                      |
| Cross-project-site origin collision                                   | `singscope`-namespaced IndexedDB, OPFS paths, caches, events, and download names.                                                                                                                |
| Stale vulnerable dependency                                           | Exact direct versions, committed pnpm lockfile, Dependabot, production-dependency audit in CI, no remote runtime assets.                                                                         |
| User assumes “local” means durable                                    | Onboarding, storage/backup health, first-take backup prompt, and explicit deletion/storage-pressure warnings.                                                                                    |

## Production policy

The built HTML injects a CSP that denies everything by default and permits only same-origin scripts, stylesheets, manifest and workers; `blob:` is limited to local media/images. `connect-src` permits the configured Supabase report origin in addition to self only when direct reporting is configured. Inline script and style attributes are not permitted. The explicitly namespaced service worker precaches only build output matching its shell allowlist, including static workers/worklet, icons, manifest and synthetic demo—not user imports, recordings, or submitted report bodies.

The report bucket must remain private in a dedicated Supabase project. `bucket.public = false` does not neutralize pre-existing broad `storage.objects` policies, so a reused project is not an accepted production configuration. Client code must never receive a Supabase secret/service-role key, create public or signed download URLs, or write directly to Storage. The Edge Function is the sole writer and returns only a versioned receipt. A Supabase publishable key in the browser is an identifier, not a secret; endpoint authorization, validation, rate limiting, and private-bucket policy remain server responsibilities.

The intended default retention is 30 days from receipt. Each report records an expiry time, and a Vault-authorized hourly cleanup removes the Storage object before its matching metadata. Exact deletion timing remains an operational property of each deployment: verify the cron run, asynchronous pg_net response, and a synthetic end-to-end deletion before representing the retention window as enforced.

GitHub Pages cannot provide `Permissions-Policy` or CSP `frame-ancestors` response headers. A meta CSP cannot express `frame-ancestors`. Residual clickjacking and broad origin-level permission policy are hosting limitations; a dedicated custom domain on a header-capable static host is the recommended hardening step.

## Residual risks

- Browser/iOS bugs or another compromised sibling project on the shared Pages origin could cross intended application boundaries.
- Local files are available to anyone with access to the unlocked device/browser profile; SingScope does not encrypt at rest.
- iOS may evict site data, reroute audio, stop background work, or terminate the process without notice.
- Export recipients and share destinations are outside SingScope's control.
- A submitted diagnostic leaves the device and can be accessed by authorized Supabase project operators. Voice and room audio may identify the user or bystanders even though project names, filenames, lyrics, microphone identifiers, unrelated projects, and local storage identifiers are omitted.
- The public report endpoint is reachable by non-browser clients; CORS does not prevent abuse. Server limits, monitoring, and retention cleanup remain deployment responsibilities.
- The pre-body gate bounds expensive work but deliberately fails closed. A targeted attacker can still flood the cheap stateless ticket endpoint or consume the daily claim allowance; this residual availability risk is accepted to avoid accounts and remote challenge assets.
- Network failure can make direct-report delivery ambiguous: the service may commit before its receipt is lost. The app says delivery is unconfirmed, retains the same package identity for an idempotent retry, and can save the local package; it is not a durable outbox and does not send later in the background.
- Monophonic pitch detection can produce octave and confidence errors in uploaded or directly recorded sources; it is an editable coaching aid, not chord transcription or a medical/diagnostic instrument.
