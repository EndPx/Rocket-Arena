import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROOM_POLICIES,
  serializeSnapshotEnvelopeV2,
  type RoomMode,
  type RosterEntry,
  type Team,
} from '@rocket-arena/shared';
import {
  SnapshotBuilder,
  type SnapshotBuildInput,
  type SnapshotCarBodyInput,
} from '../../server/src/systems/snapshot-builder.js';
import {
  decodeSnapshot,
  type DomainSnapshot,
} from '../src/networking/snapshot-validator.js';

function teamFor(index: number): Team {
  return index % 2 === 0 ? 'blue' : 'orange';
}

function roster(mode: RoomMode, count: number): readonly Readonly<RosterEntry>[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({
    sessionId: `transport-driver-${index}`,
    acceptedJoinOrdinal: index,
    team: teamFor(index),
    name: `Transport Driver ${index}`,
    isHost: mode === 'custom' && index === 0,
  })));
}

function carsFor(
  entries: readonly Readonly<RosterEntry>[],
): ReadonlyMap<string, Readonly<SnapshotCarBodyInput>> {
  return new Map(entries.map((entry, index) => [entry.sessionId, Object.freeze({
    position: Object.freeze([index, 0.5, -index] as const),
    rotation: Object.freeze([0, 0, 0, 1] as const),
    linearVelocity: Object.freeze([index / 10, 0, 0] as const),
    boost: 100 - index,
  })]));
}

function input(
  entries: readonly Readonly<RosterEntry>[],
  overrides: Partial<SnapshotBuildInput> = {},
): SnapshotBuildInput {
  return {
    serverTime: 10_000,
    simulationTime: 1_000,
    phase: 'playing',
    countdownKind: null,
    phaseSecondsRemaining: 0,
    regulationSecondsRemaining: 240,
    kickoffEpoch: 2,
    blueScore: 0,
    orangeScore: 0,
    winner: null,
    roster: entries,
    cars: carsFor(entries),
    ball: Object.freeze({
      position: Object.freeze([0, 0.9125, 0] as const),
      rotation: Object.freeze([0, 0, 0, 1] as const),
      linearVelocity: Object.freeze([0, 0, 0] as const),
    }),
    ...overrides,
  };
}

function decoded(
  payload: unknown,
  previousSnapshot?: Readonly<DomainSnapshot>,
): Readonly<DomainSnapshot> {
  const result = decodeSnapshot(payload, {
    roomMode: 'custom',
    ...(previousSnapshot === undefined ? {} : { previousSnapshot }),
  });
  assert.equal(result.ok, true, result.ok ? undefined : `${result.code}: ${result.message}`);
  if (!result.ok) throw new Error(result.message);
  return result.snapshot;
}

// Validates: Requirements 6.2-6.12, 18.17

test('maximum Custom V2 transport round-trips into the client and omits a disconnect', () => {
  const builder = new SnapshotBuilder({ policy: ROOM_POLICIES.custom });
  const fullRoster = roster('custom', 8);
  const fullWire = builder.build(input(fullRoster));
  const full = decoded(JSON.parse(serializeSnapshotEnvelopeV2(fullWire)));

  assert.equal(full.wireFormat, 'v2');
  assert.equal(full.roomMode, 'custom');
  assert.equal(full.cars.length, 8);
  assert.equal(new Set(full.cars.map((car) => car.sessionId)).size, 8);
  assert.equal(Object.isFrozen(full), true);

  const retainedRoster = fullRoster.filter((entry) => entry.sessionId !== 'transport-driver-3');
  const nextWire = builder.build(input(retainedRoster, {
    serverTime: 10_033,
    simulationTime: 1_016,
  }));
  const next = decoded(JSON.parse(serializeSnapshotEnvelopeV2(nextWire)), full);

  assert.equal(next.sequence, full.sequence + 1);
  assert.equal(next.cars.length, 7);
  assert.equal(next.cars.some((car) => car.sessionId === 'transport-driver-3'), false);
  assert.deepEqual(
    next.cars.map((car) => car.sessionId),
    retainedRoster.map((entry) => entry.sessionId),
  );
});

// Validates: Requirements 13.14, 13.19, 13.25

test('repeated terminal V2 transport preserves score, winner, reason, and event identity', () => {
  const builder = new SnapshotBuilder({ policy: ROOM_POLICIES.custom });
  const entries = roster('custom', 1);
  builder.commitTransition({
    kind: 'hard-cutoff',
    winner: 'blue',
    blueScore: 5,
    orangeScore: 4,
  });
  const ended = input(entries, {
    phase: 'ended',
    regulationSecondsRemaining: 0,
    blueScore: 5,
    orangeScore: 4,
    winner: 'blue',
  });
  const firstWire = builder.build(ended);
  const secondWire = builder.build({
    ...ended,
    serverTime: 10_033,
    simulationTime: 1_016,
  });
  const first = decoded(JSON.parse(serializeSnapshotEnvelopeV2(firstWire)));
  const second = decoded(JSON.parse(serializeSnapshotEnvelopeV2(secondWire)), first);

  assert.equal(second.sequence, first.sequence + 1);
  assert.equal(second.blueScore, first.blueScore);
  assert.equal(second.orangeScore, first.orangeScore);
  assert.equal(second.winner, first.winner);
  assert.deepEqual(second.terminalResult, first.terminalResult);
  assert.deepEqual(second.latestTransition, first.latestTransition);
  assert.equal(second.terminalResult?.reason, 'hard-regulation-cutoff');
  assert.equal(second.terminalResult?.eventId, second.latestTransition?.eventId);
});
