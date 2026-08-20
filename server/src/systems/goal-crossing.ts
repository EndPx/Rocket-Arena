import type {
  ArenaVector3Tuple,
  ResolvedArenaGoalRegion,
  Team,
} from '@rocket-arena/shared';

export type GoalId = ResolvedArenaGoalRegion['id'];

/** Object form accepted directly from Rapier and authoritative room state. */
export interface AuthoritativeBallCenter {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Tuple form is accepted for shared geometry/snapshot adapters. */
export type AuthoritativeBallCenterInput = AuthoritativeBallCenter | ArenaVector3Tuple;

export interface GoalPlaneCrossingState {
  /** Immutable resolved record used as the source of every goal boundary. */
  readonly goal: ResolvedArenaGoalRegion;
  /** True only after this plane has observed a strict field-side sample. */
  readonly armedFromFieldSide: boolean;
}

export type GoalPlaneCrossingStates = Readonly<Record<GoalId, GoalPlaneCrossingState>>;

/**
 * Pure detector state. A kickoff epoch is eligible to score only after
 * rearmedKickoffEpoch matches kickoffEpoch.
 */
export interface GoalCrossingState {
  readonly planes: GoalPlaneCrossingStates;
  readonly kickoffEpoch: number | null;
  readonly rearmedKickoffEpoch: number | null;
  readonly awardedKickoffEpoch: number | null;
  readonly activePlay: boolean;
  /** Last accepted Active Play center; inactive phases deliberately clear it. */
  readonly previousBallCenter: AuthoritativeBallCenter | null;
}

export interface GoalCrossingStepInput {
  readonly previousBallCenter: AuthoritativeBallCenterInput;
  readonly currentBallCenter: AuthoritativeBallCenterInput;
  readonly kickoffEpoch: number;
  readonly activePlay: boolean;
}

export interface GoalCrossingAward {
  readonly kickoffEpoch: number;
  readonly crossedGoal: ResolvedArenaGoalRegion;
  readonly crossedGoalId: GoalId;
  readonly mirroredGoalId: GoalId;
  readonly defendingTeam: Team;
  readonly scoringTeam: Team;
  readonly previousBallCenter: AuthoritativeBallCenter;
  readonly currentBallCenter: AuthoritativeBallCenter;
  readonly intersection: AuthoritativeBallCenter;
  /** Swept segment parameter, strictly between zero and one. */
  readonly intersectionT: number;
}

export type GoalCrossingRejectionReason =
  | 'invalid-active-play-state'
  | 'invalid-kickoff-epoch'
  | 'non-finite-ball-center'
  | 'stale-kickoff-epoch'
  | 'discontinuous-sample'
  | 'duplicate-sample'
  | 'non-finite-intersection';

export interface GoalCrossingStepResult {
  /** False only when the complete sample was rejected and state is unchanged. */
  readonly accepted: boolean;
  readonly rejectionReason: GoalCrossingRejectionReason | null;
  readonly state: Readonly<GoalCrossingState>;
  readonly crossing: Readonly<GoalCrossingAward> | null;
}

const GOAL_IDS = Object.freeze(['blue-goal', 'orange-goal'] as const);

type FrozenCenter = Readonly<AuthoritativeBallCenter>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function copyCenter(value: AuthoritativeBallCenterInput): FrozenCenter | null {
  if (Array.isArray(value)) {
    if (value.length !== 3
        || !isFiniteNumber(value[0])
        || !isFiniteNumber(value[1])
        || !isFiniteNumber(value[2])) {
      return null;
    }
    return Object.freeze({ x: value[0], y: value[1], z: value[2] });
  }

  if (typeof value !== 'object'
      || value === null
      || !isFiniteNumber(value.x)
      || !isFiniteNumber(value.y)
      || !isFiniteNumber(value.z)) {
    return null;
  }
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

function copyTuple(value: ArenaVector3Tuple): ArenaVector3Tuple {
  return Object.freeze([value[0], value[1], value[2]] as const);
}

function isDeeplyFrozenGoal(goal: ResolvedArenaGoalRegion): boolean {
  return Object.isFrozen(goal)
    && Object.isFrozen(goal.opening)
    && Object.isFrozen(goal.bounds)
    && Object.isFrozen(goal.bounds.min)
    && Object.isFrozen(goal.bounds.max)
    && Object.isFrozen(goal.surfaceIds)
    && Object.isFrozen(goal.primitiveIds);
}

/** Preserve canonical resolved-record identity; defensively snapshot ad-hoc fixtures. */
function immutableGoal(goal: ResolvedArenaGoalRegion): ResolvedArenaGoalRegion {
  if (isDeeplyFrozenGoal(goal)) return goal;
  return Object.freeze({
    ...goal,
    opening: Object.freeze({ ...goal.opening }),
    bounds: Object.freeze({
      min: copyTuple(goal.bounds.min),
      max: copyTuple(goal.bounds.max),
    }),
    surfaceIds: Object.freeze([...goal.surfaceIds]),
    primitiveIds: Object.freeze([...goal.primitiveIds]),
  });
}

function assertResolvedGoalPair(
  goals: readonly ResolvedArenaGoalRegion[],
): readonly [ResolvedArenaGoalRegion, ResolvedArenaGoalRegion] {
  if (!Array.isArray(goals) || goals.length !== GOAL_IDS.length) {
    throw new TypeError('Goal crossing requires exactly two resolved goal records.');
  }

  const byId = new Map<GoalId, ResolvedArenaGoalRegion>();
  for (const candidate of goals) {
    if (typeof candidate !== 'object' || candidate === null
        || !GOAL_IDS.includes(candidate.id)
        || byId.has(candidate.id)
        || (candidate.defendingTeam !== 'blue' && candidate.defendingTeam !== 'orange')
        || (candidate.zDirection !== -1 && candidate.zDirection !== 1)
        || !isFiniteNumber(candidate.goalLineZ)
        || !isFiniteNumber(candidate.backWallZ)
        || typeof candidate.opening !== 'object'
        || candidate.opening === null
        || !isFiniteNumber(candidate.opening.centerX)
        || !isFiniteNumber(candidate.opening.bottomY)
        || !isFiniteNumber(candidate.opening.width)
        || candidate.opening.width <= 0
        || !isFiniteNumber(candidate.opening.height)
        || candidate.opening.height <= 0
        || !Number.isFinite(candidate.opening.centerX - candidate.opening.width / 2)
        || !Number.isFinite(candidate.opening.centerX + candidate.opening.width / 2)
        || !Number.isFinite(candidate.opening.bottomY + candidate.opening.height)
        || (candidate.backWallZ - candidate.goalLineZ) * candidate.zDirection <= 0) {
      throw new TypeError('Goal crossing received an invalid resolved goal record.');
    }
    byId.set(candidate.id, immutableGoal(candidate));
  }

  const blue = byId.get('blue-goal');
  const orange = byId.get('orange-goal');
  if (blue === undefined
      || orange === undefined
      || blue.defendingTeam !== 'blue'
      || orange.defendingTeam !== 'orange'
      || blue.mirroredGoalId !== orange.id
      || orange.mirroredGoalId !== blue.id
      || blue.zDirection === orange.zDirection
      || !isStrictlyFieldSide(blue, { x: 0, y: 0, z: orange.goalLineZ })
      || !isStrictlyFieldSide(orange, { x: 0, y: 0, z: blue.goalLineZ })) {
    throw new TypeError('Resolved goal records must be a reciprocal Blue/Orange mirror pair.');
  }
  return Object.freeze([blue, orange] as const);
}

function freezePlanes(
  blueGoal: ResolvedArenaGoalRegion,
  blueArmed: boolean,
  orangeGoal: ResolvedArenaGoalRegion,
  orangeArmed: boolean,
): GoalPlaneCrossingStates {
  return Object.freeze({
    'blue-goal': Object.freeze({ goal: blueGoal, armedFromFieldSide: blueArmed }),
    'orange-goal': Object.freeze({ goal: orangeGoal, armedFromFieldSide: orangeArmed }),
  });
}

function freezeState(
  planes: GoalPlaneCrossingStates,
  kickoffEpoch: number | null,
  rearmedKickoffEpoch: number | null,
  awardedKickoffEpoch: number | null,
  activePlay: boolean,
  previousBallCenter: FrozenCenter | null,
): Readonly<GoalCrossingState> {
  return Object.freeze({
    planes,
    kickoffEpoch,
    rearmedKickoffEpoch,
    awardedKickoffEpoch,
    activePlay,
    previousBallCenter,
  });
}

function acceptedResult(
  state: Readonly<GoalCrossingState>,
  crossing: Readonly<GoalCrossingAward> | null = null,
): Readonly<GoalCrossingStepResult> {
  return Object.freeze({
    accepted: true,
    rejectionReason: null,
    state,
    crossing,
  });
}

function rejectedResult(
  state: Readonly<GoalCrossingState>,
  rejectionReason: GoalCrossingRejectionReason,
): Readonly<GoalCrossingStepResult> {
  return Object.freeze({
    accepted: false,
    rejectionReason,
    state,
    crossing: null,
  });
}

function sameCenter(left: AuthoritativeBallCenter, right: AuthoritativeBallCenter): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function isStrictlyFieldSide(
  goal: ResolvedArenaGoalRegion,
  center: AuthoritativeBallCenter,
): boolean {
  return goal.zDirection === 1
    ? center.z < goal.goalLineZ
    : center.z > goal.goalLineZ;
}

function isStrictlyBeyond(
  goal: ResolvedArenaGoalRegion,
  center: AuthoritativeBallCenter,
): boolean {
  return goal.zDirection === 1
    ? center.z > goal.goalLineZ
    : center.z < goal.goalLineZ;
}

function bothPlanesFieldSide(
  planes: GoalPlaneCrossingStates,
  center: AuthoritativeBallCenter,
): boolean {
  return isStrictlyFieldSide(planes['blue-goal'].goal, center)
    && isStrictlyFieldSide(planes['orange-goal'].goal, center);
}

function opposingTeam(defendingTeam: Team): Team {
  return defendingTeam === 'blue' ? 'orange' : 'blue';
}

type IntersectionResult =
  | Readonly<{ readonly kind: 'outside-opening' }>
  | Readonly<{
    readonly kind: 'inside-opening';
    readonly point: FrozenCenter;
    readonly t: number;
  }>
  | Readonly<{ readonly kind: 'non-finite' }>;

const OUTSIDE_OPENING: IntersectionResult = Object.freeze({ kind: 'outside-opening' });
const NON_FINITE_INTERSECTION: IntersectionResult = Object.freeze({ kind: 'non-finite' });

function openingIntersection(
  goal: ResolvedArenaGoalRegion,
  previous: AuthoritativeBallCenter,
  current: AuthoritativeBallCenter,
): IntersectionResult {
  const deltaZ = current.z - previous.z;
  const deltaX = current.x - previous.x;
  const deltaY = current.y - previous.y;
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)
      || !Number.isFinite(deltaZ) || deltaZ === 0) {
    return NON_FINITE_INTERSECTION;
  }

  const t = (goal.goalLineZ - previous.z) / deltaZ;
  if (!Number.isFinite(t) || t <= 0 || t >= 1) return NON_FINITE_INTERSECTION;
  const point = Object.freeze({
    x: previous.x + t * deltaX,
    y: previous.y + t * deltaY,
    z: goal.goalLineZ,
  });
  if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return NON_FINITE_INTERSECTION;

  const minimumX = goal.opening.centerX - goal.opening.width / 2;
  const maximumX = goal.opening.centerX + goal.opening.width / 2;
  const minimumY = goal.opening.bottomY;
  const maximumY = goal.opening.bottomY + goal.opening.height;
  if (point.x < minimumX || point.x > maximumX
      || point.y < minimumY || point.y > maximumY) {
    return OUTSIDE_OPENING;
  }
  return Object.freeze({ kind: 'inside-opening', point, t });
}

function award(
  goal: ResolvedArenaGoalRegion,
  kickoffEpoch: number,
  previous: FrozenCenter,
  current: FrozenCenter,
  intersection: Extract<IntersectionResult, { readonly kind: 'inside-opening' }>,
): Readonly<GoalCrossingAward> {
  return Object.freeze({
    kickoffEpoch,
    crossedGoal: goal,
    crossedGoalId: goal.id,
    mirroredGoalId: goal.mirroredGoalId,
    defendingTeam: goal.defendingTeam,
    scoringTeam: opposingTeam(goal.defendingTeam),
    previousBallCenter: previous,
    currentBallCenter: current,
    intersection: intersection.point,
    intersectionT: intersection.t,
  });
}

/**
 * Create an unarmed detector from the exact two resolved goal records.
 * Canonical frozen goal objects retain identity; mutable fixtures are snapshotted.
 */
export function createGoalCrossingState(
  goals: readonly ResolvedArenaGoalRegion[],
): Readonly<GoalCrossingState> {
  const [blueGoal, orangeGoal] = assertResolvedGoalPair(goals);
  return freezeState(
    freezePlanes(blueGoal, false, orangeGoal, false),
    null,
    null,
    null,
    false,
    null,
  );
}

/**
 * Consume one ordered authoritative center segment.
 *
 * Invalid/non-finite/stale samples return the original state object. Valid
 * inactive samples clear all active-play evidence. A new epoch cannot score
 * until Active Play observes the ball strictly field-side of both planes.
 */
export function advanceGoalCrossing(
  state: Readonly<GoalCrossingState>,
  input: GoalCrossingStepInput,
): Readonly<GoalCrossingStepResult> {
  if (typeof input.activePlay !== 'boolean') {
    return rejectedResult(state, 'invalid-active-play-state');
  }
  if (!Number.isSafeInteger(input.kickoffEpoch) || input.kickoffEpoch < 0) {
    return rejectedResult(state, 'invalid-kickoff-epoch');
  }

  const previous = copyCenter(input.previousBallCenter);
  const current = copyCenter(input.currentBallCenter);
  if (previous === null || current === null) {
    return rejectedResult(state, 'non-finite-ball-center');
  }
  if (state.kickoffEpoch !== null && input.kickoffEpoch < state.kickoffEpoch) {
    return rejectedResult(state, 'stale-kickoff-epoch');
  }

  const blueGoal = state.planes['blue-goal'].goal;
  const orangeGoal = state.planes['orange-goal'].goal;
  if (!input.activePlay) {
    return acceptedResult(freezeState(
      freezePlanes(blueGoal, false, orangeGoal, false),
      input.kickoffEpoch,
      null,
      state.awardedKickoffEpoch,
      false,
      null,
    ));
  }

  const continuingEpoch = state.activePlay && state.kickoffEpoch === input.kickoffEpoch;
  if (continuingEpoch && state.previousBallCenter !== null
      && !sameCenter(state.previousBallCenter, previous)) {
    return rejectedResult(state, 'discontinuous-sample');
  }
  if (continuingEpoch && state.previousBallCenter !== null
      && sameCenter(previous, current)) {
    return rejectedResult(state, 'duplicate-sample');
  }

  const readyBeforeSegment = continuingEpoch
    && state.rearmedKickoffEpoch === input.kickoffEpoch;
  const previousIsKickoffFieldSide = bothPlanesFieldSide(state.planes, previous);
  const currentIsKickoffFieldSide = bothPlanesFieldSide(state.planes, current);
  // An epoch change observed while play was still active is a discontinuity, not
  // proof of a resumed kickoff. Only the post-change current sample may rearm it.
  const changedEpochWithoutInactivePhase = state.activePlay && !continuingEpoch;
  const readyAtSegmentStart = readyBeforeSegment
    || (!changedEpochWithoutInactivePhase && previousIsKickoffFieldSide);

  let blueArmed = readyBeforeSegment
    ? state.planes['blue-goal'].armedFromFieldSide
    : false;
  let orangeArmed = readyBeforeSegment
    ? state.planes['orange-goal'].armedFromFieldSide
    : false;
  if (readyAtSegmentStart) {
    blueArmed = blueArmed || isStrictlyFieldSide(blueGoal, previous);
    orangeArmed = orangeArmed || isStrictlyFieldSide(orangeGoal, previous);
  }

  let crossing: Readonly<GoalCrossingAward> | null = null;
  if (readyAtSegmentStart && state.awardedKickoffEpoch !== input.kickoffEpoch) {
    for (const [goal, armed] of [
      [blueGoal, blueArmed],
      [orangeGoal, orangeArmed],
    ] as const) {
      if (!armed
          || !isStrictlyFieldSide(goal, previous)
          || !isStrictlyBeyond(goal, current)) {
        continue;
      }
      const intersection = openingIntersection(goal, previous, current);
      if (intersection.kind === 'non-finite') {
        return rejectedResult(state, 'non-finite-intersection');
      }
      if (intersection.kind === 'inside-opening') {
        crossing = award(goal, input.kickoffEpoch, previous, current, intersection);
        break;
      }
    }
  }

  if (crossing !== null) {
    const nextState = freezeState(
      freezePlanes(blueGoal, false, orangeGoal, false),
      input.kickoffEpoch,
      input.kickoffEpoch,
      input.kickoffEpoch,
      true,
      current,
    );
    return acceptedResult(nextState, crossing);
  }

  const rearmedKickoffEpoch = readyAtSegmentStart || currentIsKickoffFieldSide
    ? input.kickoffEpoch
    : null;
  if (rearmedKickoffEpoch === input.kickoffEpoch
      && state.awardedKickoffEpoch !== input.kickoffEpoch) {
    blueArmed = blueArmed || currentIsKickoffFieldSide
      || isStrictlyFieldSide(blueGoal, current);
    orangeArmed = orangeArmed || currentIsKickoffFieldSide
      || isStrictlyFieldSide(orangeGoal, current);
  } else if (state.awardedKickoffEpoch === input.kickoffEpoch) {
    blueArmed = false;
    orangeArmed = false;
  }

  return acceptedResult(freezeState(
    freezePlanes(blueGoal, blueArmed, orangeGoal, orangeArmed),
    input.kickoffEpoch,
    rearmedKickoffEpoch,
    state.awardedKickoffEpoch,
    true,
    current,
  ));
}
