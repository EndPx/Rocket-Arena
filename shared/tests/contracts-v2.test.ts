import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOM_POLICIES } from '../src/config/room-policies.js';
import {
  GameState,
  PlayerState,
} from '../src/schema/index.js';
import {
  INPUT_PROTOCOL_VERSION,
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
  MAX_BOOST_PAD_COOLDOWNS,
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

test('V2 input allow-list ignores authoritative-looking extras without suppressing controls', () => {
  const controlOnly = normalizeInputCommandV2(baseInput);
  const forgedInputs = [
    { ...baseInput, position: [99, 99, 99] },
    { ...baseInput, blueScore: 999 },
    { ...baseInput, boostInventory: 100 },
    { ...baseInput, team: 'orange' },
    { ...baseInput, phase: 'ended' },
    { ...baseInput, car: { transform: { x: 1 } } },
  ];

  for (const forged of forgedInputs) {
    assert.deepEqual(normalizeInputCommandV2(forged), controlOnly);
    assert.equal(isInputCommandV2(forged), true);
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

test('authoritative schemas atomically project roster, ball, policy, timing, occupancy, and terminal state', () => {
  const state = new GameState();
  const cars = makeCars();

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
    cars: cars.map((car, index) => ({
      ...car,
      acceptedJoinOrdinal: index,
      angularVelocity: [index, index / 2, -index] as const,
      boost: index === 7 ? 150 : car.boost,
    })),
    ball: {
      position: [2, 0.9125, -3] as const,
      rotation: [0, 0, 0, 1] as const,
      linearVelocity: [1, 2, 3] as const,
    },
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

type GameProjection = Parameters<GameState['applyAuthoritativeProjection']>[0];
type RoomPolicyValue = (typeof ROOM_POLICIES)[keyof typeof ROOM_POLICIES];

function makeNonTerminalProjection(
  policy: RoomPolicyValue = ROOM_POLICIES.custom,
): GameProjection {
  return {
    cars: [],
    ball: {
      position: [0, 0.9125, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0, 0, 0],
    },
    policy,
    phase: 'waiting',
    countdownKind: null,
    phaseSecondsRemaining: 0,
    countdownStepsRemaining: 0,
    goalResetStepsRemaining: 0,
    regulationStepsRemaining: 18_000,
    regulationActivePlayStepsCompleted: 0,
    regulationStarted: false,
    regulationCutoffResolved: false,
    kickoffEpoch: 0,
    blueScore: 0,
    orangeScore: 0,
    winner: null,
    terminalResult: null,
    latestTransition: null,
    transitionSequence: 0,
  };
}

function makeChangedNonTerminalProjection(policy: RoomPolicyValue): GameProjection {
  return {
    ...makeNonTerminalProjection(policy),
    phase: 'playing',
    phaseSecondsRemaining: 1.25,
    regulationStepsRemaining: 12_000,
    regulationActivePlayStepsCompleted: 6_000,
    regulationStarted: true,
    kickoffEpoch: 4,
    blueScore: 2,
    orangeScore: 1,
  };
}

function makeEndedProjectionForTransition(
  terminal: Readonly<TerminalResult>,
  transition: Readonly<MatchTransitionSnapshot>,
): GameProjection {
  return {
    ...makeNonTerminalProjection(),
    phase: 'ended',
    regulationStepsRemaining: 0,
    regulationActivePlayStepsCompleted: 18_000,
    regulationStarted: true,
    regulationCutoffResolved: true,
    blueScore: terminal.blueScore,
    orangeScore: terminal.orangeScore,
    winner: terminal.winner,
    terminalResult: terminal,
    latestTransition: transition,
    transitionSequence: transition.eventId,
  };
}

function projectionForTransition(
  transition: Readonly<MatchTransitionSnapshot>,
): GameProjection {
  if (transition.terminal !== null) {
    return makeEndedProjectionForTransition(transition.terminal, transition);
  }
  return {
    ...makeNonTerminalProjection(),
    latestTransition: transition,
    transitionSequence: transition.eventId,
  };
}

function addSchemaPlayer(
  state: GameState,
  index: number,
  team: CarSnapshot['team'],
  isHost = false,
): PlayerState {
  const sessionId = `schema-session-${index}`;
  const player = PlayerState.fromAuthoritative({
    sessionId,
    acceptedJoinOrdinal: index,
    team,
    name: `Schema Driver ${index}`,
    isHost,
    position: [index, 1, -index],
    rotation: [0, 0, 0, 1],
    linearVelocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    boost: 33,
  });
  state.players.set(sessionId, player);
  return player;
}

function completeProjectionFromState(
  state: GameState,
  projection: GameProjection,
): GameProjection {
  return {
    ...projection,
    cars: state.stableRosterSessionIds().map((sessionId) => {
      const player = state.players.get(sessionId);
      if (player === undefined) throw new Error(`Missing schema player ${sessionId}.`);
      return {
        sessionId,
        acceptedJoinOrdinal: player.acceptedJoinOrdinal,
        team: player.team,
        name: player.name,
        isHost: player.isHost,
        position: [player.x, player.y, player.z],
        rotation: [player.qx, player.qy, player.qz, player.qw],
        linearVelocity: [player.vx, player.vy, player.vz],
        angularVelocity: [player.wx, player.wy, player.wz],
        boost: player.boost,
      };
    }),
    ball: {
      position: [state.ball.x, state.ball.y, state.ball.z],
      rotation: [state.ball.qx, state.ball.qy, state.ball.qz, state.ball.qw],
      linearVelocity: [state.ball.vx, state.ball.vy, state.ball.vz],
    },
  };
}

function cloneSchemaState(state: GameState): unknown {
  return JSON.parse(JSON.stringify(state.toJSON())) as unknown;
}

function assertProjectionRejectedWithoutMutation(
  state: GameState,
  projection: GameProjection,
): void {
  const before = cloneSchemaState(state);
  const references = {
    players: state.players,
    ball: state.ball,
    terminalResult: state.terminalResult,
    latestTransition: state.latestTransition,
  };

  assert.throws(() => state.applyAuthoritativeProjection(projection), Error);
  assert.deepEqual(cloneSchemaState(state), before);
  assert.strictEqual(state.players, references.players);
  assert.strictEqual(state.ball, references.ball);
  assert.strictEqual(state.terminalResult, references.terminalResult);
  assert.strictEqual(state.latestTransition, references.latestTransition);
}

test('complete schema projection rejects late car or ball failure without partial mutation', () => {
  const state = new GameState();
  addSchemaPlayer(state, 0, 'blue', true);
  const committed = completeProjectionFromState(state, makeNonTerminalProjection());
  state.applyAuthoritativeProjection(committed);

  const invalidCar = {
    ...committed.cars[0]!,
    position: [Number.NaN, 1, 0] as const,
  };
  assertProjectionRejectedWithoutMutation(state, {
    ...makeChangedNonTerminalProjection(ROOM_POLICIES.custom),
    cars: [invalidCar],
    ball: committed.ball,
  });
  assertProjectionRejectedWithoutMutation(state, {
    ...makeChangedNonTerminalProjection(ROOM_POLICIES.custom),
    cars: committed.cars,
    ball: {
      ...committed.ball,
      linearVelocity: [0, Number.POSITIVE_INFINITY, 0],
    },
  });
});

test('non-ended V2 snapshots reject terminal transition payloads', () => {
  const ended = makeEndedSnapshot(80, makeTerminal(80, 'hard-regulation-cutoff'));

  assert.throws(
    () => parseSnapshotEnvelopeV2({
      ...ended,
      phase: 'playing',
      winner: null,
      terminalResult: null,
    }),
    SnapshotContractError,
  );
});

test('V2 terminal transitions require symmetric and identical goal payloads', () => {
  const eventId = 81;
  const cutoffGoal = createGoalResult({
    eventId,
    team: 'blue',
    kickoffEpoch: 3,
    blueScore: 5,
    orangeScore: 4,
  });
  const cutoffWithGoal = createTerminalResult({
    eventId,
    reason: 'hard-regulation-cutoff',
    winner: 'blue',
    blueScore: 5,
    orangeScore: 4,
    goal: cutoffGoal,
  });
  const withGoalSource = makeEndedSnapshot(81, cutoffWithGoal);

  assert.doesNotThrow(() => parseSnapshotEnvelopeV2(withGoalSource));
  assert.throws(
    () => parseSnapshotEnvelopeV2({
      ...withGoalSource,
      latestTransition: {
        ...terminalTransition(cutoffWithGoal),
        goal: null,
      },
    }),
    SnapshotContractError,
  );

  const cutoffWithoutGoal = makeTerminal(82, 'hard-regulation-cutoff');
  const transitionOnlyGoal = createGoalResult({
    eventId: 82,
    team: 'blue',
    kickoffEpoch: 3,
    blueScore: 5,
    orangeScore: 4,
  });
  assert.throws(
    () => parseSnapshotEnvelopeV2({
      ...makeEndedSnapshot(82, cutoffWithoutGoal),
      latestTransition: {
        ...terminalTransition(cutoffWithoutGoal),
        goal: transitionOnlyGoal,
      },
    }),
    SnapshotContractError,
  );

  const unequalGoal = createGoalResult({
    ...cutoffGoal,
    kickoffEpoch: cutoffGoal.kickoffEpoch - 1,
  });
  assert.throws(
    () => parseSnapshotEnvelopeV2({
      ...withGoalSource,
      latestTransition: {
        ...terminalTransition(cutoffWithGoal),
        goal: unequalGoal,
      },
    }),
    SnapshotContractError,
  );
});

test('schema transition validation mirrors every wire kind and payload rejection', () => {
  const eventId = 90;
  const goal = createGoalResult({
    eventId,
    team: 'blue',
    kickoffEpoch: 3,
    blueScore: 6,
    orangeScore: 4,
  });
  const regulationTerminal = createTerminalResult({
    eventId,
    reason: 'regulation-target-and-margin',
    winner: 'blue',
    blueScore: 6,
    orangeScore: 4,
    goal,
  });
  const cutoffTerminal = createTerminalResult({
    eventId,
    reason: 'hard-regulation-cutoff',
    winner: 'blue',
    blueScore: 6,
    orangeScore: 4,
    goal,
  });

  const invalidTransitions: readonly MatchTransitionSnapshot[] = [
    { eventId, kind: 'countdown', goal, terminal: null },
    { eventId, kind: 'countdown', goal, terminal: cutoffTerminal },
    { eventId, kind: 'regulation-goal-reset', goal: null, terminal: null },
    { eventId, kind: 'regulation-goal-reset', goal, terminal: regulationTerminal },
    { eventId, kind: 'regulation-terminal-goal', goal, terminal: null },
    { eventId, kind: 'regulation-terminal-goal', goal, terminal: cutoffTerminal },
    { eventId, kind: 'hard-cutoff', goal: null, terminal: null },
    { eventId, kind: 'hard-cutoff', goal, terminal: regulationTerminal },
    { eventId, kind: 'overtime-entry', goal, terminal: cutoffTerminal },
    { eventId, kind: 'overtime-terminal-goal', goal, terminal: null },
    { eventId, kind: 'overtime-terminal-goal', goal, terminal: regulationTerminal },
  ];

  for (const transition of invalidTransitions) {
    const state = new GameState();
    assertProjectionRejectedWithoutMutation(state, projectionForTransition(transition));
  }
});

test('schema terminal transitions require symmetric and identical goal payloads', () => {
  const eventId = 91;
  const goal = createGoalResult({
    eventId,
    team: 'blue',
    kickoffEpoch: 3,
    blueScore: 5,
    orangeScore: 4,
  });
  const terminalWithGoal = createTerminalResult({
    eventId,
    reason: 'hard-regulation-cutoff',
    winner: 'blue',
    blueScore: 5,
    orangeScore: 4,
    goal,
  });
  const terminalWithoutGoal = createTerminalResult({
    eventId,
    reason: 'hard-regulation-cutoff',
    winner: 'blue',
    blueScore: 5,
    orangeScore: 4,
    goal: null,
  });
  const unequalGoal = createGoalResult({ ...goal, kickoffEpoch: 2 });

  const invalidPairs: readonly {
    readonly terminal: Readonly<TerminalResult>;
    readonly transitionGoal: Readonly<GoalResult> | null;
  }[] = [
    { terminal: terminalWithGoal, transitionGoal: null },
    { terminal: terminalWithoutGoal, transitionGoal: goal },
    { terminal: terminalWithGoal, transitionGoal: unequalGoal },
  ];

  for (const pair of invalidPairs) {
    const transition: MatchTransitionSnapshot = {
      eventId,
      kind: 'hard-cutoff',
      goal: pair.transitionGoal,
      terminal: pair.terminal,
    };
    const state = new GameState();
    assertProjectionRejectedWithoutMutation(
      state,
      makeEndedProjectionForTransition(pair.terminal, transition),
    );
  }
});

test('schema rejects terminal transition data outside Ended state without mutation', () => {
  const terminal = makeTerminal(92, 'hard-regulation-cutoff');
  const transition = terminalTransition(terminal);
  const state = new GameState();

  assertProjectionRejectedWithoutMutation(state, {
    ...makeNonTerminalProjection(),
    phase: 'playing',
    latestTransition: transition,
    transitionSequence: transition.eventId,
  });
});

test('authoritative projection preflights roster team, capacity, and Host state atomically', () => {
  const invalidTeamState = new GameState();
  addSchemaPlayer(invalidTeamState, 0, 'blue');
  invalidTeamState.applyAuthoritativeProjection(completeProjectionFromState(
    invalidTeamState,
    makeNonTerminalProjection(),
  ));
  const invalidTeamPlayer = invalidTeamState.players.get('schema-session-0');
  assert.ok(invalidTeamPlayer);
  (invalidTeamPlayer as unknown as { team: string }).team = 'spectator';
  assertProjectionRejectedWithoutMutation(
    invalidTeamState,
    completeProjectionFromState(
      invalidTeamState,
      makeChangedNonTerminalProjection(ROOM_POLICIES.quick),
    ),
  );

  const teamCapacityState = new GameState();
  for (let index = 0; index < 4; index += 1) {
    addSchemaPlayer(teamCapacityState, index, 'blue');
  }
  teamCapacityState.applyAuthoritativeProjection(completeProjectionFromState(
    teamCapacityState,
    makeNonTerminalProjection(),
  ));
  assertProjectionRejectedWithoutMutation(
    teamCapacityState,
    completeProjectionFromState(
      teamCapacityState,
      makeChangedNonTerminalProjection(ROOM_POLICIES.quick),
    ),
  );

  const totalCapacityState = new GameState();
  for (let index = 0; index < 7; index += 1) {
    addSchemaPlayer(totalCapacityState, index, index < 4 ? 'blue' : 'orange');
  }
  totalCapacityState.applyAuthoritativeProjection(completeProjectionFromState(
    totalCapacityState,
    makeNonTerminalProjection(),
  ));
  assertProjectionRejectedWithoutMutation(
    totalCapacityState,
    completeProjectionFromState(
      totalCapacityState,
      makeChangedNonTerminalProjection(ROOM_POLICIES.quick),
    ),
  );

  const quickHostState = new GameState();
  addSchemaPlayer(quickHostState, 0, 'blue', true);
  quickHostState.applyAuthoritativeProjection(completeProjectionFromState(
    quickHostState,
    makeNonTerminalProjection(),
  ));
  assertProjectionRejectedWithoutMutation(
    quickHostState,
    completeProjectionFromState(
      quickHostState,
      makeChangedNonTerminalProjection(ROOM_POLICIES.quick),
    ),
  );

  const multipleHostsState = new GameState();
  addSchemaPlayer(multipleHostsState, 0, 'blue', true);
  addSchemaPlayer(multipleHostsState, 1, 'orange');
  multipleHostsState.applyAuthoritativeProjection(completeProjectionFromState(
    multipleHostsState,
    makeNonTerminalProjection(),
  ));
  const secondHost = multipleHostsState.players.get('schema-session-1');
  assert.ok(secondHost);
  secondHost.isHost = true;
  assertProjectionRejectedWithoutMutation(
    multipleHostsState,
    completeProjectionFromState(
      multipleHostsState,
      makeChangedNonTerminalProjection(ROOM_POLICIES.custom),
    ),
  );
});


test('schema terminal goal equality is independent of object key insertion order', () => {
  const goal = createGoalResult({
    eventId: 93,
    team: 'blue',
    kickoffEpoch: 3,
    blueScore: 5,
    orangeScore: 4,
  });
  const terminal = createTerminalResult({
    eventId: goal.eventId,
    reason: 'hard-regulation-cutoff',
    winner: 'blue',
    blueScore: goal.blueScore,
    orangeScore: goal.orangeScore,
    goal,
  });
  const reorderedGoal: GoalResult = {
    orangeScore: goal.orangeScore,
    blueScore: goal.blueScore,
    kickoffEpoch: goal.kickoffEpoch,
    team: goal.team,
    eventId: goal.eventId,
  };
  const transition: MatchTransitionSnapshot = {
    eventId: goal.eventId,
    kind: 'hard-cutoff',
    goal: reorderedGoal,
    terminal,
  };
  const state = new GameState();

  assert.doesNotThrow(() => {
    state.applyAuthoritativeProjection(makeEndedProjectionForTransition(terminal, transition));
  });
});

test('boost pad cooldowns are validated, ordered, and optional', () => {
  // Any valid envelope will do; the field under test is independent of phase.
  const base = makeEndedSnapshot() as Record<string, unknown>;

  // Absent reads as nothing spent, so every envelope written before this field
  // existed still parses instead of being rejected as malformed.
  const { boostPadCooldowns: _omitted, ...withoutField } = base;
  assert.deepEqual(parseSnapshotEnvelopeV2(withoutField).boostPadCooldowns, []);
  assert.deepEqual(
    parseSnapshotEnvelopeV2({ ...base, boostPadCooldowns: null }).boostPadCooldowns,
    [],
  );

  // Listed pads are sorted by index, so two envelopes describing one state
  // serialize identically and a diff cannot be caused by ordering alone.
  const unordered = parseSnapshotEnvelopeV2({
    ...base,
    boostPadCooldowns: [
      { index: 7, secondsRemaining: 2 },
      { index: 1, secondsRemaining: 9.5 },
      { index: 4, secondsRemaining: 0.25 },
    ],
  });
  assert.deepEqual(unordered.boostPadCooldowns.map(({ index }) => index), [1, 4, 7]);
  assert.equal(unordered.boostPadCooldowns[0]!.secondsRemaining, 9.5);
  assert.equal(Object.isFrozen(unordered.boostPadCooldowns), true);
  assert.equal(Object.isFrozen(unordered.boostPadCooldowns[0]), true);

  for (const invalid of [
    // A pad with nothing left is available, so listing it is a contradiction.
    [{ index: 0, secondsRemaining: 0 }],
    [{ index: 0, secondsRemaining: -1 }],
    [{ index: 0, secondsRemaining: Number.NaN }],
    [{ index: 0, secondsRemaining: Number.POSITIVE_INFINITY }],
    // Two entries for one pad would leave presentation choosing between them.
    [{ index: 3, secondsRemaining: 1 }, { index: 3, secondsRemaining: 2 }],
    [{ index: -1, secondsRemaining: 1 }],
    [{ index: 1.5, secondsRemaining: 1 }],
    [{ index: MAX_BOOST_PAD_COOLDOWNS, secondsRemaining: 1 }],
    [{ secondsRemaining: 1 }],
    [{ index: 0 }],
    ['not a record'],
    'not an array',
    Array.from({ length: MAX_BOOST_PAD_COOLDOWNS + 1 }, (_, index) => ({
      index,
      secondsRemaining: 1,
    })),
  ]) {
    assert.throws(
      () => parseSnapshotEnvelopeV2({ ...base, boostPadCooldowns: invalid }),
      SnapshotContractError,
      `expected rejection for ${JSON.stringify(invalid)}`,
    );
  }
});
