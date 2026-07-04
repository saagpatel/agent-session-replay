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
- Public release needs a final scrub of internal handoff notes and links.
- The local app intentionally avoids collectors, daemons, and write flows unless
  a separate operator decision approves them.

## Next Recommended Move

Keep this manual-only unless a concrete release, public packaging, or operating
diagnostics integration decision is active. For routine maintenance, run the
test/typecheck/build gates before changing parser, detector, or action-rail
behavior.
