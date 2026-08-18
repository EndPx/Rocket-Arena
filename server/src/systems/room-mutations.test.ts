import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROOM_POLICIES,
  type MatchPhase,
  type RoomPolicy,
  type RosterEntry,
  type Team,
} from '@rocket-arena/shared';
import {
  RoomMutationCommitError,
  canAcceptRoomInput,
  createRoomMutationState,
  isCapacityValidRoster,
  planRoomMutation,
  prepareRoomMutation,
  tombstoneRoomIdentity,
  visibleRosterEntries,
  type RoomMutationPlanningResult,
  type RoomMutationPreparationResult,
  type RoomMutationRejection,
  type RoomMutationState,
} from './room-mutations.js';

interface TestCar {
  readonly id: string;
  disposed: boolean;
}

interface TestInput {
  readonly throttle: number;
  readonly jumpSequence: number;
}

interface TestBall {
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
  readonly marker: string;
}

type TestState = Readonly<RoomMutationState<TestCar, TestInput, TestBall, string>>;

interface StateOptions {
  readonly phase?: MatchPhase;
  readonly countdownStepsRemaining?: number;
  readonly blueScore?: number;
  readonly orangeScore?: number;
  readonly regulationStepsRemaining?: number;
  readonly ball?: TestBall;
}

function rosterEntry(
  sessionId: string,
  acceptedJoinOrdinal: number,
  team: Team,
  isHost = false,
): RosterEntry {
  return {
    sessionId,
    acceptedJoinOrdinal,
    team,
    name: `Player ${sessionId}`,
    isHost,
  };
}

function makeState(
  policy: RoomPolicy,
  entries: readonly RosterEntry[] = [],
  options: StateOptions = {},
): TestState {
  const roster = new Map(entries.map((entry) => [entry.sessionId, entry]));
  const cars = new Map(entries.map((entry) => [
    entry.sessionId,
    { id: `car:${entry.sessionId}`, disposed: false },
  ]));
  const inputs = new Map(entries.map((entry, index) => [
    entry.sessionId,
    { throttle: index / 10, jumpSequence: index },
  ]));
  const host = entries.find(({ isHost }) => isHost)?.sessionId ?? null;
  const phase = options.phase ?? 'waiting';
  const maxOrdinal = entries.reduce(
    (maximum, entry) => Math.max(maximum, entry.acceptedJoinOrdinal),
    -1,
  );

  return createRoomMutationState<TestCar, TestInput, TestBall, string>({
    policy,
    roster,
    nextJoinOrdinal: maxOrdinal + 1,
    hostSessionId: host,
    phase,
    countdownKind: phase === 'countdown' ? 'initial' : null,
    countdownStepsRemaining: phase === 'countdown'
      ? (options.countdownStepsRemaining ?? 91)
      : 0,
    blueScore: options.blueScore ?? 4,
    orangeScore: options.orangeScore ?? 3,
    regulationStepsRemaining: options.regulationStepsRemaining ?? 12_345,
    ball: options.ball ?? {
      position: [1, 2, 3],
      velocity: [4, 5, 6],
      marker: 'authoritative-ball',
    },
    cars,
    inputs,
    kickoffAssignments: new Map(entries.map((entry) => [entry.sessionId, `slot:${entry.sessionId}`])),
  });
}

function stateSnapshot(state: TestState) {
  const ordered = <T>(values: ReadonlyMap<string, T>): readonly [string, T][] => (
    [...values.entries()].sort(([left], [right]) => left.localeCompare(right))
  );

  return structuredClone({
    revision: state.revision,
    policy: state.policy,
    roster: ordered(state.roster),
    nextJoinOrdinal: state.nextJoinOrdinal,
    hostSessionId: state.hostSessionId,
    occupancy: state.occupancy,
    phase: state.phase,
    countdownKind: state.countdownKind,
    countdownStepsRemaining: state.countdownStepsRemaining,
    blueScore: state.blueScore,
    orangeScore: state.orangeScore,
    regulationStepsRemaining: state.regulationStepsRemaining,
    ball: state.ball,
    cars: ordered(state.cars),
    inputs: ordered(state.inputs),
    kickoffAssignments: ordered(state.kickoffAssignments),
    tombstones: [...state.tombstones].sort(),
  });
}

function assertRejection(
  result: RoomMutationPlanningResult | RoomMutationPreparationResult<TestCar, TestInput, TestBall, string>,
  code: RoomMutationRejection['code'],
): asserts result is RoomMutationRejection {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, code);
}

function assertUnchanged(state: TestState, before: unknown): void {
  assert.deepEqual(
    stateSnapshot(state),
    before,
    'rejection must preserve roster, Host, phase, countdown, score, timer, ball, cars, and inputs',
  );
}

function expectPlan(
  state: TestState,
  request: Parameters<typeof planRoomMutation<TestCar, TestInput, TestBall, string>>[1],
  physicsReady = true,
) {
  const result = planRoomMutation(state, request, { physicsReady });
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  return result.plan;
}

function prepareJoin(plan: ReturnType<typeof expectPlan>) {
  return prepareRoomMutation<TestCar, TestInput, TestBall, string>(plan, {
    prepareJoin: ({ entry }, scope) => {
      const car = scope.track<TestCar>(
        { id: `car:${entry.sessionId}`, disposed: false },
        (resource) => { resource.disposed = true; },
      );
      return {
        car,
        input: { throttle: 0, jumpSequence: 0 },
      };
    },
  });
}

function commitJoin(state: TestState, sessionId: string): TestState {
  const plan = expectPlan(state, { kind: 'join', sessionId, name: `Player ${sessionId}` });
  const preparation = prepareJoin(plan);
  assert.equal(preparation.ok, true, preparation.ok ? undefined : preparation.message);
  const committed = preparation.prepared.commit(state);
  assert.equal(committed.ok, true, committed.ok ? undefined : committed.message);
  return committed.next;
}

// Validates: Requirements 2.10, 3.1-3.2, 4.1-4.3

test('join prepares a body before one-shot commit exposes the identity', () => {
  const state = makeState(ROOM_POLICIES.custom);
  const before = stateSnapshot(state);
  const plan = expectPlan(state, { kind: 'join', sessionId: 'host', name: 'Host Player' });

  assert.equal(state.roster.has('host'), false);
  assert.equal(state.cars.has('host'), false);
  assert.deepEqual(stateSnapshot(state), before);
  assert.deepEqual(plan.effect, {
    kind: 'joined',
    entry: {
      sessionId: 'host',
      acceptedJoinOrdinal: 0,
      team: 'blue',
      name: 'Host Player',
      isHost: true,
    },
  });

  const preparation = prepareJoin(plan);
  assert.equal(preparation.ok, true, preparation.ok ? undefined : preparation.message);
  if (!preparation.ok) return;

  assert.equal(state.roster.has('host'), false, 'preparation must not expose a logical identity');
  assert.equal(state.cars.has('host'), false, 'preparation must not alter the body map');
  assert.deepEqual(stateSnapshot(state), before);

  const committed = preparation.prepared.commit(state);
  assert.equal(committed.ok, true, committed.ok ? undefined : committed.message);
  if (!committed.ok) return;

  const next = committed.next;
  assert.equal(next.roster.size, 1);
  assert.equal(next.cars.size, 1);
  assert.equal(next.inputs.size, 1);
  assert.ok(next.cars.has('host'));
  assert.ok(next.inputs.has('host'));
  assert.equal(next.hostSessionId, 'host');
  assert.deepEqual(next.occupancy, { total: 1, blue: 1, orange: 0 });
  assert.equal(next.phase, state.phase);
  assert.equal(next.blueScore, state.blueScore);
  assert.equal(next.regulationStepsRemaining, state.regulationStepsRemaining);
  assert.equal(next.ball, state.ball);
  assert.equal(next.cars.get('host')?.disposed, false);
  assert.ok([...next.roster.keys()].every((sessionId) => next.cars.has(sessionId)));

  assert.throws(
    () => preparation.prepared.commit(next),
    RoomMutationCommitError,
    'a prepared mutation must not commit twice',
  );

  const second = commitJoin(next, 'second');
  assert.equal(second.roster.get('second')?.team, 'orange');
  assert.equal(second.roster.get('second')?.isHost, false);
  assert.equal(second.hostSessionId, 'host');
});

// Validates: Requirements 2.10, 3.2, 3.8, 4.3, 4.9, 4.11-4.15

test('all typed plan rejections preserve the complete authoritative state', async (t) => {
  const duplicateState = makeState(ROOM_POLICIES.custom, [
    rosterEntry('host', 0, 'blue', true),
  ]);
  const fullQuickState = makeState(ROOM_POLICIES.quick, [
    rosterEntry('q0', 0, 'blue'),
    rosterEntry('q1', 1, 'orange'),
    rosterEntry('q2', 2, 'blue'),
    rosterEntry('q3', 3, 'orange'),
    rosterEntry('q4', 4, 'blue'),
    rosterEntry('q5', 5, 'orange'),
  ]);
  const countdownState = makeState(
    ROOM_POLICIES.custom,
    [rosterEntry('host', 0, 'blue', true)],
    { phase: 'countdown', countdownStepsRemaining: 77 },
  );
  const nonHostState = makeState(ROOM_POLICIES.custom, [
    rosterEntry('host', 0, 'blue', true),
    rosterEntry('guest', 1, 'orange'),
  ]);
  const fullDestinationState = makeState(ROOM_POLICIES.custom, [
    rosterEntry('host', 0, 'blue', true),
    rosterEntry('o0', 1, 'orange'),
    rosterEntry('o1', 2, 'orange'),
    rosterEntry('o2', 3, 'orange'),
    rosterEntry('o3', 4, 'orange'),
  ]);
  const emptyCustomState = makeState(ROOM_POLICIES.custom);

  const invalidRosterState = {
    ...duplicateState,
    cars: new Map<string, TestCar>(),
  } as TestState;
  const policyMismatchState = {
    ...duplicateState,
    policy: { ...ROOM_POLICIES.custom, totalCapacity: 6 },
  } as unknown as TestState;

  const cases: readonly {
    readonly name: string;
    readonly state: TestState;
    readonly request: Parameters<typeof planRoomMutation<TestCar, TestInput, TestBall, string>>[1];
    readonly physicsReady: boolean;
    readonly code: RoomMutationRejection['code'];
  }[] = [
    {
      name: 'duplicate identity',
      state: duplicateState,
      request: { kind: 'join', sessionId: 'host', name: 'Duplicate' },
      physicsReady: true,
      code: 'duplicate-identity',
    },
    {
      name: 'total capacity',
      state: fullQuickState,
      request: { kind: 'join', sessionId: 'q6', name: 'Seventh' },
      physicsReady: true,
      code: 'total-capacity',
    },
    {
      name: 'wrong phase',
      state: countdownState,
      request: { kind: 'switch-team', sessionId: 'host', team: 'orange' },
      physicsReady: true,
      code: 'wrong-phase',
    },
    {
      name: 'non Host start',
      state: nonHostState,
      request: { kind: 'start', sessionId: 'guest' },
      physicsReady: true,
      code: 'not-host',
    },
    {
      name: 'destination team capacity',
      state: fullDestinationState,
      request: { kind: 'switch-team', sessionId: 'host', team: 'orange' },
      physicsReady: true,
      code: 'team-capacity',
    },
    {
      name: 'same team rather than opposite team',
      state: duplicateState,
      request: { kind: 'switch-team', sessionId: 'host', team: 'blue' },
      physicsReady: true,
      code: 'not-opposite-team',
    },
    {
      name: 'unrepresented identity',
      state: duplicateState,
      request: { kind: 'leave', sessionId: 'missing' },
      physicsReady: true,
      code: 'not-represented',
    },
    {
      name: 'join before physics readiness',
      state: emptyCustomState,
      request: { kind: 'join', sessionId: 'early', name: 'Early' },
      physicsReady: false,
      code: 'physics-not-ready',
    },
    {
      name: 'start before physics readiness',
      state: duplicateState,
      request: { kind: 'start', sessionId: 'host' },
      physicsReady: false,
      code: 'physics-not-ready',
    },
    {
      name: 'invalid represented body roster',
      state: invalidRosterState,
      request: { kind: 'start', sessionId: 'host' },
      physicsReady: true,
      code: 'invalid-roster',
    },
    {
      name: 'policy mismatch',
      state: policyMismatchState,
      request: { kind: 'start', sessionId: 'host' },
      physicsReady: true,
      code: 'policy-mismatch',
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const before = stateSnapshot(scenario.state);
      const result = planRoomMutation(
        scenario.state,
        scenario.request,
        { physicsReady: scenario.physicsReady },
      );
      assertRejection(result, scenario.code);
      assertUnchanged(scenario.state, before);
    });
  }
});

// Validates: Requirements 2.10, 3.1, 4.1, 4.18

test('failed or aborted join preparation disposes temporary bodies and preserves state', () => {
  const state = makeState(ROOM_POLICIES.custom);
  const before = stateSnapshot(state);
  const plan = expectPlan(state, { kind: 'join', sessionId: 'candidate', name: 'Candidate' });
  const failedBody = { current: null as TestCar | null };

  const failed = prepareRoomMutation<TestCar, TestInput, TestBall, string>(plan, {
    prepareJoin: ({ entry }, scope) => {
      failedBody.current = scope.track<TestCar>(
        { id: `car:${entry.sessionId}`, disposed: false },
        (resource) => { resource.disposed = true; },
      );
      throw new Error('synthetic body preparation failure');
    },
  });

  assertRejection(failed, 'physics-not-ready');
  assert.equal(failedBody.current?.disposed, true);
  assertUnchanged(state, before);

  const missingPreparer = prepareRoomMutation<TestCar, TestInput, TestBall, string>(plan);
  assertRejection(missingPreparer, 'physics-not-ready');
  assertUnchanged(state, before);

  const prepared = prepareJoin(plan);
  assert.equal(prepared.ok, true, prepared.ok ? undefined : prepared.message);
  if (!prepared.ok) return;
  const preparedBody = (() => {
    const effect = prepared.prepared.effect;
    assert.equal(effect.kind, 'joined');
    if (effect.kind !== 'joined') throw new Error('expected joined effect');
    return effect.entry.sessionId;
  })();
  assert.equal(preparedBody, 'candidate');
  prepared.prepared.abort();
  assert.equal(prepared.prepared.settled, true);
  assertUnchanged(state, before);
});

// Validates: Requirements 3.11, 3.14-3.15, 4.16, 4.18-4.20

test('leave tombstones the identity, removes its body/input, and reassigns Host by stable order', () => {
  const state = makeState(
    ROOM_POLICIES.custom,
    [
      rosterEntry('host', 0, 'blue', true),
      rosterEntry('zeta', 1, 'orange'),
      rosterEntry('alpha', 1, 'blue'),
    ],
    {
      phase: 'countdown',
      countdownStepsRemaining: 64,
      blueScore: 8,
      orangeScore: 7,
      regulationStepsRemaining: 8_765,
    },
  );
  const before = stateSnapshot(state);
  const leavingCar = state.cars.get('host');
  assert.ok(leavingCar);
  let removalCommitted = false;

  const plan = expectPlan(state, { kind: 'leave', sessionId: 'host' });
  const preparation = prepareRoomMutation<TestCar, TestInput, TestBall, string>(plan, {
    prepareLeave: ({ car }) => ({
      commitRemoval: () => {
        removalCommitted = true;
        car.disposed = true;
      },
    }),
  });
  assert.equal(preparation.ok, true, preparation.ok ? undefined : preparation.message);
  if (!preparation.ok) return;

  assert.equal(removalCommitted, false);
  assertUnchanged(state, before);

  const committed = preparation.prepared.commit(state);
  assert.equal(committed.ok, true, committed.ok ? undefined : committed.message);
  if (!committed.ok) return;
  const next = committed.next;

  assert.equal(removalCommitted, true);
  assert.equal(leavingCar.disposed, true);
  assert.equal(next.roster.has('host'), false);
  assert.equal(next.cars.has('host'), false);
  assert.equal(next.inputs.has('host'), false);
  assert.equal(next.tombstones.has('host'), true);
  assert.equal(next.hostSessionId, 'alpha', 'equal ordinals use session identity as tie breaker');
  assert.equal(next.roster.get('alpha')?.isHost, true);
  assert.equal(next.roster.get('zeta')?.isHost, false);
  assert.deepEqual(next.occupancy, { total: 2, blue: 1, orange: 1 });
  assert.equal(next.phase, 'countdown');
  assert.equal(next.countdownKind, 'initial');
  assert.equal(next.countdownStepsRemaining, 64);
  assert.equal(next.blueScore, 8);
  assert.equal(next.orangeScore, 7);
  assert.equal(next.regulationStepsRemaining, 8_765);
  assert.equal(next.ball, state.ball);
  assert.equal(canAcceptRoomInput(next, 'host'), false);
  assert.deepEqual(visibleRosterEntries(next).map(({ sessionId }) => sessionId), ['alpha', 'zeta']);
  assert.ok([...next.roster.keys()].every((sessionId) => next.cars.has(sessionId)));
});

test('final leave clears Host, occupancy, body/input maps, and kickoff assignments', () => {
  const state = makeState(ROOM_POLICIES.custom, [
    rosterEntry('only', 0, 'blue', true),
  ]);
  const plan = expectPlan(state, { kind: 'leave', sessionId: 'only' });
  const preparation = prepareRoomMutation<TestCar, TestInput, TestBall, string>(plan, {
    prepareLeave: ({ car }) => ({
      commitRemoval: () => { car.disposed = true; },
    }),
  });
  assert.equal(preparation.ok, true, preparation.ok ? undefined : preparation.message);
  if (!preparation.ok) return;
  const committed = preparation.prepared.commit(state);
  assert.equal(committed.ok, true, committed.ok ? undefined : committed.message);
  if (!committed.ok) return;

  assert.equal(committed.next.roster.size, 0);
  assert.equal(committed.next.cars.size, 0);
  assert.equal(committed.next.inputs.size, 0);
  assert.equal(committed.next.kickoffAssignments.size, 0);
  assert.equal(committed.next.hostSessionId, null);
  assert.deepEqual(committed.next.occupancy, { total: 0, blue: 0, orange: 0 });
});

test('body-removal failure is fatal and never publishes a half-removed logical state', () => {
  const state = makeState(ROOM_POLICIES.custom, [
    rosterEntry('host', 0, 'blue', true),
  ]);
  const before = stateSnapshot(state);
  const plan = expectPlan(state, { kind: 'leave', sessionId: 'host' });
  const preparation = prepareRoomMutation<TestCar, TestInput, TestBall, string>(plan, {
    prepareLeave: () => ({
      commitRemoval: () => { throw new Error('world removal failed'); },
    }),
  });
  assert.equal(preparation.ok, true, preparation.ok ? undefined : preparation.message);
  if (!preparation.ok) return;

  assert.throws(() => preparation.prepared.commit(state), RoomMutationCommitError);
  assert.equal(preparation.prepared.settled, true);
  assertUnchanged(state, before);
});

// Validates: Requirements 4.10-4.12, 4.14-4.15

test('team switch and Host start validation commit only their intended logical effects', () => {
  const state = makeState(ROOM_POLICIES.custom, [
    rosterEntry('host', 0, 'blue', true),
    rosterEntry('guest', 1, 'blue'),
  ]);
  const hostCar = state.cars.get('host');
  const hostInput = state.inputs.get('host');
  const switchPlan = expectPlan(state, {
    kind: 'switch-team',
    sessionId: 'host',
    team: 'orange',
  });
  const switchPreparation = prepareRoomMutation<TestCar, TestInput, TestBall, string>(switchPlan);
  assert.equal(
    switchPreparation.ok,
    true,
    switchPreparation.ok ? undefined : switchPreparation.message,
  );
  if (!switchPreparation.ok) return;
  const switched = switchPreparation.prepared.commit(state);
  assert.equal(switched.ok, true, switched.ok ? undefined : switched.message);
  if (!switched.ok) return;

  assert.equal(switched.next.roster.get('host')?.team, 'orange');
  assert.equal(switched.next.roster.get('guest')?.team, 'blue');
  assert.equal(switched.next.hostSessionId, 'host');
  assert.equal(switched.next.roster.get('host')?.isHost, true);
  assert.deepEqual(switched.next.occupancy, { total: 2, blue: 1, orange: 1 });
  assert.equal(switched.next.cars.get('host'), hostCar);
  assert.equal(switched.next.inputs.get('host'), hostInput);
  assert.equal(switched.next.ball, state.ball);
  assert.equal(switched.next.blueScore, state.blueScore);
  assert.equal(switched.next.regulationStepsRemaining, state.regulationStepsRemaining);

  assert.equal(isCapacityValidRoster(ROOM_POLICIES.custom, switched.next.roster), true);
  const startPlan = expectPlan(switched.next, { kind: 'start', sessionId: 'host' });
  const startPreparation = prepareRoomMutation<TestCar, TestInput, TestBall, string>(startPlan);
  assert.equal(startPreparation.ok, true, startPreparation.ok ? undefined : startPreparation.message);
  if (!startPreparation.ok) return;
  const started = startPreparation.prepared.commit(switched.next);
  assert.equal(started.ok, true, started.ok ? undefined : started.message);
  if (!started.ok) return;

  assert.deepEqual(started.effect, { kind: 'start-validated', sessionId: 'host' });
  assert.equal(started.next.phase, 'waiting', 'Task 2.2 validates start; MatchFlow owns countdown');
  assert.equal(started.next.countdownKind, null);
  assert.equal(started.next.countdownStepsRemaining, 0);
  assert.deepEqual(
    { ...stateSnapshot(started.next), revision: 0 },
    { ...stateSnapshot(switched.next), revision: 0 },
    'validated start preserves all gameplay state until the fixed-step reducer consumes it',
  );
});

// Validates: Requirements 3.14, 4.18

test('explicit tombstoning immediately gates input and snapshot visibility before removal', () => {
  const state = makeState(ROOM_POLICIES.custom, [
    rosterEntry('host', 0, 'blue', true),
    rosterEntry('guest', 1, 'orange'),
  ]);
  assert.equal(canAcceptRoomInput(state, 'guest'), true);
  assert.deepEqual(visibleRosterEntries(state).map(({ sessionId }) => sessionId), ['host', 'guest']);

  const result = tombstoneRoomIdentity(state, 'guest');
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  if (!result.ok) return;

  assert.equal(result.next.roster.has('guest'), true, 'body removal may still be queued');
  assert.equal(result.next.cars.has('guest'), true);
  assert.equal(canAcceptRoomInput(result.next, 'guest'), false);
  assert.deepEqual(visibleRosterEntries(result.next).map(({ sessionId }) => sessionId), ['host']);
  assert.equal(canAcceptRoomInput(state, 'guest'), true, 'prior state remains immutable');
});
