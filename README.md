# Agent Session Replay

Agent Session Replay is a local-first diagnostic viewer for coding-agent sessions. It parses Claude Code, Codex, and Agent Flight Recorder metadata into a shared trace model, then presents timelines, findings, and decision-oriented next steps. Transcript and archive data stay on the device.

## Status

The repository contains a browser app, a Tauri desktop shell, a TypeScript parsing and findings core, and an optional local watchdog. Desktop distribution uses the maintained macOS release lane. This repository does not collect transcripts in the background or upload them.

### Stack

- TypeScript 6 core, tested with Node's built-in test runner.
- Vite 8 and React 19 browser UI.
- Tauri 2 shell with a Rust package.
- pnpm and Node versions pinned in the repository; Rust uses the stable toolchain with `rustfmt` and `clippy`.

### Known risks

- Very large sessions may eventually need timeline virtualization.
- The optional watchdog reads recently changed session files and can invoke a local notification adapter when explicitly run. It does not kill, pause, or modify sessions. Filesystem discovery gaps are reported as partial, operator-actionable results; missing roots and sidechain directories remain expected and silent.
- Handled adapter receipts prove the adapter handled an attempt. They do not prove that a notification appeared or that a person read it.
- A clean local build does not prove independent desktop installation or acceptance on another machine.

### Next steps

Run `pnpm check` before changing parser, detector, or action-rail behavior. Use the desktop release lane for distribution work. Repository ownership questions about the control-plane/AFR and watchdog components remain for the maintainer.

## Features

- Drop a Claude Code or Codex transcript to inspect a proportional timeline, findings, tool calls, and session integrity.
- Drop one Agent Flight Recorder archive to view privacy, validation, reconciliation, freshness, cost, evaluation, and control-boundary findings.
- Replay a copied action bundle against loaded metadata. Source presets narrow the view; pasted bundle text remains available across preset changes, including empty presets.
- Copy a scoped decision note or eligible read-only command bundle by explicit user action. Viewing data does not write to the clipboard.
- Use the archive candidate helper to list existing local metadata archives without collecting or modifying them.

## Setup and checks

Install the pinned toolchain and dependencies, then run the aggregate check:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test:ui
```

`pnpm check` runs type-checking, the Node test suite, the browser build, and a deterministic server-render smoke check. It does not modify source files. `pnpm test:ui` runs SSR checks for replay behavior and AFR import grouping. High severity dependency advisories are checked separately with `pnpm audit --audit-level high`.

Other useful commands:

```sh
pnpm dev
pnpm tauri dev
pnpm afr:archives
pnpm watchdog --once --dry-run
```

The archive helper and watchdog are operational commands that read existing local session or archive data. Use synthetic fixtures and the test suite for routine verification. The watchdog dry run avoids adapter calls and state writes, but still discovers and reads configured session files.

## Watchdog boundaries

The watchdog is an optional, explicit local process. It scans recent Claude Code and Codex session files, applies the shared parser and detector, and may send approved findings to a local notification adapter. Only grind loops, quiescent silent stalls, and transcript-window budget failures may alert. Other findings remain in tick counts. The watchdog retains local dedupe and retry state so a failed acknowledgement can be reconciled without inventing a successful outcome.

Its terminal result distinguishes successful, partial, failed, and skipped runs. Discovery errors such as access denial or I/O failure make the result partial and require operator review. Expected missing roots or sidechain directories do not. Receipt counts describe adapter handling only, not operating-system display or human attention.

## Privacy and release

Parsing and rendering happen locally. The app does not upload transcripts or AFR archives. Keep test fixtures synthetic and never commit session data. Use the repository's maintained macOS release process for signing, notarization, packaging, and publication; this repository's checks do not perform those actions.
