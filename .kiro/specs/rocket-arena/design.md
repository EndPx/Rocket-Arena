# Design Document: Procedural Audio Completion

## Overview

The remaining slice completes and proves the existing procedural Web Audio implementation without redesigning Rocket Arena. Sound generation stays dependency-free and asset-free. The implementation separates two timelines:

1. **Authoritative event timeline:** accepted server `state-sync` snapshots at approximately 30 Hz feed the pure `AudioEventTracker` for jump confirmation, landing, impact, and match-transition cues.
2. **Interpolated presentation timeline:** the rendered local car sampled every animation frame feeds continuous engine and boost layers so sound follows what the player sees.

The separation prevents interpolation from fabricating discrete events while avoiding 30 Hz stepping in continuous sound.

## Existing Invariants to Preserve

- Rapier remains server-authoritative.
- Physics remains an accumulator-driven fixed step of `1/60` seconds with callback delta capped at `0.1` seconds and at most five substeps.
- Rooms continue manual `state-sync` broadcasts near the 33-millisecond target.
- Inputs retain monotonic `jumpSequence` edges and a 250-millisecond heartbeat.
- The client retains 24 immutable snapshots, a 100-millisecond interpolation delay, shortest-path quaternion slerp, an 8-meter teleport threshold, and extrapolation capped at 80 milliseconds.
- No external or copyrighted audio asset and no new package dependency may be introduced.
- `implementation-plan.md` remains unchanged as historical context.

## Architecture

```text
InputController ── jumpSequence ─────────────┐
                                             v
Server fixed-step physics ── state-sync ──> AudioEventTracker ── semantic events ─┐
          (authoritative, ~30 Hz)            (pure TypeScript)                    │
                                                                                  v
SnapshotBuffer ── rendered local speed ─────────────────────────────────> AudioManager
 (24 entries, 100 ms delay)              input throttle/boost ──────────> Web Audio graph
                                                                                  │
Real gesture ── unlock/resume ────────────────────────────────────────────────────┘

Audio constants ── synthesis/detection/safety values ──> tracker + manager
Audio debug state + interpolation stats ───────────────> Playwright evidence
```

## Components and Interfaces

### Component Boundaries

| Component | Responsibility | Must not own |
|---|---|---|
| `shared/src/constants/audio.ts` | Numeric synthesis, smoothing, event-detection, spatial, and resource bounds | Browser APIs, mutable runtime state, external assets |
| `client/src/audio/audio-model.ts` | Pure value mapping, transition queue, event deduplication, authoritative motion inference | DOM, Three.js scene mutation, Web Audio nodes |
| `client/src/audio/audio-manager.ts` | Gesture unlock, audio graph, one-shots, continuous layers, controls, persistence, lifecycle, debug state | Physics authority, match-state mutation, snapshot interpolation |
| `client/src/networking/state-listener.ts` | Accepted authoritative snapshots, delayed interpolation, synchronized render-speed telemetry | Sound-event inference |
| `client/src/networking/client.ts` | Own the active Colyseus room reference, clear the reference on `onLeave` or a closed connection, and propagate `null` through the main/input/audio update boundary | Audio synthesis, gameplay authority, match-state mutation |
| `client/src/input/input-controller.ts` | Monotonic jump edges, held controls, heartbeat | Sound playback or jump acknowledgement |
| `client/src/main.ts` | Pass one immutable frame view into the audio manager after interpolation | Event deduplication or audio-node ownership |

### Interfaces and Data Flow

#### Shared Audio Constants

`AUDIO` remains an `as const` numeric tree and is exported through `DEFAULTS_REGISTRY`. The dev panel excludes `AUDIO` from server override messages because synthesis runs on the client. Values cover master limiting, smoothing, detection thresholds, panning, and each procedural voice.

#### Web Audio Graph

```text
engine oscillator A ─ gain ─┐
engine oscillator B ─ gain ─┴─ low-pass ─ engine gain ─┐
looping generated noise ─ band-pass ─ boost gain ──────┼─ limiter ─ master gain ─ destination
one-shot tone/noise ─ envelope ─ optional stereo pan ──┘
```

- The graph is created lazily after a real gesture.
- The master limiter bounds summed procedural voices.
- Engine and boost sources are created once per context and faded rather than recreated per frame.
- One-shot voices track every owned source and intermediate node until `onended` cleanup.
- Event panning projects the source direction onto the camera-right axis; centered match cues use pan zero.
- Noise buffers are generated locally with no downloaded sample.

## Data Models

### Pure Event Model

```typescript
interface AudioSnapshotSample {
  sequence: number;
  phase: string;
  blueScore: number;
  orangeScore: number;
  timeRemaining: number;
  localCar: KinematicAudioCar | null;
  ball: KinematicAudioEntity | null;
  otherCars: readonly KinematicAudioCar[];
}

interface TrackedAudioEvent {
  type: 'jump' | 'landing' | 'impact' | 'countdown' | 'go'
    | 'goal' | 'overtime' | 'match-end' | 'ui';
  strength: number;
  countdownValue?: number;
  source?: Vector3Like;
  contactKey?: string;
}

class AudioEventTracker {
  observeJump(jumpSequence: number | undefined, active: boolean, nowMs: number): TrackedAudioEvent[];
  observeSnapshot(sample: AudioSnapshotSample, nowMs: number): TrackedAudioEvent[];
  resetMotionHistory(): void;
  reset(): void;
}
```

The tracker accepts immutable values, ignores duplicate snapshot sequences, resets on stream regression, and emits no browser side effects. A local jump edge only arms a request. A later authoritative grounded-to-upward transition confirms playback. Landing and impact detection compare accepted authoritative samples, enforce thresholds and per-contact cooldowns, and reset motion history on teleports.

### Continuous Frame Model

```typescript
interface AudioFrame {
  roomId: string | null;
  sessionId: string | null;
  state: StateSync | null;
  input: Readonly<InputPayload>;
  localCar: THREE.Group | null;
  ball: THREE.Group | null;
  camera: THREE.Camera;
  deltaSeconds: number;
  nowMs: number;
}
```

The engine uses `localCar.userData.syncedSpeed`, which is written from the interpolated entity frame. Latest authoritative velocity is a fallback when the mesh sample is unavailable. Boost activation requires active gameplay, held boost input, and authoritative boost amount greater than zero.

For response coefficient `r` and clamped frame delta `dt`, smoothing uses:

```typescript
const alpha = 1 - Math.exp(-Math.max(0, r) * clamp(dt, 0, 0.1));
current += (target - current) * alpha;
```

This produces elapsed-time-based convergence rather than a frame-count-dependent lerp.

## Authoritative Event Rules

| Cue | Trigger source | Deduplication boundary |
|---|---|---|
| Jump | New local `jumpSequence`, followed by authoritative takeoff within 400 ms | One confirmation per input sequence |
| Landing | Authoritative airborne descent followed by grounded state above threshold | Landing cooldown |
| Impact | Authoritative spatial contact plus velocity discontinuity | Stable contact key and impact cooldown |
| Countdown | Authoritative integer countdown value 1-5 | Once per value in a tracker epoch |
| Start | `countdown -> playing` or `goal-scored -> playing/overtime` | Once per kickoff epoch |
| Goal | Authoritative total score increase | Once per score transition |
| Overtime | First accepted `overtime` phase | Once per tracker epoch |
| Match end | First accepted `ended` phase after a baseline | Once per tracker epoch |

A phase-driven kickoff reset or any displacement above `NETCODE.TELEPORT_THRESHOLD` seeds a fresh motion baseline. The reset may still emit the legitimate start or match-transition cue, but the displacement cannot emit landing or impact cues.

## Controls and Persistence

The manager creates one sound-control region with a mute button, range input, percentage output, visible focus treatment, action-specific labels, and `aria-pressed` state. Settings use the existing versioned local-storage key. Read and write failures fall back to in-memory operation. Volume is normalized to `[0, 1]`; mute and volume update the master gain without rebuilding the graph.

## Lifecycle Design

| Boundary | Required action |
|---|---|
| Room or session identity change | Reset tracker and queue, stop one-shots, fade continuous gains, establish new snapshot baseline |
| State loss or room leave | Apply the same room-bound reset and clear active-layer flags |
| Document hidden | Clear queued transitions, stop one-shots, fade continuous layers, reset motion history |
| First visible snapshot | Seed motion history and suppress discontinuity-derived events |
| Suspended context | Queue only a bounded latest-per-type set of match transitions; discard rapid action cues |
| Back-forward-cache transition | Reset session-bound state without retaining stale cues |
| Final page cleanup | Remove owned listeners and controls, stop and disconnect sources, disconnect graph nodes, close context |

The tracker, transition queue, continuous graph, and one-shot set each have one owner. Cleanup is idempotent. A reconnect does not create a second continuous graph inside the same context.

## Debug Instrumentation

The read-only `window.__rocketArenaAudio.getState()` surface is the browser proof boundary. The audit should retain existing fields and add only missing counters needed to verify lifecycle behavior:

```typescript
interface AudioDebugState {
  supported: boolean;
  initialized: boolean;
  contextState: string;
  muted: boolean;
  volume: number;
  roomId: string | null;
  phase: string | null;
  activeContinuousLayers: { engine: boolean; boost: boolean };
  eventPlayCounts: Record<AudioEventType, number>;
  trackedSequence: number | null;
  queuedTransitionCount: number;
  liveOneShotVoiceCount: number;
  continuousGraphCount: 0 | 1;
}
```

Instrumentation exposes copies and counters only; no debug mutator may bypass authority or inject gameplay state. Interpolation evidence comes from `getInterpolationStats()`. Playwright measures render cadence with a page-local `requestAnimationFrame` sampler and records sample duration, count, median interval, and 95th-percentile interval.

## Error Handling

| Condition | Response |
|---|---|
| Web Audio unsupported | Keep controls and game operational, report `supported: false`, remain silent |
| Context create or resume failure | Warn once, fade active gains, report non-running context state, keep game loop alive |
| Context suspended during transition | Bound and deduplicate eligible queued match transitions |
| Local storage unavailable or malformed | Use normalized defaults and keep settings in memory |
| Invalid numeric input | Clamp or replace with a finite default before parameter scheduling |
| Room reconnect or snapshot regression | Reset event and motion baselines before accepting new transitions |
| Visibility discontinuity or teleport | Suppress motion-derived cues for the baseline snapshot |
| Voice stop or disconnect after prior completion | Treat the cleanup call as idempotent |

## Browser Validation Strategy

### Fresh Runtime

1. Record `git status --short`, unstaged names, and staged names before any implementation work.
2. Confirm no stale process owns ports 2567 or 3000.
3. Use managed background-process tooling, not a blocking shell command, to start `npm run dev:server` and `npm run dev:client` from the repository root.
4. Wait for the server log at `ws://localhost:2567` and Vite at `http://localhost:3000` before opening Playwright.

### Playwright Scenarios

1. **Unlock and fallback:** Read debug state before a gesture, activate a real button or non-editable key, then assert `running` when Web Audio is supported. A separate mocked-constructor unit path covers unsupported and rejected-resume behavior.
2. **Controls and persistence:** Verify names, `aria-pressed`, keyboard range adjustment, visible focus, local-storage value, and state after reload.
3. **Continuous sound:** Join active play, drive and boost, then compare debug layer flags and engine/boost changes with interpolated car movement and authoritative remaining boost.
4. **Action cues:** Use actual controls to jump, land, and collide. Compare event counters before and after each confirmed action and across subsequent unchanged snapshots.
5. **Match transitions:** Use four Playwright pages for the real quick-match countdown. Existing dev tuning may shorten countdown and match duration. Observe countdown/start, tied-time overtime, a real goal, and end-state counts; repeated snapshots must not increment counts.
6. **Lifecycle:** Hide/show or background the page, leave/rejoin, and reload. Assert suppressed first-snapshot motion cues, zero stale one-shots, and a continuous graph count no greater than one.
7. **Cadence evidence:** During a visible five-second drive, capture interpolation stats, accepted snapshot delta, applied render-frame delta, extrapolation and underrun deltas, plus request-animation-frame median and p95 interval. Render frames must advance faster than accepted snapshots; extrapolation remains bounded by design.
8. **Console evidence:** Collect page exceptions and error-level console records for the complete run. Expected one-time warnings from deliberately mocked unsupported paths remain isolated to the mocked test, not the normal browser run.

If a browser scenario exposes a defect, the implementation task fixes only audio-owned code or audio-specific hunks, reruns the focused automated checks, restarts affected fresh processes, and repeats the failed scenario plus dependent scenarios.

## Testing Strategy

- **Focused unit tests:** Event transitions, queue bounds, jump confirmation, teleport suppression, impact cooldown, value mapping, persistence parsing, and cleanup counters.
- **Generated/property tests:** Deterministic generators with at least 100 cases for pure model invariants; no new property-testing dependency is required.
- **Integration tests:** Audio manager behavior with mocked Web Audio and storage boundaries when browser behavior cannot be asserted through the pure model.
- **Browser tests:** Playwright against real Chromium and fresh local processes.
- **Regression tests:** Existing client tests, fixed-step scheduler test, all five Rapier harnesses, TypeScript project check, and all workspace builds.

Each generated test uses the tag format `Feature: rocket-arena, Property N: <property title>`.

## Commit Isolation Strategy

1. Treat the Task 1 status and diff as the preservation baseline.
2. Stage new audio files and spec documents by explicit path; never use `git add .` or `git add -A`.
3. For mixed files such as `client/src/main.ts`, construct a non-interactive audio-only patch and apply the patch to the index without replacing unrelated working-tree hunks.
4. Review `git diff --cached --name-only`, `git diff --cached`, and `git diff --cached --check` before commit.
5. Validate the proposed staged patch against `HEAD` in an isolated temporary worktree when mixed-file dependencies could make the dirty working tree mask a missing dependency.
6. Create one audio-completion commit only after automated and browser proof passes, push the current branch to `origin`, and compare protected dirty content with the baseline after push.

## Correctness Properties

### Property 1: Time-partition-independent smoothing

For any finite start value, finite target value, non-negative response coefficient, and two partitions of the same elapsed time whose individual deltas are between zero and 100 milliseconds, repeated smoothing shall produce results differing by no more than 0.1 percent of the target range and shall remain bounded by the start and target values.

**Validates: Requirements 2.4, 2.5**

### Property 2: Snapshot observation is idempotent

For any valid tracker state and any accepted `Authoritative_Snapshot`, observing the same `Snapshot_Sequence` any additional number of times shall emit zero additional cues and shall not advance transition counts.

**Validates: Requirements 3.6, 3.7, 3.8, 3.9, 3.10, 6.1, 6.2**

### Property 3: Jump cues require one authoritative confirmation

For any sequence of jump inputs and authoritative local-car samples, each increasing `Jump_Sequence` shall emit at most one jump cue, and a jump cue shall exist only when a later sample within 400 milliseconds confirms grounded-to-upward takeoff.

**Validates: Requirements 3.1, 3.2, 3.3**

### Property 4: Teleports cannot synthesize motion cues

For any consecutive valid snapshots in which a tracked car or ball displacement exceeds `NETCODE.TELEPORT_THRESHOLD`, the second snapshot shall establish a new motion baseline and the emitted event set shall contain no landing or impact cue caused by that displacement.

**Validates: Requirements 6.4, 6.5, 6.6**

### Property 5: Numeric audio mappings remain finite and bounded

For any finite or non-finite speed, throttle, volume, frame delta, source position, listener position, and camera-right vector, pure audio mapping functions shall return finite normalized values within the documented gain, ratio, pan, and smoothing bounds.

**Validates: Requirements 2.1, 2.3, 2.5, 4.1, 4.2**

## Property Reflection

The five properties cover distinct failure classes: temporal smoothing, transport idempotence, authoritative jump acknowledgement, discontinuity suppression, and numeric safety. Transition-specific duplicate checks are consolidated into Property 2, and landing and impact teleport checks are consolidated into Property 4. Browser lifecycle, accessibility, process freshness, and git isolation remain example or integration checks because repeated generated inputs would not add meaningful coverage.
