<h1 align="center">
  <img src="client/src/assets/generated/rocket-arena-logo.png" alt="Rocket Arena" width="720" />
</h1>

<p align="center">
  An authoritative browser multiplayer car-ball game built with TypeScript, Rapier, Colyseus, and Three.js.
</p>

<p align="center">
  <a href="https://github.com/EndPx/Rocket-Arena"><strong>github.com/EndPx/Rocket-Arena</strong></a>
</p>

> [!IMPORTANT]
> The current repository contains a playable 2v2 baseline. The expanded 3v3/4v4 mechanics-fidelity slice described below has completed requirements, design, and implementation planning, but implementation and validation are still in progress. This README separates shipped behavior from the finalized target so the project does not claim unfinished features.

## Project Status

| Area | Current playable baseline | Finalized implementation target |
|------|---------------------------|---------------------------------|
| Quick Match | Up to four players using the existing shared 2v2 limits | Exactly six humans, balanced as 3 Blue vs 3 Orange |
| Custom Room | Existing room-code and host flow with shared 2v2 limits | Up to eight humans, maximum four per team, host-controlled start |
| Match flow | Five-minute match with golden-goal overtime when tied | Five-minute regulation, above-zero first-to-6 win-by-2, hard cutoff at `0:00`, then sudden-death OT only when tied |
| Transport | Authoritative server state and client interpolation | Versioned, validated snapshots carrying as many as eight unique cars |
| Mechanics | Playable authoritative Rapier driving, ball, arena, scoring, boost, HUD, audio, and lobby | Metric arena and bodies, deterministic kickoff slots, expanded controls, bounded boost pads, cameras, and evidence-gated tuning |
| Delivery phase | Playable locally | Requirements/design/task plan finalized; implementation and validation underway |

## Why Rocket Arena

Rocket Arena aims to make an authoritative multiplayer car-ball game easy to inspect and run. A judge or developer can clone the repository, install one workspace, and launch the complete local stack without accounts, API keys, a database, or downloaded gameplay assets.

Two teams drive physics-controlled cars in a closed arena and knock a ball into the opposing goal. The server owns every gameplay outcome; clients send controls and render synchronized state.

## Core Approach

- **Authoritative simulation** — Rapier 3D physics advances on the server at an exact 60 Hz fixed step. Clients never decide transforms, contacts, boost, scores, teams, or match phases.
- **Deterministic multiplayer rules** — Room capacities, team assignment, kickoff placement, match outcomes, and reset behavior are specified as testable server policies.
- **Bounded netcode** — Server snapshots are sequenced and validated before the client atomically accepts them into its interpolation and presentation state.
- **Procedural gameplay visuals** — Gameplay geometry is built with Three.js primitives. Original locally bundled 2D brand images are presentation-only and never define collisions.
- **Evidence-gated tuning** — Confirmed values and unverified Rocket League-style tuning hypotheses are kept distinct; uncertain values remain configurable until deterministic and browser evidence is approved.
- **Accessible presentation** — The target HUD exposes team, score, timer, boost, room capacity, camera mode, and match transitions without relying on color alone.

## Finalized Multiplayer Target

### Quick Match

- Exactly **6 human players**.
- Exactly **3 players per team**.
- Deterministic balancing with Blue as the equal-count tie break.
- The kickoff countdown starts only when the room reaches a complete 3v3 roster.
- A pre-match disconnect cancels the countdown; restoring 3v3 starts a fresh countdown.

### Custom Room

- Up to **8 human players**.
- Up to **4 players per team**.
- The first accepted player becomes Host.
- Team switching is allowed only while waiting and only when the destination team has space.
- Only the Host can start a capacity-valid roster.
- Host succession follows stable join order.

Both modes use deterministic four-slot-per-team kickoff placement and the same regulation and overtime rules. Room mode changes capacity and start policy, not the win condition.

## Finalized Target Match Rules

| Rule | Behavior |
|------|----------|
| Regulation duration | Exactly `300` seconds, represented by `18,000` Active Play fixed steps at 60 Hz |
| Kickoff countdown | Exactly `3` seconds / `180` fixed steps |
| Above-zero victory | After a valid goal while time remains, the scorer wins only when its updated score is at least `6` and its lead is at least `2` |
| Score cap | None; tied and one-goal-lead scores can continue above six |
| Hard cutoff | The fixed step that first reaches `0:00` applies any valid same-step goal exactly once before comparing scores |
| Unequal score at cutoff | The leading team wins immediately, regardless of the six-goal target or two-goal margin |
| Tied score at cutoff | Restore deterministic kickoff state and begin a fresh three-second overtime countdown |
| Overtime | Untimed sudden death; the first valid goal immediately ends the match |
| Ended state | Gameplay controls and authoritative car/ball physics remain frozen; later snapshots preserve one immutable final result |

Boundary examples during regulation while time remains:

- **Immediate wins:** `6-4`, `7-5`, `8-6`.
- **Continue after reset:** `5-3`, `6-5`, `6-6`, `7-6`.

At the hard cutoff, unequal examples such as `5-4`, `5-3`, and `6-5` award the leader immediately. Only a tie enters overtime.

## Quick Start

Requirements:

- Node.js with npm
- A modern desktop browser with WebGL and WebSocket support

```bash
git clone https://github.com/EndPx/Rocket-Arena.git
cd Rocket-Arena
npm install
npm run dev
```

This launches:

- Colyseus server: `ws://localhost:2567`
- Vite client: `http://localhost:3000`

Open the client in **2–4 browser tabs** to exercise the current playable baseline. The six-player Quick Match and eight-player Custom Room targets should not be treated as shipped until their implementation tasks and validation gates land.

If PowerShell reports that `concurrently` is not recognized, run `npm install` from the repository root before retrying `npm run dev`.

## Current Controls

| Key | Action |
|-----|--------|
| W / Up | Accelerate |
| S / Down | Brake / Reverse |
| A / Left | Steer left |
| D / Right | Steer right |
| Space | Jump |
| Shift | Boost |
| ` (backtick) | Toggle the development panel in development mode |

Expanded powerslide, directional flip, air-control, and Ball/Car Camera bindings are part of the finalized mechanics target and will be documented as shipped controls after implementation.

## Architecture

```text
Keyboard input
  -> Client input controller
  -> Colyseus WebSocket control messages
  -> Authoritative room and fixed-step scheduler
  -> Rapier world, car/ball systems, scoring, and match flow
  -> Sequenced state snapshots
  -> Client validation and interpolation
  -> Three.js renderer, HUD, camera, effects, and procedural audio

shared/
  -> constants, contracts, schemas, geometry, and tuning metadata
  -> imported by client/ and server/ without importing either workspace
```

Boundary rules:

- `shared/` imports nothing from `client/` or `server/`.
- `client/` and `server/` never import one another.
- All Rapier authority remains in `server/`.
- The client sends control intent only.
- Gameplay constants and tuning metadata are shared and unit-labelled.

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Physics | Rapier 3D (WASM) | Authoritative rigid-body simulation and CCD |
| Server | Colyseus 0.15 | Rooms, matchmaking, commands, and snapshot transport |
| Client | Three.js | Procedural 3D rendering and presentation |
| Language | TypeScript (strict) | Shared contracts and compile-time boundaries |
| Build | Vite | Client development and production bundling |
| Netcode | Fixed-step snapshots and interpolation | Stable authority with smooth client rendering |

## Validation Strategy

The finalized implementation plan uses layered evidence:

- Pure unit tests for policies, reducers, validators, geometry, and controller math.
- Deterministic generated property tests with recorded seeds and at least 100 cases per property.
- Room and serialization integration tests for six-player Quick Match, eight-player Custom Rooms, and terminal snapshot coherence.
- Rapier harnesses for body construction, arena containment, goal crossing, grounding, boost pads, finite recovery, and resource cleanup.
- Scheduler tests for exact countdown, regulation, same-step cutoff ordering, and suppression of post-cutoff regulation work.
- Non-watch browser proof for lobby capacity, rendered cars, HUD, cameras, accessibility, audio deduplication, and finalized match-result presentation.

Repository-level checks:

```bash
npm run typecheck
npm run build
```

Browser observations are presentation evidence only. Reducer, scheduler, integration, and Rapier tests prove authoritative mechanics and timing.

## How Kiro Is Used

Rocket Arena is developed with [Kiro](https://kiro.dev) using a spec-driven workflow.

### Steering

The always-on project guidance defines product scope, technology constraints, repository boundaries, and implementation conventions:

| File | Purpose |
|------|---------|
| `.kiro/steering/product.md` | Product intent, gameplay scope, and definition of done |
| `.kiro/steering/tech.md` | Rapier, Colyseus, Three.js, networking, and validation constraints |
| `.kiro/steering/structure.md` | Workspace layout, import boundaries, and naming conventions |

### Feature Specification

The active Rocket Arena feature specification separates planning from implementation:

| Document | Purpose |
|----------|---------|
| `.kiro/specs/rocket-arena/requirements.md` | EARS-style acceptance criteria and finalized match rules |
| `.kiro/specs/rocket-arena/design.md` | Architecture, data models, state machines, error handling, and correctness properties |
| `.kiro/specs/rocket-arena/tasks.md` | Dependency-ordered implementation and validation plan |

The current requirements, design, and tasks cover exact 3v3 Quick Match, up-to-8-player Custom Rooms, eight-car transport, Rocket League-style mechanics targets, regulation win-by-two, atomic hard cutoff, sudden-death overtime, and truthful staging/release gates.

### Custom Agents and Skills

The workspace includes specialized agents for physics tuning, headless room exercise, boundary checks, spec auditing, and submission support. Its project skills guide requirements clarification, dependency-aware planning, and task-by-task implementation.

## Project Structure

```text
Rocket-Arena/
├── .kiro/              # Steering, specs, agents, skills, and hooks
├── bench/              # Physics tuning harnesses
├── client/             # Three.js renderer, input, HUD, audio, and networking
├── docs/               # Provenance and project evidence
├── server/             # Colyseus rooms, Rapier physics, and game systems
├── shared/             # Constants, contracts, schemas, and shared configuration
└── package.json        # Workspace scripts
```

## Playtesting the Current Baseline

1. Clone the repository and run `npm install`.
2. Start both workspaces with `npm run dev`.
3. Open `http://localhost:3000` in 2–4 browser tabs.
4. Join through Quick Match or create and join a Custom Room.
5. Drive, jump, boost, score, and verify synchronized timer and HUD behavior.

No external services, API keys, accounts, database, or runtime asset download are required.

## Staging and Fidelity Boundaries

The required staging path includes expanded room capacity, eight-car transport, deterministic kickoff, scripted controller mechanics, Core surface grounding, metric arena and goals, finalized match flow, six Large boost pads, cameras, HUD/accessibility, and baseline regression coverage.

The following remain optional final-fidelity increments until evidence is approved:

- Proximity-sensitive kickoff selection.
- The complete 28-Small-Boost-Pad layout.
- Full Surface Driving across walls, corners, ceiling transitions, and ceiling.
- Final evidence/approval promotion from Hackathon Staging to Mechanics Fidelity Release.

Demolition remains deferred until it receives a separately approved behavior contract.

## AI-Generated Brand Art

The lobby wordmark, compact mark, and favicon are original 2D images generated with ChatGPT by OpenAI under participant direction, then human-selected, reviewed, and optimized for local use. They are presentation-only and never loaded from remote URLs at runtime. See [`docs/asset-provenance.md`](docs/asset-provenance.md) for per-asset provenance, dimensions, purpose, and review notes.

## License

MIT
