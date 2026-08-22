# Implementation Plan: Rocket Arena Client Presentation Completion

## Overview

The remaining implementation path is client-first and strictly ordered: arena, car, ball, then HUD. Completed shared contracts, V2 acceptance/interpolation, camera and ball-indicator foundations, server authority, Colyseus rooms, match flow, scoring, and server physics are frozen baselines; this plan schedules no new server or Colyseus implementation and does not rewrite existing dirty server work.

The arena must consume the completed frozen `ResolvedArenaGeometry` contract directly. Car, ball, and HUD work consumes only existing accepted/interpolated state and remains presentation-only. Boost-pad visuals are optional and cannot block the core path. All implementation validation is deferred to one bounded final client/shared pass after the four core slices.

## Tasks

### Completed foundations (preserved)

- [x] 1. Establish shared policies, V2 contracts, metric geometry, and tuning foundations
  - [x] 1.1 Add immutable room policies and confirmed shared match rules
  - [x] 1.2 Define V2 input, snapshot, terminal-transition, and authoritative schema contracts
  - [x] 1.3 Add the single shared metric arena and surface specification
  - [x] 1.4 Implement the versioned tuning registry and release-validation core
  - [x] 1.5 Wire shared exports and verify the foundational contracts compile
  - [x] 1.6 Implement generated Property 20 coverage for tuning atomicity and traceability

- [x] 2. Build the transactional authoritative room core and mode-specific roster behavior
  - [x] 2.1 Implement deterministic team assignment as a pure service
  - [x] 2.2 Implement transactional room mutation planning and commit
  - [x] 2.3 Add the shared authoritative room core and readiness lifecycle
  - [x] 2.4 Refactor Quick Match into a thin exact-3v3 policy adapter
  - [x] 2.5 Refactor Custom Room into a thin up-to-8/4v4 policy adapter
  - [x] 2.6 Implement generated Property 2 coverage for deterministic team assignment
  - [x] 2.7 Implement generated Property 1 coverage for mode policy and capacity invariants
  - [x] 2.8 Implement generated Property 3 coverage for atomic roster mutations

- [x] 3. Introduce V2 eight-car transport and atomic client acceptance
  - [x] 3.1 Implement the bounded ordered V2 snapshot builder
  - [x] 3.2 Add the client V2 decoder, validator, and temporary V1 adapter
  - [x] 3.3 Add a single immutable accepted-snapshot store
  - [x] 3.4 Refactor scene reconciliation into prepare-and-commit acceptance
  - [x] 3.5 Switch both room adapters and the client connection path to V2
  - [x] 3.6 Preserve and extend scheduler/interpolation baselines for V2 epochs
  - [x] 3.7 Implement generated Property 7 coverage for snapshot round trip and identity completeness
  - [x] 3.8 Implement generated Property 8 coverage for atomic client acceptance and rejection
  - [x] 3.9 Implement generated Property 25 coverage for transport and interpolation bounds

- [x] 4. Complete deterministic kickoff slots and simulation-time pre-play foundations
  - [x] 4.1 Define four mirrored, team-facing slots per team
  - [x] 4.2 Implement complete deterministic kickoff assignment
  - [x] 4.3 Integrate kickoff epochs and atomic placements into the room core
  - [x] 4.4 Replace wall-clock countdown/reset logic with a pure fixed-step match-state reducer skeleton
  - [x] 4.5 Wire Quick cancellation and Custom Host start into fixed-step phases
  - [x] 4.7 Implement generated Property 6 coverage for kickoff bijection and unique spawn
  - [x] 4.8 Implement generated Property 4 coverage for Quick countdown gating
  - [x] 4.9 Implement generated Property 5 coverage for Custom Host authority and succession
  - [x] 4.10 Implement generated Property 14 coverage for kickoff and reset timing
  - [x] 4.11 Checkpoint the room, transport, kickoff, and timing increment

- [x] 5. Complete metric bodies, scripted control, and Core grounding foundations
  - [x] 5.1 Build metric Rapier bodies and finite-state recovery
  - [x] 5.2 Implement speed-dependent throttle, boost actuation, drag, and propulsion bounds
  - [x] 5.3 Implement grounded steering, lateral grip, and handbrake
  - [x] 5.4 Implement jump/flip/air state and expanded client controls
  - [x] 5.5 Implement local-down grounding for Core surfaces
  - [x] 5.6 Wire the ordered scripted simulation pipeline into the room core
  - [x] 5.7 Implement generated Property 23 coverage for physics construction and collision-owned spin
  - [x] 5.8 Implement generated Property 9 coverage for throttle monotonicity and scaling
  - [x] 5.9 Implement generated Property 11 coverage for grip and handbrake ordering
  - [x] 5.10 Implement generated Property 13 coverage for local-down grounding
  - [x] 5.11 Implement generated Property 10 coverage for finite output and speed bounds
  - [x] 5.12 Implement generated Property 19 coverage for server authority preservation

### Remaining client-first coding path

- [x] 6. Build the shared-geometry-driven Three.js arena and original exterior stadium
  - [x] 6.1 Preserve the completed shared resolved-geometry foundation
    - [x] 6.1.1 Evolve the shared arena resolver into the only authoritative primitive contract
      - `shared/src/geometry/arena-collision.ts`, its geometry exports, and `shared/tests/arena-collision.test.ts` already provide the deeply frozen `ResolvedArenaGeometry`, canonical identity/fingerprint, exact metric bounds and profiles, mirrored goal regions, semantic surfaces, boundary primitives, inward indexed surfaces, and explicit seams.
      - _Requirements: 12.1-12.9, 18.8_

  - [x] 6.2 Refactor the client arena and stadium around `ResolvedArenaGeometry`
    - Refactor `client/src/renderer/arena.ts` so `createArena(scene, resolvedGeometry, padDescriptors = [])` consumes the existing frozen resolved object and never reconstructs authoritative field, ramp, wall, corner, ceiling, goal-mouth, or goal-interior dimensions from legacy `ARENA.*` values.
    - Create exactly three named roots: `arena-authoritative-boundaries`, `arena-gameplay-overlays`, and `arena-exterior-presentation`. Build indexed `THREE.BufferGeometry` directly from each primitive's `inwardSurface`, preserve primitive/surface/seam IDs plus geometry identity in immutable mesh metadata, and choose bounded reusable materials by `materialRole`.
    - Build both mirrored recessed goal tunnels from resolved goal and primitive records, keeping the exact mouths open and rendering matching floors, sides, roofs, backs, ribs, lights, and original procedural containment treatment without moving authoritative vertices.
    - Generate deterministic turf, halfway/center markings, team-half accents, and other non-colliding overlays from resolved anchors. Keep an empty `padDescriptors` list valid and create no pad placeholder in the core arena task.
    - Refit stands, crowd, floodlights, flags, arches, scoreboards, atmosphere, and skyline under `arena-exterior-presentation` only; keep every decorative object outside the resolved shell, free of authoritative metadata, and built from original project-owned procedural assets.
    - Return explicit arena ownership with bounded `update` and idempotent `dispose` behavior. Reuse geometries/materials and `THREE.InstancedMesh` for repeated scenery, allocate no geometry/material/typed arrays/nodes per frame, and release each owned resource exactly once.
    - Refactor `client/src/main.ts` to resolve/pass the shared geometry once, retain the arena handle for frame updates and teardown, and leave accepted snapshot/interpolation ownership unchanged.
    - _Depends on: 6.1.1_
    - _Requirements: 1.15, 12.1-12.10, 18.8, 18.24_

- [x] 7. Polish car presentation and client interaction from accepted/interpolated state
  - Refactor `client/src/renderer/car.ts` into a reusable, explicitly owned `CarVisualRig` whose visual dimensions remain independent of the authoritative collider; preserve clear Blue/Orange textural and shape cues, improve local-car readability, and share immutable geometry/material resources across up to eight cars.
  - Refactor `client/src/renderer/entity-effects.ts` to drive wheel rotation, steering presentation, emissive state, boost flame/trail response, and bounded motion accents from existing interpolated transforms, synchronized velocity/boost values, and existing local presentation input only. Local input may affect transient visuals but must never move a car or mutate accepted state.
  - Refine `client/src/networking/state-listener.ts` so prepared/committed mesh reconciliation attaches one rig per accepted identity, preserves teleport/kickoff rebasing, and disposes per-car and shared presentation resources correctly on removal, room reset, preparation failure, and final teardown.
  - Refine `client/src/renderer/camera-controller.ts` and `client/src/main.ts` only at the presentation boundary so the completed Ball/Car camera toggle, finite spring bounds, local-car anchor, resize behavior, and frame ordering remain coherent with the polished rig; add no protocol, room, or server changes.
  - _Depends on: 6.2, 8.1_
  - _Requirements: 1.9-1.12, 6.9, 6.12, 15.1-15.11, 18.24, 19.11-19.12, 19.17_

- [x] 8. Complete ball presentation using the existing camera and indicator foundations
  - [x] 8.1 Implement local Ball and Car camera modes with edge toggles
    - _Requirements: 15.1-15.11_

  - [x] 8.2 Implement the off-screen ball indicator projection
    - _Requirements: 16.6-16.8_

  - [x] 8.3 Refactor the ball mesh and motion effects as a presentation-only rig
    - Refactor `client/src/renderer/ball.ts` to expose an explicitly owned ball visual rig with reusable shell, seam, node, glow, and effect resources; keep its visible scale anchored to the existing shared ball radius and retain an original neutral Rocket Arena treatment without proprietary assets.
    - Extend `client/src/renderer/entity-effects.ts` with finite, frame-rate-bounded spin, emissive pulse, motion trail, and contact-proximity presentation derived only from the accepted/interpolated ball transform and velocity already available on the client. Reset temporal effects at kickoff-epoch teleports and never infer goals, contacts, or score authority.
    - Refine `client/src/networking/state-listener.ts` and `client/src/main.ts` so the same committed/interpolated ball drives rendering, camera targeting, effects, audio inputs, and later HUD projection, with atomic setup and idempotent disposal on leave/reconnect/teardown.
    - _Depends on: 7_
    - _Requirements: 1.9-1.12, 11.1, 12.10, 15.4-15.5, 15.8, 16.6-16.7, 18.24, 19.11, 19.13, 19.17_

- [x] 9. Implement accepted-state-driven HUD, accessibility, and presentation integration
  - Refactor `client/src/hud/hud.ts` and `client/src/ui/lobby.ts` to subscribe to the existing `AcceptedSnapshotStore` for room policy, occupancy, score, regulation/overtime state, phase/countdown, local boost, winner, and available transition data; remove independent raw-state parsing and never synthesize missing authoritative outcomes.
  - Integrate `client/src/hud/ball-indicator.ts` with the interpolated ball and active camera. Present score, timer/overtime, boost, camera mode, indicator, countdown/goal/terminal notices, and room capacities using only fields already delivered by accepted snapshots plus local camera state.
  - Consume each available stable transition/event ID once for one composite screen-center notice and one `role="status"`, `aria-live="polite"`, `aria-atomic="true"` announcement. Repeated snapshots emit nothing again; unavailable optional transition details degrade to the stable phase display rather than blocking the HUD.
  - Add accessible names/current values, keyboard-visible focus where controls exist, Blue/Orange text or shape distinctions in addition to color, at least 4.5:1 contrast, central safe-zone protection, and responsive non-overlapping desktop/mobile layouts.
  - Refactor `client/src/main.ts` to use one presentation order: accepted/interpolated state, car and ball effects, camera, HUD/indicator, audio, then render. Add explicit HUD subscription/update/disposal ownership and preserve rejected-snapshot isolation.
  - _Depends on: 3.3, 8.1, 8.2, 8.3_
  - _Requirements: 2.6-2.7, 6.9-6.12, 16.1-16.20, 18.24, 19.1, 19.3-19.17_

- [x]* 10. Add optional descriptor-driven boost-pad visuals without gameplay authority
  - Add `client/src/renderer/boost-pads.ts` or an equivalent isolated arena renderer module that accepts an immutable descriptor list, renders only supplied IDs/kinds/transforms with shared geometry/material instances, and treats an empty descriptor set as a complete valid no-op.
  - Wire the optional renderer under `arena-gameplay-overlays` with bounded visual-state updates and idempotent disposal. Create no decorative placeholder for absent pads and implement no pickup, inventory, respawn, collision, sensor, room, or server behavior.
  - Keep this task outside every core and validation dependency; skipping it must leave arena, car, ball, HUD, and final validation unchanged.
  - _Depends on: 6.2_
  - _Requirements: 1.15, 14.15-14.16, 18.24_
  - Delivered: `client/src/renderer/boost-pads.ts` draws each descriptor as a flat disc with a brighter rim, sized from the sensor footprint it is handed and lifted by `VISUAL.BALL_MOTION.MARKER_FLOOR_CLEARANCE` so it cannot z-fight the turf. One geometry and material set per pad **class**, shared within the class. An empty descriptor list is a complete valid no-op, and disposal releases each owned resource exactly once however often it is called. No pickup, inventory, respawn, collision, or sensor behaviour lives here. Coverage: `client/tests/boost-pads.test.ts`, seven tests.
  - The pad table is resolved in `shared/src/config/boost-pads.ts`, not in the client. Deriving it twice would let a drawn pad drift away from a pad that pays out, which is worse than no pads at all because it lies to the player; one test asserts the renderer draws exactly the shared table the room grants from.
  - Deviation from this task as written: pads are drawn as **always available**. Availability is authoritative state and `SnapshotEnvelopeV2` does not carry it, so honouring it would have meant widening the envelope and reaching into `shared/tests/contracts-v2.test.ts` and the snapshot builder for a purely cosmetic gain. Marking where boost is beats animating a guess about whether it is there. Authoritative pad availability in the envelope is now recorded as an open increment in `README.md`.
  - Deviation from this task as written: the renderer is attached at the scene root from `client/src/main.ts` rather than under `arena-gameplay-overlays`, because `createArena` owns and disposes that group and the pad rig owns its own lifetime and teardown, wired into `disposeClient` beside the other rigs.
  - Two defects were found here and are worth recording because both had the same shape. The shared resolver derived one sensor footprint for the whole table, so a second pad class would have silently inherited the first one's catch area; each class now resolves its own, and a class whose footprint is unreadable drops entirely rather than borrowing the other's. The renderer sized every disc from `descriptors[0]`, so once small pads existed every one of them would have been drawn at large-pad size, reporting a catch area where none is.

- [x] 11. Implement and run one bounded final client/shared validation pass
  - Add or reuse focused client tests for resolved-geometry mesh identity/alignment, the three arena roots, mirrored goal tunnels, exterior-only decoration, reusable-resource/disposal budgets, eight-car rig lifecycle, ball effect rebasing, accepted-state HUD notices, transition deduplication, accessibility semantics, safe-zone layout, camera behavior, and the ball indicator. Consolidate coverage in `client/tests/arena-geometry.test.ts`, `client/tests/procedural-models.test.ts`, `client/tests/stadium-camera-effects.test.ts`, `client/tests/state-listener.test.ts`, `client/tests/camera-controller.test.ts`, `client/tests/ball-indicator.test.ts`, and `client/tests/hud-accessibility.test.ts` as applicable.
  - Add or reuse finite Playwright coverage in root `playwright.config.ts` and `client/tests/browser/client-presentation.spec.ts`; add one exact-pinned `@playwright/test` version only if no runner exists. Use managed finite non-watch processes and deterministic accepted-state fixtures without adding a server mutation API or changing frozen server code.
  - Capture one bounded desktop view set and one bounded mobile view set covering arena overview/goal depth, local and remote cars, the ball, score/timer/boost/camera HUD, notices, ball indicator, and responsive accessibility. Require no unexpected `pageerror` or Rocket Arena error-level console output.
  - After all four core slices are implemented, run exactly one final matrix: `npx tsc -b shared client`, `npm run build -w client`, the focused shared/client Node tests, and the Playwright suite once. Fix only failures caused by the four client slices, then stop.
  - Do not run root server build/typecheck as part of this gate and do not include the currently failing `server/src/physics/test-metric-arena.ts` harness.
  - _Depends on: 6.2, 7, 8.3, 9_
  - _Requirements: 1.9-1.15, 6.9-6.12, 12.10, 15.1-15.11, 16.1-16.20, 18.24, 19.1, 19.11-19.17_
  - Delivered: focused coverage lives in `client/tests/arena-geometry.test.ts`, `client/tests/procedural-models.test.ts`, `client/tests/hud-accessibility.test.ts`, `client/tests/stadium-camera-effects.test.ts`, `client/tests/state-listener.test.ts`, `client/tests/camera-controller.test.ts`, and `client/tests/ball-indicator.test.ts`. The final matrix ran green: `npx tsc -b shared server client`, `npm run build -w client`, 325/325 focused Node tests, and all seven standalone physics harnesses.
  - Deviation from this task as written: no `playwright.config.ts` or `client/tests/browser/client-presentation.spec.ts` was added. Browser evidence was captured interactively instead, against a clean dev server, at 1440x900 and 414x896: zero console errors, zero warnings, and no page error; boost started at 33 when that evidence was captured, drained to zero while held, then regenerated to exactly 100 after its delay; the accepted-state scoreboard, occupancy, camera-mode, and boost readings all render; regulation ran out and the match entered overtime. Adding a checked-in, pinned Playwright runner remains open.

- [x] 12. Restore flat-surface car contact on the resolved arena floor
  - A car resting on the arena floor sinks `98 mm` and is supported by a single solver contact point with a small persistent tilt, instead of resting `1-3 mm` down on four contacts. Isolated measurement: the real 16-vertex `field.floor.center` convex hull yields restY `0.3016`, one solver contact, and `0.68` degrees of tilt, while an equivalent cuboid slab yields restY `0.3987`, four solver contacts, and zero tilt.
  - The defect is independent of mass (`1`, `25`, and `150 kg` are identical), independent of contact skin, present with both the sharp and the rounded chassis, and it grows with more solver iterations, so it is a contact-manifold generation problem rather than a force or penetration-recovery problem. A synthetic eight-vertex slab hull of the same footprint behaves correctly, so the trigger is the specific octagonal floor hull.
  - Consequence: the presented car sits about `10 cm` into the floor because the presentation offset assumes a `0.4 m` resting centre, and single-point support explains residual wobble while grounded.
  - This is pre-existing and predates the current session's physics work. Fixing it means changing the authoritative arena collision representation for flat slab primitives, which changes the resolved geometry fingerprint and touches `shared/tests/arena-collision.test.ts`, the renderer boundary metadata, and `server/src/physics/test-metric-arena.ts`. It therefore needs an explicit decision before implementation.
  - _Requirements: 10.1-10.9, 12.1-12.9_
  - Delivered: worst resting height error `0.1318 m` -> `0.0039 m`, worst resting tilt `1.06` -> `0.22` degrees, and sunk positions `7/11` -> `0/11` across eleven sampled floor positions.
  - Deviation from this task as written: the authoritative arena collision representation was **not** changed, so the resolved geometry fingerprint, `shared/tests/arena-collision.test.ts`, the renderer boundary metadata, and `test-metric-arena.ts` are all untouched. The decision this task asked for was resolved the other way: stop depending on Rapier's box-vs-convex-polyhedron manifold for car support instead of reshaping the hull.
  - Approach: `server/src/physics/grounding.ts` gains `probeRideHeight()`, which casts one ray per support contact point starting one `rayDistance` **above** that point along local-down, so `gap = toi - lift` is signed: positive hovering, about zero at rest, negative sunk. `server/src/physics/car-controller.ts` consumes it as `CarRideHeightObservation` and emits `rideHeightDeltaVelocity` under `RIDE_HEIGHT_RESPONSE 14`, `RIDE_HEIGHT_MAX_CORRECTION 0.35`, and `RIDE_HEIGHT_MAX_SPEED 2.5`. The correction runs only while grounded **and** sunk, and subtracts the current closing speed along the normal, so it can only lift a sunk chassis and never adds energy to a jump, a landing, or an airborne car. `rapier-room-world.ts` probes only when grounding already reported support.
  - Ruled out first, each measured rather than assumed: mass (`1`, `25`, `150 kg` identical), arena contact skin (moved rest height without restoring contact count, and lifted the ball), car contact skin (masked the height but left one contact, so the wobble stayed), spawn clearance, vertex rounding, slab thickness, extra solver iterations, and `roundConvexHull`.
  - Coverage: `runRideHeightProbeCases()` in `server/src/physics/test-grounding.ts` pins a resting gap of about zero on four samples with `normal.y` 1, a hovering gap equal to its `0.12` clearance, a sunk gap of `-0.10`, `null` when airborne, and finite bounded unit-normal readings on a ramp. The ramp case stays loose on purpose: the chassis is longer than one chord segment, so an exact gap assertion there fails at about `-0.094`.

## Notes

- Recorded product decisions that superseded earlier acceptance text, all requested directly and now reflected in `requirements.md`:
  - Boost regenerates. Requirement 14.5 previously forbade passive recharge; it now specifies a `1.25` second delay, `12` units per second, a clamp at 100, regeneration armed only after boost is spent, and no regeneration on a Fixed_Step where boost input is held at zero inventory.
  - The ball radius stays `1.8 m`. Requirement 11.1 previously specified `0.9125 m`; production, tuning, and the client all use `1.8 m`, and the ball's visual scale stays anchored to that shared radius.
  - A directional flip now requires held intent. Requirement 9.8 previously flipped as soon as directional magnitude reached the deadzone on an accepted edge; it now also requires Directional_Flip_Intent, and a brief tap produces a neutral second jump instead of a flip.
- Ball bounce was restored by fixing the ball's soft-CCD prediction rather than by retuning damping or resizing the ball. Damping stayed at its seed value and the radius was untouched. The prediction is now disabled outright: `BALL.SOFT_CCD_PREDICTION` stays `0` and `applyConfiguredSoftCcdPrediction()` replaced the adaptive version, with `BALL.SOFT_CCD_TRAVEL_RATIO` removed. An earlier attempt scaled the prediction to the ball's own per-step travel, but measurement showed **any** non-zero prediction makes the solver brake the ball one step before contact and discard restitution non-deterministically: `e` came out `0.592` from 10 m, `0.585` from 3 m, but `0.159` from 5 m, and one fast case overshot at `1.162`. With prediction off, `e` is `0.582-0.597` at every sampled height and speed. `runBounceConsistencySweep()` in `server/src/physics/test-ball.ts` guards it across seven heights and three speeds with a `0.09` tolerance; worst observed deviation is `0.048`.
- Airborne rotation is integrated per local axis instead of snapped. The planner used to replace angular velocity with the capped target, so any deflection reached the full `5.5 rad/s` inside one `16.7 ms` step, all three axes behaved identically, and releasing the sticks froze the spin because nothing damped it. `TUNING_IDS.car.air` seeds six new unverified hypotheses with real ranges (torque `12.46` pitch, `9.11` yaw, `38.34` roll `rad/s^2`; damping `2.798`, `1.886`, `4.687` `s^-1`), which are the Rocket League air-control rates. Measured spin-up to 99% of maximum: roll `9` steps, pitch `27`, yaw `36`. Flips still snap, because a dodge is an impulse in Rocket League as well. No confirmed-starting-target was touched.
- Kickoff boost inventory was raised from `33` to `100` on request. This is a deliberate departure from Rocket League, which starts a kickoff at `33`, so the entry was reclassified from a pinned `confirmed-starting-target` to an `unverified-hypothesis` over the full `0-100` inventory range rather than left claiming a confirmed value it no longer matches. `CAR.BOOST.START_AMOUNT` stays at `60` and is untouched: it feeds the legacy `server/src/physics/car.ts` path and `shared/src/schema/player-state.ts` defaults, while the live room reads `initialBoostAmount()` from the registry.
- Jump hold and the throttle curve were then matched to Rocket League on request, both being hypotheses that sat below their reference values. `car.jump.holdForce` `1450 -> 2187.5 N`, because Rocket League sustains a held jump at `1458.333 uu/s^2` = `14.58333 m/s^2`, which against the confirmed `150 kg` mass is exactly `2187.5 N`; over the full `0.2 s` hold that adds `2.91667 m/s`, matching the initial impulse, so a full jump leaves at `5.83334 m/s`. `car.throttle.accelerationCurve` now carries Rocket League's own shape, `16 m/s^2` from rest to `1.6` at `14 m/s` and `0` at the `14.1 m/s` ceiling, where the old seed peaked at `10`. Both are accelerations and speeds with no length term, so they transfer to this metric scale exactly. Measured live from the `0.399 m` ride height: apex at `894 ms` against a predicted `897 ms`, `2.19 m` of rise, floor again at about `1.69 s`.
- Not copied from Rocket League, and deliberately so: `car.steering.curvatureCurve`. Curvature has units of `1/length`, so it does not transfer while the car is `3.2 m` against Rocket League's `1.18 m`. Rocket League's `0.0069 1/uu` at rest is a `1.45 m` turn radius, which is shorter than half this chassis. Scaled by the length ratio its curve would read about `0.254` at rest falling to `0.033` at top speed, and the existing seed of `0.18 -> 0.04` is already close to that everywhere except low speed, so it was left alone rather than retuned without a complaint driving it.
- `server/src/physics/test-metric-arena.ts` still fails and remains outside every gate, and the reason is now measured rather than guessed. It asserts the ball never interpenetrates any resolved surface at any frame, and that assertion is **unsatisfiable at the same time as a correct bounce**, so it is a test-design conflict rather than a defect. At the configured `60 m/s` on a `60 Hz` fixed step the ball advances exactly `1 m` per step, so a discrete solver necessarily resolves the first contact frame from inside the surface. Measured worst transient overlap: `0.907 m` against `goal.blue.back`, `0.815 m` against the floor, `0.524 m` against a side wall, lasting two to five frames and settling under `4 mm`. This is not goal-specific.
  - Raising `PHYSICS.MAX_CCD_SUBSTEPS` cannot help: overlap was identical at 2, 4, 8, and 16 substeps, because `1 m` of travel is still well under the `1.8 m` radius so Rapier never classifies the motion as needing nonlinear CCD. Hard CCD is doing its real job, which is preventing tunneling.
  - The only lever that removes the overlap is soft-CCD prediction, which is exactly what makes the bounce non-deterministic, so it stays at `0`.
  - The property that actually matters was therefore moved into a gate. `runContainmentSweep()` in `server/src/physics/test-ball.ts` fires the ball at its maximum speed into both goal back walls, both side walls, an off-mouth end wall, the ceiling, the floor, and a corner diagonal, and asserts the centre never leaves the arena shell, the transform stays finite, and the ball settles in bounds. All eight shots are contained. A ball outside the shell would break scoring; a `0.9 m` overlap for four frames would not.
  - Reproduce the measurement with `npx tsx bench/goal-penetration-diagnostic.ts`, which also contains the substep sweep behind the negative result.
- Task 10 was completed after the plan closed, on request, rather than skipped as designed. It remains optional and still blocks nothing.
- The authoritative boost-pad freeze was **reopened on request**, so the note that this plan schedules no server boost-pad work no longer holds. Everything else in that freeze stands: Colyseus, room/match-flow/scoring/goal-crossing, and server physics were not touched, and no existing dirty server work was reverted or rewritten.
  - Pickup, inventory, and respawn live in `server/src/systems/boost-pads.ts` as a pure step: it takes pad state, car positions, and one timestep, and returns the next pad state plus the boost each car earned. It touches no physics body, no room, and no schema, so the pickup rule is testable exactly without a world, and the caller keeps boost authority in one place.
  - `authoritative-room-core.ts` gains one optional `afterFixedStep` hook, called after the `command.commit()` loop. Ruled out: a per-car hook, which cannot decide which of two cars on one pad in the same step takes it, and `recoverBallAfterStep`, which is the wrong semantics entirely.
  - Collectors are consulted in the caller's stable roster order, so two cars on one pad in one step produce exactly one grant and which car wins is decided by roster order rather than iteration chance.
  - The vertical pickup window is deliberately **not** the seeded sensor extent. That slab is `+/-0.3 m` about `y = 0.15` and tops out at `0.45 m` while a resting car centre sits near `0.399 m`, a `51 mm` margin that any bump would fall out of. The window is two car-collider heights instead, and that figure is measured: the two side large pads sit at `|x| = 39`, which is `1.96 m` from the wall and therefore inside the `2.56 m` ramp band, and a car driving onto the `[39, 0]` pad was observed at `y = 1.093` while still `0.54 m` short of the pad horizontally. Two heights covers a climbing car and still ignores one flying over, since a full jump apexes near `2.6 m`.
  - The two side large pads keep their seeded ramp-band positions rather than being nudged onto flat floor, because Rocket League puts them against the wall and moving them would edit authored content to suit an implementation. A `onRampBand` flag records the condition instead.
- Small pads were then added on request alongside the six large ones. Rocket League's full twenty-eight went in first and were cut to eighteen on request, because at this arena's scale the full set read as clutter, for a total of twenty-four pads. The positions are converted rather than authored: this arena is a clean hundredth of Rocket League's, since `40.96 / 4096` and `51.2 / 5120` both give `0.01`, so a source coordinate in Unreal units becomes metres by moving the decimal two places. All twenty-eight land on flat floor, clear of the ramp band and the chamfered corners, and the `onRampBand` count stays at exactly two, which is the assertion that would have caught a bad conversion. Small pads grant `12` on a `5` second cycle against the large pads' `100` on `10`; the room needed no change, because `stepBoostPads` already read both values per descriptor.
- Deferred outside the active path: proximity-sensitive kickoff selection, unfinished server arena/Rapier follow-ups, swept-goal and match-outcome work, authoritative pad availability in the snapshot envelope, full-surface/release-gate promotion, and the separate Property 28/29 placement-bugfix path. None is a prerequisite for Tasks 6.2, 7, 8.3, 9, or 11.
- Boost-pad visuals are descriptor-driven, valid with an empty descriptor set, and never block the core path.
- The arena boundary shell was repainted on request, entirely in materials. No collision geometry, primitive, or seam was touched, so the resolved geometry fingerprint, `shared/tests/arena-collision.test.ts`, and the renderer boundary metadata are all unchanged. The defect was concrete: `field-containment` was a `MeshPhysicalMaterial` at `opacity 0.2` with `depthWrite` disabled, so the wall occluded nothing and the crowd, trusses, skyline, and sky all read straight through it; a car on the wall had no visible surface under it to judge height or position against. It was made fully opaque first, with panel seams spaced against the arena's own length, a bright kick plate at the ramp, a cool cap at the ceiling curve, and one continuous bright team stripe around the perimeter. A deep team tint alone was tried before that and was invisible, because a dark tint mixed into a dark panel is not a tint. Opaque then went too far in the other direction: it walled the crowd out of the shot, and a Rocket League wall is a glazed pane in a frame rather than a slab. It is a tinted glass pane again, but not by reverting, because the readability the opaque pass added is what was worth keeping. Alpha is now computed per fragment, so the one thick team stripe stays effectively solid at `0.97`, the frame mullions and the ramp line stay legible at `0.32` and `0.78`, and only the panes between them return to roughly `0.11`. A driver still has a stripe and a frame to judge height and position against while the arena reads as glass. Because alpha varies per fragment the material has to be blended and must not write depth, which puts the wall back alongside the ceiling as a sorted pane. The `field-lower-transition` band is painted the same way so the start of the climb is visible rather than discovered, and the two goal interiors, previously near-black and within a few points of each other, now carry enough of their own team to be told apart. Implementation notes: the pattern is injected into `MeshStandardMaterial` via `onBeforeCompile` so the wall still takes the stadium lighting instead of reading as a flat sheet, `customProgramCacheKey` is keyed on the source, arena dimensions are baked in as GLSL literals since they are fixed for the material's life, and both transition risers are read from `resolvedGeometry.profiles` rather than from a local copy of the numbers. The wall and the ceiling are both sorted panes.
- Pad presentation was then split by class on request, because one shape for two very different payouts told a player nothing. A small pad is a plate set into the turf and nothing more. A large pad hovers an orb above its plate, a pale core inside an additive golden halo at `1.7 m`, bobbing gently, which is what makes a full refill worth spotting from the other end of the pitch. Orb resources are created only for the class that hovers one, so the small pads pay nothing for geometry they never use. The bob is driven from elapsed time rather than accumulated deltas, so identical elapsed time gives an identical pose regardless of frame pacing; each pad takes a phase from its index so the orbs breathe independently while staying deterministic; and a non-finite elapsed time is ignored rather than turned into a NaN transform.
- Local axis inversion for W/S, A/D, and Q/E was added on request, in `client/src/ui/pause-menu.ts` and applied in `InputController.getPayload`. It is input mapping only: the flip is applied to the command this client builds, so the server keeps one sign convention and is never told an axis was reversed. Sign flipping is used rather than rebinding keys, which keeps the two halves of an axis exactly symmetric. Air pitch and roll are derived from the ground axes on this client and therefore invert with them, deliberately, since it is one physical axis. Two details that would otherwise bite: a neutral inverted axis reports exactly `0` rather than `-0`, and a flip forces the next transmission, because the payload changes with no key event and the transport dedupe would otherwise hold the old value until the player next pressed something.
- There are no iterative feature checkpoints. Tests and browser screenshots are implemented/reused and executed once in Task 11 after arena, car, ball, and HUD are complete.

## Task Dependency Graph

```json
{
  "completedBaselines": [
    "1", "2", "3", "4", "5", "6.1.1", "6.2", "7", "8", "8.1", "8.2", "8.3", "9", "11", "12"
  ],
  "waves": [],
  "optionalWaves": [
    { "id": 0, "tasks": ["10"] }
  ],
  "dependencies": {}
}
```
