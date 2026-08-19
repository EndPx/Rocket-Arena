import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SnapshotBuffer,
  slerpShortest,
  type EntitySnapshot,
  type ValidatedTimelineSnapshot,
} from '../src/networking/interpolation-buffer.js';

const IDENTITY_ENTITY: EntitySnapshot = Object.freeze({
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
});

function snapshot(
  sequence: number,
  simulationTime: number,
  entity: Partial<EntitySnapshot>,
  kickoffEpoch = 0,
): ValidatedTimelineSnapshot {
  return Object.freeze({
    sequence,
    serverTime: 1_700_000_000_000 + simulationTime,
    simulationTime,
    kickoffEpoch,
    entities: Object.freeze({
      car: Object.freeze({ ...IDENTITY_ENTITY, ...entity }),
    }),
  });
}

function entityAt(buffer: SnapshotBuffer, simulationTime: number): EntitySnapshot {
  const frame = buffer.sampleAt(simulationTime);
  assert.ok(frame);
  const entity = frame.entities.car;
  assert.ok(entity);
  return entity;
}

// **Validates: Requirements 1.10**
test('the default delayed render timeline remains 100 milliseconds', () => {
  const buffer = new SnapshotBuffer({ teleportThreshold: 20 });
  assert.equal(buffer.accept(snapshot(1, 0, { x: 0 }), 1000), true);
  assert.equal(buffer.accept(snapshot(2, 100, { x: 10 }), 1100), true);

  const frame = buffer.sample(1150);
  assert.ok(frame);
  assert.equal(buffer.getStats().delayMs, 100);
  assert.equal(frame.simulationTime, 50);
  assert.equal(frame.entities.car.x, 5);
});

test('position and velocity interpolation hits both endpoints and midpoint', () => {
  const buffer = new SnapshotBuffer({ interpolationDelayMs: 0, teleportThreshold: 20 });
  assert.equal(buffer.accept(snapshot(1, 0, { x: 0, vx: 0 }), 0), true);
  assert.equal(buffer.accept(snapshot(2, 100, { x: 10, vx: 20 }), 100), true);

  assert.equal(entityAt(buffer, 0).x, 0);
  assert.equal(entityAt(buffer, 50).x, 5);
  assert.equal(entityAt(buffer, 50).vx, 10);
  assert.equal(entityAt(buffer, 100).x, 10);
});

// **Validates: Requirements 1.11**
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

test('duplicate, regressed sequence, time, and kickoff epoch are rejected', () => {
  const buffer = new SnapshotBuffer();
  assert.equal(buffer.accept(snapshot(4, 100, {}, 1), 100), true);
  assert.equal(buffer.accept(snapshot(4, 200, { x: 2 }, 1), 200), false);
  assert.equal(buffer.accept(snapshot(3, 300, { x: 3 }, 1), 300), false);
  assert.equal(buffer.accept(snapshot(5, 90, { x: 4 }, 1), 400), false);
  assert.equal(buffer.accept(snapshot(5, 200, { x: 5 }, 2), 500), true);
  assert.equal(buffer.accept(snapshot(6, 300, { x: 6 }, 1), 600), false);

  assert.deepEqual(buffer.getSnapshotSequences(), [4, 5]);
  assert.equal(buffer.getStats().rejectedSnapshots, 4);
});

// **Validates: Requirements 1.9**
test('the immutable buffer retains the 24 greatest accepted sequences', () => {
  const buffer = new SnapshotBuffer();
  for (let sequence = 1; sequence <= 30; sequence++) {
    assert.equal(
      buffer.accept(snapshot(sequence, sequence * 33, { x: sequence }), sequence * 33),
      true,
    );
  }

  assert.deepEqual(
    buffer.getSnapshotSequences(),
    Array.from({ length: 24 }, (_, index) => index + 7),
  );
  assert.equal(buffer.getStats().size, 24);
  assert.equal(Object.isFrozen(buffer.getSnapshotSequences()), true);
});

// **Validates: Requirements 1.12**
test('underrun extrapolation stops at 80 milliseconds and holds the bounded result', () => {
  const buffer = new SnapshotBuffer();
  buffer.accept(snapshot(1, 100, { x: 2, vx: 10 }), 100);

  const atBound = buffer.sampleAt(180);
  const beyondBound = buffer.sampleAt(1000);
  const muchLater = buffer.sampleAt(10_000);
  assert.ok(atBound && beyondBound && muchLater);
  assert.equal(atBound.mode, 'extrapolated');
  assert.equal(beyondBound.underrun, true);
  assert.equal(atBound.simulationTime, 180);
  assert.equal(beyondBound.simulationTime, 180);
  assert.equal(muchLater.simulationTime, 180);
  assert.ok(Math.abs(atBound.entities.car.x - 2.8) < 1e-12);
  assert.equal(beyondBound.entities.car.x, atBound.entities.car.x);
  assert.equal(muchLater.entities.car.x, atBound.entities.car.x);
});

test('distance teleports hold the old pose until the authoritative endpoint', () => {
  const buffer = new SnapshotBuffer({ teleportThreshold: 8 });
  buffer.accept(snapshot(1, 0, { x: 0 }), 0);
  buffer.accept(snapshot(2, 100, { x: 20 }), 100);

  const midpoint = buffer.sampleAt(50);
  const endpoint = buffer.sampleAt(100);
  assert.ok(midpoint && endpoint);
  assert.equal(midpoint.mode, 'teleport');
  assert.equal(midpoint.entities.car.x, 0);
  assert.equal(endpoint.entities.car.x, 20);
});

test('kickoff epoch changes rebase as teleport boundaries without cross-epoch interpolation', () => {
  const buffer = new SnapshotBuffer({ teleportThreshold: 10_000 });
  buffer.accept(snapshot(1, 0, { x: 0, vx: 100 }, 7), 0);
  buffer.accept(snapshot(2, 100, { x: 1, vx: 0 }, 8), 100);

  const beforeBoundary = buffer.sampleAt(50);
  const boundary = buffer.sampleAt(100);
  assert.ok(beforeBoundary && boundary);
  assert.equal(beforeBoundary.mode, 'teleport');
  assert.equal(beforeBoundary.kickoffEpoch, 7);
  assert.equal(beforeBoundary.entities.car.x, 0);
  assert.equal(boundary.mode, 'teleport');
  assert.equal(boundary.kickoffEpoch, 8);
  assert.equal(boundary.entities.car.x, 1);

  buffer.accept(snapshot(3, 200, { x: 3, vx: 0 }, 8), 200);
  const rebased = buffer.sampleAt(150);
  assert.ok(rebased);
  assert.equal(rebased.mode, 'interpolated');
  assert.equal(rebased.kickoffEpoch, 8);
  assert.equal(rebased.entities.car.x, 2);
});

// **Validates: Requirements 1.9-1.12**
test('generated linear snapshots preserve interpolation bounds and normalized rotations', () => {
  let state = 0x1a2b3c4d;
  for (let sampleIndex = 0; sampleIndex < 256; sampleIndex++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const start = (state % 2000) - 1000;
    state = (state * 1664525 + 1013904223) >>> 0;
    const end = (state % 2000) - 1000;
    state = (state * 1664525 + 1013904223) >>> 0;
    const amount = (state % 1001) / 1000;

    const buffer = new SnapshotBuffer({ teleportThreshold: 10_000 });
    buffer.accept(snapshot(1, 0, { x: start, qw: 3 }), 0);
    buffer.accept(snapshot(2, 1000, { x: end, qw: -7 }), 1000);
    const entity = entityAt(buffer, amount * 1000);
    const lower = Math.min(start, end);
    const upper = Math.max(start, end);
    const quaternionLength = Math.hypot(entity.qx, entity.qy, entity.qz, entity.qw);

    assert.ok(entity.x >= lower - 1e-9 && entity.x <= upper + 1e-9);
    assert.ok(Math.abs(quaternionLength - 1) < 1e-12);
  }
});


test('accepted snapshots are defensively owned against later caller mutation', () => {
  const callerEntity = { ...IDENTITY_ENTITY, x: 4, vx: 0 };
  const callerSnapshot = {
    sequence: 1,
    serverTime: 1_700_000_000_100,
    simulationTime: 100,
    kickoffEpoch: 3,
    entities: { car: callerEntity },
  };
  const buffer = new SnapshotBuffer({ interpolationDelayMs: 0 });

  assert.equal(buffer.accept(callerSnapshot, 100), true);

  callerSnapshot.sequence = 99;
  callerSnapshot.simulationTime = 9_900;
  callerSnapshot.kickoffEpoch = 99;
  callerEntity.x = 999;
  callerSnapshot.entities.car = { ...callerEntity, x: -999 };

  const frame = buffer.sampleAt(100);
  assert.ok(frame);
  assert.deepEqual(buffer.getSnapshotSequences(), [1]);
  assert.equal(frame.simulationTime, 100);
  assert.equal(frame.kickoffEpoch, 3);
  assert.equal(frame.entities.car.x, 4);
});
