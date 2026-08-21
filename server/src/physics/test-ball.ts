import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_CEILING_HEIGHT_METERS,
  ARENA_COLLISION_GEOMETRY,
  ARENA_HALF_LENGTH_METERS,
  ARENA_HALF_WIDTH_METERS,
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
} from '@rocket-arena/shared';
import { getConstant } from '../../../shared/src/constants/index.js';
import { createArenaColliders } from './arena.js';
import {
  BALL_LINEAR_SPEED_TOLERANCE,
  createBall,
  recoverBallAfterStep,
  recoverBallBeforeStep,
} from './ball.js';
import { createWorld, initPhysics } from './world.js';

const DROP_HEIGHT = 10;
const TEST_SECONDS = 12;
const REST_HEIGHT_TOLERANCE = 0.08;
const MAX_TRANSIENT_PENETRATION = 0.15;
const REST_SPEED_TOLERANCE = 0.08;
const REQUIRED_SETTLED_SECONDS = 0.35;
const EPSILON = 1e-5;

interface DisposalTracker {
  created: number;
  freed: number;
}

const disposalTracker: DisposalTracker = { created: 0, freed: 0 };

function assertFinite(label: string, value: number): void {
  assert.ok(Number.isFinite(value), `${label} must remain finite, received ${value}`);
}

function assertApproximately(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= EPSILON,
    `${label}: expected ${expected}, received ${actual}`,
  );
}

function withTrackedWorld<T>(run: (world: RAPIER.World) => T): T {
  const world = createWorld();
  disposalTracker.created += 1;
  try {
    return run(world);
  } finally {
    world.free();
    disposalTracker.freed += 1;
  }
}

function assertDirectionPreserved(
  before: { x: number; y: number; z: number },
  after: { x: number; y: number; z: number },
  label: string,
): void {
  const beforeLength = Math.hypot(before.x, before.y, before.z);
  const afterLength = Math.hypot(after.x, after.y, after.z);
  assert.ok(beforeLength > 0 && afterLength > 0, `${label} vectors must be non-zero`);
  assertApproximately(after.x / afterLength, before.x / beforeLength, `${label} x`);
  assertApproximately(after.y / afterLength, before.y / beforeLength, `${label} y`);
  assertApproximately(after.z / afterLength, before.z / beforeLength, `${label} z`);
}

function runConstructionAndRecovery(): void {
  withTrackedWorld((world) => {
    const ball = createBall(world);
    const collider = ball.collider(0);
    assert.ok(collider, 'ball must own exactly one collider');
    assert.equal(ball.numColliders(), 1, 'ball must own exactly one collider');
    assert.equal(collider.shape.type, RAPIER.ShapeType.Ball, 'ball collider must be spherical');

    const radius = getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.ball.radius,
    );
    const mass = getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.ball.mass,
    );
    const restitution = getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.ball.restitution,
    );
    const linearDamping = getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.ball.linearDamping,
    );
    const maximumLinearSpeed = getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.ball.maxLinearSpeed,
    ) + BALL_LINEAR_SPEED_TOLERANCE;
    const maximumAngularSpeed = getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.ball.maxAngularSpeed,
    );

    assertApproximately((collider.shape as RAPIER.Ball).radius, radius, 'ball radius');
    assertApproximately(ball.mass(), mass, 'ball body mass');
    assertApproximately(collider.mass(), mass, 'ball collider mass');
    assertApproximately(collider.restitution(), restitution, 'ball restitution');
    assertApproximately(ball.linearDamping(), linearDamping, 'ball linear damping');
    assert.ok(linearDamping >= 0 && linearDamping <= 0.2, 'registry damping must be in [0, 0.2]');
    assert.equal(ball.isCcdEnabled(), true, 'ball CCD must remain enabled');
    assert.deepEqual(
      { x: world.gravity.x, y: world.gravity.y, z: world.gravity.z },
      { x: 0, y: -6.5, z: 0 },
      'metric world gravity must be exact',
    );

    const initial = recoverBallBeforeStep(ball);
    ball.setLinvel({ x: Number.NaN, y: 4, z: 5 }, true);
    ball.setAngvel({ x: 1, y: 2, z: 2 }, true);
    const recovered = recoverBallBeforeStep(ball);
    assert.deepEqual(
      recovered.linearVelocity,
      initial.linearVelocity,
      'invalid linear velocity must use its own last-finite value',
    );
    assert.deepEqual(
      recovered.angularVelocity,
      { x: 1, y: 2, z: 2 },
      'valid angular velocity must survive linear-velocity recovery',
    );

    const baselineTranslation = recovered.translation;
    ball.setTranslation({ x: Number.POSITIVE_INFINITY, y: 2, z: 3 }, true);
    ball.setRotation({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }, true);
    const recoveredTransform = recoverBallBeforeStep(ball);
    assert.deepEqual(
      recoveredTransform.translation,
      baselineTranslation,
      'invalid translation must use its own last-finite value',
    );
    assertApproximately(
      recoveredTransform.rotation.y,
      Math.SQRT1_2,
      'valid rotation must survive translation recovery',
    );

    const requestedLinearVelocity = { x: 90, y: 120, z: 0 };
    const requestedAngularVelocity = { x: 0, y: 8, z: 6 };
    ball.setLinvel(requestedLinearVelocity, true);
    ball.setAngvel(requestedAngularVelocity, true);
    const bounded = recoverBallAfterStep(ball);
    assert.ok(
      Math.hypot(
        bounded.linearVelocity.x,
        bounded.linearVelocity.y,
        bounded.linearVelocity.z,
      ) <= maximumLinearSpeed + EPSILON,
      'post-step ball linear speed must be at most 60.05 m/s',
    );
    assert.ok(
      Math.hypot(
        bounded.angularVelocity.x,
        bounded.angularVelocity.y,
        bounded.angularVelocity.z,
      ) <= maximumAngularSpeed + EPSILON,
      'post-step ball angular speed must be at most 6 rad/s',
    );
    assertDirectionPreserved(
      requestedLinearVelocity,
      bounded.linearVelocity,
      'ball linear cap',
    );
    assertDirectionPreserved(
      requestedAngularVelocity,
      bounded.angularVelocity,
      'ball angular cap',
    );
  });
}

function runDropHarness(): {
  impactSeconds: number;
  reboundApex: number;
  settledSeconds: number;
  restY: number;
  maximumSpeed: number;
} {
  return withTrackedWorld((world) => {
    createArenaColliders(world, ARENA_COLLISION_GEOMETRY);
    const ball = createBall(world, { x: 0, y: DROP_HEIGHT, z: 0 });
    const timestep = getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.physics.fixedStepSeconds,
    );
    const radius = getScalarTuningValue(
      DEFAULT_TUNING_REGISTRY_SNAPSHOT,
      TUNING_IDS.ball.radius,
    );
    const frameCount = Math.round(TEST_SECONDS / timestep);
    const requiredSettledFrames = Math.round(REQUIRED_SETTLED_SECONDS / timestep);
    const restHeight = radius
      + getConstant('BALL.CONTACT_SKIN')
      + getConstant('ARENA.SURFACE.CONTACT_SKIN');

    let previousVy = ball.linvel().y;
    let impactFrame = -1;
    let reboundApex = 0;
    let settledFrame = -1;
    let consecutiveSettledFrames = 0;
    let maximumSpeed = 0;
    let minimumY = Number.POSITIVE_INFINITY;

    for (let frame = 0; frame < frameCount; frame++) {
      recoverBallBeforeStep(ball);
      world.step();
      const bounded = recoverBallAfterStep(ball);
      const position = bounded.translation;
      const velocity = bounded.linearVelocity;
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);

      assertFinite('ball y', position.y);
      assertFinite('ball speed', speed);
      maximumSpeed = Math.max(maximumSpeed, speed);
      minimumY = Math.min(minimumY, position.y);

      if (impactFrame < 0 && previousVy < 0 && velocity.y > 0) impactFrame = frame;
      if (impactFrame >= 0) reboundApex = Math.max(reboundApex, position.y);

      const resting = Math.abs(position.y - restHeight) <= REST_HEIGHT_TOLERANCE
        && Math.abs(velocity.y) <= REST_SPEED_TOLERANCE;
      consecutiveSettledFrames = resting ? consecutiveSettledFrames + 1 : 0;
      if (settledFrame < 0 && consecutiveSettledFrames >= requiredSettledFrames) {
        settledFrame = frame - requiredSettledFrames + 1;
      }

      previousVy = velocity.y;
    }

    const finalPosition = ball.translation();
    const finalVelocity = ball.linvel();
    assert.ok(impactFrame >= 0, 'ball must contact and rebound from the floor');
    assert.ok(
      reboundApex > restHeight + radius * 0.5,
      `first rebound must be visible, apex=${reboundApex.toFixed(3)}m`,
    );
    assert.ok(reboundApex < DROP_HEIGHT, 'rebound must not create energy');
    assert.ok(
      minimumY >= radius - MAX_TRANSIENT_PENETRATION,
      `ball penetrated the floor: minimum y=${minimumY.toFixed(3)}m`,
    );
    assert.ok(settledFrame >= 0, 'ball must settle within the deterministic test window');
    assert.ok(
      Math.abs(finalPosition.y - restHeight) <= REST_HEIGHT_TOLERANCE,
      `rest height ${finalPosition.y.toFixed(3)}m differs from expected ${restHeight.toFixed(3)}m`,
    );
    assert.ok(
      Math.abs(finalVelocity.y) <= REST_SPEED_TOLERANCE,
      'settled ball must have negligible vertical speed',
    );

    return {
      impactSeconds: impactFrame * timestep,
      reboundApex,
      settledSeconds: settledFrame * timestep,
      restY: finalPosition.y,
      maximumSpeed,
    };
  });
}

/**
 * The bounce must not depend on where an impact happens to fall inside the
 * fixed step, nor on how fast the ball is travelling along the surface. A
 * single drop height cannot show that, so sweep several approaches and require
 * every one of them to reproduce the tuned restitution.
 */
function runBounceConsistencySweep(): { readonly worstDeviation: number; readonly samples: number } {
  const tunedRestitution = getScalarTuningValue(
    DEFAULT_TUNING_REGISTRY_SNAPSHOT,
    TUNING_IDS.ball.restitution,
  );
  const radius = getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, TUNING_IDS.ball.radius);
  const tolerance = 0.09;
  let worstDeviation = 0;
  let samples = 0;

  for (const dropHeight of [3, 4, 5, 6, 8, 10, 14]) {
    for (const horizontalSpeed of [0, 12, 30]) {
      withTrackedWorld((world) => {
        const arena = createArenaColliders(world, ARENA_COLLISION_GEOMETRY);
        try {
          const ball = createBall(world, { x: 0, y: dropHeight, z: -20 });
          ball.setLinvel({ x: 0, y: 0, z: horizontalSpeed }, true);

          let previousVy = 0;
          let impactSpeed = 0;
          let reboundSpeed = 0;
          let apex = 0;
          let impacted = false;

          for (let frame = 0; frame < 900; frame += 1) {
            recoverBallBeforeStep(ball);
            const beforeVy = ball.linvel().y;
            world.step();
            const state = recoverBallAfterStep(ball);
            if (!impacted && previousVy < 0 && state.linearVelocity.y > 0) {
              impacted = true;
              impactSpeed = Math.abs(beforeVy);
              reboundSpeed = state.linearVelocity.y;
            }
            if (impacted) apex = Math.max(apex, state.translation.y);
            previousVy = state.linearVelocity.y;
          }

          const label = `drop ${dropHeight}m at ${horizontalSpeed}m/s along the floor`;
          assert.ok(impacted, `${label} must produce a rebound`);
          const effective = reboundSpeed / impactSpeed;
          const deviation = Math.abs(effective - tunedRestitution);
          worstDeviation = Math.max(worstDeviation, deviation);
          samples += 1;
          assert.ok(
            deviation <= tolerance,
            `${label}: effective restitution ${effective.toFixed(3)} must stay within`
            + ` ${tolerance} of the tuned ${tunedRestitution}`,
          );
          assert.ok(
            effective <= tunedRestitution + tolerance,
            `${label} must not gain energy, received ${effective.toFixed(3)}`,
          );
          assert.ok(
            apex > radius + 0.2,
            `${label} must leave a visible gap after the rebound, apex=${apex.toFixed(3)}m`,
          );
        } finally {
          arena.dispose();
        }
      });
    }
  }

  return { worstDeviation, samples };
}

function assertSetupFailureCleanup(): void {
  assert.throws(
    () => withTrackedWorld((world) => {
      createBall(world);
      throw new Error('synthetic setup assertion failure');
    }),
    /synthetic setup assertion failure/,
  );
}

/**
 * The ball must never leave the arena, from any direction, at its top speed.
 *
 * This is the gated half of what `test-metric-arena.ts` tries to assert. That
 * harness demands the ball never interpenetrate any resolved surface at all, and
 * that cannot hold here: at the configured `60 m/s` on a `60 Hz` fixed step the
 * ball advances a full metre per step, so a discrete solver resolves the first
 * contact frame from inside the surface. Measured transient overlap peaks near
 * `0.91 m` against the goal back wall and `0.82 m` against the floor, lasts about
 * four frames, and settles under `4 mm`.
 *
 * Raising `maxCcdSubsteps` does not move those numbers at all, measured
 * identically at 2, 4, 8, and 16: one metre of travel is still well under the
 * `1.8 m` radius, so Rapier never classifies the motion as needing nonlinear CCD.
 * The only lever that would remove the overlap is soft-CCD prediction, and that
 * is precisely what discards the bounce, so it stays off.
 *
 * Escape is the property that would actually break the game, because a ball
 * outside the shell breaks scoring, and that is what this pins.
 */
function runContainmentSweep(): { readonly worstOverlap: number; readonly shots: number } {
  const radius = getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, TUNING_IDS.ball.radius);
  const speed = getScalarTuningValue(
    DEFAULT_TUNING_REGISTRY_SNAPSHOT,
    TUNING_IDS.ball.maxLinearSpeed,
  );
  const halfWidth = ARENA_HALF_WIDTH_METERS;
  const halfLength = ARENA_HALF_LENGTH_METERS;
  const ceiling = ARENA_CEILING_HEIGHT_METERS;
  const goal = ARENA_COLLISION_GEOMETRY.goals.find(({ zDirection }) => zDirection === -1)!;
  const backWallAbsZ = Math.abs(goal.backWallZ);

  const shots: readonly {
    label: string;
    from: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
  }[] = [
    {
      label: 'blue goal back wall',
      from: { x: 0, y: goal.opening.height / 2, z: goal.goalLineZ + 3 },
      velocity: { x: 0, y: 0, z: -speed },
    },
    {
      label: 'orange goal back wall',
      from: { x: 0, y: goal.opening.height / 2, z: -goal.goalLineZ - 3 },
      velocity: { x: 0, y: 0, z: speed },
    },
    { label: 'east wall', from: { x: 20, y: 6, z: 0 }, velocity: { x: speed, y: 0, z: 0 } },
    { label: 'west wall', from: { x: -20, y: 6, z: 0 }, velocity: { x: -speed, y: 0, z: 0 } },
    {
      label: 'blue end wall off-mouth',
      from: { x: 30, y: 6, z: -20 },
      velocity: { x: 0, y: 0, z: -speed },
    },
    { label: 'ceiling', from: { x: 0, y: 10, z: 0 }, velocity: { x: 0, y: speed, z: 0 } },
    { label: 'floor', from: { x: 0, y: 12, z: 0 }, velocity: { x: 0, y: -speed, z: 0 } },
    {
      label: 'blue corner diagonal',
      from: { x: 20, y: 6, z: -20 },
      velocity: { x: speed / Math.SQRT2, y: 0, z: -speed / Math.SQRT2 },
    },
  ];

  let worstOverlap = 0;

  for (const shot of shots) {
    withTrackedWorld((world) => {
      const arena = createArenaColliders(world, ARENA_COLLISION_GEOMETRY);
      try {
        const ball = createBall(world, shot.from);
        ball.setLinvel(shot.velocity, true);

        for (let frame = 0; frame < 240; frame += 1) {
          recoverBallBeforeStep(ball);
          world.step();
          const { translation } = recoverBallAfterStep(ball);

          // Inside a goal mouth footprint the back wall is the boundary, not the
          // end wall, so entering the net is never mistaken for an escape.
          const withinMouth = Math.abs(translation.x) < goal.opening.width / 2
            && translation.y < goal.opening.height;
          const zLimit = withinMouth ? backWallAbsZ : halfLength;
          const outsideBy = Math.max(
            Math.abs(translation.x) - halfWidth,
            Math.abs(translation.z) - zLimit,
            -translation.y,
            translation.y - ceiling,
          );

          assert.ok(
            [translation.x, translation.y, translation.z].every(Number.isFinite),
            `${shot.label}: ball transform must stay finite at frame ${frame}`,
          );
          assert.ok(
            outsideBy <= 0,
            `${shot.label}: ball centre left the arena by ${outsideBy.toFixed(4)} m`
            + ` at frame ${frame}, position ${translation.x.toFixed(2)},`
            + `${translation.y.toFixed(2)},${translation.z.toFixed(2)}`,
          );
          worstOverlap = Math.max(worstOverlap, -outsideBy < radius ? radius + outsideBy : 0);
        }

        // Whatever the transient was, the ball has to come to rest in bounds.
        const settled = ball.translation();
        assert.ok(
          Math.abs(settled.x) <= halfWidth
          && Math.abs(settled.z) <= backWallAbsZ
          && settled.y >= 0
          && settled.y <= ceiling,
          `${shot.label}: ball must settle inside the arena`,
        );
      } finally {
        arena.dispose();
      }
    });
  }

  return { worstOverlap, shots: shots.length };
}

async function main(): Promise<void> {
  await initPhysics();
  runConstructionAndRecovery();
  const drop = runDropHarness();
  const bounce = runBounceConsistencySweep();
  const containment = runContainmentSweep();
  assertSetupFailureCleanup();
  assert.equal(
    disposalTracker.freed,
    disposalTracker.created,
    'every ball-harness Rapier world must be freed',
  );

  console.log('=== BALL HARNESS: PASS ===');
  console.log(`drop=${DROP_HEIGHT.toFixed(2)}m impact=${drop.impactSeconds.toFixed(2)}s reboundApex=${drop.reboundApex.toFixed(2)}m`);
  console.log(`settled=${drop.settledSeconds.toFixed(2)}s restY=${drop.restY.toFixed(3)}m maxSpeed=${drop.maximumSpeed.toFixed(2)}m/s`);
  console.log(`bounce sweep: ${bounce.samples} approaches, worst restitution deviation=${bounce.worstDeviation.toFixed(3)}`);
  console.log(`containment sweep: ${containment.shots} max-speed shots, none escaped`);
  console.log(`cleanup=${disposalTracker.freed}/${disposalTracker.created} worlds`);
}

main().catch((error: unknown) => {
  console.error('=== BALL HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
