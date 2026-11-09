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

### Work Equivalence

Work Equivalence compares canonical events while retaining every original member for expansion. Its rules are:

| RULES | Description |
| --- | --- |
| `read-coalesce` | Allowlist only: structured Read/read_file with known keys, or an entire literal sed -n 'N,Mp' file, sed -n 'Np' file, head -n N file, or cat file (plain command or exact sh/bash/zsh -c/-lc argv). Union successful overlapping/adjacent ranges of one file only across other reads/searches. Whole-file-or-unknown reads require identical evidence. Unsupported sources are global barriers and make comparison incomplete. |
| `search-dedupe` | Allowlist only: structured Grep/Glob with documented keys, or an entire literal rg command with only -n -i -w -l -F --no-heading flags, or grep -rn, with plain pattern/path tokens. Shell commands permit no quoting, expansion, chaining or redirects; only exact sh/bash/zsh -c/-lc argv wrappers are unwrapped. Merge identical successful searches across commuting events; retain every member. |
| `edit-batch` | Allowlist only: structured Edit/MultiEdit with known keys and replace_all omitted or false; structured Write/write_file use exact content and stay separate. Batch consecutive successful replacements of one file only when sequential composition matches the other side. Failed/unknown observations never merge. Tests/runs retain normalized signatures and are global barriers; only explicitly empty write_stdin status polls may be ignored. |

Successful consecutive reads and searches can be reordered for comparison. Reads never commute across edits. Delegates, unsupported sources, unresolved paths, and unknown workspace roots make a comparison incomplete.

Run `pnpm run-diff:equiv --eval` for the evaluation, `pnpm run-diff:equiv --count` for the fixture count, or `pnpm run-diff:equiv <fixture-slug>` to inspect a pair.

On this synthetic set of 40 pairs (20 labeled equivalent and 20 divergent), `--eval` reports 0/20 false matches (0.0%), 4/20 missed matches (20.0%), and 2 incomplete comparisons. The linear Run Diff baseline reports 15/20 false matches (75.0%) and 2/20 missed matches (10.0%). Incomplete comparisons are excluded from equivalence error counts; rates use the full labeled-class denominators. These figures describe only this synthetic set.

The four missed matches are:

- `09-extra-exploratory-read`: one side has an additional successful read; the comparison retains it.
- `18-distinct-file-read-around-edit`: the read moves across an edit, which is an order barrier even for distinct files.
- `23-extra-exploratory-reads`: one side has an additional read-only search; the comparison retains it.
- `26-identical-tests`: the test commands have different source evidence (plain command versus an argv shell wrapper), so their keys differ.

### Known limits

Run Diff is experimental. It reads results from evidence only, and anything the transcript does not prove is shown as unknown (a step) or unclear (a run's verdict), never guessed:

- **Piped or chained tests are unclear.** A run passed only when its last test run exited cleanly *and* printed the runner's passing summary, with the test as the whole command. In `npm test | tail` or `npm test; git diff`, the exit status belongs to another command, so real agent runs often end unclear.
- **Complex Codex cells are unknown.** An `exec` cell is read only when it is straight-line and each tool call prints its own result once. Branches, `Promise.all`, unprinted calls or extra prints make every call in that cell unknown.
- **Piped commands and unproven writes are unknown.** In `npm run build | grep -q ERROR` the exit status belongs to `grep`, so the build's own result is unknown. In a `;` chain, anything before the last stage is unknown even when the chain exits 0, since a failed stage does not stop it. A file in a directory made unknown by a dynamic `cd` or `workdir` is not named. A command is read only from a plainly written argument object (`{cmd: "…"}`); joined strings, spreads, duplicate or computed keys, or a variable or shorthand `workdir` leave it unparsed or its directory unknown.
- **Unconfirmed patches and missing results are unknown.** A patch counts only when its own output confirms it applied. A call whose result never arrived, such as a cut-off run or a yielded command never polled, is unknown.

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
