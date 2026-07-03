<!-- portfolio-context:start -->
# Portfolio Context

## What This Project Is

agent-session-replay is a local-first failure-forensics viewer for coding-agent sessions: drop a Claude Code or Codex transcript in and replay what the agent did, with idle-gap detection and per-agent-type lanes.

## Current State

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
during passive viewing.

## Stack

- Primary stack: React, TypeScript, Tauri 2
- JavaScript package manager: npm-compatible workflow

## How To Run

- Install dependencies with `pnpm install`.
- Start local development with `pnpm run dev`.
- Review the repo README for any required verification commands before shipping.

## Known Risks

- This repo only has minimum-viable recovery context today; deeper handoff details may still live in the README and supporting docs.

## Next Recommended Move

Use this context plus the README and supporting docs to resume the next active task, then promote the repo beyond minimum-viable by capturing a dedicated handoff, roadmap, or discovery artifact.

<!-- portfolio-context:end -->
