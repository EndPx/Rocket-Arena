---
name: build
description: Complete one approved and unblocked Kiro spec task end to end with tests and validation. Use when asked to build or execute the next planned task.
---

# Build

## Use when

Activate this skill when the user asks to build, implement, continue, or execute one task from an approved Kiro feature plan. It is intentionally single-task: finish one eligible task, report the result, and stop.

## Workflow

1. **Inspect state safely.** Check the working tree before editing. Resolve `.kiro/specs/<feature>/`, inspect `.config` when present, and honor the current approval and task-status workflow. Preserve unrelated modified and untracked work.
2. **Choose one task.** Use the task named by the user, or select the highest-priority unblocked item from `tasks.md` or the feature's established implementation plan. Verify its prerequisites are complete; do not pull later-task scope forward.
3. **Load only relevant context.** Read `.kiro/steering/`, the feature requirements, design, selected task details, existing implementation plan, and any established learnings file. Then inspect the affected code and current tests before proposing changes.
4. **Define the completion check.** Restate the selected task's requirement links, acceptance criteria, expected files, and validation commands. Ask before proceeding if the task conflicts with the spec or leaves a product decision unresolved.
5. **Add focused tests when feasible.** Extend existing tests or add the smallest useful unit and regression coverage for the selected behavior. Prefer a reproducing regression test for a bug and avoid mocks that bypass the real behavior.
6. **Implement the bounded change.** Make the minimum coherent code and documentation edits needed for this task. Follow existing patterns and keep simulation, scoring, and gameplay authority on the server; clients send inputs and render synchronized state.
7. **Validate before completion.** Run the most targeted tests first, then applicable type checks, lint checks, and package builds. Fix failures caused by this task, but do not hide unrelated failures or mark the task complete while required validation is failing.
8. **Record status and learnings.** After validation passes, update only the selected task's checkbox or status in the established plan. Add durable findings to the existing feature learnings mechanism; if none exists, include them in the final report rather than inventing a new convention.
9. **Report and stop.** List changed files, tests and checks run, requirement coverage, task-status update, relevant learnings, and any unrelated pre-existing issues. Do not start another task.

## Output expectations

- Focused tests and implementation for exactly one approved, unblocked task.
- Evidence from targeted validation plus any required build, type, or lint checks.
- The selected task's status updated only after success, with reusable learnings captured without unrelated churn.
- A concise completion report that identifies anything intentionally left for later tasks.

## Guardrails

- One invocation completes at most one planned task; no opportunistic refactors or follow-on features.
- Never bypass spec approvals, silently change acceptance criteria, or mark blocked or failing work complete.
- Preserve all unrelated working-tree changes, and stage or commit only when the user explicitly requests it.
- Do not move authoritative physics or gameplay decisions into the client, duplicate shared contracts, or violate `.kiro/steering/` boundaries.
- Do not add dependencies, alter settings or MCP configuration, or modify unrelated specs to make validation pass.

## Source

Adapted for Rocket Arena from the [Coding Agents FYI Build skill](https://codingagents.fyi/skills/build/), with original wording and a Kiro-native single-task workflow.
