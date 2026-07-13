# SingScope

SingScope is a private, local-first singing practice PWA. It aligns an editable target melody with backing audio, live monophonic pitch detection, microphone takes, transparent review metrics, and coach-ready exports. A target melody can come from MIDI, manual entry, uploaded monophonic audio, or a short melody recorded directly in setup. No recording or analysis is uploaded.

The acceptance target is an iPhone on the current public iOS release ([initial target: iOS 26.5.2](https://support.apple.com/en-us/127594)), with the installed Home Screen web app as the preferred experience. Older iOS releases and non-iPhone platforms are best-effort secondary targets, not formal acceptance platforms. Automated WebKit and iOS Simulator checks are useful compatibility gates, but **do not count as physical-iPhone acceptance**.

The public deployment target is [joeypshell.github.io/singscope](https://joeypshell.github.io/singscope/). Until the deployment workflow has completed successfully, use the local instructions below and treat the Pages URL as pending.

## Start locally

Use Node 24 and pnpm 11.7:

```sh
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm dev
```

Open the HTTPS URL printed by Vite, or `http://localhost:5173` on the development computer. Microphone access requires a secure context; browsers normally make an exception for `localhost`. A phone cannot use the computer's plain-HTTP LAN URL for microphone testing. Use a trusted HTTPS development tunnel or the deployed Pages build.

## Commands

```sh
pnpm dev                 # development server
pnpm typecheck           # strict TypeScript
pnpm lint                # ESLint, no warnings
pnpm format:check        # formatting verification
pnpm test                # unit and component tests
pnpm test:coverage       # measured core coverage and enforced thresholds
pnpm test:e2e            # mobile WebKit flows
pnpm build:pages         # /singscope/ GitHub Pages build
pnpm preview:pages       # preview that build at /singscope/
pnpm audit:prod          # production dependency audit
pnpm check               # local required checks
```

The static Pages build is emitted to `dist/`. After `pnpm build:pages`, run `pnpm preview:pages` and open `http://127.0.0.1:4173/singscope/`. The plain `pnpm build` / `pnpm preview` pair is the root-path development-production variant used by local Playwright.

## iPhone installation and local data

For a new user, install from Safari with **Share → Add to Home Screen** before creating the first project. Safari and an installed Home Screen web app can use separate IndexedDB/OPFS stores. To move an existing Safari-mode project, export a project backup in Safari, install/open SingScope from the Home Screen, then import that backup there.

Projects, imported audio, locally recorded melody sources, microphone takes, and analysis stay in the selected browser/app container. Uninstalling the Home Screen app, clearing website data, or iOS storage pressure can remove them. SingScope asks for a backup after the first successful take; backups remain the user's responsibility.

Use wired or USB-C headphones for the most predictable playback/capture route. AirPods and speaker-only use are compatibility modes because iPhone may reroute or duck audio during capture.

## Reference targets

- Standard MIDI format 0/1 with PPQN timing: supported and authoritative after track selection.
- Touch/manual note editing: supported and authoritative after edits.
- Uploaded isolated monophonic vocal/instrument analysis: assisted estimate; always editable.
- Local **Record melody** capture: sing, hum, whistle, or play one note at a time on a single-note instrument. Analysis stays on the device and produces editable piano-note names and timings.
- Chord, polyphonic, and mixed mastered-song transcription or vocal isolation: not implemented. A backing track is not claimed to contain an extracted melody.

Direct melody recording is foreground-only. If Safari or the Home Screen app is interrupted, capture stops and never auto-resumes; review the partial source if offered or record it again.

## Privacy and hosting

All runtime code and assets are bundled. There is no analytics, telemetry, account, cloud backend, external AI, upload API, CDN, or streaming-service integration. Normal app-shell requests reach GitHub Pages and may be logged by GitHub. Recordings are never requested by or sent to the application host.

GitHub Pages cannot set `Permissions-Policy` or CSP `frame-ancestors` response headers. The production document has a strict meta CSP, but a dedicated header-capable origin is the recommended future hardening path.

## Documentation

- [Architecture](docs/architecture.md)
- [Security and privacy](docs/security-privacy.md)
- [Known limitations](docs/known-limitations.md)
- [Physical iPhone acceptance checklist](docs/iphone-acceptance.md)
- [CI and acceptance gates](docs/ci-and-release.md)
- [Implementation plan](docs/implementation-plan.md)
- [Future roadmap](docs/future-roadmap.md)

## License

MIT © Joey P Shell contributors.
