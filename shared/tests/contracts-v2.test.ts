import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOM_POLICIES } from '../src/config/room-policies.js';
import {
  GameState,
  PlayerState,
} from '../src/schema/index.js';
import {
  INPUT_PROTOCOL_VERSION,
  InputContractError,
  isInputCommandV2,
  normalizeInputCommandV2,
} from '../src/types/input.js';
import {
  createGoalResult,
  createTerminalResult,
  type GoalResult,
  type TerminalResult,
} from '../src/types/room.js';
import {
  SNAPSHOT_PROTOCOL_VERSION,
  SnapshotContractError,
  assertStableTerminalSnapshots,
  deserializeSnapshotEnvelopeV2,
  isSnapshotEnvelopeV2,
  parseSnapshotEnvelopeV2,
  serializeSnapshotEnvelopeV2,
  type CarSnapshot,
  type MatchTransitionSnapshot,
} from '../src/types/snapshot.js';

const baseInput = Object.freeze({
  protocolVersion: INPUT_PROTOCOL_VERSION,
  throttle: 0.75,
  steer: -0.5,
  pitch: 0.25,
  yaw: -0.25,
  roll: 0.5,
  jumpHeld: true,
  jumpSequence: 8,
  boostHeld: true,
  powerslideHeld: false,
  cameraToggleSequence: 5,
});

function makeCars(): readonly CarSnapshot[] {
  return Object.freeze(Array.from({ length: 8 }, (_, index): CarSnapshot => Object.freeze({
    sessionId: `session-${index}`,
    team: index < 4 ? 'blue' : 'orange',
    name: `Driver ${index}`,
    isHost: index === 0,
    position: Object.freeze([index + 0.25, 1 + index / 10, -index - 0.5] as const),
    rotation: Object.freeze([0, index / 100, 0, 1] as const),
    linearVelocity: Object.freeze([index / 2, index === 0 ? 0 : -index / 4, index * 1.5] as const),
    boost: index * 10 + 0.5,
  })));
}

function makeGoal(eventId = 41, team: 'blue' | 'orange' = 'blue'): Readonly<GoalResult> {
  return createGoalResult({
    eventId,
    team,
    kickoffEpoch: 3,
    blueScore: team === 'blue' ? 6 : 4,
    orangeScore: team === 'orange' ? 6 : 4,
  });
}

function makeTerminal(
  eventId = 41,
  reason: TerminalResult['reason'] = 'regulation-target-and-margin',
): Readonly<TerminalResult> {
  if (reason === 'hard-regulation-cutoff') {
    return createTerminalResult({
      eventId,
      reason,
      winner: 'blue',
      blueScore: 5,
      orangeScore: 4,
      goal: null,
    });
  }

  const goal = makeGoal(eventId, 'blue');
  return createTerminalResult({
    eventId,
    reason,
    winner: 'blue',
    blueScore: goal.blueScore,
    orangeScore: goal.orangeScore,
    goal,
  });
}

function terminalTransition(
  terminal = makeTerminal(),
): Readonly<MatchTransitionSnapshot> {
  const kind = terminal.reason === 'hard-regulation-cutoff'
    ? 'hard-cutoff'
    : terminal.reason === 'overtime-goal'
      ? 'overtime-terminal-goal'
      : 'regulation-terminal-goal';
  return Object.freeze({
    eventId: terminal.eventId,
    kind,
    goal: terminal.goal,
    terminal,
  });
}

function makeEndedSnapshot(
  sequence = 1,
  terminal = makeTerminal(),
): Record<string, unknown> {
  return {
    protocolVersion: SNAPSHOT_PROTOCOL_VERSION,
    policyVersion: ROOM_POLICIES.custom.version,
    roomMode: 'custom',
    totalCapacity: ROOM_POLICIES.custom.totalCapacity,
    teamCapacity: ROOM_POLICIES.custom.teamCapacity,
    sequence,
    serverTime: 10_000 + sequence * 33,
    simulationTime: 5_000,
    phase: 'ended',
    countdownKind: null,
    phaseSecondsRemaining: 0,
    regulationSecondsRemaining: 123.5,
    kickoffEpoch: 3,
    blueScore: terminal.blueScore,
    orangeScore: terminal.orangeScore,
    winner: terminal.winner,
    terminalResult: terminal,
    latestTransition: terminalTransition(terminal),
    cars: makeCars(),
    ball: {
      position: [0, 0.9125, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
    },
  };
}

function assertAllNumbersFinite(value: unknown): void {
  if (typeof value === 'number') {
    assert.equal(Number.isFinite(value), true);
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

test('V2 input normalization preserves independent controls and monotonic edges', () => {
  const normalized = normalizeInputCommandV2(
    {
      ...baseInput,
      throttle: 2,
      steer: Number.NaN,
      pitch: Number.POSITIVE_INFINITY,
      yaw: -2,
      jumpSequence: 7,
      cameraToggleSequence: -1,
    },
    { jumpSequence: 8, cameraToggleSequence: 5 },
  );

  assert.deepEqual(normalized, {
    ...baseInput,
    throttle: 1,
    steer: 0,
    pitch: 0,
    yaw: -1,
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(isInputCommandV2(normalized, { jumpSequence: 8, cameraToggleSequence: 5 }), true);
});

test('V2 input contract rejects authoritative-looking fields at any nesting level', () => {
  const forgedInputs = [
    { ...baseInput, position: [99, 99, 99] },
    { ...baseInput, blueScore: 999 },
    { ...baseInput, boostInventory: 100 },
    { ...baseInput, team: 'orange' },
    { ...baseInput, phase: 'ended' },
    { ...baseInput, car: { transform: { x: 1 } } },
  ];

  for (const forged of forgedInputs) {
    assert.throws(() => normalizeInputCommandV2(forged), InputContractError);
    assert.equal(isInputCommandV2(forged), false);
  }
});

test('maximum-capacity V2 JSON round trip preserves eight identities and associated fields', () => {
  const source = makeEndedSnapshot();
  const serialized = serializeSnapshotEnvelopeV2(source);
  const decoded = deserializeSnapshotEnvelopeV2(serialized);

  assert.equal(decoded.cars.length, 8);
  assert.equal(new Set(decoded.cars.map((car) => car.sessionId)).size, 8);
  const expectedById = new Map(makeCars().map((car) => [car.sessionId, car]));
  for (const car of decoded.cars) {
    assert.deepEqual(car, expectedById.get(car.sessionId));
  }
  assert.deepEqual(decoded.terminalResult, makeTerminal());
  assert.equal(decoded.latestTransition?.eventId, decoded.terminalResult?.eventId);
  assert.equal(decoded.policyVersion, ROOM_POLICIES.custom.version);
  assert.equal(decoded.totalCapacity, 8);
  assert.equal(decoded.teamCapacity, 4);
  assertAllNumbersFinite(decoded);
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.cars), true);
  assert.equal(Object.isFrozen(decoded.cars[0]?.position), true);
  assert.equal(Object.isFrozen(decoded.terminalResult), true);
  assert.equal(isSnapshotEnvelopeV2(decoded), true);
});

test('snapshot structural validation rejects duplicate identities, over-capacity cars, and non-finite fields', () => {
  const source = makeEndedSnapshot();
  const cars = makeCars();

  assert.throws(
    () => parseSnapshotEnvelopeV2({ ...source, cars: [...cars.slice(0, 7), cars[0]] }),
    SnapshotContractError,
  );
  assert.throws(
    () => parseSnapshotEnvelopeV2({
      ...source,
      cars: [...cars, { ...cars[0], sessionId: 'session-8', team: 'orange', isHost: false }],
    }),
    SnapshotContractError,
  );
  assert.throws(
    () => parseSnapshotEnvelopeV2({
      ...source,
      cars: [{ ...cars[0], position: [Number.NaN, 0, 0] }, ...cars.slice(1)],
    }),
    SnapshotContractError,
  );
  assert.throws(
    () => parseSnapshotEnvelopeV2({ ...source, regulationSecondsRemaining: Infinity }),
    SnapshotContractError,
  );
});

test('terminal snapshots enforce score, winner, reason, and composite event-ID coherence', () => {
  const validTerminals = [
    makeTerminal(51, 'regulation-target-and-margin'),
    makeTerminal(52, 'hard-regulation-cutoff'),
    makeTerminal(53, 'overtime-goal'),
  ];
  for (const terminal of validTerminals) {
    assert.doesNotThrow(() => parseSnapshotEnvelopeV2(makeEndedSnapshot(1, terminal)));
  }

  const source = makeEndedSnapshot();
  assert.throws(
    () => parseSnapshotEnvelopeV2({ ...source, blueScore: 7 }),
    SnapshotContractError,
  );
  assert.throws(
    () => parseSnapshotEnvelopeV2({
      ...source,
      latestTransition: { ...terminalTransition(), eventId: 99 },
    }),
    SnapshotContractError,
  );
  assert.throws(
    () => parseSnapshotEnvelopeV2({
      ...source,
      latestTransition: { ...terminalTransition(), kind: 'hard-cutoff' },
    }),
    SnapshotContractError,
  );
  assert.throws(
    () => createTerminalResult({
      ...makeTerminal(),
      winner: 'orange',
    }),
    TypeError,
  );
});

test('repeated Ended snapshots retain one immutable terminal transition', () => {
  const first = parseSnapshotEnvelopeV2(makeEndedSnapshot(10));
  const second = parseSnapshotEnvelopeV2(makeEndedSnapshot(11));

  assert.doesNotThrow(() => assertStableTerminalSnapshots(first, second));
  assert.throws(() => {
    (first.terminalResult as unknown as { blueScore: number }).blueScore = 999;
  }, TypeError);

  const changedTerminal = makeTerminal(42);
  const changed = parseSnapshotEnvelopeV2(makeEndedSnapshot(12, changedTerminal));
  assert.throws(() => assertStableTerminalSnapshots(second, changed), SnapshotContractError);
  assert.throws(() => assertStableTerminalSnapshots(second, second), SnapshotContractError);
});

test('authoritative schemas project stable roster order, bounded boost, policy, timing, occupancy, and terminal state', () => {
  const state = new GameState();
  const cars = makeCars();

  for (let index = cars.length - 1; index >= 0; index -= 1) {
    const car = cars[index];
    assert.ok(car);
    const player = PlayerState.fromAuthoritative({
      ...car,
      acceptedJoinOrdinal: index,
      angularVelocity: [index, index / 2, -index],
      boost: index === 7 ? 150 : car.boost,
    });
    state.players.set(car.sessionId, player);
  }

  const terminal = createTerminalResult({
    eventId: 70,
    reason: 'hard-regulation-cutoff',
    winner: 'blue',
    blueScore: 300,
    orangeScore: 299,
    goal: null,
  });
  const transition: MatchTransitionSnapshot = {
    eventId: 70,
    kind: 'hard-cutoff',
    goal: null,
    terminal,
  };
  const projection = {
    policy: ROOM_POLICIES.custom,
    phase: 'ended' as const,
    countdownKind: null,
    phaseSecondsRemaining: 0,
    countdownStepsRemaining: 0,
    goalResetStepsRemaining: 0,
    regulationStepsRemaining: 0,
    regulationActivePlayStepsCompleted: 18_000,
    regulationStarted: true,
    regulationCutoffResolved: true,
    kickoffEpoch: 9,
    blueScore: 300,
    orangeScore: 299,
    winner: 'blue' as const,
    terminalResult: terminal,
    latestTransition: transition,
    transitionSequence: 70,
  };

  state.applyAuthoritativeProjection(projection);
  assert.deepEqual(state.stableRosterSessionIds(), cars.map((car) => car.sessionId));
  assert.equal(state.players.get('session-7')?.boost, 100);
  assert.equal(state.players.get('session-0')?.acceptedJoinOrdinal, 0);
  assert.equal(state.players.get('session-0')?.team, 'blue');
  assert.equal(state.players.get('session-0')?.isHost, true);
  assert.equal(state.roomMode, 'custom');
  assert.equal(state.policyVersion, 1);
  assert.equal(state.totalCapacity, 8);
  assert.equal(state.teamCapacity, 4);
  assert.equal(state.totalOccupancy, 8);
  assert.equal(state.blueOccupancy, 4);
  assert.equal(state.orangeOccupancy, 4);
  assert.equal(state.hostSessionId, 'session-0');
  assert.equal(state.regulationStepsRemaining, 0);
  assert.equal(state.regulationActivePlayStepsCompleted, 18_000);
  assert.equal(state.terminalResult?.blueScore, 300);
  assert.equal(state.latestTransition?.eventId, 70);

  const schemaJson = JSON.parse(JSON.stringify(state.toJSON())) as {
    players: Record<string, unknown>;
    blueScore: number;
    orangeScore: number;
    terminalResult: { reason: string };
    latestTransition: { eventId: number };
  };
  assert.equal(Object.keys(schemaJson.players).length, 8);
  assert.equal(schemaJson.blueScore, 300);
  assert.equal(schemaJson.orangeScore, 299);
  assert.equal(schemaJson.terminalResult.reason, 'hard-regulation-cutoff');
  assert.equal(schemaJson.latestTransition.eventId, 70);

  assert.doesNotThrow(() => state.applyAuthoritativeProjection(projection));
  const changedTerminal = createTerminalResult({ ...terminal, eventId: 71 });
  assert.throws(() => state.applyAuthoritativeProjection({
    ...projection,
    terminalResult: changedTerminal,
    latestTransition: {
      eventId: 71,
      kind: 'hard-cutoff',
      goal: null,
      terminal: changedTerminal,
    },
    transitionSequence: 71,
  }), TypeError);
});
