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
--experimental-strip-types`, Node ≥22.6). The Vite + React browser UI is a separate,
later layer that needs an **approval-gated** install. `@types/node` is intentionally
absent — `node:fs`/`process` editor diagnostics are expected, runtime is the gate.

## Next concrete step: pick a slice (core viewer is DONE)

The end-to-end product ships: drop a CC/Codex session → waterfall + findings,
local-first. Candidate next slices, roughly highest-value first:
1. **Cost analytics** — price tokens per model ($ in/out, cache-read ~0.1×,
   cache-creation ~1.25×) into a per-run + per-subagent cost view and a
   `cost_runaway` $ detector (current detector is token-count based).
2. **Live visual QA** — verified via SSR, not a real browser yet. Run `pnpm dev`,
   drive a headless browser, screenshot, tune spacing/contrast/alignment.
3. **@types/react + tsc typecheck** — approval-gated dev install
   (`pnpm add -D @types/react @types/react-dom`); then a `typecheck` script over a
   tsconfig.app.json (include src/ui + src/core, exclude *.test.ts + scripts).
4. **Waterfall virtualization** — big sessions render thousands of bars; windowing
   keeps it smooth (the 19MB CC session is ~6177 steps).
5. **Tauri 2 packaging** — wrap the SPA as a desktop app for offline distribution.

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
