/**
 * Measure how far the ball sinks into arena surfaces at the configured maximum
 * speed, and whether it ever escapes.
 *
 * `test-metric-arena.ts` asserts the ball never interpenetrates any resolved
 * surface. At 60 m/s on a 60 Hz fixed step the ball advances a full metre per
 * step, so a discrete solver cannot honour that without soft-CCD prediction, and
 * that prediction is exactly what discards the bounce. This separates the two
 * questions the assertion conflates: transient interpenetration, which lasts a
 * frame or two and is cosmetically invisible, and escape, which would break
 * scoring.
 *
 * Penetration is read from Rapier's own contact manifolds rather than from a
 * hand-rolled box, so it is measured against the real resolved geometry.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_COLLISION_GEOMETRY,
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
} from '@rocket-arena/shared';
import { createArenaColliders } from '../server/src/physics/arena.js';
import {
  createBall,
  recoverBallAfterStep,
  recoverBallBeforeStep,
} from '../server/src/physics/ball.js';
import { createWorld, initPhysics } from '../server/src/physics/world.js';

const RADIUS = getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, TUNING_IDS.ball.radius);
const SPEED = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.ball.maxLinearSpeed,
);
const STEP = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.physics.fixedStepSeconds,
);

const HALF_WIDTH = 40.96;
const HALF_LENGTH = 51.2;
const CEILING = 20.44;
const blueGoal = ARENA_COLLISION_GEOMETRY.goals.find(({ zDirection }) => zDirection === -1)!;
const BACK_WALL_ABS_Z = Math.abs(blueGoal.backWallZ);

interface Shot {
  readonly label: string;
  readonly from: { x: number; y: number; z: number };
  readonly velocity: { x: number; y: number; z: number };
}

/**
 * How far the ball centre sits beyond the outermost shell plane it could pass.
 * Positive means the centre left the arena. Inside a goal mouth footprint the
 * relevant plane is the back wall, not the end wall, so the widest of the two is
 * used and the mouth crossing cannot be mistaken for an escape.
 */
function escapeDepth(p: { x: number; y: number; z: number }): number {
  const withinMouthFootprint = Math.abs(p.x) < blueGoal.opening.width / 2
    && p.y < blueGoal.opening.height;
  const zLimit = withinMouthFootprint ? BACK_WALL_ABS_Z : HALF_LENGTH;
  return Math.max(
    Math.abs(p.x) - HALF_WIDTH,
    Math.abs(p.z) - zLimit,
    -p.y,
    p.y - CEILING,
  );
}

/** Deepest overlap Rapier itself reports for the ball this step, in metres. */
function deepestPenetration(world: RAPIER.World, ball: RAPIER.RigidBody): {
  depth: number;
  surface: string;
} {
  let depth = 0;
  let surface = 'none';
  const collider = ball.collider(0);
  world.contactPairsWith(collider, (other) => {
    world.contactPair(collider, other, (manifold) => {
      for (let index = 0; index < manifold.numContacts(); index += 1) {
        // Rapier reports a negative distance for overlapping contacts.
        const overlap = -manifold.contactDist(index);
        if (overlap > depth) {
          depth = overlap;
          surface = String(other.handle);
        }
      }
    });
  });
  return { depth, surface };
}

function run(shot: Shot, ccdSubsteps: number | null = null): void {
  const world = createWorld();
  try {
    if (ccdSubsteps !== null) world.integrationParameters.maxCcdSubsteps = ccdSubsteps;
    createArenaColliders(world, ARENA_COLLISION_GEOMETRY);
    const ball = createBall(world, shot.from);
    ball.setLinvel(shot.velocity, true);

    let worstEscape = Number.NEGATIVE_INFINITY;
    let framesEscaped = 0;
    let worstPenetration = 0;
    let worstPenetrationFrame = -1;
    let framesPenetratedPastSkin = 0;
    let settledPenetration = 0;

    for (let frame = 0; frame < 240; frame += 1) {
      recoverBallBeforeStep(ball);
      world.step();
      const { translation } = recoverBallAfterStep(ball);

      const escaped = escapeDepth(translation);
      if (escaped > 0) framesEscaped += 1;
      worstEscape = Math.max(worstEscape, escaped);

      const { depth } = deepestPenetration(world, ball);
      settledPenetration = depth;
      if (depth > 0.02) framesPenetratedPastSkin += 1;
      if (depth > worstPenetration) {
        worstPenetration = depth;
        worstPenetrationFrame = frame;
      }
    }

    console.log(
      `${shot.label.padEnd(26)} ${(framesEscaped > 0 ? 'ESCAPED' : 'contained').padEnd(10)}`
      + ` centreOutsideBy=${worstEscape.toFixed(4)}m`
      + ` worstOverlap=${worstPenetration.toFixed(4)}m@f${worstPenetrationFrame}`
      + ` framesOverlapping=${framesPenetratedPastSkin}`
      + ` settledOverlap=${settledPenetration.toFixed(4)}m`,
    );
  } finally {
    world.free();
  }
}

async function main(): Promise<void> {
  await initPhysics();
  console.log(
    `radius=${RADIUS}m speed=${SPEED}m/s step=${STEP.toFixed(5)}s`
    + ` travelPerStep=${(SPEED * STEP).toFixed(4)}m backWallZ=${blueGoal.backWallZ}`,
  );
  console.log('--- straight into surfaces at the configured maximum speed ---');

  const shots: readonly Shot[] = [
    {
      label: 'blue goal back wall',
      from: { x: 0, y: blueGoal.opening.height / 2, z: blueGoal.goalLineZ + 3 },
      velocity: { x: 0, y: 0, z: -SPEED },
    },
    {
      label: 'orange goal back wall',
      from: { x: 0, y: blueGoal.opening.height / 2, z: -blueGoal.goalLineZ - 3 },
      velocity: { x: 0, y: 0, z: SPEED },
    },
    {
      label: 'east side wall',
      from: { x: 20, y: 6, z: 0 },
      velocity: { x: SPEED, y: 0, z: 0 },
    },
    {
      label: 'blue end wall off-mouth',
      from: { x: 30, y: 6, z: -20 },
      velocity: { x: 0, y: 0, z: -SPEED },
    },
    {
      label: 'ceiling',
      from: { x: 0, y: 10, z: 0 },
      velocity: { x: 0, y: SPEED, z: 0 },
    },
    {
      label: 'floor',
      from: { x: 0, y: 12, z: 0 },
      velocity: { x: 0, y: -SPEED, z: 0 },
    },
    {
      label: 'blue corner diagonal',
      from: { x: 20, y: 6, z: -20 },
      velocity: { x: SPEED / Math.SQRT2, y: 0, z: -SPEED / Math.SQRT2 },
    },
  ];

  for (const shot of shots) run(shot);

  // Does raising hard-CCD substeps reduce the transient overlap, or is CCD simply
  // not triggering because one metre of travel is still under the 1.8 m radius?
  console.log('--- maxCcdSubsteps sweep on the worst two shots ---');
  for (const substeps of [2, 4, 8, 16]) {
    console.log(`substeps=${substeps}`);
    for (const shot of [shots[0]!, shots[5]!]) run(shot, substeps);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
