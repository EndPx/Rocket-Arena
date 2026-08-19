import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROOM_POLICIES,
  SNAPSHOT_PROTOCOL_VERSION,
  createSnapshotEnvelopeV2,
  type SnapshotEnvelopeV2,
} from '@rocket-arena/shared';
import type { AuthoritativeRoomProjection } from './authoritative-room-core.js';
import {
  broadcastDueV2Snapshot,
  type StateSyncBroadcaster,
  type V2SnapshotSource,
} from './room-snapshot-transport.js';

const policy = ROOM_POLICIES.custom;
const projection = Object.freeze({}) as Readonly<AuthoritativeRoomProjection>;
const snapshot: Readonly<SnapshotEnvelopeV2> = createSnapshotEnvelopeV2({
  protocolVersion: SNAPSHOT_PROTOCOL_VERSION,
  policyVersion: policy.version,
  roomMode: policy.mode,
  totalCapacity: policy.totalCapacity,
  teamCapacity: policy.teamCapacity,
  sequence: 0,
  serverTime: 10_000,
  simulationTime: 1_000,
  phase: 'waiting',
  countdownKind: null,
  phaseSecondsRemaining: 0,
  regulationSecondsRemaining: 300,
  kickoffEpoch: 0,
  blueScore: 0,
  orangeScore: 0,
  winner: null,
  terminalResult: null,
  latestTransition: null,
  cars: [],
  ball: {
    position: [0, 0.9125, 0],
    rotation: [0, 0, 0, 1],
    linearVelocity: [0, 0, 0],
  },
});

// Validates: Requirements 6.2-6.8

test('adapter transport builds and broadcasts only one due successful V2 snapshot', () => {
  let buildCalls = 0;
  const source: V2SnapshotSource = {
    buildSnapshotV2(receivedProjection, serverTime) {
      buildCalls += 1;
      assert.strictEqual(receivedProjection, projection);
      assert.equal(serverTime, 12_345);
      return snapshot;
    },
    failSnapshotPublication() {
      assert.fail('successful publication must not report a transport failure');
    },
  };
  const broadcasts: Array<readonly [string, Readonly<SnapshotEnvelopeV2>]> = [];
  const broadcast: StateSyncBroadcaster = (type, value) => {
    broadcasts.push([type, value]);
  };

  assert.equal(
    broadcastDueV2Snapshot(false, projection, source, 12_345, broadcast),
    false,
  );
  assert.equal(
    broadcastDueV2Snapshot(true, null, source, 12_345, broadcast),
    false,
  );
  assert.equal(buildCalls, 0, 'non-due or projection-less frames never consume a sequence');
  assert.deepEqual(broadcasts, []);

  assert.equal(
    broadcastDueV2Snapshot(true, projection, source, 12_345, broadcast),
    true,
  );
  assert.equal(buildCalls, 1);
  assert.deepEqual(broadcasts, [['state-sync', snapshot]]);
  const broadcastSnapshot = broadcasts.at(0)?.[1] as Readonly<SnapshotEnvelopeV2> | undefined;
  assert.ok(broadcastSnapshot);
  assert.equal(broadcastSnapshot.protocolVersion, SNAPSHOT_PROTOCOL_VERSION);
  assert.equal('players' in (broadcastSnapshot as unknown as Record<string, unknown>), false);
});

test('adapter transport publishes nothing when authoritative V2 construction fails', () => {
  let buildCalls = 0;
  let broadcastCalls = 0;
  const source: V2SnapshotSource = {
    buildSnapshotV2() {
      buildCalls += 1;
      return null;
    },
    failSnapshotPublication() {
      assert.fail('a suppressed build failure must not be reported as publication failure');
    },
  };

  const published = broadcastDueV2Snapshot(
    true,
    projection,
    source,
    20_000,
    () => { broadcastCalls += 1; },
  );
  assert.equal(published, false);
  assert.equal(buildCalls, 1);
  assert.equal(broadcastCalls, 0);
});

test('adapter transport swallows publication exceptions and reports the exact cause once', () => {
  const publicationFailure = new Error('injected serializer failure');
  let reportedCause: unknown;
  let failureCalls = 0;
  let broadcastCalls = 0;
  const source: V2SnapshotSource = {
    buildSnapshotV2() {
      return snapshot;
    },
    failSnapshotPublication(cause) {
      failureCalls += 1;
      reportedCause = cause;
    },
  };

  const published = broadcastDueV2Snapshot(
    true,
    projection,
    source,
    30_000,
    () => {
      broadcastCalls += 1;
      throw publicationFailure;
    },
  );

  assert.equal(published, false);
  assert.equal(broadcastCalls, 1);
  assert.equal(failureCalls, 1);
  assert.strictEqual(reportedCause, publicationFailure);
});
