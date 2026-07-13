# Repository instructions

- Use Node 24 and pnpm 11.7; keep direct dependency versions exact.
- Keep DSP/domain modules independent from React and browser persistence.
- Never use wall-clock time for audio alignment; use `AudioContext.currentTime`/context frames.
- Preserve raw pitch measurements and represent unvoiced data with `null`.
- User media stays local. Do not add telemetry, remote assets, or upload APIs.
- Treat imports and IndexedDB records as untrusted and validate through versioned schemas.
- Run `pnpm check` and the relevant Playwright flow before publishing changes.
- Do not claim physical-iPhone acceptance without completing the hardware checklist.
