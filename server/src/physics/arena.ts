import RAPIER from '@dimforge/rapier3d-compat';
import { getConstant } from '../../../shared/src/constants/index.js';

function applySurfaceMaterial(desc: RAPIER.ColliderDesc): RAPIER.ColliderDesc {
  return desc
    .setFriction(getConstant('ARENA.SURFACE.FRICTION'))
    .setRestitution(getConstant('ARENA.SURFACE.RESTITUTION'))
    .setContactSkin(getConstant('ARENA.SURFACE.CONTACT_SKIN'))
    .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max);
}

/**
 * Create static colliders for the arena: floor, walls, ceiling, and goal backs.
 * Goal openings remain as gaps in the short walls along the Z axis.
 */
export function createArenaColliders(world: RAPIER.World): void {
  const width = getConstant('ARENA.WIDTH');
  const length = getConstant('ARENA.LENGTH');
  const height = getConstant('ARENA.HEIGHT');
  const thickness = getConstant('ARENA.WALL_THICKNESS');
  const goalWidth = getConstant('ARENA.GOAL.WIDTH');
  const goalHeight = getConstant('ARENA.GOAL.HEIGHT');
  const goalDepth = getConstant('ARENA.GOAL.DEPTH');

  world.createCollider(applySurfaceMaterial(
    RAPIER.ColliderDesc.cuboid(width / 2, thickness / 2, length / 2)
      .setTranslation(0, -thickness / 2, 0),
  ));

  world.createCollider(applySurfaceMaterial(
    RAPIER.ColliderDesc.cuboid(width / 2, thickness / 2, length / 2)
      .setTranslation(0, height + thickness / 2, 0),
  ));

  world.createCollider(applySurfaceMaterial(
    RAPIER.ColliderDesc.cuboid(thickness / 2, height / 2, length / 2)
      .setTranslation(-width / 2 - thickness / 2, height / 2, 0),
  ));
  world.createCollider(applySurfaceMaterial(
    RAPIER.ColliderDesc.cuboid(thickness / 2, height / 2, length / 2)
      .setTranslation(width / 2 + thickness / 2, height / 2, 0),
  ));

  const sideSegmentWidth = (width - goalWidth) / 2;
  const sideSegmentX = width / 2 - sideSegmentWidth / 2;
  const topSegmentHeight = height - goalHeight;
  const endWallZ = length / 2 + thickness / 2;

  for (const zSign of [-1, 1]) {
    if (sideSegmentWidth > 0) {
      for (const xSign of [-1, 1]) {
        world.createCollider(applySurfaceMaterial(
          RAPIER.ColliderDesc.cuboid(sideSegmentWidth / 2, height / 2, thickness / 2)
            .setTranslation(xSign * sideSegmentX, height / 2, zSign * endWallZ),
        ));
      }
    }

    if (topSegmentHeight > 0) {
      world.createCollider(applySurfaceMaterial(
        RAPIER.ColliderDesc.cuboid(goalWidth / 2, topSegmentHeight / 2, thickness / 2)
          .setTranslation(0, goalHeight + topSegmentHeight / 2, zSign * endWallZ),
      ));
    }

    world.createCollider(applySurfaceMaterial(
      RAPIER.ColliderDesc.cuboid(goalWidth / 2, goalHeight / 2, thickness / 2)
        .setTranslation(0, goalHeight / 2, zSign * (length / 2 + goalDepth)),
    ));
  }
}
