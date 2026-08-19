import assert from 'node:assert/strict';
import test from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  KICKOFF_SLOTS,
  TUNING_IDS,
  getConstant,
  getScalarTuningValue,
  type KickoffSlotIndex,
  type Team,
} from '@rocket-arena/shared';
import { createCarPhysicsState } from '../physics/car.js';
import {
  prepareResetToKickoff,
  resetToKickoff,
  type KickoffCarBody,
} from './scoring.js';
import type { KickoffAssignment } from './kickoff-slots.js';

function assignment(
  sessionId: string,
  team: Team,
  slotIndex: KickoffSlotIndex,
): Readonly<KickoffAssignment> {
  const slot = KICKOFF_SLOTS[team][slotIndex];
  assert.ok(slot);
  return Object.freeze({
    sessionId,
    team,
    slotId: slot.id,
    slotIndex,
    position: slot.position,
    rotation: slot.rotation,
  });
}

function bodySnapshot(body: RAPIER.RigidBody): unknown {
  return structuredClone({
    position: body.translation(),
    rotation: body.rotation(),
    linearVelocity: body.linvel(),
    angularVelocity: body.angvel(),
  });
}

function assertVectorNear(
  actual: { x: number; y: number; z: number },
  expected: readonly [number, number, number],
  tolerance = 1e-6,
): void {
  assert.ok(Math.abs(actual.x - expected[0]) <= tolerance, `${actual.x} != ${expected[0]}`);
  assert.ok(Math.abs(actual.y - expected[1]) <= tolerance, `${actual.y} != ${expected[1]}`);
  assert.ok(Math.abs(actual.z - expected[2]) <= tolerance, `${actual.z} != ${expected[2]}`);
}

function assertQuaternionNear(
  actual: { x: number; y: number; z: number; w: number },
  expected: readonly [number, number, number, number],
  tolerance = 1e-6,
): void {
  assertVectorNear(actual, [expected[0], expected[1], expected[2]], tolerance);
  assert.ok(Math.abs(actual.w - expected[3]) <= tolerance, `${actual.w} != ${expected[3]}`);
}

function createBody(
  world: RAPIER.World,
  position: readonly [number, number, number],
): RAPIER.RigidBody {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(...position),
  );
  body.setLinvel({ x: 4, y: 5, z: 6 }, true);
  body.setAngvel({ x: 1, y: 2, z: 3 }, true);
  return body;
}

// Validates: Requirements 5.5-5.10

test('prepared scoring reset applies complete kickoff transforms and can restore every body atomically', async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -6.5, z: 0 });

  try {
    const ball = createBody(world, [7, 8, 9]);
    const blueBody = createBody(world, [1, 2, 3]);
    const orangeBody = createBody(world, [-1, 2, -3]);
    const blueState = createCarPhysicsState();
    const orangeState = createCarPhysicsState();
    Object.assign(blueState, { count: 2, grounded: true, airborneTime: 4 });
    Object.assign(orangeState, { count: 1, wasGrounded: true, landingTime: 5 });
    const cars = new Map<string, KickoffCarBody>([
      ['blue-player', { body: blueBody, jumpState: blueState }],
      ['orange-player', { body: orangeBody, jumpState: orangeState }],
    ]);
    const assignments = new Map<string, Readonly<KickoffAssignment>>([
      ['blue-player', assignment('blue-player', 'blue', 0)],
      ['orange-player', assignment('orange-player', 'orange', 0)],
    ]);
    const before = structuredClone({
      ball: bodySnapshot(ball),
      blue: bodySnapshot(blueBody),
      orange: bodySnapshot(orangeBody),
      blueState,
      orangeState,
    });

    const ballRadius = getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.ball.radius,
    );
    const prepared = prepareResetToKickoff(ball, cars, assignments, ballRadius);
    assert.deepEqual(structuredClone({
      ball: bodySnapshot(ball),
      blue: bodySnapshot(blueBody),
      orange: bodySnapshot(orangeBody),
      blueState,
      orangeState,
    }), before, 'preparation captures state without moving any body');

    prepared.apply();
    assertVectorNear(ball.translation(), [
      0,
      ballRadius + getConstant('BALL.SPAWN_CLEARANCE'),
      0,
    ]);
    for (const [sessionId, entry] of cars) {
      const expected = assignments.get(sessionId)!;
      assertVectorNear(entry.body.translation(), expected.position);
      assertQuaternionNear(entry.body.rotation(), expected.rotation);
      assertVectorNear(entry.body.linvel(), [0, 0, 0]);
      assertVectorNear(entry.body.angvel(), [0, 0, 0]);
    }
    assertVectorNear(ball.linvel(), [0, 0, 0]);
    assertVectorNear(ball.angvel(), [0, 0, 0]);

    prepared.rollback();
    assert.deepEqual(structuredClone({
      ball: bodySnapshot(ball),
      blue: bodySnapshot(blueBody),
      orange: bodySnapshot(orangeBody),
      blueState,
      orangeState,
    }), before);

    resetToKickoff(ball, cars, assignments);
    assertVectorNear(ball.translation(), [
      0,
      ballRadius + getConstant('BALL.SPAWN_CLEARANCE'),
      0,
    ]);
    assertVectorNear(blueBody.linvel(), [0, 0, 0]);
    assertVectorNear(orangeBody.angvel(), [0, 0, 0]);
  } finally {
    world.free();
  }
});

// Validates: Requirements 5.6, 5.11

test('incomplete scoring reset rejects before moving the ball or any car', async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -6.5, z: 0 });

  try {
    const ball = createBody(world, [9, 8, 7]);
    const first = createBody(world, [1, 2, 3]);
    const second = createBody(world, [4, 5, 6]);
    const cars = new Map<string, KickoffCarBody>([
      ['first', { body: first, jumpState: createCarPhysicsState() }],
      ['second', { body: second, jumpState: createCarPhysicsState() }],
    ]);
    const incomplete = new Map<string, Readonly<KickoffAssignment>>([
      ['first', assignment('first', 'blue', 0)],
    ]);
    const before = structuredClone({
      ball: bodySnapshot(ball),
      first: bodySnapshot(first),
      second: bodySnapshot(second),
    });

    assert.throws(
      () => resetToKickoff(ball, cars, incomplete),
      /one assignment for every current car/,
    );
    assert.deepEqual(structuredClone({
      ball: bodySnapshot(ball),
      first: bodySnapshot(first),
      second: bodySnapshot(second),
    }), before);
  } finally {
    world.free();
  }
});
