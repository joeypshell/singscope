# CI and release gates

Automated jobs deliberately distinguish browser-engine coverage, Simulator Safari, a deployed-site smoke, and physical-device acceptance.

| Gate                              | Environment                                                      | What it establishes                                                                                                                               | What it does not establish                                                                    |
| --------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `quality`                         | Ubuntu, Node 24, pnpm 11.7                                       | Exact-lock install, production dependency audit, formatting, lint, strict types, core coverage thresholds, and the `/singscope/` production build | Browser media behavior                                                                        |
| `e2e-mobile-webkit`               | Playwright mobile WebKit with iPhone descriptors                 | Deterministic mobile flows, portrait layout, and selected landscape layout                                                                        | Shipping iPhone Safari or iOS audio routing                                                   |
| `e2e-ios-simulator-safari`        | Serial iPhone 17 / iOS 26.4 Simulator SafariDriver on `macos-26` | Safari availability/API smoke, deterministic demo interaction, Canvas presence, and reload behavior against a local Pages-base build              | Physical microphone, route, lock/call, storage-pressure, Share Sheet, or Home Screen behavior |
| `deploy-pages`                    | GitHub Pages                                                     | Publishes only after all pre-deploy automated gates pass on `main`                                                                                | Runtime correctness after CDN publication                                                     |
| `live-mobile-webkit-smoke`        | Playwright WebKit                                                | The public `/singscope/` path loads and passes its deployed smoke                                                                                 | iOS Safari acceptance                                                                         |
| `live-ios-simulator-safari-smoke` | Serial Simulator SafariDriver                                    | The public `/singscope/` path loads in the pinned iOS Simulator                                                                                   | Physical-iPhone acceptance                                                                    |
| Physical checklist                | Current public iOS on real hardware                              | The release acceptance described in `iphone-acceptance.md`                                                                                        | Compatibility on every older OS or secondary platform                                         |

The simulator job intentionally fails if the pinned runner lacks the named iOS runtime or device; it is never silently relabeled as an iPhone pass. Playwright jobs are named `mobile-webkit`, not “iOS Safari.”

## Local release-equivalent checks

Use Node 24 and pnpm 11.7, then run:

```sh
pnpm install --frozen-lockfile
pnpm audit:prod
pnpm check
pnpm test:coverage
pnpm exec playwright install webkit
pnpm test:e2e
```

`pnpm check` builds the Pages-base variant. Preview it with `pnpm preview:pages` at `http://127.0.0.1:4173/singscope/`.

## Release status

A green workflow and successful Pages deployment mean “automated gates passed.” They must not be described as “iPhone accepted.” That label requires the completed physical checklist with device model, iOS build, app commit SHA, audio route, tester, and recorded failures or approved limitations.
