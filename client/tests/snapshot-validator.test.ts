import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOM_POLICIES, SNAPSHOT_PROTOCOL_VERSION } from '@rocket-arena/shared';
import {
  adaptLegacySnapshotV1,
  decodeSnapshot,
  hasFinalReleaseProtocolProof,
  type DomainSnapshot,
  type SnapshotValidationErrorCode,
  type SnapshotValidationResult,
} from '../src/networking/snapshot-validator.js';

type MutableRecord = Record<string, unknown>;

function makeCar(index: number, roomMode: 'quick' | 'custom', count: number): MutableRecord {
  const policy = ROOM_POLICIES[roomMode];
  const blueCount = Math.min(policy.teamCapacity, Math.ceil(count / 2));
  return {
    sessionId: `driver-${index}`,
    team: index < blueCount ? 'blue' : 'orange',
    name: `Driver ${index}`,
    isHost: roomMode === 'custom' && index === 0,
    position: [index + 0.5, 1, -index],
    rotation: [0, 0, 0, 2],
    linearVelocity: [index / 2, 0, -index / 3],
    boost: Math.min(100, index * 11),
  };
}

function makeV2(
  roomMode: 'quick' | 'custom',
  count = ROOM_POLICIES[roomMode].totalCapacity,
  sequence = 1,
): MutableRecord {
  const policy = ROOM_POLICIES[roomMode];
  return {
    protocolVersion: SNAPSHOT_PROTOCOL_VERSION,
    policyVersion: policy.version,
    roomMode,
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
    orangeScore: 1,
    winner: null,
    terminalResult: null,
    latestTransition: null,
    cars: Array.from({ length: count }, (_, index) => makeCar(index, roomMode, count)),
    ball: {
      position: [0, 0.9125, 0],
      rotation: [0, 0, 0, 4],
      linearVelocity: [0, 0, 0],
    },
  };
}

function makeLegacy(
  roomMode: 'quick' | 'custom',
  count = ROOM_POLICIES[roomMode].totalCapacity,
  sequence = 1,
): MutableRecord {
  const players = Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const car = makeCar(index, roomMode, count);
      const position = car.position as number[];
      const rotation = car.rotation as number[];
      const velocity = car.linearVelocity as number[];
      return [car.sessionId, {
        x: position[0],
        y: position[1],
        z: position[2],
        qx: rotation[0],
        qy: rotation[1],
        qz: rotation[2],
        qw: rotation[3],
        vx: velocity[0],
        vy: velocity[1],
        vz: velocity[2],
        boost: car.boost,
        team: car.team,
        name: car.name,
        isHost: car.isHost,
      }];
    }),
  );

  return {
    sequence,
    serverTime: 20_000 + sequence * 33,
    simulationTime: 2_000 + sequence * 16,
    players,
    ball: {
      x: 0,
      y: 0.9125,
      z: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 3,
      vx: 0,
      vy: 0,
      vz: 0,
    },
    blueScore: 2,
    orangeScore: 1,
    timeRemaining: 180,
    phase: 'playing',
  };
}

function terminalPayload(
  reason: 'regulation-target-and-margin' | 'hard-regulation-cutoff' | 'overtime-goal',
  eventId: number,
): {
  blueScore: number;
  orangeScore: number;
  winner: 'blue';
  terminalResult: MutableRecord;
  latestTransition: MutableRecord;
} {
  const blueScore = reason === 'regulation-target-and-margin' ? 6 : 5;
  const orangeScore = reason === 'regulation-target-and-margin' ? 4 : 4;
  const goal = reason === 'hard-regulation-cutoff'
    ? null
    : {
        eventId,
        team: 'blue',
        kickoffEpoch: 2,
        blueScore,
        orangeScore,
      };
  const terminalResult: MutableRecord = {
    eventId,
    reason,
    winner: 'blue',
    blueScore,
    orangeScore,
    goal,
  };
  const kind = reason === 'hard-regulation-cutoff'
    ? 'hard-cutoff'
    : reason === 'overtime-goal'
      ? 'overtime-terminal-goal'
      : 'regulation-terminal-goal';
  return {
    blueScore,
    orangeScore,
    winner: 'blue',
    terminalResult,
    latestTransition: {
      eventId,
      kind,
      goal,
      terminal: terminalResult,
    },
  };
}

function makeEndedV2(
  reason: 'regulation-target-and-margin' | 'hard-regulation-cutoff' | 'overtime-goal',
  eventId: number,
  sequence: number,
): MutableRecord {
  const terminal = terminalPayload(reason, eventId);
  return {
    ...makeV2('custom', 8, sequence),
    phase: 'ended',
    regulationSecondsRemaining: reason === 'regulation-target-and-margin' ? 30 : 0,
    ...terminal,
  };
}

function accepted(result: SnapshotValidationResult): Readonly<DomainSnapshot> {
  if (!result.ok) {
    assert.fail(`expected acceptance, received ${result.error.code}: ${result.error.message}`);
  }
  return result.snapshot;
}

function rejected(
  result: SnapshotValidationResult,
  expectedCode: SnapshotValidationErrorCode,
): void {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail('expected rejection');
  assert.equal(result.error.code, expectedCode, result.error.message);
}

test('accepts immutable maximum-capacity V2 snapshots for Quick and Custom rooms', () => {
  for (const roomMode of ['quick', 'custom'] as const) {
    const payload = makeV2(roomMode);
    const before = structuredClone(payload);
    const snapshot = accepted(decodeSnapshot(payload, { roomMode }));
    const policy = ROOM_POLICIES[roomMode];

    assert.equal(snapshot.wireFormat, 'v2');
    assert.equal(snapshot.protocolVersion, 2);
    assert.equal(snapshot.cars.length, policy.totalCapacity);
    assert.equal(snapshot.totalCapacity, policy.totalCapacity);
    assert.equal(snapshot.teamCapacity, policy.teamCapacity);
    assert.equal(new Set(snapshot.cars.map((car) => car.sessionId)).size, policy.totalCapacity);
    assert.equal(hasFinalReleaseProtocolProof(snapshot), true);
    assert.equal(snapshot.validationEvidence.duplicateIdentityProof, true);
    assert.equal(snapshot.validationEvidence.terminalEventIdentityProof, true);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.cars), true);
    assert.equal(Object.isFrozen(snapshot.cars[0]), true);
    assert.equal(Object.isFrozen(snapshot.ball.rotation), true);
    assert.deepEqual(payload, before, 'decoding must not mutate the wire payload');
  }
});

test('rejects duplicate, over-capacity, policy, room-mode, team, phase, and version errors', () => {
  const duplicate = makeV2('quick');
  const duplicateCars = duplicate.cars as MutableRecord[];
  duplicateCars[5] = structuredClone(duplicateCars[0]);
  rejected(decodeSnapshot(duplicate, { roomMode: 'quick' }), 'duplicate-identity');

  const overCapacity = makeV2('quick');
  (overCapacity.cars as MutableRecord[]).push({
    ...makeCar(6, 'quick', 7),
    sessionId: 'driver-extra',
  });
  rejected(decodeSnapshot(overCapacity, { roomMode: 'quick' }), 'capacity-exceeded');

  rejected(
    decodeSnapshot({ ...makeV2('quick'), totalCapacity: 8 }, { roomMode: 'quick' }),
    'policy-mismatch',
  );
  rejected(decodeSnapshot(makeV2('quick'), { roomMode: 'custom' }), 'room-mode-mismatch');

  const invalidTeam = makeV2('quick');
  (invalidTeam.cars as MutableRecord[])[0].team = 'green';
  rejected(decodeSnapshot(invalidTeam, { roomMode: 'quick' }), 'invalid-team');

  rejected(
    decodeSnapshot({ ...makeV2('quick'), phase: 'goal-scored' }, { roomMode: 'quick' }),
    'invalid-phase',
  );
  rejected(
    decodeSnapshot(
      { ...makeV2('quick'), phase: 'countdown', countdownKind: null },
      { roomMode: 'quick' },
    ),
    'invalid-phase',
  );
  rejected(
    decodeSnapshot({ ...makeV2('quick'), protocolVersion: 3 }, { roomMode: 'quick' }),
    'unsupported-protocol-version',
  );

  const missingCustomHost = makeV2('custom');
  missingCustomHost.phase = 'waiting';
  for (const car of missingCustomHost.cars as MutableRecord[]) car.isHost = false;
  rejected(decodeSnapshot(missingCustomHost, { roomMode: 'custom' }), 'policy-mismatch');
});

test('rejects non-finite numbers and invalid quaternions, then normalizes valid rotations', () => {
  const nonFinitePosition = makeV2('quick');
  (nonFinitePosition.cars as MutableRecord[])[0].position = [Number.NaN, 0, 0];
  rejected(decodeSnapshot(nonFinitePosition, { roomMode: 'quick' }), 'non-finite-number');

  rejected(
    decodeSnapshot(
      { ...makeV2('quick'), regulationSecondsRemaining: Number.POSITIVE_INFINITY },
      { roomMode: 'quick' },
    ),
    'non-finite-number',
  );

  const zeroRotation = makeV2('quick');
  (zeroRotation.cars as MutableRecord[])[0].rotation = [0, 0, 0, 0];
  rejected(decodeSnapshot(zeroRotation, { roomMode: 'quick' }), 'invalid-quaternion');

  const payload = makeV2('quick');
  const snapshot = accepted(decodeSnapshot(payload, { roomMode: 'quick' }));
  for (const rotation of [snapshot.ball.rotation, ...snapshot.cars.map((car) => car.rotation)]) {
    assert.ok(Math.abs(Math.hypot(...rotation) - 1) < 1e-12);
  }
  assert.deepEqual((payload.cars as MutableRecord[])[0].rotation, [0, 0, 0, 2]);
  assert.deepEqual((payload.ball as MutableRecord).rotation, [0, 0, 0, 4]);
  assert.throws(() => {
    (snapshot.cars[0].rotation as unknown as number[])[3] = 99;
  }, TypeError);
});

test('accepts coherent terminal reasons and rejects incomplete or incoherent Ended_State data', () => {
  for (const [reason, eventId] of [
    ['regulation-target-and-margin', 31],
    ['hard-regulation-cutoff', 32],
    ['overtime-goal', 33],
  ] as const) {
    const snapshot = accepted(decodeSnapshot(makeEndedV2(reason, eventId, eventId), {
      roomMode: 'custom',
    }));
    assert.equal(snapshot.phase, 'ended');
    assert.equal(snapshot.terminalResult?.reason, reason);
    assert.equal(snapshot.latestTransition?.eventId, eventId);
    assert.deepEqual(snapshot.latestTransition?.terminal, snapshot.terminalResult);
  }

  rejected(
    decodeSnapshot({ ...makeEndedV2('hard-regulation-cutoff', 40, 40), winner: null }, {
      roomMode: 'custom',
    }),
    'terminal-coherence',
  );
  rejected(
    decodeSnapshot({ ...makeEndedV2('hard-regulation-cutoff', 41, 41), blueScore: 6 }, {
      roomMode: 'custom',
    }),
    'terminal-coherence',
  );

  const wrongEvent = makeEndedV2('overtime-goal', 42, 42);
  (wrongEvent.latestTransition as MutableRecord).eventId = 999;
  rejected(decodeSnapshot(wrongEvent, { roomMode: 'custom' }), 'terminal-coherence');

  const invalidMargin = makeEndedV2('regulation-target-and-margin', 43, 43);
  invalidMargin.orangeScore = 5;
  const terminal = invalidMargin.terminalResult as MutableRecord;
  terminal.orangeScore = 5;
  const goal = terminal.goal as MutableRecord;
  goal.orangeScore = 5;
  const transition = invalidMargin.latestTransition as MutableRecord;
  (transition.goal as MutableRecord).orangeScore = 5;
  (transition.terminal as MutableRecord).orangeScore = 5;
  rejected(decodeSnapshot(invalidMargin, { roomMode: 'custom' }), 'terminal-coherence');

  const terminalDuringPlay = makeV2('custom');
  const cutoff = terminalPayload('hard-regulation-cutoff', 50);
  terminalDuringPlay.latestTransition = cutoff.latestTransition;
  terminalDuringPlay.blueScore = cutoff.blueScore;
  terminalDuringPlay.orangeScore = cutoff.orangeScore;
  rejected(decodeSnapshot(terminalDuringPlay, { roomMode: 'custom' }), 'terminal-coherence');
});

test('requires repeated snapshots of one terminal event to retain the same immutable payload', () => {
  const first = accepted(decodeSnapshot(makeEndedV2('hard-regulation-cutoff', 70, 10), {
    roomMode: 'custom',
  }));
  const repeatedPayload = makeEndedV2('hard-regulation-cutoff', 70, 11);
  repeatedPayload.simulationTime = first.simulationTime;
  const repeated = accepted(decodeSnapshot(repeatedPayload, {
    roomMode: 'custom',
    previousSnapshot: first,
  }));

  assert.equal(repeated.latestTransition?.eventId, 70);
  assert.deepEqual(repeated.terminalResult, first.terminalResult);
  assert.equal(Object.isFrozen(repeated.terminalResult), true);

  rejected(
    decodeSnapshot(makeEndedV2('hard-regulation-cutoff', 71, 12), {
      roomMode: 'custom',
      previousSnapshot: repeated,
    }),
    'terminal-payload-changed',
  );
  rejected(
    decodeSnapshot(makeV2('custom', 8, 13), {
      roomMode: 'custom',
      previousSnapshot: repeated,
    }),
    'terminal-payload-changed',
  );
});

test('temporary LegacySnapshotV1 adapter derives policy but exposes no final-release proof', () => {
  for (const roomMode of ['quick', 'custom'] as const) {
    const payload = makeLegacy(roomMode);
    const before = structuredClone(payload);
    const snapshot = accepted(adaptLegacySnapshotV1(payload, { roomMode }));
    const policy = ROOM_POLICIES[roomMode];

    assert.equal(snapshot.wireFormat, 'legacy-v1');
    assert.equal(snapshot.protocolVersion, 1);
    assert.equal(snapshot.roomMode, roomMode);
    assert.equal(snapshot.totalCapacity, policy.totalCapacity);
    assert.equal(snapshot.teamCapacity, policy.teamCapacity);
    assert.equal(snapshot.cars.length, policy.totalCapacity);
    assert.equal(snapshot.validationEvidence.duplicateIdentityProof, false);
    assert.equal(snapshot.validationEvidence.terminalEventIdentityProof, false);
    assert.equal(hasFinalReleaseProtocolProof(snapshot), false);
    assert.ok(Math.abs(Math.hypot(...snapshot.ball.rotation) - 1) < 1e-12);
    assert.deepEqual(payload, before);
  }

  const countdown = makeLegacy('quick', 6, 5);
  countdown.phase = 'countdown';
  countdown.timeRemaining = 2.25;
  const countdownSnapshot = accepted(decodeSnapshot(countdown, { roomMode: 'quick' }));
  assert.equal(countdownSnapshot.phaseSecondsRemaining, 2.25);
  assert.equal(countdownSnapshot.regulationSecondsRemaining, 0);

  const nonFinite = makeLegacy('quick');
  const firstPlayer = Object.values(nonFinite.players as MutableRecord)[0] as MutableRecord;
  firstPlayer.vx = Number.NEGATIVE_INFINITY;
  rejected(decodeSnapshot(nonFinite, { roomMode: 'quick' }), 'non-finite-number');

  rejected(
    decodeSnapshot({ ...makeLegacy('quick'), phase: 'ended' }, { roomMode: 'quick' }),
    'legacy-terminal-unverifiable',
  );
});

test('mixed-version migration permits one V1-to-V2 upgrade and enforces stream sequence rules', () => {
  const legacy = makeLegacy('quick', 6, 10);
  legacy.simulationTime = 1_000;
  const first = accepted(decodeSnapshot(legacy, { roomMode: 'quick' }));

  const duplicateSequence = makeLegacy('quick', 6, 10);
  duplicateSequence.simulationTime = 1_001;
  rejected(
    decodeSnapshot(duplicateSequence, { roomMode: 'quick', previousSnapshot: first }),
    'sequence-regression',
  );

  const regressedTime = makeLegacy('quick', 6, 11);
  regressedTime.simulationTime = 999;
  rejected(
    decodeSnapshot(regressedTime, { roomMode: 'quick', previousSnapshot: first }),
    'simulation-time-regression',
  );

  const v2 = makeV2('quick', 6, 11);
  v2.simulationTime = 1_001;
  const upgraded = accepted(decodeSnapshot(v2, {
    roomMode: 'quick',
    previousSnapshot: first,
  }));
  assert.equal(upgraded.wireFormat, 'v2');

  const downgrade = makeLegacy('quick', 6, 12);
  downgrade.simulationTime = 1_002;
  rejected(
    decodeSnapshot(downgrade, { roomMode: 'quick', previousSnapshot: upgraded }),
    'protocol-downgrade',
  );

  rejected(
    decodeSnapshot({ ...makeV2('quick'), players: {} }, { roomMode: 'quick' }),
    'mixed-protocol-payload',
  );
  const unversionedV2 = makeV2('quick');
  delete unversionedV2.protocolVersion;
  rejected(decodeSnapshot(unversionedV2, { roomMode: 'quick' }), 'mixed-protocol-payload');
});
