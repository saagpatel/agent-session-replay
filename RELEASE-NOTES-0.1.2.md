## Agent Session Replay 0.1.2

This patch release improves accessibility and makes the signed macOS build
easier to install and verify.

- Add a single main landmark and clearer headings across initial, transcript,
  and Agent Flight Recorder views.
- Reduce dense timeline tab stops with roving keyboard navigation, focus the
  selected step details, and restore focus when details close.
- Announce invalid file input, expose preset selection state, and improve
  guidance when evidence sources are stale, quiet, or absent.
- Add direct macOS installation guidance and a provider-safe release filename.

Apple Silicon (`aarch64`) macOS build. Session transcripts remain local: they
are parsed and rendered on the machine.

The release includes a public verification receipt covering the exact tag,
artifact checksum, signing identity, notarization, stapling, Gatekeeper, and
provider readback. Independent clean-Mac verification was waived and is not
claimed.
