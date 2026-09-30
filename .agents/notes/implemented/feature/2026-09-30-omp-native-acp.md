# Oh My Pi through native ACP

Status: implemented
Translation: current

[中文](2026-09-30-omp-native-acp.zh.md)

## Abstract

Lody can launch the user's `omp acp`, discover its slash commands, and preserve
command arguments. A separate, pinned OMP source patch exposes native surfaces
that official ACP leaves inaccessible, including collaboration, atomic commit
plans, management, steering, and GUI components. The fixed 36-family acceptance
inventory completes 36/36 with real OMP processes and the Lody ACP client while
external services use controlled substitutes. The result applies to this patched
build; selecting an unmodified OMP installation does not supply those extensions.

## Integration ownership

The registry generator retains `registry/omp` across upstream refreshes; the
existing launch resolver starts `omp acp` without a managed download. OMP owns its
installation, credentials, and configuration. It keeps a separate identity from
[built-in Pi](2026-09-17-builtin-pi.md).

The generic capability probe consumes the latest command list for its own ACP
session. An empty list is authoritative, the response extension is a fallback,
and a missing list allows a bounded one-second wait. Cancellation closes the
process without caching success. Capability and Skills cache versions advance.
Default project roots are `.omp/skills`, `.agent/skills`, and `.agents/skills`;
user roots include `~/.omp/agent/{skills,managed-skills}` and the shared roots.
Custom profile paths require runtime-aware discovery. The composer and first-turn
execution preserve slash input without injected guidance: appended MCP prose
previously changed native command names or arguments in the desktop client.

Standard forms reuse the existing durable permission/question path. The neutral
reader preserves original field keys, restores booleans, validates required and
enum answers, and rejects unsupported constraints or invalid/future Core metadata.
Defaults are not prefilled; untagged `_other` names do not imply Core associations.
No alternate history writer or provider-specific renderer is introduced.

## Native extensions and authority

[The OMP patch](../../../../scripts/omp-acp-extended.patch) reuses native owners:

- MCP prompt catalogs become standard command updates; reconfiguration fences old
  managers and clears stale commands, including late stdio/HTTP catalogs.
- `/omp` exposes session/project/chat/usage/extension and speech model catalogs.
  Extension toggles use the native store and reload, including disabled entries.
- Core acknowledged steering queues a native message in the current turn. Only
  native `message_start` proves application; cancellation withdraws queued input
  and does not restart an idle turn.
- `/commit-plan validate|apply <plan.json>` uses native validation and split-commit
  staging. Approval precedes mutation, cancellation and invalid plans preserve
  HEAD/index, and accepted plans produce separate commits with exact file ownership.
- `/collab start|view|status|watch|stop`, `/join`, and `/leave` reuse encrypted
  native relay frames, write tokens, and file-backed snapshot replication. View
  links cannot submit prompts. An ACP host accepts guest input only during its
  owning `/collab watch` turn. Remote identity never replaces local ACP identity
  or cwd; unknown remote usage stays omitted. Status previews retain at most 20
  entries with bounded text. Replicas flush before resync and close on departure.

## GUI protocol and presentation

[Core's source patch](../../../../scripts/omp-acp-core-components.patch) owns the
shared v1 contracts; Lody imports them from the public Core submodule. Clients
negotiate `_meta.lody.elicitation.components.version = 1`. A standard form carries
an inert document and one required `event` string; replies bind component ID and
revision. Unknown versions, stale events, executable content, arbitrary CSS, and
oversized documents are rejected. Frames are limited to 128 KiB UTF-8, 256 nodes,
128 bindings, and 4096-character input.

The real question card renders text, buttons, input, a local palette, and focused
shortcuts through `@lody/ui`. Historical and pending frames disable actions. The
OMP adapter executes the native `ctx.ui.custom` factory, Theme, and profile
KeybindingsManager, then projects each 80-column text frame into this document.
CSI-u preserves remapped Ctrl+J rather than confusing it with Enter. Turn abort
also disposes factories that finish late. The owning Story demonstrates the same
production card.

This v1 bridge is input-driven: it does not stream unsolicited animations or
implement native header/footer/widget placement. ANSI layout is converted to
text with a component-local palette. This bounds the GUI contract without claiming
complete terminal API equivalence. The frozen customization facets verify native
themes, profile keybindings, and a custom component with its returned result.

## Acceptance and reproducibility

The [inventory and evaluator](../../../../apps/cli/src/agent/omp-integration-baseline.ts)
require **36/36 (100%)**. Every required facet must execute; partial, unsupported,
failed, and evidence-free facets stay in the denominator. Tests prove 28, 29,
and 35 families fail and 36 pass. The official control completed 28/36; the
[MCP-only patch](../../../../scripts/omp-acp-mcp-prompts.patch) completed 29/36.
Both fail the current 100% gate. Full acceptance requires the extended patch and
Core GUI contracts.

The final full native run completes 36/36. It verifies native tool results and
state, real LSP/DAP frames, two encrypted OMP collaboration processes, applied and
withdrawn steering, commit validation/approval/splits, forms, media, jobs, session
load/resume/fork, management persistence, browser interaction, security reports
from a fresh process, and actual desktop capture/input against an owned Cocoa
fixture. Customization drives the real React permission card and native component
through Ctrl+J and confirmation. A separate built Electron run verifies the actual
main/preload/renderer/CLI path and native result. All fixtures and external-service
responses are synthetic; no existing user window or installed OMP is changed.

Pins are source OMP `fc671eba383f2a7208500836673b485c0dc7073d` (18.4.3),
Core `c80616271c52de79ab4502fd58901d1e72088b86`, Bun 1.4.0 and Node 22.23.2.
The official native addon is `@oh-my-pi/pi-natives-darwin-arm64@18.4.3`, SHA-256
`820115e81da1d57b3a8fb5efc3780ca827ac568f8c2e74389d812b80c3d40461`.
Final patch/binary digests are exported by the evaluator and recorded in reports,
including the Core contract patch digest. The runner verifies those bytes before
startup. Rebuilds must be reviewed and repinned if the binary digest changes.

To reproduce from this Lody checkout, initialize its submodules and dependencies,
then build Core with `npm run build` and `npm run typecheck`. The included Core
patch also reproduces the contract change from its base commit. Clone OMP at the
pinned source, apply `scripts/omp-acp-extended.patch`, and run frozen `bun install`.
Replace the installed `node_modules/acp-extension-core` directory with a symlink
to this built Core checkout. The package's 0.1.8 registry dependency supplies
existing runtime steering definitions; the unreleased GUI types require this
explicit source overlay. Do not loosen the upstream release-age policy.
Build with `bun run build` from OMP's `packages/coding-agent`, then run:

```sh
# From Lody apps/cli; requires macOS ARM64, swiftc and native desktop permissions.
pnpm exec tsx --tsconfig tsconfig.json scripts/omp-integration-baseline.ts \
  --build acp-extended --binary /path/to/omp --report /tmp/omp-baseline.json
pnpm exec tsc --noEmit -p tsconfig.omp-baseline.json
```

Acceptance uses an environment allowlist and disables login-shell imports.
Loopback services replace external provider/search/GitHub/MCP/relay/speech services;
Mnemopi uses a private FTS-only database and browser checks own a headless Chrome
process. Reports retain outcomes and hashes, not transcripts or workspace paths.
Core build/typecheck/tests, owning upstream ACP/MCP/collaboration tests, scoped
formatting, Lody checks, and the opt-in script typecheck validate the source. The
[Spec](../../../../specs/omp-native-acp.md) remains draft pending human review.
No upstream OMP publication or replacement of the user's runtime is included.

Core contract dependency: [draft PR #16](https://github.com/LodyAI/acp-extension-core/pull/16), commit `a63f327`. It has no reported CI checks; local build/typecheck/tests passed.
