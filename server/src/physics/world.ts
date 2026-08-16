import RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS, getConstant } from '../../../shared/src/constants/index.js';

let rapier: typeof RAPIER;

export async function initPhysics(): Promise<typeof RAPIER> {
  await RAPIER.init();
  rapier = RAPIER;
  return rapier;
}

/** Create a deterministically configured fixed-step Rapier world. */
export function createWorld(): RAPIER.World {
  const gravity = new rapier.Vector3(0, getConstant('PHYSICS.GRAVITY'), 0);
  const world = new rapier.World(gravity);

  world.timestep = PHYSICS.TIMESTEP;
  world.numSolverIterations = Math.round(getConstant('PHYSICS.SOLVER_ITERATIONS'));
  world.numAdditionalFrictionIterations = Math.round(
    getConstant('PHYSICS.ADDITIONAL_FRICTION_ITERATIONS'),
  );
  world.integrationParameters.maxCcdSubsteps = Math.round(
    getConstant('PHYSICS.MAX_CCD_SUBSTEPS'),
  );

  return world;
}

export function getRapier(): typeof RAPIER {
  return rapier;
}
