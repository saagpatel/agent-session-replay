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
Eval failures preserve AFR's redaction boundary while still surfacing failed
observation counts, assertion counts when available, command-result counts, and
the failed observation time window for safer routing decisions.
The action rail deduplicates repeated evidence refs and uses source-specific route
titles so eval and cost follow-up are decision commands rather than generic alerts.
Each action includes a compact decision reason, such as critical eval failures,
estimated cost signal, or stale source evidence.
The repo also includes a read-only archive candidate helper
(`pnpm afr:archives`) that ranks existing local AFR run folders and prints the
best folder path to drop into the deck without collecting or modifying archives.
When multiple findings share one safe command, the rail keeps a single row while
showing every contributing action category and reason.
Source-specific freshness and routing quirks live in a small source contract
layer, rather than being scattered through the control engine. The source
freshness summary shows the contract or timestamp reason behind each state, so
`historical` and live-billing freshness are legible without opening raw AFR rows.
Freshness override contracts carry representative reconciliation-row fixtures, so
new source-specific contracts have to document their expected decision shape.
Source contracts also carry decision wording for bridge handoffs,
notification routing, hook boundaries, and MCP boundary evidence, keeping those
action labels declarative instead of embedded in the control engine.
Stale source-specific archives now surface a runnable read-only source timeline
inspection alongside the approval-gated refresh command, so sparse archives do
not dead-end on collection approval.
Boundary/control findings are split per source, so mixed hook, MCP, and
notification evidence routes into separate source-filtered action rows. Boundary
summaries now ride along on the action rows too, so follow-up commands show
whether they came from bridge handoff pressure, notification routing, hooks, MCP,
or a generic control signal without opening evidence refs. Each action also
explains its local safety boundary and the source freshness reason behind the
command, keeping command choice inspectable without exposing raw AFR rows. The
rail keeps the top three commands visible and folds lower-priority actions behind
a source-labeled expander so dense all-source archives stay scannable. Commands
carry a compact read-only/local-write/external-write/unknown safety chip and can
be copied from the action row by explicit user click; no clipboard write happens
during passive viewing. Actions also show readiness: runnable now, needs a
placeholder value, or needs explicit approval because it creates local artifacts
or crosses an unknown/write boundary. Each action can expand into a compact
preview explaining why the command was suggested, what boundary it crosses, and
which metadata-only evidence refs triggered it. The rail can also export one
grouped command block by explicit click, limited to commands that are both
read-only and runnable now; placeholder and approval-required commands stay out
of the exported block by default. Actions and findings can also copy grouped
metadata evidence refs by explicit click, with raw-looking values excluded from
the copied block. Each action also has a compact bundle preview showing command
export eligibility, readiness, boundary, and evidence-ref counts before anything
is copied or run. Runnable read-only actions can copy an action bundle with the
command plus preflight and metadata refs; approval-required or placeholder
commands keep the bundle copy disabled with the blocked reason visible. Copied
action bundles can be pasted back into the deck for a replay preview against the
currently loaded AFR evidence, surfacing missing commands, missing metadata refs,
source freshness drift, and blocked export status before anything is run. The
replay preview can also copy an export-only markdown decision note with top
findings, next actions, replay verdict, and metadata evidence refs; the app does
not write the note anywhere automatically. A scope preview shows included
metadata refs, raw-looking excluded ref count, evidence sources, and privacy tier
counts before the note is copied. Source presets filter the decision context to
all, bridge-db, evals, cost, or hooks/MCP so findings, actions, replay preview,
and decision note scope can narrow without changing the loaded AFR archive. Empty
presets distinguish absent metadata from quiet metadata with no active findings,
then show a read-only latest-timeline command for inspection, never a collection
command. The action rail also includes a
command safety ledger that groups every surfaced command by read-only,
local-write, external-write, or unknown safety while keeping grouped export
limited to runnable read-only commands. Preset switches also show a command
delta preview, making hidden, appeared, and changed command safety/readiness
visible before anything is copied or run. Pasted action-bundle replay uses the
same context awareness, distinguishing commands hidden by the active preset from
commands missing from the archive and surfacing title, safety, and readiness
drift from older bundles. Replay previews also include an operator next-step hint
for matched, hidden, missing, and blocked bundles, so the UI says whether to
switch presets, inspect evidence, refresh, or resolve approval first. Copied
decision notes include that replay scope, drift, and next-step hint, so handoffs
preserve why a pasted command is runnable, hidden, stale, or gone. Action bundles
and decision notes also include a compact finding-to-command
trace with finding kind, severity, source, signal, and metadata-ref count, so the
handoff explains why each command exists. Decision note evidence keeps explicit
source prefixes such as `evals:` even when a note is scoped to another preset,
while generic report/timestamp refs stay in a metadata bucket. The same trace is
visible inside each action's "Why this command" preview before copying anything,
sorted by impact with lower-signal rows tucked behind a small disclosure when
needed. Validation warnings are bucketed into decision-oriented signals such as
cost-quality, correlation-confidence, multiple-trace, and schema-field warnings,
then routed to the likely source when the warning text carries a source-shaped
record id. Copied decision notes lead with a Decision Pressure Map that
compresses top actions by reason, source freshness, labeled signals, and safe
command. Notes copied from filtered source presets include a Scope Caveat with
hidden all-source finding/action counts, and empty presets can copy a scoped note
with the safe read-only inspect command. A filtered or empty preset note is
therefore a scoped handoff, not an all-clear.

## Develop

```bash
pnpm test         # run the full test suite
pnpm typecheck    # TypeScript gate
pnpm build        # browser build
pnpm afr:archives # rank existing local AFR archive folders, read-only
```

## Decision Flight Deck Input

To pick a local AFR archive without collecting anything new:

```bash
pnpm afr:archives
```

Drop the printed `BEST` folder path into the app. The helper reads existing
metadata archives only; it does not create, modify, or upload archives.

Inside the deck:

- Use source presets to narrow the view without changing the loaded archive.
- Use action bundles when you want to replay one command against current evidence.
- Use decision notes when handing off context; they include pressure map, scope
  caveat, replay verdict, and metadata-only evidence refs.
- Empty preset notes are copyable too, and include the safe inspect command plus
  hidden all-source counts.
