# Agent Session Replay

Local-first failure-forensics for coding-agent sessions. Drop in a Claude Code or
Codex transcript and find out *exactly where the run went wrong*: which guard trip,
Read-to-Edit race, runaway subagent, or cost spike broke it. Drop in an Agent
Flight Recorder local metadata archive and switch into a Decision Flight Deck for
ranked control-plane findings across local agent evidence.

The transcript never leaves the machine. Parsing and rendering happen entirely
locally.

## Why this exists

Generic local-first session viewers already exist (Mantra, claude-replay). They
render the timeline; they do not understand the harness. Agent Session Replay is a
**diagnostic engine first, viewer second**: it knows what `Blocked (bash-egress)`
means, that a `staleReadFileStateHint` is a Read-to-Edit race, and that a subagent
burning 200k tokens is a cost runaway. The scrubbable timeline is the evidence
panel; the ranked findings are the product.

## Design

- **Data model:** the [plumbline](https://github.com/saagpatel/plumbline) trace
  schema (`{ run, steps[] }`, an OTel-shaped decision DAG). Our parser output is
  drop-in compatible, and we enrich it through plumbline's open `attributes` bag
  rather than forking the schema.
- **Cross-tool:** one schema for Claude Code (`~/.claude/projects/**/*.jsonl`) and
  Codex (`~/.codex/sessions/**/rollout-*.jsonl`).
- **Core is dependency-free TypeScript.** The parser and detector engine run under
  `node --test` with native type-stripping, no toolchain install required. The
  browser UI (Vite + React) is a separate, later layer.

## Status

Shipped v1 local replay plus a v0 Decision Flight Deck for AFR metadata archives.
The deck parses `trace.afr.jsonl` with optional privacy, validation,
reconciliation, and manifest reports, then ranks privacy, validation, freshness,
reconciliation, boundary, cost-quality, bridge handoff, eval outcome, and failure
findings without uploading data.

The AFR path has been smoke-tested against a real metadata-only all-source local
archive. It supports the local collector's reconciliation source rows and treats
stale per-source evidence as ranked decision findings rather than passive
summary data when the archive is otherwise current; stale archives collapse to a
single refresh decision while preserving source freshness in the summary. Ranked
findings also feed a compact action rail that groups safe next commands into
route, inspect, refresh, and repair moves. Source-specific stale findings in a
fresh archive use inspect commands instead of looping back into another all-source
collection. Cost-tracker freshness respects healthy live ccusage reconciliation
so billing-period timestamps do not masquerade as stale source evidence.
Healthy artifact-store samples are marked historical rather than stale, keeping
the deck focused on operationally risky freshness gaps.

## Develop

```bash
pnpm test         # run the full test suite
pnpm typecheck    # TypeScript gate
pnpm build        # browser build
```
