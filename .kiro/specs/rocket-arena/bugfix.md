# Bugfix Requirements Document

## Introduction

This bugfix prevents represented cars from appearing outside the arena at room entry or kickoff. The defect occurs when car placement is accepted against arena bounds that differ from the collision volume and authoritative visible perimeter active in the same build. The correction must cover waiting-state creation, initial kickoffs, and post-goal kickoffs in both Quick Match and Custom Room while preserving authoritative, deterministic, and atomic placement behavior.

## Bug Analysis

### Current Behavior (Defect)

The active build can validate and expose a car placement using arena bounds that do not match the arena actually used for collision and presentation.

1.1 WHEN kickoff placement validation and the active collision or authoritative visible perimeter use different arena geometry sources or versions THEN the system may accept a placement that is outside the actual active playable volume
1.2 WHEN a represented car is newly created or first exposed in Waiting_State at a position that fits only the non-active geometry THEN the system may publish and render the car with part or all of its authoritative collider outside the active playable volume
1.3 WHEN an initial kickoff assigns a slot that fits the validation geometry but not the active arena geometry THEN the system may publish and render the car outside the transparent perimeter during the countdown or subsequent Active_Play
1.4 WHEN a post-goal kickoff assigns a slot that fits the validation geometry but not the active arena geometry THEN the system may replace the preceding valid car state with an out-of-bounds placement and expose it in an Authoritative_Snapshot
1.5 WHEN the geometry mismatch occurs in either Quick Match or Custom Room THEN the affected room flow may place a represented car outside the active arena even though its deterministic slot assignment was considered valid
1.6 WHEN current browser validation enters and starts a room THEN the validation may complete without asserting full-collider containment against the arena geometry and visible perimeter active in that browser run

### Expected Behavior (Correct)

All placement acceptance, collision containment, and authoritative visible boundaries must agree on the geometry active in the running build.

2.1 WHEN kickoff placement validation, server collision geometry, and the authoritative visible perimeter are active in one build THEN the system SHALL govern all three with the same shared arena geometry source and version
2.2 WHEN a represented car is newly created or first exposed in Waiting_State THEN the system SHALL verify that its full authoritative collider fits inside the actual active playable volume, or a valid solid goal interior where explicitly intended, before any Authoritative_Snapshot exposes the car
2.3 WHEN an initial kickoff placement is prepared THEN the system SHALL verify every represented car's full authoritative collider against the actual active playable volume before committing the placement or exposing countdown or Active_Play state
2.4 WHEN a post-goal kickoff placement is prepared THEN the system SHALL verify every represented car's full authoritative collider against the actual active playable volume before replacing the preceding valid car state or publishing the new kickoff state
2.5 WHEN a proposed room-entry or kickoff placement is invalid for the active arena in either Quick Match or Custom Room THEN the system SHALL reject the complete placement atomically, retain the previous valid authoritative state, and publish no out-of-bounds car
2.6 WHEN browser validation enters and starts deterministic Custom Room and Quick Match scenarios THEN the system SHALL expose the first accepted local car render and every countdown-to-playing sample with the full authoritative collider inside the active arena and visible perimeter, while producing zero unexpected page exceptions and zero Rocket Arena error-level console messages

### Unchanged Behavior (Regression Prevention)

The containment correction must remain narrowly scoped and preserve established authority, mapping, and presentation guarantees.

3.1 WHEN a capacity-valid roster receives valid active-arena placements THEN the system SHALL CONTINUE TO map each team-local Stable_Roster_Order identity deterministically to its same-team Kickoff_Slot
3.2 WHEN kickoff assignments are valid THEN the system SHALL CONTINUE TO preserve team-facing orientation, one-to-one assignment, non-overlapping full car colliders, and identical results for identical geometry, roster, and slot inputs
3.3 WHEN roster identities, team memberships, and within-team Stable_Roster_Order are unchanged across a goal reset THEN the system SHALL CONTINUE TO preserve the deterministic identity-to-slot assignment
3.4 WHEN clients send controls or receive snapshots THEN the system SHALL CONTINUE TO keep transforms, collision outcomes, team membership, scores, match phases, and placement acceptance under server authority
3.5 WHEN server collision boundaries are presented by the client THEN the system SHALL CONTINUE TO align the authoritative visible perimeter with those active collision boundaries within the existing tolerance
3.6 WHEN a proposed placement fails any geometry, containment, completeness, or overlap invariant THEN the system SHALL CONTINUE TO avoid partial body movement and preserve the last complete valid assignment and authoritative body state
3.7 WHEN valid Quick Match or Custom Room countdown, kickoff, and match-flow transitions occur THEN the system SHALL CONTINUE TO preserve their existing deterministic timing, capacity, host, and phase rules
