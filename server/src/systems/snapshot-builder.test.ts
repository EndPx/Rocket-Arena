import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROOM_POLICIES,
  assertStableTerminalSnapshots,
  deserializeSnapshotEnvelopeV2,
  serializeSnapshotEnvelopeV2,
  type RoomMode,
  type RosterEntry,
  type SnapshotEnvelopeV2,
  type Team,
} from '@rocket-arena/shared';
import {
  SNAPSHOT_FIELD_BOUNDS,
  SnapshotBuildError,
  SnapshotBuilder,
  type SnapshotBallBodyInput,
  type SnapshotBuildInput,
  type SnapshotCarBodyInput,
  type SnapshotGoalTransitionInput,
} from './snapshot-builder.js';

function teamFor(index: number): Team {
  return index % 2 === 0 ? 'blue' : 'orange';
}

function makeRoster(mode: RoomMode, count: number): readonly Readonly<RosterEntry>[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({
    sessionId: `driver-${index}`,
    acceptedJoinOrdinal: index,
    team: teamFor(index),
    name: `Driver ${index}`,
    isHost: mode === 'custom' && index === 0,
  })));
}

function makeCar(index: number): Readonly<SnapshotCarBodyInput> {
  return Object.freeze({
    position: Object.freeze([index + 0.25, 1 + index / 10, -index - 0.5] as const),
    rotation: Object.freeze([0, index / 100, 0, 1] as const),
    linearVelocity: Object.freeze([index / 2, index === 0 ? 0 : -index / 4, index] as const),
    boost: index * 10 + 0.5,
  });
}

function makeCars(
  roster: readonly Readonly<RosterEntry>[],
): ReadonlyMap<string, Readonly<SnapshotCarBodyInput>> {
  return new Map([...roster].reverse().map((entry) => {
    const index = Number(entry.sessionId.split('-')[1] ?? 0);
    return [entry.sessionId, makeCar(index)];
  }));
}

const BALL: Readonly<SnapshotBallBodyInput> = Object.freeze({
  position: Object.freeze([0, 0.9125, 0] as const),
  rotation: Object.freeze([0, 0, 0, 1] as const),
  linearVelocity: Object.freeze([0, 0, 0] as const),
});

function makeInput(
  mode: RoomMode,
  count: number,
  overrides: Partial<SnapshotBuildInput> = {},
): SnapshotBuildInput {
  const roster = overrides.roster ?? makeRoster(mode, count);
  return {
    serverTime: 10_000,
    simulationTime: 1_000,
    phase: 'playing',
    countdownKind: null,
    phaseSecondsRemaining: 0,
    regulationSecondsRemaining: 240,
    kickoffEpoch: 3,
    blueScore: 0,
    orangeScore: 0,
    winner: null,
    ball: BALL,
    ...overrides,
    roster,
    cars: overrides.cars ?? makeCars(roster),
  };
}

function assertAllNumbersFinite(value: unknown): void {
  if (typeof value === 'number') {
    assert.equal(Number.isFinite(value), true, `expected finite number, received ${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) assertAllNumbersFinite(child);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) assertAllNumbersFinite(child);
  }
}

function magnitude(vector: readonly [number, number, number]): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function terminalGoal(
  blueScore: number,
  orangeScore: number,
  team: Team = 'blue',
): SnapshotGoalTransitionInput {
  return { team, kickoffEpoch: 3, blueScore, orangeScore };
}

// **Validates: Requirements 6.1-6.3, 6.6**
test('builds zero-through-capacity snapshots with strict room-local sequences', () => {
  for (const mode of ['quick', 'custom'] as const) {
    const policy = ROOM_POLICIES[mode];
    const builder = new SnapshotBuilder({ policy });
    const sequences: number[] = [];

    for (let count = 0; count <= policy.totalCapacity; count += 1) {
      const snapshot = builder.build(makeInput(mode, count, {
        serverTime: 10_000 + count * 33,
        simulationTime: 1_000 + count * 16,
      }));
      sequences.push(snapshot.sequence);
      assert.equal(snapshot.cars.length, count);
      assert.equal(new Set(snapshot.cars.map(({ sessionId }) => sessionId)).size, count);
      assert.ok(snapshot.cars.length <= 8);
      assert.equal(snapshot.totalCapacity, policy.totalCapacity);
      assert.equal(snapshot.teamCapacity, policy.teamCapacity);
    }

    assert.deepEqual(
      sequences,
      Array.from({ length: policy.totalCapacity + 1 }, (_, index) => index),
    );
    assert.equal(builder.nextSnapshotSequence, policy.totalCapacity + 1);
  }
});

// **Validates: Requirements 6.2-6.4, 18.17**
test('maximum Custom snapshot round trip preserves eight identity-associated fields and Host metadata', () => {
  const roster = makeRoster('custom', 8);
  const sourceCars = makeCars(roster);
  const builder = new SnapshotBuilder({ policy: ROOM_POLICIES.custom });
  const snapshot = builder.build(makeInput('custom', 8, { roster, cars: sourceCars }));
  const decoded = deserializeSnapshotEnvelopeV2(serializeSnapshotEnvelopeV2(snapshot));

  assert.equal(decoded.cars.length, 8);
  assert.equal(new Set(decoded.cars.map(({ sessionId }) => sessionId)).size, 8);
  assert.equal(decoded.cars.filter(({ isHost }) => isHost).length, 1);
  assert.equal(decoded.cars.find(({ isHost }) => isHost)?.sessionId, 'driver-0');

  for (const entry of roster) {
    const decodedCar = decoded.cars.find(({ sessionId }) => sessionId === entry.sessionId);
    const source = sourceCars.get(entry.sessionId);
    assert.ok(decodedCar && source);
    assert.equal(decodedCar.team, entry.team);
    assert.equal(decodedCar.name, entry.name);
    assert.equal(decodedCar.isHost, entry.isHost);
    assert.deepEqual(decodedCar.position, source.position);
    assert.deepEqual(decodedCar.linearVelocity, source.linearVelocity);
    assert.equal(decodedCar.boost, source.boost);
    assert.ok(Math.abs(Math.hypot(...decodedCar.rotation) - 1) < 1e-12);
  }
  assertAllNumbersFinite(decoded);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.cars), true);
  assert.equal(Object.isFrozen(snapshot.cars[0]), true);
});

// **Validates: Requirements 6.3, 6.5**
test('a disconnected identity is omitted from the very next snapshot without disturbing others', () => {
  const builder = new SnapshotBuilder({ policy: ROOM_POLICIES.custom });
  const fullRoster = makeRoster('custom', 8);
  const first = builder.build(makeInput('custom', 8, {
    roster: fullRoster,
    cars: makeCars(fullRoster),
  }));

  const remainingRoster = Object.freeze(fullRoster.filter(({ sessionId }) => sessionId !== 'driver-3'));
  const remainingCars = new Map(makeCars(fullRoster));
  remainingCars.delete('driver-3');
  const next = builder.build(makeInput('custom', 7, {
    serverTime: 10_033,
    simulationTime: 1_016,
    roster: remainingRoster,
    cars: remainingCars,
  }));

  assert.equal(first.cars.length, 8);
  assert.equal(next.cars.length, 7);
  assert.equal(next.cars.some(({ sessionId }) => sessionId === 'driver-3'), false);
  assert.deepEqual(
    next.cars.map(({ sessionId }) => sessionId),
    remainingRoster.map(({ sessionId }) => sessionId),
  );
});

// **Validates: Requirements 6.3, 6.6**
test('Stable_Roster_Order is deterministic across roster and car insertion order', () => {
  const roster = Object.freeze([
    Object.freeze({ sessionId: 'zeta', acceptedJoinOrdinal: 2, team: 'orange', name: 'Z', isHost: false }),
    Object.freeze({ sessionId: 'beta', acceptedJoinOrdinal: 1, team: 'orange', name: 'B', isHost: false }),
    Object.freeze({ sessionId: 'alpha', acceptedJoinOrdinal: 1, team: 'blue', name: 'A', isHost: true }),
    Object.freeze({ sessionId: 'gamma', acceptedJoinOrdinal: 0, team: 'blue', name: 'G', isHost: false }),
  ] satisfies readonly RosterEntry[]);
  const cars = new Map<string, Readonly<SnapshotCarBodyInput>>([
    ['beta', makeCar(1)],
    ['gamma', makeCar(3)],
    ['zeta', makeCar(2)],
    ['alpha', makeCar(0)],
  ]);
  const expected = ['gamma', 'alpha', 'beta', 'zeta'];

  const first = new SnapshotBuilder({ policy: ROOM_POLICIES.custom }).build(
    makeInput('custom', 4, { roster, cars }),
  );
  const second = new SnapshotBuilder({ policy: ROOM_POLICIES.custom }).build(
    makeInput('custom', 4, {
      roster: Object.freeze([...roster].reverse()),
      cars: new Map([...cars].reverse()),
    }),
  );

  assert.deepEqual(first.cars.map(({ sessionId }) => sessionId), expected);
  assert.deepEqual(second.cars.map(({ sessionId }) => sessionId), expected);
  assert.deepEqual(first.cars, second.cars);
});

// **Validates: Requirements 6.7**
test('recovers non-finite fields, clamps world/inventory bounds, and caps motion magnitudes', () => {
  const builder = new SnapshotBuilder({ policy: ROOM_POLICIES.custom });
  const initial = builder.build(makeInput('custom', 1));
  const roster = makeRoster('custom', 2);
  const cars = new Map(makeCars(roster));
  cars.set('driver-0', {
    position: [Number.NaN, Number.POSITIVE_INFINITY, 999],
    rotation: [0, 0, 0, 0],
    linearVelocity: [Number.NaN, 999, -999],
    boost: Number.NaN,
  });
  cars.set('driver-1', {
    position: [Number.NaN, Number.NaN, Number.NaN],
    rotation: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
    linearVelocity: [Number.POSITIVE_INFINITY, Number.NaN, Number.NEGATIVE_INFINITY],
    boost: Number.POSITIVE_INFINITY,
  });
  const recovered = builder.build(makeInput('custom', 2, {
    serverTime: Number.NaN,
    simulationTime: Number.POSITIVE_INFINITY,
    regulationSecondsRemaining: Number.NaN,
    roster,
    cars,
    ball: {
      position: [999, Number.NaN, -999],
      rotation: [0, 0, 0, 0],
      linearVelocity: [999, 999, 999],
    },
  }));

  const retained = recovered.cars.find(({ sessionId }) => sessionId === 'driver-0');
  const fallback = recovered.cars.find(({ sessionId }) => sessionId === 'driver-1');
  assert.ok(retained && fallback);
  assert.equal(retained.position[0], initial.cars[0]?.position[0]);
  assert.equal(retained.position[1], initial.cars[0]?.position[1]);
  assert.equal(retained.position[2], SNAPSHOT_FIELD_BOUNDS.position.max[2]);
  assert.equal(retained.boost, initial.cars[0]?.boost);
  assert.deepEqual(fallback.position, [0, 0, 0]);
  assert.deepEqual(fallback.rotation, [0, 0, 0, 1]);
  assert.deepEqual(fallback.linearVelocity, [0, 0, 0]);
  assert.equal(fallback.boost, 0);
  assert.ok(magnitude(retained.linearVelocity) <= SNAPSHOT_FIELD_BOUNDS.carLinearSpeed + 1e-12);
  assert.ok(magnitude(recovered.ball.linearVelocity) <= SNAPSHOT_FIELD_BOUNDS.ballLinearSpeed + 1e-12);
  assert.equal(recovered.ball.position[0], SNAPSHOT_FIELD_BOUNDS.position.max[0]);
  assert.equal(recovered.ball.position[2], SNAPSHOT_FIELD_BOUNDS.position.min[2]);
  assert.equal(recovered.serverTime, initial.serverTime);
  assert.equal(recovered.simulationTime, initial.simulationTime);
  assert.equal(recovered.regulationSecondsRemaining, initial.regulationSecondsRemaining);
  assertAllNumbersFinite(recovered);
});

// **Validates: Requirements 6.1-6.3**
test('fails atomically before broadcast on count, identity, team, and Host mismatch', () => {
  const builder = new SnapshotBuilder({ policy: ROOM_POLICIES.custom });
  const roster = makeRoster('custom', 2);
  const missingCar = new Map(makeCars(roster));
  missingCar.delete('driver-1');

  assert.throws(
    () => builder.build(makeInput('custom', 2, { roster, cars: missingCar })),
    (error: unknown) => error instanceof SnapshotBuildError && error.code === 'count-mismatch',
  );

  const wrongIdentity = new Map(makeCars(roster));
  wrongIdentity.delete('driver-1');
  wrongIdentity.set('outsider', makeCar(7));
  assert.throws(
    () => builder.build(makeInput('custom', 2, { roster, cars: wrongIdentity })),
    (error: unknown) => error instanceof SnapshotBuildError && error.code === 'identity-mismatch',
  );

  const overTeamRoster = Object.freeze(Array.from({ length: 5 }, (_, index) => Object.freeze({
    sessionId: `blue-${index}`,
    acceptedJoinOrdinal: index,
    team: 'blue' as const,
    name: `Blue ${index}`,
    isHost: index === 0,
  })));
  const overTeamCars = new Map(overTeamRoster.map((entry, index) => [entry.sessionId, makeCar(index)]));
  assert.throws(
    () => builder.build(makeInput('custom', 5, {
      roster: overTeamRoster,
      cars: overTeamCars,
    })),
    (error: unknown) => error instanceof SnapshotBuildError && error.code === 'count-mismatch',
  );

  const missingHostRoster = Object.freeze(roster.map((entry) => Object.freeze({ ...entry, isHost: false })));
  assert.throws(
    () => builder.build(makeInput('custom', 2, {
      roster: missingHostRoster,
      cars: makeCars(missingHostRoster),
    })),
    (error: unknown) => error instanceof SnapshotBuildError && error.code === 'invalid-roster',
  );

  const valid = builder.build(makeInput('custom', 2));
  assert.equal(valid.sequence, 0, 'failed candidates must not consume snapshot sequence numbers');
});

// **Validates: Requirements 6.6, 13.14**
test('snapshot and transition sequences increase independently and emission never creates events', () => {
  const builder = new SnapshotBuilder({ policy: ROOM_POLICIES.custom });
  const baseline = builder.build(makeInput('custom', 1));
  assert.equal(baseline.sequence, 0);
  assert.equal(baseline.latestTransition, null);
  assert.equal(builder.transitionSequence, 0);

  const countdown = builder.commitTransition({ kind: 'countdown' });
  const countdownSnapshot = builder.build(makeInput('custom', 1, {
    serverTime: 10_033,
    simulationTime: 1_016,
    phase: 'countdown',
    countdownKind: 'initial',
    phaseSecondsRemaining: 3,
  }));
  const repeatedCountdown = builder.build(makeInput('custom', 1, {
    serverTime: 10_066,
    simulationTime: 1_032,
    phase: 'countdown',
    countdownKind: 'initial',
    phaseSecondsRemaining: 2.5,
  }));

  assert.equal(countdown.eventId, 1);
  assert.equal(countdownSnapshot.latestTransition?.eventId, 1);
  assert.equal(repeatedCountdown.latestTransition?.eventId, 1);
  assert.equal(builder.transitionSequence, 1);

  const goalReset = builder.commitTransition({
    kind: 'regulation-goal-reset',
    goal: terminalGoal(1, 0),
  });
  const goalSnapshot = builder.build(makeInput('custom', 1, {
    serverTime: 10_099,
    simulationTime: 1_048,
    phase: 'goal-reset',
    phaseSecondsRemaining: 2,
    blueScore: 1,
  }));

  assert.equal(goalReset.eventId, 2);
  assert.equal(goalSnapshot.latestTransition?.eventId, 2);
  assert.deepEqual(
    [baseline.sequence, countdownSnapshot.sequence, repeatedCountdown.sequence, goalSnapshot.sequence],
    [0, 1, 2, 3],
  );
  assert.equal(builder.transitionSequence, 2);
});

// **Validates: Requirements 13.14, 13.19, 13.25**
test('projects coherent terminal score, winner, reason, goal, and transition IDs', () => {
  const cases = [
    {
      kind: 'regulation-terminal-goal' as const,
      goal: terminalGoal(6, 4),
      blueScore: 6,
      orangeScore: 4,
      regulationSecondsRemaining: 10,
      reason: 'regulation-target-and-margin',
      transitionKind: 'regulation-terminal-goal',
    },
    {
      kind: 'hard-cutoff' as const,
      goal: null,
      blueScore: 5,
      orangeScore: 4,
      regulationSecondsRemaining: 0,
      reason: 'hard-regulation-cutoff',
      transitionKind: 'hard-cutoff',
    },
    {
      kind: 'overtime-terminal-goal' as const,
      goal: terminalGoal(3, 2),
      blueScore: 3,
      orangeScore: 2,
      regulationSecondsRemaining: 0,
      reason: 'overtime-goal',
      transitionKind: 'overtime-terminal-goal',
    },
  ] as const;

  for (const terminalCase of cases) {
    const builder = new SnapshotBuilder({ policy: ROOM_POLICIES.custom });
    if (terminalCase.kind === 'hard-cutoff') {
      builder.commitTransition({
        kind: terminalCase.kind,
        winner: 'blue',
        blueScore: terminalCase.blueScore,
        orangeScore: terminalCase.orangeScore,
      });
    } else {
      builder.commitTransition({ kind: terminalCase.kind, goal: terminalCase.goal });
    }

    const snapshot = builder.build(makeInput('custom', 1, {
      phase: 'ended',
      regulationSecondsRemaining: terminalCase.regulationSecondsRemaining,
      kickoffEpoch: 3,
      blueScore: terminalCase.blueScore,
      orangeScore: terminalCase.orangeScore,
      winner: 'blue',
    }));

    assert.equal(snapshot.terminalResult?.reason, terminalCase.reason);
    assert.equal(snapshot.terminalResult?.winner, snapshot.winner);
    assert.equal(snapshot.terminalResult?.blueScore, snapshot.blueScore);
    assert.equal(snapshot.terminalResult?.orangeScore, snapshot.orangeScore);
    assert.equal(snapshot.latestTransition?.kind, terminalCase.transitionKind);
    assert.equal(snapshot.latestTransition?.eventId, snapshot.terminalResult?.eventId);
    assert.deepEqual(snapshot.latestTransition?.terminal, snapshot.terminalResult);
  }

  const invalidRegulation = new SnapshotBuilder({ policy: ROOM_POLICIES.custom });
  assert.throws(
    () => invalidRegulation.commitTransition({
      kind: 'regulation-terminal-goal',
      goal: terminalGoal(6, 5),
    }),
    (error: unknown) => error instanceof SnapshotBuildError && error.code === 'invalid-transition',
  );
  assert.equal(invalidRegulation.transitionSequence, 0);

  const mismatch = new SnapshotBuilder({ policy: ROOM_POLICIES.custom });
  mismatch.commitTransition({
    kind: 'hard-cutoff',
    winner: 'blue',
    blueScore: 5,
    orangeScore: 4,
  });
  assert.throws(
    () => mismatch.build(makeInput('custom', 1, {
      phase: 'ended',
      regulationSecondsRemaining: 0,
      blueScore: 6,
      orangeScore: 4,
      winner: 'blue',
    })),
    (error: unknown) => error instanceof SnapshotBuildError && error.code === 'invalid-match-state',
  );
  assert.equal(mismatch.nextSnapshotSequence, 0);
});

// **Validates: Requirements 13.14, 13.19, 13.25**
test('repeated Ended_State snapshots preserve one immutable terminal event ID', () => {
  const builder = new SnapshotBuilder({ policy: ROOM_POLICIES.custom });
  const transition = builder.commitTransition({
    kind: 'hard-cutoff',
    winner: 'blue',
    blueScore: 5,
    orangeScore: 4,
  });
  const endedInput = makeInput('custom', 1, {
    phase: 'ended',
    regulationSecondsRemaining: 0,
    kickoffEpoch: 3,
    blueScore: 5,
    orangeScore: 4,
    winner: 'blue',
  });
  const first = builder.build(endedInput);
  const second = builder.build({
    ...endedInput,
    serverTime: endedInput.serverTime + 33,
    simulationTime: endedInput.simulationTime + 16,
  });

  assert.equal(transition.eventId, 1);
  assert.equal(first.sequence, 0);
  assert.equal(second.sequence, 1);
  assert.equal(first.latestTransition?.eventId, 1);
  assert.equal(second.latestTransition?.eventId, 1);
  assert.deepEqual(second.latestTransition, first.latestTransition);
  assert.deepEqual(second.terminalResult, first.terminalResult);
  assert.doesNotThrow(() => assertStableTerminalSnapshots(first, second));
  assert.equal(builder.transitionSequence, 1);
  assert.throws(
    () => builder.commitTransition({ kind: 'countdown' }),
    (error: unknown) => (
      error instanceof SnapshotBuildError && error.code === 'transition-after-terminal'
    ),
  );

  const decoded: Readonly<SnapshotEnvelopeV2> = deserializeSnapshotEnvelopeV2(
    serializeSnapshotEnvelopeV2(second),
  );
  assert.equal(decoded.latestTransition?.eventId, 1);
  assert.equal(decoded.terminalResult?.reason, 'hard-regulation-cutoff');
});
