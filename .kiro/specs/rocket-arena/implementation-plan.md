# Implementation Plan — Rocket Arena

## Problem Statement
Build a browser-based 2v2 multiplayer car-ball game (Rocket League-style) for the Kiro hackathon. Players drive physics-driven cars in a walled arena and try to knock a large ball into the opposing goal. All visuals are procedural (Three.js primitives), physics is authoritative on server (Rapier), netcode via Colyseus, with a configurable constants architecture separating tuning values from logic.

## Requirements
- 2v2 (Blue vs Orange), 5 minutes per match + golden-goal overtime
- Cars: accelerate, brake, turn, jump, boost, air control
- Ball: heavy & bouncy, car-ball impact = most important game feel
- Quick Match (join-or-create) + Custom Room (6-char code)
- No external assets — all procedural geometry (BoxGeometry, SphereGeometry, CylinderGeometry)
- Configurable constants hierarchy (class-based nested objects, SCREAMING_SNAKE_CASE, JSDoc comments)
- Dev panel for live constant tuning during development
- Desktop keyboard only
- Single server process, max 20 concurrent rooms
- No accounts, no persistence, no database, no auth

## Tech Stack
- **Physics**: `@dimforge/rapier3d-compat` (WASM) — fixed timestep 1/60s, CCD on ball and cars
- **Server**: Colyseus — authoritative, rooms, state sync, `setSimulationInterval` at 60Hz
- **Client**: Three.js — procedural geometry only, NO .glb/.gltf/.fbx/texture files
- **Language**: TypeScript strict mode throughout
- **Build**: Vite for client dev server
- **Netcode**: Interpolation buffer (~100ms behind server) for smooth remote entities

## Repository Structure
```
Rocket-Arena/
├── .kiro/
│   ├── steering/
│   │   ├── product.md
│   │   ├── tech.md
│   │   └── structure.md
│   └── specs/
│       └── rocket-arena/
│           └── implementation-plan.md
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── rooms/
│       ├── physics/
│       └── systems/
├── client/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.ts
│       ├── renderer/
│       ├── networking/
│       ├── input/
│       ├── hud/
│       ├── ui/
│       └── dev-panel/
├── shared/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── constants/
│       │   ├── car.ts
│       │   ├── ball.ts
│       │   ├── arena.ts
│       │   ├── match.ts
│       │   ├── physics.ts
│       │   ├── registry.ts
│       │   └── index.ts
│       ├── types/
│       │   └── input.ts
│       └── schema/
│           └── game-state.ts
└── README.md
```

## Constants Architecture

Style: nested readonly objects with SCREAMING_SNAKE_CASE and JSDoc comments.

```typescript
// Example: shared/src/constants/car.ts
export const CAR = {
  /** Physical dimensions in meters */
  BODY: {
    WIDTH: 1.8,
    HEIGHT: 0.8,
    LENGTH: 3.2,
    MASS: 150,          // kg
  },

  /** Driving forces in Newtons */
  ENGINE: {
    FORWARD_FORCE: 3600,
    BRAKE_FORCE: 4800,
    REVERSE_FORCE: 1800,
    MAX_SPEED: 23,      // m/s (~83 km/h)
  },

  /** Boost system */
  BOOST: {
    FORCE: 7200,        // Newtons — double engine force
    MAX_AMOUNT: 100,
    USAGE_RATE: 33,     // units/sec
    START_AMOUNT: 33,
  },

  /** Steering parameters */
  STEERING: {
    TURN_RATE: 2.8,         // rad/s at low speed
    TURN_RATE_AT_MAX: 0.8,  // rad/s at max speed
    ANGULAR_DAMPING: 5.0,
  },

  /** Jump & air control */
  JUMP: {
    IMPULSE: 420,
    AIR_ROLL_RATE: 3.5,     // rad/s
    AIR_PITCH_RATE: 3.5,
  },
} as const;
```

A `registry.ts` collects all constants into a flat `Map<string, number>` with dot-path keys for the dev panel.

## Task Breakdown

### Task 1: Repository setup and monorepo scaffolding
**Objective:** Create GitHub repo "Rocket-Arena" (public), initialize monorepo with `server/`, `client/`, `shared/` folders. Configure TypeScript strict mode, Vite for client, Colyseus server entry point.

**Implementation:**
1. Root `package.json` with workspaces
2. Create `shared/package.json`, `shared/tsconfig.json`, `shared/src/index.ts`
3. Create `server/package.json` with dependencies (colyseus, @dimforge/rapier3d-compat), `server/tsconfig.json`, `server/src/index.ts`
4. Create `client/package.json` with dependencies (three, colyseus.js), `client/tsconfig.json`, `client/vite.config.ts`, `client/index.html`, `client/src/main.ts`
5. Configure tsconfig path aliases
6. `.kiro/steering/` files with specs

**Test:** `npm install` succeeds, `tsc --noEmit` passes.
**Demo:** Server starts, client dev server shows blank page.

---

### Task 2: Configurable constants system
**Objective:** Build the full constants directory in `shared/src/constants/` with all tuning values.

**Implementation:**
1. `shared/src/constants/car.ts` — BODY, ENGINE, BOOST, STEERING, JUMP
2. `shared/src/constants/ball.ts` — RADIUS, MASS, RESTITUTION, LINEAR_DAMPING, ANGULAR_DAMPING
3. `shared/src/constants/arena.ts` — WIDTH, LENGTH, HEIGHT, WALL_THICKNESS, GOAL dimensions
4. `shared/src/constants/match.ts` — DURATION_SECONDS, COUNTDOWN, GOAL_RESET_DELAY, MAX_PLAYERS
5. `shared/src/constants/physics.ts` — GRAVITY, TIMESTEP, SOLVER_ITERATIONS
6. `shared/src/constants/registry.ts` — flatten into Map<string, number> for dev panel
7. `shared/src/constants/index.ts` — barrel export

**Test:** Import `CAR.ENGINE.FORWARD_FORCE`, verify type inference. Registry maps all values.
**Demo:** `console.log(CAR.BOOST.FORCE)` works from both packages.

---

### Task 3: Shared types and Colyseus state schema
**Objective:** Define Schema classes for synced state and input payload types.

**Implementation:**
1. `shared/src/types/input.ts` — InputPayload interface
2. `shared/src/schema/player-state.ts` — position, rotation (quaternion), velocity, boost, team
3. `shared/src/schema/ball-state.ts` — position, rotation, velocity
4. `shared/src/schema/game-state.ts` — players (MapSchema), ball, scores, timeRemaining, phase

**Test:** Schema serialization roundtrip.
**Demo:** Can create and read GameState.

---

### Task 4: Rapier physics world — ball only
**Objective:** Initialize Rapier world with arena walls and bouncing ball. Verify by logging.

**Implementation:**
1. `server/src/physics/world.ts` — init WASM, create world
2. `server/src/physics/arena.ts` — static colliders (floor, walls, ceiling)
3. `server/src/physics/ball.ts` — dynamic body, CCD, constants-driven
4. Test script: step 300 frames, log ball Y

**Test:** Ball bounces and settles. Restitution from constants affects bounce height.
**Demo:** Console prints ball bouncing over time.

---

### Task 5: Rapier physics — car body and driving forces
**Objective:** Add car rigid body, apply forces from input, verify by logging.

**Implementation:**
1. `server/src/physics/car.ts` — box body, mass, CCD
2. Forward force along local Z-axis, brake, reverse
3. Steering torque scaled by speed
4. Damping from constants

**Test:** Forward input → position changes. Turn → rotation changes.
**Demo:** Console shows car moving and turning.

---

### Task 6: Car-ball collision and impact feel
**Objective:** Verify car-ball impact physics. Tune mass ratios, restitution, CCD.

**Implementation:**
1. Position car behind ball, apply force
2. Log ball velocity after impact at various speeds
3. Verify CCD prevents tunneling

**Test:** Max speed impact → significant ball velocity. Low speed → gentle roll.
**Demo:** Console shows impact dynamics.

---

### Task 7: Colyseus room — basic lifecycle
**Objective:** ArenaRoom with lifecycle, Quick Match, Custom Room.

**Implementation:**
1. `server/src/rooms/arena-room.ts` — extend Room<GameState>
2. onCreate, onJoin (team assign), onLeave, onDispose
3. Lock at 4 players, countdown
4. Quick Match: joinOrCreate. Custom: 6-char code

**Test:** 4 clients → room locks, countdown starts.
**Demo:** Server logs show join/team/lock flow.

---

### Task 8: Server game loop — 60Hz physics tick + state sync
**Objective:** Wire Rapier into Colyseus setSimulationInterval.

**Implementation:**
1. setSimulationInterval at 1000/60
2. Each tick: read inputs → apply forces → step Rapier → write to Schema
3. Handle "input" messages, store latest per client

**Test:** Client sends forward → PlayerState position updates.
**Demo:** State updates at 60Hz.

---

### Task 9: Three.js client — renderer, camera, arena
**Objective:** Three.js scene with procedural arena from constants.

**Implementation:**
1. `client/src/renderer/scene.ts` — renderer, camera, lights
2. `client/src/renderer/arena.ts` — floor, walls, goals (colored)
3. Render loop via requestAnimationFrame

**Test:** Browser shows arena with goals.
**Demo:** 3D arena visible with correct proportions.

---

### Task 10: Three.js client — car and ball rendering from server state
**Objective:** Render car and ball at server-dictated positions.

**Implementation:**
1. `client/src/renderer/car.ts` — box body + cylinder wheels, team colored
2. `client/src/renderer/ball.ts` — sphere
3. `client/src/networking/client.ts` — Colyseus connection
4. `client/src/networking/state-listener.ts` — update mesh transforms

**Test:** Connect → car and ball appear at correct positions.
**Demo:** Car and ball in arena, positioned per server.

---

### Task 11: Interpolation buffer for smooth remote rendering
**Objective:** ~100ms interpolation buffer for smooth remote entities.

**Implementation:**
1. `client/src/networking/interpolation-buffer.ts` — snapshot buffer, lerp/slerp
2. Render time = now - INTERPOLATION_DELAY_MS
3. Apply to all entities

**Test:** Smooth movement despite jitter.
**Demo:** Two windows — smooth movement in both.

---

### Task 12: Client input capture and sending
**Objective:** Keyboard → input payload → server.

**Implementation:**
1. `client/src/input/keyboard-handler.ts` — WASD, Space, Shift
2. Pack InputPayload each frame
3. Send via room.send("input", payload)

**Test:** Press W → server receives throttle=1.
**Demo:** Full loop: keys → car moves in browser.

---

### Task 13: Scoring system and goal detection
**Objective:** Detect ball in goal, score, reset to kickoff.

**Implementation:**
1. `server/src/physics/goal-sensor.ts` — Rapier sensor colliders
2. `server/src/systems/scoring.ts` — score event, reset positions after delay

**Test:** Ball in goal sensor → score increments, reset occurs.
**Demo:** Goal → score updates → ball resets.

---

### Task 14: Match timer and overtime
**Objective:** 5-min countdown, golden-goal overtime if tied.

**Implementation:**
1. `server/src/systems/match-timer.ts` — countdown, sync to schema
2. On expire: end or overtime
3. `client/src/hud/timer.ts` — MM:SS display

**Test:** Timer expires → correct end/overtime behavior.
**Demo:** Timer counts down, match ends or enters overtime.

---

### Task 15: HUD — scores, timer, boost meter
**Objective:** HTML overlay HUD.

**Implementation:**
1. `client/src/hud/hud.ts` — overlay div
2. Blue score | Timer | Orange score
3. Boost bar for local player

**Test:** Values update in real-time.
**Demo:** Full HUD visible during gameplay.

---

### Task 16: Dev panel for live constant tuning
**Objective:** Toggleable dev panel for runtime constant editing.

**Implementation:**
1. `client/src/dev-panel/dev-panel.ts` — lil-gui or custom panel
2. Read from registry, grouped by category
3. On change: send "dev-tune" message to server
4. Server updates mutable constants copy
5. Toggle with backtick, DEV-only

**Test:** Change FORWARD_FORCE → car accelerates differently.
**Demo:** Live tuning visible in-game.

---

### Task 17: Lobby UI — Quick Match and Custom Room
**Objective:** Entry screen with matchmaking.

**Implementation:**
1. `client/src/ui/lobby.ts` — HTML/CSS
2. Quick Match, Create Room (shows code), Join Room (input code)
3. Team display + countdown when filled

**Test:** Quick Match works. Custom code joins correct room.
**Demo:** Two browsers join same match.

---

### Task 18: Kickoff sequence and match flow
**Objective:** Full match lifecycle.

**Implementation:**
1. Phases: waiting → countdown → playing → goal-scored → overtime → ended
2. Client adjusts UI/controls per phase
3. `client/src/ui/game-over.ts` — end screen

**Test:** Full match through all states.
**Demo:** Complete flow from lobby to game over.

---

### Task 19: Camera system and polish
**Objective:** Follow camera + visual polish.

**Implementation:**
1. `client/src/renderer/camera-controller.ts` — follow cam with lerp
2. Boost trail (small spheres), goal flash, arena markings
3. `shared/src/constants/camera.ts` — FOLLOW_DISTANCE, HEIGHT_OFFSET, LERP_SPEED

**Test:** Smooth camera, no jitter. Boost trail works.
**Demo:** Polished game feel.

---

### Task 20: README, documentation, and demo video prep
**Objective:** Comprehensive README for judges.

**Implementation:**
1. Project description, architecture diagram
2. Kiro usage documentation
3. Setup/run instructions
4. Controls, testing instructions

**Test:** Fresh clone → game runs in 2 minutes.
**Demo:** Professional README for submission.

---

## Definition of Done
Two browser windows on the same machine can join a match, both see the same ball position within a frame or two of each other, a goal registers and resets to kickoff, and the timer ends the match.

## Non-Goals (DO NOT BUILD)
- No matchmaking algorithm, no skill rating, no bot-fill
- No horizontal scaling, no Redis, no room sharding
- No user accounts, no auth, no persistence, no database
- No cosmetics, no progression, no unlocks
- No 3v3 (fixed at 4 players max)
- No mobile/touch controls

## Stretch Goals (ONLY after core is playable)
- Client-side prediction and reconciliation
- Boost pad pickups
- Double-jump / flip mechanics
