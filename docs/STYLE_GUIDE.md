# Documentation Style Guide

Style contract for all docs in this repository.

---

## Goals

1. Fast onboarding for first-time operators.
2. Precise references for maintainers and automation users.
3. Stable wording for commands, flags, paths, and version policy.
4. Consistent structure across user and maintainer docs.
5. High-confidence discoverability without keyword stuffing or unsupported ranking claims.

---

## Page Template

User-facing docs should generally follow:

1. Title and one-line lead.
2. Quick path commands.
3. Core operational workflow.
4. Troubleshooting or failure handling.
5. Related links.

Use short sections and scan-friendly tables where they improve clarity.

---

## Writing Rules

1. Prefer direct, actionable language.
2. Use runnable command examples.
3. Explain expected outcomes after critical commands.
4. Keep terminology consistent with runtime names.
5. Avoid speculative language when behavior is deterministic.
6. Put the user problem in the first paragraph before implementation detail.

---

## Discoverability Rules

1. Root README and docs landing pages should naturally include `Codex CLI`, `multi-account OAuth`, `account switching`, `health checks`, `runtime rotation`, `diagnostics`, and `recovery` when those topics are in scope.
2. Use descriptive page titles such as `codex-multi-auth Features` instead of generic titles on public docs.
3. Do not promise search rankings. Improve discoverability through accurate titles, first paragraphs, package metadata, internal links, and GitHub topics.
4. Do not repeat keyword lists in every section. Search terms should appear only where they help a developer understand the page.
5. Keep the repository description, package description, README lead, and `docs/development/GITHUB_DISCOVERABILITY.md` aligned.

---

## Command and Path Rules

1. Canonical command family is `codex-multi-auth ...`.
2. Canonical runtime root is `~/.codex/multi-auth`.
3. Runtime rotation must be described as default-on unless the release policy changes.
4. Legacy command/path references belong only in migration contexts.
5. Compatibility aliases (`codex multi auth`, `codex multi-auth`, `codex multiauth`) belong only in command reference, troubleshooting, or migration contexts.
6. Keep command flags aligned with runtime usage text.

---

## Maintainer Rules

1. Behavior changes must update docs and tests together.
2. New flags/settings/paths must be reflected in `docs/reference/*`.
3. Migration-impacting changes must update `docs/upgrade.md`.
4. Governance-impacting changes must review `SECURITY.md` and `CONTRIBUTING.md`.
5. Keep PR/issue templates aligned with validation gates.

---

## Anti-Patterns

Avoid:

- non-runnable command snippets
- conflicting path guidance across docs
- legacy-first onboarding language
- undocumented behavior drift between runtime and docs
