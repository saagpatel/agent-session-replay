# Agent Session Replay — Handoff

> Local-first failure-forensics for coding-agent sessions. Drop a Claude Code or
> Codex transcript → a proportional waterfall timeline + ranked "where it went
> wrong" findings. Cross-tool (one plumbline Trace schema), everything parses and
> renders in the browser; the transcript never leaves the machine.

## Status: SHIPPED (v1) + Decision Flight Deck v0 — private on GitHub

- **Repo:** `github.com/saagpatel/agent-session-replay` (private), branch `main`.
- Base replay app built end to end, code-reviewed clean, MIT-licensed, packaged as
  a desktop app, pushed.

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
- **Decision Flight Deck v0** — drag-drop AFR archives (`trace.afr.jsonl` plus
  optional privacy, validation, reconciliation, manifest reports) → ranked
  control-plane findings with freshness, privacy tier, boundary/cost/outcome
  signals, bridge handoff/eval outcome checks, evidence refs, and safe next
  commands. Pure parser + engine, no new collector or daemon. Real all-source
  smoke confirmed reconciliation row support and stale per-source evidence
  findings. Stale archives collapse to one refresh decision while per-source
  freshness stays visible in the summary. The deck now derives a compact action
  rail from ranked findings, grouping safe next commands by
  route/inspect/refresh/repair. Source-specific stale findings in a fresh archive
  route to source-filtered inspection commands instead of repeating the all-source
  collection command. Cost-tracker freshness respects healthy live ccusage
  reconciliation so billing-period timestamps do not create stale source noise.
  Healthy artifact-store samples are marked historical rather than stale, keeping
  the deck focused on operationally risky freshness gaps. Eval failures preserve
  AFR redaction while surfacing aggregate assertion counts, command-result counts,
  and failed observation windows for safer routing decisions. The action rail now
  deduplicates repeated evidence refs, uses source-specific route titles, and
  adds compact decision reasons. Shared commands stay in one row while preserving
  every contributing category and reason. Source-specific freshness/routing quirks
  are centralized in a small source contract layer and the summary shows why each
  freshness state was chosen. Freshness override contracts now include
  representative reconciliation-row fixtures that lock the expected decision
  shape for future source-specific contracts. Stale source-specific archives now
  surface a runnable read-only source timeline inspection alongside the
  approval-gated refresh command, so sparse archives do not dead-end on
  collection approval. Bridge-db, notification-hub,
  hook-boundary, and MCP-boundary action wording now lives in source contracts
  instead of the control engine. Boundary/control findings are split per source,
  so mixed hook/MCP/notification evidence routes into separate source-filtered
  action rows. Action rows now carry compact boundary summaries, making bridge
  handoff pressure, notification routing, hook, MCP, and generic control signals
  visible without opening evidence refs. Action rows also explain their local
  safety boundary and source freshness reasons without exposing raw AFR rows.
  The rail keeps the top three commands visible and folds lower-priority actions
  behind a source-labeled expander for dense all-source archives. Commands carry
  a compact read-only/local-write/external-write/unknown safety chip and can be
  copied by explicit user click; passive viewing never writes the clipboard.
  Action rows also show command readiness: runnable now, needs a placeholder
  value, or needs explicit approval because it creates local artifacts or crosses
  an unknown/write boundary. Each action expands into a compact preview explaining
  why the command was suggested, what boundary it crosses, and which
  metadata-only evidence refs triggered it. The rail can also export one grouped
  command block by explicit click, limited to read-only commands that are
  runnable now; placeholder and approval-required commands are excluded by
  default. Actions and findings can copy grouped metadata evidence refs by
  explicit click, with raw-looking values excluded from the copied block. Each
  action has a compact bundle preview showing command export eligibility,
  readiness, boundary, and evidence-ref counts before anything is copied or run.
  Runnable read-only actions can copy a command + preflight + metadata-ref bundle;
  approval-required or placeholder commands keep bundle copy disabled with the
  blocked reason visible. Copied action bundles can be pasted back into the deck
  for a replay preview against the current AFR evidence, surfacing missing
  commands, missing metadata refs, source freshness drift, and blocked export
  status before anything is run. The replay preview can copy an export-only
  markdown decision note with top findings, next actions, replay verdict, and
  metadata evidence refs; the app does not write that note anywhere automatically.
  A scope preview shows included metadata refs, raw-looking excluded ref count,
  evidence sources, and privacy tier counts before the note is copied.
  Source presets filter the decision context to all, bridge-db, evals, cost, or
  hooks/MCP so findings, actions, replay preview, and decision note scope can
  narrow without changing the loaded AFR archive. Empty presets distinguish
  absent metadata from quiet metadata with no active findings, then show a
  read-only latest-timeline command for inspection, never a collection command.
  The action rail now includes a command safety ledger that
  groups every surfaced command by read-only, local-write, external-write, or
  unknown safety while keeping grouped export limited to runnable read-only
  commands. Preset switches also show a command delta preview, making hidden,
  appeared, and changed command safety/readiness visible before anything is
  copied or run. Pasted action-bundle replay uses the same context awareness,
  distinguishing commands hidden by the active preset from commands missing from
  the archive and surfacing title, safety, and readiness drift from older
  bundles. Copied decision notes include that replay scope and drift, so
  handoffs preserve why a pasted command is runnable, hidden, stale, or gone.
  Action bundles and decision notes also include a compact finding-to-command
  trace with finding kind, severity, source, signal, and metadata-ref count, so
  the handoff explains why each command exists. The same trace is visible inside
  each action's "Why this command" preview before copying anything, sorted by
  impact with lower-signal rows tucked behind a small disclosure when needed.
- **Quality** — 125 tests; `pnpm typecheck` gate (`@types/react` dev-only, core stays
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
- **Flight Deck confidence:** keep the next pass evidence-led: test several
  existing AFR archives (empty, stale, dense all-source, and source-specific) and
  tighten labels only where a real archive makes a decision ambiguous. Avoid
  adding collectors, daemons, or write flows; keep the deck a decision surface.

## Blocked

- None.

## Key Decisions

- Zero-dep TS core; plumbline Trace schema; cross-tool via a single `parseTranscript`
  sniffer. Vite 8 + React 19, no Tailwind, one CSS file. Tauri shell has **no IPC**
  (viewer is fully client-side). Cost analytics **dropped** (operator has cost-tracker
  MCP + ccusage). Run window must be **min/max of timestamps**, not array order.

## Verify / Run

`pnpm test` (125) · `pnpm typecheck` · `pnpm build` · `pnpm render:smoke <main.jsonl> [sidechains]`
· `pnpm dev` (web) · `pnpm tauri dev` / `pnpm tauri build` (desktop).
