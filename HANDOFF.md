# Agent Session Replay — Authoritative Handoff

> Single source of truth for resuming this build. Two Claude Code chats (same name)
> worked this repo **sequentially on one branch** — parser first, detector second.
> Git already consolidated them linearly; there is no divergence to merge. If a
> stale chat's CONTINUE → says "build the detector engine next," **ignore it** —
> that work is done (see below). Trust this file + `git log` over any chat prompt.

## Product

Local-first **failure-forensics** for coding-agent sessions (NOT a generic viewer —
a validator NO-GO'd the viewer because Mantra/claude-replay already ship free
local-first cross-tool replay). Ingest a Claude Code or Codex transcript, surface
*where the run went wrong*: guard/hook trips, Read→Edit races, cost runaways,
subagent fan-out failures. The scrubbable timeline is the evidence panel; the
**ranked findings are the product**. Wedge vs Langfuse/LangSmith/Helicone/Braintrust
= local-first + cross-tool + a "where did this go wrong" diagnostic lens. The
transcript never leaves the machine.

## Current state (committed, branch `feat/parser-core`, never touch main)

- `8af9e94 feat(core)` — JSONL parser + plumbline-compatible Trace schema + **Claude
  Code parser** with forensic signal extraction. Validated on real transcripts
  (a 19MB / 6177-step session, an evals session with real subagent sidechains).
- `ea3afaf feat(detect)` — **ranked findings engine** (THIS is the "build detector
  next" item — DONE). Validated on real data (a 538-step session surfaces 3
  CRITICAL mcp-guard clusters + a tool-error spike).
- `841d106 feat(codex)` — **Codex rollout parser + cross-tool dispatcher** (DONE).
  Emits the same plumbline Trace; `parse.ts` sniffs CC vs Codex and routes.
  Validated on a real Codex rollout (280 steps, gpt-5.3-codex, 14.9M input tokens,
  a compaction-thrash finding). 48/48 tests pass, zero deps.
- `0c608e5 feat(view)` — **proportional waterfall view-model** (DONE). Pure
  Trace -> TimelineView (lanes, positioned bars, finding markers). 57/57 tests.
- `1a94f28 feat(ui)` — **the viewer** (DONE). Vite + React 19 SPA. Drag-drop a
  session folder (recursively merges CC subagents/*.jsonl sidechains) or a Codex
  rollout -> in-browser parse + detect + waterfall + ranked findings + step
  inspector. Diagnostic-instrument design, one tokenized CSS file, no Tailwind.
  **THE CORE VIEWER WORKS END TO END.** Verified via `pnpm build` + headless SSR
  render (`pnpm render:smoke`) on real data: Codex -> 280 bars; CC -> 538 bars /
  11 lanes / 4 findings. Reviewed by nextjs-react-reviewer (memo, input reset,
  error surfacing, aria all fixed).
- `d0f3501 feat(ui)` — **visual-QA polish** (DONE). Eyeballed the real UI in a
  headless browser on real CC + Codex sessions; killed a top-stuck dead-space void
  (ruler + lanes + fault-lines now a vertically-centered connected band via
  `justify-content: safe center`) and added a step-kind color legend. Technique:
  old `--headless` one-shot screenshot (NOT `=new`, which hangs) + a JSON-fixture
  harness under `qa/` (gitignored; pre-parses real transcripts, renders the real
  components). See memory `reference-headless-visual-qa`.
- `965db10 build` — **tsc typecheck gate** (DONE). `pnpm typecheck` (`tsc -p
  tsconfig.app.json` over `src`, excluding `*.test.ts` + node scripts) catches type
  errors esbuild strips silently. Added `@types/react` + `@types/react-dom`
  (dev-only; core stays zero-dep) + `src/vite-env.d.ts` for CSS side-effect imports.
- `be1f3a7 fix(parser)` — **CC run-window fix** (DONE). `buildRun` set started/ended
  from the first/last event in ARRAY order; subagent sidechains concat in size order
  so the chronologically-latest event isn't last → the run window collapsed (a real
  session showed 25.5s instead of its true 14h27m span) and later steps clamped to
  the right edge, blanking the subagent lanes. Now min/max of parsed event
  timestamps, order-independent. Caught by an operator drag of a real CC session
  folder; regression test added. **58/58 tests, typecheck + build green.**

### What's on disk
- `src/core/jsonl.ts` — defensive JSONL line parser.
- `src/core/types.ts` — plumbline Trace `{ plumbline_version, run, steps[] }` +
  centralized `ATTR` key registry (OTel `gen_ai.*` / plumbline `harness.*`).
- `src/core/parsers/claude-code.ts` — CC transcript → Trace (llm turns, tool_use/
  result merge by `tool_use_id`, guard trips via `/^Blocked \(name\): reason$/`,
  stale-read Read→Edit race, subagent telemetry, hooks, compaction, mode changes).
- `src/core/detect/` — the findings engine. **Path is `detect/` (singular).** A
  stale chat proposed `detectors/` (plural) with a different Finding shape — that
  spec is superseded. The real, shipped shape:
  ```ts
  Finding = { id, kind, severity: "critical"|"warning"|"info",
              title, detail, step_ids: string[], score: number }
  ```
  Seven detectors: `guard_trip_cluster`, `subagent_cost_runaway`,
  `tool_error_spike` (tool_call-only; excludes guard/stale steps), `stale_read_race`,
  `compaction_thrash`, `hook_denial`, `incomplete_run`. Ranked by severity tier then
  magnitude; stable ids; thresholds centralized in `THRESHOLDS`.
- `scripts/parse-real.ts` — read-only smoke: `node --experimental-strip-types
  scripts/parse-real.ts <transcript.jsonl>` prints run summary + ranked findings.

### Stack (decided, do not re-litigate)
Dependency-free TypeScript core, tested via `npm test` (`node --test
--experimental-strip-types`, Node ≥22.6). The Vite + React browser UI is a separate
layer with `@types/react` (dev-only) and a `pnpm typecheck` gate over `src`. `@types/node`
is still intentionally absent — `node:fs`/`process` editor diagnostics on the test files
and node scripts are expected (those are verified by running them, not by tsc); the
typecheck config excludes them. Three verification surfaces: `pnpm test` (logic),
`pnpm typecheck` (types), `pnpm render:smoke` (SSR render), plus `pnpm build`.

## Next concrete step: pick a slice (core viewer DONE + browser-verified)

Drop a CC/Codex session → waterfall + findings, local-first. Verified end to end by
an operator drag of real sessions. Candidate next slices, highest-value first:
1. **Idle-gap compression (timeline)** — IN PROGRESS as of be1f3a7. Long/marathon
   sessions (e.g. the 14h27m operant session) render uselessly on a linear axis:
   activity bursts crush to slivers, the idle middle eats the chart. Collapse idle
   spans longer than a gap threshold into a `// gap //` break so each burst gets real
   width. Pure view-model time-warp (`buildTimeline`) + a UI break render; backward
   compatible (no big gaps → identity warp → unchanged). One knob: the gap threshold.
   **Top pick** — central to forensics on long runs.
2. **Waterfall virtualization** — big sessions render thousands of bars; windowing
   keeps it smooth (the 19MB CC session is ~6177 steps).
3. **Tauri 2 packaging** — wrap the SPA as a desktop app for offline distribution.
4. **Polish nits** — "load another" button affordance; agent-type lane labels
   (currently truncated subagent-id hashes).

DONE (no longer candidates): ~~Cost analytics~~ — dropped, redundant with the
`cost-tracker` MCP + ccusage CLI. ~~Live visual QA~~ → `d0f3501`. ~~@types/react + tsc
typecheck~~ → `965db10`.

> Install gotcha (banked): the `!` shell runs in `$HOME`, NOT the repo — use
> `pnpm -C ~/Projects/agent-session-replay add …` or installs land in $HOME and cause
> false-green typechecks (tsc walks up to a stray parent `node_modules`).

## Open follow-ups (deferred)
- `parseJsonl` malformed-line count so the UI can warn "N unparseable lines".
- `readEntry` (DropZone) silently resolves on per-entry I/O error — acceptable
  graceful-degrade for v1; surface a count if it bites.

## Open follow-ups (deferred, not yet done)
- Surface a **malformed-line count** from `parseJsonl` so the UI can warn "N
  unparseable lines" (forensic completeness; current behavior silently skips).
- **Cost-runaway pricing detector**: cache_read ~0.1×, cache_creation ~1.25× of
  input token price — a future cost-analytics slice (the current
  `subagent_cost_runaway` detector is token-count based, not priced).

## Assets to reuse
- `~/Projects/plumbline` — trace schema + offline scorer (already adopted;
  `recorders/claude_code.py` is what the CC parser was ported from).
- `~/Projects/Grotto` — OTel waterfall TUI; borrow `internal/render/layout.go`.
- `~/Projects/agent-flight-recorder-local` — Codex parsing reference (`adapters/codex.py`).
- `~/Projects/agent-flight-recorder` — adjacent prior art (metadata-only CLI), kept separate.

## Operating loop
Long autonomous turns; proceed at ≥70% confidence, stop only when blocked or at a
direction-changing decision. Keep a todo list. Verify before done (tests + parser
against real transcripts). `/code-review` (matching specialist) before every commit.
No push/deploy/publish/public — print exact commands for anything outward-facing.
End every turn with STATE + a fresh copy-paste CONTINUE → block.
