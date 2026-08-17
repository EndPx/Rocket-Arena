# Requirements Document

## Introduction

This document specifies only the remaining work needed to complete, validate, and safely commit Rocket Arena's existing procedural browser-audio slice after a laptop restart. The historical whole-game plan remains in `implementation-plan.md`; this document does not reopen completed game scope.

## Glossary

- **Audio_System**: The complete procedural sound feature formed by `Audio_Event_Tracker`, `Audio_Manager`, `Audio_Constants`, controls, tests, and application wiring.
- **Audio_Manager**: The browser-facing component that owns sound graph creation, continuous layers, one-shot voices, settings, lifecycle handling, and debug state.
- **Audio_Event_Tracker**: The browser-independent pure TypeScript component that converts accepted state and input transitions into semantic sound events.
- **Audio_Constants**: Numeric sound synthesis, smoothing, detection, spatialization, and safety values exported from `shared/src/constants/audio.ts`.
- **Audio_Context**: A browser Web Audio context and the nodes connected to the context destination.
- **Audio_Node**: An oscillator, buffer source, gain, filter, compressor, panner, or destination-connected node owned by the `Audio_Manager`.
- **Real_Gesture**: A non-repeated pointer activation or keyboard activation initiated by a user outside an editable control.
- **Authoritative_Snapshot**: A server-produced `state-sync` message containing a monotonic sequence, simulation time, phase, scores, and entity transforms and velocities.
- **Snapshot_Sequence**: The non-negative monotonic sequence number of an `Authoritative_Snapshot`.
- **Interpolated_Local_State**: The local car presentation transform and synchronized speed sampled by the 24-entry client interpolation buffer on the delayed render timeline.
- **Active_Play**: A connected room state whose phase is `playing` or `overtime`, with a local player present and the document visible.
- **Continuous_Layer**: A persistent engine or boost sound whose parameters update on render frames.
- **Discrete_Cue**: A bounded one-shot sound for jump, landing, impact, countdown, start, goal, overtime, match end, or interface activation.
- **Match_Transition_Cue**: A countdown, start, goal, overtime, or match-end `Discrete_Cue` that may be retained while an `Audio_Context` is suspended.
- **Jump_Sequence**: The monotonic input counter incremented once for each non-repeated physical jump-key press and resent by the input heartbeat.
- **Kickoff_Teleport**: A server-authoritative reset that moves a car or ball by more than `NETCODE.TELEPORT_THRESHOLD` between accepted snapshots.
- **Audio_Debug_State**: Read-only browser instrumentation that reports support, context state, settings, room and phase identity, active layers, event counts, tracker sequence, queue size, and live voice or graph counts needed for validation.
- **Fresh_Runtime**: Server and client processes started from current source after confirming that stale pre-restart processes are absent.
- **Browser_Proof**: A Playwright-driven validation session against a `Fresh_Runtime` that records assertions, console failures, audio debug state, interpolation telemetry, and render cadence telemetry.
- **Fixed_Step_Simulation**: The server-authoritative Rapier loop using `PHYSICS.TIMESTEP` of `1/60`, a clamped callback delta, an accumulator, and at most five fixed substeps per callback.
- **Audio_Change_Set**: Audio-only source, wiring, and test hunks in `shared/src/constants/audio.ts`, `shared/src/constants/index.ts`, `shared/src/constants/registry.ts`, `client/src/audio/**`, `client/src/input/keyboard-handler.ts`, `client/src/networking/client.ts`, `client/src/main.ts`, `client/src/dev-panel/dev-panel.ts`, and `client/tests/audio-*.test.ts`, plus `.kiro/specs/rocket-arena/.config.kiro`, `requirements.md`, `design.md`, and `tasks.md`.
- **Protected_Dirty_Content**: Every pre-existing non-audio working-tree hunk, including steering, stadium and renderer work, visual constants, physics-arena changes, `client/index.html`, non-audio `client/src/main.ts` hunks, non-audio state-listener changes, stadium tests, lobby-state work, and goal-tunnel work.
- **Validation_Workflow**: The ordered audit, automated regression, Playwright proof, staged-diff review, commit, and push process defined by `tasks.md`.

## Requirements

### Requirement 1: Gesture-gated activation and graceful fallback

**User Story:** As a player, I want sound to activate only after a valid interaction and fail silently when browser audio is unavailable, so that audio policy restrictions do not break gameplay.

#### Acceptance Criteria

1. WHEN a `Real_Gesture` occurs and no `Audio_Context` exists, THE `Audio_Manager` SHALL create an `Audio_Context` and request the running state.
2. WHEN a `Real_Gesture` occurs while the `Audio_Context` is suspended, THE `Audio_Manager` SHALL request resumption of the existing `Audio_Context`.
3. IF the browser exposes no Web Audio context constructor, THEN THE `Audio_Manager` SHALL keep rendering, input, networking, and sound controls operational in silent mode.
4. IF `Audio_Context` creation or resumption rejects, THEN THE `Audio_Manager` SHALL contain the error and keep the game loop operational.
5. IF the `Audio_Context` remains suspended after a resumption request, THEN THE `Audio_Manager` SHALL expose the suspended state through `Audio_Debug_State`.
6. WHILE the `Audio_Context` is suspended, THE `Audio_Manager` SHALL retain at most five latest-per-type `Match_Transition_Cue` events.
7. WHILE the `Audio_Context` is suspended, THE `Audio_Manager` SHALL discard jump, landing, impact, and interface `Discrete_Cue` events instead of queuing those events.

### Requirement 2: Continuous engine and boost layers

**User Story:** As a player, I want engine and boost sound to follow visible local-car motion smoothly, so that sound agrees with the delayed synchronized presentation.

#### Acceptance Criteria

1. WHILE `Active_Play` is true and `Interpolated_Local_State` is available, THE `Audio_Manager` SHALL derive the engine target from the interpolated local-car speed on each render frame.
2. WHILE `Active_Play` is true and boost input is held and authoritative boost amount is greater than zero, THE `Audio_Manager` SHALL target the active boost gain.
3. IF `Interpolated_Local_State` is unavailable during `Active_Play`, THEN THE `Audio_Manager` SHALL derive the engine target from the latest authoritative local-car velocity.
4. WHEN an engine or boost target changes, THE `Audio_Manager` SHALL apply elapsed-time-based smoothing whose result after equal elapsed time differs by no more than 0.1 percent of the target range at 30, 60, and 120 render updates per second.
5. WHEN a render-frame delta exceeds 100 milliseconds, THE `Audio_Manager` SHALL clamp the smoothing delta to 100 milliseconds.
6. WHILE `Active_Play` is false, THE `Audio_Manager` SHALL drive engine and boost gains toward zero.

### Requirement 3: Authoritative discrete cue semantics

**User Story:** As a player, I want action and match sounds to correspond to server-confirmed events, so that local input prediction and network repetition do not create misleading cues.

#### Acceptance Criteria

1. WHEN a new `Jump_Sequence` occurs during `Active_Play`, THE `Audio_Event_Tracker` SHALL arm one pending jump confirmation for at most 400 milliseconds.
2. WHEN a later `Authoritative_Snapshot` confirms grounded-to-upward takeoff for the armed `Jump_Sequence`, THE `Audio_Event_Tracker` SHALL emit one jump `Discrete_Cue`.
3. IF the armed `Jump_Sequence` receives no authoritative takeoff confirmation within 400 milliseconds, THEN THE `Audio_Event_Tracker` SHALL expire the pending confirmation with zero jump cues.
4. WHEN authoritative local-car motion crosses from airborne descent to grounded state at or above the configured downward-speed threshold, THE `Audio_Event_Tracker` SHALL emit one landing `Discrete_Cue` scaled by downward speed.
5. WHEN consecutive `Authoritative_Snapshot` values show spatial contact and a velocity discontinuity at or above the configured threshold, THE `Audio_Event_Tracker` SHALL emit an impact `Discrete_Cue` with a stable contact key and bounded strength.
6. WHEN an authoritative countdown enters a previously unobserved integer value from one through five, THE `Audio_Event_Tracker` SHALL emit one countdown `Discrete_Cue` for that value.
7. WHEN an authoritative phase transition starts or resumes a kickoff epoch, THE `Audio_Event_Tracker` SHALL emit one start `Discrete_Cue` for that kickoff epoch.
8. WHEN the authoritative total score increases, THE `Audio_Event_Tracker` SHALL emit one goal `Discrete_Cue`.
9. WHEN the authoritative phase first enters `overtime`, THE `Audio_Event_Tracker` SHALL emit one overtime `Discrete_Cue`.
10. WHEN the authoritative phase first enters `ended` after an earlier accepted snapshot, THE `Audio_Event_Tracker` SHALL emit one match-end `Discrete_Cue`.

### Requirement 4: Persistent and accessible sound controls

**User Story:** As a player, I want accessible mute and volume controls that remember preferences, so that sound remains comfortable across page reloads.

#### Acceptance Criteria

1. WHEN the `Audio_Manager` initializes, THE `Audio_Manager` SHALL restore a valid persisted mute value and a persisted volume value clamped to the inclusive range from zero through one.
2. IF persisted sound settings are absent, malformed, or blocked, THEN THE `Audio_Manager` SHALL use `AUDIO.MASTER.DEFAULT_VOLUME` and an unmuted fallback without interrupting gameplay.
3. WHEN the player changes mute or volume, THE `Audio_Manager` SHALL persist the normalized settings during the same control event.
4. THE sound-control region SHALL expose an accessible name.
5. THE mute control SHALL expose an action-specific accessible label and an `aria-pressed` state matching the current mute value.
6. THE volume control SHALL support keyboard adjustment and expose its current percentage through accessible value text.
7. WHEN a sound control receives keyboard focus, THE sound-control region SHALL display a visible focus indicator.

### Requirement 5: Lifecycle safety and bounded resources

**User Story:** As a player, I want sound to reset cleanly across reconnects, tab visibility changes, and page lifecycle events, so that stale sounds and leaked nodes do not accumulate.

#### Acceptance Criteria

1. WHEN room identity, session identity, or connected state is lost, THE `Audio_Manager` SHALL reset event history, clear queued transitions, stop one-shot voices, and fade continuous layers.
2. WHEN the document becomes hidden, THE `Audio_Manager` SHALL clear queued transitions, stop one-shot voices, fade continuous layers, and reset motion history.
3. WHEN the document becomes visible after a hidden interval, THE `Audio_Manager` SHALL treat the next accepted snapshot as a motion baseline before emitting motion-derived cues.
4. WHEN a back-forward-cache page transition occurs, THE `Audio_Manager` SHALL reset room-bound event and motion state before resumed updates.
5. WHEN final page cleanup occurs, THE `Audio_Manager` SHALL remove owned event listeners and sound controls.
6. WHEN final page cleanup occurs, THE `Audio_Manager` SHALL stop and disconnect every owned source and `Audio_Node` and request closure of the owned `Audio_Context`.
7. WHEN three room reconnect cycles complete, THE `Audio_Debug_State` SHALL report no growth in continuous graph count and zero stale one-shot voices between rooms.
8. WHEN one-shot playback completes, THE `Audio_Manager` SHALL remove and disconnect the completed voice from the live voice set.

### Requirement 6: Snapshot deduplication and teleport suppression

**User Story:** As a player, I want each authoritative event represented once and kickoff resets kept silent, so that the approximately 30 Hz snapshot stream does not repeat or fabricate cues.

#### Acceptance Criteria

1. WHEN an `Authoritative_Snapshot` repeats an already accepted `Snapshot_Sequence`, THE `Audio_Event_Tracker` SHALL emit zero additional `Discrete_Cue` events.
2. WHEN multiple accepted snapshots retain the same score or terminal phase, THE `Audio_Event_Tracker` SHALL emit zero duplicate goal, overtime, or match-end cues.
3. WHEN the same contact remains within its configured cooldown, THE `Audio_Event_Tracker` SHALL emit zero additional impact cues for the corresponding contact key.
4. WHEN a `Kickoff_Teleport` or active-play teleport is detected, THE `Audio_Event_Tracker` SHALL replace motion history with the teleported snapshot as a new baseline.
5. WHEN a teleported snapshot becomes a new motion baseline, THE `Audio_Event_Tracker` SHALL emit zero landing or impact cues caused by the position discontinuity.
6. WHEN a lower `Snapshot_Sequence` indicates a restarted stream, THE `Audio_Event_Tracker` SHALL reset stream deduplication state before establishing new motion history.

### Requirement 7: Post-restart Playwright browser proof

**User Story:** As a maintainer, I want objective browser evidence from fresh processes after restart, so that passing unit tests are supplemented by proof of real browser behavior.

#### Acceptance Criteria

1. WHEN `Browser_Proof` begins, THE `Validation_Workflow` SHALL confirm stale pre-restart server and client processes are absent before starting a `Fresh_Runtime` from current source.
2. WHEN Playwright loads the client before a `Real_Gesture`, THE `Browser_Proof` SHALL record the pre-unlock `Audio_Debug_State`.
3. WHEN Playwright performs a `Real_Gesture` in a supported browser, THE `Browser_Proof` SHALL observe an `Audio_Context` state of `running` before sound assertions continue.
4. WHEN Playwright changes mute and volume and reloads the page, THE `Browser_Proof` SHALL observe matching control state, accessible attributes, and persisted values after reload.
5. WHEN Playwright drives, boosts, jumps, lands, and creates a collision during `Active_Play`, THE `Browser_Proof` SHALL observe the corresponding continuous-layer states and exactly one increment for each confirmed discrete event under test.
6. WHEN Playwright exercises countdown, start, goal, overtime, and match-end transitions, THE `Browser_Proof` SHALL observe event-count increments that remain unchanged across repeated snapshots for the same transition.
7. WHILE the Playwright page remains visible during at least one five-second active-play sample, THE `Browser_Proof` SHALL record accepted snapshot rate, applied render-frame count, interpolation underrun count, extrapolated-frame count, teleport-frame count, and render-frame median and 95th-percentile interval.
8. WHILE the five-second active-play sample runs, THE `Browser_Proof` SHALL observe applied render frames advancing faster than accepted authoritative snapshots.
9. WHEN Playwright validation completes, THE `Browser_Proof` SHALL report zero uncaught page exceptions and zero unexpected console errors.

### Requirement 8: Regression and authority preservation

**User Story:** As a maintainer, I want the complete existing validation baseline rerun, so that audio completion does not alter authoritative physics or networking behavior.

#### Acceptance Criteria

1. WHEN the `Audio_Change_Set` is ready for browser proof, THE `Validation_Workflow` SHALL run the focused audio, input, interpolation, and fixed-step Node test command with exit code zero.
2. WHEN the `Audio_Change_Set` is ready for final review, THE `Validation_Workflow` SHALL run every repository TypeScript unit test with exit code zero.
3. WHEN the `Audio_Change_Set` is ready for final review, THE `Validation_Workflow` SHALL run the ball, car, impact, jump-sequence, and goal-tunnel Rapier harnesses with exit code zero.
4. WHEN the `Audio_Change_Set` is ready for final review, THE `Validation_Workflow` SHALL run `npm run typecheck`, the shared build, the server build, and the client build with exit code zero.
5. THE `Fixed_Step_Simulation` SHALL retain a timestep of `1/60`, a maximum callback delta of 100 milliseconds, and a maximum of five substeps.
6. THE server SHALL remain the sole authority for Rapier physics, scores, match phases, and state-snapshot production.
7. THE manual state transport SHALL retain the approximately 33-millisecond snapshot target.
8. THE client presentation path SHALL retain a 24-snapshot buffer, a 100-millisecond delay, shortest-path quaternion slerp, and extrapolation capped at 80 milliseconds.
9. THE `Audio_Change_Set` SHALL add no external sound asset and no package dependency.

### Requirement 9: Isolated commit and push

**User Story:** As a maintainer, I want a narrowly scoped commit after validation, so that unrelated dirty work remains intact and absent from the pushed history.

#### Acceptance Criteria

1. WHEN Task 1 begins, THE `Validation_Workflow` SHALL record the unstaged, staged, and untracked baseline for `Protected_Dirty_Content`.
2. WHEN files are prepared for commit, THE `Validation_Workflow` SHALL stage only `Audio_Change_Set` paths and audio-specific hunks.
3. IF an `Audio_Change_Set` path contains `Protected_Dirty_Content`, THEN THE `Validation_Workflow` SHALL stage an audio-only patch without altering the protected working-tree hunk.
4. WHEN the staged diff is complete, THE `Validation_Workflow` SHALL verify that every staged path and hunk traces to an acceptance criterion in this document.
5. WHEN the staged diff is complete, THE `Validation_Workflow` SHALL verify that package files, git configuration, `implementation-plan.md`, unrelated steering files, and `Protected_Dirty_Content` are absent from the staged diff.
6. WHEN automated regressions and `Browser_Proof` pass, THE `Validation_Workflow` SHALL create one logical commit containing only the staged `Audio_Change_Set`.
7. WHEN the isolated commit is verified, THE `Validation_Workflow` SHALL push the current branch to the configured `origin` remote.
8. WHEN push completes, THE `Validation_Workflow` SHALL confirm that the remaining working-tree diff for `Protected_Dirty_Content` matches the Task 1 baseline.
