# Requirements Document

## Introduction

This document defines the next Rocket Arena feature slice: Rocket League-style gameplay-mechanics fidelity and expanded human multiplayer capacity. The completed authoritative fixed-step simulation, manual snapshot transport, client interpolation, lobby, procedural-audio, and stadium-presentation foundations are regression baselines to preserve rather than new delivery scope.

The current source uses one shared four-player/two-per-team limit for both room types, branches kickoff placement only between a first and second teammate, and uses physics, arena, and timing values that differ from the new targets. This specification replaces those obsolete limits and targets while retaining configurable, evidence-gated treatment for values whose supplied references are approximate or unverified.

## Glossary

- **Rocket_Arena**: The complete browser game formed by the authoritative server, shared contracts and tuning values, and client presentation.
- **Server_Simulation**: The server-owned Rapier simulation that determines physical state, contacts, boost state, goals, scores, and match phases.
- **Client_Presentation**: The client-owned rendering, interpolation, input capture, camera, audio, lobby, and HUD behavior that displays authoritative state without deciding gameplay outcomes.
- **Match_Configuration**: The shared, validated configuration that defines mode-specific capacities, match timing, and confirmed regulation win values.
- **Quick_Match_Service**: The server room behavior for normal automatically assigned matches that start only with exactly three Blue_Team players and three Orange_Team players.
- **Custom_Room_Service**: The server room behavior for host-started matches with team switching and up to four players per team.
- **Team_Assignment_Service**: The deterministic server behavior that assigns a joining player to Blue_Team or Orange_Team.
- **Kickoff_Slot_Service**: The deterministic server behavior that assigns non-overlapping, team-facing spawn transforms.
- **Snapshot_Transport**: The manual server-to-client `state-sync` path carrying an Authoritative_Snapshot.
- **Snapshot_Target_Interval**: The configured nominal Authoritative_Snapshot interval of approximately `33` milliseconds with a configurable finite non-negative scheduling tolerance, independent of the Fixed_Step and not an exact wall-clock delivery guarantee.
- **Car_Controller**: The scripted authoritative controller that converts Input_Command values and authoritative car state into bounded forces, impulses, and angular commands.
- **Grounding_System**: The authoritative local-down contact-ray system that identifies whether a car has valid surface support.
- **Ball_System**: The authoritative ball body, contact behavior, and bounded-motion behavior.
- **Arena_System**: The collision and presentation geometry for the field, ramps, corners, walls, ceiling, and goal interiors.
- **Goal_System**: The authoritative goal-line crossing detector and score-transition behavior.
- **Match_Flow_System**: The authoritative countdown, regulation win evaluation, Hard_Regulation_Cutoff, goal reset, overtime, and match-end behavior.
- **Boost_System**: The authoritative boost inventory, consumption, pickup, and pad-respawn behavior.
- **Camera_System**: The client presentation behavior for Ball_Camera and Car_Camera.
- **HUD_System**: The client presentation behavior for scores, timer, boost, countdown, goal notices, room capacity, and ball direction.
- **Lobby_UI**: The completed lobby foundation extended to display and enforce the capacities in this document.
- **Audio_System**: The completed procedural sound implementation and accessible sound controls retained as a regression baseline.
- **Stadium_Renderer**: The completed stadium presentation foundation aligned to the Arena_System geometry and retained as a regression baseline.
- **Tuning_Registry**: The versioned, unit-labelled configuration for confirmed targets and Unverified_Tuning_Hypothesis values.
- **Release_Gate**: The validation decision that determines whether the Mechanics_Fidelity_Release may be declared complete.
- **Validation_Suite**: The deterministic unit, property, integration, serialization, scheduler, and Rapier harness checks.
- **Browser_Proof**: Playwright validation of player-visible room, lobby, HUD, camera, accessibility, and baseline integration flows.
- **Human_Player**: One connected human participant represented by one session identity and at most one authoritative car.
- **Human_Player_Slot**: One capacity position occupied by one Human_Player.
- **Blue_Team**: The team whose authoritative team identifier is `blue`.
- **Orange_Team**: The team whose authoritative team identifier is `orange`.
- **Quick_Match_Total_Capacity**: Exactly six Human_Player_Slot values for Quick Match.
- **Quick_Match_Team_Capacity**: Exactly three Human_Player_Slot values per team for Quick Match.
- **Custom_Room_Total_Capacity**: Exactly eight Human_Player_Slot values for a Custom Room.
- **Custom_Room_Team_Capacity**: Exactly four Human_Player_Slot values per team for a Custom Room.
- **Stable_Roster_Order**: Ascending accepted-join order with session identifier as the deterministic tie breaker.
- **Capacity_Valid_Roster**: A roster with unique session identities whose total and per-team counts satisfy the active room type; a Quick Match countdown requires exactly three players per team, and a Custom Room countdown requires at least one player, no more than eight total players, and no more than four players per team.
- **Host**: The Human_Player authorized to start a Custom Room countdown.
- **Waiting_State**: A room phase in which gameplay has not started and eligible Human_Player joins or team changes may occur.
- **Countdown_State**: A room phase in which the kickoff countdown is active and car gameplay input is disabled.
- **Active_Play**: A room phase of regulation `playing` or Golden_Goal_Overtime in which authoritative gameplay is active.
- **Goal_Reset_State**: The bounded configurable delay after a non-winning Above_Zero_Regulation_Goal and before the next kickoff setup.
- **Ended_State**: The terminal room phase after the winner has been resolved, during which authoritative gameplay is inactive.
- **Kickoff_Epoch**: One initial or post-goal setup cycle ending when Active_Play resumes.
- **Kickoff_Slot**: A configured position and rotation identified by team and zero-based slot index.
- **Team_Facing**: A Kickoff_Slot orientation whose local forward axis points toward the arena center within one degree.
- **Unique_Spawn**: A set of assigned Kickoff_Slot transforms whose Car_Collider volumes do not intersect.
- **Authoritative_Snapshot**: A sequenced server message containing simulation time, match state, ball state, and one Car_Snapshot for each connected Human_Player in the room.
- **Car_Snapshot**: The bounded state record for one car, including session identity, team, transform, linear velocity, boost amount, and player-facing metadata.
- **Snapshot_Sequence**: A non-negative sequence number that increases for each Authoritative_Snapshot in one room stream.
- **Fixed_Step**: One authoritative simulation step of exactly `1/60` second.
- **Simulation_Callback**: One server scheduling callback that contributes elapsed time to the Fixed_Step_Accumulator.
- **Fixed_Step_Accumulator**: The server timing state that converts clamped Simulation_Callback elapsed time into zero or more Fixed_Step values.
- **Input_Command**: A validated client request containing normalized driving, steering, jump, camera, powerslide, and boost controls without an authoritative transform or score.
- **Input_Edge_Sequence**: A monotonically increasing identifier for a discrete input press transition, used to consume each jump or camera-toggle press at most once across repeated input heartbeats.
- **Scripted_Car_Model**: A controller model that commands chassis acceleration and angular response directly rather than deriving propulsion from simulated wheel torque.
- **Car_Collider**: The plain box collision body used by the Server_Simulation independently of the render mesh.
- **Local_Forward_Axis**: The car-space forward direction transformed into world space.
- **Local_Lateral_Axis**: The car-space right direction transformed into world space.
- **Local_Roof_Axis**: The car-space up direction transformed into world space.
- **Local_Down_Axis**: The direction opposite the Local_Roof_Axis.
- **Throttle_Acceleration_Curve**: The deterministic, speed-dependent grounded forward-acceleration function whose full-throttle output reaches zero at the Throttle_Target_Speed.
- **Throttle_Target_Speed**: The starting target of `14.1 m/s` for zero full-throttle acceleration without boost.
- **Boost_Acceleration**: The starting target of `9.91666 m/s²` added along the Local_Forward_Axis while boost is active.
- **Car_Max_Speed**: The starting target car linear-speed cap of `23 m/s`.
- **Steering_Curvature_Curve**: The deterministic relationship between forward speed, steering input, and commanded grounded turn curvature.
- **Powerslide_Input**: A held Input_Command control that reduces grounded lateral grip and increases turn curvature relative to normal steering at the same speed.
- **Aerodynamic_Drag_Hypothesis**: The unverified, configurable drag response applied opposite car motion.
- **Ball_Linear_Damping_Hypothesis**: The unverified, configurable Rapier linear-damping value for the ball, constrained to the inclusive range from `0` through `0.2 s⁻¹`.
- **First_Jump_Target**: The starting target velocity change of `2.91667 m/s` along the Local_Roof_Axis.
- **Jump_Hold**: A bounded additional roof-axis force applied while the initial jump control remains held.
- **Second_Jump_Window**: The unverified starting target of `1.25 seconds` after the accepted first jump.
- **Directional_Flip**: A second-jump action with directional input that produces bounded translational and rotational actuation.
- **Flip_Actuation_Window**: The unverified starting target maximum duration of `0.65 seconds` for Directional_Flip actuation.
- **Valid_Ground_Surface**: An Arena_System surface enabled for grounded traction, steering, and jump reset.
- **Core_Ground_Surface**: The floor, floor-to-wall ramp, and solid goal-interior surface set required in every build.
- **Advanced_Ground_Surface**: A wall, horizontal arena-corner transition, wall-to-ceiling transition, or ceiling surface required for declared wall-and-ceiling driving support.
- **Full_Surface_Driving**: The capability to maintain grounded control across Core_Ground_Surface and Advanced_Ground_Surface values.
- **CCD**: Continuous collision detection enabled on dynamic ball and car bodies to reduce tunnelling.
- **Finite_Output**: A numeric output that is neither `NaN` nor positive or negative infinity.
- **Ball_Max_Speed**: The ball linear-speed cap of `60 m/s`.
- **Arena_Width**: The inside field width of `81.92 m` along the world X axis.
- **Arena_Length**: The inside field length of `102.4 m` along the world Z axis.
- **Arena_Ceiling_Height**: The inside ceiling height of `20.44 m` along the world Y axis.
- **Corner_Cut**: A `45-degree`, `11.52 m` horizontal corner transition at each field corner.
- **Floor_Wall_Ramp**: A floor-to-wall transition reaching `2.56 m` above the floor.
- **Goal_Opening**: A centered opening `17.86 m` wide and `6.43 m` high.
- **Goal_Depth**: The solid goal-interior depth of `8.8 m` beyond the Goal_Line_Plane.
- **Goal_Line_Plane**: The vertical plane at the field end that separates the playing field from a goal interior.
- **Ball_Center_Crossing**: A transition in which the authoritative ball center moves from the field side to strictly beyond the Goal_Line_Plane while the ball center intersects the Goal_Line_Plane within the Goal_Opening bounds.
- **Regulation_Timer**: The authoritative match clock initialized to exactly `300 seconds`, clamped to zero, and resolved through Hard_Regulation_Cutoff when zero is first reached.
- **Regulation_Score**: A team's non-negative integer score during regulation, with no match-rule score cap.
- **Regulation_Goal_Target**: The confirmed regulation winning-score threshold of exactly `6` goals.
- **Regulation_Win_Margin**: The confirmed regulation winning-lead threshold of exactly `2` goals.
- **Above_Zero_Regulation_Goal**: A valid regulation goal produced during a Fixed_Step after which Regulation_Timer remains greater than zero.
- **Regulation_Win_Condition**: The condition after an Above_Zero_Regulation_Goal in which the scoring team's Regulation_Score is at least Regulation_Goal_Target and exceeds the opposing team's Regulation_Score by at least Regulation_Win_Margin.
- **Hard_Regulation_Cutoff**: The match resolution in the Fixed_Step that first reduces Regulation_Timer to zero, applying a valid goal from the same Fixed_Step before comparing scores and ending regulation before the next Fixed_Step.
- **Regulation_Goal_Reset_Duration**: The configurable Unverified_Tuning_Hypothesis initialized to `2 seconds` for Goal_Reset_State because the supplied mechanics reference identifies an approximate `~2 second` duration.
- **Golden_Goal_Overtime**: Untimed play entered after a tied Hard_Regulation_Cutoff in which the first valid goal ends the match regardless of either team's score or goal margin.
- **Boost_Inventory**: One car's authoritative boost amount clamped to the inclusive range from zero through 100.
- **Large_Boost_Pad**: A pad that grants 100 boost and respawns 10 seconds after collection.
- **Small_Boost_Pad**: A pad that grants 12 boost and respawns 4 seconds after collection.
- **Boost_Pad_Staging_Mode**: An explicitly labelled intermediate scope that delivers the six Large_Boost_Pad values before the 28 Small_Boost_Pad values.
- **Ball_Camera**: The default camera mode that tracks the authoritative-interpolated ball while retaining local-car context.
- **Car_Camera**: The toggleable camera mode that follows the authoritative-interpolated local car with Spring_Follow behavior.
- **Spring_Follow**: A bounded camera response using configurable distance, height, stiffness, damping, look-ahead, and field-of-view values.
- **Off_Screen_Ball_Indicator**: A viewport-edge HUD element that communicates the direction of a ball outside the visible viewport.
- **Screen_Center_Safe_Zone**: The central 20 percent of viewport width and central 20 percent of viewport height reserved from persistent HUD obstruction.
- **Confirmed_Starting_Target**: A value supplied as the initial acceptance target and retained unless approved evidence establishes a replacement.
- **Unverified_Tuning_Hypothesis**: A configurable value or curve requiring a finite validated range, authoritative reference evidence, and applicable physics or browser tuning before final release.
- **Reference_Evidence_Record**: A record containing source identity, source version or access date, original units, conversion, resulting value, and approval status.
- **Tuning_Approval_Record**: A record containing deterministic harness evidence, Browser_Proof evidence when player perception is affected, and explicit approval for one tuning hypothesis.
- **Feature_Status_Record**: A player-facing and maintainer-facing declaration of delivered and deferred mechanics for an intermediate build.
- **Hackathon_Staging_Build**: An intermediate build that is not the Mechanics_Fidelity_Release and may carry explicitly declared deferrals.
- **Mechanics_Fidelity_Release**: The final deliverable governed by this document after every non-deferred acceptance criterion and Release_Gate condition passes.

## Requirements

### Requirement 1: Preserve completed authority, netcode, audio, lobby, and stadium baselines

**User Story:** As a maintainer, I want completed foundations preserved while mechanics and capacity expand, so that the next slice does not regress shipped behavior.

#### Acceptance Criteria

1. THE Server_Simulation SHALL remain the sole authority for car transforms, ball transforms, physical contacts, Boost_Inventory, goals, scores, team membership, and match phases.
2. WHEN a connected Human_Player sends a validated Input_Command, THE Server_Simulation SHALL use the Input_Command only as control input for subsequent Fixed_Step processing.
3. IF a client message supplies a car transform, ball transform, physical contact, Boost_Inventory, goal, score, team membership, or match phase as an authoritative value, THEN THE Server_Simulation SHALL ignore the supplied value and preserve the corresponding authoritative state through the next produced Authoritative_Snapshot.
4. THE Server_Simulation SHALL retain a Fixed_Step of exactly `1/60` second.
5. IF a Simulation_Callback delta is negative or non-finite, THEN THE Server_Simulation SHALL contribute zero elapsed time to the Fixed_Step_Accumulator for that Simulation_Callback.
6. WHEN a Simulation_Callback supplies a finite non-negative delta, THE Server_Simulation SHALL clamp the contributed delta to at most `0.1` seconds before Fixed_Step_Accumulator processing.
7. WHEN a Simulation_Callback is processed, THE Server_Simulation SHALL execute at most five complete Fixed_Step values and retain a non-negative accumulator remainder smaller than one Fixed_Step after excess complete steps are discarded.
8. THE Snapshot_Transport SHALL retain Snapshot_Target_Interval and the corresponding finite non-negative scheduling tolerance independently of the Fixed_Step.
9. WHEN an accepted Authoritative_Snapshot would increase the interpolation buffer above 24 snapshots, THE Client_Presentation SHALL retain the 24 accepted Authoritative_Snapshot values with the greatest Snapshot_Sequence values.
10. THE Client_Presentation SHALL retain a `100` millisecond delayed render timeline.
11. THE Client_Presentation SHALL retain shortest-path quaternion interpolation.
12. IF the delayed render timeline exceeds the newest accepted Authoritative_Snapshot time by more than `80` milliseconds, THEN THE Client_Presentation SHALL extrapolate no farther than `80` milliseconds beyond the newest snapshot and hold the bounded result until a newer Authoritative_Snapshot is accepted.
13. WHEN a Mechanics_Fidelity_Release candidate is evaluated, THE Release_Gate SHALL require every completed Audio_System baseline assertion referenced by Requirements 16, 18, and 19 to pass.
14. WHEN a Mechanics_Fidelity_Release candidate is evaluated, THE Release_Gate SHALL require every completed Lobby_UI baseline assertion referenced by Requirements 2, 16, 18, and 19 to pass.
15. WHEN a Mechanics_Fidelity_Release candidate is evaluated, THE Release_Gate SHALL require every Stadium_Renderer alignment assertion referenced by Requirements 12 and 18 to pass.

### Requirement 2: Define separate multiplayer capacities

**User Story:** As a player, I want each room type to advertise and enforce the intended player count, so that Quick Match and Custom Room behavior is predictable.

#### Acceptance Criteria

1. THE Match_Configuration SHALL define Quick_Match_Total_Capacity as exactly 6 Human_Player_Slot values.
2. THE Match_Configuration SHALL define Quick_Match_Team_Capacity as exactly 3 Human_Player_Slot values.
3. THE Match_Configuration SHALL define Custom_Room_Total_Capacity as exactly 8 Human_Player_Slot values.
4. THE Match_Configuration SHALL define Custom_Room_Team_Capacity as exactly 4 Human_Player_Slot values.
5. THE Match_Configuration SHALL map Quick Match and Custom Room independently to the corresponding total and per-team capacities.
6. WHILE the Lobby_UI presents Quick Match as an available room type, THE Lobby_UI SHALL display a total limit of 6 and a per-team limit of 3.
7. WHILE the Lobby_UI presents Custom Room as an available room type, THE Lobby_UI SHALL display a total limit of 8 and a per-team limit of 4.
8. WHEN a room is created, THE Server_Simulation SHALL apply the total and per-team capacities mapped to the selected room type before accepting a Human_Player.
9. WHEN a room is created, THE Server_Simulation SHALL log the selected room type, total capacity, and per-team capacity.
10. IF a room-creation request resolves to capacities different from the Match_Configuration mapping, THEN THE Server_Simulation SHALL reject room creation and preserve every existing room roster and phase.

### Requirement 3: Enforce normal Quick Match as exactly 3 versus 3

**User Story:** As a Quick Match player, I want balanced six-player matchmaking with safe start gating, so that normal play starts only as a complete 3-versus-3 match.

#### Acceptance Criteria

1. WHEN a session identity absent from a non-full Quick Match requests to join, THE Quick_Match_Service SHALL add exactly one Human_Player and one Human_Player_Slot without changing any existing roster entry or team assignment.
2. IF a Quick Match join request uses a session identity already represented in the room, THEN THE Quick_Match_Service SHALL reject the request with a duplicate-identity reason and preserve the roster, team assignments, occupancy, room phase, countdown value, score, timer, ball state, and car states.
3. WHEN Blue_Team and Orange_Team contain equal player counts immediately before an accepted Quick Match assignment, THE Team_Assignment_Service SHALL assign the accepted Human_Player to Blue_Team.
4. WHEN Blue_Team and Orange_Team contain unequal player counts immediately before an accepted Quick Match assignment, THE Team_Assignment_Service SHALL assign the accepted Human_Player to the team with fewer players.
5. WHEN multiple accepted Quick Match assignments are pending, THE Team_Assignment_Service SHALL process the accepted Human_Player values in Stable_Roster_Order and use the updated team counts for each successive assignment.
6. WHEN a Quick Match assignment is accepted, THE Team_Assignment_Service SHALL leave the team-count difference at no more than one.
7. THE Quick_Match_Service SHALL keep total occupancy at no more than 6 and each team count at no more than 3.
8. IF a Quick Match already contains 6 Human_Player values, THEN THE Quick_Match_Service SHALL reject an additional join with a capacity-specific reason and preserve the roster, team assignments, occupancy, room phase, countdown value, score, timer, ball state, and car states.
9. WHEN a Quick Match in Waiting_State first reaches exactly 3 Blue_Team players and exactly 3 Orange_Team players, THE Quick_Match_Service SHALL begin exactly one fresh kickoff countdown from the full configured `3`-second duration.
10. WHILE a Quick Match has not entered Active_Play and does not contain exactly 3 Blue_Team players and exactly 3 Orange_Team players, THE Quick_Match_Service SHALL keep the room in Waiting_State without an active kickoff countdown.
11. WHEN a Human_Player disconnects from a Quick Match before Active_Play, THE Quick_Match_Service SHALL remove exactly the disconnected Human_Player, Human_Player_Slot, and authoritative car while preserving every remaining roster entry and team assignment.
12. IF Quick Match occupancy drops below 6 during Countdown_State, THEN THE Quick_Match_Service SHALL cancel the countdown before Active_Play, clear the countdown value, return the room to Waiting_State, and reopen eligible joins.
13. WHEN a cancelled Quick Match returns to exactly 3 Blue_Team players and exactly 3 Orange_Team players, THE Quick_Match_Service SHALL start a new countdown from the full configured `3`-second duration.
14. WHEN a Human_Player disconnects during Active_Play, THE Quick_Match_Service SHALL remove exactly the disconnected Human_Player, Human_Player_Slot, and authoritative car before the next Authoritative_Snapshot.
15. WHEN a Human_Player disconnects during Active_Play, THE Quick_Match_Service SHALL preserve Active_Play, the authoritative score, Regulation_Timer, ball state, remaining car states, remaining roster entries, and remaining team assignments without starting a disconnect-triggered reset or countdown.

### Requirement 4: Enforce Custom Room capacity, host control, and team switching

**User Story:** As a Custom Room participant, I want up to eight players with host-controlled starts and bounded team switching, so that private matches can support configurations through 4-versus-4.

#### Acceptance Criteria

1. WHEN a session identity absent from a non-full Custom Room requests to join, THE Custom_Room_Service SHALL add exactly one Human_Player and one Human_Player_Slot while preserving every existing roster entry, team assignment, Host designation, and room phase.
2. WHEN the first Human_Player joins an empty Custom Room, THE Custom_Room_Service SHALL designate the accepted Human_Player as the sole Host.
3. IF a Custom Room join request uses a session identity already represented in the room, THEN THE Custom_Room_Service SHALL reject the request with a duplicate-identity reason and preserve total occupancy, both team rosters, the Host designation, and the room phase.
4. WHEN both Custom Room teams have available capacity and unequal player counts, THE Team_Assignment_Service SHALL assign an accepted Human_Player to the team with fewer players.
5. WHEN both Custom Room teams have equal counts and available capacity, THE Team_Assignment_Service SHALL assign an accepted Human_Player to Blue_Team.
6. WHEN only one Custom Room team has available capacity, THE Team_Assignment_Service SHALL assign an accepted Human_Player to the team with available capacity.
7. THE Custom_Room_Service SHALL keep total Custom Room occupancy at no more than 8.
8. THE Custom_Room_Service SHALL keep each Custom Room team count at no more than 4.
9. IF a Custom Room already contains 8 Human_Player values, THEN THE Custom_Room_Service SHALL reject an additional join with a total-capacity reason and preserve total occupancy, both team rosters, the Host designation, and the room phase.
10. WHILE a Custom Room is in Waiting_State, WHEN a represented Human_Player requests the opposite team and the destination team contains fewer than 4 players, THE Custom_Room_Service SHALL change only the requesting Human_Player's team and preserve total occupancy, the Host designation, every other team assignment, and Waiting_State.
11. WHILE a Custom Room is in Waiting_State, IF a represented Human_Player requests the opposite team and the destination team contains 4 players, THEN THE Custom_Room_Service SHALL reject the switch with a team-capacity reason and preserve total occupancy, both team rosters, the Host designation, and Waiting_State.
12. IF a team-switch request occurs outside Waiting_State, identifies an unrepresented session, or does not identify the opposite team, THEN THE Custom_Room_Service SHALL reject the switch with a precondition-specific reason and preserve total occupancy, both team rosters, the Host designation, and the room phase.
13. WHILE a Custom Room is in Waiting_State with a Capacity_Valid_Roster, WHEN the Host requests match start, THE Custom_Room_Service SHALL begin exactly one kickoff countdown using the current roster and team assignments.
14. IF a non-Host requests Custom Room match start, THEN THE Custom_Room_Service SHALL reject the request and preserve the room phase, Host designation, total occupancy, and both team rosters.
15. IF a Custom Room match-start request occurs outside Waiting_State or without a Capacity_Valid_Roster, THEN THE Custom_Room_Service SHALL reject the request and preserve the room phase, Host designation, total occupancy, and both team rosters.
16. WHEN the Host disconnects before Active_Play and at least one Human_Player remains, THE Custom_Room_Service SHALL assign sole Host status to the earliest remaining Human_Player in Stable_Roster_Order.
17. WHEN the Host disconnects during Countdown_State and at least one Human_Player remains, THE Custom_Room_Service SHALL preserve the remaining countdown value without restarting or cancelling the countdown.
18. WHEN a Custom Room participant disconnects before Active_Play, THE Custom_Room_Service SHALL release exactly the participant's Human_Player_Slot and authoritative car before accepting the next join or team switch.
19. WHEN a Custom Room participant disconnects, THE Custom_Room_Service SHALL preserve every remaining roster entry and team assignment.
20. WHEN the final Human_Player leaves a Custom Room, THE Custom_Room_Service SHALL release the room roster and kickoff assignments, clear the Host designation, and set total and per-team occupancy to zero.

### Requirement 5: Assign deterministic, unique, team-facing kickoff slots

**User Story:** As a player, I want a distinct kickoff position facing the play, so that larger teams never spawn cars on top of one another.

#### Acceptance Criteria

1. THE Kickoff_Slot_Service SHALL define at least four Kickoff_Slot values for Blue_Team.
2. THE Kickoff_Slot_Service SHALL define at least four Kickoff_Slot values for Orange_Team.
3. THE Kickoff_Slot_Service SHALL mirror corresponding Blue_Team and Orange_Team Kickoff_Slot positions across the arena center.
4. THE Kickoff_Slot_Service SHALL make every assigned Kickoff_Slot Team_Facing.
5. WHEN a Capacity_Valid_Roster is established for a Kickoff_Epoch, THE Kickoff_Slot_Service SHALL map the Human_Player at zero-based position `i` in each team's Stable_Roster_Order to zero-based Kickoff_Slot index `i` for that team.
6. WHEN kickoff assignments are complete, THE Kickoff_Slot_Service SHALL assign exactly one same-team Kickoff_Slot to every roster identity, assign no Kickoff_Slot to an identity outside the roster, and assign no Kickoff_Slot to more than one identity.
7. WHEN a Quick Match contains three players on one team, THE Kickoff_Slot_Service SHALL assign three distinct Kickoff_Slot values to that team.
8. WHEN a Custom Room contains four players on one team, THE Kickoff_Slot_Service SHALL assign four distinct Kickoff_Slot values to that team.
9. WHEN kickoff assignments are complete for a Capacity_Valid_Roster, THE Kickoff_Slot_Service SHALL produce a Unique_Spawn across both teams.
10. WHEN a goal reset preserves roster identities, team memberships, and within-team Stable_Roster_Order, THE Kickoff_Slot_Service SHALL preserve every identity-to-slot assignment, position, and rotation from the preceding Kickoff_Epoch.
11. WHEN roster identities, team memberships, or within-team Stable_Roster_Order change before the next Kickoff_Epoch, THE Kickoff_Slot_Service SHALL preserve the last complete assignment until a deterministic replacement covers every current roster identity exactly once and produces a Unique_Spawn before any car is placed.
12. WHEN the same room type, configured Kickoff_Slot values, roster identities, team memberships, and within-team Stable_Roster_Order are evaluated repeatedly, THE Kickoff_Slot_Service SHALL return identical identity-to-slot assignments, positions, and rotations.
13. IF exact Rocket League kickoff-proximity selection is absent from a Hackathon_Staging_Build, THEN THE Feature_Status_Record SHALL identify kickoff-proximity selection as deferred while retaining deterministic Unique_Spawn behavior.

### Requirement 6: Keep eight-car snapshot transport bounded and correct

**User Story:** As a player in an eight-person room, I want every car represented consistently, so that multiplayer presentation remains synchronized at maximum capacity.

#### Acceptance Criteria

1. THE Snapshot_Transport SHALL bound one Authoritative_Snapshot to at most 8 Car_Snapshot records.
2. WHEN a room contains N connected Human_Player values, THE Snapshot_Transport SHALL include exactly N Car_Snapshot records where N is from zero through the room capacity.
3. WHEN an Authoritative_Snapshot contains Car_Snapshot records, THE Snapshot_Transport SHALL include each connected session identity exactly once and no disconnected or unrepresented session identity.
4. WHEN the Snapshot_Transport serializes and deserializes an Authoritative_Snapshot for a Custom Room containing exactly 8 Human_Player values, THE Snapshot_Transport SHALL preserve exactly 8 unique session identities and each identity's team, transform, linear velocity, Boost_Inventory, and Host metadata.
5. WHEN a Human_Player disconnects, THE Snapshot_Transport SHALL omit the disconnected session identity from the next produced Authoritative_Snapshot.
6. THE Snapshot_Transport SHALL emit a strictly increasing Snapshot_Sequence within one room stream.
7. THE Snapshot_Transport SHALL emit every numeric transform component, velocity component, timer value, and boost value as a Finite_Output within the applicable bound defined by this document or the corresponding finite validated range.
8. WHILE a room contains 8 active cars, THE Snapshot_Transport SHALL retain Snapshot_Target_Interval and the corresponding scheduling tolerance without increasing the authoritative Fixed_Step.
9. WHEN Client_Presentation accepts an Authoritative_Snapshot, THE Client_Presentation SHALL create or update exactly one rendered car for every Car_Snapshot session identity and remove rendered cars whose session identities are absent from the accepted snapshot.
10. IF Client_Presentation receives an Authoritative_Snapshot containing duplicate Car_Snapshot session identities, THEN THE Client_Presentation SHALL reject the entire snapshot and preserve the complete previously accepted authoritative presentation state and last accepted Snapshot_Sequence.
11. IF Client_Presentation receives an Authoritative_Snapshot whose Car_Snapshot count exceeds the configured room capacity, THEN THE Client_Presentation SHALL reject the entire snapshot and preserve the complete previously accepted authoritative presentation state and last accepted Snapshot_Sequence.
12. WHEN Client_Presentation accepts a maximum-capacity Custom Room snapshot, THE Client_Presentation SHALL present exactly one rendered car for each of the 8 distinct session identities.

### Requirement 7: Establish authoritative physics scale and bounded bodies

**User Story:** As a player, I want stable, reproducible authoritative physics, so that driving and ball interaction remain consistent across rooms and callback timing.

#### Acceptance Criteria

1. WHILE the Server_Simulation advances authoritative physics, THE Server_Simulation SHALL apply a gravity vector of `(0, -6.5, 0) m/s²`.
2. WHILE an authoritative car body participates in the Server_Simulation, THE Server_Simulation SHALL keep CCD enabled on the car body.
3. WHILE the authoritative ball body participates in the Server_Simulation, THE Server_Simulation SHALL keep CCD enabled on the ball body.
4. THE Car_Controller SHALL use a Scripted_Car_Model without simulated wheel-torque propulsion.
5. THE Car_Collider SHALL be a plain box collider independent of the car render mesh.
6. THE Car_Collider SHALL use the independently configurable length, width, and height values registered as separate Unverified_Tuning_Hypothesis values.
7. THE Car_Collider SHALL use a mass of exactly `150 kg`.
8. WHEN a Fixed_Step completes, THE Car_Controller SHALL leave every authoritative car's angular-speed magnitude at or below `5.5 rad/s`.
9. WHEN a Fixed_Step completes, THE Car_Controller SHALL leave every authoritative car's linear-speed magnitude at or below Car_Max_Speed plus `0.05 m/s`.
10. IF an input, tuning value, or physics observation required by a Fixed_Step is non-finite and a last validated finite value exists for the same quantity, THEN THE Server_Simulation SHALL substitute the last validated finite value before the quantity is applied.
11. IF an input, tuning value, or physics observation required by a Fixed_Step is non-finite and no last validated finite value exists for the same quantity, THEN THE Server_Simulation SHALL substitute the defined finite fallback before the quantity is applied.
12. WHEN a Fixed_Step completes, THE Server_Simulation SHALL expose only Finite_Output values for authoritative positions, rotations, linear velocities, angular velocities, forces, impulses, and inventory amounts.

### Requirement 8: Implement speed-dependent scripted driving, grip, powerslide, and boost

**User Story:** As a driver, I want acceleration, turning, grip, powerslide, and boost to follow Rocket League-style control rules, so that car handling rewards deliberate inputs.

#### Acceptance Criteria

1. THE Tuning_Registry SHALL initialize Throttle_Target_Speed to `14.1 m/s` before reference confirmation.
2. THE Tuning_Registry SHALL define Boost_Acceleration as exactly `9.91666 m/s²`.
3. THE Tuning_Registry SHALL define Car_Max_Speed as exactly `23 m/s`.
4. WHILE a car is grounded, full forward throttle is held, and non-negative forward speed is below Throttle_Target_Speed, THE Car_Controller SHALL command a Finite_Output positive acceleration along the Local_Forward_Axis according to the Throttle_Acceleration_Curve.
5. WHEN the Throttle_Acceleration_Curve is evaluated at two non-negative forward speeds below Throttle_Target_Speed under equal full-throttle input, THE Car_Controller SHALL produce an acceleration magnitude at the higher speed no greater than the acceleration magnitude at the lower speed.
6. WHILE a grounded car has non-negative forward speed at or above Throttle_Target_Speed and boost is inactive, THE Car_Controller SHALL command zero positive full-throttle acceleration along the Local_Forward_Axis.
7. WHEN normalized throttle magnitude increases at the same non-negative sub-target speed, THE Car_Controller SHALL produce a finite non-decreasing throttle-acceleration magnitude and map zero throttle magnitude to zero throttle acceleration.
8. WHILE boost is active and Boost_Inventory is greater than zero, THE Car_Controller SHALL add Boost_Acceleration along the Local_Forward_Axis independently of the Throttle_Acceleration_Curve.
9. WHILE a car is airborne and boost is active, THE Car_Controller SHALL apply Boost_Acceleration along the Local_Forward_Axis rather than a world-horizontal axis.
10. WHEN a car reaches Car_Max_Speed, THE Car_Controller SHALL prevent throttle or boost propulsion from increasing car linear speed above Car_Max_Speed.
11. WHILE a grounded car has nonzero Local_Lateral_Axis velocity and receives no new lateral contact impulse, THE Car_Controller SHALL reduce the finite absolute Local_Lateral_Axis velocity during each Fixed_Step.
12. WHILE Powerslide_Input is inactive, THE Car_Controller SHALL apply the configured normal grounded lateral-grip response.
13. WHILE Powerslide_Input is active, THE Car_Controller SHALL apply a lower finite lateral-grip response than normal grip for the same grounded state and input.
14. WHILE Powerslide_Input is active, THE Car_Controller SHALL command a greater finite turn-curvature magnitude than normal steering for the same grounded nonzero speed and steering input without changing the steering direction.
15. WHILE a car is grounded, THE Car_Controller SHALL map finite normalized steering input and current forward speed to finite commanded turn curvature through the Steering_Curvature_Curve.
16. WHEN a grounded car has zero steering input and receives no angular contact impulse during a Fixed_Step, THE Car_Controller SHALL reduce the finite absolute commanded yaw rate during that Fixed_Step.
17. WHILE the validated Aerodynamic_Drag_Hypothesis response is finite and greater than zero and the car has nonzero authoritative velocity, THE Car_Controller SHALL apply a Finite_Output drag response opposite the authoritative velocity.

### Requirement 9: Implement bounded jump, second-jump, flip, and air control

**User Story:** As a driver, I want first jumps, held jumps, second jumps, flips, and air control to have explicit windows, so that aerial actions are responsive and deterministic.

#### Acceptance Criteria

1. THE Tuning_Registry SHALL initialize First_Jump_Target to `2.91667 m/s`.
2. THE Tuning_Registry SHALL initialize Second_Jump_Window to `1.25` seconds and classify Second_Jump_Window as an Unverified_Tuning_Hypothesis.
3. THE Tuning_Registry SHALL initialize Flip_Actuation_Window to `0.65` seconds and classify Flip_Actuation_Window as an Unverified_Tuning_Hypothesis.
4. WHILE a car is grounded, WHEN an unconsumed Input_Edge_Sequence for jump is accepted, THE Car_Controller SHALL apply First_Jump_Target along the Local_Roof_Axis exactly once and record the Input_Edge_Sequence as consumed.
5. WHILE the accepted first-jump control remains continuously held and elapsed authoritative simulation time since acceptance is less than the configured Jump_Hold duration, THE Car_Controller SHALL apply the configured finite Jump_Hold force along the Local_Roof_Axis during each Fixed_Step.
6. IF the accepted first-jump control is released or elapsed authoritative simulation time reaches the configured Jump_Hold duration, THEN THE Car_Controller SHALL apply zero further Jump_Hold force for the accepted first-jump edge.
7. WHILE a car is airborne and second-jump availability is unconsumed, WHEN an unconsumed jump Input_Edge_Sequence is accepted at an elapsed time no greater than Second_Jump_Window and directional-input magnitude is below the configured deadzone, THE Car_Controller SHALL apply exactly one bounded second jump without Directional_Flip actuation and consume second-jump availability.
8. WHILE a car is airborne and second-jump availability is unconsumed, WHEN an unconsumed jump Input_Edge_Sequence is accepted at an elapsed time no greater than Second_Jump_Window and directional-input magnitude reaches the configured deadzone and Directional_Flip_Intent is satisfied, THE Car_Controller SHALL begin exactly one Directional_Flip in the requested local direction and consume second-jump availability.
   - THE Car_Controller SHALL treat Directional_Flip_Intent as satisfied only when directional-input magnitude has continuously reached the configured Directional_Flip_Intent threshold for at least the configured Directional_Flip_Intent step count immediately preceding the accepted jump Input_Edge_Sequence.
   - IF Directional_Flip_Intent is not satisfied at an accepted second-jump edge, THEN THE Car_Controller SHALL apply exactly one bounded second jump without Directional_Flip actuation and consume second-jump availability, so a brief directional tap cannot flip.
9. IF a new jump Input_Edge_Sequence occurs after Second_Jump_Window or after second-jump availability is consumed without an intervening Valid_Ground_Surface contact, THEN THE Car_Controller SHALL consume the Input_Edge_Sequence without applying an additional second jump or Directional_Flip and preserve the current jump-window start times.
10. WHILE a Directional_Flip is active, THE Car_Controller SHALL limit flip actuation to Flip_Actuation_Window.
11. WHEN elapsed authoritative simulation time since a Directional_Flip began reaches Flip_Actuation_Window, THE Car_Controller SHALL stop flip actuation and keep second-jump availability consumed until Valid_Ground_Surface contact.
12. WHEN Grounding_System confirms contact with a Valid_Ground_Surface, THE Car_Controller SHALL stop active Jump_Hold and Directional_Flip actuation and reset first-jump, second-jump, and Directional_Flip availability for the next unconsumed jump Input_Edge_Sequence.
13. IF an input heartbeat contains a jump Input_Edge_Sequence no greater than the greatest consumed jump sequence, THEN THE Car_Controller SHALL apply zero additional first-jump, second-jump, or Directional_Flip actuation and preserve active actuation windows.
14. WHILE a car is airborne, THE Car_Controller SHALL map configured pitch, yaw, and roll controls relative to the Local_Lateral_Axis, Local_Roof_Axis, and Local_Forward_Axis respectively.
15. WHILE a car is grounded, THE Car_Controller SHALL map steering input to grounded yaw behavior instead of airborne roll behavior.
16. THE Car_Controller SHALL keep combined air-control angular speed at or below `5.5 rad/s`.
17. IF a jump or air-control input component is malformed or non-finite, THEN THE Car_Controller SHALL substitute a finite neutral value for the affected component and preserve every other validated component.

### Requirement 10: Detect grounded support relative to car orientation

**User Story:** As a driver, I want ground support detected relative to the car, so that ramps and enabled arena surfaces provide consistent traction and jump reset behavior.

#### Acceptance Criteria

1. THE Grounding_System SHALL cast support rays along the Local_Down_Axis from each configured wheel or contact point.
2. THE Grounding_System SHALL use at least four distinct configured wheel or contact points distributed across the Car_Collider footprint.
3. WHEN a support ray hits enabled static non-sensor Arena_System collision within the configured contact distance and normal-angle threshold, THE Grounding_System SHALL classify the corresponding enabled surface as a Valid_Ground_Surface contact.
4. WHEN a support ray hits a dynamic car, the dynamic ball, a sensor, disabled collision, or a surface not enabled as a Valid_Ground_Surface, THE Grounding_System SHALL exclude the hit from support classification and jump reset.
5. THE Grounding_System SHALL classify every Core_Ground_Surface as a Valid_Ground_Surface.
6. THE Mechanics_Fidelity_Release SHALL classify every Core_Ground_Surface and Advanced_Ground_Surface as a Valid_Ground_Surface.
7. THE Mechanics_Fidelity_Release SHALL apply grounded traction, steering, and jump directions relative to the confirmed surface normal on every Valid_Ground_Surface.
8. WHERE Full_Surface_Driving is declared delivered, THE Grounding_System SHALL classify walls, Corner_Cut values, wall-to-ceiling transitions, and the ceiling as Advanced_Ground_Surface values.
9. WHERE Full_Surface_Driving is declared delivered, THE Car_Controller SHALL apply traction, steering, and jump directions relative to the confirmed surface normal.
10. WHERE wall or ceiling driving is deferred in a Hackathon_Staging_Build, THE Feature_Status_Record SHALL identify each deferred Advanced_Ground_Surface without claiming Full_Surface_Driving support.
11. WHEN one or more accepted support hits span adjacent enabled surfaces, THE Grounding_System SHALL produce a deterministic confirmed surface normal with Finite_Output components within the configured contact-distance and normal-angle ranges.
12. IF all support rays miss accepted static collision during a Fixed_Step, THEN THE Grounding_System SHALL classify the car as airborne and apply no grounded traction, steering, or jump reset from prior support.

### Requirement 11: Configure Rocket League-style ball behavior

**User Story:** As a player, I want a correctly scaled and bounded ball, so that impacts and scoring resemble the intended reference while remaining stable.

#### Acceptance Criteria

1. THE Ball_System SHALL use a ball radius of exactly `1.8 m`.
2. THE Ball_System SHALL use a ball mass of exactly `25 kg`.
3. THE Ball_System SHALL use a restitution coefficient of exactly `0.60`.
4. WHEN a Fixed_Step completes, THE Ball_System SHALL leave ball angular-speed magnitude at or below `6 rad/s`.
5. WHEN a Fixed_Step completes, THE Ball_System SHALL leave ball linear-speed magnitude at or below Ball_Max_Speed plus `0.05 m/s`.
6. THE Ball_System SHALL use Ball_Linear_Damping_Hypothesis as the configurable Rapier linear-damping value.
7. THE Ball_System SHALL constrain Ball_Linear_Damping_Hypothesis to the inclusive range from `0` through `0.2 s⁻¹`.
8. THE Server_Simulation SHALL preserve a car-to-ball mass ratio of exactly `6:1` from the `150 kg` car and `25 kg` ball masses.
9. WHEN Rapier resolves contact between the ball and authoritative collision geometry, THE Ball_System SHALL use the finite angular-velocity change produced by Rapier contact impulses and friction, subject to the ball angular-speed cap and finite recovery.
10. WHEN Rapier resolves a ball contact, THE Ball_System SHALL apply zero additional scripted angular impulse for that contact.
11. IF ball linear velocity or angular velocity becomes non-finite, THEN THE Ball_System SHALL restore the affected vector from the most recent finite bounded ball motion or a zero-vector fallback before the next Authoritative_Snapshot and preserve every unaffected finite ball-state value.

### Requirement 12: Build the metric arena and goal-line behavior

**User Story:** As a player, I want a closed, correctly scaled arena with solid goals, so that movement, rebounds, and scoring use predictable metric geometry.

#### Acceptance Criteria

1. THE Arena_System SHALL define Arena_Width as exactly `81.92 m`.
2. THE Arena_System SHALL define Arena_Length as exactly `102.4 m`.
3. THE Arena_System SHALL define Arena_Ceiling_Height as exactly `20.44 m`.
4. THE Arena_System SHALL define four Corner_Cut values with a horizontal length of exactly `11.52 m` and an angle of exactly `45 degrees`.
5. THE Arena_System SHALL define Floor_Wall_Ramp geometry reaching exactly `2.56 m` above the floor.
6. THE Arena_System SHALL define one centered Goal_Opening at each short end with a width of exactly `17.86 m` and a height of exactly `6.43 m`.
7. THE Arena_System SHALL define Goal_Depth as exactly `8.8 m` beyond each Goal_Line_Plane.
8. THE Arena_System SHALL form a closed collision volume around the floor, walls, corners, ceiling, and exterior goal boundaries.
9. THE Arena_System SHALL provide solid collision for each goal floor, side wall, roof, and back wall.
10. WHEN Stadium_Renderer presents an authoritative collision boundary, THE Stadium_Renderer SHALL align the visible boundary to the collision boundary within `0.05 m` in world space.
11. WHILE Active_Play is active and no goal has been awarded in the current Kickoff_Epoch, WHEN a Ball_Center_Crossing occurs, THE Goal_System SHALL increment the score of the team opposing the crossed goal by exactly one and preserve the other team's score.
12. IF the authoritative ball center is on a Goal_Line_Plane, remains on the field side, or reaches the goal-interior side without a preceding field-side position for the same plane, THEN THE Goal_System SHALL preserve both team scores.
13. IF the authoritative ball center crosses an end plane outside the corresponding Goal_Opening bounds, THEN THE Goal_System SHALL preserve both team scores and allow Arena_System collision to retain the ball.
14. WHEN a goal is awarded, THE Goal_System SHALL suppress additional scoring and preserve the resulting scores until the next Kickoff_Epoch resumes Active_Play with the ball on the field side of both Goal_Line_Plane values.
15. WHILE the ball travels at or below Ball_Max_Speed, THE Arena_System SHALL keep the ball inside the closed collision volume unless a Ball_Center_Crossing places the ball inside a goal interior.

### Requirement 13: Enforce regulation win-by-two, hard cutoff, kickoff resets, and golden-goal overtime

**User Story:** As a player, I want a confirmed regulation win condition and a hard match cutoff, so that above-zero goals require six goals with a two-goal lead and tied matches enter sudden-death overtime at zero.

#### Acceptance Criteria

1. WHEN the initial regulation Countdown_State begins for a match, THE Match_Flow_System SHALL initialize Regulation_Timer to exactly `300` seconds.
2. WHILE Regulation_Timer is greater than zero during regulation Active_Play, THE Match_Flow_System SHALL decrement Regulation_Timer by Fixed_Step elapsed time and clamp Regulation_Timer to a lower bound of zero.
3. THE Match_Configuration SHALL define one kickoff-countdown duration of exactly `3` seconds for initial regulation, post-goal regulation, and Golden_Goal_Overtime kickoffs.
4. THE Match_Configuration SHALL initialize Regulation_Goal_Reset_Duration to `2` seconds and expose Regulation_Goal_Reset_Duration as a configurable Unverified_Tuning_Hypothesis.
5. WHILE Countdown_State or Goal_Reset_State is active, THE Match_Flow_System SHALL decrement the active state's remaining duration by Fixed_Step elapsed time to a lower bound of zero.
6. WHILE Countdown_State or Goal_Reset_State is active, THE Match_Flow_System SHALL preserve both teams' Regulation_Score values and Regulation_Timer.
7. WHILE Countdown_State or Goal_Reset_State is active, THE Match_Flow_System SHALL disable car propulsion, steering, boost consumption, and jump actuation.
8. WHEN Countdown_State reaches zero with a Capacity_Valid_Roster, THE Match_Flow_System SHALL begin Active_Play and establish a new Kickoff_Epoch.
9. THE Match_Configuration SHALL define Regulation_Goal_Target as the confirmed value of exactly `6` goals.
10. THE Match_Configuration SHALL define Regulation_Win_Margin as the confirmed value of exactly `2` goals.
11. THE Match_Configuration SHALL apply the `300`-second Regulation_Timer duration, Regulation_Goal_Target, and Regulation_Win_Margin identically to Quick Match and Custom Room regulation.
12. WHILE Regulation_Timer is greater than zero, WHEN a valid regulation goal occurs, THE Goal_System SHALL increase the scoring team's Regulation_Score by exactly one without applying a match-rule Regulation_Score cap.
13. WHEN an Above_Zero_Regulation_Goal satisfies Regulation_Win_Condition, THE Match_Flow_System SHALL make Ended_State the next authoritative phase with the scoring team as winner and with no intervening Goal_Reset_State or Countdown_State.
14. WHEN an Above_Zero_Regulation_Goal satisfies Regulation_Win_Condition, THE Match_Flow_System SHALL emit exactly one terminal goal result containing the updated scores and the scoring team as winner.
15. WHEN an Above_Zero_Regulation_Goal leaves the scoring team's Regulation_Score below Regulation_Goal_Target or the scoring team's lead below Regulation_Win_Margin, THE Match_Flow_System SHALL enter Goal_Reset_State with the updated scores preserved and the remaining duration initialized to Regulation_Goal_Reset_Duration.
16. WHEN Goal_Reset_State reaches zero during regulation, THE Match_Flow_System SHALL restore the ball and cars to deterministic kickoff transforms with zero linear and angular velocities, preserve the updated scores and Regulation_Timer, and begin a fresh `3`-second kickoff countdown.
17. WHEN the Fixed_Step that first reduces Regulation_Timer to zero contains a valid regulation goal, THE Match_Flow_System SHALL apply the valid regulation goal exactly once before comparing the resulting scores.
18. WHEN a Fixed_Step first reduces Regulation_Timer to zero, THE Match_Flow_System SHALL compare the resulting scores after same-step goal processing and complete Hard_Regulation_Cutoff within that Fixed_Step.
19. WHEN Hard_Regulation_Cutoff compares unequal scores after same-step goal processing, THE Match_Flow_System SHALL make Ended_State the next authoritative phase with the leading team as winner regardless of Regulation_Goal_Target or Regulation_Win_Margin.
20. WHEN Hard_Regulation_Cutoff compares equal scores after same-step goal processing, THE Match_Flow_System SHALL preserve the tied Regulation_Score values, restore deterministic kickoff entities, and begin a fresh `3`-second Golden_Goal_Overtime countdown.
21. WHEN Hard_Regulation_Cutoff completes, THE Match_Flow_System SHALL process zero additional regulation control inputs and zero additional regulation physics steps.
22. WHILE Ended_State is active, THE Match_Flow_System SHALL keep gameplay control processing and authoritative car-and-ball physics inactive.
23. WHILE the Golden_Goal_Overtime Countdown_State is active, THE Match_Flow_System SHALL preserve deterministic kickoff transforms and zero linear and angular velocities for the ball and cars.
24. WHILE Active_Play is active during Golden_Goal_Overtime, THE Match_Flow_System SHALL keep overtime untimed and continue authoritative gameplay.
25. WHILE Active_Play is active during Golden_Goal_Overtime, WHEN the first valid goal occurs, THE Match_Flow_System SHALL make Ended_State the next authoritative phase with the scoring team as winner regardless of Regulation_Goal_Target, Regulation_Win_Margin, or either team's Regulation_Score.
26. WHERE demolition is deferred in a Hackathon_Staging_Build, THE Feature_Status_Record SHALL identify demolition as deferred without claiming demolition support.

### Requirement 14: Implement boost inventory and arena pads

**User Story:** As a player, I want a bounded boost economy with predictable pickups, so that boost management supports competitive movement.

#### Acceptance Criteria

1. WHEN Boost_Inventory changes, THE Boost_System SHALL clamp Boost_Inventory to the inclusive range from zero through 100.
2. WHEN a car is placed for a Kickoff_Epoch, THE Boost_System SHALL initialize the car's Boost_Inventory to exactly 33.
3. WHILE valid boost input is held during Active_Play and Boost_Inventory is greater than zero, THE Boost_System SHALL consume boost at `33.3` units per second using Fixed_Step elapsed time.
4. WHEN remaining Boost_Inventory is less than one Fixed_Step consumption amount, THE Boost_System SHALL consume only the remaining amount and clamp Boost_Inventory to zero.
5. WHILE boost has been consumed since the current Kickoff_Epoch and no valid boost input is held, THE Boost_System SHALL wait `1.25` seconds of authoritative simulation time and then regenerate Boost_Inventory at `12` units per second using Fixed_Step elapsed time, clamped to 100.
   - WHILE no boost has been consumed since the current Kickoff_Epoch, THE Boost_System SHALL preserve Boost_Inventory without passive regeneration.
   - WHILE valid boost input is held and Boost_Inventory is zero, THE Boost_System SHALL apply no regeneration for that Fixed_Step.
6. THE Arena_System SHALL provide exactly 6 Large_Boost_Pad values for the completed boost-pad target.
7. THE Arena_System SHALL provide exactly 28 Small_Boost_Pad values for the completed boost-pad target.
8. WHEN a car collects an active Large_Boost_Pad, THE Boost_System SHALL add 100 units, clamp Boost_Inventory to 100, and deactivate the collected pad exactly once.
9. WHEN a car collects an active Small_Boost_Pad, THE Boost_System SHALL add 12 units, clamp Boost_Inventory to 100, and deactivate the collected pad exactly once.
10. WHEN a Large_Boost_Pad is collected, THE Boost_System SHALL keep the pad inactive for exactly 10 seconds of authoritative simulation time.
11. WHEN a Small_Boost_Pad is collected, THE Boost_System SHALL keep the pad inactive for exactly 4 seconds of authoritative simulation time.
12. WHILE a boost pad is inactive, THE Boost_System SHALL grant zero boost from contact with the boost pad.
13. WHEN the applicable boost-pad respawn interval expires, THE Boost_System SHALL reactivate the corresponding pad for collection.
14. WHEN multiple cars reach one active boost pad during the same Fixed_Step, THE Boost_System SHALL award the pickup only to the earliest eligible car in Stable_Roster_Order and deactivate the pad exactly once.
15. WHERE Boost_Pad_Staging_Mode is enabled, THE Arena_System SHALL deliver all 6 Large_Boost_Pad values before declaring a Small_Boost_Pad milestone complete.
16. WHERE Boost_Pad_Staging_Mode delivers fewer than 28 Small_Boost_Pad values, THE Feature_Status_Record SHALL identify the delivered count and the remaining deferred count without declaring the Small_Boost_Pad milestone complete.
17. THE Mechanics_Fidelity_Release SHALL include all 6 Large_Boost_Pad values and all 28 Small_Boost_Pad values.

### Requirement 15: Provide default ball camera and toggleable spring car camera

**User Story:** As a player, I want readable ball tracking and an optional car-follow view, so that camera control supports both play styles.

#### Acceptance Criteria

1. WHEN a Human_Player first enters Active_Play in a client session, THE Camera_System SHALL select Ball_Camera before rendering the first Active_Play camera frame.
2. WHEN an unconsumed camera-toggle Input_Edge_Sequence is accepted, THE Camera_System SHALL perform exactly one transition between Ball_Camera and Car_Camera and record the Input_Edge_Sequence as consumed.
3. IF a camera input update contains no unconsumed camera-toggle Input_Edge_Sequence, THEN THE Camera_System SHALL perform zero camera-mode transitions.
4. WHILE Ball_Camera is active, THE Camera_System SHALL set the camera look target to the authoritative-interpolated ball position.
5. WHILE Ball_Camera is active, THE Camera_System SHALL derive the camera origin from the authoritative-interpolated local-car anchor using the configured Ball_Camera framing values.
6. WHILE Car_Camera is active, THE Camera_System SHALL apply Spring_Follow to the authoritative-interpolated local car.
7. THE Camera_System SHALL clamp Spring_Follow position, rotation, and field-of-view outputs to finite configured bounds.
8. WHEN the local car or ball undergoes a kickoff teleport, THE Camera_System SHALL preserve the selected camera mode, rebase affected camera targets to post-teleport authoritative-interpolated samples, and apply no interpolation or extrapolation across pre-teleport and post-teleport transforms.
9. THE Camera_System SHALL keep camera mode local to Client_Presentation without changing Server_Simulation state.
10. IF a camera tuning update contains a non-finite or out-of-range value, THEN THE Camera_System SHALL reject the complete update and preserve the selected camera mode and last validated finite camera configuration.
11. IF no last validated camera configuration exists at Camera_System initialization, THEN THE Camera_System SHALL use the finite configurable starting values registered for the Ball_Camera and Spring_Follow Unverified_Tuning_Hypothesis values.

### Requirement 16: Present capacity, match, boost, and ball-direction HUD information accessibly

**User Story:** As a player, I want a readable and accessible lobby and gameplay HUD, so that match state remains understandable without obscuring play.

#### Acceptance Criteria

1. WHILE a player is in a room lobby, THE HUD_System SHALL display current total occupancy and total capacity for the active room type.
2. WHILE a player is in a room lobby, THE HUD_System SHALL display current Blue_Team and Orange_Team occupancy with the applicable per-team capacity.
3. WHILE Active_Play is visible, THE HUD_System SHALL display authoritative Blue_Team score, Orange_Team score, Regulation_Timer or Golden_Goal_Overtime state, and local Boost_Inventory.
4. WHILE Countdown_State is visible, THE HUD_System SHALL display the current kickoff countdown value as a screen-center transient notice.
5. WHILE Goal_Reset_State is visible after an Above_Zero_Regulation_Goal that does not satisfy Regulation_Win_Condition, THE HUD_System SHALL display the scoring team and updated score as a screen-center transient notice.
6. WHEN the ball lies outside the visible viewport during Active_Play, THE HUD_System SHALL display an Off_Screen_Ball_Indicator fully within the viewport edge in the ball's projected direction.
7. WHEN the ball returns inside the visible viewport, THE HUD_System SHALL hide the Off_Screen_Ball_Indicator.
8. THE HUD_System SHALL keep persistent scoreboard, timer, boost, and ball-direction elements outside the Screen_Center_Safe_Zone.
9. THE HUD_System SHALL expose accessible names and current values matching the presented room capacity, team counts, score, timer state, boost amount, and camera mode.
10. WHEN an authoritative countdown starts, changes displayed value, completes, or is cancelled, THE HUD_System SHALL include the current countdown value or completion state in the live-region update for that authoritative transition.
11. WHEN one authoritative transition starts, changes, completes, or cancels a countdown or includes a goal, Hard_Regulation_Cutoff resolution, Golden_Goal_Overtime entry, or Ended_State entry, THE HUD_System SHALL expose exactly one non-interruptive live-region update containing every player-visible result from that authoritative transition.
12. THE HUD_System SHALL distinguish Blue_Team and Orange_Team using text or shape in addition to color.
13. THE HUD_System SHALL render every visible value and notice required by this requirement with a contrast ratio of at least `4.5:1` against the immediate background.
14. WHEN viewport dimensions are at least `1280 by 720` CSS pixels, THE HUD_System SHALL keep persistent HUD elements and screen-center transient notices fully inside the viewport and pairwise non-overlapping.
15. WHEN mute or volume controls are present, THE HUD_System SHALL preserve the completed accessible names, keyboard operation, focus indication, and persisted values of the Audio_System controls as regression behavior.
16. WHEN an Above_Zero_Regulation_Goal satisfies Regulation_Win_Condition, THE HUD_System SHALL display the scoring team, updated final score, and winner as a terminal screen-center notice.
17. WHEN Hard_Regulation_Cutoff resolves unequal scores, THE HUD_System SHALL display the leading team, final score, and Ended_State as a terminal screen-center notice.
18. WHEN Hard_Regulation_Cutoff resolves equal scores, THE HUD_System SHALL display the tied regulation score and the fresh `3`-second Golden_Goal_Overtime countdown.
19. WHEN the first valid goal occurs during Golden_Goal_Overtime, THE HUD_System SHALL display the scoring team, updated final score, and winner as a terminal screen-center notice.
20. WHEN one authoritative transition satisfies more than one screen-center notice condition in this requirement, THE HUD_System SHALL display exactly one screen-center notice containing every player-visible outcome from that authoritative transition.

### Requirement 17: Treat unverified reference values as configurable, verification-gated hypotheses

**User Story:** As a maintainer, I want uncertain reference values clearly labelled and proven before release, so that the game does not present guesses as verified Rocket League fidelity.

#### Acceptance Criteria

1. THE Tuning_Registry SHALL classify each numeric target not identified as an Unverified_Tuning_Hypothesis as a Confirmed_Starting_Target.
2. THE Tuning_Registry SHALL represent the `1.18 m` length, `0.84 m` width, and `0.36 m` height Car_Collider dimensions as separate Unverified_Tuning_Hypothesis values.
3. THE Tuning_Registry SHALL represent Throttle_Acceleration_Curve provenance and Throttle_Target_Speed provenance as Unverified_Tuning_Hypothesis values.
4. THE Tuning_Registry SHALL represent Aerodynamic_Drag_Hypothesis parameters as Unverified_Tuning_Hypothesis values.
5. THE Tuning_Registry SHALL represent Ball_Linear_Damping_Hypothesis as an Unverified_Tuning_Hypothesis value.
6. THE Tuning_Registry SHALL represent Jump_Hold force, Jump_Hold duration, Second_Jump_Window, and Flip_Actuation_Window as Unverified_Tuning_Hypothesis values.
7. THE Tuning_Registry SHALL represent boost-pad hitbox dimensions and boost-pad placement coordinates as Unverified_Tuning_Hypothesis values.
8. THE Tuning_Registry SHALL represent Steering_Curvature_Curve samples as Unverified_Tuning_Hypothesis values until authoritative curve evidence is approved.
9. THE Tuning_Registry SHALL represent Ball_Camera framing values and Spring_Follow distance, height, stiffness, damping, look-ahead, and field-of-view defaults as Unverified_Tuning_Hypothesis values.
10. THE Tuning_Registry SHALL represent support-ray contact distance, support-ray contact-point placement, and support-normal angle threshold as Unverified_Tuning_Hypothesis values.
11. THE Tuning_Registry SHALL represent Regulation_Goal_Reset_Duration as an Unverified_Tuning_Hypothesis initialized to `2` seconds.
12. THE Tuning_Registry SHALL store units, verification status, finite starting values, and finite inclusive validated ranges for every Unverified_Tuning_Hypothesis.
13. IF a proposed Unverified_Tuning_Hypothesis value or range bound is non-finite, a proposed lower bound exceeds the corresponding upper bound, or a proposed value lies outside the corresponding validated range, THEN THE Tuning_Registry SHALL reject the complete proposal and retain the last validated value and range.
14. WHEN authoritative reference evidence is accepted for an Unverified_Tuning_Hypothesis, THE Tuning_Registry SHALL associate a Reference_Evidence_Record with the resulting configured value and validated range.
15. IF accepted reference evidence contradicts a starting hypothesis, THEN THE Tuning_Registry SHALL adopt the finite evidence-backed value within the evidence-backed validated range and retain the prior value and range in the change record.
16. WHEN a Confirmed_Starting_Target changes, THE Tuning_Registry SHALL require a Reference_Evidence_Record and approval rationale before the changed value becomes release eligible.
17. THE Release_Gate SHALL require one approved Reference_Evidence_Record for every Unverified_Tuning_Hypothesis before declaring the Mechanics_Fidelity_Release complete.
18. THE Release_Gate SHALL require deterministic physics-harness evidence for every Unverified_Tuning_Hypothesis that affects authoritative mechanics.
19. THE Release_Gate SHALL require Browser_Proof tuning evidence for every Unverified_Tuning_Hypothesis that affects camera, HUD readability, or player-perceived control.
20. THE Release_Gate SHALL require one Tuning_Approval_Record for every Unverified_Tuning_Hypothesis before declaring the Mechanics_Fidelity_Release complete.
21. WHERE a Hackathon_Staging_Build retains an unconfirmed hypothesis, THE Feature_Status_Record SHALL identify the hypothesis as unverified and prevent a final-fidelity claim.

### Requirement 18: Validate mechanics, capacity, determinism, and authority

**User Story:** As a maintainer, I want deterministic automated proof of the new mechanics and capacities, so that tuning and multiplayer changes remain reproducible.

#### Acceptance Criteria

1. WHEN the Validation_Suite exercises the Throttle_Acceleration_Curve over at least 100 generated finite speeds, THE Validation_Suite SHALL verify non-increasing full-throttle acceleration through Throttle_Target_Speed.
2. WHEN the Validation_Suite exercises throttle and boost over at least 100 generated Input_Command sequences, THE Validation_Suite SHALL verify Throttle_Target_Speed, Boost_Acceleration, and Car_Max_Speed bounds.
3. WHEN the Validation_Suite exercises grounded lateral motion without a new lateral impulse, THE Validation_Suite SHALL verify decreasing finite absolute lateral speed.
4. WHEN the Validation_Suite compares normal grip with Powerslide_Input at equal state and input, THE Validation_Suite SHALL verify lower powerslide grip and greater powerslide turn curvature.
5. WHEN the Validation_Suite exercises jump presses before, at, and after Second_Jump_Window, THE Validation_Suite SHALL verify exactly one permitted second jump or Directional_Flip within the inclusive window and zero late actuation.
6. WHEN the Validation_Suite exercises Directional_Flip duration, THE Validation_Suite SHALL verify that actuation ends no later than Flip_Actuation_Window.
7. WHEN the Validation_Suite constructs authoritative car and ball bodies, THE Validation_Suite SHALL verify masses of `150 kg` and `25 kg` and a `6:1` mass ratio.
8. WHEN the Validation_Suite inspects arena geometry, THE Validation_Suite SHALL verify every metric dimension, closed boundary, solid goal interior, Corner_Cut, Floor_Wall_Ramp, and Goal_Opening requirement.
9. WHEN the Validation_Suite moves the ball across each Goal_Line_Plane, THE Validation_Suite SHALL verify scoring only for a Ball_Center_Crossing within Goal_Opening bounds and exactly one score change per Kickoff_Epoch crossing.
10. WHEN the Validation_Suite partitions equal accepted elapsed time into finite Simulation_Callback sequences that trigger neither delta clamping nor excess-step dropping, THE Validation_Suite SHALL verify identical Fixed_Step counts and authoritative state differences no greater than `1e-5` for equal initial states and Input_Command sequences.
11. WHEN the Validation_Suite generates at least 100 finite and non-finite controller-input and tuning-value edge cases, THE Validation_Suite SHALL verify Finite_Output and configured speed-cap invariants.
12. WHEN the Validation_Suite joins 6 Quick Match players, THE Validation_Suite SHALL verify deterministic balanced assignment of exactly 3 Blue_Team and 3 Orange_Team players.
13. WHEN the Validation_Suite varies Quick Match occupancy around 6 before Active_Play, THE Validation_Suite SHALL verify start only at exactly 3 players per team, countdown cancellation below 6, return to Waiting_State, and a fresh countdown after capacity is restored.
14. WHEN the Validation_Suite disconnects a Quick Match player during Active_Play, THE Validation_Suite SHALL verify removal of only the disconnected identity and car and preservation of Active_Play, score, Regulation_Timer, ball state, remaining car states, and remaining roster.
15. WHEN the Validation_Suite joins and switches Custom Room players through capacity boundaries, THE Validation_Suite SHALL verify the total limit of 8, per-team limit of 4, deterministic assignment, deterministic Host reassignment, Host-only start, and rejection without partial roster mutation.
16. WHEN the Validation_Suite evaluates every capacity-valid roster ordering, THE Validation_Suite SHALL verify a one-to-one identity-to-Kickoff_Slot mapping, identical repeated mappings, and no intersecting assigned Car_Collider volumes.
17. WHEN the Validation_Suite serializes and deserializes a maximum-capacity Custom Room snapshot, THE Validation_Suite SHALL verify exactly 8 Car_Snapshot records, 8 unique session identities, preserved identity-associated fields, and Finite_Output for every numeric field.
18. IF the Validation_Suite submits a client request containing a forged transform, score, Boost_Inventory, team membership, or match phase, THEN THE Validation_Suite SHALL verify rejection and preservation of the corresponding authoritative values through the next produced Authoritative_Snapshot.
19. WHEN the Validation_Suite places a car on each enabled Valid_Ground_Surface, THE Validation_Suite SHALL verify Local_Down_Axis support detection, surface-relative control, jump reset, and finite transition output.
20. WHEN the Validation_Suite exercises boost consumption and pad collection over equal simulated durations, THE Validation_Suite SHALL verify inventory bounds, Fixed_Step-scaled consumption, grants, deterministic contention, and respawn intervals.
21. WHEN the Validation_Suite executes the Fixed_Step that first reduces Regulation_Timer to zero with a valid regulation goal, THE Validation_Suite SHALL verify that the valid regulation goal is applied exactly once before the final score comparison.
22. WHEN the Validation_Suite executes a kickoff countdown configured to `3` seconds, THE Validation_Suite SHALL verify that Active_Play begins after exactly 180 Fixed_Step values and does not begin earlier.
23. WHEN the Validation_Suite executes an Above_Zero_Regulation_Goal that does not satisfy Regulation_Win_Condition with Regulation_Goal_Reset_Duration configured to the `2`-second starting target, THE Validation_Suite SHALL verify exactly one score change, exactly 120 Fixed_Step values in Goal_Reset_State, deterministic kickoff restoration, and the subsequent fresh countdown.
24. WHEN the Validation_Suite runs baseline regressions, THE Validation_Suite SHALL verify fixed-step scheduling, snapshot interpolation, input-edge deduplication, Audio_System behavior, Lobby_UI behavior, and Stadium_Renderer alignment.
25. WHEN a property test uses generated cases, THE Validation_Suite SHALL execute at least 100 cases from a recorded deterministic seed and reproduce the same ordered cases and result when rerun with that seed.
26. WHEN a Rapier harness terminates after success, assertion failure, or setup failure, THE Validation_Suite SHALL release every created physics world and body resource.
27. WHEN the Validation_Suite evaluates Above_Zero_Regulation_Goal outcomes with scoring-team-to-opponent scores of `6-4`, `7-5`, and `8-6`, THE Validation_Suite SHALL verify direct entry into Ended_State with the scoring team as winner.
28. WHEN the Validation_Suite evaluates Above_Zero_Regulation_Goal outcomes with scoring-team-to-opponent scores of `5-3`, `6-5`, `6-6`, and `7-6`, THE Validation_Suite SHALL verify entry into Goal_Reset_State with the updated scores preserved.
29. WHEN a deterministic property test evaluates at least 100 generated Above_Zero_Regulation_Goal outcomes without applying a match-rule Regulation_Score cap in which the scoring team's Regulation_Score is below Regulation_Goal_Target or the scoring team's lead is below Regulation_Win_Margin, THE Validation_Suite SHALL verify entry into Goal_Reset_State with the updated scores preserved.
30. WHEN a deterministic property test evaluates at least 100 generated Above_Zero_Regulation_Goal outcomes without applying a match-rule Regulation_Score cap in which the resulting scores are tied or the scoring team's lead is exactly one goal, THE Validation_Suite SHALL verify entry into Goal_Reset_State with the updated scores preserved.
31. WHEN a deterministic property test evaluates at least 100 generated Above_Zero_Regulation_Goal outcomes without applying a match-rule Regulation_Score cap in which the scoring team's Regulation_Score is at least Regulation_Goal_Target and the scoring team's lead is at least Regulation_Win_Margin, THE Validation_Suite SHALL verify direct entry into Ended_State with the scoring team as winner, including outcomes with a lead equal to Regulation_Win_Margin.
32. WHEN the Validation_Suite executes Hard_Regulation_Cutoff with unequal final scores, including a leading Regulation_Score below Regulation_Goal_Target or a lead below Regulation_Win_Margin, THE Validation_Suite SHALL verify immediate entry into Ended_State with the leading team as winner.
33. WHEN the Validation_Suite executes Hard_Regulation_Cutoff with equal final scores after same-step goal processing, THE Validation_Suite SHALL verify deterministic kickoff restoration and a fresh `3`-second Golden_Goal_Overtime countdown.
34. WHEN the Validation_Suite completes Hard_Regulation_Cutoff resolution, THE Validation_Suite SHALL verify zero subsequent regulation control inputs and zero subsequent regulation physics steps.
35. WHEN the Validation_Suite advances Golden_Goal_Overtime without a valid goal, THE Validation_Suite SHALL verify that Golden_Goal_Overtime remains active with no time limit.
36. WHEN the Validation_Suite applies the first valid goal during Golden_Goal_Overtime, THE Validation_Suite SHALL verify direct entry into Ended_State with the scoring team as winner regardless of Regulation_Goal_Target, Regulation_Win_Margin, or either team's Regulation_Score.
37. WHEN the Validation_Suite executes the regulation and Golden_Goal_Overtime outcome matrix, THE Validation_Suite SHALL verify identical match-win rules for Quick Match and Custom Room.
38. WHEN the Validation_Suite executes regulation without an Above_Zero_Regulation_Goal that satisfies Regulation_Win_Condition, THE Validation_Suite SHALL verify Hard_Regulation_Cutoff after exactly `18,000` regulation Active_Play Fixed_Step values and no earlier.

### Requirement 19: Prove player-visible room, lobby, HUD, and camera flows in a browser

**User Story:** As a player, I want visible multiplayer and presentation behavior proven in a real browser, so that automated mechanics correctness is reflected accurately in the interface.

#### Acceptance Criteria

1. THE Browser_Proof SHALL use browser assertions for player-visible room, lobby, HUD, camera, accessibility, and completed-baseline integration behavior.
2. THE Browser_Proof SHALL use Validation_Suite and Rapier harness results rather than browser-only observation as acceptance evidence for Fixed_Step processing and authoritative force, impulse, contact, and timestep mechanics.
3. WHEN the Quick Match lobby is loaded, THE Browser_Proof SHALL observe a 6-player total capacity and a 3-player capacity for each team.
4. WHEN six browser clients occupy Quick Match, THE Browser_Proof SHALL observe exactly 3 Blue_Team players, exactly 3 Orange_Team players, exactly one rendered car for each accepted session identity, and exactly one kickoff countdown displaying `3`, `2`, and `1` in order before Active_Play.
5. WHEN one Quick Match browser client disconnects before Active_Play, THE Browser_Proof SHALL observe countdown cancellation, Waiting_State, the disconnected identity absent, and every remaining accepted identity preserved.
6. IF a seventh browser client attempts to join a full Quick Match, THEN THE Browser_Proof SHALL observe a capacity-specific rejection, unchanged accepted session identities and team counts, and no lobby entry or rendered car for the rejected identity.
7. WHEN the Custom Room lobby is loaded, THE Browser_Proof SHALL observe an 8-player total capacity and a 4-player capacity for each team.
8. IF a Custom Room browser client requests a switch to a team containing 4 players, THEN THE Browser_Proof SHALL observe a team-capacity rejection and unchanged team rosters, team counts, Host identity, and room phase.
9. WHEN a non-Host requests Custom Room start during Waiting_State and the Host subsequently requests start, THE Browser_Proof SHALL observe rejection with Waiting_State preserved after the non-Host request and exactly one `3`-second countdown after the Host request.
10. IF a ninth browser client attempts to join a full Custom Room, THEN THE Browser_Proof SHALL observe a capacity-specific rejection, unchanged accepted session identities, team counts, Host identity, and room phase, and no lobby entry or rendered car for the rejected identity.
11. WHILE Active_Play is visible in a full-capacity Quick Match or Custom Room, THE Browser_Proof SHALL observe score, Regulation_Timer or Golden_Goal_Overtime state, and local Boost_Inventory matching authoritative state, the displayed camera mode matching Camera_System state, and exactly one rendered car per accepted session identity.
12. WHEN a player holds one camera-toggle press through repeated input heartbeats, releases the control, and performs a second press, THE Browser_Proof SHALL observe exactly one camera transition for the first Input_Edge_Sequence, zero additional transitions while held or released, and exactly one transition for the second Input_Edge_Sequence.
13. WHEN the ball leaves and re-enters the visible viewport, THE Browser_Proof SHALL observe Off_Screen_Ball_Indicator appearance in the projected direction and subsequent removal.
14. WHEN a countdown, non-winning regulation goal, terminal regulation goal, Hard_Regulation_Cutoff, Golden_Goal_Overtime, or match-end transition occurs, THE Browser_Proof SHALL observe exactly one readable screen-center notice and exactly one corresponding accessible live-region update containing every player-visible outcome from that authoritative transition.
15. WHEN an Above_Zero_Regulation_Goal that does not satisfy Regulation_Win_Condition enters Goal_Reset_State, THE Browser_Proof SHALL observe the scoring-team and updated-score notice throughout Goal_Reset_State and replacement by the kickoff-countdown notice when the subsequent Countdown_State begins.
16. WHERE browser sound support is available, WHEN a real user gesture activates Audio_System regression coverage, THE Browser_Proof SHALL observe the completed Audio_System baseline remaining operational during expanded multiplayer play.
17. WHEN all Browser_Proof scenarios complete, THE Browser_Proof SHALL report zero uncaught page exceptions and zero Rocket_Arena error-level console messages across tested browser clients.
18. WHEN an Above_Zero_Regulation_Goal satisfies Regulation_Win_Condition in Quick Match and Custom Room browser scenarios, THE Browser_Proof SHALL observe the terminal goal result, updated final score, winning team, and Ended_State as the next authoritative phase.
19. WHEN an Above_Zero_Regulation_Goal produces a scoring-team-to-opponent score of `6-5` in Quick Match and `7-6` in Custom Room, THE Browser_Proof SHALL observe Goal_Reset_State followed by a fresh `3`-second kickoff countdown in both scenarios.
20. WHEN Hard_Regulation_Cutoff resolves unequal scores below Regulation_Goal_Target or separated by one goal, THE Browser_Proof SHALL observe Regulation_Timer at `0:00`, the leading team as winner, and every subsequent gameplay frame in Ended_State.
21. WHEN Hard_Regulation_Cutoff resolves equal scores, THE Browser_Proof SHALL observe deterministic kickoff presentation, a fresh `3`-second Golden_Goal_Overtime countdown, and untimed Golden_Goal_Overtime after the countdown.
22. WHEN the first valid goal occurs during Golden_Goal_Overtime, THE Browser_Proof SHALL observe the updated final score, scoring team as winner, and immediate Ended_State regardless of the displayed total score or goal margin.
