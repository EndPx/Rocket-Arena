# Implementation Plan: Rocket Arena Mechanics Fidelity and Expanded Multiplayer

## Overview

Implement the finalized Rocket Arena mechanics and multiplayer design incrementally in the existing TypeScript monorepo. The plan preserves the completed authoritative fixed-step scheduler, interpolation, procedural audio, lobby foundation, and stadium presentation while extending them to exact 3-versus-3 Quick Match, up-to-4-versus-4 Custom Rooms, eight-car transport, deterministic kickoff and match flow, metric Rapier mechanics, boost pads, and accessible camera/HUD presentation.

Both room modes use one confirmed ruleset: 300 seconds of regulation, exactly 18,000 regulation Active_Play fixed steps at 60 Hz unless an above-zero goal ends the match earlier, `Regulation_Goal_Target = 6`, `Regulation_Win_Margin = 2`, and no match-rule score cap. Above-zero goals end regulation only when the updated scorer has at least six goals and leads by at least two. The fixed step that first reaches zero applies any valid same-step goal exactly once before an atomic Hard_Regulation_Cutoff; unequal scores end immediately, while a tie restores deterministic kickoff state for a frozen 180-step Golden_Goal_Overtime countdown followed by untimed first-goal-wins play.

Every implementation task must leave its code wired into the preceding increment, add focused automated coverage where practical, and keep uncertain mechanics in the versioned tuning registry as unverified hypotheses. Generated property tests use the existing TypeScript/Node test stack rather than a new property-testing dependency. Final-fidelity-only increments are marked `*`; the normal hackathon feature path and its validation remain required.

## Tasks

- [ ] 1. Establish shared policies, V2 contracts, metric geometry, and tuning foundations
  - [ ] 1.1 Add immutable room policies and confirmed shared match rules
    - Add `shared/src/config/room-policies.ts` and `shared/src/types/room.ts` for `RoomMode`, `Team`, policy capacities, stable roster entries, phases, countdown kinds, winners, rejection codes, terminal reasons/results, and feature status.
    - Refactor `shared/src/constants/match.ts` to define one immutable Quick/Custom ruleset with a 300-second regulation duration, exactly 18,000 regulation Active_Play fixed steps at 60 Hz, an exact 3-second/180-step kickoff duration, `Regulation_Goal_Target = 6`, `Regulation_Win_Margin = 2`, and no match-rule score cap; remove gameplay use of the shared four-player/two-player limits and obsolete timing values.
    - Refactor `shared/src/constants/netcode.ts` to expose a finite non-negative snapshot scheduling tolerance independent of `1/60` simulation time.
    - Add `shared/tests/room-policies.test.ts` for exact 6/3 and 8/4 mappings, immutable policy validation, invalid policy rejection, identical Quick/Custom 300/18,000/6/2 rules, no score-cap field, and independent room-capacity configuration.
    - _Depends on: none_
    - _Requirements: 1.8, 2.1-2.5, 13.1-13.3, 13.9-13.12, 18.37-18.38_

  - [ ] 1.2 Define V2 input, snapshot, terminal-transition, and authoritative schema contracts
    - Refactor `shared/src/types/input.ts` and add `shared/src/types/snapshot.ts` for normalized drive/air controls, held controls, monotonic jump and camera-toggle edges, versioned `SnapshotEnvelopeV2`, array-based `CarSnapshot`, ball state, policy metadata, and typed match fields.
    - Define coherent `GoalResult`, immutable `TerminalResult`, `TerminalReason`, and stable authoritative transition/event IDs so snapshots can carry final scores, winner, reason, and one composite goal/cutoff/overtime outcome across repeated Ended_State snapshots.
    - Refactor `shared/src/schema/player-state.ts` and `shared/src/schema/game-state.ts` to project stable join order, typed teams, host metadata, bounded boost, policy/version data, phase timing, integer regulation-step state, kickoff epoch, winner, terminal result, latest transition, and occupancy without accepting client authority.
    - Add serialization and structural contract tests in `shared/tests/contracts-v2.test.ts`, including eight distinct cars, identity-associated fields, finite numeric fields, terminal score/winner/reason/event-ID coherence, stable repeated terminal snapshots, and rejection of authoritative-looking input fields.
    - _Depends on: 1.1_
    - _Requirements: 1.1-1.3, 6.1-6.7, 9.17, 13.14, 13.19, 13.25, 15.2-15.3, 18.17_

  - [ ] 1.3 Add the single shared metric arena and surface specification
    - Add `shared/src/geometry/arena-spec.ts` with exact field, ceiling, corner-cut, floor-ramp, goal-opening, goal-depth, semantic boundary, and Core/Advanced surface descriptors consumed by both server and client.
    - Add `shared/tests/arena-spec.test.ts` for exact dimensions, finite descriptors, mirrored end geometry, unique semantic surface IDs, and internally closed-boundary topology metadata.
    - Do not assign unverified support, pad, or camera values in this module; reference registry IDs for those values.
    - _Depends on: none_
    - _Requirements: 10.5-10.10, 12.1-12.9_

  - [ ] 1.4 Implement the versioned tuning registry and release-validation core
    - Add `shared/src/tuning/model.ts`, `shared/src/tuning/registry.ts`, and `shared/src/tuning/release-gate.ts` for classifications, units, finite inclusive ranges, structured curves, immutable room-pinned versions, evidence/approval links, proposal history, feature status, and pure release eligibility.
    - Refactor `shared/src/constants/registry.ts` and `shared/src/constants/resolver.ts` so confirmed compatibility reads remain available while mechanics tuning is range-checked, atomic, versioned, and no longer an unrestricted process-global override.
    - Seed all required confirmed targets and unverified hypotheses, including independent collider dimensions, throttle/steering provenance, drag, ball damping, jump/flip windows, support rays, pad geometry, camera values, and the configurable 2-second goal reset; do not mark them verified.
    - Add `shared/tests/tuning-registry.test.ts` for finite/range/curve/cross-entry validation, all-or-nothing rejection, immutable snapshots, history, and release-gate failure when evidence or approval is absent.
    - _Depends on: none_
    - _Requirements: 7.6, 8.1-8.3, 9.1-9.3, 11.6-11.7, 13.4, 17.1-17.21_

  - [ ] 1.5 Wire shared exports and verify the foundational contracts compile
    - Refactor `shared/src/index.ts`, `shared/src/constants/index.ts`, `shared/src/types/index.ts`, and `shared/src/schema/index.ts` to export the new policy, confirmed 300/18,000/6/2 rules, geometry, terminal-transition contracts, schema, and tuning APIs while retaining imports used by completed presentation/audio baselines.
    - Update compatibility consumers only as needed to remove references to obsolete `MATCH.MAX_PLAYERS`, `MATCH.TEAM_SIZE`, countdown/reset values, mode-specific regulation rules, and any score-cap assumption.
    - Run `npx tsc -b shared` and the focused shared Node tests; fix contract/export errors before server work begins.
    - _Depends on: 1.1, 1.2, 1.3, 1.4_
    - _Requirements: 1.4, 1.8, 2.5, 13.1-13.3, 13.9-13.12, 17.12-17.13_

  - [ ] 1.6 Implement generated Property 20 coverage for tuning atomicity and traceability
    - Add `shared/tests/support/generated-cases.ts` as a deterministic seeded generator helper that records seed and ordered case index without adding a property-testing package.
    - Add `shared/tests/tuning-registry.property.test.ts` and execute at least 100 generated valid/invalid proposals per recorded seed; rerunning the seed must reproduce the same ordered inputs and result.
    - **Property 20: Tuning proposal atomicity and traceability**
    - **Validates: Requirements 17.1-17.16**
    - _Depends on: 1.4_
    - _Requirements: 17.1-17.16, 18.25_

- [ ] 2. Build the transactional authoritative room core and mode-specific roster behavior
  - [ ] 2.1 Implement deterministic team assignment as a pure service
    - Add `server/src/systems/team-assignment.ts` with Blue tie-breaking, smaller-team selection, one-team-available Custom handling, and Stable_Roster_Order folding for queued accepted joins.
    - Add `server/src/systems/team-assignment.test.ts` for Quick prefixes, Custom capacity edges, repeated evaluation, and team-count difference invariants.
    - _Depends on: 1.5_
    - _Requirements: 3.3-3.7, 4.4-4.8_

  - [ ] 2.2 Implement transactional room mutation planning and commit
    - Add `server/src/systems/room-mutations.ts` for join, leave, switch, host succession, start validation, tombstoning, resource preparation, typed rejection, and one-shot logical commit.
    - Add `server/src/systems/room-mutations.test.ts` with deep atomic-state assertions proving every duplicate, capacity, phase, host, team, identity, readiness, and preparation rejection preserves roster, host, phase, countdown, score, timer, ball, cars, and inputs.
    - Ensure failed body preparation disposes temporary resources and no accepted logical identity is exposed without an authoritative body.
    - _Depends on: 2.1_
    - _Requirements: 2.10, 3.1-3.2, 3.8, 3.11, 3.14-3.15, 4.1-4.3, 4.9-4.12, 4.14-4.16, 4.18-4.20_

  - [ ] 2.3 Add the shared authoritative room core and readiness lifecycle
    - Add `server/src/rooms/authoritative-room-core.ts` to own the pinned policy/tuning snapshot, mutation queue, roster/body/input maps, fixed-step lifecycle, authoritative state projection, failure handling, and idempotent world disposal.
    - Keep `server/src/rooms/fixed-step-scheduler.ts` as the only callback-to-fixed-step adapter and ensure room creation validates/logs mode, total capacity, and team capacity before any join.
    - Add `server/src/rooms/authoritative-room-core.test.ts` for policy mismatch rejection, readiness barriers, mutation ordering, authoritative-only state, empty-room cleanup, and room-fatal body-removal failure behavior.
    - _Depends on: 2.2_
    - _Requirements: 1.1-1.7, 2.8-2.10_

  - [ ] 2.4 Refactor Quick Match into a thin exact-3v3 policy adapter
    - Refactor `server/src/rooms/arena-room.ts` to register the immutable Quick policy, delegate all common state/physics work, admit at most six identities/three per team, balance deterministically, and remove only the disconnected identity and car.
    - Add `server/src/rooms/arena-room.test.ts` for duplicate/seventh-player rejection, stable 3+3 assignment, pre-active removal, active-play disconnect preservation, and unchanged-state assertions on every rejection.
    - Leave countdown progression to Stage 4 while exposing the exact full-balanced start predicate to the core.
    - _Depends on: 2.3_
    - _Requirements: 3.1-3.8, 3.11, 3.14-3.15, 18.12, 18.14_

  - [ ] 2.5 Refactor Custom Room into a thin up-to-8/4v4 policy adapter
    - Refactor `server/src/rooms/custom-room.ts` to retain room-code transport while delegating common state, enforce eight total/four per team, assign the first player as sole Host, validate waiting-only opposite-team switches, and reassign Host by Stable_Roster_Order.
    - Add `server/src/rooms/custom-room.test.ts` for duplicate/ninth-player rejection, one-team-full assignment, full-destination switch rejection, non-Host/invalid start rejection hooks, host succession, final-leave cleanup, and full atomic-state preservation.
    - Leave fixed-step countdown progression to Stage 4 while exposing Host-start and capacity-valid roster predicates.
    - _Depends on: 2.3_
    - _Requirements: 4.1-4.12, 4.14-4.16, 4.18-4.20, 18.15_

  - [ ] 2.6 Implement generated Property 2 coverage for deterministic team assignment
    - Add `server/src/systems/team-assignment.property.test.ts` using at least 100 generated capacity-valid join sequences from a recorded deterministic seed and the shared generator helper; report seed and ordered case on failure.
    - **Property 2: Deterministic team assignment**
    - **Validates: Requirements 3.3-3.6, 4.4-4.6**
    - _Depends on: 1.6, 2.1_
    - _Requirements: 3.3-3.6, 4.4-4.6, 18.25_

  - [ ] 2.7 Implement generated Property 1 coverage for mode policy and capacity invariants
    - Add `server/src/systems/room-capacity.property.test.ts` using at least 100 generated Quick/Custom operation prefixes per recorded deterministic seed, including boundaries at 6/3 and 8/4.
    - **Property 1: Mode policy and capacity invariants**
    - **Validates: Requirements 2.1-2.5, 2.8, 3.6-3.7, 4.7-4.8**
    - _Depends on: 1.6, 2.4, 2.5_
    - _Requirements: 2.1-2.5, 2.8, 3.6-3.7, 4.7-4.8, 18.12, 18.25_

  - [ ] 2.8 Implement generated Property 3 coverage for atomic roster mutations
    - Add `server/src/systems/room-mutations.property.test.ts` with at least 100 generated joins, leaves, switches, and starts per recorded deterministic seed; compare complete pre/post snapshots bit-for-bit whenever a request is rejected.
    - **Property 3: Atomic roster mutations**
    - **Validates: Requirements 2.10, 3.1-3.2, 3.8, 3.11, 3.14-3.15, 4.1, 4.3, 4.9-4.12, 4.14-4.15, 4.18-4.20**
    - _Depends on: 1.6, 2.4, 2.5_
    - _Requirements: 2.10, 3.1-3.2, 3.8, 3.11, 3.14-3.15, 4.1, 4.3, 4.9-4.12, 4.14-4.15, 4.18-4.20, 18.14-18.15, 18.25_

- [ ] 3. Introduce V2 eight-car transport and atomic client acceptance
  - [ ] 3.1 Implement the bounded ordered V2 snapshot builder
    - Add `server/src/systems/snapshot-builder.ts` to serialize Stable_Roster_Order into `cars[]`, own strictly increasing room-local snapshot and transition sequences, validate policy/team counts, recover finite bounded fields, and fail before broadcast on identity/count mismatch.
    - Project coherent regulation and terminal state: final scores, winner, terminal reason/result, and transition/event ID must agree, remain immutable through later Ended_State snapshots, and never be regenerated merely because another snapshot is emitted.
    - Add `server/src/systems/snapshot-builder.test.ts` for zero-through-capacity rooms, eight-car round trips, disconnect omission on the next snapshot, host metadata, finite bounds, deterministic order, sequence monotonicity, terminal coherence, and stable repeated terminal event IDs.
    - _Depends on: 1.5, 2.3_
    - _Requirements: 6.1-6.8, 13.14, 13.19, 13.25, 18.17_

  - [ ] 3.2 Add the client V2 decoder, validator, and temporary V1 adapter
    - Add `client/src/networking/snapshot-validator.ts` to decode unknown input, validate V2 protocol/policy/counts/unique identities/teams/phases/numbers/quaternions, normalize an immutable domain snapshot, and return typed errors without mutation.
    - Reject snapshots whose Ended_State score, winner, terminal reason/result, or transition/event ID is missing or incoherent, and require repeated snapshots of one committed terminal transition to retain the same immutable terminal payload.
    - Implement a temporary `LegacySnapshotV1` adapter for the current keyed record, deriving policy from the joined room type while still enforcing finite and sequence rules; never treat V1 as final release proof for duplicate identities or terminal event identity.
    - Add `client/tests/snapshot-validator.test.ts` for valid 6/8-car payloads, duplicate/over-capacity/policy/version/non-finite/coherence rejection, quaternion normalization, coherent terminal snapshots, repeated terminal IDs, and mixed-version migration behavior.
    - _Depends on: 1.5_
    - _Requirements: 6.10-6.12, 13.14, 13.19, 13.25_

  - [ ] 3.3 Add a single immutable accepted-snapshot store
    - Add `client/src/networking/accepted-snapshot-store.ts` with atomic commit/reset/subscription APIs for lobby, HUD, audio, camera, and entity lifecycle consumers.
    - Add `client/tests/accepted-snapshot-store.test.ts` for one commit notification, immutable reads, subscriber isolation, generation-safe room reset, and no notification on rejected candidates.
    - _Depends on: 3.2_
    - _Requirements: 6.9-6.12_

  - [ ] 3.4 Refactor scene reconciliation into prepare-and-commit acceptance
    - Refactor `client/src/networking/state-listener.ts` to validate before keying identities, ask the interpolation buffer to accept the candidate, prepare car additions/removals without touching the scene, and commit the buffer/store/local state/mesh ownership together.
    - Support exactly one rendered car per accepted identity through eight cars; dispose temporary resources on preparation failure and preserve the prior sequence, buffer, meshes, HUD/camera/audio inputs, and scene on any rejection.
    - Add `client/tests/state-listener.test.ts` with atomic-state assertions for duplicate, over-capacity, malformed, sequence-regressed, and mesh-preparation failures plus eight-car add/update/remove and leave/reconnect cleanup.
    - _Depends on: 3.2, 3.3_
    - _Requirements: 6.9-6.12_

  - [ ] 3.5 Switch both room adapters and the client connection path to V2
    - Wire `server/src/rooms/authoritative-room-core.ts`, `server/src/rooms/arena-room.ts`, and `server/src/rooms/custom-room.ts` to `SnapshotBuilder`, and update `client/src/networking/client.ts` to pass joined room mode into decoding.
    - Keep the V1 adapter only for migration, verify unsupported versions are never partially applied, and add server/client integration tests for maximum-capacity Custom transport, post-disconnect omission, and coherent repeated terminal score/winner/reason/transition snapshots.
    - _Depends on: 2.4, 2.5, 3.1, 3.4_
    - _Requirements: 6.2-6.12, 13.14, 13.19, 13.25, 18.17_

  - [ ] 3.6 Preserve and extend scheduler/interpolation baselines for V2 epochs
    - Refine `server/src/rooms/fixed-step-scheduler.ts` only as needed to expose its bounded remainder and finite scheduling-tolerance decisions while retaining exact `1/60`, `0.1` clamp, five-step cap, and independent snapshot cadence.
    - Refactor `client/src/networking/interpolation-buffer.ts` to accept validated immutable timelines and treat kickoff-epoch changes as teleport boundaries without changing the 24-snapshot, 100-millisecond delay, shortest-path quaternion, or 80-millisecond extrapolation behavior.
    - Extend `server/src/rooms/fixed-step-scheduler.test.ts` and `client/tests/interpolation-buffer.test.ts` for negative/non-finite deltas, admissible snapshot tolerance, greatest-sequence retention, epoch rebasing, bounded hold, and unchanged baseline semantics.
    - _Depends on: 1.5_
    - _Requirements: 1.4-1.12, 6.8_

  - [ ] 3.7 Implement generated Property 7 coverage for snapshot round trip and identity completeness
    - Add `server/src/systems/snapshot-builder.property.test.ts` with at least 100 generated valid rosters/snapshots per recorded seed across both room modes; serialize/deserialize and verify identity-associated fields, finite bounds, disconnect omission, and coherent terminal final score, winner, reason, and stable event ID across repeated snapshots.
    - **Property 7: Snapshot round trip and identity completeness**
    - **Validates: Requirements 6.1-6.8, 13.14, 13.19, 13.25, 18.17**
    - _Depends on: 1.6, 3.1, 3.5_
    - _Requirements: 6.1-6.8, 13.14, 13.19, 13.25, 18.17, 18.25_

  - [ ] 3.8 Implement generated Property 8 coverage for atomic client acceptance and rejection
    - Add `client/tests/snapshot-acceptance.property.test.ts` with at least 100 generated valid and malformed payloads per recorded seed; snapshot every committed client subsystem before rejection and require exact preservation.
    - **Property 8: Atomic client snapshot acceptance and rejection**
    - **Validates: Requirements 6.9-6.12**
    - _Depends on: 1.6, 3.4, 3.5_
    - _Requirements: 6.9-6.12, 18.25_

  - [ ] 3.9 Implement generated Property 25 coverage for transport and interpolation bounds
    - Add `client/tests/transport-interpolation.property.test.ts` with at least 100 generated increasing snapshot streams and callback partitions per recorded seed, checking nominal cadence independence, 24 greatest sequences, 100-millisecond delay, shortest-path normalized slerp, and 80-millisecond extrapolation hold.
    - **Property 25: Bounded transport and interpolation baseline**
    - **Validates: Requirements 1.8-1.12, 6.8**
    - _Depends on: 1.6, 3.5, 3.6_
    - _Requirements: 1.8-1.12, 6.8, 18.25_

- [ ] 4. Add deterministic kickoff slots and simulation-time pre-play phases
  - [ ] 4.1 Define four mirrored, team-facing slots per team
    - Add `shared/src/geometry/kickoff-slots.ts` with four canonical Blue transforms and derived Orange mirrors, stable slot IDs, finite bounds, center-facing validation within one degree, and registry-backed collider dimensions.
    - Add `shared/tests/kickoff-slots.test.ts` for four slots per team, exact mirroring, facing, arena containment, and structural rejection of incomplete/invalid tables.
    - _Depends on: 1.3, 1.4_
    - _Requirements: 5.1-5.4_

  - [ ] 4.2 Implement complete deterministic kickoff assignment
    - Add `server/src/systems/kickoff-slots.ts` to map team-local Stable_Roster_Order index `i` to slot `i`, validate a complete bijection, perform cross-team oriented-box overlap checks, and retain the prior complete assignment until an atomic replacement is valid.
    - Add `server/src/systems/kickoff-slots.test.ts` for one-through-four players per team, outsiders/duplicates, changed rosters, repeated inputs, and unchanged-epoch assignment reuse.
    - _Depends on: 2.2, 4.1_
    - _Requirements: 5.5-5.12_

  - [ ] 4.3 Integrate kickoff epochs and atomic placements into the room core
    - Refactor `server/src/rooms/authoritative-room-core.ts` and the reset compatibility path in `server/src/systems/scoring.ts` so no body moves until every current roster identity has a valid slot; cache assignments by roster/team/order and zero body motion atomically at placement.
    - Add integration tests proving three Quick teammates and four Custom teammates receive distinct transforms, unchanged goal resets preserve mappings, and replacement failure leaves the last complete assignment and bodies untouched.
    - _Depends on: 3.5, 4.2_
    - _Requirements: 5.5-5.12_

  - [ ] 4.4 Replace wall-clock countdown/reset logic with a pure fixed-step match-state reducer skeleton
    - Add `server/src/systems/match-flow.ts` and replace `server/src/systems/match-timer.ts` behavior with typed states, integer `regulationStepsRemaining`, 180-step kickoff countdowns, registry-derived goal-reset steps, disabled-control gates, regulation preservation, frozen overtime-countdown state, immutable Ended_State fields, and transition results that take effect only after the completing step.
    - Initialize the first regulation countdown with exactly 18,000 future regulation Active_Play steps, share the same confirmed rule object across Quick and Custom, and retain hooks for the finalized above-zero, Hard_Regulation_Cutoff, and sudden-death outcomes completed in Task 6.4.
    - Add `server/src/systems/match-flow.test.ts` for exactly 180 countdown steps, exactly 120 reset steps at the 2-second starting hypothesis, no early Active_Play, preserved scores/regulation time, disabled controls, edge synchronization, deterministic reset output, frozen overtime kickoff state, and immutable Ended_State projection.
    - _Depends on: 1.4, 2.3_
    - _Requirements: 13.1-13.8, 13.15-13.16, 13.22-13.23, 18.22-18.23_

  - [ ] 4.5 Wire Quick cancellation and Custom Host start into fixed-step phases
    - Remove room-owned countdown intervals from `server/src/rooms/arena-room.ts` and `server/src/rooms/custom-room.ts`; route start/cancel/disconnect events through `AuthoritativeRoomCore` and `MatchFlowReducer`.
    - Implement one fresh Quick countdown only at exact 3+3, cancellation below six before play, full restart when restored, Host-only Custom start for a capacity-valid roster, and countdown preservation after Custom Host succession.
    - Extend room integration tests with exact countdown values, reopened Quick admission, non-Host rejection atomicity, and active-play disconnect preservation.
    - _Depends on: 2.4, 2.5, 4.3, 4.4_
    - _Requirements: 3.9-3.15, 4.13-4.17, 13.5-13.7, 18.13-18.15_

  - [ ]* 4.6 Add evidence-backed proximity-sensitive kickoff selection
    - Extend `shared/src/geometry/kickoff-slots.ts` and `server/src/systems/kickoff-slots.ts` only after a deterministic proximity-selection rule and evidence are approved; preserve the stable unique-spawn fallback.
    - Add focused generated and example tests proving proximity choice never breaks team facing, bijection, repeatability, or collider separation, then remove only the matching feature-status deferral.
    - _Depends on: 4.2, 4.3_
    - _Requirements: 5.13_

  - [ ] 4.7 Implement generated Property 6 coverage for kickoff bijection and unique spawn
    - Add `server/src/systems/kickoff-slots.property.test.ts` and enumerate every capacity-valid team-size/order shape plus at least 100 generated identity/order cases per recorded seed; verify mirroring, facing, OBB separation, completeness, and repeatability.
    - **Property 6: Deterministic kickoff-slot bijection and unique spawn**
    - **Validates: Requirements 5.1-5.12, 18.16**
    - _Depends on: 1.6, 4.3_
    - _Requirements: 5.1-5.12, 18.16, 18.25_

  - [ ] 4.8 Implement generated Property 4 coverage for Quick countdown gating
    - Add `server/src/rooms/quick-countdown.property.test.ts` with at least 100 generated pre-active roster sequences per recorded seed, checking iff start gating, cancellation before play, and full-duration restart.
    - **Property 4: Quick Match countdown gate and cancellation**
    - **Validates: Requirements 3.9-3.13, 18.13**
    - _Depends on: 1.6, 4.5_
    - _Requirements: 3.9-3.13, 18.13, 18.25_

  - [ ] 4.9 Implement generated Property 5 coverage for Custom Host authority and succession
    - Add `server/src/rooms/custom-host.property.test.ts` with at least 100 generated waiting/countdown rosters and requests per recorded seed; assert sole-Host start authority, deterministic succession, rejection atomicity, and countdown preservation.
    - **Property 5: Custom Host authority and succession**
    - **Validates: Requirements 4.2, 4.13-4.17**
    - _Depends on: 1.6, 4.5_
    - _Requirements: 4.2, 4.13-4.17, 18.15, 18.25_

  - [ ] 4.10 Implement generated Property 14 coverage for kickoff and reset timing
    - Add `server/src/systems/match-flow-timing.property.test.ts` with at least 100 generated callback partitions and legal phase states per recorded seed; require 180/120 completed fixed steps, disabled controls, deterministic restoration, preserved scores/regulation time, and no early Active_Play.
    - **Property 14: Fixed-step kickoff and reset timing**
    - **Validates: Requirements 13.3, 13.5-13.8, 13.15-13.16, 18.22-18.23**
    - _Depends on: 1.6, 4.5_
    - _Requirements: 13.3, 13.5-13.8, 13.15-13.16, 18.22-18.23, 18.25_

  - [ ] 4.11 Checkpoint the room, transport, kickoff, and timing increment
    - Run the focused shared/server/client tests added in Stages 1-4, `npm run typecheck`, and `npm run build`; resolve only feature-caused failures before physics replacement begins.
    - Confirm V2 maximum-capacity and terminal-aware transport, all rejection atomicity assertions, exact 3+3/8+4 limits, deterministic kickoff mappings, and 180/120-step tests pass together.
    - Ensure all tests pass, ask the user if questions arise.
    - _Depends on: 2.6, 2.7, 2.8, 3.5, 3.6, 3.7, 3.8, 3.9, 4.5, 4.7, 4.8, 4.9, 4.10_
    - _Requirements: 1.4-1.12, 2.1-2.10, 3.1-3.15, 4.1-4.20, 5.1-5.12, 6.1-6.12, 13.1-13.8, 13.15-13.16, 13.22-13.23_

- [ ] 5. Replace legacy mechanics with metric bodies, scripted control, and Core grounding
  - [ ] 5.1 Build metric Rapier bodies and finite-state recovery
    - Add `server/src/physics/car-body.ts` and `server/src/physics/finite-state.ts`; refactor `server/src/physics/world.ts`, `server/src/physics/ball.ts`, and the compatibility facade in `server/src/physics/car.ts` for gravity `(0,-6.5,0)`, a plain 150 kg box car, a 0.9125 m/25 kg/0.60 ball, CCD, registry damping, last-finite recovery, and post-step speed/angular caps.
    - Extend `server/src/physics/test-ball.ts`, `test-car.ts`, and `test-impact.ts` for exact construction, 6:1 mass ratio, finite fallback, caps, collision-owned ball spin, and zero additional scripted ball angular impulse.
    - Wrap every Rapier world/body setup in `try/finally`, free all created resources after success, assertion failure, or setup failure, and add a cleanup assertion or tracked disposal spy.
    - _Depends on: 1.4, 4.11_
    - _Requirements: 7.1-7.12, 11.1-11.11, 18.7, 18.11, 18.26_

  - [ ] 5.2 Implement speed-dependent throttle, boost actuation, drag, and propulsion bounds
    - Add `server/src/physics/car-controller.ts` with pure command planning for the validated non-increasing throttle curve, normalized input scaling, zero positive throttle acceleration at/above 14.1 m/s, exact 9.91666 m/s² local-forward boost in air or on ground, optional opposite-motion drag, and 23 m/s propulsion projection.
    - Add focused controller unit tests and Rapier traces in `server/src/physics/test-controller.ts` for sub-target acceleration, target cutoff, boost direction, finite fallback, and speed limits; free all Rapier resources in `finally`.
    - Keep inventory ownership separate for Stage 7 while accepting an authoritative available-boost amount as controller input.
    - _Depends on: 5.1_
    - _Requirements: 8.1-8.10, 8.17_

  - [ ] 5.3 Implement grounded steering, lateral grip, and powerslide
    - Extend `server/src/physics/car-controller.ts` with surface-normal steering curvature, finite yaw decay, exponential lateral grip, lower powerslide grip, greater same-direction powerslide curvature, and no simulated wheel-torque propulsion.
    - Add deterministic unit/Rapier cases in `server/src/physics/test-controller.ts` for monotonic lateral decay, equal-state normal/powerslide ordering, zero-steer yaw decay, curve bounds, and no speed-cap bypass; retain `try/finally` cleanup.
    - _Depends on: 5.2_
    - _Requirements: 7.4, 8.11-8.16_

  - [ ] 5.4 Implement jump/flip/air state and expanded client controls
    - Extend `server/src/physics/car-controller.ts` with per-car consumed edge state, first jump, bounded hold, inclusive second-jump window, directional flip/deadzone/window, stale/late edge consumption, grounded reset, local-axis pitch/yaw/roll, and combined 5.5 rad/s bound.
    - Refactor `client/src/input/input-controller.ts` and `client/src/input/keyboard-handler.ts` to emit V2 powerslide/air axes and monotonic edges while retaining editable-target rules, neutral synchronization, and the 250-millisecond heartbeat.
    - Extend `server/src/physics/test-jump-sequence.ts` and `client/tests/input-controller.test.ts` for before/at/after boundaries, held/released jump, repeated heartbeats, malformed-axis neutrality, grounded-vs-air mapping, and Rapier cleanup in `finally`.
    - _Depends on: 1.2, 5.3_
    - _Requirements: 9.1-9.17, 18.5-18.6_

  - [ ] 5.5 Implement local-down grounding for Core surfaces
    - Add `server/src/physics/grounding.ts` with at least four registry-configured footprint points, Local_Down rays, static non-sensor filtering, Core surface tags, distance/normal thresholds, deterministic sorted normal combination, and no stale support when all rays miss.
    - Refactor `server/src/physics/arena.ts` only enough to tag the current floor, lower ramps, and solid goal-interior Core surfaces; keep Advanced surfaces capability-gated and explicitly disabled for the staging increment.
    - Add `server/src/physics/test-grounding.ts` for rotated cars, floor/ramp/goal support, adjacent surfaces, dynamic/ball/sensor/disabled exclusions, all-miss airborne behavior, surface-relative commands, and guaranteed Rapier cleanup.
    - _Depends on: 1.3, 5.1_
    - _Requirements: 10.1-10.5, 10.10-10.12, 18.19, 18.26_

  - [ ] 5.6 Wire the ordered scripted simulation pipeline into the room core
    - Refactor `server/src/rooms/authoritative-room-core.ts` to execute mutation drain, phase gate, input recovery, body recovery, grounding, Stable_Roster_Order command planning, Rapier step, post-step bounds, event extraction, match reduction, and schema projection in the exact design order.
    - Remove legacy duplicated control logic from room adapters while retaining `server/src/physics/car.ts` only as a temporary harness-compatible facade.
    - Add room/physics integration tests for authoritative input-only behavior, disabled-phase edge synchronization, local-forward airborne boost, finite snapshots, and cleanup when a simulation test fails.
    - _Depends on: 4.5, 5.2, 5.3, 5.4, 5.5_
    - _Requirements: 1.1-1.3, 7.8-7.12, 8.4-8.17, 9.4-9.17, 10.3-10.5, 10.11-10.12, 11.9-11.11_

  - [ ] 5.7 Implement generated Property 23 coverage for physics construction and collision-owned spin
    - Add `server/src/physics/physics-construction.property.test.ts` with at least 100 generated body/world configurations inside validated ranges per recorded seed, exact construction assertions, contact traces, and `try/finally` resource cleanup.
    - **Property 23: Physics construction and collision-owned ball spin**
    - **Validates: Requirements 7.1-7.7, 11.1-11.10, 18.7**
    - _Depends on: 1.6, 5.6_
    - _Requirements: 7.1-7.7, 11.1-11.10, 18.7, 18.25-18.26_

  - [ ] 5.8 Implement generated Property 9 coverage for throttle monotonicity and scaling
    - Add `server/src/physics/throttle.property.test.ts` with at least 100 generated finite speeds and normalized inputs per recorded seed, including exact target boundaries and boost/no-boost cases.
    - **Property 9: Throttle curve monotonicity and input scaling**
    - **Validates: Requirements 8.4-8.7, 18.1-18.2**
    - _Depends on: 1.6, 5.6_
    - _Requirements: 8.4-8.7, 18.1-18.2, 18.25_

  - [ ] 5.9 Implement generated Property 11 coverage for grip and powerslide ordering
    - Add `server/src/physics/grip-powerslide.property.test.ts` with at least 100 generated grounded velocities, speeds, normals, and steering inputs per recorded seed; require finite lateral decay and strict configured ordering.
    - **Property 11: Grip and powerslide ordering**
    - **Validates: Requirements 8.11-8.16, 18.3-18.4**
    - _Depends on: 1.6, 5.6_
    - _Requirements: 8.11-8.16, 18.3-18.4, 18.25_

  - [ ] 5.10 Implement generated Property 13 coverage for local-down grounding
    - Add `server/src/physics/grounding.property.test.ts` with at least 100 generated car orientations/contact sets per recorded seed; exercise enabled Core surfaces and rejected dynamic/sensor/disabled/all-miss cases, record deterministic normals, and free every world in `finally`.
    - **Property 13: Local-down grounding classification**
    - **Validates: Requirements 10.1-10.5, 10.10-10.12, 18.19**
    - _Depends on: 1.6, 5.6_
    - _Requirements: 10.1-10.5, 10.10-10.12, 18.19, 18.25-18.26_

  - [ ] 5.11 Implement generated Property 10 coverage for finite output and speed bounds
    - Add `server/src/physics/finite-bounds.property.test.ts` with at least 100 generated finite/non-finite input, tuning, and observed-state cases per recorded seed; verify every exposed scalar/vector and all car/ball caps after recovery.
    - **Property 10: Finite authoritative output and body speed bounds**
    - **Validates: Requirements 7.8-7.12, 8.10, 9.16, 11.4-11.5, 11.11, 18.11**
    - _Depends on: 1.6, 5.6_
    - _Requirements: 7.8-7.12, 8.10, 9.16, 11.4-11.5, 11.11, 18.11, 18.25_

  - [ ] 5.12 Implement generated Property 19 coverage for server authority preservation
    - Add `server/src/rooms/server-authority.property.test.ts` with at least 100 generated valid controls plus forged transform/contact/inventory/score/team/phase fields per recorded seed; compare the next authoritative snapshot to a control-only run.
    - **Property 19: Server authority preservation**
    - **Validates: Requirements 1.1-1.3, 18.18**
    - _Depends on: 1.6, 5.6_
    - _Requirements: 1.1-1.3, 18.18, 18.25_

- [ ] 6. Build the metric closed arena, swept goals, and complete match flow
  - [ ] 6.1 Generate the closed Rapier arena and solid goal interiors from the shared spec
    - Refactor `server/src/physics/arena.ts` to build exact floor, ramps, side/end walls, four corner cuts, transitions, ceiling, goal floor/sides/roof/back, openings, and semantic contact metadata from `ArenaGeometrySpec`.
    - Replace obsolete goal sensors where they conflict with center-plane scoring, retain only required sensors such as pads, and add `server/src/physics/test-metric-arena.ts` for exact extents, closed containment through 60 m/s, solid goal interiors, openings, Core tags, and resource cleanup in `finally`.
    - _Depends on: 5.6_
    - _Requirements: 12.1-12.9, 12.15, 18.8, 18.26_

  - [ ] 6.2 Align visible authoritative boundaries to the shared arena spec
    - Refactor `client/src/renderer/arena.ts` to derive field, ramps, containment, corners, and goal tunnels from `ArenaGeometrySpec` while preserving completed stadium art, lighting, materials, and effects around those boundaries.
    - Extend `client/tests/stadium-camera-effects.test.ts` with resolved world-space comparisons requiring every authoritative visible boundary to lie within 0.05 m of its collision descriptor.
    - _Depends on: 1.3, 3.4_
    - _Requirements: 1.15, 12.10_

  - [ ] 6.3 Replace goal occupancy with swept ball-center crossing
    - Add `server/src/systems/goal-crossing.ts` and refactor `server/src/systems/scoring.ts` to track previous center, per-plane field-side arming, segment-plane intersection, centered opening bounds, and one-score-per-kickoff-epoch suppression.
    - Extend `server/src/physics/test-goal-tunnel.ts` and add pure `server/src/systems/goal-crossing.test.ts` cases for on-plane, outside-opening, unarmed teleport, both goal planes, high-speed crossing, and rearming; free Rapier resources in `finally`.
    - _Depends on: 6.1_
    - _Requirements: 12.11-12.14, 18.9, 18.26_

  - [ ] 6.4 Complete the pure regulation, atomic cutoff, and sudden-death outcome reducer
    - Extend `server/src/systems/match-flow.ts` with one shared Quick/Custom ruleset: 300 seconds represented by exactly 18,000 regulation Active_Play fixed steps, `Regulation_Goal_Target = 6`, `Regulation_Win_Margin = 2`, and non-negative scores with no match-rule cap.
    - For every valid above-zero regulation goal, increment the scorer exactly once and enter Ended_State if and only if the updated scorer has at least six goals and leads by at least two; otherwise enter Goal_Reset_State with the updated scores and remaining regulation steps preserved.
    - In the fixed step that first reaches zero, apply a valid same-step goal exactly once before Hard_Regulation_Cutoff compares scores. Unequal scores must immediately produce an immutable terminal result for the leader regardless of target or margin; equal scores must atomically preserve the tie, restore deterministic kickoff entities with zero velocities, and create a fresh frozen 180-step Golden_Goal_Overtime countdown.
    - Return an explicit scheduler halt signal at cutoff, keep the overtime countdown frozen at deterministic transforms with controls disabled, make active overtime untimed, and make its first valid goal increment once and transition directly to immutable Ended_State without a reset or additional kickoff.
    - Add reducer examples for terminal above-zero `6-4`, `7-5`, and `8-6`; non-terminal/reset `5-3`, `6-5`, `6-6`, and `7-6`; cutoff leaders `5-4`, `5-3`, and `6-5`; a tied cutoff; high uncapped scores; untimed overtime; first-overtime-goal termination; and repeated Ended_State reduction preserving final score, winner, reason, and event ID.
    - _Depends on: 4.4, 6.3_
    - _Requirements: 13.1-13.25, 18.21, 18.27-18.38_

  - [ ] 6.5 Integrate goal epochs, cutoff halting, terminal snapshots, and match outcomes
    - Refactor `server/src/rooms/authoritative-room-core.ts` to apply swept goals once, decrement regulation by completed Active_Play fixed steps, pass the same-step validated goal into the pure reducer, commit one atomic transition, reset deterministic entities only when directed, and suppress goal rearming until the next kickoff epoch.
    - Honor the reducer halt signal so no later substep, callback, or queued input is processed as regulation after Hard_Regulation_Cutoff; during the overtime countdown process no gameplay controls or car/ball physics and preserve deterministic transforms plus zero linear/angular velocities.
    - Freeze gameplay controls and authoritative car/ball physics throughout Ended_State, and project one coherent immutable terminal payload—final score, winner, terminal reason/result, and stable transition/event ID—into every later snapshot without replaying the transition.
    - Add room integration tests for non-winning regulation reset/countdown, direct above-zero terminal wins, exact 18,000-step cutoff, same-step goal-before-cutoff comparison, unequal and tied cutoff paths, frozen 180-step overtime kickoff, untimed overtime, immediate first-overtime-goal end, no post-cutoff regulation work, immutable later Ended snapshots, disconnect preservation, and closed-volume behavior.
    - _Depends on: 5.6, 6.1, 6.2, 6.3, 6.4_
    - _Requirements: 11.9-11.10, 12.11-12.15, 13.1-13.25, 18.21, 18.27-18.38_

  - [ ] 6.6 Implement generated Property 24 coverage for arena closure and renderer alignment
    - Add `server/src/physics/arena-geometry.property.test.ts` and complementary client geometry assertions with at least 100 generated boundary samples/ball trajectories per recorded seed; require exact dimensions, closed containment, solid goals, and 0.05 m render alignment, with Rapier cleanup.
    - **Property 24: Arena geometry closure and renderer alignment**
    - **Validates: Requirements 12.1-12.10, 12.15, 18.8**
    - _Depends on: 1.6, 6.1, 6.2_
    - _Requirements: 12.1-12.10, 12.15, 18.8, 18.25-18.26_

  - [ ] 6.7 Implement generated Property 15 coverage for goal-line crossing semantics
    - Add `server/src/systems/goal-crossing.property.test.ts` with at least 100 generated ball-center segments/opening intersections per recorded seed; require exactly one valid score and no score for every invalid/unarmed/suppressed case.
    - **Property 15: Goal-line crossing semantics**
    - **Validates: Requirements 12.11-12.14, 18.9**
    - _Depends on: 1.6, 6.3, 6.5_
    - _Requirements: 12.11-12.14, 18.9, 18.25_

  - [ ] 6.8 Implement generated Property 18 coverage for above-zero target-and-margin outcomes
    - Add `server/src/systems/match-flow-above-zero.property.test.ts` with at least 100 generated representable non-negative score pairs per recorded seed for both room modes; apply one valid goal with regulation time still above zero and verify one uncapped increment followed by Ended_State if and only if the updated scorer score is at least six and its lead is at least two.
    - Include exact terminal cases `6-4`, `7-5`, and `8-6`; exact Goal_Reset_State cases `5-3`, `6-5`, `6-6`, and `7-6`; tied/one-goal-lead cases; and high-score cases on both sides of the predicate. Require one terminal result for wins and preserved updated scores for resets.
    - **Property 18: Above-zero regulation goals obey target and margin without a score cap**
    - **Validates: Requirements 13.9-13.16, 18.27-18.31, 18.37**
    - _Depends on: 1.6, 6.4, 6.5_
    - _Requirements: 13.9-13.16, 18.27-18.31, 18.37, 18.25_

  - [ ] 6.9 Implement generated Property 26 coverage for atomic Hard_Regulation_Cutoff
    - Add `server/src/systems/hard-regulation-cutoff.property.test.ts` with at least 100 deterministic seeded regulation executions and same-step event bundles across Quick and Custom; require cutoff after exactly 18,000 regulation Active_Play fixed steps and never earlier when no above-zero target-and-margin win occurs.
    - Verify a valid goal from the cutoff step is applied exactly once before comparison; unequal results—including `5-4`, `5-3`, and `6-5`—end immediately with the leader regardless of target/margin, while ties atomically restore deterministic kickoff entities and start a fresh frozen 180-step overtime countdown.
    - Verify the cutoff halt signal permits zero later regulation controls and zero later regulation Rapier steps, and that terminal/tied transition IDs remain stable across repeated snapshots.
    - **Property 26: Hard regulation cutoff is same-step, atomic, and final for regulation**
    - **Validates: Requirements 13.1-13.2, 13.17-13.23, 18.21, 18.32-18.34, 18.37-18.38**
    - _Depends on: 1.6, 3.5, 6.4, 6.5_
    - _Requirements: 13.1-13.2, 13.17-13.23, 18.21, 18.32-18.34, 18.37-18.38, 18.25_

  - [ ] 6.10 Implement generated Property 27 coverage for first-goal-wins overtime
    - Add `server/src/systems/overtime-sudden-death.property.test.ts` with at least 100 deterministic seeded overtime states for both room modes and representable score/margin combinations.
    - Verify goal-free active overtime remains untimed, while the first valid goal increments only the scorer exactly once and transitions directly to Ended_State with that team as winner regardless of target, margin, or total score, with no Goal_Reset_State or additional countdown.
    - Require later inputs and snapshots to preserve the immutable terminal result and stable event ID without additional control, physics, score, or transition work.
    - **Property 27: First overtime goal wins immediately**
    - **Validates: Requirements 13.24-13.25, 18.35-18.37**
    - _Depends on: 1.6, 3.5, 6.4, 6.5_
    - _Requirements: 13.24-13.25, 18.35-18.37, 18.25_

  - [ ] 6.11 Implement generated Property 16 coverage for fixed-step partition determinism
    - Extend `server/src/rooms/fixed-step-scheduler.test.ts` or add `fixed-step-determinism.property.test.ts` with at least 100 recorded-seed pairs of equal accepted elapsed-time partitions that avoid clamping/drop; compare step counts and authoritative state within `1e-5`.
    - **Property 16: Fixed-step partition determinism**
    - **Validates: Requirements 1.4-1.7, 18.10**
    - _Depends on: 1.6, 3.6, 6.5_
    - _Requirements: 1.4-1.7, 18.10, 18.25_

  - [ ] 6.12 Checkpoint the metric mechanics, arena, goal, and finalized match-flow increment
    - Run all focused Node tests, every existing and new Rapier harness separately, `npm run typecheck`, and `npm run build`; each physics process must exit zero and prove disposal on all harness outcomes.
    - Require exact dimensions/masses/timing, finite bounds, deterministic partitioning, above-zero 6-goal/two-goal-margin boundaries, uncapped high scores, exact 18,000-step atomic cutoff, same-step goal ordering, no later regulation work, frozen overtime kickoff, untimed sudden death, immutable Ended_State snapshots, and stadium alignment to pass together for Quick and Custom.
    - Ensure all tests pass, ask the user if questions arise.
    - _Depends on: 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11_
    - _Requirements: 7.1-7.12, 8.1-8.17, 9.1-9.17, 10.1-10.5, 10.10-10.12, 11.1-11.11, 12.1-12.15, 13.1-13.25, 18.1-18.11, 18.19, 18.21-18.38_

- [ ] 7. Implement bounded boost inventory and staged arena pads
  - [ ] 7.1 Complete authoritative boost inventory lifecycle
    - Add exact kickoff initialization to 33, fixed-step consumption at 33.3 units/second, proportional final partial-step acceleration, `[0,100]` clamping, and no passive recharge in `server/src/physics/car-controller.ts` and `server/src/rooms/authoritative-room-core.ts`.
    - Add unit/integration tests for empty/full/fractional inventory, disabled phases, no-pickup preservation, airborne local-forward boost, and snapshot/HUD precision boundaries.
    - _Depends on: 5.6, 6.12_
    - _Requirements: 8.8-8.10, 14.1-14.5_

  - [ ] 7.2 Add the generic pad system and all six Large pad specs
    - Add `shared/src/geometry/boost-pads.ts` with six registry-backed Large pad positions/hitboxes and generic Small-kind support, plus `server/src/systems/boost-pads.ts` for active state, stable same-step contention, grants, and exact 600/240-step respawn semantics.
    - Add pure tests for unique IDs, arena-bounded finite specs, 100/12 grants, inactive contact, exact respawn boundaries, and Stable_Roster_Order contention; configure exactly six Large pads and no false Small milestone claim.
    - _Depends on: 1.3, 1.4, 7.1_
    - _Requirements: 14.6, 14.8-14.16_

  - [ ] 7.3 Integrate pad sensors, authoritative state, rendering, and Rapier harnesses
    - Refactor `server/src/physics/arena.ts` and `server/src/rooms/authoritative-room-core.ts` to create pad sensors, reactivate before contact resolution at the target step, collect intersections after Rapier, award one eligible car, and expose pad state needed by presentation.
    - Add `client/src/renderer/boost-pads.ts` and wire it through `client/src/main.ts` without granting gameplay authority.
    - Add `server/src/physics/test-boost-pads.ts` for six-Large layout, contact, contention, disabled-phase behavior, exact respawn, and `try/finally` world/resource cleanup.
    - _Depends on: 3.5, 6.1, 7.2_
    - _Requirements: 14.6, 14.8-14.16, 18.20, 18.26_

  - [ ]* 7.4 Add and validate the complete 28-Small-pad layout
    - Extend `shared/src/geometry/boost-pads.ts`, server sensors, client pad rendering, and layout tests with exactly 28 evidence-backed Small pad coordinates/hitboxes while retaining all six Large pads.
    - Add containment/layout audit, pickup/respawn integration coverage, and browser visibility/feedback assertions; update feature status only after every Small pad passes.
    - _Depends on: 7.3_
    - _Requirements: 14.7, 14.9, 14.11-14.13, 14.17_

  - [ ] 7.5 Implement generated Property 17 coverage for boost inventory and pad lifecycle
    - Add `server/src/systems/boost-pads.property.test.ts` with at least 100 generated inventories, input runs, pad states, contact sets, and step boundaries per recorded seed; include generic Small behavior even when its full layout remains staged and free Rapier fixtures in `finally`.
    - **Property 17: Boost inventory and pad lifecycle**
    - **Validates: Requirements 14.1-14.5, 14.8-14.14, 18.20**
    - _Depends on: 1.6, 7.3_
    - _Requirements: 14.1-14.5, 14.8-14.14, 18.20, 18.25-18.26_

- [ ] 8. Deliver Ball/Car cameras, accessible lobby/HUD, and baseline integration
  - [ ] 8.1 Implement local Ball and Car camera modes with edge toggles
    - Refactor `client/src/renderer/camera-controller.ts` for lobby orbit plus gameplay `ball`/`car` modes, default Ball Camera before the first Active_Play frame, interpolated ball targeting, local-car anchoring, finite registry-validated spring/FOV bounds, and kickoff-epoch rebasing without cross-teleport history.
    - Wire monotonic `cameraToggleSequence` from `client/src/input/input-controller.ts` without sending camera authority to the server; add `client/tests/camera-controller.test.ts` for first-frame default, one transition per edge, held/released deduplication, finite bounds, invalid all-or-nothing configuration, and mode-preserving teleports.
    - _Depends on: 1.4, 3.4, 5.4_
    - _Requirements: 15.1-15.11_

  - [ ] 8.2 Implement the off-screen ball indicator projection
    - Add `client/src/hud/ball-indicator.ts` with pure clip/camera-space projection, behind-camera handling, inset viewport-edge intersection, finite fallback, and hidden in-viewport output.
    - Add `client/tests/ball-indicator.test.ts` for each edge/corner, behind-camera direction, viewport containment, resize behavior, and no obstruction of the center safe zone.
    - _Depends on: 3.4_
    - _Requirements: 16.6-16.8_

  - [ ] 8.3 Refactor lobby and HUD around accepted policy, match, and transition state
    - Refactor `client/src/ui/lobby.ts`, `client/src/ui/lobby-state.ts`, and `client/src/hud/hud.ts` to subscribe to `AcceptedSnapshotStore`, show Quick 6/3 and Custom 8/4 occupancy, Host/switch/rejection state, score/timer/overtime/boost/camera mode, countdown/goal notices, terminal results, and off-screen indicator state.
    - Reduce each stable authoritative transition/event ID exactly once into one composite visual notice and one `aria-live="polite"` update. Cover non-winning regulation goals, terminal above-zero goals, unequal cutoff at `0:00`, tied cutoff plus the fresh overtime countdown, and first-overtime-goal winner; repeated snapshots must emit nothing again.
    - Add accessible names/current values, text/shape team distinctions, 4.5:1 contrast, central 20% safe-zone placement, pairwise non-overlap at 1280x720 and larger, and immutable Ended_State score/winner presentation.
    - Extend `client/tests/lobby-input.test.ts` and add `client/tests/hud-accessibility.test.ts` for capacities, exact outcome notices, composite announcement contents, event-ID deduplication, contrast tokens, viewport layout, cancellation, overtime, and terminal transitions.
    - _Depends on: 3.3, 4.5, 6.5, 7.1, 8.1, 8.2_
    - _Requirements: 2.6-2.7, 16.1-16.20_

  - [ ] 8.4 Wire presentation order, transition-ID audio, stadium, and entity lifecycle
    - Refactor `client/src/main.ts` to order each frame as accepted snapshot/interpolation, entity/pad effects, camera, HUD, completed audio consumption, and render; do not reimplement procedural audio or add client authority.
    - Adapt completed `client/src/audio/audio-manager.ts`/`audio-model.ts` only at their accepted-state boundary so rejected snapshots and uncommitted meshes remain invisible, and key every goal/cutoff/overtime/terminal cue to the same stable authoritative transition/event ID used by the HUD.
    - Ensure a terminal goal can layer goal/win sound components while still counting as exactly one transition consumption, and ensure repeated snapshots, frozen overtime countdown frames, and later Ended_State snapshots produce no duplicate audio event.
    - Extend `client/tests/audio-model.test.ts`, `client/tests/stadium-camera-effects.test.ts`, and state-listener integration tests for eight-car iteration, teleport rebasing, one HUD/live-region/audio consumption per transition ID, repeated terminal snapshot deduplication, stadium alignment, resource disposal, and no baseline regression.
    - _Depends on: 6.2, 7.3, 8.1, 8.3_
    - _Requirements: 1.13-1.15, 6.9, 6.12, 16.10-16.11, 16.15-16.20, 18.24, 19.14, 19.16-19.17_

  - [ ] 8.5 Add and run non-watch browser proof for full multiplayer and finalized outcome presentation
    - Add `playwright.config.ts` and `client/tests/browser/rocket-arena.spec.ts` (plus an exact-pinned Playwright dev dependency only if the repository still lacks a runner) using managed/webServer lifecycle rather than a blocking watch command.
    - Automate six Quick clients, countdown cancellation/restart, rejected seventh; eight Custom clients, switch/start rejection, Host start, rejected ninth; exact rendered identities; camera edges; indicator; score/timer/boost; audio gesture baseline; and leave/reload cleanup.
    - Add deterministic outcome fixtures for terminal above-zero wins in both modes; Quick `6-5` and Custom `7-6` continuing through Goal_Reset_State and a fresh `3`, `2`, `1` countdown; unequal cutoff at `0:00` including below-target or one-goal leads; tied cutoff with deterministic kickoff presentation and a fresh frozen 3-second countdown; untimed active overtime; and the first overtime goal producing immediate Ended_State.
    - For each outcome, assert coherent final/updated score, scorer or leader, winner when terminal, terminal reason, and exactly one composite screen-center notice, one live-region update, and one audio transition consumption. Replay the same authoritative transition across multiple snapshots and assert no duplicate HUD, accessibility, or audio event.
    - Collect page exceptions and error-level Rocket Arena console messages for every page, require zero unexpected errors, and use deterministic server/reducer/harness state rather than browser observation as proof of fixed-step, force, contact, cutoff ordering, or physics suppression.
    - _Depends on: 2.4, 2.5, 3.5, 6.5, 7.3, 8.4_
    - _Requirements: 18.24, 19.1-19.22_

  - [ ] 8.6 Implement generated Property 21 coverage for camera isolation and finite output
    - Add `client/tests/camera-controller.property.test.ts` with at least 100 generated accepted input streams and interpolated car/ball samples per recorded seed; verify default/toggle behavior, finite bounded output, server isolation, and teleport rebasing.
    - **Property 21: Camera edge isolation and finite spring output**
    - **Validates: Requirements 15.1-15.11**
    - _Depends on: 1.6, 8.1, 8.4_
    - _Requirements: 15.1-15.11, 18.25_

  - [ ] 8.7 Implement generated Property 22 coverage for indicator and transition-announcement determinism
    - Add `client/tests/hud-projection-announcements.property.test.ts` with at least 100 generated finite camera/viewport and authoritative transition streams per recorded seed. Cover countdown, non-winning goal, terminal regulation goal, unequal cutoff, tied cutoff/overtime entry, and overtime terminal-goal IDs, including repeated snapshots.
    - Require hidden/inset indicator behavior plus exactly one composite visual notice and one live-region update per unique transition ID, every player-visible outcome in that composite, no emission for repeats, and matching one-time audio consumption through the accepted presentation boundary.
    - **Property 22: HUD projection and transition-announcement determinism**
    - **Validates: Requirements 16.6-16.7, 16.10-16.11, 16.16-16.20**
    - _Depends on: 1.6, 8.2, 8.3, 8.4_
    - _Requirements: 16.6-16.7, 16.10-16.11, 16.16-16.20, 18.25_

  - [ ] 8.8 Implement generated Property 12 coverage for input-edge idempotence and bounded windows
    - Add cross-layer `client/tests/input-edges.property.test.ts` and server jump fixtures with at least 100 generated jump/camera sequence streams per recorded seed; verify one actuation/transition, stale-edge consumption, unchanged window origins, and bounded hold/flip durations.
    - **Property 12: Input-edge idempotence and bounded jump windows**
    - **Validates: Requirements 9.4-9.13, 15.2-15.3, 18.5-18.6, 19.12**
    - _Depends on: 1.6, 5.4, 8.1, 8.4_
    - _Requirements: 9.4-9.13, 15.2-15.3, 18.5-18.6, 18.25, 19.12_

- [ ] 9. Gate staging truthfully and reserve final-fidelity promotion for evidence-backed work
  - [ ] 9.1 Implement executable tuning/status/release validation for the staging build
    - Add `tools/validate-tuning-registry.ts` and `tools/validate-release-gate.ts`, plus loaders/validators for `docs/tuning/reference-evidence.json`, `docs/tuning/approvals.json`, and `docs/feature-status.json`; create the machine-readable files as inputs to these validators rather than documentation-only deliverables.
    - Encode delivered six-Large-pad/Core-surface behavior and accurately record any skipped 28-Small-pad, Advanced-surface, exact-proximity, demolition, or unverified-tuning work; a Hackathon Staging Build must fail a Mechanics Fidelity Release claim while any such gate remains unresolved.
    - Add `shared/tests/release-gate.test.ts` and tool smoke tests for missing/stale evidence, mismatched versions, insufficient deterministic/browser proof, inaccurate delivered counts, confirmed-target changes, and successful staging-status validation.
    - _Depends on: 1.4, 7.3, 8.5_
    - _Requirements: 5.13, 10.10, 13.26, 14.15-14.16, 17.17-17.21_

  - [ ]* 9.2 Implement and validate Full_Surface_Driving
    - Extend `server/src/physics/arena.ts`, `server/src/physics/grounding.ts`, and `server/src/physics/car-controller.ts` to enable walls, horizontal corners, wall-to-ceiling transitions, and ceiling as Advanced surfaces with confirmed-normal-relative traction, steering, and jump behavior.
    - Extend `server/src/physics/test-grounding.ts`, Property 13 generated cases, and browser control automation for every Advanced transition, deterministic adjacent normals, finite control output, and Rapier cleanup; remove the deferral only when all evidence passes.
    - _Depends on: 5.5, 6.12, 8.5, 9.1_
    - _Requirements: 10.6-10.9, 17.18-17.20, 18.19, 18.26_

  - [ ]* 9.3 Complete final tuning evidence, approvals, and Mechanics Fidelity release promotion
    - Populate approved source/conversion/range records and approval records for every hypothesis in `docs/tuning/reference-evidence.json` and `docs/tuning/approvals.json`; retain prior values/ranges in registry history when evidence changes a seed.
    - Run deterministic Rapier/controller/arena/pad evidence and browser camera/HUD/perceived-control evidence, attach machine-verifiable references, complete optional final-scope tasks, and require `tools/validate-release-gate.ts` to pass as `mechanics-fidelity-release` without deferrals or unverified claims.
    - Do not approve guessed values, broaden ranges to make tests pass, or claim final fidelity without the exact evidence and explicit approval required by the registry.
    - _Depends on: 4.6, 7.4, 9.1, 9.2, 9.4_
    - _Requirements: 14.17, 17.14-17.20_

  - [ ] 9.4 Final checkpoint: run the complete required staging validation matrix
    - Run all focused and generated Node tests with their recorded seeds, every Rapier harness separately, `npm run typecheck`, `npx tsc -b shared`, `npm run build -w server`, `npm run build -w client`, the non-watch Playwright suite, and both validation tools in Hackathon Staging mode.
    - Require at least 100 ordered cases for every Property 1-27 test, repeat selected seeds to prove reproduction, verify all Rapier resources are released, and require zero uncaught browser exceptions or unexpected Rocket Arena error-level console messages.
    - Confirm the required 3v3 Quick, eight-player/4v4 Custom, V2 terminal-aware transport, deterministic kickoff, controller, Core grounding, metric arena, above-zero 6-goal/two-goal-margin outcomes, atomic 18,000-step cutoff, no post-cutoff regulation processing, frozen overtime kickoff, untimed sudden death, immutable Ended_State, one-time HUD/live-region/audio transitions, six Large pads, camera/HUD, audio/stadium regression, and truthful staging gates all pass even when optional final-fidelity tasks are skipped.
    - Ensure all tests pass, ask the user if questions arise.
    - _Depends on: 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 6.12, 7.5, 8.5, 8.6, 8.7, 8.8, 9.1_
    - _Requirements: 1.13-1.15, 13.1-13.26, 18.1-18.38, 19.1-19.22_

## Notes

- Tasks marked with `*` are the only optional implementation increments: exact proximity-sensitive kickoff selection, the complete 28-Small-pad layout, Full_Surface_Driving, and final evidence/approval promotion. Skipping them keeps the build explicitly in Hackathon Staging status.
- Quick and Custom use the same confirmed match rules: 300 seconds, exactly 18,000 regulation Active_Play fixed steps at 60 Hz unless an earlier above-zero target-and-margin win occurs, `Regulation_Goal_Target = 6`, `Regulation_Win_Margin = 2`, and no match-rule score cap.
- Above-zero goals use only the updated-score target-and-margin predicate. Hard_Regulation_Cutoff applies a same-step goal once before comparison, ends unequal scores immediately, or restores a tied deterministic kickoff for a frozen 180-step overtime countdown. Active overtime is untimed and its first valid goal ends the match immediately.
- Ended_State freezes gameplay controls and authoritative car/ball physics. Final score, winner, terminal reason/result, and transition/event ID remain coherent and immutable across later snapshots; HUD, live-region, and audio consumers process each authoritative transition ID once.
- Demolition has no finalized behavior contract in the requirements or design; required Task 9.1 therefore records it as deferred instead of inventing mechanics. It needs a separately approved design before an implementation task can be added.
- All room/capacity, V2 transport, controller, Core grounding, metric arena, goal/match flow, six-Large-pad, camera/HUD, accessibility, baseline integration, Property 1-27, Rapier, build/typecheck, and browser-validation tasks are required.
- Every generated property test runs at least 100 ordered cases from a recorded deterministic seed, reports seed/case on failure, and uses `shared/tests/support/generated-cases.ts` without a new PBT dependency.
- Every physics harness owns its Rapier resources in `try/finally` and proves cleanup after success, assertion failure, or setup failure.
- Rejected room mutations and snapshots must assert complete atomic-state preservation; tests may not check only the rejection code.
- Unverified tuning values stay configurable, range-checked, and labelled; passing mechanics tests alone never converts a hypothesis into approved final fidelity.
- Completed procedural audio is a regression baseline only; prior source-control delivery and workspace-cleanup workflows are out of scope.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "1.4"] },
    { "id": 1, "tasks": ["1.2", "1.6", "4.1"] },
    { "id": 2, "tasks": ["1.5"] },
    { "id": 3, "tasks": ["2.1", "3.2", "3.6"] },
    { "id": 4, "tasks": ["2.2", "2.6", "3.3"] },
    { "id": 5, "tasks": ["2.3", "4.2"] },
    { "id": 6, "tasks": ["2.4", "2.5", "3.1", "4.4"] },
    { "id": 7, "tasks": ["2.7", "2.8", "3.4"] },
    { "id": 8, "tasks": ["3.5"] },
    { "id": 9, "tasks": ["3.7", "3.8", "3.9", "4.3"] },
    { "id": 10, "tasks": ["4.5"] },
    { "id": 11, "tasks": ["4.6", "4.7", "4.8", "4.9", "4.10"] },
    { "id": 12, "tasks": ["4.11"] },
    { "id": 13, "tasks": ["5.1"] },
    { "id": 14, "tasks": ["5.2", "5.5"] },
    { "id": 15, "tasks": ["5.3"] },
    { "id": 16, "tasks": ["5.4"] },
    { "id": 17, "tasks": ["5.6"] },
    { "id": 18, "tasks": ["5.7", "5.8", "5.9", "5.10", "5.11", "5.12", "6.1", "6.2"] },
    { "id": 19, "tasks": ["6.3"] },
    { "id": 20, "tasks": ["6.4"] },
    { "id": 21, "tasks": ["6.5"] },
    { "id": 22, "tasks": ["6.6", "6.7", "6.8", "6.9", "6.10", "6.11"] },
    { "id": 23, "tasks": ["6.12"] },
    { "id": 24, "tasks": ["7.1"] },
    { "id": 25, "tasks": ["7.2"] },
    { "id": 26, "tasks": ["7.3"] },
    { "id": 27, "tasks": ["7.4", "7.5", "8.1", "8.2"] },
    { "id": 28, "tasks": ["8.3"] },
    { "id": 29, "tasks": ["8.4"] },
    { "id": 30, "tasks": ["8.5", "8.6", "8.7", "8.8"] },
    { "id": 31, "tasks": ["9.1"] },
    { "id": 32, "tasks": ["9.4"] },
    { "id": 33, "tasks": ["9.2"] },
    { "id": 34, "tasks": ["9.3"] }
  ]
}
```
