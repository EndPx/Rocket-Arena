import RAPIER from '@dimforge/rapier3d-compat';
import { getConstant } from '../../../shared/src/constants/index.js';

let rapier: typeof RAPIER;

export async function initPhysics(): Promise<typeof RAPIER> {
  await RAPIER.init();
  rapier = RAPIER;
  return rapier;
}

export function createWorld(): RAPIER.World {
  const gravity = new rapier.Vector3(0, getConstant('PHYSICS.GRAVITY'), 0);
  const world = new rapier.World(gravity);
  return world;
}

export function getRapier(): typeof RAPIER {
  return rapier;
}
