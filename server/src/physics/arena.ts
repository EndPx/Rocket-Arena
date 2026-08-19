import RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_GEOMETRY_SPEC,
  type ArenaSurfaceDescriptor,
} from '@rocket-arena/shared';
import { getConstant } from '../../../shared/src/constants/index.js';
import { ArenaSurfaceRegistry } from './grounding.js';

function applySurfaceMaterial(desc: RAPIER.ColliderDesc): RAPIER.ColliderDesc {
  return desc
    .setFriction(getConstant('ARENA.SURFACE.FRICTION'))
    .setRestitution(getConstant('ARENA.SURFACE.RESTITUTION'))
    .setContactSkin(getConstant('ARENA.SURFACE.CONTACT_SKIN'))
    .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max);
}

const SURFACES_BY_ID = new Map<string, ArenaSurfaceDescriptor>(
  ARENA_GEOMETRY_SPEC.surfaces.map((surface) => [surface.id, surface]),
);

function surfaceDescriptor(id: string): ArenaSurfaceDescriptor {
  const descriptor = SURFACES_BY_ID.get(id);
  if (descriptor === undefined) throw new TypeError(`Unknown arena surface descriptor: ${id}`);
  return descriptor;
}

function rotationAroundX(radians: number): RAPIER.Rotation {
  return { x: Math.sin(radians / 2), y: 0, z: 0, w: Math.cos(radians / 2) };
}

function rotationAroundZ(radians: number): RAPIER.Rotation {
  return { x: 0, y: 0, z: Math.sin(radians / 2), w: Math.cos(radians / 2) };
}

/**
 * Create the legacy static shell plus the minimum Core lower ramps required by
 * grounding. Exact closed metric-shell replacement remains task 6.1.
 */
export function createArenaColliders(world: RAPIER.World): ArenaSurfaceRegistry {
  const width = getConstant('ARENA.WIDTH');
  const length = getConstant('ARENA.LENGTH');
  const height = getConstant('ARENA.HEIGHT');
  const thickness = getConstant('ARENA.WALL_THICKNESS');
  const goalWidth = getConstant('ARENA.GOAL.WIDTH');
  const goalHeight = getConstant('ARENA.GOAL.HEIGHT');
  const goalDepth = getConstant('ARENA.GOAL.DEPTH');
  const registry = new ArenaSurfaceRegistry(world);

  function createTaggedCollider(desc: RAPIER.ColliderDesc, surfaceId: string): RAPIER.Collider {
    const collider = world.createCollider(applySurfaceMaterial(desc));
    registry.register(collider, surfaceDescriptor(surfaceId));
    return collider;
  }

  createTaggedCollider(
    RAPIER.ColliderDesc.cuboid(width / 2, thickness / 2, length / 2)
      .setTranslation(0, -thickness / 2, 0),
    'field.floor',
  );

  createTaggedCollider(
    RAPIER.ColliderDesc.cuboid(width / 2, thickness / 2, length / 2)
      .setTranslation(0, height + thickness / 2, 0),
    'field.ceiling',
  );

  createTaggedCollider(
    RAPIER.ColliderDesc.cuboid(thickness / 2, height / 2, length / 2)
      .setTranslation(-width / 2 - thickness / 2, height / 2, 0),
    'field.wall.west',
  );
  createTaggedCollider(
    RAPIER.ColliderDesc.cuboid(thickness / 2, height / 2, length / 2)
      .setTranslation(width / 2 + thickness / 2, height / 2, 0),
    'field.wall.east',
  );

  const sideSegmentWidth = (width - goalWidth) / 2;
  const sideSegmentX = width / 2 - sideSegmentWidth / 2;
  const topSegmentHeight = height - goalHeight;
  const endWallZ = length / 2 + thickness / 2;

  for (const zSign of [-1, 1] as const) {
    const endName = zSign < 0 ? 'blue' : 'orange';
    if (sideSegmentWidth > 0) {
      for (const xSign of [-1, 1] as const) {
        createTaggedCollider(
          RAPIER.ColliderDesc.cuboid(sideSegmentWidth / 2, height / 2, thickness / 2)
            .setTranslation(xSign * sideSegmentX, height / 2, zSign * endWallZ),
          `field.wall.${endName}-end`,
        );
      }
    }

    if (topSegmentHeight > 0) {
      createTaggedCollider(
        RAPIER.ColliderDesc.cuboid(goalWidth / 2, topSegmentHeight / 2, thickness / 2)
          .setTranslation(0, goalHeight + topSegmentHeight / 2, zSign * endWallZ),
        `field.wall.${endName}-end`,
      );
    }

    const tunnelCenterZ = zSign * (length / 2 + goalDepth / 2);
    for (const xSign of [-1, 1] as const) {
      const sideName = xSign < 0 ? 'west' : 'east';
      createTaggedCollider(
        RAPIER.ColliderDesc.cuboid(thickness / 2, goalHeight / 2, goalDepth / 2)
          .setTranslation(xSign * (goalWidth / 2 + thickness / 2), goalHeight / 2, tunnelCenterZ),
        `goal.${endName}.side-${sideName}`,
      );
    }

    createTaggedCollider(
      RAPIER.ColliderDesc.cuboid(goalWidth / 2, thickness / 2, goalDepth / 2)
        .setTranslation(0, -thickness / 2, tunnelCenterZ),
      `goal.${endName}.floor`,
    );
    createTaggedCollider(
      RAPIER.ColliderDesc.cuboid(goalWidth / 2, thickness / 2, goalDepth / 2)
        .setTranslation(0, goalHeight + thickness / 2, tunnelCenterZ),
      `goal.${endName}.roof`,
    );
    createTaggedCollider(
      RAPIER.ColliderDesc.cuboid(goalWidth / 2, goalHeight / 2, thickness / 2)
        .setTranslation(0, goalHeight / 2, zSign * (length / 2 + goalDepth)),
      `goal.${endName}.back`,
    );
  }

  const rampHeight = ARENA_GEOMETRY_SPEC.floorWallRamp.height;
  const rampSlopeLength = Math.SQRT2 * rampHeight;
  const rampNormalOffset = thickness / (2 * Math.SQRT2);

  for (const xSign of [-1, 1] as const) {
    const sideName = xSign < 0 ? 'west' : 'east';
    createTaggedCollider(
      RAPIER.ColliderDesc.cuboid(rampSlopeLength / 2, thickness / 2, length / 2)
        .setTranslation(
          xSign * (width / 2 - rampHeight / 2 + rampNormalOffset),
          rampHeight / 2 - rampNormalOffset,
          0,
        )
        .setRotation(rotationAroundZ(xSign * Math.PI / 4)),
      `field.ramp.${sideName}`,
    );
  }

  if (sideSegmentWidth > 0) {
    for (const zSign of [-1, 1] as const) {
      const endName = zSign < 0 ? 'blue' : 'orange';
      for (const xSign of [-1, 1] as const) {
        createTaggedCollider(
          RAPIER.ColliderDesc.cuboid(sideSegmentWidth / 2, thickness / 2, rampSlopeLength / 2)
            .setTranslation(
              xSign * sideSegmentX,
              rampHeight / 2 - rampNormalOffset,
              zSign * (length / 2 - rampHeight / 2 + rampNormalOffset),
            )
            .setRotation(rotationAroundX(-zSign * Math.PI / 4)),
          `field.ramp.${endName}-end`,
        );
      }
    }
  }

  world.updateSceneQueries();
  return registry;
}
