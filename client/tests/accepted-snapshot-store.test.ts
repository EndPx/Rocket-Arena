import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOM_POLICIES, SNAPSHOT_PROTOCOL_VERSION } from '@rocket-arena/shared';
import {
  AcceptedSnapshotStore,
  type AcceptedSnapshotChange,
} from '../src/networking/accepted-snapshot-store.js';
import {
  decodeSnapshot,
  type SnapshotValidationResult,
} from '../src/networking/snapshot-validator.js';

type MutableRecord = Record<string, unknown>;

function makePayload(sequence = 1): MutableRecord {
  const policy = ROOM_POLICIES.quick;
  return {
    protocolVersion: SNAPSHOT_PROTOCOL_VERSION,
    policyVersion: policy.version,
    roomMode: 'quick',
    totalCapacity: policy.totalCapacity,
    teamCapacity: policy.teamCapacity,
    sequence,
    serverTime: 10_000 + sequence * 33,
    simulationTime: 1_000 + sequence * 16,
    phase: 'playing',
    countdownKind: null,
    phaseSecondsRemaining: 0,
    regulationSecondsRemaining: 240,
    kickoffEpoch: 2,
    blueScore: 1,
    orangeScore: 0,
    winner: null,
    terminalResult: null,
    latestTransition: null,
    cars: [{
      sessionId: 'driver-1',
      team: 'blue',
      name: 'Driver 1',
      isHost: false,
      position: [1, 0.5, -2],
      rotation: [0, 0, 0, 2],
      linearVelocity: [3, 0, -1],
      boost: 50,
    }],
    ball: {
      position: [0, 0.9125, 0],
      rotation: [0, 0, 0, 4],
      linearVelocity: [0, 0, 0],
    },
  };
}

function acceptedCandidate(
  sequence = 1,
  previousSnapshot: Parameters<typeof decodeSnapshot>[1]['previousSnapshot'] = null,
): SnapshotValidationResult {
  const result = decodeSnapshot(makePayload(sequence), {
    roomMode: 'quick',
    previousSnapshot,
  });
  assert.equal(result.ok, true);
  return result;
}

// **Validates: Requirements 6.9-6.12**
test('one atomic commit sends exactly one notification with the accepted snapshot', () => {
  const store = new AcceptedSnapshotStore();
  const generation = store.getGeneration();
  const changes: AcceptedSnapshotChange[] = [];
  const candidate = acceptedCandidate();

  store.subscribe((change) => changes.push(change));

  assert.equal(store.commit(candidate, generation), true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'commit');
  assert.equal(changes[0].previous.snapshot, null);
  assert.strictEqual(changes[0].current, store.getState());
  if (!candidate.ok) assert.fail('candidate unexpectedly rejected');
  assert.strictEqual(store.getSnapshot(), candidate.snapshot);
});

test('reads expose only frozen state and recursively immutable decoder output', () => {
  const store = new AcceptedSnapshotStore();
  const candidate = acceptedCandidate();
  assert.equal(store.commit(candidate, store.getGeneration()), true);

  const state = store.getState();
  const snapshot = state.snapshot;
  assert.ok(snapshot);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.generation), true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.cars), true);
  assert.equal(Object.isFrozen(snapshot.cars[0]), true);
  assert.equal(Object.isFrozen(snapshot.cars[0].position), true);

  assert.throws(() => {
    (state as { snapshot: null }).snapshot = null;
  }, TypeError);
  assert.throws(() => {
    (snapshot.cars as unknown as Array<unknown>).pop();
  }, TypeError);
  assert.throws(() => {
    (snapshot.cars[0].position as unknown as number[])[0] = 999;
  }, TypeError);

  assert.strictEqual(store.getState(), state);
  assert.equal(store.getSnapshot()?.cars[0].position[0], 1);
});

test('subscriber failures and unsubscriptions are isolated from other consumers', () => {
  const reportedErrors: unknown[] = [];
  const store = new AcceptedSnapshotStore((error) => reportedErrors.push(error));
  const deliveries: string[] = [];

  store.subscribe(() => {
    deliveries.push('failing');
    throw new Error('HUD failed');
  });
  const unsubscribeAudio = store.subscribe(() => deliveries.push('audio'));
  store.subscribe(() => deliveries.push('camera'));

  assert.doesNotThrow(() => {
    assert.equal(store.commit(acceptedCandidate(1), store.getGeneration()), true);
  });
  assert.deepEqual(deliveries, ['failing', 'audio', 'camera']);
  assert.equal(reportedErrors.length, 1);

  unsubscribeAudio();
  unsubscribeAudio();
  const previous = store.getSnapshot();
  assert.ok(previous);
  assert.equal(
    store.commit(acceptedCandidate(2, previous), store.getGeneration()),
    true,
  );
  assert.deepEqual(deliveries, ['failing', 'audio', 'camera', 'failing', 'camera']);
  assert.equal(reportedErrors.length, 2);
});

test('room reset rejects stale commits and stale resets by generation identity', () => {
  const store = new AcceptedSnapshotStore();
  const firstGeneration = store.getGeneration();
  const changes: AcceptedSnapshotChange[] = [];
  store.subscribe((change) => changes.push(change));

  assert.equal(store.commit(acceptedCandidate(1), firstGeneration), true);
  const secondGeneration = store.reset(firstGeneration);
  assert.ok(secondGeneration);
  assert.notStrictEqual(secondGeneration, firstGeneration);
  assert.equal(secondGeneration.id, firstGeneration.id + 1);
  assert.equal(store.getSnapshot(), null);
  assert.equal(changes.at(-1)?.type, 'reset');

  assert.equal(store.commit(acceptedCandidate(2), firstGeneration), false);
  assert.equal(store.reset(firstGeneration), null);
  assert.equal(store.getSnapshot(), null);
  assert.equal(changes.length, 2, 'stale work must not notify subscribers');

  assert.equal(store.commit(acceptedCandidate(1), secondGeneration), true);
  assert.equal(store.getSnapshot()?.sequence, 1, 'a new room may restart its sequence');
  assert.equal(changes.length, 3);
});

test('decoder-rejected candidates preserve accepted state and send no notification', () => {
  const store = new AcceptedSnapshotStore();
  const first = acceptedCandidate();
  assert.equal(store.commit(first, store.getGeneration()), true);
  const before = store.getState();
  let notifications = 0;
  store.subscribe(() => notifications += 1);

  const invalid = makePayload(2);
  invalid.protocolVersion = 999;
  const rejected = decodeSnapshot(invalid, {
    roomMode: 'quick',
    previousSnapshot: before.snapshot,
  });
  assert.equal(rejected.ok, false);

  assert.equal(store.commit(rejected, store.getGeneration()), false);
  assert.strictEqual(store.getState(), before);
  assert.equal(notifications, 0);
});
