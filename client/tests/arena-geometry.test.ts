import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  RESOLVED_ARENA_GEOMETRY,
  type ResolvedArenaBoundaryPrimitive,
} from '@rocket-arena/shared';
import {
  createArena,
  type ArenaBoundaryMeshMetadata,
  type ArenaOwnership,
} from '../src/renderer/arena.js';

const ROOT_NAMES = [
  'arena-authoritative-boundaries',
  'arena-gameplay-overlays',
  'arena-exterior-presentation',
] as const;

function withArena(run: (arena: ArenaOwnership, scene: THREE.Scene) => void): void {
  const scene = new THREE.Scene();
  const arena = createArena(scene, RESOLVED_ARENA_GEOMETRY);
  try {
    run(arena, scene);
  } finally {
    arena.dispose();
  }
}

function boundaryMeshes(arena: ArenaOwnership): THREE.Mesh[] {
  return arena.authoritativeBoundaries.children.filter(
    (child): child is THREE.Mesh => child instanceof THREE.Mesh,
  );
}

function metadataOf(mesh: THREE.Mesh): ArenaBoundaryMeshMetadata {
  const metadata = (mesh.userData as { arenaBoundary?: ArenaBoundaryMeshMetadata }).arenaBoundary;
  assert.ok(metadata, `mesh ${mesh.name} must carry authoritative metadata`);
  return metadata;
}

function primitiveById(id: string): ResolvedArenaBoundaryPrimitive {
  const primitive = RESOLVED_ARENA_GEOMETRY.primitives.find((entry) => entry.id === id);
  assert.ok(primitive, `resolved geometry must define primitive ${id}`);
  return primitive;
}

// Validates: Requirements 12.1-12.10, 18.8, 18.24 (Task 6.2 / Task 11 arena coverage)

test('the arena exposes exactly three named roots and attaches them once', () => {
  withArena((arena, scene) => {
    const roots = [
      arena.authoritativeBoundaries,
      arena.gameplayOverlays,
      arena.exteriorPresentation,
    ];
    assert.deepEqual(roots.map((root) => root.name), [...ROOT_NAMES]);
    for (const root of roots) {
      assert.strictEqual(root.parent, scene, `${root.name} must be parented to the scene once`);
      assert.equal(
        scene.children.filter((child) => child === root).length,
        1,
        `${root.name} must appear exactly once`,
      );
    }
    assert.strictEqual(arena.geometry, RESOLVED_ARENA_GEOMETRY);
  });
});

test('every resolved primitive becomes one mesh whose vertices are not reconstructed', () => {
  withArena((arena) => {
    const meshes = boundaryMeshes(arena);
    assert.equal(
      meshes.length,
      RESOLVED_ARENA_GEOMETRY.primitives.length,
      'exactly one boundary mesh per resolved primitive',
    );

    const seenPrimitiveIds = new Set<string>();
    for (const mesh of meshes) {
      const metadata = metadataOf(mesh);
      const primitive = primitiveById(metadata.primitiveId);
      assert.equal(mesh.name, `arena-boundary:${primitive.id}`);
      assert.equal(seenPrimitiveIds.has(primitive.id), false, 'no primitive may be duplicated');
      seenPrimitiveIds.add(primitive.id);

      assert.equal(metadata.surfaceId, primitive.surfaceId);
      assert.equal(metadata.semanticKind, primitive.semanticKind);
      assert.equal(metadata.region, primitive.region);
      assert.equal(metadata.materialRole, primitive.materialRole);
      assert.deepEqual([...metadata.seamIds], [...primitive.inwardSurface.seamIds]);
      assert.deepEqual(metadata.geometryIdentity, {
        sourceVersion: RESOLVED_ARENA_GEOMETRY.identity.sourceVersion,
        primitiveSchemaVersion: RESOLVED_ARENA_GEOMETRY.identity.primitiveSchemaVersion,
        fingerprint: RESOLVED_ARENA_GEOMETRY.identity.fingerprint,
      });
      assert.equal(Object.isFrozen(metadata), true, 'metadata must be immutable');
      assert.equal(Object.isFrozen(mesh.userData), true);

      // The mesh must be the resolved surface, vertex for vertex.
      const surface = primitive.inwardSurface;
      const position = mesh.geometry.getAttribute('position');
      const normal = mesh.geometry.getAttribute('normal');
      const uv = mesh.geometry.getAttribute('uv');
      const index = mesh.geometry.getIndex();
      assert.ok(index, `${primitive.id} must stay indexed`);
      assert.equal(position.count, surface.positions.length);
      assert.equal(normal.count, surface.normals.length);
      assert.equal(uv.count, surface.uvs.length);
      assert.equal(index.count, surface.indices.length);

      for (let vertex = 0; vertex < surface.positions.length; vertex += 1) {
        const expected = surface.positions[vertex]!;
        assert.equal(position.getX(vertex), Math.fround(expected[0]));
        assert.equal(position.getY(vertex), Math.fround(expected[1]));
        assert.equal(position.getZ(vertex), Math.fround(expected[2]));
      }
      for (let element = 0; element < surface.indices.length; element += 1) {
        assert.equal(index.getX(element), surface.indices[element]);
      }

      // The mesh transform stays identity so world space equals resolved space.
      assert.deepEqual(mesh.position.toArray(), [0, 0, 0]);
      assert.deepEqual(mesh.quaternion.toArray(), [0, 0, 0, 1]);
      assert.deepEqual(mesh.scale.toArray(), [1, 1, 1]);
    }
  });
});

test('both goal tunnels are present and mirrored primitive for primitive', () => {
  withArena((arena) => {
    const byRegion = new Map<string, string[]>();
    for (const mesh of boundaryMeshes(arena)) {
      const metadata = metadataOf(mesh);
      const ids = byRegion.get(metadata.region) ?? [];
      ids.push(metadata.primitiveId);
      byRegion.set(metadata.region, ids);
    }

    const blue = byRegion.get('blue-goal') ?? [];
    const orange = byRegion.get('orange-goal') ?? [];
    assert.ok(blue.length > 0, 'the blue goal interior must be rendered');
    assert.equal(blue.length, orange.length, 'both goal tunnels must mirror');

    // Every rendered goal primitive must point at its mirrored counterpart, and
    // that counterpart must also be rendered.
    const rendered = new Set([...blue, ...orange]);
    for (const id of rendered) {
      const primitive = primitiveById(id);
      assert.ok(primitive.mirroredPrimitiveId, `${id} must declare a mirror`);
      assert.equal(
        rendered.has(primitive.mirroredPrimitiveId),
        true,
        `${id} mirror ${primitive.mirroredPrimitiveId} must also be rendered`,
      );
      assert.ok(primitive.mirrorAxes.length > 0, `${id} must record its mirror axes`);
    }

    for (const goal of RESOLVED_ARENA_GEOMETRY.goals) {
      for (const primitiveId of goal.primitiveIds) {
        assert.ok(
          arena.getObjectByName(`arena-boundary:${primitiveId}`),
          `${goal.id} primitive ${primitiveId} must be rendered`,
        );
      }
    }
  });
});

test('decoration stays outside the authoritative shell and carries no authority', () => {
  withArena((arena) => {
    for (const root of [arena.gameplayOverlays, arena.exteriorPresentation]) {
      root.traverse((object) => {
        const metadata = (object.userData as { arenaBoundary?: unknown }).arenaBoundary;
        assert.equal(
          metadata,
          undefined,
          `${root.name} child ${object.name || object.type} must not claim authoritative metadata`,
        );
      });
    }

    // Decoration must never be nested inside the authoritative root.
    assert.equal(
      arena.authoritativeBoundaries.getObjectByName('arena-exterior-presentation'),
      undefined,
    );
    assert.equal(
      arena.authoritativeBoundaries.getObjectByName('arena-gameplay-overlays'),
      undefined,
    );
    assert.ok(
      arena.exteriorPresentation.children.length > 0,
      'the stadium exterior must actually be built',
    );
  });
});

test('boundary materials are shared per material role', () => {
  withArena((arena) => {
    const materialsByRole = new Map<string, Set<THREE.Material>>();
    for (const mesh of boundaryMeshes(arena)) {
      const role = metadataOf(mesh).materialRole;
      const materials = materialsByRole.get(role) ?? new Set<THREE.Material>();
      const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of meshMaterials) materials.add(material);
      materialsByRole.set(role, materials);
    }

    assert.ok(materialsByRole.size > 0);
    for (const [role, materials] of materialsByRole) {
      assert.equal(materials.size, 1, `material role ${role} must reuse one material instance`);
    }
  });
});

test('an empty pad descriptor list is a complete no-op', () => {
  withArena((arena) => {
    assert.deepEqual([...arena.padDescriptors], []);
    assert.equal(Object.isFrozen(arena.padDescriptors), true);
    assert.equal(arena.getObjectByName('arena-boost-pads'), undefined);
  });

  const scene = new THREE.Scene();
  const descriptors = Object.freeze([
    Object.freeze({
      id: 'pad-large-0',
      kind: 'large' as const,
      position: Object.freeze([-30, 0.15, -35] as const),
    }),
  ]);
  const arena = createArena(scene, RESOLVED_ARENA_GEOMETRY, descriptors);
  try {
    assert.deepEqual([...arena.padDescriptors], [...descriptors]);
    assert.notStrictEqual(
      arena.padDescriptors,
      descriptors,
      'the retained list must be the arena\'s own copy',
    );
  } finally {
    arena.dispose();
  }
});

test('updates stay bounded and disposal is idempotent', () => {
  const scene = new THREE.Scene();
  const arena = createArena(scene, RESOLVED_ARENA_GEOMETRY);
  const meshes = boundaryMeshes(arena);
  const geometries = new Set(meshes.map((mesh) => mesh.geometry));
  let disposedGeometries = 0;
  for (const geometry of geometries) {
    geometry.addEventListener('dispose', () => { disposedGeometries += 1; });
  }

  for (const [delta, elapsed] of [
    [1 / 60, 0],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, Number.NaN],
    [-5, 12.5],
    [10, 30],
  ] as const) {
    arena.update(delta, elapsed);
  }
  assert.equal(arena.disposed, false);
  assert.ok(
    arena.exteriorPresentation.rotation.toArray().slice(0, 3).every(Number.isFinite),
  );

  assert.equal(scene.children.length, 3);
  arena.dispose();
  assert.equal(arena.disposed, true);
  assert.equal(scene.children.length, 0, 'disposal detaches every root');
  assert.equal(arena.authoritativeBoundaries.children.length, 0);
  assert.equal(arena.gameplayOverlays.children.length, 0);
  assert.equal(arena.exteriorPresentation.children.length, 0);
  assert.equal(disposedGeometries, geometries.size, 'each owned geometry is released once');

  arena.dispose();
  assert.equal(
    disposedGeometries,
    geometries.size,
    'a repeated disposal must not release anything twice',
  );
});
