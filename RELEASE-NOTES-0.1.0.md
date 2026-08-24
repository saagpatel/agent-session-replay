## Agent Session Replay 0.1.0

First public release.

Local-first failure forensics for coding-agent sessions: drop a Claude Code or
Codex transcript and get a proportional waterfall timeline plus ranked
"where it went wrong" findings. Everything parses and renders on your machine —
the transcript never leaves it. Includes the Decision Flight Deck v0 for Agent
Flight Recorder archives.

- Zero-dependency TypeScript core; one open [plumbline](https://github.com/saagpatel/plumbline)
  trace schema across both transcript formats.
- Signed with a Developer ID certificate, notarized by Apple, and stapled — the
  DMG opens cleanly on a stock Mac. Apple Silicon (aarch64) build.

Integrity: the DMG SHA-256 and the full distribution receipt (build, signing,
notarization, stapling, and Gatekeeper evidence) are attached as
`receipt-0.1.0.json`.
