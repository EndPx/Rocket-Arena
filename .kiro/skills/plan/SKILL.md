---
name: plan
description: Convert approved Kiro requirements and design into a traceable dependency-ordered task plan without implementing code. Use when a feature is ready for execution planning.
---

# Plan

## Use when

Activate this skill after a feature's requirements and design are approved and the user asks for an implementation plan, task breakdown, dependency order, or execution roadmap. Do not use it to write implementation code.

## Workflow

1. **Confirm the feature and phase.** Resolve `.kiro/specs/<feature>/`, inspect `.config` when present, and verify the required requirements and design approvals. If an approval or prerequisite is missing, report the gap and stop.
2. **Read the full planning context.** Read `.kiro/steering/`, approved `requirements.md` and `design.md`, and any existing `tasks.md` or `implementation-plan.md`. Include relevant review notes and current task status.
3. **Build traceability.** Map every in-scope requirement ID and design component to at least one implementation or verification task. Flag uncovered, contradictory, or obsolete items instead of guessing.
4. **Define executable tasks.** Give each task a stable identifier, bounded objective, requirement references, dependencies, expected affected areas, and concrete validation. Split work so a task can be completed and verified without bundling unrelated behavior.
5. **Order by dependency.** Put foundations and interfaces before consumers, migrations before dependent behavior, and implementation before broad integration checks. Mark work as parallel only when it has no shared ordering or file-state dependency.
6. **Update the established plan artifact.** Use `tasks.md` for a standard Kiro feature package, or the feature's existing plan file when that is the established convention. Preserve user edits, IDs, checkboxes, completion state, and review notes; do not create a competing plan.
7. **Review plan quality.** Check requirement coverage, dependency correctness, validation coverage, task size, and consistency with repository architecture. Include documentation or test work only where required by the approved spec.
8. **Request approval and stop.** Summarize additions, reordered dependencies, preserved edits, and any blockers. Do not begin the first task until the plan is approved through the active Kiro workflow.

## Output expectations

- One traceable task plan inside `.kiro/specs/<feature>/`, using the feature's existing format and status conventions.
- Tasks ordered by dependency, with requirement references and a verification method for each meaningful outcome.
- A concise coverage and dependency summary; no implementation changes.

## Guardrails

- Never plan from unapproved requirements or design unless the user explicitly asks for a clearly labeled draft.
- Never erase completed work, renumber stable task IDs, or overwrite user-authored changes merely to normalize formatting.
- Keep server-authoritative physics and gameplay on `server/`; shared contracts belong in `shared/`, and rendering/input concerns belong in `client/`.
- Do not introduce non-goals, optional infrastructure, dependencies, or speculative abstractions that the approved spec does not require.
- Do not modify source code, dependency manifests, settings, MCP configuration, or unrelated files while using this skill.

## Source

Adapted for Rocket Arena from the [Coding Agents FYI Plan skill](https://codingagents.fyi/skills/plan/), with original wording and the repository's Kiro spec layout.
