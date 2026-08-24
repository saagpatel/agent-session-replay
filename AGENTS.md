# AGENTS.md

## What This Project Is

Agent Session Replay is a local-first diagnostic viewer for coding-agent sessions.
It parses Claude Code, Codex, and Agent Flight Recorder evidence into a shared
trace model, then surfaces timelines, findings, and decision-oriented next
actions without uploading transcripts.

## Current State

The repo is shipped as a private local app with a Vite/React browser UI, a
Tauri desktop shell, and a zero-dependency TypeScript core for parsing and
control-plane findings. Current work is maintenance and selective hardening, not
a broad rebuild.

## Stack

- TypeScript core
- Vite and React UI
- Tauri 2 desktop shell
- Node test runner
- Rust shell package under `src-tauri/`

## How To Run

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm afr:archives
```

Use `pnpm dev` for the browser UI and `pnpm tauri dev` for the desktop shell
when UI verification is needed.

## Known Risks

- Large sessions may eventually need timeline virtualization.
- The local app intentionally avoids collectors, daemons, and write flows unless
  a separate operator decision approves them.

## Distribution State (closeout 2026-08-24, Foundation Zero Proof Launch #2)

**The repo is PUBLIC and v0.1.0 is publicly distributed**: signed (Developer ID),
Apple-notarized, stapled, Gatekeeper-accepted, published at
https://github.com/saagpatel/agent-session-replay/releases/tag/v0.1.0 with
byte-verified provider readback (asset `Agent.Session.Replay_0.1.0_aarch64.dmg`,
sha256 `dc1cf5…511d`) and the distribution receipt attached as
`receipt-0.1.0.json`. Released from commit `bda18ba` on `main`.

- **Pre-publication review passed 2026-08-24**: no secrets, no real paths or
  identities in tree or history (fixtures use synthetic `/Users/x`), no
  transcript data ever tracked, MIT + react/react-dom only. The "final scrub"
  risk above is resolved: HANDOFF.md kept (clean), README plumbline link points
  at the public plumbline repo.
- **Release path**: `~/Projects/distribution-kit` macOS lane +
  `distkit.macos.config.sh` in this repo. Next release: bump `version` in
  `src-tauri/tauri.conf.json` + `DK_VERSION`/`DK_TAG`/`DK_DMG_PATH`, write new
  notes, run the lane.
- **Known non-blockers at release**: open Dependabot alerts are dev-scope
  (nanoid/postcss) plus runtime `glib` (Linux GTK stack, not in the macOS
  bundle); remediation in flight on `codex/security-dependency-convergence-*`.
- **No blocking distribution defect known.** Independent clean-Mac consumer
  proof: UNKNOWN (not claimed).

## Next Recommended Move

For routine maintenance, run the test/typecheck/build gates before changing
parser, detector, or action-rail behavior. The public/private question is
settled (public, released); future distribution work goes through the
distribution-kit lane rather than ad-hoc scripts.
