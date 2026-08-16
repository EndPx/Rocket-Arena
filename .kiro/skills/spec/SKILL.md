---
name: spec
description: Clarify product or PRD context into EARS-style requirements for a Rocket Arena feature without implementing code. Use when requirements must be created, refined, or reviewed.
---

# Spec

## Use when

Activate this skill when the user asks to create, clarify, revise, or review requirements from product context, a PRD, or an existing feature brief. Do not use it to design the solution, create implementation tasks, or change source code.

## Workflow

1. **Locate the feature package.** Resolve `.kiro/specs/<feature>/` from the request. Read `.kiro/steering/` first so product boundaries, repository structure, and technical constraints remain authoritative.
2. **Respect the current spec state.** If the feature has a `.config`, inspect its spec type, phase, and approvals. Read every existing requirements, design, task, or implementation-plan artifact in that feature directory. Do not infer approval merely because a file exists.
3. **Gather the product intent.** Use the user request, `PRODUCT.md`, steering, and any feature brief or PRD already in the repository. Separate required behavior, constraints, non-goals, assumptions, and unresolved decisions.
4. **Clarify before committing decisions.** Ask focused questions only where ambiguity would change scope, observable behavior, acceptance criteria, or architecture. Present explicit options when useful; do not invent product decisions.
5. **Write testable requirements.** Create or minimally update `.kiro/specs/<feature>/requirements.md` using stable requirement IDs and acceptance criteria. Express behavior with suitable EARS forms such as `THE <system> SHALL ...`, `WHEN ... THE <system> SHALL ...`, `WHILE ... THE <system> SHALL ...`, or `IF ... THEN THE <system> SHALL ...`.
6. **Preserve prior work.** Keep valid user wording, IDs, review notes, and approved sections intact unless the user explicitly asks to change them. Resolve contradictions with a question instead of silently rewriting history.
7. **Hand off for approval.** Summarize changed requirements, trace each clarification to its outcome, list open questions, and request review through the active Kiro spec workflow. Stop before design, planning, or implementation.

## Output expectations

- A focused requirements artifact under `.kiro/specs/<feature>/` with stable IDs and objectively verifiable acceptance criteria.
- Explicit scope, constraints, non-goals, assumptions, and unresolved questions where relevant.
- A concise review summary; no design, task breakdown, or production code.

## Guardrails

- Never bypass Kiro approval gates or mark an artifact approved on the user's behalf.
- Do not replace an existing spec format or create a competing feature directory without confirmation.
- Treat Rocket Arena as server-authoritative: clients submit inputs, while server state owns physics and gameplay outcomes.
- Do not weaken boundaries in `.kiro/steering/`, especially the `client/`, `server/`, and `shared/` import rules.
- Make no source, dependency, settings, MCP, or unrelated documentation changes while using this skill.

## Source

Adapted for Rocket Arena from the [Coding Agents FYI Spec skill](https://codingagents.fyi/skills/spec/), with original wording and Kiro-native paths and approvals.
