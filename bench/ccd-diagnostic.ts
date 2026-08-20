import RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_COLLISION_GEOMETRY,
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
} from '@rocket-arena/shared';
import { createArenaColliders } from '../server/src/physics/arena.js';
import { createBall, recoverBallAfterStep, recoverBallBeforeStep } from '../server/src/physics/ball.js';
import { createWorld, initPhysics } from '../server/src/physics/world.js';

async function main(): Promise<void> {
await initPhysics();
const radius = getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, TUNING_IDS.ball.radius);
const goal = ARENA_COLLISION_GEOMETRY.goals.find(({ id }) => id === 'blue-goal')!;

for (const prediction of [0, 0.1, 0.25, 0.5, 1, 1.5, 2]) {
  const substeps = 2;
  const world = createWorld();
  world.integrationParameters.maxCcdSubsteps = substeps;
  const arena = createArenaColliders(world, ARENA_COLLISION_GEOMETRY);
  if (prediction === 0) {
    const rayHit = world.castRayAndGetNormal(
      new RAPIER.Ray({ x: 0, y: goal.opening.height / 2, z: -55 }, { x: 0, y: 0, z: -1 }),
      10,
      true,
      RAPIER.QueryFilterFlags.ONLY_FIXED,
    );
    console.log(JSON.stringify({
      rayToi: rayHit?.timeOfImpact,
      rayPointZ: rayHit === null || rayHit === undefined ? null : -55 - rayHit.timeOfImpact,
      rayNormal: rayHit?.normal,
      raySurface: rayHit === null || rayHit === undefined
        ? null
        : arena.registry.get(rayHit.collider)?.surfaceId,
    }));
  }
  const ball = createBall(world, { x: 0, y: goal.opening.height / 2, z: 0 });
  ball.setSoftCcdPrediction(prediction);
  if (prediction === 0) console.log(JSON.stringify({ ccdEnabled: ball.isCcdEnabled() }));
  ball.setLinvel({ x: 0, y: 0, z: -60 }, true);
  let minimumClearance = Number.POSITIVE_INFINITY;
  let minimumFrame = -1;
  let minimumVelocity = 0;
  try {
    for (let frame = 0; frame < 130; frame += 1) {
      recoverBallBeforeStep(ball);
      world.step();
      const state = recoverBallAfterStep(ball);
      if (state.translation.z < goal.goalLineZ) {
        const clearance = state.translation.z - goal.backWallZ;
        if (clearance < minimumClearance) {
          minimumClearance = clearance;
          minimumFrame = frame;
          minimumVelocity = state.linearVelocity.z;
        }
      }
    }
    console.log(JSON.stringify({
      substeps,
      prediction,
      radius,
      minimumClearance,
      penetration: radius - minimumClearance,
      minimumFrame,
      minimumVelocity,
    }));
  } finally {
    if (ball.isValid()) world.removeRigidBody(ball);
    arena.dispose();
    world.free();
  }
}

void RAPIER;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
