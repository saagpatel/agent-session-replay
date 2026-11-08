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
- Compare two runs of the same task with Run Diff, for example one by Claude Code and one by Codex (see below).

## Run Diff (experimental)

On the drop screen, choose **Compare two runs of the same task**, load one transcript per lane, and press **Compare runs**. The two runs line up step by step like a code diff, and the fork that changed the outcome is highlighted with a one- or two-sentence explanation.

- **Normalize** (`src/core/diff/normalize.ts`): the existing parsers produce both traces, then each step maps to a harness-neutral verb (read, search, edit, write, test, run, plan, delegate) and a workspace-relative target. A Claude Code `Read` and a Codex `sed -n` on the same file both become `read src/x.ts`. A compound shell line or a Codex `exec` cell yields one step per stage. Shell noise such as `pwd` is dropped, and read-only git commands count as reads. Other commands are not parsed further: their full text is the target, so `npm run build` and `npm run lint` stay distinct. `sed` fails closed: only the plain form `sed -n '<range>p' file` is a read, and any other `sed` (in-place, script files, other scripts, redirects) is an unparsed command. Codex cells fail closed: results are read only from a straight-line cell where every call prints its own result once, comments and strings are never read as calls, and a patch counts as applied only when its own output confirms it. Everything else is shown as unknown, never guessed.
- **Align** (`align.ts`): a global (Needleman-Wunsch) alignment. Matching a test or edit scores higher than matching a read. The same verb on a different target pairs as *changed*. Different verbs never pair; they show as one-sided rows.
- **Rank** (`rank.ts`): each fork is scored on edits, tests and commands over reads, a failure only one run ever hits, files only one run touches, whether the runs line back up afterwards, and, when the runs ended differently, how early the fork came. Forks that differ only in reads, searches or plan updates are cosmetic and never outrank a consequential one. Forks whose steps have no recorded result count like reads.
- **Verdict** (`run-diff.ts`): a run's end state comes from its last test run, from evidence only. It **passed** when that run exited cleanly *and* printed the test runner's passing summary, and a summary only counts when the test was the whole command (a leading `cd` aside). It **failed** when it exited with a failure or its summary reported failing tests. Anything in between (piped output, a missing result, no summary) is **unclear**. Runs without tests fall back to the harness completion signal; a test verdict and a completion verdict are never treated as different outcomes.

Like the rest of the app, Run Diff parses in the browser and uploads nothing.

### Known limits

Run Diff is experimental. It reads results from evidence only, and anything the transcript does not prove is shown as unknown (a step) or unclear (a run's verdict), never guessed:

- **Piped or chained tests are unclear.** A run passed only when its last test run exited cleanly *and* printed the runner's passing summary, with the test as the whole command. In `npm test | tail` or `npm test; git diff`, the exit status belongs to another command, so real agent runs often end unclear.
- **Complex Codex cells are unknown.** An `exec` cell is read only when it is straight-line and each tool call prints its own result once. Branches, `Promise.all`, unprinted calls or extra prints make every call in that cell unknown.
- **Unconfirmed patches and missing results are unknown.** A patch counts only when its own output confirms it applied. A call whose result never arrived, such as a cut-off run or a yielded command never polled, is unknown.
- **Some shell forms are still read too literally.** These are tracked as an open issue: commands built by joining strings, writes in `;` chains reported as succeeded, and piped non-test commands taking the last command's exit status.

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

Each live tick exclusively locks the normalized absolute state path for its full scan, adapter reconciliation, and state write. Configure separate watchdog instances with the same pathname spelling to share the lock; symlink aliases are not canonicalized. An overlapping tick fails closed and reports the lock path; use distinct state paths only when independent dedupe histories are intended. The lock is a sibling file named `<state path>.lock`, so the JSON state format stays unchanged. A normal tick removes only the lock it created. The CLI drains its active tick before exiting on SIGINT or SIGTERM. An abrupt process exit or power loss during a live tick can leave the lock behind: inspect its PID if present and confirm no watchdog still uses that state path before manually removing the stale lock and retrying. Locks are not reclaimed automatically.

## Privacy and release

Parsing and rendering happen locally. The app does not upload transcripts or AFR archives. Keep test fixtures synthetic and never commit session data. Use the repository's maintained macOS release process for signing, notarization, packaging, and publication; this repository's checks do not perform those actions.
