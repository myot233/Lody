# Oh My Pi native ACP

Status: draft
Translation: current

[中文](omp-native-acp.zh.md)

A user with a configured Oh My Pi installation can select **Oh My Pi (OMP)** on a
connected machine. Lody launches `omp acp` over stdio with stable identity
`registry/omp`. OMP owns installation, credentials, and configuration. Existing
built-in Pi providers and sessions retain their identities.

## Commands, Skills, and forms

The running process supplies models, modes, commands, and other capabilities.
Verification failures use the existing provider flow. The probe consumes the
latest standard `available_commands_update` for its session, including empty
lists and updates after `session/new`. An optional response list is a fallback;
without either list the probe waits up to one second. Cancellation closes the
process without caching success. Updated cache versions refresh previous probes.

The `/` menu displays advertised commands. Selection inserts the command and
prompt transport preserves its text and arguments, including the first turn:
system guidance and references are not appended to runtime commands. Skill and
extension commands appear when advertised; no static catalog substitutes for the
runtime's list.

The Skills menu maps default project `.omp/skills`, `.agent/skills`, `.agents/skills`
and user `~/.omp/agent/skills`, `~/.omp/agent/managed-skills`, `~/.agent/skills`,
`~/.agents/skills`. Additional roots and custom profile paths require runtime-aware
discovery and are outside this static mapping.

Standard ACP forms reuse the durable question/permission UI for strings, choices,
enumerated arrays, and booleans. Replies preserve field identity and JSON types
and validate required/enum constraints. Invalid or future Core metadata and
unsupported constraints are declined. Untagged `_other` fields remain independent;
defaults are not prefilled.

## Negotiated GUI components

A compatible agent can open a native custom component in Lody's question card.
Core v1 negotiates inert text/button/input documents on standard form elicitation.
The required `event` string contains version, component ID, revision, and input.
Only the active request can accept its matching event; stale/future events cancel.
The existing permission owner, cancellation, persistence, and history writers
remain authoritative. Historical frames disable input.

Palettes and shortcuts are component-local. Keys act only while the component
region has focus and do not intercept editable fields or IME input. Documents do
not contain HTML, scripts, URLs, arbitrary CSS, or remote widgets. UTF-8 document
size is at most 128 KiB with 256 nodes, 128 bindings and 4096-character input.

The patched OMP bridge executes native `ctx.ui.custom`, Theme and profile
KeybindingsManager, projecting bounded 80-column text frames and native key input.
Each input produces the next revision; completion returns the native result and
cancel/abort disposes the component, including a factory that finishes late.
This v1 protocol does not promise unsolicited animation, ANSI layout fidelity,
or native header/footer/widget placement.

## Native ACP extension behavior

The pinned extended OMP build also exposes native management and speech catalogs
through `/omp`, versioned acknowledged steering, reviewed atomic commit plans
through `/commit-plan`, and encrypted collaboration commands. These are advertised
runtime surfaces; selecting an official binary does not install the source patch.

Steering stays in the owning active turn, requires native application proof, and
withdraws canceled queued messages. Commit validation and approval precede native
index/HEAD mutation; canceled and invalid plans cannot produce commits.
Collaboration preserves local ACP identity and cwd, enforces read-only links, and
requires the host's `/collab watch` turn for guest prompts. Remote status previews
are bounded, remote usage is omitted when unknown, and leaving closes replicas and
owned sockets. Existing native crypto/write-token enforcement remains authoritative.

## Fixed acceptance baseline

Acceptance requires **100%** of the fixed
[36-family inventory](../apps/cli/src/agent/omp-integration-baseline.ts), covering
all 21 highlighted OMP features plus lifecycle, configuration, commands, forms,
permissions, MCP, media, context, jobs, sessions, usage, management, customization,
and security. Every required facet needs executed evidence. Partial, failed,
unsupported, or unverified families stay in the denominator. Discovery and source
inspection cannot earn a pass.

The [opt-in runner](../apps/cli/scripts/omp-integration-baseline.ts) checks real OMP
18.4.3 processes and Lody ACP clients with controlled external-service substitutes.
It verifies tool results and state, native capture/input on an owned Cocoa fixture,
real React GUI interaction and two encrypted native collaboration processes.
Provider, search, GitHub, relay, speech, LSP/DAP and MCP endpoints use synthetic
loopback services; Mnemopi owns a private FTS database and browser checks own a
headless Chrome process. Native desktop checks require macOS ARM64, `swiftc`, and
capture/accessibility permissions. Environment inheritance is allowlisted and
login-shell imports are disabled. Temporary state and owned children are removed;
reports contain outcomes/hashes rather than transcripts or workspace paths.

The measured `acp-extended` build completes **36/36**. The unmodified official
control completes 28/36; the MCP-only repair completes 29/36. Both controls fail
the current 100% gate. These results apply to the specified source/contract/binary
pins, not all OMP versions. The extended build needs both included source patches
and the Core source overlay described in the owning Note. Binary and patch digests
are checked before startup; a rebuild needs reviewed pins if its digest changes.
A separate built Electron check verifies the actual desktop command/component path.
Run from `apps/cli`:

```sh
pnpm exec tsx --tsconfig tsconfig.json scripts/omp-integration-baseline.ts \
  --build acp-extended --binary /path/to/omp --report /tmp/omp-baseline.json
pnpm exec tsc --noEmit -p tsconfig.omp-baseline.json
```

## Evidence

- [Decision, limits, build instructions and validation](../.agents/notes/implemented/feature/2026-09-30-omp-native-acp.md)
- [OMP source patch](../scripts/omp-acp-extended.patch), [Core contract patch](../scripts/omp-acp-core-components.patch)
- [Command discovery](../apps/cli/src/agent/acp-capabilities.test.ts)
- [Command transport](../apps/cli/tests/session-execution-helpers.test.ts)
- [Form/component validation](../packages/shared/tests/ask-user-question.test.ts)
- [Production card and native GUI acceptance driver](../packages/components/tests/ask-user-question-card.test.ts)
