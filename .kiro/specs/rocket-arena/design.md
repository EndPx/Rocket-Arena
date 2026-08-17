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

## Remaining Dirty-Tree Safe Integration

### Scope and Safety Boundary

This slice integrates only remaining working-tree changes above commit `eb29bf7` that can be proven complete and coherent. Classification is hunk-level: a dirty path is not safe merely because another hunk in the same file is safe. No candidate receives implied approval from this design, and exclusion is the default whenever intent, completeness, ownership, or validation is uncertain.

The workflow records a baseline manifest containing HEAD, staged/unstaged/untracked path sets, file size, and SHA-256 hash for every remaining path. The index must stay empty during classification and candidate validation. Protected leftovers are checked against the manifest after every correction batch, staging operation, commit, and push.

### Semantic Classification Ledger

The audit produces an in-memory or execution-report ledger with: path and hunk identifier, semantic concern, dependencies, behavior traceability, focused checks, classification rationale, and final disposition.

| Area | Known paths to inspect | Classification guidance |
|---|---|---|
| Operational metadata | `.kiro/specs/**/tasks.meta.json` | Always protected and unstaged; local task-runner state is not product history |
| Spec orchestration | Status-only hunks in `tasks.md` | Protect status-only state; separately authored requirement, design, or plan content may qualify only as an intentional documentation concern |
| Steering | `.kiro/steering/product.md`, `.kiro/steering/structure.md` | Excluded by default; qualify only with explicit intent, valid Markdown, direct traceability, and no corruption; text such as `ssssssss` excludes the complete file |
| Stadium and rendering | `client/index.html`, renderer arena/camera/lighting/scene, `entity-effects.ts`, visual constants, and `stadium-camera-effects.test.ts` | Group only mutually required visual behavior and its tests; split unrelated integration hunks |
| Lobby and client integration | `lobby-state.ts` plus relevant hunks in `client/src/main.ts` or `state-listener.ts` | Require a complete user flow and exact integration dependencies; do not absorb unrelated renderer or audio hunks |
| Goal-tunnel physics | `server/src/physics/arena.ts` and `test-goal-tunnel.ts` | Keep authority and fixed-step invariants intact; pair physics behavior with its harness |
| Mixed integration files | `client/src/main.ts`, `client/src/networking/state-listener.ts`, `client/index.html` | Classify and stage by hunk; an unsafe hunk does not block an independent safe hunk, and a safe hunk does not authorize the whole file |

Candidate boundaries follow behavior rather than directory layout. Tests travel with the implementation concern they validate. If two sets cannot form independently valid commits, the ledger either records one coherent concern or records an explicit dependency order in which every intermediate commit still passes its required checks.

### Validation Pipeline

```text
HEAD eb29bf7
  -> byte/hash baseline
  -> hunk-level classification ledger
  -> focused checks per candidate group
  -> combined full regressions and builds
  -> fresh Playwright smoke/gameplay/audio/console proof
  -> exact-path or hunk staging
  -> isolated staged-tree validation
  -> one concern commit
  -> repeat for next concern
  -> non-force push
  -> protected-leftover hash comparison
```

Each group receives a validation matrix before commands run. Rendering candidates use renderer/stadium and interpolation tests; lobby candidates use lobby/input tests and browser navigation; physics candidates use the goal-tunnel harness plus the complete Rapier harness set; mixed client candidates use every affected focused test. The candidate union must also pass every repository TypeScript test, all five Rapier harnesses, type checking, shared/server/client builds, and diff whitespace checks.

Playwright uses fresh managed server and client processes. Browser proof covers initial load, lobby entry, active driving and rendering, changed concern behavior, page exceptions, and error-level console output. The audio regression sample repeats gesture unlock, continuous drive/boost response, authoritative cue deduplication, control persistence, and lifecycle counters so the already-pushed audio slice remains healthy.

A failed candidate can receive a `Tiny_Scoped_Fix` only inside the candidate's existing concern and file set. The correction restarts classification and all affected checks for that group. A failure requiring redesign, a dependency, a new concern, or edits to protected bytes causes the entire candidate group to become a protected leftover.

### Explicit Staging and Staged-Tree Isolation

Staging proceeds one concern at a time. New safe files use explicit path staging; mixed files use a reviewed non-interactive patch applied to the index. Repository-wide staging commands are forbidden. Before each commit, the executor reviews cached path names, every cached hunk, and `git diff --cached --check`, then confirms the index contains no operational metadata, non-qualified steering content, questionable hunk, or unrelated spec status state.

For staged-tree isolation, the executor creates a temporary worktree from the current commit, materializes only the exact cached patch, and runs the concern's focused checks plus the repository-wide checks required by the validation matrix. Browser checks run against that isolated source whenever the concern affects runtime behavior. The temporary worktree is validation infrastructure only and cannot replace or rewrite the dirty primary working tree.

### Small Commit and Push Strategy

Each staged concern becomes one `Concern_Commit`; implementation and directly supporting tests stay together. Independent rendering, lobby, physics, and documentation concerns remain separate commits. Foundational concerns precede dependent integration concerns, and every commit must remain buildable and testable. Hooks remain enabled, commits are not amended, and no force operation is permitted.

After all concern commits are locally verified, the current branch is pushed to `origin`, adding upstream tracking only when absent. The final report lists each commit and concern, command and browser outcomes, remote branch, excluded paths and reasons, and before/after hashes proving that unsafe leftovers were preserved.

### Testing Classification

This slice adds no new property-based correctness property because semantic review, Git index state, process freshness, and remote delivery are example, integration, and smoke concerns. Existing Properties 1-5 remain unchanged and continue to protect the audio and simulation behavior exercised by the expanded regression matrix.