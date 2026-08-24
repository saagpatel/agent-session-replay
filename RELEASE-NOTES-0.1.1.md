## Agent Session Replay 0.1.1

Patch release candidate focused on reliability and dependency security.

- Harden persisted watchdog-state loading: valid entries are preserved while
  malformed nested state is discarded safely instead of crashing the next
  alert cycle.
- Update Vite and the locked PostCSS and nanoid dependency graph to the
  validated advisory-safe floors.
- Add regression coverage for persisted-state recovery and dependency floors,
  plus continuous install, test, typecheck, build, and high-advisory audit
  verification.

Apple Silicon (`aarch64`) macOS build. Distribution remains local-first: session
transcripts are parsed and rendered on the machine.

If published, the DMG SHA-256 and the distribution receipt containing build,
signing, notarization, stapling, and Gatekeeper evidence accompany the release.
