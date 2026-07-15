# Repository instructions

- Use Node 24 and pnpm 11.7; keep direct dependency versions exact.
- Keep DSP/domain modules independent from React and browser persistence.
- Never use wall-clock time for audio alignment; use `AudioContext.currentTime`/context frames.
- Preserve raw pitch measurements and represent unvoiced data with `null`.
- User media stays local except for the explicit, warned **Send bug report** flow, which may upload only the prepared analysis-debug package to the approved Supabase endpoint. Never upload automatically or add telemetry, remote runtime assets, project sync, or a general-purpose upload API.
- Never expose a Supabase secret or service-role key in browser code or a `VITE_` variable. Client configuration may contain only the report URL and an optional publishable key.
- Treat imports and IndexedDB records as untrusted and validate through versioned schemas.
- Run `pnpm check` and the relevant Playwright flow before publishing changes.
- Do not claim physical-iPhone acceptance without completing the hardware checklist.
