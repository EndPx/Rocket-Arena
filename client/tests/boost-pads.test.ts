import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  VISUAL,
  resolveBoostPadDescriptors,
  type BoostPadDescriptor,
  type BoostPadKind,
} from '@rocket-arena/shared';
import { createBoostPadVisuals } from '../src/renderer/boost-pads.js';

function descriptor(
  id: string,
  position: readonly [number, number, number],
  kind: BoostPadKind = 'large',
): BoostPadDescriptor {
  const large = kind === 'large';
  return {
    id,
    kind,
    position,
    halfExtents: large ? [1.5, 0.3, 1.5] : [0.8, 0.2, 0.8],
    pickupHeight: 1.6,
    onRampBand: false,
    boostAmount: large ? 100 : 12,
    respawnSeconds: large ? 10 : 5,
  };
}

function collectMeshes(root: THREE.Object3D, name: string): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && object.name === name) found.push(object);
  });
  return found;
}

test('an empty descriptor list is a complete valid no-op rather than invented decoration', () => {
  const visuals = createBoostPadVisuals([]);

  assert.equal(visuals.padCount, 0);
  assert.equal(visuals.object.children.length, 0);
  // A no-op must still be safe to attach, detach, and tear down like any other.
  const scene = new THREE.Scene();
  scene.add(visuals.object);
  visuals.dispose();
  assert.equal(visuals.object.parent, null);
  visuals.dispose();
});

test('every pad is drawn at its descriptor position, lifted clear of the turf', () => {
  const positions: readonly (readonly [number, number, number])[] = [
    [-30, 0.15, -35],
    [39, 0.15, 0],
    [30, 0.15, 35],
  ];
  const visuals = createBoostPadVisuals(
    positions.map((position, index) => descriptor(`pad.${index}`, position)),
  );

  assert.equal(visuals.padCount, positions.length);
  assert.equal(visuals.object.children.length, positions.length);

  positions.forEach((position, index) => {
    const pad = visuals.object.getObjectByName(`boost-pad:pad.${index}`);
    assert.ok(pad, `pad ${index} was not drawn`);
    assert.equal(pad.position.x, position[0]);
    assert.equal(pad.position.z, position[2]);
    // Lifted by exactly the shared floor clearance: enough to beat z-fighting
    // against the turf and its markings, and no more.
    assert.equal(
      pad.position.y,
      position[1] + VISUAL.BALL_MOTION.MARKER_FLOOR_CLEARANCE,
    );
  });

  visuals.dispose();
});

test('pads lie flat on the floor and the rim reads over the disc', () => {
  const visuals = createBoostPadVisuals([descriptor('pad.0', [39, 0.15, 0])]);

  const [disc] = collectMeshes(visuals.object, 'boost-pad-disc');
  const [rim] = collectMeshes(visuals.object, 'boost-pad-rim');
  assert.ok(disc && rim);
  // Both lie in the floor plane; a pad that stood upright would be a wall decal.
  assert.equal(disc.rotation.x, -Math.PI / 2);
  assert.equal(rim.rotation.x, -Math.PI / 2);
  assert.ok(rim.renderOrder > disc.renderOrder, 'rim must resolve above the disc');

  visuals.dispose();
});

test('geometry and materials are shared across every pad however many there are', () => {
  const visuals = createBoostPadVisuals(
    Array.from({ length: 6 }, (_, index) => descriptor(`pad.${index}`, [index, 0.15, 0])),
  );

  const discs = collectMeshes(visuals.object, 'boost-pad-disc');
  const rims = collectMeshes(visuals.object, 'boost-pad-rim');
  assert.equal(discs.length, 6);
  assert.equal(rims.length, 6);

  assert.equal(new Set(discs.map((mesh) => mesh.geometry)).size, 1);
  assert.equal(new Set(discs.map((mesh) => mesh.material)).size, 1);
  assert.equal(new Set(rims.map((mesh) => mesh.geometry)).size, 1);
  assert.equal(new Set(rims.map((mesh) => mesh.material)).size, 1);
  // Disc and rim are distinct resources, not the same one reused.
  assert.notEqual(discs[0]!.geometry, rims[0]!.geometry);

  visuals.dispose();
});

test('disposal releases every owned resource exactly once and is idempotent', () => {
  const visuals = createBoostPadVisuals([
    descriptor('pad.0', [-39, 0.15, 0]),
    descriptor('pad.1', [39, 0.15, 0]),
  ]);
  const scene = new THREE.Scene();
  scene.add(visuals.object);

  const disc = collectMeshes(visuals.object, 'boost-pad-disc')[0]!;
  const rim = collectMeshes(visuals.object, 'boost-pad-rim')[0]!;
  const disposals = new Map<string, number>();
  const watch = (key: string, resource: THREE.BufferGeometry | THREE.Material): void => {
    disposals.set(key, 0);
    resource.addEventListener('dispose', () => {
      disposals.set(key, (disposals.get(key) ?? 0) + 1);
    });
  };
  watch('disc-geometry', disc.geometry);
  watch('rim-geometry', rim.geometry);
  watch('disc-material', disc.material as THREE.Material);
  watch('rim-material', rim.material as THREE.Material);

  visuals.dispose();
  visuals.dispose();
  visuals.dispose();

  assert.deepEqual([...disposals.entries()].sort(), [
    ['disc-geometry', 1],
    ['disc-material', 1],
    ['rim-geometry', 1],
    ['rim-material', 1],
  ]);
  assert.equal(visuals.object.parent, null);
  assert.equal(visuals.object.children.length, 0);
});

test('the two pad classes get their own footprint rather than the first one seen', () => {
  // Sizing every pad from `descriptors[0]` drew small pads at large-pad size,
  // which told a player the catch area was somewhere it is not.
  const visuals = createBoostPadVisuals([
    descriptor('small.0', [0, 0.15, 10.24], 'small'),
    descriptor('large.0', [39, 0.15, 0], 'large'),
    descriptor('small.1', [10.24, 0.15, 0], 'small'),
    descriptor('large.1', [-39, 0.15, 0], 'large'),
  ]);

  const radiusOf = (padId: string): number => {
    const pad = visuals.object.getObjectByName(`boost-pad:${padId}`);
    const rim = pad?.getObjectByName('boost-pad-rim');
    assert.ok(rim instanceof THREE.Mesh);
    const parameters = (rim.geometry as THREE.RingGeometry).parameters;
    return parameters.outerRadius;
  };

  // Footprints follow the descriptor: 1.5 for large, 0.8 for small.
  assert.equal(radiusOf('large.0'), 1.5);
  assert.equal(radiusOf('large.1'), 1.5);
  assert.equal(radiusOf('small.0'), 0.8);
  assert.equal(radiusOf('small.1'), 0.8);

  // One resource set per class present, shared within the class, distinct across.
  const discs = collectMeshes(visuals.object, 'boost-pad-disc');
  const geometries = new Set(discs.map((mesh) => mesh.geometry));
  const materials = new Set(discs.map((mesh) => mesh.material));
  assert.equal(geometries.size, 2);
  assert.equal(materials.size, 2);

  visuals.dispose();
});

test('the renderer draws exactly the shared pad table the room grants from', () => {
  // The point of resolving the table in shared: a drawn pad is a pad that pays
  // out. If these two ever disagree, players are being shown boost that is not
  // there, or are missing boost that is.
  const descriptors = resolveBoostPadDescriptors();
  const visuals = createBoostPadVisuals(descriptors);

  assert.ok(descriptors.length > 0, 'the seeded registry must resolve at least one pad');
  assert.equal(visuals.padCount, descriptors.length);
  for (const pad of descriptors) {
    assert.ok(
      visuals.object.getObjectByName(`boost-pad:${pad.id}`),
      `pad ${pad.id} pays out but is not drawn`,
    );
  }

  visuals.dispose();
});
