# Implementation Plan — Rocket Arena (rev 2)

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
- **Physics**: `@dimforge/rapier3d-compat` (WASM) — fixed timestep 1/60s, CCD on ball only (cars don't need it — they're slower and wider)
- **Server**: Colyseus — authoritative, rooms, state sync, `setSimulationInterval` at 60Hz, `setPatchRate(33)` for ~30fps state broadcast
- **Client**: Three.js — procedural geometry only, NO .glb/.gltf/.fbx/texture files
- **Language**: TypeScript strict mode throughout
- **Build**: Vite for client dev server
- **Netcode**: Interpolation buffer, delay = 2× patch interval (~66ms at 33ms patch rate)

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
│       │   ├── netcode.ts
│       │   ├── physics.ts
│       │   ├── camera.ts
│       │   ├── defaults.ts    (frozen as-const objects)
│       │   ├── registry.ts    (flat path→value enumeration)
│       │   ├── resolver.ts    (reads override map, falls back to frozen default)
│       │   └── index.ts
│       ├── types/
│       │   └── input.ts
│       └── schema/
│           └── game-state.ts
└── README.md
```

## Constants Architecture

Two layers:
1. **Frozen defaults** — `as const` objects with JSDoc. These are the source-of-truth checked into git.
2. **Mutable override map** — `Map<string, number>` populated at runtime by the dev panel. Empty in production.
3. **Resolver** — `getConstant("CAR.ENGINE.FORWARD_FORCE")` checks override map first, falls back to frozen default. All simulation code reads through the resolver, never from the frozen object directly.

This resolves the contradiction between `as const` immutability and runtime dev-panel mutation.

```typescript
// shared/src/constants/car.ts — FROZEN DEFAULTS
/** Car physics and handling tuning constants */
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
    /** Lateral grip factor. 1.0 = perfect grip (no slide), 0.0 = ice.
     *  This is THE key constant for car feel. Each tick, lateral velocity
     *  is countered by: lateralVel * LATERAL_GRIP * mass = counter-force.
     *  Start high (0.85) and tune down for driftier feel. */
    LATERAL_GRIP: 0.85,
  },

  /** Jump & air control */
  JUMP: {
    IMPULSE: 420,
    /** Max jumps before needing ground contact again */
    MAX_JUMPS: 1,
    AIR_ROLL_RATE: 3.5,     // rad/s
    AIR_PITCH_RATE: 3.5,
  },
} as const;
```

```typescript
// shared/src/constants/ball.ts
/** Ball physics constants.
 *  Mass ratio car:ball is critical for impact feel.
 *  At 150:30 (5:1), a car at full speed launches the ball hard
 *  but doesn't feel like hitting a beach ball. Tune from here. */
export const BALL = {
  RADIUS: 1.8,            // meters — oversized for readability
  MASS: 30,               // kg — 1:5 ratio vs car (150kg)
  RESTITUTION: 0.6,       // bounciness (0-1)
  LINEAR_DAMPING: 0.3,    // air drag equivalent
  ANGULAR_DAMPING: 0.1,   // spin decay
} as const;
```

```typescript
// shared/src/constants/netcode.ts
/** Netcode tuning.
 *  PATCH_RATE_MS and INTERPOLATION_DELAY_MS are coupled:
 *  delay MUST be >= 2× patch rate to guarantee two snapshots
 *  in the buffer at all times. If you lower one, lower the other. */
export const NETCODE = {
  PATCH_RATE_MS: 33,            // ~30fps state broadcast (setPatchRate)
  INTERPOLATION_DELAY_MS: 66,   // 2× patch rate — minimum safe buffer
  SNAPSHOT_BUFFER_SIZE: 20,     // keep last N snapshots
} as const;
```

---

## Task Breakdown

### Task 1: Repository setup and monorepo scaffolding
**Objective:** Initialize monorepo with `server/`, `client/`, `shared/` folders. Configure TypeScript strict mode, Vite for client, Colyseus server entry point.

**Implementation:**
1. Root `package.json` with npm workspaces
2. `shared/package.json`, `shared/tsconfig.json`, `shared/src/index.ts`
3. `server/package.json` with dependencies (colyseus, @dimforge/rapier3d-compat), `server/tsconfig.json`, `server/src/index.ts` (basic Colyseus server start)
4. `client/package.json` with dependencies (three, colyseus.js), `client/tsconfig.json`, `client/vite.config.ts`, `client/index.html`, `client/src/main.ts`
5. Configure tsconfig project references
6. `.gitignore`

**Test:** `npm install` succeeds, `tsc -b` passes with zero errors.
**Demo:** Server starts and listens, client dev server shows blank page.

---

### Task 2: Configurable constants system (frozen defaults + resolver)
**Objective:** Build constants directory with frozen defaults, mutable override map, and resolver function. This is the foundation for ALL subsequent physics work and the dev panel.

**Implementation:**
1. `shared/src/constants/car.ts` — BODY, ENGINE, BOOST, STEERING (including LATERAL_GRIP), JUMP
2. `shared/src/constants/ball.ts` — RADIUS, MASS (30kg, 1:5 ratio), RESTITUTION, DAMPING values
3. `shared/src/constants/arena.ts` — WIDTH, LENGTH, HEIGHT, WALL_THICKNESS, GOAL dimensions
4. `shared/src/constants/match.ts` — DURATION_SECONDS (300), COUNTDOWN_SECONDS (5), GOAL_RESET_DELAY (3), MAX_PLAYERS (4), TEAM_SIZE (2)
5. `shared/src/constants/netcode.ts` — PATCH_RATE_MS (33), INTERPOLATION_DELAY_MS (66), SNAPSHOT_BUFFER_SIZE (20) with coupling comment
6. `shared/src/constants/physics.ts` — GRAVITY (-30), TIMESTEP (1/60), SOLVER_ITERATIONS (4)
7. `shared/src/constants/defaults.ts` — barrel import of all frozen objects
8. `shared/src/constants/registry.ts` — recursively flatten all constant objects into `Map<string, number>` with dot-path keys
9. `shared/src/constants/resolver.ts` — `overrides: Map<string, number>`, `getConstant(path): number` that checks overrides first, `setOverride(path, value)`, `clearOverrides()`
10. `shared/src/constants/index.ts` — barrel export all

**Test:** `getConstant("CAR.ENGINE.FORWARD_FORCE")` returns 3600. After `setOverride("CAR.ENGINE.FORWARD_FORCE", 5000)`, returns 5000. `clearOverrides()` reverts.
**Demo:** Both server and client can import and resolve constants.

---

### Task 3: Shared types and Colyseus state schema
**Objective:** Define Schema classes for synced state and input payload types.

**Implementation:**
1. `shared/src/types/input.ts` — `InputPayload { throttle: number (-1 to 1), steer: number (-1 to 1), jump: boolean, boost: boolean }`
2. `shared/src/schema/player-state.ts` — Schema: x, y, z, qx, qy, qz, qw, vx, vy, vz, boost (number 0-100), team ("blue"|"orange")
3. `shared/src/schema/ball-state.ts` — Schema: x, y, z, qx, qy, qz, qw, vx, vy, vz
4. `shared/src/schema/game-state.ts` — Schema: players (MapSchema<PlayerState>), ball (BallState), blueScore (number), orangeScore (number), timeRemaining (number), phase (string: "waiting"|"countdown"|"playing"|"goal-scored"|"overtime"|"ended")

**Test:** Schema instantiation and field assignment compiles. Type exports work from both packages.
**Demo:** Can create a GameState, populate players and ball, read back values.

---

### Task 4: Rapier physics world — ball only
**Objective:** Initialize Rapier world with arena walls and a bouncing ball. Verify by logging positions (no rendering).

**Implementation:**
1. `server/src/physics/world.ts` — init WASM, create world with gravity from `getConstant("PHYSICS.GRAVITY")`
2. `server/src/physics/arena.ts` — static colliders: floor, 4 walls, ceiling. Dimensions from ARENA constants via resolver.
3. `server/src/physics/ball.ts` — dynamic rigid body (sphere collider), BALL.MASS, BALL.RESTITUTION, CCD enabled, damping from constants
4. Test script (`server/src/physics/test-ball.ts`): spawn ball at height 10, step 300 frames, log Y position every 10 frames

**Test:** Ball bounces and settles. Changing BALL.RESTITUTION via override map visibly affects bounce height in logs.
**Demo:** Console prints ball bouncing pattern. With restitution=0.9 vs 0.3, clearly different behavior.

---

### Task 5: Rapier physics — car body with traction model
**Objective:** Add car rigid body with a proper traction model so it drives like a car, not a hockey puck on ice.

**Traction model (lateral grip):**
Each physics tick:
1. Get car's linear velocity
2. Project velocity onto car's local X-axis (lateral direction)
3. Compute counter-force = -lateralVelocity × `getConstant("CAR.STEERING.LATERAL_GRIP")` × mass
4. Apply counter-force as impulse

This is 4 lines but makes all the difference between "car" and "sliding box".

**Ground contact detection:**
- Cast a short ray downward from car center (length = half car height + small margin)
- If ray hits: car is grounded → can jump, full traction applies
- If not grounded: reduced grip (or zero), air control via roll/pitch rates instead

**Implementation:**
1. `server/src/physics/car.ts`:
   - Dynamic rigid body (box collider), mass from CAR.BODY.MASS
   - NO CCD (cars are wide and slow enough; saves perf)
   - Each tick function `applyCarPhysics(body, input)`:
     a. Ground check via raycast
     b. If grounded: apply forward force (ENGINE.FORWARD_FORCE × throttle along local Z)
     c. If grounded: apply steering torque (TURN_RATE scaled by speed ratio)
     d. If grounded: apply lateral grip counter-force
     e. If airborne: apply air roll/pitch from input
     f. Apply linear damping, angular damping
   - Jump: if grounded and jump pressed and jumps remaining > 0 → upward impulse

2. Test script (`server/src/physics/test-car.ts`):
   - Scenario A: full throttle forward 120 frames → log speed (should cap near MAX_SPEED due to damping)
   - Scenario B: full throttle + full steer → car turns in arc (lateral grip prevents sliding)
   - Scenario C: full throttle, then sudden steer reversal → car grip holds, no wild spin

**Test:** Scenario B — car's path curves (changing X and Z), not straight line + sudden rotation. Lateral velocity stays small.
**Demo:** Console logs show car following curved path under steering, proving traction works.

---

### Task 5.5: Dev tuning panel (minimal — before car-ball tuning)
**Objective:** Minimal dev panel so Task 6 tuning iterations (car-ball impact) don't require file edit + restart. Server-side message handler + bare HTML panel on client.

**Implementation:**
1. Server: in room (or standalone endpoint), handle `"dev-tune"` message → `setOverride(path, value)` and `"dev-reset"` → `clearOverrides()`
2. Client: `client/src/dev-panel/dev-panel.ts`:
   - Import registry (flat map of all constant paths + current values)
   - Render HTML `<details>` groups by prefix (CAR, BALL, ARENA, etc.)
   - Each value: label + `<input type="number">` + on-change sends to server
   - Toggle visibility with backtick (`) key
   - Only rendered when `import.meta.env.DEV === true`
3. No lil-gui dependency, just raw HTML/CSS. Keep it ugly but functional.

**Test:** Open panel, change `BALL.RESTITUTION` → server picks it up, next tick uses new value.
**Demo:** Change constant → immediately see different behavior in physics (once rendering exists, or in logs for now).

---

### Task 6: Car-ball collision and impact feel
**Objective:** Verify car-ball impact produces satisfying physics. Use dev panel to tune live.

**Implementation:**
1. Test script (`server/src/physics/test-impact.ts`):
   - Position car 15m behind ball, both on ground
   - Apply full engine force until car reaches ball
   - Log ball velocity immediately after collision frame
   - Repeat with: slow approach, max speed, boost speed
2. Key tuning targets (use dev panel):
   - Car at max speed → ball should launch at ~1.5× car speed (mass ratio effect)
   - Car at boost speed → ball should fly fast and far
   - Slow tap → ball rolls gently
   - Ball should NOT tunnel through car (CCD on ball handles this)
3. Document final tuned values as the new constants defaults

**Test:** No tunneling at any speed. Impact velocities feel proportional to approach speed. Mass ratio 5:1 produces punchy but not absurd results.
**Demo:** Console shows clean impact physics at multiple speeds. Final tuned values committed.

---

### Task 7: Colyseus room — basic lifecycle + sandbox
**Objective:** ArenaRoom with full lifecycle + dev-only sandbox room for testing.

**Implementation:**
1. `server/src/rooms/arena-room.ts` — extend Room<GameState>:
   - `onCreate`: init state, maxClients=4, setPatchRate(33)
   - `onJoin`: assign team (blue first 2, orange next 2), create PlayerState
   - `onLeave`: remove player
   - Lock at 4 players → start 5s countdown
   - Handle "input" messages
   - Handle "dev-tune" messages (dev only)
2. `server/src/rooms/sandbox-room.ts` — dev-only room:
   - maxClients=4 but starts immediately with 1 player (no lock, no countdown)
   - Same physics and state sync as ArenaRoom
   - Phase goes straight to "playing" on first join
   - Registered only when `process.env.NODE_ENV !== 'production'`
3. Quick Match: `gameServer.define("arena", ArenaRoom)` with joinOrCreate
4. Custom Room: `gameServer.define("custom", ArenaRoom)` with room code filter
5. Sandbox: `gameServer.define("sandbox", SandboxRoom)`

**Test:** Join sandbox with 1 client → immediately in "playing" phase. Join arena with 4 → locks, countdown.
**Demo:** Server logs show sandbox instant-start, arena fill-and-lock flow.

---

### Task 8: Server game loop — 60Hz physics tick + state sync
**Objective:** Wire Rapier physics into Colyseus game loop. Explicit patch rate.

**Implementation:**
1. In ArenaRoom/SandboxRoom `onCreate`:
   - Init Rapier world (from Task 4)
   - Create arena colliders, ball body, car bodies per player
   - `this.setSimulationInterval(tick, 1000/60)` — 60Hz physics
   - `this.setPatchRate(getConstant("NETCODE.PATCH_RATE_MS"))` — explicit 33ms
2. Each `tick(deltaTime)`:
   - Read stored input per player
   - Call `applyCarPhysics(carBody, input)` for each (from Task 5)
   - Step Rapier world (PHYSICS.TIMESTEP)
   - Read positions/rotations/velocities from Rapier bodies
   - Write into Colyseus Schema (PlayerState, BallState)
3. On "input" message: store latest InputPayload per client sessionId

**Test:** Connect 1 client to sandbox, send forward input → PlayerState.z increases each patch. Ball sits on floor at correct height.
**Demo:** State updates at 30fps broadcast rate, physics runs at 60fps internally.

---

### Task 9: Three.js client — renderer, camera, arena
**Objective:** Three.js scene with procedural arena rendered from constants.

**Implementation:**
1. `client/src/renderer/scene.ts` — WebGLRenderer (antialias), Scene, PerspectiveCamera, resize handler
2. `client/src/renderer/arena.ts` — procedural geometry:
   - Floor: large BoxGeometry, dark green material
   - Walls: 4 BoxGeometry, dark semi-transparent
   - Goals: open boxes at each short end, blue and orange emissive materials
   - Center line, center circle (TubeGeometry or Line)
   - Dimensions from ARENA constants via resolver
3. `client/src/renderer/lighting.ts` — directional light (sun), ambient light, colored point lights at goals
4. `client/src/main.ts` — init scene, add arena, start requestAnimationFrame loop

**Test:** `npm run dev` → browser shows arena with colored goals and lighting.
**Demo:** 3D arena visible with correct proportions.

---

### Task 10: Three.js client — car and ball rendering from server state
**Objective:** Render car and ball meshes, position them from server state (direct, no interp yet).

**Implementation:**
1. `client/src/renderer/car.ts` — procedural car mesh:
   - Body: BoxGeometry (CAR.BODY dimensions)
   - 4 wheels: CylinderGeometry at corners
   - Team color material (blue=0x3366ff, orange=0xff6633)
   - Group all in Object3D for easy transform
2. `client/src/renderer/ball.ts` — SphereGeometry (BALL.RADIUS), white/light emissive
3. `client/src/networking/client.ts` — Colyseus Client, connect to sandbox room
4. `client/src/networking/state-listener.ts`:
   - On player add: create car mesh, add to scene
   - On player change: update mesh position/quaternion directly from state
   - On player remove: remove mesh from scene
   - Same for ball

**Test:** Connect to running server (sandbox) → car and ball appear at correct positions.
**Demo:** Car and ball visible in arena, updating position from server.

---

### Task 11: Client input capture and sending
**Objective:** Keyboard → input payload → server → car moves → visible in browser.

**Implementation:**
1. `client/src/input/keyboard-handler.ts`:
   - W / ArrowUp: throttle = +1
   - S / ArrowDown: throttle = -1 (brake/reverse)
   - A / ArrowLeft: steer = +1
   - D / ArrowRight: steer = -1
   - Space: jump = true (edge-triggered, not held)
   - Shift: boost = true (held)
2. Each requestAnimationFrame: pack key state into InputPayload
3. Send via `room.send("input", payload)` — every frame (server ignores duplicates since it reads latest)
4. Debounce: don't send if payload identical to last sent

**Test:** Press W → car moves forward in browser. A/D → car turns (follows curved path thanks to grip). Space → car jumps.
**Demo:** Full loop working: keyboard → server → physics → state sync → render update. Car drives like a car, not a puck.

---

### Task 12: Interpolation buffer for smooth remote rendering
**Objective:** Smooth rendering of remote entities using interpolation buffer.

**Implementation:**
1. `client/src/networking/interpolation-buffer.ts`:
   - Stores snapshots: `{ serverTime, positions/rotations per entity }`
   - Buffer size from `NETCODE.SNAPSHOT_BUFFER_SIZE`
   - Render time = local time - `NETCODE.INTERPOLATION_DELAY_MS`
   - Find two bracketing snapshots, lerp position (Vector3.lerp), slerp rotation (Quaternion.slerp)
   - Extrapolate gently if buffer starved (use last velocity)
2. Apply to: ball + all remote cars (not local car — local car uses latest state directly for responsiveness)
3. `client/src/networking/state-listener.ts` refactored: push snapshots to buffer instead of direct mesh update

**Test:** Open 2 browser windows in sandbox. Both cars move smoothly without teleporting despite 33ms patch intervals.
**Demo:** Smooth remote movement. Intentional latency simulation still looks good.

---

### Task 13: Scoring system and goal detection
**Objective:** Detect ball entering goal, increment score, reset to kickoff.

**Implementation:**
1. `server/src/physics/goal-sensor.ts`:
   - Two Rapier sensor colliders (cuboid shape) inside each goal volume
   - Check intersection with ball each tick
2. `server/src/systems/scoring.ts`:
   - On ball fully inside goal sensor → determine scoring team
   - Set `state.phase = "goal-scored"`
   - Increment blueScore or orangeScore
   - After `MATCH.GOAL_RESET_DELAY` seconds (3s): reset ball to center, cars to kickoff positions
   - Set phase back to "playing" (or "overtime" if was overtime)
3. Kickoff positions: defined in constants — blue team on their half, orange on theirs, facing center

**Test:** Teleport ball into goal sensor → score increments, reset occurs after 3s.
**Demo:** Push ball into goal → HUD updates (once HUD exists), positions reset.

---

### Task 14: Match timer and overtime
**Objective:** 5-minute countdown with golden-goal overtime.

**Implementation:**
1. `server/src/systems/match-timer.ts`:
   - On phase="playing": decrement timeRemaining by deltaTime each tick
   - Sync to schema (clients read it)
   - On reaching 0:
     - If blueScore !== orangeScore → phase="ended", winner determined
     - If tied → phase="overtime", timeRemaining = -1 (display as "+OT")
   - In overtime: next goal immediately triggers phase="ended"
2. Timer pauses during "goal-scored" and "countdown" phases
3. On "ended": broadcast winner, wait 10s, then dispose room

**Test:** Set MATCH.DURATION_SECONDS override to 10s → match ends quickly. Test tied → overtime → goal → ended.
**Demo:** Timer counts down, transitions work correctly through all phase changes.

---

### Task 15: HUD — scores, timer, boost meter
**Objective:** HTML overlay HUD.

**Implementation:**
1. `client/src/hud/hud.ts` — DOM overlay:
   - Top bar: [Blue Score] — [Timer MM:SS or +OT] — [Orange Score]
   - Bottom: boost meter (horizontal bar, 0-100%)
   - Team colors on score numbers
   - Phase indicator (COUNTDOWN 3..2..1, GOAL!, OVERTIME, GAME OVER)
2. `client/src/hud/hud.css` — minimal styling, position:fixed overlay
3. Update from Colyseus state change callbacks
4. Countdown: large center text "3... 2... 1... GO!"
5. Goal scored: flash "GOAL!" for 2 seconds

**Test:** Scores, timer, boost all update in real-time from server state.
**Demo:** Full HUD visible during gameplay.

---

### Task 16: Dev panel polish (upgrade from Task 5.5)
**Objective:** Upgrade the minimal dev panel from Task 5.5 into something usable for final tuning.

**Implementation:**
1. Grouped by category with collapsible sections
2. Slider inputs for bounded values (0-1 for grip, etc.), number inputs for unbounded
3. "Reset to defaults" button per group
4. "Reset all" button
5. Show current value vs default (highlight if overridden)
6. Keyboard shortcut reminder in panel header
7. Still HTML-only, no external deps

**Test:** Full tuning workflow: change multiple values, verify effect, reset selectively.
**Demo:** Panel looks usable (not pretty, but functional for the demo video).

---

### Task 17: Lobby UI — Quick Match and Custom Room
**Objective:** Entry screen with matchmaking options.

**Implementation:**
1. `client/src/ui/lobby.ts`:
   - Player name input (stored in sessionStorage, ephemeral)
   - "Quick Match" button → `client.joinOrCreate("arena")`
   - "Create Room" button → creates custom room, shows 6-char code
   - "Join Room" → text input for code + join button
   - "Sandbox (Dev)" button → joins sandbox room (hidden in production)
2. Team assignment display once in room (waiting for others)
3. Player list with team colors
4. Countdown overlay (5s) when room fills
5. Transition: hide lobby DOM, show canvas + HUD when phase transitions from waiting/countdown to playing

**Test:** Quick Match creates/joins. Custom code works. Sandbox starts immediately. Countdown triggers at 4.
**Demo:** Two browsers join same match, see countdown, enter game.

---

### Task 18: Kickoff sequence and match flow
**Objective:** Full match lifecycle wired end-to-end.

**Implementation:**
1. Phase machine in ArenaRoom:
   - `"waiting"` → accepting joins, no physics, show lobby
   - `"countdown"` → 5s timer, cars visible at kickoff positions, inputs disabled
   - `"playing"` → physics active, inputs processed, timer running
   - `"goal-scored"` → freeze 3s, show scorer info, then reset → back to "playing"
   - `"overtime"` → like playing but next goal wins, no timer
   - `"ended"` → show final scores, 10s then dispose
2. Client phase handler:
   - `"waiting"`: show lobby/waiting UI
   - `"countdown"`: show arena + cars + countdown text, lock input
   - `"playing"`: full game
   - `"goal-scored"`: show "GOAL!" text, maybe slow-mo camera
   - `"ended"`: show `client/src/ui/game-over.ts` — winner display + "Play Again" button
3. "Play Again" → back to lobby

**Test:** Play full shortened match (30s) through all phase transitions including overtime.
**Demo:** Complete flow from lobby → gameplay → goal → reset → end → play again.

---

### Task 19: Camera system and visual polish
**Objective:** Follow camera behind local car + visual feedback.

**Implementation:**
1. `client/src/renderer/camera-controller.ts`:
   - Position: behind and above local car (configurable offset)
   - Smooth follow with lerp (CAMERA.LERP_SPEED)
   - Look-at point: car position + forward offset
   - `shared/src/constants/camera.ts`: FOLLOW_DISTANCE, HEIGHT_OFFSET, LOOK_AHEAD_DISTANCE, LERP_SPEED
2. Visual polish:
   - Boost trail: elongated transparent geometry behind car when boosting, fades quickly
   - Goal celebration: brief screen flash + camera shake on goal scored
   - Arena floor: subtle grid lines or field markings
   - Car headlights: small point lights on front of each car
   - Ball glow: subtle emissive on ball material
3. Shadows: renderer.shadowMap enabled, directional light casts shadows on floor

**Test:** Camera follows smoothly through turns without jitter or snapping. Boost trail visible.
**Demo:** Game looks polished enough for a demo video.

---

### Task 20: README, documentation, and submission prep
**Objective:** Comprehensive README for hackathon judges. Everything runs from a fresh clone.

**Implementation:**
1. README.md:
   - Title + one-line description
   - Architecture diagram (ASCII art showing client/server/shared)
   - **Kiro usage section**: how .kiro steering files guided development, how specs drove task execution, link to commit history showing task-by-task progress
   - Setup instructions: `git clone` → `npm install` → `npm run dev` → open two browsers
   - Controls documentation (keyboard diagram)
   - Testing instructions: "Open 2-4 browser tabs, play a match"
   - Tech stack with brief rationale for each choice
   - Screenshots or GIF instructions
2. Verify fresh clone workflow:
   - `npm install` completes without errors
   - `npm run dev` starts server + client
   - Navigate to localhost:3000 → game works
3. `package.json` scripts clear and documented
4. Environment: no .env required, no external services, zero config

**Test:** Fresh clone on clean machine → follow README → playing within 2 minutes.
**Demo:** README is judge-ready.

---

## Task Order (final, corrected)

1. Repo setup + scaffolding
2. Constants system (frozen + resolver + registry)
3. Shared types + Colyseus schema
4. Rapier world — ball only (verify by logging)
5. Rapier car body + **traction model** (verify by logging)
5.5. Dev panel minimal (before car-ball tuning)
6. Car-ball collision + impact tuning (use dev panel)
7. Colyseus room lifecycle + **sandbox room**
8. Server game loop (60Hz physics, **33ms patch rate**)
9. Three.js renderer + arena
10. Car + ball rendering from server state
11. **Input capture** (moved before interpolation)
12. **Interpolation buffer** (moved after input — now you can feel it while driving)
13. Scoring + goal detection
14. Match timer + overtime
15. HUD
16. Dev panel polish
17. Lobby UI
18. Kickoff sequence + full match flow
19. Camera + visual polish
20. README + submission prep

---

## Definition of Done
Two browser windows on the same machine can join a match (via sandbox room for dev, or Quick Match/Custom Room once Task 17 is done), both see the same ball position within a frame or two of each other, a goal registers and resets to kickoff, and the timer ends the match.

## Non-Goals (DO NOT BUILD)
- No matchmaking algorithm, no skill rating, no bot-fill
- No horizontal scaling, no Redis, no room sharding
- No user accounts, no auth, no persistence, no database
- No cosmetics, no progression, no unlocks
- No 3v3 (fixed at 4 players max)
- No mobile/touch controls
- No deployment (judges clone and run locally)

## Stretch Goals (ONLY after core is playable)
- Client-side prediction and reconciliation for local car
- Boost pad pickups on arena floor
- Double-jump / flip mechanics (requires ground contact already built in Task 5)
