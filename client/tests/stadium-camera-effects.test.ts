import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { RESOLVED_ARENA_GEOMETRY, VISUAL } from '@rocket-arena/shared';
import { createArena, type ArenaBoundaryMeshMetadata } from '../src/renderer/arena.js';
import { DAYLIGHT_SCENE_STYLE } from '../src/renderer/arena-style.js';
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

test('stadium preserves authoritative geometry while batching the daylight presentation', () => {
  const scene = new THREE.Scene();
  const arena = createArena(scene, RESOLVED_ARENA_GEOMETRY);
  const floorPrimitive = RESOLVED_ARENA_GEOMETRY.primitives.find(({ id }) => id === 'field.floor.center');
  assert.ok(floorPrimitive);
  const field = arena.getObjectByName(`arena-boundary:${floorPrimitive.id}`) as THREE.Mesh;
  const turf = arena.getObjectByName(`procedural-pbr-turf:${floorPrimitive.id}`) as THREE.Mesh;
  const cageFacets = arena.getObjectByName('batched-cage-faceted-overlay');
  const cageMullions = arena.getObjectByName('batched-cage-major-mullions');
  const serviceDeckHexes = arena.getObjectByName('batched-service-deck-hex-lines');
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

  assert.ok(turf instanceof THREE.Mesh);
  assert.ok(turf.material instanceof THREE.MeshStandardMaterial);
  assert.equal(turf.material.name, 'procedural-pbr-turf-material');
  assert.ok(turf.material.map instanceof THREE.DataTexture);
  assert.ok(turf.material.roughnessMap instanceof THREE.DataTexture);
  assert.notEqual(turf.material.map, turf.material.roughnessMap);
  assert.equal(turf.material.map.colorSpace, THREE.SRGBColorSpace);
  assert.ok(cageFacets instanceof THREE.LineSegments);
  assert.ok(cageMullions instanceof THREE.LineSegments);
  assert.ok(serviceDeckHexes instanceof THREE.LineSegments);
  assert.equal(cageFacets.userData.arenaBoundary, undefined);
  assert.equal(cageMullions.userData.arenaBoundary, undefined);
  arena.gameplayOverlays.traverse((object) => assert.equal(object.userData.arenaBoundary, undefined));

  assert.ok(seats instanceof THREE.InstancedMesh);
  assert.equal(seats.count, expectedSeats);
  assert.ok(arches instanceof THREE.InstancedMesh);
  assert.equal(arches.count, VISUAL.STADIUM.STRUCTURE.ARCH_COUNT);
  assert.ok(lamps instanceof THREE.InstancedMesh);
  assert.equal(lamps.count, 2 * VISUAL.STADIUM.LIGHTS.BANKS_PER_SIDE * VISUAL.STADIUM.LIGHTS.LAMPS_PER_BANK);
  assert.ok(arena.getObjectByName('instanced-tier-fascia') instanceof THREE.InstancedMesh);
  assert.ok(arena.getObjectByName('instanced-compression-ring') instanceof THREE.InstancedMesh);
  assert.ok(arena.getObjectByName('instanced-roof-cross-bracing') instanceof THREE.InstancedMesh);
  assert.ok(arena.getObjectByName('instanced-ribbon-floodlights') instanceof THREE.InstancedMesh);
  assert.ok(arena.getObjectByName('instanced-skyline-window-bands') instanceof THREE.InstancedMesh);
  assert.ok(arena.getObjectByName('blue-goal-grid'));
  assert.ok(arena.getObjectByName('orange-goal-grid'));
  assert.ok(arena.getObjectByName('blue-goal-dark-tunnel-floor'));
  assert.ok(arena.getObjectByName('orange-goal-tunnel-ceiling-light-strips') instanceof THREE.InstancedMesh);
  assert.ok(arena.getObjectByName('blue-rocket-arena-scoreboard'));
  assert.ok(arena.getObjectByName('orange-rocket-arena-scoreboard'));
  assert.ok(arena.getObjectByName('instanced-rocket-arena-flags'));
  assert.ok(arena.getObjectByName('instanced-city-skyline'));
  assert.ok(arena.getObjectByName('procedural-daylight-gradient-sky'));
  assert.equal(arena.exteriorPresentation.userData.presentationOnly, true);
  assert.equal(arena.getObjectByName('instanced-spectator-seats')?.userData.arenaBoundary, undefined);

  const albedo = turf.material.map;
  const roughness = turf.material.roughnessMap;
  let albedoDisposals = 0;
  let roughnessDisposals = 0;
  albedo.dispose = () => { albedoDisposals += 1; };
  roughness.dispose = () => { roughnessDisposals += 1; };

  arena.update(1 / 60, 1);
  arena.update(Number.POSITIVE_INFINITY, Number.NaN);
  const animatedGoalLight = (arena.getObjectByName('blue-goal-tunnel-ceiling-light-strips') as THREE.InstancedMesh).material;
  assert.ok(animatedGoalLight instanceof THREE.MeshStandardMaterial);
  assert.ok(Number.isFinite(animatedGoalLight.emissiveIntensity));
  assert.ok(animatedGoalLight.emissiveIntensity >= 2.45 && animatedGoalLight.emissiveIntensity <= 3.05);

  arena.dispose();
  arena.dispose();
  assert.equal(albedoDisposals, 1);
  assert.equal(roughnessDisposals, 1);
  assert.equal(arena.disposed, true);
  assert.equal(arena.authoritativeBoundaries.parent, null);
  assert.equal(arena.gameplayOverlays.parent, null);
  assert.equal(arena.exteriorPresentation.parent, null);
});

test('daylight rig derives goal accents from resolved goal records within the light budget', () => {
  const scene = new THREE.Scene();
  const rig = createLighting(scene, RESOLVED_ARENA_GEOMETRY);
  const lights: THREE.Light[] = [];
  rig.traverse((object) => {
    if (object instanceof THREE.Light) lights.push(object);
  });

  assert.equal(lights.filter((light) => light.castShadow).length, 1);
  assert.equal(lights.length, 5);
  for (const goal of RESOLVED_ARENA_GEOMETRY.goals) {
    const light = rig.getObjectByName(`${goal.defendingTeam}-goal-ambience`);
    assert.ok(light instanceof THREE.PointLight);
    assert.equal(light.position.x, goal.opening.centerX);
    assert.equal(light.position.y, goal.opening.bottomY + goal.opening.height * 0.55);
    assert.equal(light.position.z, THREE.MathUtils.lerp(goal.goalLineZ, goal.backWallZ, 0.32));
    assert.equal(light.castShadow, false);
  }
  assert.ok(lights.length <= 5, `lighting budget unexpectedly grew to ${lights.length} lights`);
});

test('daylight scene configuration keeps the skyline bright and ahead of haze', () => {
  const sky = new THREE.Color(DAYLIGHT_SCENE_STYLE.sky);
  assert.ok(sky.getHSL({ h: 0, s: 0, l: 0 }).l > 0.45);
  assert.ok(DAYLIGHT_SCENE_STYLE.exposure >= 1);
  assert.ok(DAYLIGHT_SCENE_STYLE.fogNear >= 80);
  assert.ok(DAYLIGHT_SCENE_STYLE.fogFar > DAYLIGHT_SCENE_STYLE.fogNear * 2);
  assert.ok(DAYLIGHT_SCENE_STYLE.cameraFar > DAYLIGHT_SCENE_STYLE.fogFar);
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
