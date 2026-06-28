# Agent Session Replay — Handoff

> Local-first failure-forensics for coding-agent sessions. Drop a Claude Code or
> Codex transcript → a proportional waterfall timeline + ranked "where it went
> wrong" findings. Cross-tool (one plumbline Trace schema), everything parses and
> renders in the browser; the transcript never leaves the machine.

## Status: SHIPPED (v1) — private on GitHub

- **Repo:** `github.com/saagpatel/agent-session-replay` (private), branch `main`.
- Net-new this session; built end to end, code-reviewed clean, MIT-licensed,
  packaged as a desktop app, pushed. Working tree clean.

## Completed

- **Parsers + schema** — `src/core/`: zero-dep TS core (`node --test
  --experimental-strip-types`). `parse.ts` sniffs harness → CC (`claude-code.ts`,
  merges `subagents/*.jsonl` sidechains) or Codex (`codex.ts`). One plumbline
  `Trace { plumbline_version, run, steps[], malformed_lines? }`.
- **Detectors** — `detect/`: 7 ranked findings (guard clusters, tool-error spike,
  stale-read race, compaction thrash, subagent cost runaway, hook denial, incomplete).
- **Timeline** — `view/timeline.ts`: proportional waterfall view-model + **idle-gap
  axis compression** (warp collapses idle spans > 5min; `gaps[]` + `axis[]` knots
  keep ruler/scrub truthful). Subagent lanes labeled by **agent type**, not hash id.
- **UI** — Vite 8 + React 19 SPA, one tokenized CSS file, no Tailwind. Drag-drop →
  waterfall + findings + step inspector. Kind-color legend, centered band,
  `⚠ N unparsed` integrity chip. Verified in a real browser (headless screenshots).
- **Quality** — 66 tests; `pnpm typecheck` gate (`@types/react` dev-only, core stays
  zero-dep); independent `/code-review` of the warp algo + parser → zero findings.
- **Desktop** — Tauri 2 shell (`src-tauri/`, no IPC; neutral identifier
  `dev.localfirst.agentsessionreplay`). `pnpm tauri build` → `.app` + 3.3MB DMG.
- **Release hygiene** — local paths scrubbed from tracked files; MIT LICENSE +
  matching `license` fields in `package.json` + `Cargo.toml`.

## In Progress / Next Steps

- **Virtualization** — window the waterfall for 6000+-step sessions (speculative; not
  yet needed — current sessions render fine).
- **Public release** — if flipping public: review `README.md` plumbline link
  (`saagpatel` handle) and whether to keep `HANDOFF.md` (internal notes). LICENSE is
  ready. Distribute the DMG via a GitHub *Release* (binaries are gitignored under `target/`).
- **Minor:** `parseJsonl` already counts malformed lines; `readEntry` (DropZone) still
  silently resolves on per-entry I/O error (graceful-degrade, acceptable for v1).

## Blocked

- None.

## Key Decisions

- Zero-dep TS core; plumbline Trace schema; cross-tool via a single `parseTranscript`
  sniffer. Vite 8 + React 19, no Tailwind, one CSS file. Tauri shell has **no IPC**
  (viewer is fully client-side). Cost analytics **dropped** (operator has cost-tracker
  MCP + ccusage). Run window must be **min/max of timestamps**, not array order.

## Verify / Run

`pnpm test` (66) · `pnpm typecheck` · `pnpm build` · `pnpm render:smoke <main.jsonl> [sidechains]`
· `pnpm dev` (web) · `pnpm tauri dev` / `pnpm tauri build` (desktop).
