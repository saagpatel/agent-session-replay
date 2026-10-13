# AGENTS.md

## Purpose

Agent Session Replay is a local-first diagnostic viewer for coding-agent sessions. It parses Claude Code, Codex, and Agent Flight Recorder metadata into a shared trace model, then presents timelines, findings, and decision-oriented next steps. Transcript data is not uploaded.

## Layout

- `src/core/`: transcript and AFR parsers, trace model, detectors, and control-plane findings.
- `src/ui/`: Vite and React browser interface.
- `src/watchdog/`: explicit local session scan, alert policy, adapter, and terminal result.
- `src-tauri/`: Tauri desktop shell and Rust package.
- `scripts/`: local developer helpers, deterministic SSR checks, and release generation tools.
- `fixtures/`: synthetic inputs and expected smoke-test results.

## Setup

Use the versions pinned by `.node-version`, `package.json`, and `rust-toolchain.toml`. Install JavaScript dependencies with `pnpm install --frozen-lockfile`. Core tests use Node's built-in test runner and do not require a separate test framework.

## Checks

- `pnpm check`: type-check, tests, browser build, and deterministic render smoke.
- `pnpm test:ui`: SSR checks for UI replay behavior and archive import grouping.
- `pnpm audit --audit-level high`: dependency advisory gate.
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`: Rust shell compile check.
- `python3 -m unittest scripts.test_build_watchdog_release`: atomic release-builder tests.

There is no separate lint or format command configured. Keep changes focused and run the smallest relevant checks during development, followed by the requested delivery gates.

## Boundaries

- Parsing, findings, and rendering remain local. Do not commit real session or archive data.
- Keep fixtures synthetic and free of personal identifiers and machine-specific paths.
- The optional watchdog runs only when explicitly invoked. It reads recent session files and can call a local notification adapter; it does not stop, pause, or modify sessions.
- Missing discovery roots and sidechain directories are expected. Permission and I/O discovery failures must remain visible as partial, operator-actionable results.
- Adapter-handled receipts do not prove display or human attention.
- Do not add collection, upload, daemon, or write flows without a separate maintainer decision.
- Use the maintained desktop release process for signing, notarization, packaging, and publication.

## Delivery

Run `pnpm check` and relevant platform checks before delivery. Keep public release, signing, publishing, and deployment work out of routine source changes. Preserve the existing privacy boundary and report local checks separately from hosted, desktop-installation, or human-acceptance evidence.
