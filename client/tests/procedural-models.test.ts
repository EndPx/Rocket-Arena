import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { BALL, CAR, VISUAL } from '@rocket-arena/shared';
import {
  createCarMesh,
  createCarVisualRig,
  createSectionedShellGeometry,
  getCarVisualRig,
  getSharedCarResourceReferenceCount,
  type CarVisualRig,
  type ShellSection,
} from '../src/renderer/car.js';
import { createBallMesh } from '../src/renderer/ball.js';

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('car model exposes a complete synchronized visual rig within chassis scale', () => {
  const car = createCarMesh('blue');
  const rig = car.userData.visualRig as CarVisualRig;
  const bounds = new THREE.Box3();
  car.updateMatrixWorld(true);
  car.traverse((object) => {
    if (object instanceof THREE.Mesh && object.visible) {
      bounds.union(new THREE.Box3().setFromObject(object));
    }
  });
  const size = bounds.getSize(new THREE.Vector3());

  assert.equal(rig.wheelSpins.length, 4);
  assert.equal(rig.frontWheelSteers.length, 2);
  assert.equal(rig.exhausts.length, 2);
  assert.equal(rig.boostFlames.length, 2);
  assert.equal(rig.boostTrails.length, 2);
  assert.ok(car.getObjectByName('faceted-main-shell'));
  assert.ok(car.getObjectByName('armored-canopy'));
  assert.ok(car.getObjectByName('front-splitter'));
  assert.ok(car.getObjectByName('rear-diffuser'));
  assert.ok(size.x <= CAR.BODY.WIDTH * 1.18, `car width ${size.x} exceeded readable chassis allowance`);
  assert.ok(size.y <= CAR.BODY.HEIGHT * 1.15, `car height ${size.y} exceeded readable chassis allowance`);
  assert.ok(size.z <= CAR.BODY.LENGTH * 1.08, `car length ${size.z} exceeded readable chassis allowance`);
  assert.ok(rig.exhausts.every((exhaust) => exhaust.position.z < 0), 'exhausts must remain behind the +Z-facing car');
});

test('mechanical ball preserves the authoritative spherical silhouette and instanced nodes', () => {
  const ball = createBallMesh();
  const bounds = new THREE.Box3().setFromObject(ball);
  const size = bounds.getSize(new THREE.Vector3());
  const nodes = ball.getObjectByName('emissive-panel-nodes');

  assert.ok(ball.getObjectByName('faceted-panel-shell'));
  assert.ok(ball.getObjectByName('dark-panel-seams'));
  assert.ok(nodes instanceof THREE.InstancedMesh);
  assert.equal(nodes.count, VISUAL.BALL.NODE_COUNT);
  assert.ok(size.x <= BALL.RADIUS * 2.08);
  assert.ok(size.y <= BALL.RADIUS * 2.08);
  assert.ok(size.z <= BALL.RADIUS * 2.08);
});

test('sectioned shell geometry stays finite and bounded across generated profiles', () => {
  const random = seededRandom(0x524f434b);

  for (let sample = 0; sample < 64; sample++) {
    const sectionCount = 2 + Math.floor(random() * 5);
    const sections: ShellSection[] = [];
    let z = -2 - random();
    let maxHalfWidth = 0;
    let minBottom = Number.POSITIVE_INFINITY;
    let maxTop = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < sectionCount; index++) {
      const width = 0.2 + random() * 3;
      const bottom = -0.8 + random() * 0.4;
      const top = bottom + 0.1 + random() * 1.2;
      sections.push({ z, width, bottom, top });
      z += 0.1 + random() * 1.5;
      maxHalfWidth = Math.max(maxHalfWidth, width / 2);
      minBottom = Math.min(minBottom, bottom);
      maxTop = Math.max(maxTop, top);
    }

    const geometry = createSectionedShellGeometry(sections);
    const positions = geometry.getAttribute('position');
    const bounds = geometry.boundingBox;
    assert.ok(bounds);

    for (let index = 0; index < positions.count; index++) {
      assert.ok(Number.isFinite(positions.getX(index)));
      assert.ok(Number.isFinite(positions.getY(index)));
      assert.ok(Number.isFinite(positions.getZ(index)));
    }
    assert.ok(bounds.min.x >= -maxHalfWidth - 1e-6);
    assert.ok(bounds.max.x <= maxHalfWidth + 1e-6);
    assert.ok(bounds.min.y >= minBottom - 1e-6);
    assert.ok(bounds.max.y <= maxTop + 1e-6);
    assert.ok(Math.abs(bounds.min.z - sections[0].z) <= 1e-6);
    assert.ok(Math.abs(bounds.max.z - sections[sections.length - 1].z) <= 1e-6);
    geometry.dispose();
  }
});

// Validates: Requirements 1.9-1.12, 18.24 (Task 7 rig ownership and budgets)

test('eight car rigs share one immutable resource set and release it exactly once', () => {
  const before = getSharedCarResourceReferenceCount();
  const rigs = [
    ...Array.from({ length: 4 }, () => createCarVisualRig('blue')),
    ...Array.from({ length: 4 }, () => createCarVisualRig('orange')),
  ];

  try {
    assert.equal(getSharedCarResourceReferenceCount(), before + 8);

    const shells = rigs.map((rig) => {
      const shell = rig.object.getObjectByName('faceted-main-shell');
      assert.ok(shell instanceof THREE.Mesh);
      return shell;
    });
    const geometries = new Set(shells.map((shell) => shell.geometry));
    assert.equal(geometries.size, 1, 'all eight rigs must reuse one shell geometry');

    const bodyMaterials = new Set(shells.map((shell) => shell.material));
    assert.equal(bodyMaterials.size, 2, 'exactly one body material per team is shared');

    const flameMaterials = new Set(rigs.flatMap((rig) => rig.boostFlames.map((f) => f.material)));
    assert.equal(
      flameMaterials.size,
      16,
      'boost flame opacity is animated per car, so those materials stay per car',
    );

    const wheelGeometries = new Set(rigs.flatMap((rig) => rig.wheelSpins.map((wheel) => {
      const tire = wheel.getObjectByName('tire');
      assert.ok(tire instanceof THREE.Mesh);
      return tire.geometry;
    })));
    assert.equal(wheelGeometries.size, 1, 'all 32 wheels reuse one tire geometry');
  } finally {
    for (const rig of rigs) rig.dispose();
  }

  assert.equal(getSharedCarResourceReferenceCount(), before);
  assert.ok(rigs.every((rig) => rig.isDisposed));

  const disposedTwice = createCarVisualRig('blue');
  const afterCreate = getSharedCarResourceReferenceCount();
  disposedTwice.dispose();
  disposedTwice.dispose();
  assert.equal(
    getSharedCarResourceReferenceCount(),
    afterCreate - 1,
    'repeated disposal must release only one shared reference',
  );
});

test('rigs carry team shape cues and an opt-in local marker', () => {
  const blue = createCarVisualRig('blue');
  const orange = createCarVisualRig('orange');

  try {
    assert.equal(blue.team, 'blue');
    assert.equal(orange.team, 'orange');
    assert.ok(blue.object.getObjectByName('team-crest-blue-left'));
    assert.ok(blue.object.getObjectByName('team-crest-blue-right'));
    assert.equal(blue.object.getObjectByName('team-crest-orange'), undefined);
    assert.ok(orange.object.getObjectByName('team-crest-orange'));
    assert.equal(orange.object.getObjectByName('team-crest-blue-left'), undefined);

    const marker = blue.object.getObjectByName('local-player-marker');
    assert.ok(marker instanceof THREE.Mesh);
    assert.equal(marker.visible, false, 'remote cars must not show the local marker');
    assert.equal(blue.isLocal, false);

    blue.setLocal(true);
    assert.equal(blue.isLocal, true);
    assert.equal(marker.visible, true);

    blue.setLocal(false);
    assert.equal(marker.visible, false);

    assert.strictEqual(getCarVisualRig(blue.object), blue);
    assert.equal(getCarVisualRig(new THREE.Group()), null);
  } finally {
    blue.dispose();
    orange.dispose();
  }
});

test('an unknown team label resolves to a presentable identity', () => {
  const rig = createCarVisualRig('spectator');
  try {
    assert.equal(rig.team, 'orange');
    assert.ok(rig.object.getObjectByName('team-crest-orange'));
  } finally {
    rig.dispose();
  }
});

test('rig temporal state rebases without touching the transform', () => {
  const car = createCarMesh('blue');
  const rig = getCarVisualRig(car);
  assert.ok(rig);

  try {
    car.position.set(4, 2, -7);
    rig.motion.wheelSpeed = 12;
    rig.motion.boostBlend = 0.8;
    rig.motion.boostActiveUntil = 99;
    rig.motion.lastBoost = 21;
    rig.motion.hasBoostReference = true;
    rig.wheelSpins[0]!.rotation.x = 1.2;
    rig.frontWheelSteers[0]!.rotation.y = 0.4;
    for (const flame of rig.boostFlames) flame.visible = true;

    rig.resetTemporalState();

    assert.equal(rig.motion.wheelSpeed, 0);
    assert.equal(rig.motion.boostBlend, 0);
    assert.equal(rig.motion.boostActiveUntil, 0);
    assert.equal(rig.motion.hasBoostReference, false);
    assert.equal(rig.wheelSpins[0]!.rotation.x, 0);
    assert.equal(rig.frontWheelSteers[0]!.rotation.y, 0);
    assert.ok(rig.boostFlames.every((flame) => !flame.visible));
    assert.deepEqual(car.position.toArray(), [4, 2, -7], 'a rebase must not move the car');
  } finally {
    rig.dispose();
  }
});
