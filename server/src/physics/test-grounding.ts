import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_COLLISION_GEOMETRY,
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
  type ArenaSurfaceDescriptor,
  type TuningEntry,
  type TuningRegistrySnapshot,
} from '@rocket-arena/shared';
import { createArenaColliders } from './arena.js';
import {
  ADVANCED_SURFACE_GROUNDING_ENABLED,
  ArenaSurfaceRegistry,
  createSurfaceRelativeBasis,
  detectGroundSupport,
  probeRideHeight,
  projectSurfaceCommand,
  type GroundingQuaternion,
  type GroundingTuningSnapshot,
} from './grounding.js';
import { initPhysics } from './world.js';

const EPSILON = 1e-8;

/**
 * Probe geometry is derived from the registry so this harness keeps testing a
 * car that actually rests on the surface when the collider or the support
 * contact points are retuned. A hard-coded half height silently lifts every
 * local-down ray off the thin test plates and turns real assertions into
 * vacuous ones.
 */
const CAR_HALF_HEIGHT = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.collider.height,
) / 2;

const SUPPORT_CONTACT_POINTS: readonly number[] = (() => {
  const entry = DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(TUNING_IDS.support.contactPoints);
  if (entry?.kind !== 'vector') throw new Error('Support contact points must be a vector entry.');
  return entry.value;
})();

function supportFootprintHalfExtent(component: 0 | 2): number {
  let maximum = 0;
  for (let index = component; index < SUPPORT_CONTACT_POINTS.length; index += 3) {
    maximum = Math.max(maximum, Math.abs(SUPPORT_CONTACT_POINTS[index]!));
  }
  return maximum;
}

/** Test plates must cover every support point, otherwise all rays simply miss. */
const SUPPORT_PLATE_HALF_DEPTH = supportFootprintHalfExtent(2) + 0.2;
const SUPPORT_PLATE_HALF_WIDTH = supportFootprintHalfExtent(0) + 0.2;

const disposalTracker = { created: 0, freed: 0 };
const SURFACES = new Map(
  ARENA_COLLISION_GEOMETRY.surfaces.map((surface) => [surface.id, surface]),
);

function descriptor(id: string): ArenaSurfaceDescriptor {
  const value = SURFACES.get(id);
  if (value === undefined) throw new Error(`Missing test surface descriptor ${id}`);
  return value;
}

function createTrackedWorld(): RAPIER.World {
  disposalTracker.created += 1;
  return new RAPIER.World({ x: 0, y: -6.5, z: 0 });
}

function freeTrackedWorld(world: RAPIER.World): void {
  world.free();
  disposalTracker.freed += 1;
}

function rotationAroundX(radians: number): GroundingQuaternion {
  return { x: Math.sin(radians / 2), y: 0, z: 0, w: Math.cos(radians / 2) };
}

function rotationAroundZ(radians: number): GroundingQuaternion {
  return { x: 0, y: 0, z: Math.sin(radians / 2), w: Math.cos(radians / 2) };
}

function createProbe(
  world: RAPIER.World,
  translation: { x: number; y: number; z: number },
  rotation: GroundingQuaternion = { x: 0, y: 0, z: 0, w: 1 },
): RAPIER.RigidBody {
  return world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(translation.x, translation.y, translation.z)
      .setRotation(rotation),
  );
}

function createFloorCollider(
  world: RAPIER.World,
  sensor = false,
): RAPIER.Collider {
  return world.createCollider(
    RAPIER.ColliderDesc.cuboid(2, 0.05, 2)
      .setTranslation(0, -0.05, 0)
      .setSensor(sensor),
  );
}

function tuningWith(
  overrides: ReadonlyMap<string, number | readonly number[]>,
): GroundingTuningSnapshot {
  return {
    get(id: string): TuningEntry | undefined {
      const entry = DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id);
      const replacement = overrides.get(id);
      if (entry === undefined || replacement === undefined) return entry;
      if (entry.kind === 'scalar' && typeof replacement === 'number') {
        return { ...entry, value: replacement };
      }
      if (entry.kind === 'vector' && Array.isArray(replacement)) {
        return { ...entry, value: replacement };
      }
      return entry;
    },
  } satisfies Pick<TuningRegistrySnapshot, 'get'>;
}

function assertApproximately(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= EPSILON, `${label}: ${actual} != ${expected}`);
}

function assertFiniteResultGeometry(result: ReturnType<typeof detectGroundSupport>): void {
  assert.equal(result.grounded, true);
  assert.ok(result.normal !== null && result.basis !== null);
  for (const vector of [
    result.normal,
    result.basis.normal,
    result.basis.forward,
    result.basis.right,
  ]) {
    assert.ok([vector.x, vector.y, vector.z].every(Number.isFinite));
    assertApproximately(Math.hypot(vector.x, vector.y, vector.z), 1, 'basis unit vector');
  }
  assertApproximately(
    result.basis.normal.x * result.basis.forward.x
      + result.basis.normal.y * result.basis.forward.y
      + result.basis.normal.z * result.basis.forward.z,
    0,
    'surface forward tangent',
  );
  const command = projectSurfaceCommand(result.basis, 1, 1);
  assert.ok([command.x, command.y, command.z].every(Number.isFinite));
  assert.ok(Math.hypot(command.x, command.y, command.z) <= 1 + EPSILON);
}

function runArenaSupportCases(): void {
  const world = createTrackedWorld();
  let arena: ReturnType<typeof createArenaColliders> | null = null;
  try {
    arena = createArenaColliders(world, ARENA_COLLISION_GEOMETRY);
    const registry = arena.registry;
    const entries = registry.entries();
    assert.ok(entries.some((entry) => entry.surfaceId === 'field.floor' && entry.groundingEnabled));
    for (const id of [
      'field.ramp.west',
      'field.ramp.east',
      'field.ramp.blue-end',
      'field.ramp.orange-end',
      'goal.blue.floor',
      'goal.blue.side-west',
      'goal.blue.side-east',
      'goal.blue.roof',
      'goal.blue.back',
      'goal.orange.floor',
      'goal.orange.side-west',
      'goal.orange.side-east',
      'goal.orange.roof',
      'goal.orange.back',
    ]) {
      assert.ok(entries.some((entry) => entry.surfaceId === id && entry.groundingEnabled), `${id} must be enabled Core metadata`);
    }
    assert.equal(ADVANCED_SURFACE_GROUNDING_ENABLED, false);
    assert.ok(
      entries.filter((entry) => entry.capability === 'advanced')
        .every((entry) => entry.groundingEnabled === false),
      'all present Advanced surfaces must be capability-disabled',
    );

    const floorProbe = createProbe(world, { x: 0, y: CAR_HALF_HEIGHT + 0.02, z: 0 });
    world.updateSceneQueries();
    const floor = detectGroundSupport(world, floorProbe, registry);
    assert.equal(floor.grounded, true);
    assert.ok(floor.acceptedHits.length >= 4, 'all four registry points should support on floor');
    assert.ok(floor.acceptedHits.every((hit) => hit.surfaceId === 'field.floor'));
    assertFiniteResultGeometry(floor);

    floorProbe.setTranslation({ x: 0, y: 3, z: 0 }, true);
    world.updateSceneQueries();
    const miss = detectGroundSupport(world, floorProbe, registry);
    assert.deepEqual(
      miss,
      { grounded: false, normal: null, basis: null, acceptedHits: [] },
      'all misses must clear support without stale normal reuse',
    );

    const rampProfile = ARENA_COLLISION_GEOMETRY.profiles.floorWall;
    const segmentIndex = 3;
    const currentRampSample = rampProfile.samples[segmentIndex]!;
    const nextRampSample = rampProfile.samples[segmentIndex + 1]!;
    const rampHorizontal = nextRampSample.outward - currentRampSample.outward;
    const rampVertical = nextRampSample.up - currentRampSample.up;
    const rampPitch = Math.atan2(rampVertical, rampHorizontal);
    const arenaHalfWidth = ARENA_COLLISION_GEOMETRY.bounds.max[0];
    const rampRotation = rotationAroundZ(rampPitch);
    const rampNormal = { x: -Math.sin(rampPitch), y: Math.cos(rampPitch), z: 0 };
    const rampPoint = {
      x: arenaHalfWidth - rampProfile.run
        + (currentRampSample.outward + nextRampSample.outward) / 2,
      y: (currentRampSample.up + nextRampSample.up) / 2,
      z: 0,
    };
    const rampProbe = createProbe(world, {
      x: rampPoint.x + rampNormal.x * (CAR_HALF_HEIGHT + 0.02),
      y: rampPoint.y + rampNormal.y * (CAR_HALF_HEIGHT + 0.02),
      z: 0,
    }, rampRotation);
    world.updateSceneQueries();
    const ramp = detectGroundSupport(world, rampProbe, registry);
    assert.equal(ramp.grounded, true, 'rotated car must ground on lower ramp');
    assert.ok(ramp.acceptedHits.some((hit) => hit.surfaceId === 'field.ramp.east'));
    assertFiniteResultGeometry(ramp);

    const orangeGoal = ARENA_COLLISION_GEOMETRY.goals.find(({ id }) => id === 'orange-goal')!;
    const goalCenterZ = (orangeGoal.goalLineZ + orangeGoal.backWallZ) / 2;
    const goalFloorProbe = createProbe(world, {
      x: 0,
      y: CAR_HALF_HEIGHT + 0.02,
      z: goalCenterZ,
    });
    world.updateSceneQueries();
    const goalFloor = detectGroundSupport(world, goalFloorProbe, registry);
    assert.ok(goalFloor.acceptedHits.some((hit) => hit.surfaceId === 'goal.orange.floor'));

    const sideNormal = { x: -1, y: 0, z: 0 };
    const sideProbe = createProbe(world, {
      x: orangeGoal.opening.width / 2
        + sideNormal.x * (CAR_HALF_HEIGHT + 0.02),
      y: orangeGoal.opening.height / 2,
      z: goalCenterZ,
    }, rotationAroundZ(Math.PI / 2));
    world.updateSceneQueries();
    const goalSide = detectGroundSupport(world, sideProbe, registry);
    assert.equal(goalSide.grounded, true, 'rotated car must ground on solid goal interior');
    assert.ok(goalSide.acceptedHits.some((hit) => hit.surfaceId === 'goal.orange.side-east'));
    assertFiniteResultGeometry(goalSide);
  } finally {
    arena?.dispose();
    freeTrackedWorld(world);
  }
}

/**
 * The ride-height probe must stay signed on both sides of the resting height.
 * The support rays alone cannot do this: they start at the support points, so a
 * chassis that has sunk into a surface reports a zero-distance hit and the depth
 * is lost. Signed readings are what let the controller hold the resting height
 * instead of trusting Rapier's contact manifold.
 */
function runRideHeightProbeCases(): void {
  const world = createTrackedWorld();
  let arena: ReturnType<typeof createArenaColliders> | null = null;
  try {
    arena = createArenaColliders(world, ARENA_COLLISION_GEOMETRY);
    const registry = arena.registry;

    const restingProbe = createProbe(world, { x: 0, y: CAR_HALF_HEIGHT, z: 0 });
    world.updateSceneQueries();
    const resting = probeRideHeight(world, restingProbe, registry);
    assert.ok(resting, 'a resting chassis must produce a ride-height reading');
    assert.ok(
      Math.abs(resting.gap) <= 1e-3,
      `resting gap must be about zero, received ${resting.gap}`,
    );
    assertApproximately(resting.normal.y, 1, 'resting ride-height normal');
    assert.equal(resting.samples, 4, 'every support point must contribute');

    const hoverHeight = 0.12;
    restingProbe.setTranslation({ x: 0, y: CAR_HALF_HEIGHT + hoverHeight, z: 0 }, true);
    world.updateSceneQueries();
    const hovering = probeRideHeight(world, restingProbe, registry);
    assert.ok(hovering, 'a hovering chassis within probe range must still read');
    assert.ok(
      Math.abs(hovering.gap - hoverHeight) <= 1e-3,
      `hovering gap must be positive and equal the clearance, received ${hovering.gap}`,
    );

    const sinkDepth = 0.1;
    restingProbe.setTranslation({ x: 0, y: CAR_HALF_HEIGHT - sinkDepth, z: 0 }, true);
    world.updateSceneQueries();
    const sunk = probeRideHeight(world, restingProbe, registry);
    assert.ok(sunk, 'a sunk chassis must still produce a reading');
    assert.ok(
      Math.abs(sunk.gap + sinkDepth) <= 1e-3,
      `sunk gap must be negative and equal the depth, received ${sunk.gap}`,
    );

    restingProbe.setTranslation({ x: 0, y: 12, z: 0 }, true);
    world.updateSceneQueries();
    assert.equal(
      probeRideHeight(world, restingProbe, registry),
      null,
      'an airborne chassis must produce no ride-height reading',
    );

    // A rotated chassis on the lower ramp must read along its own local down.
    const rampProfile = ARENA_COLLISION_GEOMETRY.profiles.floorWall;
    const segmentIndex = 3;
    const currentSample = rampProfile.samples[segmentIndex]!;
    const nextSample = rampProfile.samples[segmentIndex + 1]!;
    const rampPitch = Math.atan2(
      nextSample.up - currentSample.up,
      nextSample.outward - currentSample.outward,
    );
    const rampNormal = { x: -Math.sin(rampPitch), y: Math.cos(rampPitch), z: 0 };
    const rampPoint = {
      x: ARENA_COLLISION_GEOMETRY.bounds.max[0] - rampProfile.run
        + (currentSample.outward + nextSample.outward) / 2,
      y: (currentSample.up + nextSample.up) / 2,
      z: 0,
    };
    const rampProbe = createProbe(world, {
      x: rampPoint.x + rampNormal.x * CAR_HALF_HEIGHT,
      y: rampPoint.y + rampNormal.y * CAR_HALF_HEIGHT,
      z: 0,
    }, rotationAroundZ(rampPitch));
    world.updateSceneQueries();
    const ramp = probeRideHeight(world, rampProbe, registry);
    assert.ok(ramp, 'a chassis aligned to the ramp must produce a reading');
    // The ramp is a chord-approximated curve and the chassis is longer than one
    // segment, so only bounded finiteness is meaningful here. Exact signed
    // behaviour is pinned by the flat-floor cases above.
    assert.ok(
      Number.isFinite(ramp.gap) && Math.abs(ramp.gap) <= 0.5,
      `ramp gap must stay finite and bounded, received ${ramp.gap}`,
    );
    assert.ok(
      [ramp.normal.x, ramp.normal.y, ramp.normal.z].every(Number.isFinite),
      'ramp ride-height normal must be finite',
    );
    assertApproximately(
      Math.hypot(ramp.normal.x, ramp.normal.y, ramp.normal.z),
      1,
      'ramp ride-height normal magnitude',
    );
    assert.ok(ramp.samples >= 1, 'at least one support point must contribute on the ramp');
  } finally {
    arena?.dispose();
    freeTrackedWorld(world);
  }
}

function runAdjacentAndConfiguredCases(): void {
  const adjacentWorld = createTrackedWorld();
  try {
    const registry = new ArenaSurfaceRegistry(adjacentWorld);
    // Two coplanar plates meeting at x = 0, each wide and deep enough to carry
    // the support points on its own side of the seam.
    const first = adjacentWorld.createCollider(
      RAPIER.ColliderDesc
        .cuboid(SUPPORT_PLATE_HALF_WIDTH, 0.05, SUPPORT_PLATE_HALF_DEPTH)
        .setTranslation(-SUPPORT_PLATE_HALF_WIDTH, -0.05, 0),
    );
    const second = adjacentWorld.createCollider(
      RAPIER.ColliderDesc
        .cuboid(SUPPORT_PLATE_HALF_WIDTH, 0.05, SUPPORT_PLATE_HALF_DEPTH)
        .setTranslation(SUPPORT_PLATE_HALF_WIDTH, -0.05, 0),
    );
    registry.register(first, descriptor('goal.blue.floor'));
    registry.register(second, descriptor('field.floor'));
    const probe = createProbe(adjacentWorld, { x: 0, y: CAR_HALF_HEIGHT + 0.02, z: 0 });
    adjacentWorld.updateSceneQueries();
    const result = detectGroundSupport(adjacentWorld, probe, registry);
    assert.equal(result.grounded, true, 'adjacent Core surfaces must combine support');
    assert.deepEqual(
      result.acceptedHits.map((hit) => hit.contactPointIndex),
      [0, 1, 2, 3],
      'accepted normals must retain stable contact-point-index order',
    );
    assert.deepEqual(
      [...new Set(result.acceptedHits.map((hit) => hit.surfaceId))].sort(),
      ['field.floor', 'goal.blue.floor'],
      'adjacent support must include both Core surfaces independent of hit order',
    );
    assertFiniteResultGeometry(result);
  } finally {
    freeTrackedWorld(adjacentWorld);
  }

  const distanceWorld = createTrackedWorld();
  try {
    const registry = new ArenaSurfaceRegistry(distanceWorld);
    registry.register(createFloorCollider(distanceWorld), descriptor('field.floor'));
    const probe = createProbe(distanceWorld, { x: 0, y: CAR_HALF_HEIGHT + 0.2, z: 0 });
    distanceWorld.updateSceneQueries();
    assert.equal(detectGroundSupport(distanceWorld, probe, registry).grounded, true);
    const shortRay = tuningWith(new Map<string, number | readonly number[]>([[TUNING_IDS.support.rayDistance, 0.1]]));
    assert.equal(
      detectGroundSupport(distanceWorld, probe, registry, { tuning: shortRay }).grounded,
      false,
      'configured ray distance must be enforced',
    );
  } finally {
    freeTrackedWorld(distanceWorld);
  }

  const thresholdWorld = createTrackedWorld();
  try {
    const registry = new ArenaSurfaceRegistry(thresholdWorld);
    registry.register(createFloorCollider(thresholdWorld), descriptor('field.floor'));
    // Tilt the probe 50 degrees and lift it so its rotated contact points still
    // start just above the plate; the rejection must come from the configured
    // normal threshold, never from rays that begin below the surface.
    const thresholdTilt = 50 * Math.PI / 180;
    const probe = createProbe(
      thresholdWorld,
      { x: 0, y: CAR_HALF_HEIGHT * Math.cos(thresholdTilt) + 0.02, z: 0 },
      rotationAroundZ(thresholdTilt),
    );
    const contactPoints = [
      0, -CAR_HALF_HEIGHT, -0.3,
      0, -CAR_HALF_HEIGHT, -0.1,
      0, -CAR_HALF_HEIGHT, 0.1,
      0, -CAR_HALF_HEIGHT, 0.3,
    ];
    const permissive = tuningWith(new Map<string, number | readonly number[]>([
      [TUNING_IDS.support.contactPoints, contactPoints],
      [TUNING_IDS.support.normalAngleThresholdDegrees, 60],
    ]));
    const strict = tuningWith(new Map<string, number | readonly number[]>([
      [TUNING_IDS.support.contactPoints, contactPoints],
      [TUNING_IDS.support.normalAngleThresholdDegrees, 40],
    ]));
    thresholdWorld.updateSceneQueries();
    assert.equal(
      detectGroundSupport(thresholdWorld, probe, registry, { tuning: permissive }).grounded,
      true,
      'surface within configured normal threshold must support',
    );
    assert.equal(
      detectGroundSupport(thresholdWorld, probe, registry, { tuning: strict }).grounded,
      false,
      'surface outside configured normal threshold must be rejected',
    );
  } finally {
    freeTrackedWorld(thresholdWorld);
  }
}

function assertRejectedSurface(
  label: string,
  setup: (world: RAPIER.World, registry: ArenaSurfaceRegistry) => void,
): void {
  const world = createTrackedWorld();
  try {
    const registry = new ArenaSurfaceRegistry(world);
    setup(world, registry);
    const probe = createProbe(world, { x: 0, y: CAR_HALF_HEIGHT + 0.02, z: 0 });
    world.updateSceneQueries();
    const result = detectGroundSupport(world, probe, registry);
    assert.deepEqual(
      result,
      { grounded: false, normal: null, basis: null, acceptedHits: [] },
      `${label} must not provide support`,
    );
  } finally {
    freeTrackedWorld(world);
  }
}

function runFilteringCases(): void {
  assertRejectedSurface('dynamic car', (world, registry) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, -0.05, 0));
    const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(2, 0.05, 2), body);
    registry.register(collider, descriptor('field.floor'));
  });
  assertRejectedSurface('dynamic ball', (world, registry) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, -0.2, 0));
    const collider = world.createCollider(RAPIER.ColliderDesc.ball(0.2), body);
    registry.register(collider, descriptor('field.floor'));
  });
  assertRejectedSurface('sensor', (world, registry) => {
    registry.register(createFloorCollider(world, true), descriptor('field.floor'));
  });
  assertRejectedSurface('disabled collider', (world, registry) => {
    const collider = createFloorCollider(world);
    collider.setEnabled(false);
    registry.register(collider, descriptor('field.floor'));
  });
  assertRejectedSurface('disabled Advanced surface', (world, registry) => {
    const collider = createFloorCollider(world);
    const metadata = registry.register(collider, descriptor('field.ceiling'), true);
    assert.equal(metadata.capability, 'advanced');
    assert.equal(metadata.groundingEnabled, false);
  });
  assertRejectedSurface('untagged fixed geometry', (world) => {
    createFloorCollider(world);
  });

  const firstWorld = createTrackedWorld();
  try {
    const secondWorld = createTrackedWorld();
    try {
      const firstRegistry = new ArenaSurfaceRegistry(firstWorld);
      firstRegistry.register(createFloorCollider(firstWorld), descriptor('field.floor'));
      const secondProbe = createProbe(secondWorld, { x: 0, y: CAR_HALF_HEIGHT, z: 0 });
      assert.throws(
        () => detectGroundSupport(secondWorld, secondProbe, firstRegistry),
        /different Rapier world/,
        'per-world registries must prevent cross-world handle aliasing',
      );
    } finally {
      freeTrackedWorld(secondWorld);
    }
  } finally {
    freeTrackedWorld(firstWorld);
  }
}

function assertStandaloneBasisFallback(): void {
  const basis = createSurfaceRelativeBasis(
    { x: Number.NaN, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
  );
  const command = projectSurfaceCommand(basis, Number.POSITIVE_INFINITY, 0.5);
  assert.ok([command.x, command.y, command.z].every(Number.isFinite));
}

function assertSetupFailureCleanup(): void {
  assert.throws(() => {
    const world = createTrackedWorld();
    try {
      const registry = new ArenaSurfaceRegistry(world);
      registry.register(createFloorCollider(world), descriptor('field.floor'));
      throw new Error('synthetic grounding setup assertion failure');
    } finally {
      freeTrackedWorld(world);
    }
  }, /synthetic grounding setup assertion failure/);
}

async function main(): Promise<void> {
  await initPhysics();
  runArenaSupportCases();
  runRideHeightProbeCases();
  runAdjacentAndConfiguredCases();
  runFilteringCases();
  assertStandaloneBasisFallback();
  assertSetupFailureCleanup();
  assert.equal(
    disposalTracker.freed,
    disposalTracker.created,
    'every grounding-harness Rapier world must be freed',
  );
  console.log('=== GROUNDING HARNESS: PASS ===');
  console.log(`cleanup=${disposalTracker.freed}/${disposalTracker.created} worlds`);
}

main().catch((error: unknown) => {
  console.error('=== GROUNDING HARNESS: FAIL ===');
  console.error(error);
  process.exitCode = 1;
});
