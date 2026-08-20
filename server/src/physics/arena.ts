import RAPIER from '@dimforge/rapier3d-compat';
import {
  validateResolvedArenaGeometry,
  type ResolvedArenaBoundaryPrimitive,
  type ResolvedArenaCollisionDescriptor,
  type ResolvedArenaGeometry,
  type ResolvedArenaSurface,
} from '@rocket-arena/shared';
import { getConstant } from '../../../shared/src/constants/index.js';
import { ArenaSurfaceRegistry } from './grounding.js';

export type ArenaConstructionStage =
  | 'descriptor'
  | 'create'
  | 'register'
  | 'scene-query';

export interface ArenaConstructionStageContext {
  readonly stage: ArenaConstructionStage;
  readonly primitiveIndex: number | null;
  readonly primitiveId: string | null;
  readonly colliderHandle: number | null;
}

/** Deterministic failure injection used only by finite construction tests. */
export interface ArenaConstructionTestHooks {
  readonly afterStage?: (context: Readonly<ArenaConstructionStageContext>) => void;
}

export interface ArenaColliderOwnership {
  readonly geometry: ResolvedArenaGeometry;
  readonly registry: ArenaSurfaceRegistry;
  readonly colliders: readonly RAPIER.Collider[];
  readonly isDisposed: boolean;
  /** Idempotently unregister and remove all owned colliders in reverse order. */
  dispose(): void;
}

function applySurfaceMaterial(desc: RAPIER.ColliderDesc): RAPIER.ColliderDesc {
  return desc
    .setFriction(getConstant('ARENA.SURFACE.FRICTION'))
    .setRestitution(getConstant('ARENA.SURFACE.RESTITUTION'))
    .setContactSkin(getConstant('ARENA.SURFACE.CONTACT_SKIN'))
    .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max);
}

function colliderDescriptor(
  collision: ResolvedArenaCollisionDescriptor,
  primitiveId: string,
): RAPIER.ColliderDesc {
  if (collision.shape === 'cuboid') {
    const [halfWidth, halfHeight, halfDepth] = collision.halfExtents;
    const [x, y, z] = collision.transform.translation;
    const [qx, qy, qz, qw] = collision.transform.rotation;
    return RAPIER.ColliderDesc.cuboid(halfWidth, halfHeight, halfDepth)
      .setTranslation(x, y, z)
      .setRotation({ x: qx, y: qy, z: qz, w: qw });
  }

  const descriptor = RAPIER.ColliderDesc.convexHull(
    new Float32Array(collision.vertices.flatMap((vertex) => vertex)),
  );
  if (descriptor === null) {
    throw new TypeError(`Rapier rejected arena convex hull ${primitiveId}.`);
  }
  return descriptor;
}

function stage(
  hooks: Readonly<ArenaConstructionTestHooks> | undefined,
  value: ArenaConstructionStageContext,
): void {
  hooks?.afterStage?.(Object.freeze(value));
}

function cleanupArenaConstruction(
  world: RAPIER.World,
  registry: ArenaSurfaceRegistry,
  registeredHandles: readonly number[],
  created: readonly RAPIER.Collider[],
): readonly unknown[] {
  const cleanupErrors: unknown[] = [];
  for (let index = registeredHandles.length - 1; index >= 0; index -= 1) {
    try {
      registry.unregister(registeredHandles[index]!);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (let index = created.length - 1; index >= 0; index -= 1) {
    try {
      const collider = created[index]!;
      if (collider.isValid()) world.removeCollider(collider, false);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    world.updateSceneQueries();
  } catch (error) {
    cleanupErrors.push(error);
  }
  return cleanupErrors;
}

function surfaceById(
  surfaces: ReadonlyMap<string, ResolvedArenaSurface>,
  primitive: ResolvedArenaBoundaryPrimitive,
): ResolvedArenaSurface {
  const surface = surfaces.get(primitive.surfaceId);
  if (surface === undefined) {
    throw new TypeError(`Arena primitive ${primitive.id} references unknown surface ${primitive.surfaceId}.`);
  }
  return surface;
}

/**
 * Strictly project one room-pinned resolved primitive contract into Rapier.
 * No dimensions, fallback walls, transition samples, or semantic metadata are
 * reconstructed here. Construction and successful ownership are transactional.
 */
export function createArenaColliders(
  world: RAPIER.World,
  resolvedGeometry: ResolvedArenaGeometry,
  hooks?: Readonly<ArenaConstructionTestHooks>,
): ArenaColliderOwnership {
  validateResolvedArenaGeometry(resolvedGeometry);
  const registry = new ArenaSurfaceRegistry(world);
  const surfaces = new Map(resolvedGeometry.surfaces.map((surface) => [surface.id, surface]));
  const created: RAPIER.Collider[] = [];
  const registeredHandles: number[] = [];

  try {
    for (let primitiveIndex = 0; primitiveIndex < resolvedGeometry.primitives.length; primitiveIndex += 1) {
      const primitive = resolvedGeometry.primitives[primitiveIndex]!;
      const descriptor = applySurfaceMaterial(colliderDescriptor(primitive.collision, primitive.id));
      stage(hooks, {
        stage: 'descriptor',
        primitiveIndex,
        primitiveId: primitive.id,
        colliderHandle: null,
      });

      const collider = world.createCollider(descriptor);
      created.push(collider);
      stage(hooks, {
        stage: 'create',
        primitiveIndex,
        primitiveId: primitive.id,
        colliderHandle: collider.handle,
      });

      registry.register(collider, surfaceById(surfaces, primitive));
      registeredHandles.push(collider.handle);
      stage(hooks, {
        stage: 'register',
        primitiveIndex,
        primitiveId: primitive.id,
        colliderHandle: collider.handle,
      });
    }

    world.updateSceneQueries();
    stage(hooks, {
      stage: 'scene-query',
      primitiveIndex: null,
      primitiveId: null,
      colliderHandle: null,
    });
  } catch (cause) {
    const cleanupErrors = cleanupArenaConstruction(
      world,
      registry,
      registeredHandles,
      created,
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [cause, ...cleanupErrors],
        'Arena construction failed and rollback encountered cleanup errors.',
      );
    }
    throw cause;
  }

  const ownedColliders = Object.freeze([...created]);
  let disposed = false;
  const ownership: ArenaColliderOwnership = {
    geometry: resolvedGeometry,
    registry,
    colliders: ownedColliders,
    get isDisposed(): boolean {
      return disposed;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const cleanupErrors = cleanupArenaConstruction(
        world,
        registry,
        registeredHandles,
        ownedColliders,
      );
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Arena collider disposal encountered cleanup errors.');
      }
    },
  };
  return Object.freeze(ownership);
}
