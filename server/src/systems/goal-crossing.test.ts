import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESOLVED_ARENA_GEOMETRY,
  type ResolvedArenaGoalRegion,
} from '@rocket-arena/shared';
import {
  advanceGoalCrossing,
  createGoalCrossingState,
  type AuthoritativeBallCenter,
  type GoalCrossingState,
} from './goal-crossing.js';

function center(x: number, y: number, z: number): AuthoritativeBallCenter {
  return Object.freeze({ x, y, z });
}

function goal(zDirection: -1 | 1): ResolvedArenaGoalRegion {
  return RESOLVED_ARENA_GEOMETRY.goals.find((candidate) => (
    candidate.zDirection === zDirection
  ))!;
}

function armedState(
  kickoffEpoch: number,
  ballCenter: AuthoritativeBallCenter = center(0, 1, 0),
): Readonly<GoalCrossingState> {
  const initial = createGoalCrossingState(RESOLVED_ARENA_GEOMETRY.goals);
  const result = advanceGoalCrossing(initial, {
    previousBallCenter: ballCenter,
    currentBallCenter: ballCenter,
    kickoffEpoch,
    activePlay: true,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.crossing, null);
  assert.equal(result.state.rearmedKickoffEpoch, kickoffEpoch);
  return result.state;
}

// Validates: Requirements 12.11, 12.13, 18.9
for (const zDirection of [-1, 1] as const) {
  test(`swept high-speed crossing awards the team opposing the ${zDirection} goal`, () => {
    const crossedGoal = goal(zDirection);
    const previous = center(
      crossedGoal.opening.centerX,
      crossedGoal.opening.bottomY + crossedGoal.opening.height / 2,
      crossedGoal.goalLineZ - zDirection * 20,
    );
    const current = center(previous.x, previous.y, crossedGoal.goalLineZ + zDirection * 20);
    const result = advanceGoalCrossing(armedState(3, previous), {
      previousBallCenter: previous,
      currentBallCenter: current,
      kickoffEpoch: 3,
      activePlay: true,
    });

    assert.equal(result.accepted, true);
    assert.equal(result.crossing?.crossedGoal, crossedGoal);
    assert.equal(result.crossing?.mirroredGoalId, crossedGoal.mirroredGoalId);
    assert.equal(
      result.crossing?.scoringTeam,
      crossedGoal.defendingTeam === 'blue' ? 'orange' : 'blue',
    );
    assert.equal(result.crossing?.intersection.z, crossedGoal.goalLineZ);
    assert.equal(result.state.awardedKickoffEpoch, 3);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.state), true);
    assert.equal(Object.isFrozen(result.crossing), true);
  });
}

// Validates: Requirements 12.12-12.13
test('on-plane endpoints, same-side motion, and outside-opening intersections do not score', () => {
  const orangeGoal = goal(1);
  const field = center(0, 1, orangeGoal.goalLineZ - 2);
  const onPlane = center(0, 1, orangeGoal.goalLineZ);
  const beyond = center(0, 1, orangeGoal.goalLineZ + 2);

  const onPlaneResult = advanceGoalCrossing(armedState(7, field), {
    previousBallCenter: field,
    currentBallCenter: onPlane,
    kickoffEpoch: 7,
    activePlay: true,
  });
  assert.equal(onPlaneResult.crossing, null);

  const beyondAfterPlane = advanceGoalCrossing(onPlaneResult.state, {
    previousBallCenter: onPlane,
    currentBallCenter: beyond,
    kickoffEpoch: 7,
    activePlay: true,
  });
  assert.equal(beyondAfterPlane.crossing, null);

  const sameSide = advanceGoalCrossing(armedState(8), {
    previousBallCenter: center(0, 1, 0),
    currentBallCenter: center(0, 1, 1),
    kickoffEpoch: 8,
    activePlay: true,
  });
  assert.equal(sameSide.crossing, null);

  const outsideX = orangeGoal.opening.centerX + orangeGoal.opening.width / 2 + 0.01;
  const outside = advanceGoalCrossing(armedState(9, center(outsideX, 1, 0)), {
    previousBallCenter: center(outsideX, 1, 0),
    currentBallCenter: center(outsideX, 1, orangeGoal.goalLineZ + 2),
    kickoffEpoch: 9,
    activePlay: true,
  });
  assert.equal(outside.crossing, null);
});

// Validates: Requirements 12.12, 12.14
test('unarmed goal-interior teleports do not score and one award is suppressed until rearmed in a new epoch', () => {
  const orangeGoal = goal(1);
  const inside = center(0, 1, orangeGoal.goalLineZ + 1);
  const deeperInside = center(0, 1, orangeGoal.goalLineZ + 2);
  const initial = createGoalCrossingState(RESOLVED_ARENA_GEOMETRY.goals);
  const teleported = advanceGoalCrossing(initial, {
    previousBallCenter: inside,
    currentBallCenter: deeperInside,
    kickoffEpoch: 11,
    activePlay: true,
  });
  assert.equal(teleported.crossing, null);
  assert.equal(teleported.state.rearmedKickoffEpoch, null);

  const field = center(0, 1, 0);
  const firstAward = advanceGoalCrossing(armedState(12, field), {
    previousBallCenter: field,
    currentBallCenter: inside,
    kickoffEpoch: 12,
    activePlay: true,
  });
  assert.notEqual(firstAward.crossing, null);

  const returned = advanceGoalCrossing(firstAward.state, {
    previousBallCenter: inside,
    currentBallCenter: field,
    kickoffEpoch: 12,
    activePlay: true,
  });
  const suppressed = advanceGoalCrossing(returned.state, {
    previousBallCenter: field,
    currentBallCenter: inside,
    kickoffEpoch: 12,
    activePlay: true,
  });
  assert.equal(suppressed.crossing, null);

  const inactiveNewEpoch = advanceGoalCrossing(suppressed.state, {
    previousBallCenter: inside,
    currentBallCenter: field,
    kickoffEpoch: 13,
    activePlay: false,
  });
  assert.equal(inactiveNewEpoch.state.rearmedKickoffEpoch, null);
  assert.equal(inactiveNewEpoch.state.planes['blue-goal'].armedFromFieldSide, false);
  assert.equal(inactiveNewEpoch.state.planes['orange-goal'].armedFromFieldSide, false);

  const secondAward = advanceGoalCrossing(inactiveNewEpoch.state, {
    previousBallCenter: field,
    currentBallCenter: inside,
    kickoffEpoch: 13,
    activePlay: true,
  });
  assert.notEqual(secondAward.crossing, null);
  assert.equal(secondAward.state.awardedKickoffEpoch, 13);
});

// Validates: Requirements 12.12-12.14
test('duplicate, discontinuous, stale, and non-finite samples preserve detector state identity', () => {
  const field = center(0, 1, 0);
  const state = armedState(20, field);
  for (const input of [
    {
      previousBallCenter: field,
      currentBallCenter: field,
      kickoffEpoch: 20,
      activePlay: true,
      reason: 'duplicate-sample',
    },
    {
      previousBallCenter: center(0, 1, 1),
      currentBallCenter: center(0, 1, 2),
      kickoffEpoch: 20,
      activePlay: true,
      reason: 'discontinuous-sample',
    },
    {
      previousBallCenter: field,
      currentBallCenter: center(0, 1, 1),
      kickoffEpoch: 19,
      activePlay: true,
      reason: 'stale-kickoff-epoch',
    },
    {
      previousBallCenter: field,
      currentBallCenter: center(Number.NaN, 1, 1),
      kickoffEpoch: 20,
      activePlay: true,
      reason: 'non-finite-ball-center',
    },
  ] as const) {
    const result = advanceGoalCrossing(state, input);
    assert.equal(result.accepted, false);
    assert.equal(result.rejectionReason, input.reason);
    assert.equal(result.state, state);
    assert.equal(result.crossing, null);
  }
});
