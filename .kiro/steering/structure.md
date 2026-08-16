# Repository structure and boundaries

## Layout
A single repo with three top-level source folders. `server/` holds the Colyseus server, room definitions, and the Rapier simulation. `client/` holds the Three.js renderer, input capture, interpolation buffer, and HUD. `shared/` holds types and constants imported by both — arena dimensions, physics tuning values, input payload shape, state schema definitions.

Spec files live in `.kiro/specs/rocket-arena/` and are committed to the repo alongside the code.

## The client/server boundary
`shared/` may not import from `client/` or `server/`. `client/` may not import from `server/` and vice versa. If something needs to be known by both, it belongs in `shared/` — this is the rule that keeps physics constants from silently diverging between the two sides.

## Physics location
All Rapier code lives under `server/`. The only exception is the stretch-goal prediction layer, which would run a second Rapier world on the client using the exact same tuning constants imported from `shared/`. Until that stretch goal is explicitly started, there is no Rapier import anywhere in `client/`.

## Tuning constants
Every physics number — car mass, engine force, boost force, turn rate, ball mass, restitution, linear and angular damping, gravity — lives in one named-constant module in `shared/`. No magic numbers inline in simulation code. These values will be tuned dozens of times during the week and hunting them across files wastes the timebox.

## Conventions
Files and folders in kebab-case, types in PascalCase, constants in SCREAMING_SNAKE_CASE. Keep modules small and single-purpose; a room file that handles physics stepping, scoring, and countdown logic all at once should be split.

## Commits
Commit after each completed task with a message naming the task. The commit history is part of what gets reviewed, so avoid single giant commits spanning multiple tasks.
