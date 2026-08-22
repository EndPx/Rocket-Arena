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
| Mechanics | Playable authoritative Rapier driving, ball, arena, scoring, HUD, audio, lobby, an ESC match menu, and all 34 authoritative boost pads | Metric arena and bodies, deterministic kickoff slots, expanded controls, cameras, and evidence-gated tuning |
| Delivery phase | Playable locally | Requirements/design/task plan finalized; implementation and validation underway |

## Why Rocket Arena

Rocket Arena aims to make an authoritative multiplayer car-ball game easy to inspect and run. A judge or developer can clone the repository, install one workspace, and launch the complete local stack without accounts, API keys, a database, or downloaded gameplay assets.

Two teams drive physics-controlled cars in a closed arena and knock a ball into the opposing goal. The server owns every gameplay outcome; clients send controls and render synchronized state.

## Core Approach

- **Authoritative simulation** — Rapier 3D physics advances on the server at an exact 60 Hz fixed step. Clients never decide transforms, contacts, boost, scores, teams, or match phases.
- **Deterministic multiplayer rules** — Room capacities, team assignment, kickoff placement, match outcomes, and reset behavior are specified as testable server policies.
- **Bounded netcode** — Server snapshots are sequenced and validated before the client atomically accepts them into its interpolation and presentation state.
- **Procedural gameplay visuals** — Gameplay geometry is built with Three.js primitives. Original locally bundled 2D brand images are presentation-only and never define collisions.
- **Readable boundaries** — The arena shell is painted from the resolved geometry's own material roles and transition heights, so the paint cannot describe a curve the collider does not have. The containment wall is a tinted glass pane with frame mullions, a marked ramp band, and one solid team stripe running the full perimeter, which keeps the crowd visible while still giving a driver height and position to read. A floor disc under the ball reports where it is even when it is high in the air.
- **Boost you can see from across the pitch** — The two pad classes are drawn as different objects because they are worth different amounts. A small pad is a plate set into the turf. A large pad adds a floating orb above that plate, so a full refill is visible at a distance and worth driving to.
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
| Q / E | Air yaw while airborne |
| Space | Jump (hold for the sustained first jump) |
| Shift | Boost |
| Ctrl | Powerslide |
| C | Toggle Ball / Car camera |
| Esc | Open the match menu |
| ` (backtick) | Toggle the development panel in development mode |

The same key list is rendered along the bottom edge in-match, generated from the
real bindings rather than maintained by hand, and can be hidden in Settings.

Air pitch and air roll are read from the ground axes: while airborne, W/S pitches
the nose and A/D rolls the car. They are the same physical axes, so an inversion
applied to one applies to the other.

## Match Menu and Settings

`Esc` opens a menu that is local to the player. The match keeps running behind it;
this is not a pause, and gameplay input is suspended and flushed so a key held as
the menu opened cannot leave the car driving into a wall.

| Action | Behavior |
|--------|----------|
| Resume | Close the menu and hand input back |
| Settings | Open the settings panel |
| Return to Lobby | Leave the room and go back to the lobby |

Settings are stored locally under `rocket-arena-settings-v1` and applied before the
first frame on a later visit. A blocked, full, or corrupt store degrades to
defaults rather than failing.

| Setting | Default | Notes |
|---------|---------|-------|
| Sound volume | Project default | Owned by the audio manager; the panel is a view of it |
| Mute sound | Off | As above |
| Ball floor marker | On | The floor disc that reports where the ball is |
| Control hints | On | The on-screen key reference |
| Invert W / S (drive) | Off | Also inverts air pitch |
| Invert A / D (steer) | Off | Also inverts air roll |
| Invert Q / E (air yaw) | Off | |
| Reset to Defaults | — | Disabled while nothing differs from the shipped defaults |

Inversion is applied to the command this client builds and to nothing else. The
server keeps one sign convention and is never told that a player flipped an axis.

## Boost

| Property | Value |
|----------|-------|
| Starting inventory | `100` |
| Consumption | `33.3` units per second while held |
| Large pads | `6`, each grants a full `100`, returns after `10` seconds |
| Small pads | `18`, each grants `12`, returns after `5` seconds |
| Full tank | A pad is left standing rather than wasted |
| Partial tank | A grant is clamped to the cap, so `95` boost takes `5` from a small pad |

Pad pickup, inventory, and respawn are authoritative and stepped on the server.
Positions come from one shared table that the room grants from and the renderer
draws, so a drawn pad is always a pad that pays out.

Two deliberate divergences from Rocket League, both recorded in the tuning
registry rather than hidden in code. Boost starts at `100` instead of `33`, by
project decision, and is classified as a hypothesis across the full `0`–`100`
range rather than pinned. Pad availability is not yet carried by the snapshot
envelope, so pads are drawn as always available; they mark where boost is, which
is the half a player cannot work out alone, and no attempt is made to animate a
guess about whether a given pad is currently spent.

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
6. Drive over a boost pad on an empty tank and watch the HUD gauge fill; a large
   pad fills it outright, a small one adds twelve.
7. Press `Esc`, open Settings, flip an axis inversion, and confirm the car steers
   the other way once you resume.

No external services, API keys, accounts, database, or runtime asset download are required.

## Staging and Fidelity Boundaries

The required staging path includes expanded room capacity, eight-car transport, deterministic kickoff, scripted controller mechanics, Core surface grounding, metric arena and goals, finalized match flow, six Large boost pads, cameras, HUD/accessibility, and baseline regression coverage.

The following remain optional final-fidelity increments until evidence is approved:

- Proximity-sensitive kickoff selection.
- Authoritative pad availability in the snapshot envelope, so a spent pad can be
  drawn as spent.
- Full Surface Driving across walls, corners, ceiling transitions, and ceiling.
- Final evidence/approval promotion from Hackathon Staging to Mechanics Fidelity Release.

Both boost-pad classes have since landed: the six Large pads and a Small-Boost-Pad
layout are seeded, authoritative, and drawn. The Small layout carries `18` of
Rocket League's `28` rather than all of them, by project decision, because the full
set read as clutter at this arena's scale. The eighteen are a mirrored subset of the
real positions, so both halves stay identical and the spacing stays Rocket League's.

Demolition remains deferred until it receives a separately approved behavior contract.

## AI-Generated Brand Art

The lobby wordmark, compact mark, and favicon are original 2D images generated with ChatGPT by OpenAI under participant direction, then human-selected, reviewed, and optimized for local use. They are presentation-only and never loaded from remote URLs at runtime. See [`docs/asset-provenance.md`](docs/asset-provenance.md) for per-asset provenance, dimensions, purpose, and review notes.

## License

MIT
