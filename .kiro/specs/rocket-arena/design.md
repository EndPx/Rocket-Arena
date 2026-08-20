# Design Document: Rocket Arena Mechanics Fidelity and Expanded Multiplayer

## Overview

This document defines the implementation architecture for the finalized Rocket Arena mechanics and multiplayer requirements. The repository remains a TypeScript monorepo with shared contracts and tuning, Colyseus rooms, an authoritative Rapier simulation, and a Three.js client.

The change expands Quick Match to exactly 3-versus-3 and Custom Room to as many as 4-versus-4, then rebuilds the gameplay layer around explicit mode policies, deterministic roster and kickoff services, a scripted car controller, metric arena geometry, bounded snapshot transport, fixed-step match flow, boost pads, and two gameplay camera modes. Shared confirmed match rules set regulation to 300 seconds, `Regulation_Goal_Target` to 6, and `Regulation_Win_Margin` to 2 for both room modes. Above-zero goals use the target-and-margin condition without a regulation score cap; the Fixed_Step that first reaches zero performs an atomic hard cutoff, and tied matches continue only through a fresh overtime kickoff and untimed sudden death. Existing server authority, the `1/60`-second accumulator, independent approximately 33-millisecond snapshots, the 24-snapshot/100-millisecond interpolation pipeline, shortest-path quaternion interpolation, 80-millisecond extrapolation bound, monotonic input edges, procedural audio, lobby foundations, and stadium presentation are preservation baselines.

No mercy rule or demolition implementation is added by this design.

The design deliberately does not assign final tuning values where the requirements classify evidence as incomplete. Support-ray geometry, steering-curve samples, car-collider dimensions, aerodynamic drag, ball damping, boost-pad coordinates and hitboxes, and camera defaults live in a versioned registry with finite validated ranges and evidence gates. Required starting hypotheses may be checked in for a staging build, but they remain visibly unverified until the release gate passes.

## Design Goals

1. Make room capacity and start behavior explicit per room mode; there is no shared `MAX_PLAYERS` or `TEAM_SIZE` gameplay constant.
2. Make every roster mutation transactional, deterministic, and testable without Rapier or Colyseus.
3. Produce complete kickoff assignments before moving any body and preserve assignments across unchanged epochs.
4. Carry up to eight unique cars in a versioned wire contract and reject invalid snapshots before any client state changes.
5. Separate controller intent from Rapier collision outcomes while keeping all authoritative values finite and bounded.
6. Drive countdowns, goal resets, pad respawns, regulation, the hard cutoff, and untimed overtime from fixed simulation time only.
7. Derive server collision and client stadium boundaries from one metric geometry specification.
8. Preserve existing audio, interpolation, rendering, and lobby behavior while adapting them to accepted eight-car state.
9. Keep uncertain values configurable, attributable, and impossible to present as final fidelity without evidence.

## Preservation Baselines

The implementation must retain these already-shipped behaviors unless a finalized requirement explicitly replaces a value:

- `server/src/rooms/fixed-step-scheduler.ts` continues to sanitize callback deltas, clamp them to `0.1` seconds, execute no more than five `1/60`-second steps, discard excess whole steps, and schedule snapshots independently.
- `client/src/networking/interpolation-buffer.ts` retains a maximum of 24 accepted snapshots, a 100-millisecond delayed timeline, shortest-path quaternion slerp, teleport discontinuity handling, and extrapolation capped at 80 milliseconds.
- The server remains the only authority for transforms, contacts, inventory, teams, score, and match phase. Client messages remain control requests only.
- `jumpSequence` semantics and the 250-millisecond input heartbeat remain; additional discrete controls use the same edge-sequence model.
- `client/src/audio/**` consumes only accepted authoritative state and interpolated presentation state. No mechanics subsystem plays sounds directly.
- `client/src/renderer/arena.ts`, lighting, car presentation, and effects remain the stadium baseline, but authoritative boundary meshes are regenerated from the new shared arena specification.
- Lobby input normalization, room-code behavior, accessible sound controls, and existing resource cleanup remain regression requirements.

## Current-State Gap Analysis

| Area | Current repository state | Finalized gap and design response |
|---|---|---|
| Match configuration | `shared/src/constants/match.ts` defines `MAX_PLAYERS: 4`, `TEAM_SIZE: 2`, a 5-second countdown, and a 3-second reset. | Replace global capacity fields with immutable `ROOM_POLICIES.quick` and `ROOM_POLICIES.custom`. Set the universal kickoff countdown to exactly 3 seconds. Register the 2-second reset as an unverified hypothesis rather than a final constant. |
| Room orchestration | `server/src/rooms/arena-room.ts` and `custom-room.ts` duplicate simulation, state sync, spawning, scoring, and timers. | Add a shared authoritative room core. Keep `ArenaRoom` and `CustomRoom` as thin policy adapters so mode-specific admission/start rules cannot drift while physics stays identical. |
| Countdown time | Both rooms use wall-clock `setInterval` countdowns outside the fixed-step accumulator. | Represent countdown/reset durations in fixed-step state and update them inside every authoritative `Fixed_Step`; remove room-owned countdown intervals. |
| Quick Match | Starts at four clients and assigns the first two Blue, next two Orange. A disconnect does not cancel a countdown. | Deterministically balance each accepted join, cap at 6/3, start only at 3+3, cancel before active play when occupancy drops below six, then restart a fresh 3-second countdown when restored. |
| Custom Room | Caps at four, permits unchecked team switches, and uses `this.clients` order for host reassignment. | Cap at 8/4, validate switches atomically, require a capacity-valid roster and Host start, and reassign Host by stable accepted-join order. |
| Kickoff placement | Each room independently distinguishes only a first and second teammate. | Add four canonical Blue slots and derive four mirrored Orange slots. A pure service maps team-local stable roster index `i` to slot `i`, validates facing and collider separation, and swaps assignments atomically. |
| Snapshot contract | Rooms build an untyped `players` record. Duplicate identities cannot be detected before record-key collapse, capacity is absent, and validation occurs only after conversion to interpolation entities. | Add a versioned snapshot with a `cars: CarSnapshot[]`, mode policy metadata, typed phase fields, finite numeric validation, and a parse/validate/prepare/commit client pipeline. |
| Client entity lifecycle | `state-listener.ts` updates `localState` and immediately creates/removes meshes after `SnapshotBuffer.push`. It has no mode-capacity, identity, team-count, or metadata validation. | Validate the complete raw envelope before conversion. Prepare mesh reconciliation without mutating the scene, commit buffer/state/meshes together, and preserve the prior accepted state on any malformed or over-capacity snapshot. |
| Car body and controller | `server/src/physics/car.ts` creates a rounded collider at 120 kg, uses world-down rays, old force/soft-cap tuning, passive boost recharge, and one jump. | Use an independent plain box collider at 150 kg, local-axis grounding, pure command planning, speed-dependent acceleration/curvature, powerslide, fixed boost consumption, two-jump/flip state, air control, finite recovery, and post-step caps. |
| World and ball | Gravity is `-24`; the ball is radius `1.8`, mass `32`, and uses old damping. | Set gravity to `(0,-6.5,0)`, ball radius `0.9125`, mass `25`, restitution `0.60`, CCD, explicit speed caps, and unverified damping constrained to `[0,0.2] s^-1`. |
| Arena and scoring | Arena is `40 x 60 x 20`; scoring checks whether the ball is currently inside a sensor-like volume. | Use the finalized metric geometry, closed goal interiors, shared collision/render descriptors, and swept ball-center crossing against each goal-line plane. |
| Match flow | Time-up immediately ends or enters overtime. Goal reset returns directly to play. Confirmed target-and-margin regulation rules and atomic cutoff ordering are absent. | Add a pure reducer with shared 6-goal/2-goal-margin rules above zero, configurable goal reset, an atomic same-step hard cutoff at zero, a frozen overtime countdown for ties, untimed sudden death, and terminal-state freezing. Regulation scores are never capped by a match rule. |
| Boost | Inventory starts at 60, consumes 24/s, and passively recharges. No pad system exists. | Start every kickoff at 33, consume 33.3/s, remove passive recharge, deliver six large pads first, then 28 small pads, and use simulation ticks for deterministic contention and respawn. |
| Camera and HUD | The client has lobby orbit and one stabilized follow mode; the HUD hard-codes `/4` and has no ball indicator or live-event deduplication. | Add default Ball Camera, edge-toggled Car Camera, finite spring bounds, off-screen ball direction, policy-derived capacities, phase notices, and event-keyed polite announcements. |
| Tuning | `DEFAULTS_REGISTRY` flattens numbers and global `setOverride` accepts any finite-looking number without units, ranges, evidence, versioning, or room isolation. | Add typed/versioned tuning entries, structured curves, finite inclusive ranges, room-pinned snapshots, evidence and approval records, status declarations, and a release-gate validator. |

## Architecture

### System Context and Data Flow

```text
Keyboard / gamepad
  -> InputController (held values + monotonic edge sequences)
  -> Colyseus `input` message
  -> InputValidator (finite normalization; no authoritative values)
  -> per-session latest InputCommand

Colyseus room callback delta
  -> FixedStepScheduler (sanitize, clamp, <=5 exact substeps)
  -> AuthoritativeRoomCore.step(1/60)
       1. queued roster mutations
       2. phase/input gate
       3. finite-state recovery
       4. local-down grounding
       5. controller command planning
       6. controller impulse/target application
       7. Rapier world.step() and emergent contacts
       8. post-step finite/speed bounds
       9. goal and pad event extraction
      10. score-once match-flow reduction, hard-cutoff resolution, and atomic transition
      11. terminal-aware schema projection
  -> SnapshotBuilder at independent ~33 ms cadence
  -> SnapshotEnvelopeV2
  -> Client SnapshotDecoder + Validator
  -> immutable candidate + interpolation candidate
  -> atomic accepted-state commit
       -> SnapshotBuffer -> interpolated meshes -> camera/audio/effects
       -> AcceptedSnapshotStore -> lobby/HUD/accessibility
```

### Server Layering

```text
ArenaRoom / CustomRoom
        | choose immutable RoomPolicy
        v
AuthoritativeRoomCore
  +-- RosterService / RoomMutationService
  +-- KickoffSlotService
  +-- MatchFlowReducer
  +-- SnapshotBuilder
  +-- BoostPadSystem
  |
  +-- SimulationPipeline
       +-- GroundingSystem
       +-- ScriptedCarController
       +-- Rapier World
       +-- BallBounds
       +-- GoalCrossingDetector
```

`ArenaRoom` and `CustomRoom` own transport registration and mode-specific commands only. They do not implement separate physics loops. Pure services receive explicit state and return a result or typed rejection; only `AuthoritativeRoomCore` commits their results.

### Client Acceptance Boundary

```text
unknown message
  -> decode structural fields
  -> validate policy/version/counts/unique identities/numbers/bounds
  -> build immutable DomainSnapshot
  -> ask SnapshotBuffer whether sequence/time are acceptable
  -> prepare car mesh additions/removals and accepted UI state
  -> commit buffer + accepted state + scene reconciliation

any failure -------------------------------> preserve previous state exactly
```

Validation happens before converting `cars[]` to a keyed record, so duplicate identities cannot be silently collapsed.

## Components and Interfaces

The following paths align the design to the current repository. “Refactor” retains the public behavior needed by existing imports; “add” introduces a focused module.

### Shared Workspace

| Path | Change | Ownership |
|---|---|---|
| `shared/src/constants/match.ts` | Refactor | Confirmed shared match rules: 300-second regulation, exact 3-second kickoff, `Regulation_Goal_Target = 6`, and `Regulation_Win_Margin = 2`, applied identically to Quick and Custom. Remove gameplay use of `MAX_PLAYERS`, `TEAM_SIZE`, and the obsolete reset value; define no regulation score cap. |
| `shared/src/constants/netcode.ts` | Refactor | Retain the nominal approximately 33-millisecond snapshot target and interpolation bounds; add a finite non-negative snapshot scheduling tolerance that remains independent of the fixed step. |
| `shared/src/config/room-policies.ts` | Add | `RoomMode`, `RoomPolicy`, immutable Quick/Custom capacity and start rules, policy version, and consistency validation. |
| `shared/src/geometry/arena-spec.ts` | Add | Exact metric arena, goal, corner, ramp, and surface descriptors consumed by server and client. |
| `shared/src/geometry/kickoff-slots.ts` | Add | Four canonical Blue slot transforms, derived mirrored Orange transforms, slot IDs, and structural validation. Exact proximity fidelity remains status-gated. |
| `shared/src/types/input.ts` | Refactor | Versioned normalized control contract: throttle, steer, jump hold/sequence, boost, powerslide, air axes, and camera-toggle sequence. |
| `shared/src/types/snapshot.ts` | Add | `SnapshotEnvelopeV2`, `CarSnapshot`, `BallSnapshot`, phase unions, room policy metadata, and serialization helpers. |
| `shared/src/types/room.ts` | Add | Teams, stable roster entries, rejection codes, countdown kinds, winner, and feature-status types. |
| `shared/src/schema/player-state.ts` | Refactor | Internal authoritative projection with stable join ordinal, typed team, host metadata, angular velocity if required by diagnostics, and bounded boost. |
| `shared/src/schema/game-state.ts` | Refactor | Room mode/policy version, phase, countdown kind, phase remaining time, regulation steps/time, scores, kickoff epoch, winner, terminal result, latest atomic transition, and occupancy projection. |
| `shared/src/tuning/model.ts` | Add | Tuning entry, finite range, unit, classification, evidence, approval, and status interfaces. |
| `shared/src/tuning/registry.ts` | Add | Versioned immutable registry, structured curve validation, atomic proposal validation, and room-pinned snapshots. |
| `shared/src/tuning/release-gate.ts` | Add | Pure release eligibility evaluation from registry, evidence, approvals, status, harness evidence, and browser evidence. |
| `shared/src/constants/registry.ts` and `resolver.ts` | Refactor | Compatibility reads for confirmed numeric constants; delegate mutable mechanics tuning to the typed registry. Remove unrestricted process-global mechanics overrides. |
| `shared/src/index.ts`, `constants/index.ts`, `types/index.ts` | Refactor | Export the new contracts while retaining baseline exports used by audio and presentation. |

### Server Workspace

| Path | Change | Ownership |
|---|---|---|
| `server/src/rooms/arena-room.ts` | Refactor | Register Quick Match, select `ROOM_POLICIES.quick`, expose Quick-only transport commands, and delegate to the core. |
| `server/src/rooms/custom-room.ts` | Refactor | Register Custom Room/code, select `ROOM_POLICIES.custom`, expose host start/team-switch commands, and delegate to the core. |
| `server/src/rooms/authoritative-room-core.ts` | Add | Physics readiness, fixed-step loop, room-pinned tuning, mutation queue, world lifecycle, phase transitions, and snapshots. |
| `server/src/rooms/fixed-step-scheduler.ts` | Preserve/refine | Existing exact-step behavior and independent snapshot cadence; add an observable non-negative remainder for tests if needed. |
| `server/src/systems/room-mutations.ts` | Add | Plan/validate/commit joins, leaves, switches, host changes, and typed rejections. |
| `server/src/systems/team-assignment.ts` | Add | Pure deterministic assignment from policy and stable roster order. |
| `server/src/systems/kickoff-slots.ts` | Add | Build and validate complete assignments, OBB overlap checks using current collider hypothesis, and epoch caching. |
| `server/src/systems/match-flow.ts` | Replace `match-timer.ts` behavior | Pure fixed-step reducer for above-zero target-and-margin goals, configurable reset, countdowns, atomic hard cutoff, tied overtime entry, untimed sudden death, and terminal freezing. |
| `server/src/systems/goal-crossing.ts` | Replace occupancy logic in `scoring.ts` | Swept ball-center crossing, per-epoch arming/suppression, and one score event per valid crossing; arena contacts do not decide match expiration. |
| `server/src/systems/snapshot-builder.ts` | Add | Finite, bounded, ordered `SnapshotEnvelopeV2` creation, strictly increasing snapshot and transition sequences, and coherent terminal score/winner projection. |
| `server/src/systems/boost-pads.ts` | Add | Inventory consumption, pad contacts, stable contention, pad state, and simulation-tick respawns. |
| `server/src/physics/car-body.ts` | Add; split from `car.ts` | Plain box body/collider creation, 150 kg mass, CCD, last-finite body state, and cleanup. |
| `server/src/physics/car-controller.ts` | Add; split from `car.ts` | Pure controller planning and bounded application for throttle, steering, grip, powerslide, boost, jumps, flips, and air control. |
| `server/src/physics/grounding.ts` | Add | Local-down support queries, surface filtering, deterministic confirmed normal, and Core/Advanced capability gates. |
| `server/src/physics/finite-state.ts` | Add | Finite substitution, vector/quaternion normalization, propulsion limits, and post-step speed/angular caps. |
| `server/src/physics/car.ts` | Refactor/barrel | Temporary compatibility facade for current harness imports; remove duplicated controller logic after migration. |
| `server/src/physics/arena.ts` | Refactor | Build colliders and tagged surfaces from `ArenaGeometrySpec`, including closed solid goal interiors and pad sensors. |
| `server/src/physics/ball.ts` | Refactor | Final radius/mass/restitution/CCD, damping hypothesis, last-finite recovery, and post-step caps. |
| `server/src/physics/world.ts` | Refactor | Gravity `(0,-6.5,0)` and deterministic solver setup; retain `world.timestep = 1/60`. |

### Client Workspace

| Path | Change | Ownership |
|---|---|---|
| `client/src/networking/snapshot-validator.ts` | Add | Decode unknown V1/V2 messages during migration, validate V2 atomically, and return immutable domain snapshots or typed errors. |
| `client/src/networking/accepted-snapshot-store.ts` | Add | Single accepted-state source for lobby, HUD, audio, and lifecycle subscribers. |
| `client/src/networking/state-listener.ts` | Refactor | Validate before keying identities, stage scene reconciliation, commit accepted state atomically, and handle up to eight meshes. |
| `client/src/networking/interpolation-buffer.ts` | Preserve/refine | Keep 24/100/80 bounds and shortest-path slerp; accept only validated immutable entity timelines. |
| `client/src/input/input-controller.ts` and `keyboard-handler.ts` | Refactor | Add powerslide/air controls and monotonic camera-toggle edges while retaining jump edges, editable-target rules, neutral sync, and heartbeat behavior. |
| `client/src/renderer/camera-controller.ts` | Refactor | Lobby orbit remains presentation-only; gameplay modes become `ball` and `car`, defaulting to Ball Camera, with teleport rebasing and validated finite spring configuration. |
| `client/src/renderer/arena.ts` | Refactor | Render authoritative boundaries from `ArenaGeometrySpec`; retain stadium art around those boundaries and enforce 0.05 m alignment. |
| `client/src/renderer/car.ts` | Refactor | Keep current visual baseline but move visual model dimensions under `VISUAL`; never derive the independent physics collider from the render mesh. |
| `client/src/hud/hud.ts` | Refactor | Policy-derived occupancy, team counts, score/timer/boost/camera mode, phase notices, off-screen indicator, and polite event announcements. |
| `client/src/hud/ball-indicator.ts` | Add | Projection and viewport-edge intersection for the off-screen ball indicator. |
| `client/src/ui/lobby.ts` | Refactor | Render 6/3 or 8/4 from accepted policy metadata, present typed rejection reasons, disable invalid team switches, and use one snapshot subscription. |
| `client/src/main.ts` | Refactor | Order each frame as accepted snapshot interpolation, entity effects, camera, HUD, audio, and render without adding authority. |
| `client/src/audio/**` | Preserve | Continue consuming accepted snapshots and interpolated entities; rejected candidates and uncommitted scene changes are invisible to audio. |

### Tools and Evidence

| Path | Change | Ownership |
|---|---|---|
| `tools/validate-tuning-registry.ts` | Add | Schema/range/classification checks for every tuning entry. |
| `tools/validate-release-gate.ts` | Add | Fail final release when evidence, approval, harness, browser proof, or feature status is incomplete. |
| `docs/tuning/reference-evidence.json` | Add during implementation | Source identity/version/date, original unit, conversion, value/range, and approval status. |
| `docs/tuning/approvals.json` | Add during implementation | Harness/browser evidence links and explicit per-hypothesis approval. |
| `docs/feature-status.json` | Add during implementation | Delivered/deferred features for staging and final builds. |

## Data Models

### Mode-Specific Room Policy

```typescript
export type RoomMode = 'quick' | 'custom';
export type Team = 'blue' | 'orange';

export interface RoomPolicy {
  readonly version: 1;
  readonly mode: RoomMode;
  readonly totalCapacity: number;
  readonly teamCapacity: number;
  readonly assignmentTieBreak: 'blue';
  readonly startRule: 'full-balanced' | 'host-request';
  readonly allowWaitingTeamSwitch: boolean;
}

export const ROOM_POLICIES = Object.freeze({
  quick: Object.freeze({
    version: 1,
    mode: 'quick',
    totalCapacity: 6,
    teamCapacity: 3,
    assignmentTieBreak: 'blue',
    startRule: 'full-balanced',
    allowWaitingTeamSwitch: false,
  }),
  custom: Object.freeze({
    version: 1,
    mode: 'custom',
    totalCapacity: 8,
    teamCapacity: 4,
    assignmentTieBreak: 'blue',
    startRule: 'host-request',
    allowWaitingTeamSwitch: true,
  }),
} satisfies Record<RoomMode, RoomPolicy>);
```

```typescript
export const Regulation_Goal_Target = 6 as const;
export const Regulation_Win_Margin = 2 as const;

export interface SharedMatchRules {
  readonly regulationDurationSeconds: 300;
  readonly regulationActivePlaySteps: 18_000;
  readonly kickoffCountdownSteps: 180;
  readonly Regulation_Goal_Target: 6;
  readonly Regulation_Win_Margin: 2;
}

export const MATCH_RULES = Object.freeze({
  regulationDurationSeconds: 300,
  regulationActivePlaySteps: 18_000,
  kickoffCountdownSteps: 180,
  Regulation_Goal_Target,
  Regulation_Win_Margin,
} satisfies SharedMatchRules);
```

`MATCH_RULES` is one confirmed shared configuration for Quick and Custom. `Regulation_Goal_Target` and `Regulation_Win_Margin` are evaluated only for valid regulation goals while time remains above zero. Scores are non-negative integers and are incremented without a match-rule cap. Hard-cutoff and overtime outcomes deliberately do not use the target or margin.

A room type is selected by the registered Colyseus room name, not by client-supplied capacities. `onCreate` obtains the policy and `MATCH_RULES`, validates their internal invariants, sets `maxClients` from `totalCapacity`, records the policy in authoritative state, and logs mode/total/team values before accepting a player. A request attempting to override those values is rejected before state or roster creation.

### Stable Roster and Transaction Result

```typescript
export interface RosterEntry {
  readonly sessionId: string;
  readonly acceptedJoinOrdinal: number;
  readonly team: Team;
  readonly name: string;
  readonly isHost: boolean;
}

export interface RoomRoster {
  readonly entries: ReadonlyMap<string, RosterEntry>;
  readonly nextJoinOrdinal: number;
  readonly hostSessionId: string | null;
}

export type RoomMutationErrorCode =
  | 'duplicate-identity'
  | 'total-capacity'
  | 'team-capacity'
  | 'not-represented'
  | 'not-opposite-team'
  | 'wrong-phase'
  | 'not-host'
  | 'invalid-roster'
  | 'policy-mismatch'
  | 'physics-not-ready';

type MutationResult<T> =
  | { readonly ok: true; readonly next: T }
  | { readonly ok: false; readonly code: RoomMutationErrorCode };
```

Stable roster order compares `acceptedJoinOrdinal`, then `sessionId` as a deterministic tie breaker. It never uses current `Map` iteration order, `this.clients` order, wall-clock time, or display name.

### Match State

```typescript
export type MatchPhase =
  | 'waiting'
  | 'countdown'
  | 'playing'
  | 'goal-reset'
  | 'overtime'
  | 'ended';

export type CountdownKind = 'initial' | 'post-goal' | 'overtime';
export type TerminalReason =
  | 'regulation-target-and-margin'
  | 'hard-regulation-cutoff'
  | 'overtime-goal';

export interface GoalResult {
  readonly eventId: number;
  readonly team: Team;
  readonly kickoffEpoch: number;
  readonly blueScore: number;
  readonly orangeScore: number;
}

export interface TerminalResult {
  readonly eventId: number;
  readonly reason: TerminalReason;
  readonly winner: Team;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly goal: GoalResult | null;
}

export interface AuthoritativeMatchState {
  readonly phase: MatchPhase;
  readonly countdownKind: CountdownKind | null;
  readonly countdownStepsRemaining: number;
  readonly goalResetStepsRemaining: number;
  readonly regulationStepsRemaining: number;
  readonly regulationActivePlayStepsCompleted: number;
  readonly regulationStarted: boolean;
  readonly regulationCutoffResolved: boolean;
  readonly kickoffEpoch: number;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly winner: Team | null;
  readonly latestGoal: GoalResult | null;
  readonly terminalResult: TerminalResult | null;
  readonly transitionSequence: number;
  readonly scoringSuppressedForEpoch: boolean;
}
```

The 300-second regulation clock uses 18,000 integer Fixed_Step values as its source of truth; displayed seconds are `regulationStepsRemaining / 60`, clamped to zero. The exact 3-second kickoff countdown is stored as 180 steps. The configurable goal-reset duration remains a validated seconds value converted deterministically to steps; the required 2-second starting hypothesis produces exactly 120 steps. `terminalResult` is immutable once set and carries the same final scores and winner projected by every later Ended snapshot. UI values are derived from authoritative fields and never drive a transition.

### Input Contract

```typescript
export interface InputCommandV2 {
  readonly protocolVersion: 2;
  readonly throttle: number;       // normalized [-1, 1]
  readonly steer: number;          // normalized [-1, 1]
  readonly pitch: number;          // normalized [-1, 1]
  readonly yaw: number;            // normalized [-1, 1]
  readonly roll: number;           // normalized [-1, 1]
  readonly jumpHeld: boolean;
  readonly jumpSequence: number;   // non-negative monotonic edge
  readonly boostHeld: boolean;
  readonly powerslideHeld: boolean;
  readonly cameraToggleSequence: number; // client presentation edge
}
```

The server validates and stores only control intent. `cameraToggleSequence` is consumed by the local camera controller and has no server-side gameplay effect. Values are normalized independently so one malformed axis becomes neutral without erasing other validated components. No transform, contact, inventory, score, team, or phase field is part of this contract; unknown authoritative-looking fields are ignored.

### Snapshot Wire Contract V2

```typescript
export interface CarSnapshot {
  readonly sessionId: string;
  readonly team: Team;
  readonly name: string;
  readonly isHost: boolean;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly linearVelocity: readonly [number, number, number];
  readonly boost: number;
}

export interface BallSnapshot {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly linearVelocity: readonly [number, number, number];
}

export interface MatchTransitionSnapshot {
  readonly eventId: number;
  readonly kind:
    | 'countdown'
    | 'regulation-goal-reset'
    | 'regulation-terminal-goal'
    | 'hard-cutoff'
    | 'overtime-entry'
    | 'overtime-terminal-goal';
  readonly goal: GoalResult | null;
  readonly terminal: TerminalResult | null;
}

export interface SnapshotEnvelopeV2 {
  readonly protocolVersion: 2;
  readonly policyVersion: 1;
  readonly roomMode: RoomMode;
  readonly totalCapacity: 6 | 8;
  readonly teamCapacity: 3 | 4;
  readonly sequence: number;
  readonly serverTime: number;
  readonly simulationTime: number;
  readonly phase: MatchPhase;
  readonly countdownKind: CountdownKind | null;
  readonly phaseSecondsRemaining: number;
  readonly regulationSecondsRemaining: number;
  readonly kickoffEpoch: number;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly winner: Team | null;
  readonly terminalResult: TerminalResult | null;
  readonly latestTransition: MatchTransitionSnapshot | null;
  readonly cars: readonly CarSnapshot[];
  readonly ball: BallSnapshot;
}
```

Cars are serialized in Stable_Roster_Order. An array is intentional: duplicate `sessionId` values remain observable and rejectable. The snapshot builder asserts `cars.length === roster.size`, `cars.length <= policy.totalCapacity`, each team count is within policy, identities are unique, and every numeric field is finite and bounded before broadcasting. In Ended_State, `blueScore`, `orangeScore`, `winner`, and `terminalResult` must agree exactly; repeated snapshots retain the same terminal event ID so clients cannot replay notices or audio.

### Wire-Contract Migration

1. Add V2 types, serializers, validators, round-trip tests, shared 6/2 rule constants, and terminal transition fields without changing the current V1 emitter.
2. Change the client decoder to accept the current unversioned record as `LegacySnapshotV1` and V2 as separate branches. The V1 adapter is temporary, derives mode from the joined room type, and still passes through finite/sequence validation; it cannot synthesize release-eligible terminal event identity.
3. Switch both rooms to the shared V2 `SnapshotBuilder`. The updated client is already able to accept it.
4. Exercise mixed-version rejection, V2 maximum-capacity transport, non-winning/winning regulation goals, hard-cutoff terminal snapshots, tied overtime entry, and overtime terminal-goal snapshots.
5. Remove the V1 adapter only after no supported server emits V1. V1 is never promoted to the final release contract because a keyed record cannot demonstrate duplicate-identity rejection or authoritative transition deduplication.

At no point does the client partially apply an unknown protocol version. Policy metadata must equal `ROOM_POLICIES[roomMode]`; a server-provided capacity is descriptive, not trusted.

## Room Policy and Transactional Mutations

### Deterministic Team Assignment

```typescript
function chooseTeam(policy: RoomPolicy, blue: number, orange: number): Team | null {
  const blueAvailable = blue < policy.teamCapacity;
  const orangeAvailable = orange < policy.teamCapacity;
  if (!blueAvailable && !orangeAvailable) return null;
  if (blueAvailable && !orangeAvailable) return 'blue';
  if (!blueAvailable && orangeAvailable) return 'orange';
  return blue <= orange ? 'blue' : 'orange';
}
```

Pending accepted joins are sorted by Stable_Roster_Order and folded one at a time through updated counts. Therefore equal counts always choose Blue, unequal counts choose the smaller team, and every Quick Match prefix differs by at most one player.

### Mutation Protocol

Colyseus callbacks enqueue intents. `AuthoritativeRoomCore` applies them in deterministic receive order at the next safe mutation boundary, before controller commands. Each mutation follows four phases:

1. **Plan:** clone the logical roster view, resolve policy and stable order, calculate team/host/slot effects, and identify required body operations.
2. **Validate:** check identity uniqueness, total/team capacity, phase, host authority, destination team, complete kickoff mapping, and physics readiness.
3. **Prepare resources:** create a body or prepare a removal while the authoritative maps still reference the old state. Any preparation failure disposes temporary Rapier resources.
4. **Commit once:** replace the logical roster, body map, input map, host metadata, occupancy projection, and kickoff assignment as one authoritative transition. Emit one typed success/rejection event.

A rejection executes no commit. For disconnects, the identity is tombstoned immediately for input and snapshot purposes and its body is removed before the next world step and snapshot. A body removal failure is a room-fatal invariant error: snapshots stop, clients receive a room error, and the world is disposed rather than publishing a half-removed roster.

### Quick Match Policy

- Admission cap: 6 total, 3 per team.
- Assignment: deterministic balancing with Blue tie break.
- Start gate: `phase === 'waiting' && blue === 3 && orange === 3`.
- Entering the gate creates exactly one fresh 180-step countdown and closes eligible joins only because capacity is full.
- Before Active_Play, any disconnect removes only that identity/body. If countdown is active, it is cancelled before another fixed step can enter play, remaining steps are cleared, phase returns to `waiting`, and room admission reopens.
- Restoring exactly 3+3 starts a new 180-step countdown; no previous countdown progress is reused.
- During Active_Play, a disconnect removes only that player and car before the next snapshot. Score, timer, ball, remaining cars, assignments, phase, and kickoff epoch remain unchanged.

### Custom Room Policy

- Admission cap: 8 total, 4 per team.
- Assignment: deterministic balancing; if one team is full, choose the available team.
- The first accepted identity is the sole Host.
- Team switching is permitted only in `waiting`, only to the opposite team, and only when the destination has fewer than four players. It mutates only the requesting entry.
- Host start is accepted only in `waiting` with a capacity-valid roster: at least one player, no more than eight total, and no more than four per team. It creates exactly one 180-step countdown.
- A non-Host, invalid phase, or invalid roster yields a typed rejection and no mutation.
- Custom room discovery/admission is closed when the Host starts the countdown; the join service therefore evaluates new Custom participants only while the room is advertised in `waiting`. Existing accepted participants remain represented through countdown and play.
- If the Host disconnects before Active_Play, the earliest remaining Stable_Roster_Order entry becomes the sole Host. During countdown, the remaining countdown value is preserved.
- Any pre-active disconnect releases its slot and car before the next join or switch. The final disconnect clears roster, host, occupancy, body/input maps, and kickoff assignments and returns the room to its empty state.

## Kickoff Slot Service

### Slot Definition and Mirroring

`shared/src/geometry/kickoff-slots.ts` contains exactly four canonical Blue transforms indexed `0..3`. Their coordinates are finite configuration, not claims of exact Rocket League proximity. Orange slot `i` is derived rather than authored independently:

```text
positionOrange(i) = (-positionBlue(i).x, positionBlue(i).y, -positionBlue(i).z)
rotationOrange(i) = yaw(PI) * rotationBlue(i)
```

For every slot, its transformed Local_Forward_Axis must point from the slot position toward arena center within one degree. Slot validation uses the active car-collider hypothesis to construct oriented boxes and rejects the entire slot table if any pair intersects, any slot lies outside playable collision space, or any team lacks four slots.

### Assignment Algorithm

```typescript
function assignKickoffSlots(roster: readonly RosterEntry[]): KickoffAssignmentMap {
  const result = new Map<string, KickoffAssignment>();
  for (const team of ['blue', 'orange'] as const) {
    const ordered = roster.filter((entry) => entry.team === team).sort(stableRosterCompare);
    ordered.forEach((entry, index) => result.set(entry.sessionId, slotFor(team, index)));
  }
  validateCompleteBijection(result, roster);
  validateUniqueSpawn(result);
  return result;
}
```

The service builds a complete replacement map off to the side. It never moves a car until every current roster identity has exactly one same-team slot and the full cross-team set is non-overlapping. If roster identity, team, or stable order changes, the prior complete assignment remains active until a valid replacement exists. If none can be built, the room stays out of Active_Play and reports an invariant failure.

An unchanged roster reuses the preceding assignment during post-goal reset. Reset sets all car and ball linear/angular velocities to zero and sets every car boost to 33 before countdown. Exact Rocket League kickoff-proximity selection may remain deferred in a Hackathon Staging Build, but `FeatureStatusRecord` must say so; deterministic unique spawn is never deferred.

## Authoritative Fixed-Step Simulation

### Coordinate and Axis Conventions

- Units are meters, kilograms, seconds, radians, and SI-derived forces/impulses.
- World X spans field width, world Y is up, and world Z spans field length.
- Arena center is `(0,0,0)`; floor is `y = 0`; ceiling is `y = 20.44`.
- Blue defends the negative-Z goal; Orange defends the positive-Z goal.
- Car local axes are Forward `+Z`, Right `+X`, Roof `+Y`, and Down `-Y`, transformed by the authoritative quaternion.
- Surface-relative control uses the deterministic confirmed support normal. Local roof remains the jump actuation axis; for grounded control the orientation/alignment system keeps it consistent with the confirmed surface normal.

### Per-Step Ordering

Every emitted fixed step uses exactly this order:

1. Drain planned room mutations in deterministic order; finalize removals before inputs or snapshots.
2. Capture the phase at the start of the step and derive control and physics gates. Ended_State bypasses input processing and `world.step()` permanently. Countdown_State and Goal_Reset_State disable gameplay actuation; an overtime countdown additionally preserves kickoff transforms and zero velocities without stepping Rapier.
3. Validate each latest input component only when the control gate is open. Use the last validated finite value for a non-finite component, otherwise its defined neutral fallback. Consume disabled-phase edge sequences without actuation so held controls cannot fire when play resumes.
4. Restore any non-finite body state from its last finite bounded state or a defined finite fallback.
5. Query support rays along each car's Local_Down_Axis and calculate one confirmed support result for grounding behavior only.
6. In Stable_Roster_Order, update jump/flip state, calculate boost demand, and produce controller commands from the same pre-step world state.
7. Apply controller impulses, forces, and bounded angular targets to Rapier. Do not synthesize contacts.
8. Execute `world.step()` exactly once only when active regulation or active overtime gameplay permits physics.
9. Read Rapier contacts and body states; apply finite recovery and global linear/angular speed caps without adding scripted ball spin.
10. Gather same-step pad candidates and at most one swept goal-line crossing from previous/current ball centers. Arena support contacts never participate in match-clock resolution.
11. Resolve pad contention in Stable_Roster_Order. During regulation, decrement the integer regulation-step counter and apply a same-step valid goal exactly once before either the above-zero win evaluation or Hard_Regulation_Cutoff comparison. During overtime, apply the first valid goal exactly once and resolve it terminally.
12. Commit one atomic transition. A non-winning above-zero goal enters Goal_Reset_State; a winning above-zero goal, unequal hard cutoff, or overtime goal enters Ended_State; a tied hard cutoff performs deterministic kickoff restoration and enters a fresh 180-step overtime countdown.
13. When Hard_Regulation_Cutoff or any terminal transition commits, return a halt signal to the scheduler. The scheduler executes no remaining substep from that callback as regulation gameplay; future overtime-countdown steps are frozen and future Ended steps bypass controls and physics.
14. Project final body, inventory, scores, winner, terminal result, and transition event ID into internal `GameState` for diagnostics and snapshot building.

The scheduler may execute zero to five such steps per callback. Snapshot due state is checked outside the substep loop. `NETCODE` supplies the nominal approximately 33-millisecond target and a configurable finite non-negative scheduling tolerance; neither value changes `world.timestep`, substep count, or simulation time. Scheduler tests evaluate due decisions within admissible callback timing rather than treating network delivery as an exact wall-clock guarantee. Regulation uses exactly 18,000 completed Active_Play steps unless an earlier above-zero goal satisfies the confirmed target and margin. A hard-cutoff halt leaves no queued step classified as regulation and proves that no later regulation input or Rapier step can execute; a later callback may only advance the frozen overtime countdown or observe Ended_State.

### Controller Commands Versus Collision Emergence

The scripted controller owns deliberate actuation: throttle acceleration, braking/reverse policy, boost acceleration, lateral grip, steering curvature, powerslide multipliers, jump impulses/hold force, flip actuation, and air angular targets. Rapier owns gravity integration, collision detection, contact impulses, frictional contact response, rebounds, and car-to-ball angular transfer.

Controller planning never writes a collision result, ball transform, or score. After `world.step`, finite/speed recovery may scale an invalid or over-bound vector, but it preserves the Rapier-produced direction whenever finite. The ball receives no extra scripted angular impulse after contact.

### Scripted Driving Equations

Let `dt = 1/60`, `F`, `R`, and `U` be authoritative local forward/right/roof unit vectors, `v` linear velocity, `vf = dot(v,F)`, and `vl = dot(v,R)`.

#### Throttle

The registry supplies an evidence-labelled, non-increasing `Throttle_Acceleration_Curve` `A(s)` over non-negative speed, with starting target speed `Vt = 14.1 m/s`:

```text
athrottle = max(throttle, 0) * A(max(vf, 0))
Jthrottle = mass * athrottle * dt * F
A(s) > 0 for 0 <= s < Vt
A(s) = 0 for s >= Vt
A(s2) <= A(s1) when 0 <= s1 < s2 < Vt
```

No curve sample values are finalized here. The registry validator requires finite samples, increasing speed keys, non-negative/non-increasing acceleration, and a finite validated range. Reverse and braking remain separately bounded controller behavior and cannot bypass the global speed or finite-output invariants.

#### Boost and Speed Limit

When boost is held during Active_Play and inventory is positive, the controller adds exactly `9.91666 m/s^2` along full local `F`, including while airborne:

```text
aboostVector = 9.91666 * F
consumptionPerStep = min(inventory, 33.3 * dt)
```

Throttle and boost commands are projected so they cannot add velocity beyond `Car_Max_Speed = 23 m/s`. A post-Rapier safety bound caps car linear speed to `23.05 m/s` and angular speed to `5.5 rad/s`; this safety cap covers contact impulses without redefining the contact itself.

#### Lateral Grip and Powerslide

```text
alpha(g) = 1 - exp(-g * dt)
deltaVl = -vl * alpha(g)
Jgrip = mass * deltaVl * R
```

The validated registry must guarantee `0 < gPowerslide < gNormal`. With no new lateral contact impulse, each response strictly moves nonzero `|vl|` toward zero. Steering uses a speed-curvature curve `C(|vf|)`:

```text
curvatureNormal = steer * C(|vf|)
curvatureSlide  = steer * C(|vf|) * powerslideCurvatureMultiplier
omegaTarget = curvature * vf * confirmedSurfaceNormal
```

The powerslide multiplier must be finite and greater than one, preserving the sign of steering. Curve samples and multipliers remain unverified until harness/browser approval; the design defines their relationships, not final values.

A validated aerodynamic drag hypothesis, when nonzero, produces a vector opposite velocity:

```text
Fdrag = -normalize(v) * D(|v|)
```

`D` and all drag parameters are unverified, finite, range-checked, and incapable of returning a non-finite value.

### Jump, Flip, and Air State

Each car owns:

```typescript
interface JumpControllerState {
  lastConsumedJumpSequence: number;
  firstJumpAcceptedAtStep: number | null;
  firstJumpHeld: boolean;
  secondJumpAvailable: boolean;
  activeFlipStartedAtStep: number | null;
  activeFlipDirection: readonly [number, number] | null;
}
```

- A new grounded edge applies a `2.91667 m/s` velocity change along Local_Roof exactly once.
- While the same first-jump control remains held and elapsed simulation time is below the unverified Jump_Hold duration, apply its finite configured force along Local_Roof. Release or expiry stops it.
- A second edge at elapsed time `<= 1.25` seconds is accepted once. Below the configured directional deadzone it applies a bounded second jump; at/above the deadzone it starts one directional flip.
- A directional flip actuates for no more than the unverified `0.65`-second starting window.
- A late, stale, or already-consumed edge is still recorded as consumed but applies no actuation and does not move the original window start.
- Valid ground support stops hold/flip actuation and resets jump availability. Dynamic cars, ball, sensors, or disabled surfaces never reset it.
- Air pitch, yaw, and roll map to Local_Right, Local_Roof, and Local_Forward respectively. Combined angular speed is capped at `5.5 rad/s`.

### Local-Down Grounding

`GroundingSystem` transforms at least four distinct configured contact points by the current body transform and casts rays along `-Local_Roof`. Contact-point placement, ray distance, and normal-angle threshold are unverified registry entries with finite inclusive ranges; this design does not assign their final values.

A support hit is eligible only when it is:

- a fixed, non-sensor Arena collider;
- tagged as an enabled `ValidGroundSurface` for the active feature status;
- inside the configured distance and normal-angle range.

Eligible hits are sorted by contact-point index then collider handle. Their finite normals are combined using a deterministic normalized equal-weight sum; an invalid or zero sum falls back to the first valid sorted normal. No accepted hit means airborne for that step, with no traction, steering, or jump reset inherited from an earlier step.

Core Ground Surfaces are floor, floor-to-wall ramp, and solid goal-interior surfaces. A Hackathon Staging Build may enable only Core surfaces and must list walls, horizontal corner transitions, wall-to-ceiling transitions, and ceiling as deferred. It may not claim Full_Surface_Driving. The Mechanics Fidelity Release enables and validates all Core and Advanced surfaces with surface-relative traction, steering, and jump behavior.

## Arena, Ball, and Goal Design

### Shared Metric Geometry

`ArenaGeometrySpec` remains the semantic metric input, and one deeply immutable resolved geometry contract is the only operational source for server collision and client authoritative boundary rendering. Neither consumer may independently rebuild dimensions, sample curves, infer corner endpoints, or read legacy `ARENA.*` values for authoritative surfaces.

| Dimension | Value |
|---|---:|
| Inside width (X) | `81.92 m` |
| Inside length (Z) | `102.4 m` |
| Inside ceiling height (Y) | `20.44 m` |
| Goal-line planes | `z = -51.2 m` and `z = +51.2 m` |
| Horizontal corner cut | four `45 degree`, `11.52 m` axis-retreat transitions |
| Floor-wall transition rise and run | `2.56 m` and `2.56 m` |
| Wall-ceiling transition rise and run | `2.56 m` and `2.56 m` |
| Goal opening | centered, `17.86 m` wide and `6.43 m` high |
| Goal depth | `8.8 m` beyond each goal-line plane; back planes at `z = -60 m` and `z = +60 m` |

These values preserve the existing metric field and goal contract. The refinement changes how lower and upper transitions are resolved and presented; it does not change field extents, goal-line position, opening dimensions, corner retreat, ceiling height, or goal depth.

#### Original Enclosed-Stadium Direction

The visual target is interpreted as mood and spatial composition only, not as an asset source. Rocket Arena becomes an original enclosed civic sky-stadium built from procedural geometry: a symmetric chamfered/octagonal rectangular footprint, rounded vertical play profile, transparent containment, recessed goals, legible team halves, and an exterior event venue visible through the shell. It must not reproduce Rocket League logos, wordmarks, vehicle silhouettes, ball panels, stadium textures, sponsor marks, or proprietary assets.

The playable enclosure has three deliberately separate layers:

1. **Authoritative shell:** floor, curved lower transitions, side and end walls, exact 45-degree corner cuts, curved upper transitions, ceiling, goal openings, and closed goal interiors. These surfaces are collision-critical and come only from the resolved shared contract.
2. **Gameplay-aligned presentation:** striped turf, Blue/Orange half tint, halfway line, center circle and kickoff mark, mirrored goal/penalty-area accents, boost-pad rings, transparent hex treatment, and goal lighting. These elements have no collision, but their anchors come from resolved shell surfaces or the room-pinned boost-pad descriptors rather than duplicated coordinates.
3. **Exterior stadium world:** grandstands, deterministic crowd color, floodlight banks, flags, structural arches, catwalks, scoreboards, and a low-detail city skyline. Every exterior element is outside the authoritative shell, has no Rapier collider, is excluded from containment and geometry fingerprints, and cannot visually masquerade as a playable surface.

Blue owns the negative-Z half and Orange owns the positive-Z half. Team tint, goal glow, crowd accents, flags, and mirrored field markings reinforce this orientation without recoloring the neutral ball or obscuring white gameplay lines. The goals read as recessed illuminated tunnels, not flat nets: the exact rectangular mouth opens into the existing `8.8 m` solid floor/side/roof/back volume, with team-color ribs and a procedural hex grid placed on the matching interior surfaces.

The field uses an original procedural cut-grass treatment with a deterministic even number of alternating bands mirrored around midfield. A neutral halfway line, center circle, center spot, and restrained mirrored goal-area/penalty accents sit a few millimeters above the floor as non-colliding overlays or use polygon offset; they do not change the floor plane. Large and delivered Small boost-pad visuals use the same stable IDs and positions as their authoritative pad sensors. A deferred pad has no decorative placeholder that could imply collectability.

The exterior preserves Rocket Arena's current industrial-event character while making it read as a complete stadium. Tiered stands follow the chamfered footprint outside the transparent shell. Crowd/seat colors mix neutral dark values with deterministic Blue and Orange sections. Reusable structural arches span outside the roof; floodlight banks hang from those arches and keep the existing bounded light budget. Original Rocket Arena flags and segmented `ROCKET ARENA` scoreboards use only project-owned geometric lettering and simple launch/orbit motifs. Beyond the stands, instanced low-poly towers and emissive window patterns form a city skyline; the skyline is atmosphere and never contributes collision, occlusion-critical gameplay geometry, or authoritative scale.

#### One Resolved Primitive Contract

`shared/src/geometry/arena-collision.ts` is evolved in place rather than supplemented by a second arena table. `resolveArenaGeometry(ARENA_GEOMETRY_SPEC)` returns `ResolvedArenaGeometry`; the current `ARENA_COLLISION_GEOMETRY` export may remain as a temporary compatibility alias to the same frozen object while consumers migrate. After resolution, both `server/src/physics/arena.ts` and `client/src/renderer/arena.ts` receive that exact contract. `ArenaGeometrySpec` is not consumed directly by either builder.

```typescript
interface ResolvedArenaGeometry {
  readonly identity: Readonly<{
    readonly sourceVersion: number;
    readonly primitiveSchemaVersion: number;
    readonly fingerprint: string;
  }>;
  readonly units: 'meters';
  readonly bounds: Readonly<{
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  }>;
  readonly profiles: Readonly<{
    readonly floorWall: ResolvedSegmentedProfile;
    readonly wallCeiling: ResolvedSegmentedProfile;
  }>;
  readonly goals: readonly ResolvedGoalRegion[];
  readonly surfaces: readonly ResolvedArenaSurface[];
  readonly primitives: readonly ResolvedArenaBoundaryPrimitive[];
  readonly seams: readonly ResolvedArenaSeam[];
}

interface ResolvedArenaBoundaryPrimitive {
  readonly id: string;
  readonly surfaceId: string;
  readonly mirroredPrimitiveId: string | null;
  readonly region: 'field' | 'blue-goal' | 'orange-goal';
  readonly semanticKind:
    | 'floor'
    | 'lower-transition'
    | 'wall'
    | 'corner-cut'
    | 'upper-transition'
    | 'ceiling'
    | 'goal-interior';
  readonly collision:
    | Readonly<{ readonly shape: 'cuboid'; readonly halfExtents: Vec3; readonly transform: Transform }>
    | Readonly<{ readonly shape: 'convex-hull'; readonly vertices: readonly Vec3[] }>;
  readonly inwardSurface: Readonly<{
    readonly positions: readonly Vec3[];
    readonly indices: readonly number[];
    readonly normals: readonly Vec3[];
    readonly uvs: readonly Vec2[];
    readonly seamIds: readonly string[];
  }>;
  readonly materialRole: ArenaBoundaryMaterialRole;
}
```

The resolver creates collision shape data and the inward visible surface together from one canonical set of samples. Rapier consumes `primitive.collision`; Three.js consumes `primitive.inwardSurface` and `materialRole`. The client never reverse-engineers a Rapier collider and never creates authoritative wall, ramp, corner, ceiling, or goal coordinates from presentation constants. The geometry fingerprint covers canonical bounds, profiles, goal regions, surface IDs, primitive collision data, inward-surface positions/indices, and seam topology. It excludes colors, crowd layout, lighting, and other decoration. Canonical serialization uses stable key/ID order, finite normalized quaternions, normalized negative zero, and a documented numeric precision before hashing.

All arrays and nested records are deeply frozen. Primitive and surface IDs are unique and stable. Each collision-critical semantic surface appears in at least one primitive and each primitive references one known surface. Startup fails before accepting a player when resolution, finiteness, topology, mirror, seam, or fingerprint validation fails. The room pins the resolved identity; snapshot geometry metadata and client acceptance continue to use the same version/fingerprint handshake defined by the active-geometry bugfix addendum.

#### Deterministic Curved Transitions and Mirroring

The horizontal footprint remains the exact symmetric octagonal rectangle required by the four straight `45 degree` corner cuts. Each corner endpoint retreats `11.52 m` from the nominal rectangular corner on both axes. The resolver may subdivide a cut co-linearly for paneling, but no subdivision may bow inside or outside the authoritative 45-degree plane.

The rounded feel comes from deterministic segmented quarter-ellipse profiles on every lower and upper boundary, including the 45-degree corner strips. Both use the existing `2.56 m` run and `2.56 m` rise and exactly eight equal-angle segments. Eight segments keep the maximum circular chord deviation below `0.013 m`, safely inside the `0.05 m` visual/collision tolerance while keeping Rapier primitive count bounded.

For `i = 0..8`, let `theta_i = i * PI / 16`:

```text
floorWall(i):
  outward = 2.56 * sin(theta_i)
  up      = 2.56 * (1 - cos(theta_i))

wallCeiling(i):
  inward = 2.56 * (1 - cos(theta_i))
  up     = 2.56 * sin(theta_i)
```

The lower profile begins tangent to the field floor and ends tangent to the vertical wall at `y = 2.56 m`. The upper profile begins tangent to that wall at `y = 20.44 - 2.56 m` and ends tangent to the ceiling at `y = 20.44 m`. Each adjacent sample pair is extruded along its side, end, or corner boundary into one closed static convex prism, with shell thickness extruded away from playable space. Rapier therefore receives bounded convex pieces rather than a runtime-generated concave triangle mesh. Three.js uses the identical inward sample strip and indices; smooth vertex normals may visually blend facets, but visual smoothing never moves a vertex or changes collision.

One canonical quadrant and the Blue goal-end description are authored; all counterparts are derived. `mirrorX([x,y,z]) = [-x,y,z]` produces west/east counterparts and `mirrorZ([x,y,z]) = [x,y,-z]` produces Blue/Orange counterparts. A reflection reverses triangle winding and normal direction exactly once. Mirrored primitive IDs, surface IDs, seam IDs, goal ownership, and material roles are validated as reciprocal pairs. The resolver never samples each side independently, preventing floating-point drift between mirrored halves.

Every boundary junction receives a stable seam ID. Adjacent primitives must resolve the same world-space edge endpoints after mirroring; floor-to-lower-transition, lower-transition-to-wall, wall-to-upper-transition, upper-transition-to-ceiling, side-to-corner, end-to-corner, goal-jamb, goal-roof, and goal-back seams are all explicit. The only intentional aperture in the field shell is either exact goal mouth. No decorative frame closes that aperture in collision, and no transparent panel spans it.

#### Authoritative Boundary Rendering

`client/src/renderer/arena.ts` builds three named roots once: `arena-authoritative-boundaries`, `arena-gameplay-overlays`, and `arena-exterior-presentation`.

- **Authoritative boundaries:** create indexed `BufferGeometry` directly from resolved inward surfaces. Opaque floor/lower-transition pieces and transparent wall/upper-transition/ceiling panels group by material role. Recessed goal floors, sides, roofs, and backs use the exact goal-region descriptors. Polygon offset or render ordering resolves coplanar artifacts; authoritative vertices are not nudged away from collision.
- **Transparent hex shell:** side/end walls, corner cuts, upper transitions, ceiling, and goal containment use a project-owned procedural hex-line shader or one reusable indexed hex overlay parameterized by descriptor UVs. Hex density and opacity are finite bounded visual constants. Cell count never creates one `Object3D` per hex, transparent surfaces use depth-write-disabled stable ordering, and the number of transparent batches is fixed by material roles rather than arena size or frame count.
- **Gameplay overlays:** turf bands, markings, team washes, and pad visuals are generated from immutable layout descriptors and built once. White markings retain contrast over both team tints. Pad geometry is instanced by pad kind and active state; animation changes instance attributes or uniforms, never geometry allocation.
- **Exterior presentation:** stands, crowd units/seats, floodlight panels, flags, arches, skyline towers, and window lights use shared geometries/materials and `InstancedMesh` where repeated. Exterior objects are positioned from read-only arena anchors plus visual offsets, not included in `ResolvedArenaGeometry.primitives`, and never registered with Rapier.

Materials are selected through a small `ArenaBoundaryMaterialRole` registry rather than created per primitive. Team-neutral structure, transparent containment, Blue goal, Orange goal, turf, markings, and emissive lighting each reuse one material instance where their render state matches. Static matrices are finalized at construction, frustum culling bounds are computed once, and disposal owns every geometry/material exactly once. Arena construction performs no fetch and uses no imported model or image texture.

No arena subsystem allocates geometry, material, typed vertex arrays, or scene nodes per frame. Runtime changes are limited to bounded uniforms, light intensity, pad instance state, crowd/flag shader phase, and visibility. Transparent shell and skyline objects do not cast shadows; the existing one-shadow-caster lighting budget and bounded accent lights remain. This keeps the visual target compatible with six/eight-car rendering and the existing interpolation/audio frame loop.

#### Collision-Critical and Decorative Ownership

| Layer | Shared source | Server ownership | Client ownership |
|---|---|---|---|
| Floor, lower transition, walls, corner cuts, upper transition, ceiling | `ResolvedArenaGeometry.primitives` | Static Rapier colliders and surface metadata | Matching authoritative inward-surface meshes and hex/opaque material roles |
| Goal mouth and solid goal floor/sides/roof/back | `ResolvedArenaGeometry.goals` and primitives | Closed goal-interior collision; mouth remains open | Recessed tunnel surfaces, original frame/ribs, and team treatment aligned to the same descriptors |
| Turf, center/halfway/goal-area markings | Geometry bounds plus immutable presentation layout | None | Non-colliding procedural overlays |
| Boost pad location and kind | Room-pinned boost-pad descriptors | Sensor and pickup state | Instanced pad ring/model at the same ID/transform |
| Grandstands, crowd, lights, flags, arches, scoreboards, skyline | Presentation constants anchored outside resolved bounds | None | Decorative `arena-exterior-presentation` only |

A client material or decorative layout change does not require a physics migration. A boundary vertex, profile, seam, opening, or goal-region change does: it changes the geometry fingerprint and requires server and client support in the same compatible build. The runtime cutover may not accept players while one consumer uses legacy `ARENA` boundaries and the other uses resolved metric primitives.

#### Task 6.1 and 6.2 Implementation Contract

**Task 6.1 — Rapier shell:** extend the existing `arena-collision.ts` resolver rather than adding a second geometry module. Replace the current linear lower/upper profile output with the eight-segment profile above, emit reciprocal mirrors and seam records, retain exact metric/goal values, and make `createArenaColliders(world, resolvedGeometry)` a pure primitive adapter plus semantic registration. It must create no hidden legacy wall, sensor, or fallback perimeter. The metric harness compares every actual Rapier collider with the resolved primitive table, exercises seams and goal apertures, proves solid goal interiors and closed containment at `60 m/s`, and frees the world in `finally`.

**Task 6.2 — Three.js boundaries and stadium:** remove authoritative reads of legacy `ARENA.*` from `client/src/renderer/arena.ts`. Build the authoritative group solely from the same resolved primitive object used by Task 6.1, then add gameplay overlays and exterior presentation as separately named groups. Preserve the incumbent reusable/instanced stadium systems where compatible, but reshape them around the metric chamfered footprint and the original visual direction above. World-space tests compare each rendered authoritative primitive ID, seam edge, inward plane, and goal extent with its resolved collision counterpart; no corresponding point or plane may differ by more than `0.05 m`.

Tasks 6.1 and 6.2 are one compatibility cutover for boundary identity even if reviewed as separate code changes. Property 24's phrase “derived from `ArenaGeometrySpec`” means derivation through this one resolver and frozen primitive contract, never separate server/client reconstruction. The broader active-geometry placement certificate and snapshot publication rules remain those in the bugfix addendum.

#### Arena Validation and Visual Proof

The arena increment adds or extends these checks without replacing existing mechanics regressions:

1. **Descriptor parity:** shared tests verify deep immutability, stable fingerprinting, finite unique IDs, complete semantic-surface coverage, deterministic repeated resolution, material-role validity, and exact parity between canonical collision and inward visible surface data.
2. **Mirror invariants:** every east/west and Blue/Orange primitive, profile sample, seam, goal region, field marking, and pad anchor has the required reflected counterpart with corrected winding and unchanged dimensions.
3. **Closed containment:** Rapier harnesses launch the CCD ball at up to `Ball_Max_Speed` toward floor, every lower/upper profile segment, straight wall, chamfered corner, ceiling, end wall, goal back, goal side, and multi-surface seam. The ball remains in the field or the corresponding closed goal interior and cannot escape through segment joins.
4. **Goal contract:** ray, sweep, and contact cases prove both exact centered openings remain unobstructed, outside-mouth end walls remain solid, and each recessed goal floor, side, roof, and back closes at the required depth.
5. **Seam coverage:** a topology test pairs every declared seam edge, rejects gaps/overlaps above numeric epsilon, and permits unmatched edges only where the topology explicitly identifies a goal aperture. Focused ball sweeps cross floor/ramp, ramp/wall, wall/upper-transition, upper-transition/ceiling, side/corner, corner/end, and goal-jamb seams without tunnelling or snagging on duplicate inward faces.
6. **Resolved visual/collision alignment:** a client test resolves each authoritative mesh's world-space vertices and planes after transforms and compares them by primitive/surface/seam ID with the shared contract and Rapier fingerprints. Maximum separation is `0.05 m`; expected construction should normally be coincident apart from numeric conversion.
7. **Rendering budget:** construction tests require reusable materials/geometries, instancing for repeated exterior and pad objects, a fixed descriptor-bounded transparent batch count, no object-per-hex expansion, and no arena geometry/material creation during repeated render updates.
8. **Browser and screenshot proof:** deterministic browser fixtures capture (a) high overview, (b) midfield at car height, (c) chamfered corner with lower ramp, (d) goal mouth looking into the recessed tunnel, and (e) wall-to-ceiling/roof view. Assertions cover one shared geometry identity, metric bounds, Blue/Orange mirroring, turf and markings, pad alignment, transparent hex containment, visible seam continuity, original Rocket Arena branding, and exterior stands/lights/flags/arches/skyline. Each view retains a screenshot and diagnostic JSON; the run requires zero unexpected page exceptions and zero Rocket Arena error-level console messages.

Screenshot review is presentation evidence, not the containment oracle. Descriptor, world-space, and Rapier tests prove geometry correctness; browser views prove that the original enclosed-stadium interpretation is legible and that decorative elements remain outside the playable shell.

### Car and Ball Bodies

- Cars use a plain Rapier cuboid independent of `client/src/renderer/car.ts`, mass exactly `150 kg`, and CCD enabled.
- Required starting collider hypotheses are length `1.18 m`, width `0.84 m`, and height `0.36 m`, each as a separate unverified entry. They are not final values and must have finite approved ranges before release.
- The ball is a CCD-enabled sphere with radius exactly `0.9125 m`, mass exactly `25 kg`, and restitution exactly `0.60`.
- The mass ratio is therefore exactly `6:1`.
- `Ball_Linear_Damping_Hypothesis` is the Rapier linear damping value and is constrained to inclusive `[0,0.2] s^-1`.
- Post-step ball linear speed is bounded to `60.05 m/s` and angular speed to `6 rad/s`.
- If a ball velocity vector becomes non-finite, only that affected vector is restored from the most recent finite bounded value or zero. Other finite ball fields are preserved.

### Swept Goal-Line Detection

A goal detector stores the previous authoritative ball center and per-plane “armed from field side” state for the current kickoff epoch. For a goal plane `z = zg`, a crossing candidate requires previous center on the field side and current center strictly beyond the plane. It computes the segment intersection:

```text
t = (zg - previous.z) / (current.z - previous.z)
intersection = previous + t * (current - previous)
valid opening = abs(intersection.x) <= 17.86 / 2
             && 0 <= intersection.y <= 6.43
```

A valid crossing increments the team opposing the crossed goal exactly once. A center on the plane, a segment remaining field-side, a teleport/current point inside the goal without a preceding armed field-side sample, or a crossing outside the opening preserves both scores. After a goal, the detector suppresses every additional crossing until a new kickoff epoch enters Active_Play with the ball field-side of both planes.

This swept test avoids tunnelling-related missed goals while leaving wall/post/crossbar collision to Rapier. It uses the ball center, not the sphere edge, exactly as required.

### Match Events Are Independent of Grounding

Arena surface metadata remains available to `GroundingSystem` for traction, steering, orientation, and jump reset only. Ball contacts with floors, ramps, walls, cars, or the ceiling do not produce match-flow events and do not delay or trigger regulation resolution. `MatchFlowReducer` receives only fixed-step clock progress, an optional already-validated goal event, roster/start events, and deterministic reset results.

## Match Flow State Machine

```text
waiting
  Quick 3+3 ------------------------------> countdown(initial, 180)
  Custom valid Host start ----------------> countdown(initial, 180)

countdown(initial/post-goal)
  Quick loses full roster before play ----> waiting
  remaining reaches zero -----------------> playing(regulation)

countdown(overtime)
  remaining reaches zero -----------------> overtime(untimed active play)

playing(regulation, steps remaining > 0)
  valid goal; updated score >= 6 and lead >= 2
                                            -> ended(regulation-target-and-margin)
  valid goal; target or margin not met ----> goal-reset
  first step reaching zero; score same-step goal first
      unequal resulting scores ------------> ended(hard-regulation-cutoff)
      equal resulting scores --------------> deterministic reset -> countdown(overtime, 180)

goal-reset
  configured duration expires ------------> deterministic reset -> countdown(post-goal, 180)

overtime(untimed active play)
  no valid goal ---------------------------> overtime
  first valid goal ------------------------> ended(overtime-goal)

ended
  every later callback --------------------> ended (controls and physics inactive)
```

### Fixed-Step Transition Rules

1. When the initial regulation Countdown_State begins, initialize `regulationStepsRemaining = 18_000`, equivalent to exactly 300 seconds. Countdown steps do not decrement regulation.
2. Each regulation Active_Play step executes at most one Rapier step, then computes `nextSteps = max(0, previousSteps - 1)` and `nextSeconds = nextSteps / 60`.
3. A valid goal from that Rapier step is represented by one unique goal event and applied exactly once before any match-flow decision:

```text
updatedScorerScore = previousScorerScore + 1
updatedOpponentScore = previousOpponentScore
aboveZeroWin = updatedScorerScore >= Regulation_Goal_Target
            && updatedScorerScore - updatedOpponentScore >= Regulation_Win_Margin
Regulation_Goal_Target = 6
Regulation_Win_Margin = 2
```

There is no match-rule score cap; representable high scores continue to increment normally.
4. If `nextSteps > 0` and a goal occurred, `aboveZeroWin === true` commits Ended_State directly with the scoring team as winner and emits one terminal goal result containing the updated scores. Otherwise it commits Goal_Reset_State with the same updated scores and the configured `Regulation_Goal_Reset_Duration`.
5. Goal reset preserves regulation time and scores, disables gameplay controls, and suppresses additional scoring. At expiry it restores deterministic kickoff transforms, zeroes car and ball linear/angular velocities, initializes car boost to 33, and starts a fresh 180-step post-goal countdown.
6. If `nextSteps === 0`, Hard_Regulation_Cutoff is resolved inside that same Fixed_Step after the optional goal has been applied. The above-zero target and margin are not consulted at cutoff.
7. Unequal resulting scores at Hard_Regulation_Cutoff commit Ended_State immediately with the leading team as winner, including scores below 6 or leads of one. Equal resulting scores atomically preserve the tie, restore deterministic kickoff entities with zero velocities, and start a fresh 180-step overtime countdown.
8. Hard_Regulation_Cutoff sets `regulationCutoffResolved` and returns a scheduler halt signal. No later input is processed as regulation, no later Rapier step is executed as regulation, and no additional regulation score event can be accepted.
9. During the overtime countdown, controls remain disabled, Rapier is not stepped, and the deterministic kickoff transforms and zero linear/angular velocities are preserved for all cars and the ball. Active overtime begins only after all 180 countdown steps complete.
10. Active overtime is untimed. Its first valid goal increments the scoring team exactly once and commits Ended_State directly with that team as winner, regardless of either score, target, or margin. It never enters Goal_Reset_State and never starts another countdown.
11. Ended_State ignores all gameplay inputs, skips all car-and-ball physics, suppresses scoring, and preserves the final scores, winner, terminal reason, transforms, and immutable terminal result in every later snapshot.
12. Quick Match and Custom Room use the same `MATCH_RULES` and reducer. Room mode affects capacity/start policy only, never regulation or overtime outcome logic.

The reducer is a pure function over previous state plus one ordered event bundle. It returns the next state, one optional atomic transition record, and a scheduler halt flag, enabling exhaustive reducer tests and scheduler tests without using browser observation as mechanics evidence.

## Boost Inventory and Pad Rollout

### Inventory

Inventory is authoritative floating-point state clamped to `[0,100]`; snapshots may present a rounded UI value but server calculations retain precision. Every kickoff placement initializes 33. During Active_Play, held boost consumes `min(current, 33.3 / 60)` per fixed step and produces proportional acceleration if the final partial step has less inventory than a full-step cost. There is no passive recharge.

### Pad Model

```typescript
type BoostPadKind = 'large' | 'small';

interface BoostPadSpec {
  readonly id: string;
  readonly kind: BoostPadKind;
  readonly position: readonly [number, number, number];
  readonly sensorHalfExtents: readonly [number, number, number];
}

interface BoostPadRuntime {
  readonly active: boolean;
  readonly inactiveUntilStep: number | null;
}
```

Pad positions and sensor hitboxes are separate unverified registry entries with finite arena-bounded ranges; this design intentionally assigns no final coordinates or dimensions.

After each Rapier step, active-pad intersections are grouped by pad ID. Eligible cars are sorted by Stable_Roster_Order, the first receives the grant, and the pad is deactivated once. Large pads grant 100 and reactivate after exactly 600 simulation steps; small pads grant 12 and reactivate after exactly 240 steps. Contacts while inactive grant nothing. At the first step whose simulation index reaches `inactiveUntilStep`, the pad reactivates before contact resolution.

### Staged Delivery

1. `BoostPadStagingMode` first supplies exactly six validated Large pad specs. The feature status records `large: 6/6`, `small: 0/28` (or the actual delivered small count) and cannot claim the Small milestone.
2. Small pads are added in validated layout increments while the status records delivered and deferred counts.
3. The Mechanics Fidelity Release requires exactly six Large and 28 Small pads, all with approved layout/hitbox evidence.

## Client Presentation

### Accepted Snapshot and Entity Lifecycle

`snapshot-validator.ts` validates the complete unknown payload before any state mutation:

- exact supported protocol and policy version;
- room mode and capacities exactly matching shared policy;
- safe non-negative sequence and finite increasing simulation time;
- `cars.length <= totalCapacity` and `<= 8`;
- unique non-empty session IDs and valid teams;
- team counts within policy;
- exactly one Host in non-empty Custom waiting/countdown state where applicable, and no Quick Host;
- finite positions, rotations, velocities, timer, and boost with documented bounds;
- finite nonzero quaternions, normalized in the immutable copy;
- non-negative integer scores and coherent phase/countdown/winner metadata.

After structural validation, the candidate is offered to `SnapshotBuffer`; sequence/time regression still rejects it. Scene reconciliation then prepares new meshes, retained updates, and removals without touching `carMeshes` or the scene. If preparation succeeds, one commit updates buffer, `AcceptedSnapshotStore`, `localState`, and scene ownership. If validation or preparation fails, temporary meshes are disposed and the prior accepted sequence, meshes, HUD, camera, and audio inputs are unchanged.

A valid snapshot creates or updates exactly one mesh per identity and removes every mesh absent from the snapshot. The maximum Custom snapshot therefore presents exactly eight cars. Existing mesh/effect disposal remains mandatory on removal, leave, reconnect, and page cleanup.

### Interpolation and Teleports

The validated snapshot is converted to interpolation entities only after duplicate detection. Existing `SnapshotBuffer` behavior remains:

- greatest 24 accepted sequence values retained;
- 100-millisecond delayed authoritative timeline;
- shortest-path normalized quaternion interpolation;
- teleport threshold handling without interpolation across a kickoff reset;
- no more than 80 milliseconds of extrapolation, then a held bounded result.

Kickoff epoch changes are an explicit teleport boundary in addition to distance detection. Camera and audio motion histories rebase to post-teleport samples and do not infer contact or motion across epochs.

### Cameras

The lobby may retain presentation-only orbit. Before the first Active_Play camera frame, gameplay mode is `ball`.

- **Ball Camera:** look target is the authoritative-interpolated ball. Origin is derived from the authoritative-interpolated local-car anchor using registry framing values, retaining local-car context.
- **Car Camera:** a spring follows the authoritative-interpolated local car using configured distance, height, stiffness, damping, look-ahead, and FOV.
- A monotonic `cameraToggleSequence` causes exactly one local transition. Repeated heartbeats or held keys do not retrigger it.
- Position, rotation, and FOV are clamped to finite configured ranges.
- A kickoff epoch change preserves the selected mode, discards pre-teleport spring history, and seeds targets from post-teleport samples.
- Camera updates never send or mutate server state.

Ball-camera framing and every spring default remain unverified registry entries. A proposed camera configuration is accepted all-or-nothing only when every value is finite and inside its inclusive range; otherwise the last validated complete configuration remains active. If none exists, the checked-in finite unverified starting configuration is used and release status remains unverified.

### Off-Screen Ball Indicator

`ball-indicator.ts` projects the interpolated ball into clip space. If it is in front of the camera and inside the viewport, the indicator is hidden. Otherwise, a camera-space direction is normalized and intersected with an inset viewport rectangle so the entire indicator stays visible. A behind-camera vector is reflected consistently before edge intersection. The indicator communicates direction with an arrow/shape and accessible text, not color alone.

### Lobby, HUD, and Accessibility

The lobby and HUD subscribe to `AcceptedSnapshotStore`; they do not register independent raw `state-sync` parsers.

- Quick Match displays total `n/6` and `Blue b/3`, `Orange o/3`.
- Custom Room displays total `n/8` and each team `/4`, Host identity, switch availability, and typed rejection messages.
- Active HUD displays authoritative scores, regulation time or untimed overtime state, local boost, and camera mode. Ended_State retains the final score, winner, and terminal reason while gameplay presentation remains frozen.
- Countdown uses a screen-center transient derived from authoritative remaining steps (`3`, `2`, `1`, then transition). A non-winning above-zero goal displays scoring team and updated score throughout Goal_Reset_State, then the fresh kickoff countdown replaces it.
- A target-and-margin regulation win displays one terminal notice containing scorer, updated final score, and winner. An unequal hard cutoff displays `0:00`, final score, leading team, and Ended_State. A tied hard cutoff displays the tied score and fresh overtime countdown. The first overtime goal displays scorer, updated final score, and winner.
- Persistent score, timer, boost, camera, and ball-direction elements stay outside the central 20% width/height safe zone.
- Each authoritative reducer commit increments one `latestTransition.eventId`. A dedicated `role="status"`, `aria-live="polite"`, `aria-atomic="true"` region and the visual notice reducer consume that ID once. When one transition contains both a goal and terminal outcome, they produce one composite screen-center notice and one live-region update containing every player-visible result rather than separate goal/end announcements.
- Accessible names/current values mirror accepted capacities, counts, score, timer state, boost, and camera mode. Blue and Orange use text/shape as well as color. Required contrast is at least `4.5:1`.
- At `1280 x 720` and larger, layout tests require every persistent/transient element inside the viewport and pairwise non-overlapping.
- Existing audio mute/volume names, keyboard operation, focus indication, and persistence remain unchanged.

### Audio and Stadium Integration

Audio continues to observe only accepted snapshots for discrete events and interpolated entities for continuous engine/boost presentation. Increasing car count requires no authority change; event tracking iterates the accepted car collection. Discrete match audio is keyed by the same authoritative `latestTransition.eventId` used by HUD notices: repeated snapshots cannot replay a goal, cutoff, overtime-entry, or terminal cue, and a terminal goal is consumed as one composite transition even if its configured sound contains layered goal-and-win elements. Rejected snapshots cannot trigger sound. Ended_State and the overtime countdown stop continuous engine/boost actuation because authoritative gameplay and motion are frozen.

The stadium renderer uses the shared arena geometry for authoritative surfaces and retains existing materials, lighting, stands, trusses, scoreboards, and procedural presentation. Core or Advanced collision status affects support classification, not whether the visible stadium may show a wall; feature status must accurately describe driveable surfaces.

## Versioned Tuning Registry and Evidence Model

### Registry Entry

```typescript
export type TuningClassification =
  | 'confirmed-starting-target'
  | 'unverified-hypothesis';

export interface FiniteRange {
  readonly min: number;
  readonly max: number;
}

export interface TuningEntry<T> {
  readonly id: string;
  readonly registryVersion: number;
  readonly unit: string;
  readonly classification: TuningClassification;
  readonly value: T;
  readonly validatedRange: FiniteRange | readonly FiniteRange[];
  readonly affects: readonly ('authority' | 'camera' | 'hud' | 'perceived-control')[];
  readonly evidenceId: string | null;
  readonly approvalId: string | null;
}
```

Structured curve entries contain ordered sample arrays and per-axis ranges rather than being flattened into unrelated numbers. Every room pins an immutable registry version/hash at creation so an ephemeral development tune cannot change another room midway through a match.

### Required Classification

All numeric targets not explicitly called hypotheses are `confirmed-starting-target`. The following remain `unverified-hypothesis` until approved:

- separate car collider length, width, and height starting hypotheses;
- throttle-curve provenance and target-speed provenance;
- aerodynamic drag model/parameters;
- ball linear damping in `[0,0.2] s^-1`;
- Jump_Hold force/duration, 1.25-second Second_Jump_Window, and 0.65-second Flip_Actuation_Window;
- steering curvature samples and powerslide relationship parameters;
- support contact points, ray distance, and support-normal threshold;
- boost-pad positions and hitbox dimensions;
- Ball Camera framing and Car Camera spring distance, height, stiffness, damping, look-ahead, and FOV;
- Regulation_Goal_Reset_Duration, initialized to 2 seconds.

The required starting values are acceptance seeds, not proof of final Rocket League fidelity.

### Range Constraints and Tuning Procedure

The checked-in registry data supplies concrete finite lower/value/upper triples, but this design intentionally does not declare unverified triples as final. The schema enforces these relational constraints and evidence procedures:

| Hypothesis group | Mandatory finite range invariants | Deterministic evidence | Browser evidence when applicable |
|---|---|---|---|
| Collider length/width/height | `0 < min <= value <= max`; dimensions remain independently adjustable and compatible with plain-box construction | body mass/CCD checks, stable contacts, kickoff OBB separation, arena containment, and speed-cap harnesses | visual/collision debug overlay confirms the independent collider is understandable without changing the render mesh |
| Throttle and steering curves | speed keys strictly increase inside the supported speed domain; outputs are finite; throttle output is non-negative/non-increasing; powerslide grip and curvature ordering remains valid | at least 100 generated speeds/inputs, measured acceleration, turn radius, lateral decay, and frame-partition comparisons | controlled driving captures approve perceived steering and powerslide response |
| Drag and ball damping | drag response is non-negative and exactly opposes nonzero velocity; damping remains inside required `[0,0.2] s^-1` | coast-down, rebound, rolling, finite recovery, and repeated-seed Rapier traces | player-perceived coast and ball-motion captures are attached before approval |
| Jump hold, second-jump, and flip windows | finite non-negative force/duration ranges; lower bound never exceeds value or upper bound | boundary cases immediately before, at, and after each window plus angular/speed bounds | jump and flip responsiveness is reviewed from recorded browser runs |
| Support rays/contact points | at least four distinct finite points inside the collider footprint; positive finite cast distance; normal threshold is a valid finite angle | floor/ramp/goal Core surfaces, adjacent-normal determinism, misses/dynamic exclusions, then every Advanced transition for final release | wall/ceiling transition control is required before Full_Surface_Driving approval |
| Pad positions/hitboxes | positions are finite and inside the intended arena surface layout; every hitbox extent is positive and finite; IDs are unique | collection boundary, non-overlap/intentional overlap audit, stable contention, and 600/240-step respawn traces | pad visibility and pickup feedback are reviewed at representative viewport sizes |
| Ball/Car camera configuration | distance/height/stiffness/damping/look-ahead/FOV ranges are finite and internally ordered; FOV remains a valid perspective angle | pure spring stability, finite-output, teleport rebase, and frame-partition tests | motion readability, ball tracking, safe-zone interaction, and discomfort review are mandatory |
| Goal reset duration | `0 < min <= value <= max`; conversion to fixed-step progress is deterministic | exact 120-step proof for the 2-second starting hypothesis and generated alternative durations | goal notice-to-countdown handoff is verified in a browser |

Tuning follows one repeatable loop: record source/provenance and candidate range, validate the complete registry proposal, run deterministic seeded harnesses, run browser evidence for perceived behavior, compare results to the prior version, and create an approval record. A failed stage leaves the prior registry version active. Enabling Advanced surfaces or a fidelity claim is impossible through tuning alone; the corresponding feature status and release evidence must also change.

### Validation and Atomic Updates

A proposal is rejected in full when any value or bound is non-finite, a lower bound exceeds an upper bound, a value falls outside its range, a curve violates ordering/monotonicity, or related fields violate a cross-entry invariant. Rejection preserves the previous registry value, range, version, evidence link, and room snapshots.

Development overrides use the same validator and are room-scoped, ephemeral, and automatically mark the running build non-release-eligible. Confirmed targets cannot become release-eligible after a change without an evidence record and rationale.

### Evidence and Status

```typescript
interface ReferenceEvidenceRecord {
  id: string;
  sourceIdentity: string;
  sourceVersionOrAccessDate: string;
  originalValueAndUnit: string;
  conversion: string;
  resultingValueAndRange: string;
  approvalStatus: 'pending' | 'approved' | 'rejected';
}

interface TuningApprovalRecord {
  id: string;
  tuningId: string;
  deterministicHarnessEvidence: readonly string[];
  browserEvidence: readonly string[];
  approvedBy: string;
  approvedAt: string;
}

interface FeatureStatusRecord {
  buildKind: 'hackathon-staging' | 'mechanics-fidelity-release';
  delivered: readonly string[];
  deferred: readonly string[];
  unverifiedTuningIds: readonly string[];
}
```

The release gate requires an approved reference and approval record for every hypothesis, deterministic harness evidence for authoritative mechanics, and browser tuning evidence for camera/HUD/player-perceived control. A staging build lists unverified hypotheses and deferred advanced surfaces, exact kickoff-proximity selection, demolition, or incomplete small pads; it cannot call itself the Mechanics Fidelity Release.

## Error Handling

| Condition | Required response |
|---|---|
| Room policy or requested capacity differs from shared mapping | Reject room creation before state/roster initialization; preserve all existing rooms. |
| Duplicate join or total/team capacity violation | Return typed rejection; do not mutate roster, host, phase, score, timer, ball, cars, inputs, or countdown. |
| Invalid Custom switch/start | Return precondition-specific rejection; preserve the complete room state. |
| Physics not ready during eligible admission | Queue the intent behind the readiness barrier or reject with `physics-not-ready`; never poll with per-player wall-clock intervals or expose a player without a body. |
| Body preparation failure | Dispose temporary resources and reject before logical commit. |
| Body removal invariant failure | Stop snapshots, notify room failure, and dispose the world rather than publish split logical/physics state. |
| Shared match-rule configuration differs by room mode or from confirmed 300/6/2 values | Reject initialization before a match starts; retain existing rooms and never run a mode-specific outcome rule. |
| Duplicate or stale goal/transition event ID | Ignore it without incrementing score or replaying HUD/audio; preserve the latest committed transition and terminal result. |
| Hard-cutoff reducer or atomic reset failure | Stop further control and physics processing, publish no partial cutoff snapshot, and fail the room rather than continue regulation past zero. |
| Input received after Hard_Regulation_Cutoff or in Ended_State | Ignore it for gameplay; execute no regulation control or physics work and preserve authoritative terminal state. |
| Non-finite input component | Use last finite validated component or neutral fallback; preserve other validated components. |
| Non-finite body/ball observation | Restore only affected values from last finite bounded state or defined fallback before snapshot. |
| Invalid tuning proposal | Reject the complete proposal and retain prior value/range/evidence/version. |
| Invalid or unsupported snapshot | Increment rejection telemetry; preserve buffer, accepted sequence/state, meshes, camera, HUD, and audio inputs. |
| Mesh preparation failure for an otherwise valid snapshot | Dispose temporary meshes and retain the prior committed presentation; report a client error without partial scene mutation. |
| Snapshot sequence/time regression | Reject through existing buffer semantics. |
| Room leave/reconnect | Clear accepted state, interpolation, meshes, camera spring history, and audio room history idempotently. |
| Rapier world disposal after any harness outcome | Free every created world/body resource in `finally`. |

## Staged Implementation and Migration Plan

Each stage compiles and retains a playable or explicitly labelled staging behavior. No stage requires partially typed snapshots or two independent authoritative loops.

### Stage 1: Shared Policies, Types, and Registry Skeleton

- Add room policies, typed teams/phases/rejections, confirmed shared 300/6/2 match rules, V2 snapshot/input contracts with terminal transition fields, tuning model, and arena specification.
- Keep current room behavior behind compatibility adapters while removing new code's dependency on `MATCH.MAX_PLAYERS`/`TEAM_SIZE`.
- Add pure policy, registry-validation, serialization, and migration decoder tests.
- Build/typecheck all workspaces.

### Stage 2: Transactional Roster Core

- Add `AuthoritativeRoomCore`, `RoomMutationService`, and deterministic team assignment.
- Convert `ArenaRoom` and `CustomRoom` to policy adapters while temporarily calling existing physics/scoring through the core.
- Deliver Quick 6/3 gates/cancellation and Custom 8/4 host/switch behavior.
- Add room-service tests for every acceptance/rejection and unchanged-state assertion.

### Stage 3: V2 Eight-Car Transport and Client Atomicity

- Add shared snapshot builder/validator, emit V2 terminal-aware transitions, and keep temporary V1 client decoding.
- Refactor `state-listener.ts` to prepare/commit and support eight meshes.
- Add maximum-capacity round-trip, duplicate, over-capacity, finite-value, disconnect, terminal score/winner coherence, transition deduplication, and lifecycle tests.
- Preserve current interpolation tests unchanged, then add kickoff-epoch boundary cases.

### Stage 4: Kickoff and Simulation-Time Phases

- Add four mirrored slots, complete-map validation, stable assignment caching, and reset integration.
- Move countdowns and goal reset from `setInterval` into fixed steps.
- Introduce the full match-state representation, integer regulation-step clock, confirmed target/margin fields, and terminal transition records while retaining old arena/controller behavior behind adapters.
- Verify 180-step countdown, cancellation, host disconnect preservation, deterministic reset mapping, and frozen overtime-countdown/Ended gates.

### Stage 5: Metric Bodies, Core Grounding, and Scripted Controller

- Switch gravity, car/ball masses, collider form, CCD, and finite recovery.
- Split `car.ts` into body/controller/grounding modules.
- Implement throttle constraints, boost, steering, grip/powerslide, jump/flip/air state, and Core Ground Surfaces using unverified registry seeds.
- Keep Advanced surfaces disabled and mark them deferred in staging status.
- Run generated pure-controller tests plus Rapier Core-surface harnesses.

### Stage 6: Metric Arena, Goals, and Finalized Match Flow

- Rebuild server collision and client authoritative boundaries from `ArenaGeometrySpec` while keeping surface contacts exclusive to physics and grounding behavior.
- Replace goal occupancy with swept crossing and one-event-per-goal identity.
- Implement above-zero 6-goal/2-goal-margin evaluation without a score cap, atomic same-step Hard_Regulation_Cutoff, tied overtime kickoff, untimed first-goal-wins overtime, and Ended freezing.
- Re-run stadium alignment, closed-volume, ball-speed, goal-tunnel, reducer, 18,000-step cutoff, no-post-cutoff-simulation, terminal snapshot, and transition-deduplication harnesses.

### Stage 7: Boost Pads

- Add inventory precision and six Large pads with simulation-time respawns and deterministic contention.
- Expose delivered/deferred counts in status.
- Add all 28 Small pads only after layout/hitbox validation; do not mark the milestone complete earlier.

### Stage 8: Camera, Lobby, HUD, and Baseline Integration

- Add Ball/Car gameplay camera modes, camera edge sequence, off-screen indicator, expanded occupancy UI, notices, and live-region event keys.
- Connect lobby/HUD/audio to `AcceptedSnapshotStore`.
- Validate 6-client and 8-client browser flows, camera toggles, indicator, accessibility, audio, stadium baselines, non-winning/winning goal notices, hard-cutoff/tied-overtime presentation, and terminal transition deduplication. Browser checks remain presentation evidence; reducer and scheduler suites prove cutoff ordering and the absence of later regulation simulation.

### Stage 9: Full Surface Driving and Release Evidence

- Tune and enable Advanced Ground Surfaces only after deterministic transition harnesses and browser control evidence pass.
- Complete reference and approval records for every hypothesis.
- Run the release-gate tool; a staging build with any deferral or unverified hypothesis remains explicitly non-final.

## Testing Strategy

### Test Layers

| Layer | Purpose | Representative modules |
|---|---|---|
| Pure unit tests | Policies, assignment, mutation plans, above-zero score reducer, hard-cutoff reducer, overtime reducer, goal crossing, curves, edge consumption, tuning validation, projection math | `shared` and `server/src/systems/*.test.ts`, `client/tests/*.test.ts` |
| Generated property tests | Universal behavior across large input spaces with deterministic seed | room rosters, snapshots, controller math, scheduler partitions, uncapped regulation scores, cutoff event bundles, overtime goals, pads |
| Rapier harnesses | Body construction, CCD, support surfaces, collision emergence, closed arena, ball bounds, same-step goal extraction, resource cleanup | extend `server/src/physics/test-*.ts` |
| Serialization tests | V2 round trip, maximum capacity, unique identity, finite fields, migration behavior | shared/client tests |
| Room integration tests | Colyseus command routing, typed rejection, disconnect timing, authoritative snapshots, terminal score/winner coherence, and scheduler halt behavior | new server room tests |
| Browser proof | Player-visible lobby/HUD/camera/accessibility/audio/stadium and finalized match-result presentation flows; never mechanics timing proof | new non-watch Playwright suite |
| Release checks | Registry/evidence/status completeness | `tools/validate-*.ts` |

Generated tests use at least 100 cases, a recorded deterministic seed, and the tag:

```text
Feature: rocket-arena, Property <number>: <property title>
```

The generator records the seed and ordered case index on failure. Re-running with that seed must reproduce the same ordered cases and result. No property test repeatedly invokes an external browser or cloud service; UI and infrastructure behavior use focused example/integration tests.

### Required Validation Matrix

- `npm run typecheck` and `npm run build` for all workspaces.
- Existing fixed-step scheduler, interpolation, input, audio, lobby, procedural-model, and stadium tests.
- All existing Rapier harnesses plus new controller, grounding, arena, goal, boost, and resource-cleanup harnesses.
- Quick Match generated join/disconnect sequences around occupancy six.
- Custom generated joins/switches/host changes around total eight/team four.
- Every capacity-valid roster ordering for kickoff bijection and overlap.
- At least 100 generated finite/non-finite controller and tuning cases.
- Exactly 180 countdown steps and, at the starting reset hypothesis, exactly 120 goal-reset steps with controls disabled.
- Confirmed shared match configuration checks for 300 seconds, target 6, margin 2, identical Quick/Custom rules, and no score clamp.
- Above-zero reducer examples: direct wins at `6-4`, `7-5`, and `8-6`; goal reset at `5-3`, `6-5`, `6-6`, and `7-6`; plus at least 100 generated representable high-score outcomes on both sides of the target-and-margin predicate.
- Hard-cutoff tests that apply a same-step goal once before comparison, end unequal scores regardless of target/margin, reset tied scores into a fresh frozen 180-step overtime countdown, and execute no later regulation controls or Rapier step.
- Exactly 18,000 regulation Active_Play Fixed_Steps and no earlier cutoff for matches without an earlier target-and-margin win.
- Untimed overtime tests that remain active without a goal and transition directly to Ended on the first valid goal without reset or another countdown.
- Terminal snapshot and presentation-reducer tests requiring coherent final score/winner/reason plus one HUD notice, one live-region update, and one audio consumption per authoritative transition ID.
- Browser scenarios with six Quick clients and eight Custom clients, plus rejected seventh/ninth clients and presentation-only regulation, cutoff, overtime, and terminal-result assertions.
- Zero uncaught page exceptions and zero Rocket Arena error-level console messages.

### Browser Proof Scenarios

Browser automation remains presentation-focused and consumes deterministic server fixtures or reducer-driven room state:

- Quick and Custom above-zero winning goals show the updated final score, scoring team, winner, and immediate Ended_State in one composite notice/live update.
- `6-5` Quick and `7-6` Custom results show Goal_Reset_State with the updated score, then a fresh `3`, `2`, `1` kickoff countdown; no winner is presented.
- Unequal hard cutoffs below target or by one goal show `0:00`, the leading team, final score, and Ended_State on every later frame.
- Tied hard cutoffs show deterministic kickoff presentation and a fresh overtime countdown, followed by an untimed overtime label.
- The first overtime goal shows the updated final score, scoring team, winner, and immediate Ended_State without a reset/countdown notice.
- Repeated snapshots of any goal/cutoff/overtime/terminal transition produce no duplicate screen-center notice, live-region update, or audio event.

The browser suite does not claim to prove exact Fixed_Step count, same-step ordering, or post-cutoff simulation suppression. Pure reducer, scheduler, room integration, and Rapier harness tests provide that evidence.

### Property Versus Example/Integration Balance

Pure policies, transformations, reducers, serializers, controller equations, and validators use property tests. Exact DOM labels, one room-creation log, Web Audio behavior, visual alignment, contrast, process startup, and real Colyseus/Rapier wiring use example, smoke, integration, or browser tests. This avoids pretending that repeated random external-service executions provide stronger evidence than focused integration checks.

## Correctness Properties

*A correctness property is a universally quantified, executable statement over valid generated inputs. Properties below are consolidated so each protects a distinct failure class; exact constants and player-visible examples remain in the complementary validation matrix.*

### Property 1: Mode policy and capacity invariants

For all valid room states, Quick Match contains at most six identities and at most three per team, Custom Room contains at most eight identities and at most four per team, the room's advertised/applied capacities equal its immutable mode policy, and every accepted Quick assignment leaves the team-count difference no greater than one.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.8, 3.6, 3.7, 4.7, 4.8**

### Property 2: Deterministic team assignment

For all capacity-valid join sequences processed in Stable_Roster_Order, equal team counts assign the next identity to Blue, unequal counts assign it to the smaller team, a single available Custom team receives the identity, and repeated evaluation from identical policy, roster, and sequence returns identical assignments.

**Validates: Requirements 3.3, 3.4, 3.5, 3.6, 4.4, 4.5, 4.6**

### Property 3: Atomic roster mutations

For all join, leave, switch, and start requests, an accepted request performs exactly its specified add, remove, team change, or phase change, while every rejected request preserves roster, teams, occupancy, Host, phase, countdown, score, timer, ball, and car states bit-for-bit.

**Validates: Requirements 2.10, 3.1, 3.2, 3.8, 3.11, 3.14, 3.15, 4.1, 4.3, 4.9, 4.10, 4.11, 4.12, 4.14, 4.15, 4.18, 4.19, 4.20**

### Property 4: Quick Match countdown gate and cancellation

For all Quick Match pre-active roster sequences, a fresh 180-step countdown exists if and only if Waiting_State first reaches exactly three Blue and three Orange; dropping below six during countdown cancels it before Active_Play, and restoring 3-versus-3 creates a new full 180-step countdown rather than resuming prior progress.

**Validates: Requirements 3.9, 3.10, 3.12, 3.13, 18.13**

### Property 5: Custom Host authority and succession

For all Custom Room waiting/countdown states, only the sole Host with a Capacity_Valid_Roster can create one countdown; when that Host disconnects and players remain, the earliest Stable_Roster_Order identity becomes the sole Host, and an in-progress countdown retains its remaining value.

**Validates: Requirements 4.2, 4.13, 4.14, 4.15, 4.16, 4.17**

### Property 6: Deterministic kickoff-slot bijection and unique spawn

For all Capacity_Valid_Rosters, mapping team-local Stable_Roster_Order index `i` to same-team slot `i` assigns every roster identity exactly once, assigns no outsider or duplicate slot, mirrors corresponding teams across arena center, faces every car toward center within one degree, produces non-intersecting car-collider volumes, and returns identical transforms for identical inputs and unchanged post-goal rosters.

**Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 18.16**

### Property 7: Snapshot round trip and identity completeness

For all valid rooms containing `N` connected identities, where `0 <= N <= room capacity`, the produced snapshot has exactly `N` cars, includes each connected identity exactly once and no other identity, contains only finite bounded numeric fields, has a strictly increasing sequence, and survives serialize-deserialize with every identity-associated team, transform, velocity, boost, and Host value preserved; for all terminal snapshots, final scores, winner, terminal reason, and terminal event ID also round-trip unchanged and remain coherent.

**Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 13.14, 13.19, 13.25, 18.17**

### Property 8: Atomic client snapshot acceptance and rejection

For all received snapshots, a valid candidate commits exactly one rendered car per distinct identity and removes identities absent from the candidate, while any duplicate-identity, over-capacity, non-finite, policy-mismatched, or structurally malformed candidate leaves the previous accepted sequence, buffer, local state, rendered cars, HUD, camera, and audio inputs unchanged.

**Validates: Requirements 6.9, 6.10, 6.11, 6.12**

### Property 9: Throttle curve monotonicity and input scaling

For all finite speeds `0 <= s1 < s2 < Throttle_Target_Speed`, full-throttle acceleration at `s2` is no greater than at `s1`; for all normalized throttle magnitudes at one sub-target speed, acceleration is finite and non-decreasing with magnitude, zero magnitude maps to zero, and speed at or above target without boost receives zero positive throttle acceleration.

**Validates: Requirements 8.4, 8.5, 8.6, 8.7, 18.1, 18.2**

### Property 10: Finite authoritative output and body speed bounds

For all fixed steps and all finite or non-finite input/tuning edge cases, every exposed transform, velocity, angular velocity, force, impulse, timer, and inventory value is finite; car speed is at most `Car_Max_Speed + 0.05 m/s`, car angular speed at most `5.5 rad/s`, ball speed at most `Ball_Max_Speed + 0.05 m/s`, and ball angular speed at most `6 rad/s` after recovery.

**Validates: Requirements 7.8, 7.9, 7.10, 7.11, 7.12, 8.10, 9.16, 11.4, 11.5, 11.11, 18.11**

### Property 11: Grip and powerslide ordering

For all grounded states with equal nonzero speed and steering input, powerslide applies a lower finite lateral-grip response and a greater finite turn-curvature magnitude than normal steering without changing direction; with no new lateral contact impulse, either mode reduces absolute lateral speed on every fixed step.

**Validates: Requirements 8.11, 8.12, 8.13, 8.14, 8.15, 8.16, 18.3, 18.4**

### Property 12: Input-edge idempotence and bounded jump windows

For all jump and camera edge sequences, an unconsumed eligible edge actuates exactly once, any repeated or non-increasing sequence actuates zero additional times, a late or unavailable jump edge is consumed without moving active window start times, and jump-hold/flip actuation ends no later than its configured window.

**Validates: Requirements 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 15.2, 15.3, 18.5, 18.6, 19.12**

### Property 13: Local-down grounding classification

For all car orientations and configured contact-point sets, support queries originate from at least four distinct points along Local_Down; only enabled static non-sensor hits within validated distance/angle bounds contribute to a deterministic finite confirmed normal, while all-miss, dynamic, sensor, or disabled-surface cases classify the car airborne and perform no grounded traction, steering, or jump reset.

**Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.11, 10.12, 18.19**

### Property 14: Fixed-step kickoff and reset timing

For all kickoff countdowns, Active_Play begins after exactly 180 completed Fixed_Steps and never earlier; for all non-winning above-zero goal resets configured to the 2-second starting hypothesis, exactly 120 Fixed_Steps elapse before deterministic zero-velocity restoration and the subsequent fresh countdown, while updated scores and regulation time are preserved and gameplay controls remain disabled.

**Validates: Requirements 13.3, 13.5, 13.6, 13.7, 13.8, 13.15, 13.16, 18.22, 18.23**

### Property 15: Goal-line crossing semantics

For all Active_Play ball-center segments in one kickoff epoch, only a field-side-to-strictly-beyond segment whose plane intersection lies inside the centered Goal_Opening increments the opposing score exactly once; centers on the plane, non-crossings, unarmed goal-interior positions, and outside-opening crossings preserve both scores, and scoring remains suppressed until the next armed kickoff epoch.

**Validates: Requirements 12.11, 12.12, 12.13, 12.14, 18.9**

### Property 16: Fixed-step partition determinism

For all pairs of finite non-negative callback-delta partitions with equal accepted elapsed time that trigger neither delta clamping nor excess-step dropping, identical initial states and input commands produce equal fixed-step counts and authoritative state components differing by no more than `1e-5`; negative or non-finite deltas contribute zero and every callback executes at most five steps with a remainder in `[0, 1/60)`.

**Validates: Requirements 1.4, 1.5, 1.6, 1.7, 18.10**

### Property 17: Boost inventory and pad lifecycle

For all inventory values, active-play boost sequences, pad states, and same-step contact sets, inventory stays in `[0,100]`, kickoff initializes 33, consumption equals available `33.3 * dt` without passive recharge, active Large/Small pads grant 100/12 once, inactive pads grant zero, respawn occurs after exactly 600/240 simulation steps, and the earliest eligible Stable_Roster_Order car wins contention.

**Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.8, 14.9, 14.10, 14.11, 14.12, 14.13, 14.14, 18.20**

### Property 18: Above-zero regulation goals obey target and margin without a score cap

For all Quick Match and Custom Room regulation states with time remaining above zero and all representable non-negative scores, applying a valid goal increments the scoring team exactly once without clamping its score; the next phase is Ended_State with one terminal result if and only if the updated scoring-team score is at least 6 and its lead is at least 2, otherwise the next phase is Goal_Reset_State with the updated scores preserved. The boundary corpus includes winning `6-4`, `7-5`, and `8-6`, non-winning `5-3`, `6-5`, `6-6`, and `7-6`, and generated high scores with leads below, equal to, and above 2.

**Validates: Requirements 13.9, 13.10, 13.11, 13.12, 13.13, 13.14, 13.15, 13.16, 18.27, 18.28, 18.29, 18.30, 18.31, 18.37**

### Property 19: Server authority preservation

For all client messages containing valid controls plus any forged transform, contact, inventory, score, team, or phase value, the server uses only the controls for subsequent fixed-step command planning and the next snapshot preserves server-derived authoritative values against every forged field.

**Validates: Requirements 1.1, 1.2, 1.3, 18.18**

### Property 20: Tuning proposal atomicity and traceability

For all tuning proposals, the registry accepts a complete proposal only when every value and inclusive range is finite, ordered, internally consistent, and classification-complete; rejection preserves the prior registry, while any accepted evidence-backed change links its evidence/approval and retains the prior value and range in history.

**Validates: Requirements 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 17.11, 17.12, 17.13, 17.14, 17.15, 17.16**

### Property 21: Camera edge isolation and finite spring output

For all accepted camera input streams and interpolated car/ball samples, gameplay starts in Ball Camera, each new toggle edge changes mode once, camera mode never mutates server state, every position/rotation/FOV output is finite and within the accepted configuration, and a kickoff teleport preserves mode while rebasing without cross-teleport interpolation.

**Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 15.11**

### Property 22: HUD projection and transition-announcement determinism

For all finite camera/viewport inputs, the pure ball-indicator projection returns hidden for an in-viewport ball and a finite viewport-contained edge direction for an off-screen ball; for all accepted authoritative transition streams, the presentation reducer emits exactly one composite notice and one live-region update per unique countdown, non-winning goal, terminal regulation goal, hard cutoff, overtime entry, or overtime terminal-goal event ID, includes every player-visible outcome from that transition, and emits none for repeated snapshots of the same ID.

**Validates: Requirements 16.6, 16.7, 16.10, 16.11, 16.16, 16.17, 16.18, 16.19, 16.20**

### Property 23: Physics construction and collision-owned ball spin

For all constructed authoritative worlds and dynamic bodies, gravity is `(0,-6.5,0)`, every car and ball has CCD enabled, cars use a plain independent box at 150 kg, the ball uses radius `0.9125 m`, mass 25 kg and restitution `0.60`, the mass ratio is `6:1`, damping stays in `[0,0.2]`, and ball contacts receive no scripted angular impulse beyond Rapier output and bounded recovery.

**Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 11.1, 11.2, 11.3, 11.6, 11.7, 11.8, 11.9, 11.10, 18.7**

### Property 24: Arena geometry closure and renderer alignment

For all boundary primitives derived from `ArenaGeometrySpec`, their extents implement the exact width, length, height, corner cuts, ramps, goal opening, and goal depth; together they form a closed collision volume with solid goal interiors, keep a ball at or below Ball_Max_Speed contained except through a valid goal opening, and place the corresponding visible boundary within `0.05 m`.

**Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.15, 18.8**

### Property 25: Bounded transport and interpolation baseline

For all valid scheduler configurations and room sizes from zero through eight cars, the nominal snapshot target and finite non-negative scheduling tolerance remain independent of the exact `1/60` Fixed_Step; for all accepted increasing snapshot streams, adding beyond capacity retains the 24 greatest accepted sequence values, delayed sampling uses a 100-millisecond timeline and shortest-path normalized quaternion interpolation, and any render time beyond the newest sample extrapolates no farther than 80 milliseconds before holding a finite result.

**Validates: Requirements 1.8, 1.9, 1.10, 1.11, 1.12, 6.8**

### Property 26: Hard regulation cutoff is same-step, atomic, and final for regulation

For all Quick Match and Custom Room regulation executions that do not end earlier through the above-zero target-and-margin condition, Hard_Regulation_Cutoff occurs after exactly 18,000 regulation Active_Play Fixed_Steps and never earlier; any valid goal produced by the 18,000th Rapier step is applied exactly once before score comparison, unequal resulting scores enter Ended_State with the leader regardless of target or margin, equal resulting scores atomically restore kickoff state and enter a fresh 180-step overtime countdown, and no later input or Rapier step is processed as regulation.

**Validates: Requirements 13.1, 13.2, 13.17, 13.18, 13.19, 13.20, 13.21, 13.22, 13.23, 18.21, 18.32, 18.33, 18.34, 18.37, 18.38**

### Property 27: First overtime goal wins immediately

For all Quick Match and Custom Room overtime states and all representable scores or margins, any execution without a valid goal remains in untimed overtime, while the first valid goal increments only the scoring team exactly once and transitions directly to Ended_State with that team as winner, without Goal_Reset_State or another countdown and without consulting Regulation_Goal_Target or Regulation_Win_Margin.

**Validates: Requirements 13.24, 13.25, 18.35, 18.36, 18.37**

### Property 28: Bug Condition - Active geometry placement containment

_For any_ represented-car placement candidate in Waiting_State, an initial kickoff, or a post-goal kickoff where validation, live Rapier collision, and the authoritative visible perimeter do not have the same active geometry identity, or where the candidate's full authoritative collider is not contained by that active geometry, the fixed system SHALL reject the complete candidate before exposure, preserve the preceding valid authoritative state, and publish no snapshot containing the invalid placement. For every accepted candidate, all three consumers SHALL report one identical active geometry identity and every represented full collider SHALL be contained before the first corresponding snapshot, throughout the frozen countdown, and in the first Active_Play sample.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**

These requirement references are from `bugfix.md`.

### Property 29: Preservation - Deterministic placement, authority, and match flow

_For any_ capacity-valid Quick Match or Custom Room input where validation, collision, presentation, and the complete proposed collider set already agree with the active geometry, the fixed system SHALL produce the same Stable_Roster_Order identity-to-slot mapping, team-facing orientation, non-overlap result, kickoff reuse, authoritative ownership, atomic rejection behavior, snapshot ordering, and valid countdown/match-flow transitions as the original behavior, except for the required replacement of legacy boundary geometry by the approved shared active geometry.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

These requirement references are from `bugfix.md`.

## Property Reflection

The reflected set removes logical overlap while retaining distinct failure boundaries:

- Capacity constants, team limits, and post-assignment balance are one invariant (Property 1); assignment choice remains separate because an invariant alone does not prove deterministic identity placement (Property 2).
- All accepted/rejected roster operations share one atomicity property (Property 3), while Quick countdown behavior and Custom Host succession retain separate temporal properties (Properties 4 and 5).
- Kickoff distinctness, one-to-one mapping, mirroring, repeatability, and reset stability are one complete bijection property (Property 6), rather than separate three-player/four-player examples.
- Snapshot identity completeness and serialization round trip are consolidated in Property 7; malformed-client atomicity remains Property 8 because a valid server round trip does not imply safe rejection.
- Finite recovery and all body caps are consolidated in Property 10. Throttle shape and grip/powerslide relationships stay separate because each needs different generators and mathematical oracles.
- Jump and camera edge deduplication share monotonic-sequence semantics (Property 12), while camera transform bounds remain in Property 21.
- Goal crossing semantics (Property 15), above-zero target-and-margin outcomes (Property 18), atomic hard cutoff (Property 26), and sudden-death overtime (Property 27) remain separate because each has a distinct input domain and oracle. This prevents the cutoff rule from accidentally inheriting target/margin logic and prevents overtime from entering reset behavior.
- Active-geometry mismatch and placement containment are one fail-closed property (Property 28); deterministic valid-input preservation remains separate (Property 29) so the fix cannot silently change roster mapping, authority, or match flow.
- Exact configuration declarations, logging, DOM layout/contrast, non-color visual treatment, browser text, audio output, release evidence presence, and process/resource integration remain smoke/example/integration tests where generated property cases would not add meaningful confidence. Property 22 covers only pure projection and transition deduplication; browser proof verifies presentation, while reducer/scheduler tests prove fixed-step cutoff behavior.

## Bugfix Design Addendum: Active Arena Geometry Consistency

This addendum is the approved design-phase response to `bugfix.md`. It narrows the immediate correction to active-geometry consistency and placement publication while preserving the broader mechanics design, Properties 1-27, completed implementation status, and all unrelated staged work. Within the bugfix workflow, global Property 28 is the Bug Condition property (bugfix-local Property 1) and global Property 29 is the Preservation property (bugfix-local Property 2); the global numbering is retained to avoid renumbering completed work.

### Overview

The defect is eliminated by pinning one immutable `Active_Arena_Geometry` for each authoritative room/world and deriving every authoritative boundary consumer from that object: kickoff and waiting-placement validation, the live Rapier shell, snapshot placement guards, and the client-visible authoritative perimeter. The server publishes the geometry identity with authoritative state; the client accepts room state only when its locally resolved visible geometry has the same identity. No consumer may independently reconstruct authoritative dimensions from legacy `ARENA` constants.

Every join/waiting placement and every initial or post-goal kickoff is prepared as a complete transaction. The transaction resolves the exact car collider dimensions used by Rapier, proves full oriented-collider containment against the active geometry, checks completeness and overlap, captures rollback state, applies all bodies, and commits assignment/epoch/phase state only after every check succeeds. A snapshot publication guard prevents any uncommitted or uncertified placement from reaching clients.

The correction completes the geometry portion of existing unfinished Tasks 6.1 and 6.2 as one compatibility cutover. It does not move the metric slots inward, introduce a second temporary arena definition, or mark either existing task complete during this design phase.

### Glossary

- **Active_Arena_Geometry**: The immutable, validated runtime resolution of `ARENA_GEOMETRY_SPEC` pinned when a room/world is created and supplied by reference to collision, containment, placement, snapshot, and authoritative rendering code.
- **Geometry_Identity**: The pair `{ version, fingerprint }`, where `version` is the shared arena schema/data version and `fingerprint` is a deterministic digest of the canonical resolved authoritative descriptors. A matching version without a matching fingerprint is not considered the same geometry.
- **Resolved_Boundary_Primitive**: A canonical world-space descriptor generated from the active spec and consumed to build either a Rapier collider or the matching authoritative visible mesh; stadium decoration is not an authoritative primitive.
- **Containment_Region**: A named closed placement region derived from the same resolved primitives, normally `field`, with a solid goal interior allowed only when the placement context explicitly names that goal region.
- **Full_Collider_Containment**: Proof that the complete oriented Rapier car cuboid, not only its center or render mesh, lies within one allowed active containment region at the proposed transform.
- **Placement_Transaction**: The prepare/validate/apply/verify/commit operation covering the complete represented roster and all authoritative state affected by a room-entry or kickoff placement.
- **Placement_Certificate**: Immutable evidence bound to a geometry identity, collider dimensions, roster signature, kickoff epoch or waiting-placement generation, and the exact committed transforms.
- **Publication_Guard**: The server-side all-or-nothing check that refuses to build or broadcast a placement-bearing snapshot unless its placement certificate and current authoritative bodies agree.
- **Browser_Placement_Diagnostics**: A deterministic, read-only, test-only projection of accepted authoritative placement data for Playwright; it is absent in production builds and grants no mutation capability.
- **F / F'**: The original mismatched implementation and the corrected active-geometry implementation, respectively.

### Bug Details

#### Confirmed Counterexample

The current source tree contains a concrete geometry split:

- `ARENA_GEOMETRY_SPEC` version 1 has length `102.4 m`, so its field goal-line bounds are `z = -51.2 m` and `z = +51.2 m`.
- Canonical Blue metric kickoff slots use `z = -34 m` and `z = -42 m`; Orange mirrors use `z = +34 m` and `z = +42 m`.
- The currently active legacy shell and visible perimeter read `ARENA.LENGTH = 60 m`, so their end bounds are only `z = -30 m` and `z = +30 m`.

A metric slot at `z = -34` or `z = -42` passes validation against `z +/-51.2` but its center is already beyond the active legacy boundary at `z = -30`, before collider half-extents are considered. The mirrored Orange slots fail identically beyond `z = +30`. This is the confirmed current counterexample, not a hypothetical edge case.

#### Bug Condition

Let a placement exposure candidate include its context, complete roster, proposed transforms, resolved collider dimensions, and the geometry identities used by validation, collision, and authoritative presentation.

**Formal Specification:**

```text
FUNCTION isBugCondition(candidate)
  INPUT: candidate of type PlacementExposureCandidate
  OUTPUT: boolean

  IF candidate.context NOT IN {
       waiting-entry,
       initial-kickoff,
       post-goal-kickoff,
       overtime-kickoff
     } THEN
    RETURN false
  END IF

  identitiesAgree :=
    candidate.validationGeometry.identity = candidate.collisionGeometry.identity
    AND candidate.collisionGeometry.identity = candidate.visibleGeometry.identity

  allContained := FOR EVERY representedCar IN candidate.completeRoster:
    containsFullCollider(
      candidate.collisionGeometry,
      representedCar.authoritativeTransform,
      candidate.resolvedCarCollider,
      candidate.allowedContainmentRegions
    )

  RETURN candidate.exposureRequested
         AND (NOT identitiesAgree OR NOT allContained)
END FUNCTION
```

Equivalently, `C(X) = ExposureRequested(X) AND (GeometryMismatch(X) OR NOT FullyContained(X))`.

#### Examples

- **Confirmed initial/waiting failure:** Blue slot `z = -34` is valid under metric half-length `51.2` but outside the live legacy half-length `30`; the current build can expose the car beyond the wall/perimeter.
- **Confirmed deeper-slot failure:** Blue slot `z = -42` and its Orange mirror are farther outside the legacy shell while still valid under the metric validator.
- **Post-goal failure:** Reusing the same deterministic metric assignment can replace previously valid dynamic body state with out-of-bounds kickoff transforms if reset validation does not use the live shell.
- **Geometry-compatible control case:** A candidate whose full oriented collider fits the active metric field and whose validation/collision/visible identities all match is accepted without changing its deterministic identity-to-slot mapping.
- **Edge case:** A center inside the field is still rejected when the rotated collider support crosses a side, end, ceiling, floor/ramp, or corner-cut plane. Center-only and render-mesh checks are insufficient.

### Expected Behavior

#### Preservation Requirements

**Unchanged Behaviors:**

- Stable_Roster_Order continues to map each team-local identity to the same deterministic same-team slot for identical policy, roster, slot, tuning, and geometry inputs.
- Mirroring, center-facing orientation, complete bijection, full-collider non-overlap, unchanged-roster post-goal reuse, and zeroed kickoff velocities remain unchanged.
- Quick Match retains exact 6/3 capacity, deterministic balancing, exact 3+3 start gating, cancellation, and fresh-countdown rules.
- Custom Room retains 8/4 capacity, Host authority, waiting-only team switches, deterministic Host succession, and countdown preservation rules.
- Server authority, V2 snapshot ordering, client atomic acceptance, interpolation, match timing, score, audio, HUD, camera, and stadium art behavior remain unchanged except where authoritative boundary meshes must move to the approved active geometry.
- Invalid placement continues to be all-or-nothing; the fix strengthens the precondition but does not permit partial body movement, partial roster publication, or fallback assignment.

**Scope:**

All inputs for which `isBugCondition` returns false remain behaviorally equivalent between F and F'. This includes valid contained waiting/kickoff placements, normal roster mutations, non-placement snapshots, controls, active-play physics, scoring, and presentation decoration. Dynamic closed-shell containment remains owned by existing Task 6.1; this bugfix guard must not reinterpret legal wall/goal contacts or replace Rapier collision response.

### Hypothesized Root Cause

The primary cause is confirmed by the current implementation; the remaining items are contributing gaps:

1. **Partially completed metric migration:** Shared metric geometry and metric kickoff slots are complete, while existing Tasks 6.1 and 6.2 are unfinished. `server/src/physics/arena.ts` and `client/src/renderer/arena.ts` still construct authoritative boundaries from legacy `ARENA` values.
2. **Implicit validator geometry:** `DeterministicKickoffAssignmentService` defaults containment to `ARENA_GEOMETRY_SPEC`, so placement validation can silently select metric bounds independently of the world that owns the bodies.
3. **No room-pinned geometry identity:** The room, snapshot, and client acceptance contracts do not currently prove that validation, collision, and visible authoritative boundaries resolved the same geometry version/data.
4. **Structural reset validation only:** `prepareResetToKickoff` validates assignment identity and finite transforms and provides rollback, but it does not validate each full collider against the live world geometry before applying the reset.
5. **Join exposure gap:** Join preparation can create and represent a body from an `initialCarPosition` without a shared full-collider placement certificate tied to the active shell.
6. **Publication gap:** Snapshot construction checks structural, identity, capacity, and numeric invariants but does not fail closed when a newly placed authoritative body lacks active-geometry containment evidence.

### Correctness Properties

The single source of truth remains the consolidated global `## Correctness Properties` section:

- **Property 28 (bugfix-local Property 1):** For every bug-condition input, F' rejects the complete invalid placement, preserves the preceding valid state, and publishes no invalid snapshot; every accepted placement uses one geometry identity and full-collider containment.
- **Property 29 (bugfix-local Property 2):** For every non-bug-condition input, F' preserves deterministic placement, authority, atomicity, and valid match-flow behavior.

The expected-result predicate used by Property 28 is:

```text
FUNCTION expectedBehavior(result)
  INPUT: result of type PlacementExposureResult
  OUTPUT: boolean

  IF result.candidateIsValid THEN
    RETURN result.geometryIdentitiesAgree
           AND result.allRepresentedCollidersContained
           AND result.transactionCommittedExactlyOnce
           AND result.snapshotPublishedOnlyAfterCommit
  END IF

  RETURN result.transactionCommitted = false
         AND result.previousValidAuthoritativeStatePreserved
         AND result.assignmentCachePreserved
         AND result.phaseAndEpochPreserved
         AND result.invalidSnapshotPublished = false
END FUNCTION
```

### Fix Implementation

#### 1. Resolve and Pin One Active Geometry

Add one pure shared resolver that validates `ARENA_GEOMETRY_SPEC` and creates an immutable runtime bundle:

```typescript
interface GeometryIdentity {
  readonly version: number;
  readonly fingerprint: string;
}

interface ActiveArenaGeometry {
  readonly identity: GeometryIdentity;
  readonly bounds: Readonly<{
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  }>;
  readonly boundaryPrimitives: readonly ResolvedBoundaryPrimitive[];
  readonly containmentRegions: readonly ContainmentRegion[];
}
```

The fingerprint is calculated from canonical, ordered authoritative descriptors and is stable across server and client builds. A room resolves this object once before world creation and passes the same instance to:

- `createArenaColliders(world, activeGeometry)`;
- the waiting-position and kickoff assignment services;
- `createCarBody` through the room-pinned collider descriptor;
- `prepareResetToKickoff` / placement transactions;
- `SnapshotBuilder` and its publication guard.

The client resolves the same shared spec for `createArena(scene, activeGeometry)`. Presentation-only stands, lights, scoreboards, atmosphere, and materials may retain visual constants; field, ramps, corners, end/side containment, ceiling, goal mouth, and goal tunnel boundaries may not.

`SnapshotEnvelopeV2` gains required `arenaGeometryVersion` and `arenaGeometryFingerprint` metadata. Client validation compares both fields with the visible authoritative geometry before any accepted-state or scene commit. Missing or mismatched identity rejects the candidate atomically and reports an incompatible-build error rather than rendering a split arena.

#### 2. Use the Actual Rapier Collider for Containment

Resolve car length, width, and height once from the room-pinned tuning snapshot and construct both the Rapier cuboid and containment OBB from that same immutable value object. Render-model dimensions never participate.

For a normalized transform, full containment against an inward plane uses the OBB support radius:

```text
supportRadius(n) =
  abs(dot(n, localRight))   * halfWidth
  + abs(dot(n, localUp))    * halfHeight
  + abs(dot(n, localForward)) * halfLength

containedByPlane = dot(n, center) + supportRadius(n) <= planeLimit + epsilon
```

A field placement must satisfy every floor/ramp, ceiling, side/end, and corner-cut half-space in the active field region. A goal-interior placement is allowed only when its placement context explicitly names that solid goal region and the complete OBB satisfies that region. This bugfix's waiting and kickoff policies allow the field region only. Validation must not use center-only, vertex-only, render-bounds, or legacy rectangular-AABB shortcuts. `epsilon` is one finite named numerical tolerance shared by tests and runtime; it absorbs floating-point normalization only and cannot make a center beyond an authoritative plane valid.

#### 3. Validate Join and Waiting-State Placement Before Representation

A join mutation prepares the logical roster and deterministic team/slot result without changing authoritative maps. It then:

1. derives the candidate waiting transform from the active geometry and stable roster order;
2. validates finite normalized transforms, full-collider containment, complete roster coverage, and non-overlap for the resulting represented set;
3. creates the candidate Rapier body with the same pinned collider dimensions;
4. verifies the created body's transform and shape identity before commit;
5. commits roster, body, input, occupancy, assignment generation, and placement certificate once.

Any validation or resource-preparation failure disposes temporary Rapier resources and rejects the join without exposing the identity. Existing represented cars and the last valid snapshot remain unchanged.

#### 4. Extend Initial and Post-Goal Kickoff Transactions

The existing prepared assignment and prepared reset mechanisms are coordinated into one outer transaction:

1. prepare a complete deterministic assignment without mutating the cache;
2. validate every proposed OBB against the room's `Active_Arena_Geometry` and every pair for non-overlap;
3. capture ball, car, controller, inventory, assignment-cache, phase, epoch, and transition state;
4. apply all car/ball transforms and resets;
5. re-read every resulting body and verify finite state, expected collider identity, exact assigned transform, and containment;
6. commit assignment cache, placement certificate, kickoff epoch, phase/countdown transition, and projected state together.

If steps 1-2 fail, no body moves. If application or verification fails, all captured state is restored and the prepared assignment is aborted. Initial kickoff remains in the preceding valid Waiting_State; post-goal kickoff retains the preceding valid goal-reset state and body state. A rollback failure is room-fatal: stop simulation and snapshots, notify clients, and dispose the world rather than publish uncertain state.

#### 5. Guard Snapshot Publication

`SnapshotBuilder` receives the active geometry and last committed placement certificate. It always validates geometry identity. For Waiting_State, all kickoff countdown kinds, and the first Active_Play snapshot of each kickoff epoch, it additionally re-reads every represented authoritative body and requires:

- exact roster/certificate identity coverage;
- the certified collider dimensions and geometry identity;
- finite current transforms matching the committed frozen placement;
- full-collider containment in the certified region;
- no pair overlap and no partial placement generation.

The candidate is rejected as a whole before sequence advancement or broadcast if any check fails. The server retains its last successfully published snapshot. This targeted guard covers every placement-bearing exposure without redefining dynamic Active_Play collision semantics; ongoing dynamic containment remains the closed-shell responsibility of Task 6.1.

#### 6. Fail Atomically

| Failure | Required result |
|---|---|
| Geometry version/fingerprint mismatch during room initialization | Reject initialization before accepting a roster or creating a world. |
| Waiting/join candidate outside active geometry | Reject the complete join/mutation; dispose temporary body; retain prior roster, bodies, assignments, phase, and published state. |
| Initial/post-goal assignment invalid | Abort before body movement; retain the preceding complete assignment and state. |
| Apply/verification failure with successful rollback | Publish nothing from the failed generation; continue only from the restored valid state. |
| Rollback or active-geometry invariant failure | Quarantine/fail the room, stop snapshots and physics, notify clients, and dispose safely. |
| Snapshot placement certificate missing/stale/mismatched | Do not advance snapshot sequence and do not broadcast a partial or stale candidate. |
| Client geometry identity mismatch | Reject before accepted-state, interpolation, meshes, HUD, camera, or audio mutate. |

#### 7. Preserve Quick and Custom Determinism

Both room modes use the same active geometry resolver, containment service, transaction coordinator, and publication guard. Mode policy remains an input only for capacity, team limits, and start rules. Stable roster sorting and slot indexing remain unchanged, so identical geometry, tuning, policy, roster, and slot inputs produce identical transforms in Quick and Custom. No retry may choose a different slot or reorder identities; a failed candidate preserves the preceding assignment until the same deterministic inputs can pass.

#### 8. Complete Tasks 6.1 and 6.2 as One Migration Slice

The bugfix must not add a legacy clamp, a second `BUGFIX_ARENA` constant, temporary inward slots, or a validator fallback to `ARENA.LENGTH`. Instead:

1. extend the shared spec/resolver so one canonical resolved descriptor set supports Rapier primitives, containment regions, and visible authoritative meshes;
2. complete existing Task 6.1 by switching the production Rapier shell to the pinned active geometry and eliminating authoritative legacy-dimension reads;
3. complete existing Task 6.2 in the same compatible build by switching visible authoritative boundaries to that geometry while preserving surrounding stadium art;
4. add geometry identity to the server/client acceptance handshake and reject mixed builds;
5. switch waiting/kickoff validation and publication guards only to the same pinned object; then remove obsolete authoritative legacy paths.

The runtime cutover is enabled only when collision, validation, snapshot metadata, and visible boundaries all support the same identity. Intermediate commits may compile for review, but no intermediate build may accept players with metric validation and a legacy live shell. Existing Task 6.1/6.2 checkboxes and unrelated task status remain untouched until the later task phase and actual implementation validation.

#### 9. Add Read-Only Test Diagnostics

When both a dedicated test build flag and server test-runtime flag are enabled, the server emits placement diagnostics keyed to a specific snapshot sequence and the client exposes a frozen getter such as `window.__ROCKET_ARENA_TEST__.readPlacement()` only after that snapshot is accepted. The returned value is a deep copy with deterministic Stable_Roster_Order:

```typescript
interface BrowserPlacementDiagnostics {
  readonly diagnosticsVersion: 1;
  readonly acceptedSnapshotSequence: number;
  readonly roomMode: 'quick' | 'custom';
  readonly phase: string;
  readonly countdownKind: string | null;
  readonly kickoffEpoch: number;
  readonly geometry: {
    readonly version: number;
    readonly fingerprint: string;
    readonly bounds: {
      readonly min: readonly [number, number, number];
      readonly max: readonly [number, number, number];
    };
  };
  readonly collider: {
    readonly length: number;
    readonly width: number;
    readonly height: number;
  };
  readonly cars: readonly {
    readonly sessionId: string;
    readonly team: 'blue' | 'orange';
    readonly position: readonly [number, number, number];
    readonly rotation: readonly [number, number, number, number];
    readonly contained: boolean;
  }[];
}
```

Transforms come from the accepted authoritative snapshot, collider dimensions and geometry identity come from the matching server-pinned diagnostic record, and bounds come from the matching active geometry. The API exposes no setters, commands, body handles, mutable references, or alternate state path. Production builds omit the global and test diagnostic transport entirely; production startup rejects an attempt to enable the test runtime flag. If a minimal production-safe identity inspector is retained for support, it is read-only and exposes only protocol/geometry versions, never test controls.

### Testing Strategy

#### Validation Approach

Validation follows the required sequence: expose the counterexample on unfixed code, observe and lock down valid baseline behavior, implement the fix, then rerun the same checks for correction and preservation. Browser evidence proves accepted state and visible alignment; pure and Rapier integration tests prove containment and atomicity.

#### Exploratory Bug Condition Checking

**Goal:** Demonstrate the active mismatch before changing placement behavior and preserve a reproducible counterexample artifact.

**Test Plan:** First add the read-only diagnostic seam without changing geometry selection. Run deterministic Custom and Quick scenarios against the unfixed build. Wait for the first accepted local-car snapshot/render, record active geometry identities/bounds, collider dimensions, and transforms, then assert full containment against the active collision/visible boundary.

**Expected Counterexample:** At least one deterministic identity receives metric slot `z = -34` or `z = -42` (or its positive mirror). Validation reports metric bounds `z +/-51.2`, while the live legacy collision/visible shell reports `z +/-30`; the containment assertion fails.

**Required Failure Artifacts:** Before the expected assertion, take an explicit viewport screenshot showing the car beyond the transparent perimeter and attach a JSON counterexample containing room mode, session ID, snapshot sequence, phase, slot transform, collider dimensions, validation identity/bounds, collision identity/bounds, and visible identity/bounds. Playwright's `screenshot: 'only-on-failure'`, retained trace, and console/page-error log supplement but do not replace the explicit counterexample artifact.

The exploratory test is correct only when it fails on unfixed code for the documented reason. It must not be weakened or deleted after the fix; the same assertion becomes regression proof.

#### Fix Checking

```text
FOR ALL candidate WHERE isBugCondition(candidate) DO
  result := exposePlacement_Fixed(candidate)
  ASSERT expectedBehavior(result)
END FOR
```

Generated candidates cover each placement context, both teams, every canonical slot, transforms near each field/ramp/ceiling/corner plane, geometry identity mismatches, collider dimension extremes within the pinned registry range, incomplete rosters, overlap, application failures, and stale certificates. Deterministic cases include the exact `-34/-42` versus `-30` counterexample.

#### Preservation Checking

Use observation-first methodology: run F on valid non-bug-condition inputs, record its deterministic mappings and complete state transitions, then compare F' on the same inputs.

```text
FOR ALL candidate WHERE NOT isBugCondition(candidate) DO
  ASSERT observablePlacementBehavior_F(candidate)
         = observablePlacementBehavior_Fixed(candidate)
END FOR
```

The comparison excludes the intentional metric authoritative-boundary replacement itself and includes identity-to-slot mapping, orientation, non-overlap, assignment reuse, roster/host state, phase/countdown state, velocities, scores, snapshot order, and client atomic acceptance.

#### Unit Tests

- Validate canonical geometry fingerprinting, unsupported/mutated version rejection, and deterministic resolver output.
- Validate OBB support-plane containment for interior, exact-boundary, just-inside, just-outside, rotated, floor/ramp, ceiling, side/end, corner-cut, and explicitly allowed goal-interior cases.
- Validate that the same resolved collider object drives Rapier body dimensions and containment dimensions.
- Validate placement-certificate identity, roster, epoch, transform, and generation matching.
- Validate snapshot guard rejection before sequence advancement and client geometry mismatch rejection before accepted-state mutation.

#### Property-Based Tests

- **Property 28: Bug Condition - Active geometry placement containment:** Generate at least 100 deterministic seeded placement/geometry/collider cases and require reject-with-preservation for every mismatch or non-contained complete collider and accept-after-complete-commit for every valid candidate.
- **Property 29: Preservation - Deterministic placement, authority, and match flow:** Generate capacity-valid Quick/Custom rosters and non-bug candidates, observe F first, then require F' to preserve mapping, authority, atomicity, and phase behavior.
- Record seed, ordered case index, geometry identity, placement context, roster signature, and minimized counterexample on failure.

#### Integration Tests

- Build a production Rapier world from one active geometry, prove exact shell extents, and verify each canonical waiting/kickoff collider is contained by the same runtime object.
- Inject validation, body creation, set-transform, verification, assignment-commit, and rollback failures; assert no partial body, roster, cache, phase, epoch, sequence, or snapshot mutation.
- Verify initial, post-goal, and overtime kickoff transactions for one-through-capacity rosters in both modes, including unchanged-roster reuse.
- Verify a malformed/mismatched placement-bearing snapshot is never broadcast and a geometry-mismatched client preserves its previous accepted scene.
- Keep existing deterministic timing, authority, interpolation, audio, HUD, and stadium regression suites unchanged except for authoritative boundary expectations.

#### Playwright Browser Proof

Use the existing planned Task 8.5 Playwright integration rather than a second browser harness. Add an exact-pinned runner only when implementation begins. `playwright.config.ts` owns fresh server and client `webServer` processes, readiness URLs, test-only diagnostic flags, and teardown; it uses non-watch production-style start/preview commands, does not reuse unknown existing servers for this proof, and releases ports/processes after success or failure. Tests do not start development watchers or depend on a manually running terminal.

Run deterministic scenarios with isolated room codes/state:

1. **Custom room entry and initial kickoff:** Assert the first accepted local car render in Waiting_State, every accepted countdown sample, and the first playing sample all share one geometry identity and contain the full collider.
2. **Quick Match initial kickoff:** Join the deterministic 3+3 roster, assert all six represented identities and the local car through waiting/countdown/first play, and preserve deterministic slot mapping.
3. **Post-goal kickoff:** Use a test-only server fixture (not a browser mutation API) to reach a deterministic goal reset, then assert every post-goal countdown sample uses the retained mapping and contained colliders.
4. **Rejection path:** Supply a server-side test fixture with a known invalid candidate and assert the browser receives no new placement generation, no partial mesh change, and no sequence advance for that candidate.

For the post-fix run, attach the same JSON diagnostic record plus deterministic screenshots for Custom, Quick, and post-goal samples. Require metric geometry version/fingerprint equality, active bounds `z +/-51.2`, full-collider containment, visible perimeter alignment within the existing `0.05 m` tolerance, zero unexpected `pageerror` events, and zero Rocket Arena error-level console messages. The screenshot is presentation evidence; the diagnostic assertion and server/Rapier tests are the correctness proof.
