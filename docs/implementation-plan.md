# SingScope MVP implementation plan

1. Establish the pinned React/TypeScript PWA, GitHub Pages build, strict schemas, and local storage.
2. Implement MIDI/manual/monophonic targets and the reusable YIN pitch-analysis pipeline, including upload and local **Record melody** acquisition with editable piano-note names.
3. Build iPhone-safe microphone setup, shared transport clock, looping, recording, and live Canvas UI.
4. Add take review, transparent metrics, project backup, and coach-feedback ZIP export.
5. Harden imports, lifecycle cleanup, storage recovery, accessibility, offline updates, and CSP.
6. Verify pure DSP, components, mobile WebKit, iOS Simulator Safari, deployment, and physical iPhone, including the direct melody-recording path in Safari and installed Home Screen mode.

Automated verification and deployment are implementation gates. Physical-iPhone acceptance remains explicitly **awaiting hardware verification** until every item in `iphone-acceptance.md` is recorded against a deployed commit.
