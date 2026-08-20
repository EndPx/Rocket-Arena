import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { RESOLVED_ARENA_GEOMETRY, VISUAL } from '@rocket-arena/shared';
import { createArena, type ArenaBoundaryMeshMetadata } from '../src/renderer/arena.js';
import { createLighting } from '../src/renderer/lighting.js';
import { createCarMesh, type CarVisualRig } from '../src/renderer/car.js';
import {
  dampingAlpha,
  setFollowMode,
  updateCamera,
} from '../src/renderer/camera-controller.js';
import {
  disposeCarVisualEffects,
  inferSteerPresentation,
  updateCarVisualRig,
} from '../src/renderer/entity-effects.js';

test('stadium maps resolved primitives into three explicitly owned presentation roots', () => {
  const scene = new THREE.Scene();
  const arena = createArena(scene, RESOLVED_ARENA_GEOMETRY);
  const floorPrimitive = RESOLVED_ARENA_GEOMETRY.primitives.find(({ id }) => id === 'field.floor.center');
  assert.ok(floorPrimitive);
  const field = arena.getObjectByName(`arena-boundary:${floorPrimitive.id}`) as THREE.Mesh;
  const seats = arena.getObjectByName('instanced-spectator-seats');
  const arches = arena.getObjectByName('instanced-stadium-arches');
  const lamps = arena.getObjectByName('instanced-floodlight-lamps');
  const rowCount = VISUAL.STADIUM.STANDS.TIER_COUNT * VISUAL.STADIUM.STANDS.ROWS_PER_TIER;
  const expectedSeats = 2 * rowCount * VISUAL.STADIUM.STANDS.SEATS_PER_SIDE
    + 2 * rowCount * VISUAL.STADIUM.STANDS.SEATS_PER_END;

  assert.equal(arena.authoritativeBoundaries.name, 'arena-authoritative-boundaries');
  assert.equal(arena.gameplayOverlays.name, 'arena-gameplay-overlays');
  assert.equal(arena.exteriorPresentation.name, 'arena-exterior-presentation');
  assert.deepEqual(
    scene.children.map(({ name }) => name),
    ['arena-authoritative-boundaries', 'arena-gameplay-overlays', 'arena-exterior-presentation'],
  );
  assert.equal(arena.authoritativeBoundaries.children.length, RESOLVED_ARENA_GEOMETRY.primitives.length);
  assert.equal(arena.padDescriptors.length, 0);
  assert.equal(arena.gameplayOverlays.getObjectByName('boost-pad-placeholder'), undefined);

  assert.ok(field instanceof THREE.Mesh);
  const positions = field.geometry.getAttribute('position');
  assert.equal(positions.count, floorPrimitive.inwardSurface.positions.length);
  floorPrimitive.inwardSurface.positions.forEach((expected, index) => {
    assert.ok(Math.abs(positions.getX(index) - expected[0]) <= 1e-5);
    assert.ok(Math.abs(positions.getY(index) - expected[1]) <= 1e-5);
    assert.ok(Math.abs(positions.getZ(index) - expected[2]) <= 1e-5);
  });
  const metadata = field.userData.arenaBoundary as ArenaBoundaryMeshMetadata;
  assert.equal(metadata.primitiveId, floorPrimitive.id);
  assert.equal(metadata.surfaceId, floorPrimitive.surfaceId);
  assert.equal(metadata.geometryIdentity.fingerprint, RESOLVED_ARENA_GEOMETRY.identity.fingerprint);
  assert.deepEqual(metadata.seamIds, floorPrimitive.inwardSurface.seamIds);
  assert.ok(Object.isFrozen(metadata));
  assert.ok(Object.isFrozen(metadata.seamIds));
  assert.ok(Object.isFrozen(metadata.geometryIdentity));

  assert.ok(seats instanceof THREE.InstancedMesh);
  assert.equal(seats.count, expectedSeats);
  assert.ok(arches instanceof THREE.InstancedMesh);
  assert.equal(arches.count, VISUAL.STADIUM.STRUCTURE.ARCH_COUNT);
  assert.ok(lamps instanceof THREE.InstancedMesh);
  assert.equal(
    lamps.count,
    2 * VISUAL.STADIUM.LIGHTS.BANKS_PER_SIDE * VISUAL.STADIUM.LIGHTS.LAMPS_PER_BANK,
  );
  assert.ok(arena.getObjectByName('blue-goal-grid'));
  assert.ok(arena.getObjectByName('orange-goal-grid'));
  assert.ok(arena.getObjectByName('blue-rocket-arena-scoreboard'));
  assert.ok(arena.getObjectByName('orange-rocket-arena-scoreboard'));
  assert.ok(arena.getObjectByName('instanced-rocket-arena-flags'));
  assert.ok(arena.getObjectByName('instanced-city-skyline'));
  assert.equal(arena.exteriorPresentation.userData.presentationOnly, true);
  assert.equal(arena.getObjectByName('instanced-spectator-seats')?.userData.arenaBoundary, undefined);

  arena.update(1 / 60, 1);
  arena.dispose();
  arena.dispose();
  assert.equal(arena.disposed, true);
  assert.equal(arena.authoritativeBoundaries.parent, null);
  assert.equal(arena.gameplayOverlays.parent, null);
  assert.equal(arena.exteriorPresentation.parent, null);
});

test('lighting budget has one shadow caster and two team goal accents', () => {
  const scene = new THREE.Scene();
  const rig = createLighting(scene);
  const lights: THREE.Light[] = [];
  rig.traverse((object) => {
    if (object instanceof THREE.Light) lights.push(object);
  });

  assert.equal(lights.filter((light) => light.castShadow).length, 1);
  assert.ok(rig.getObjectByName('blue-goal-ambience') instanceof THREE.PointLight);
  assert.ok(rig.getObjectByName('orange-goal-ambience') instanceof THREE.PointLight);
  assert.ok(lights.length <= 5, `lighting budget unexpectedly grew to ${lights.length} lights`);
});

test('camera damping is frame-rate independent and follow framing stays bounded', () => {
  for (const response of [1, 4.5, 12, 30]) {
    for (const totalTime of [0.016, 0.1, 0.5, 1]) {
      let stepped = 0;
      const step = totalTime / 20;
      for (let index = 0; index < 20; index++) {
        stepped = THREE.MathUtils.lerp(stepped, 1, dampingAlpha(response, step));
      }
      const direct = dampingAlpha(response, totalTime);
      assert.ok(Math.abs(stepped - direct) < 1e-9);
    }
  }

  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 200);
  const car = createCarMesh('orange');
  car.position.set(3, 0.6, -6);
  car.quaternion.setFromEuler(new THREE.Euler(0.7, 0.9, 0.55));
  car.userData.syncedSpeed = VISUAL.CAMERA.SPEED_FOR_MAX;
  setFollowMode();

  for (let frame = 0; frame < 120; frame++) {
    updateCamera(camera, car, frame / 60, 1 / 60);
  }

  assert.ok(camera.position.toArray().every(Number.isFinite));
  assert.ok(camera.fov >= VISUAL.CAMERA.FOV_MIN && camera.fov <= VISUAL.CAMERA.FOV_MAX + 1e-6);
  assert.deepEqual(camera.up.toArray(), [0, 1, 0]);
  disposeCarVisualEffects(car);
});

test('synchronized car presentation animates wheels, steering, and inferred boost', () => {
  const car = createCarMesh('blue');
  const rig = car.userData.visualRig as CarVisualRig;
  const initialRotation = rig.wheelSpins[0].rotation.x;
  const forward = new THREE.Vector3(0, 0, 1);
  const velocity = new THREE.Vector3(3, 0, 12);

  assert.ok(inferSteerPresentation(forward, velocity) > 0);
  updateCarVisualRig(car, { vx: 3, vy: 0, vz: 12, boost: 60 }, 1 / 60, 0);
  updateCarVisualRig(car, { vx: 3, vy: 0, vz: 12, boost: 59 }, 1 / 60, 1 / 60);
  updateCarVisualRig(car, { vx: 3, vy: 0, vz: 12, boost: 59 }, 1 / 60, 2 / 60);

  assert.notEqual(rig.wheelSpins[0].rotation.x, initialRotation);
  assert.ok(rig.frontWheelSteers[0].rotation.y > 0);
  assert.ok(rig.boostFlames.every((flame) => flame.visible));
  assert.ok(rig.boostTrails.every((trail) => trail.visible));
  disposeCarVisualEffects(car);
});
