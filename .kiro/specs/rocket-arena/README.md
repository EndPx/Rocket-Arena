# Rocket Arena — Spec Index

How this project was specified before it was built, and where each document sits
in the Ready → Spec → Ship pipeline.

## The pipeline

| Stage | Artifact | What it fixes |
|-------|----------|---------------|
| **Ready** | [`../../steering/product.md`](../../steering/product.md), [`structure.md`](../../steering/structure.md), [`tech.md`](../../steering/tech.md) | Standing context every session inherits: what the product is, how the monorepo is laid out, which stack is allowed |
| **Spec** | [`requirements.md`](requirements.md) | 19 EARS-style requirements — capacities, match rules, physics, boost, cameras, HUD, and the validation each one owes |
| **Spec** | [`design.md`](design.md) | Architecture, data models, wire contracts, and room-policy transactions that satisfy those requirements |
| **Ship** | [`implementation-plan.md`](implementation-plan.md) | Dependency-ordered build from empty repo to playable game |
| **Ship** | [`tasks.md`](tasks.md) | 63 executable tasks, each traced back to a requirement |

## Skills that drive it

Three single-purpose skills enforce the stage boundaries so a stage cannot skip ahead:

- [`spec`](../../skills/spec/SKILL.md) — turns product context into EARS requirements; forbidden from writing code
- [`plan`](../../skills/plan/SKILL.md) — turns approved requirements and design into a dependency-ordered plan; forbidden from writing code
- [`build`](../../skills/build/SKILL.md) — completes exactly one approved task end to end, with tests, then stops

## Agents

Five task-scoped agents in [`../../agents/`](../../agents): `spec-auditor` (traceability),
`physics-tuner` (evidence-gated tuning values), `boundary-checker` (arena containment),
`bot-client` (headless load and join testing), `submission-writer`.

## State

All 63 tasks are complete. The specified behaviour is the shipped behaviour:
382 unit, property, and integration tests pass, and the build runs live at
<https://rocket-arena.endpx.cloud>.

## Reading order

Start at `requirements.md` for what the game must do, `design.md` for how it is
built, then `tasks.md` for the order it was built in. `bugfix.md` is a narrower
follow-up spec kept for history, not part of the original build path.
