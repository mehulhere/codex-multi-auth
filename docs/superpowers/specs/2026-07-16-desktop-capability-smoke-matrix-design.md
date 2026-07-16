# Desktop Capability Smoke Matrix

## Problem

The current Desktop bind preserves the native `openai` provider and enables the
relevant feature flags, but those facts do not prove that every capability can
complete through the live app, router, and upstream service. Capabilities cross
different boundaries: some are local Desktop tools, some are MCP/plugin tools,
some are hosted OpenAI tools carried inside Responses requests, and some use
dedicated HTTP endpoints such as image generation. A single generic health
check can therefore report a false success.

## Goals

- Inventory every capability expected from the current Desktop feature profile.
- Distinguish configuration, discovery, deterministic router contract, live
  upstream execution, and interactive hardware/UI verification.
- Run real, low-impact live probes where automation is safe.
- Produce redacted JSON and human-readable reports with one row per capability.
- Fail the command when a required automated or live capability fails.
- Keep interactive-only checks visible instead of silently treating them as
  passing.
- Commit and push this harness independently before WebSocket implementation.

## Non-goals

- Exercise every tool contributed by every future third-party plugin.
- Automate destructive Computer Use clicks or type into arbitrary applications.
- Record microphone audio without an explicit interactive action.
- Treat a feature flag, installed file, or tool declaration as proof that a live
  action succeeded.
- Store prompts, generated images, credentials, or raw upstream response bodies.

## Considered Approaches

### 1. Feature and file checks only

Check `codex features list`, plugin configuration, and bundled files. This is
fast and deterministic but repeats the false confidence that exposed the
unsupported-route failure. Rejected as the primary test strategy.

### 2. Prompt the live model to use every tool

Run a natural-language prompt for every capability. This covers the complete
path, but model tool choice is nondeterministic and interactive tools can affect
the user's desktop. Rejected as the only strategy.

### 3. Layered capability manifest with opt-in live probes (selected)

Define every capability once in a manifest. Give each capability deterministic
configuration/discovery/contract checks, then add an explicit live or
interactive probe where appropriate. Reports state exactly which layer passed.
This is repeatable in CI while still giving strong evidence on the user's live
machine.

## Capability Inventory

The initial manifest covers:

| Capability | Deterministic evidence | Live evidence | Interactive boundary |
| --- | --- | --- | --- |
| Responses text streaming | authenticated secret path, upstream auth replacement, SSE completion | one minimal text turn | none |
| Model discovery | authenticated `/models` contract | live `200` and parseable model list | none |
| Function tools | tool declaration and tool output forwarded unchanged | forced disposable echo-tool round trip | none |
| Hosted web search | `web_search` declaration forwarded unchanged | response contains a hosted-search event and completion | none |
| Image generation | exact secret-only pass-through and header policy | one minimal image response validated in memory | none |
| Computer Use | declaration/result payload preservation and feature discovery | safe screenshot/no-op availability probe when exposed | clicks and typing remain disabled |
| In-app browser | bundled browser plugin, skill, MCP configuration, and tool discovery | open a disposable blank/local page when the bridge is callable | no external form submission |
| Plugins | enabled plugin manifests resolve to installed bundles | tool discovery from enabled bundles | connector login may remain user-owned |
| Bundled skills | every enabled bundle has a readable complete `SKILL.md` | selected skill discovery through a fresh task | none |
| Dictation | native ChatGPT auth identity, feature/resource/media bridge readiness | microphone-control discovery | speaking a phrase is interactive-only |
| Read aloud | plugin/resource/MCP discovery | synthesize or play a disposable short phrase when callable | audio-output confirmation is interactive |
| Conversation/Farfield bridge | enabled resource and bridge health | loopback readiness probe | microphone conversation is interactive |
| Thread goal/status | authenticated goal endpoints and redacted persistence | live set/get round trip on disposable key | none |
| Shared history | native provider plus all-provider list contract | fresh thread appears and remains reopenable | visual confirmation optional |

The manifest is exhaustive for the committed Desktop feature profile at the
time of the run. Unknown newly enabled features are reported as an inventory
failure until they receive an explicit probe definition.

## Command And Report Design

Add a script command equivalent to:

```bash
npm run test:desktop-capabilities -- --json
npm run test:desktop-capabilities -- --live --json
npm run test:desktop-capabilities -- --live --interactive --json
```

- Default mode performs deterministic, non-billable checks.
- `--live` permits minimal upstream requests and one disposable image.
- `--interactive` permits safe UI/audio availability checks but never arbitrary
  clicks, typing, or credential entry.
- `--require <capability>` can make a subset mandatory for focused debugging.
- Secrets, account emails, prompts, image bytes, and raw tool output are never
  printed. Reports include status, checked layers, duration, HTTP status or
  stable error code, and a redacted remediation hint.

Each row has one of these statuses:

- `passed`: every required layer for the selected mode completed.
- `failed`: a required layer was attempted and failed.
- `not_available`: the current Desktop/Codex build does not expose it.
- `interactive_required`: automation reached the intentional human boundary.
- `skipped`: the selected command mode did not permit the probe.

`interactive_required` is not converted into `passed`. The human-readable
summary lists the exact remaining action.

## Architecture

Create a focused `lib/runtime/desktop-capability-smoke.ts` module containing the
manifest, result types, redaction, probe orchestration, and dependency-injected
HTTP/process/filesystem adapters. Keep CLI parsing and output in
`scripts/test-desktop-capabilities.js`. Tests use fake adapters for deterministic
coverage and a local mock HTTP server for route contracts.

The live runner reads the existing app-bind state and configuration through
current runtime-path helpers. It must not parse or print credentials itself.
Native-auth-only probes obtain headers through the same protected helpers used
by the app bind or report `not_available` when a safe credential path is not
exposed.

## Failure Handling

- Router unavailable: fail router-dependent rows with one shared remediation.
- Missing Desktop checkout: report Desktop-only rows as `not_available`; do not
  fail unrelated router checks unless explicitly required.
- Upstream quota exhaustion: report the stable pool-exhausted code separately
  from protocol incompatibility.
- Tool declared but live call fails: mark `failed`, even when the feature flag is
  true.
- Live probe creates output: validate in memory and discard it.
- Interactive capability: stop at the explicit human boundary and report the
  one manual action required.

## Testing

Automated tests prove manifest completeness, unknown-feature detection, stable
status aggregation, JSON redaction, mode gating, timeout behavior, and every
probe's success/failure classification. Existing proxy tests continue to prove
route authorization and header behavior.

The live acceptance run must produce a report for every manifest row. A
capability is only described as verified when its required live layer passed.
Interactive microphone/audio confirmation remains visibly pending unless the
user performs it during the run.
