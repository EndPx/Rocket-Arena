import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SnapshotBuffer,
  slerpShortest,
  type AuthoritativeSnapshot,
  type EntitySnapshot,
} from '../src/networking/interpolation-buffer.js';

const IDENTITY_ENTITY: EntitySnapshot = {
  x: 0,
  y: 0,
  z: 0,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  vx: 0,
  vy: 0,
  vz: 0,
};

function snapshot(
  sequence: number,
  simulationTime: number,
  entity: Partial<EntitySnapshot>,
): AuthoritativeSnapshot {
  return {
    sequence,
    serverTime: 1_700_000_000_000 + simulationTime,
    simulationTime,
    entities: { car: { ...IDENTITY_ENTITY, ...entity } },
  };
}

function entityAt(buffer: SnapshotBuffer, simulationTime: number): EntitySnapshot {
  const frame = buffer.sampleAt(simulationTime);
  assert.ok(frame);
  const entity = frame.entities.car;
  assert.ok(entity);
  return entity;
}

test('position and velocity interpolation hits both endpoints and midpoint', () => {
  const buffer = new SnapshotBuffer({ interpolationDelayMs: 0, teleportThreshold: 20 });
  assert.equal(buffer.push(snapshot(1, 0, { x: 0, vx: 0 }), 0), true);
  assert.equal(buffer.push(snapshot(2, 100, { x: 10, vx: 20 }), 100), true);

  assert.equal(entityAt(buffer, 0).x, 0);
  assert.equal(entityAt(buffer, 50).x, 5);
  assert.equal(entityAt(buffer, 50).vx, 10);
  assert.equal(entityAt(buffer, 100).x, 10);
});

test('quaternion slerp takes the shortest path and always normalizes', () => {
  const degrees = Math.PI / 180;
  const from = { x: 0, y: Math.sin(85 * degrees), z: 0, w: Math.cos(85 * degrees) };
  const to = { x: 0, y: -Math.sin(85 * degrees) * 4, z: 0, w: Math.cos(85 * degrees) * 4 };
  const midpoint = slerpShortest(from, to, 0.5);
  const length = Math.hypot(midpoint.x, midpoint.y, midpoint.z, midpoint.w);

  assert.ok(Math.abs(midpoint.y) > 0.999, `expected shortest path near 180deg: ${midpoint.y}`);
  assert.ok(Math.abs(midpoint.w) < 0.01, `expected shortest path near 180deg: ${midpoint.w}`);
  assert.ok(Math.abs(length - 1) < 1e-12, `quaternion length was ${length}`);
});

test('duplicate, regressed sequence, and regressed simulation time are rejected', () => {
  const buffer = new SnapshotBuffer();
  assert.equal(buffer.push(snapshot(4, 100, {}), 100), true);
  assert.equal(buffer.push(snapshot(4, 200, { x: 2 }), 200), false);
  assert.equal(buffer.push(snapshot(3, 300, { x: 3 }), 300), false);
  assert.equal(buffer.push(snapshot(5, 90, { x: 4 }), 400), false);
  assert.equal(buffer.push(snapshot(5, 200, { x: 5 }), 500), true);

  assert.deepEqual(buffer.getSnapshotSequences(), [4, 5]);
  assert.equal(buffer.getStats().rejectedSnapshots, 3);
});

test('the immutable buffer prunes oldest snapshots at its configured bound', () => {
  const buffer = new SnapshotBuffer({ capacity: 3 });
  for (let sequence = 1; sequence <= 6; sequence++) {
    assert.equal(buffer.push(snapshot(sequence, sequence * 33, { x: sequence }), sequence * 33), true);
  }

  assert.deepEqual(buffer.getSnapshotSequences(), [4, 5, 6]);
  assert.equal(buffer.getStats().size, 3);
});

test('underrun extrapolation uses velocity and stops at the configured bound', () => {
  const buffer = new SnapshotBuffer({ maxExtrapolationMs: 50 });
  buffer.push(snapshot(1, 100, { x: 2, vx: 10 }), 100);

  const withinBound = buffer.sampleAt(140);
  const beyondBound = buffer.sampleAt(1000);
  assert.ok(withinBound && beyondBound);
  assert.equal(withinBound.mode, 'extrapolated');
  assert.equal(withinBound.underrun, true);
  assert.ok(Math.abs(withinBound.entities.car.x - 2.4) < 1e-12);
  assert.ok(Math.abs(beyondBound.entities.car.x - 2.5) < 1e-12);
  assert.equal(buffer.getStats().underrunFrames, 2);
});

test('teleports hold the old pose until the authoritative endpoint', () => {
  const buffer = new SnapshotBuffer({ teleportThreshold: 8 });
  buffer.push(snapshot(1, 0, { x: 0 }), 0);
  buffer.push(snapshot(2, 100, { x: 20 }), 100);

  const midpoint = buffer.sampleAt(50);
  const endpoint = buffer.sampleAt(100);
  assert.ok(midpoint && endpoint);
  assert.equal(midpoint.mode, 'teleport');
  assert.equal(midpoint.entities.car.x, 0);
  assert.equal(endpoint.entities.car.x, 20);
});

// **Validates: Requirements 5, 7**
test('generated linear snapshots preserve interpolation bounds and normalized rotations', () => {
  let state = 0x1a2b3c4d;
  for (let sample = 0; sample < 256; sample++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const start = (state % 2000) - 1000;
    state = (state * 1664525 + 1013904223) >>> 0;
    const end = (state % 2000) - 1000;
    state = (state * 1664525 + 1013904223) >>> 0;
    const amount = (state % 1001) / 1000;

    const buffer = new SnapshotBuffer({ teleportThreshold: 10_000 });
    buffer.push(snapshot(1, 0, { x: start, qw: 3 }), 0);
    buffer.push(snapshot(2, 1000, { x: end, qw: -7 }), 1000);
    const entity = entityAt(buffer, amount * 1000);
    const lower = Math.min(start, end);
    const upper = Math.max(start, end);
    const quaternionLength = Math.hypot(entity.qx, entity.qy, entity.qz, entity.qw);

    assert.ok(entity.x >= lower - 1e-9 && entity.x <= upper + 1e-9);
    assert.ok(Math.abs(quaternionLength - 1) < 1e-12);
  }
});
