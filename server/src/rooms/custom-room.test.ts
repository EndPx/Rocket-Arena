import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPUT_PROTOCOL_VERSION,
  PHYSICS,
  SNAPSHOT_PROTOCOL_VERSION,
  deserializeSnapshotEnvelopeV2,
  serializeSnapshotEnvelopeV2,
  type InputCommandV2,
  type RoomMutationErrorCode,
  type RosterEntry,
} from '@rocket-arena/shared';
import {
  createRoomMutationState,
  type RoomMutationRequest,
  type RoomMutationState,
} from '../systems/room-mutations.js';
import {
  createCustomRoomCore,
  CUSTOM_ROOM_POLICY,
  isCustomRoomCapacityValidRoster,
  isCustomRoomHostStartEligible,
} from './custom-room.js';
import {
  type AuthoritativeRoomCore,
  type AuthoritativeRoomMutationResult,
  type AuthoritativeRoomProjection,
  type AuthoritativeRoomWorldBundle,
} from './authoritative-room-core.js';

interface TestCar {
  readonly id: string;
  readonly position: [number, number, number];
  readonly rotation: [number, number, number, number];
  readonly linearVelocity: [number, number, number];
  readonly angularVelocity: [number, number, number];
  boost: number;
  removed: boolean;
}

interface TestBall {
  readonly position: [number, number, number];
  readonly rotation: [number, number, number, number];
  readonly linearVelocity: [number, number, number];
  readonly angularVelocity: [number, number, number];
}

interface TestWorld {
  readonly cars: Map<string, TestCar>;
  readonly removedSessionIds: string[];
  fixedSteps: number;
  disposeCount: number;
}

type TestCore = AuthoritativeRoomCore<TestWorld, TestCar, TestBall>;
type TestState = Readonly<
  RoomMutationState<TestCar, InputCommandV2, TestBall, string>
>;

function makeWorld(): TestWorld {
  return {
    cars: new Map(),
    removedSessionIds: [],
    fixedSteps: 0,
    disposeCount: 0,
  };
}

function makeBall(): TestBall {
  return {
    position: [0, 1, 0],
    rotation: [0, 0, 0, 1],
    linearVelocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  };
}

function neutralInput(): InputCommandV2 {
  return {
    protocolVersion: INPUT_PROTOCOL_VERSION,
    throttle: 0,
    steer: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    jumpHeld: false,
    jumpSequence: 0,
    boostHeld: false,
    powerslideHeld: false,
    cameraToggleSequence: 0,
  };
}

function makeBundle(
  world: TestWorld,
): AuthoritativeRoomWorldBundle<TestWorld, TestCar, TestBall> {
  const ball = makeBall();
  return {
    world,
    ball,
    mutationResources: {
      prepareJoin: ({ entry }, scope) => {
        const ordinal = entry.acceptedJoinOrdinal;
        const car = scope.track<TestCar>(
          {
            id: entry.sessionId,
            position: [ordinal, 0.5, entry.team === 'blue' ? -12 : 12],
            rotation: [0, entry.team === 'blue' ? 0 : 1, 0, entry.team === 'blue' ? 1 : 0],
            linearVelocity: [ordinal / 10, 0, 0],
            angularVelocity: [0, ordinal / 100, 0],
            boost: 33 + ordinal,
            removed: false,
          },
          (temporary) => {
            temporary.removed = true;
            world.cars.delete(temporary.id);
          },
        );
        world.cars.set(entry.sessionId, car);
        return { car, input: neutralInput() };
      },
      prepareLeave: ({ car }) => ({
        commitRemoval: () => {
          car.removed = true;
          world.cars.delete(car.id);
          world.removedSessionIds.push(car.id);
        },
      }),
    },
    prepareKickoffPlacement: ({ cars, assignmentSet }) => {
      const carSnapshots = new Map([...cars].map(([sessionId, car]) => [sessionId, {
        position: [...car.position] as [number, number, number],
        rotation: [...car.rotation] as [number, number, number, number],
        linearVelocity: [...car.linearVelocity] as [number, number, number],
        angularVelocity: [...car.angularVelocity] as [number, number, number],
      }]));
      const ballSnapshot = {
        position: [...ball.position] as [number, number, number],
        linearVelocity: [...ball.linearVelocity] as [number, number, number],
        angularVelocity: [...ball.angularVelocity] as [number, number, number],
      };
      return {
        apply: () => {
          ball.position.splice(0, 3, 0, 1, 0);
          ball.linearVelocity.splice(0, 3, 0, 0, 0);
          ball.angularVelocity.splice(0, 3, 0, 0, 0);
          for (const [sessionId, car] of cars) {
            const assignment = assignmentSet.assignments.get(sessionId);
            assert.ok(assignment);
            car.position.splice(0, 3, ...assignment.position);
            car.rotation.splice(0, 4, ...assignment.rotation);
            car.linearVelocity.splice(0, 3, 0, 0, 0);
            car.angularVelocity.splice(0, 3, 0, 0, 0);
          }
        },
        rollback: () => {
          ball.position.splice(0, 3, ...ballSnapshot.position);
          ball.linearVelocity.splice(0, 3, ...ballSnapshot.linearVelocity);
          ball.angularVelocity.splice(0, 3, ...ballSnapshot.angularVelocity);
          for (const [sessionId, snapshot] of carSnapshots) {
            const car = cars.get(sessionId)!;
            car.position.splice(0, 3, ...snapshot.position);
            car.rotation.splice(0, 4, ...snapshot.rotation);
            car.linearVelocity.splice(0, 3, ...snapshot.linearVelocity);
            car.angularVelocity.splice(0, 3, ...snapshot.angularVelocity);
          }
        },
      };
    },
    synchronizeCarInput: () => {},
    recoverBallBeforeStep: () => { world.fixedSteps += 1; },
    recoverCarBeforeStep: () => {},
    prepareGrounding: () => {},
    groundCar: () => ({ grounded: false, basis: null }),
    prepareCarCommand: () => ({ apply: () => {}, commit: () => {} }),
    stepWorld: () => {},
    recoverCarAfterStep: () => {},
    recoverBallAfterStep: () => {},
    extractMatchFlowInput: () => ({}),
    projectCar: ({ car }) => ({
      position: [...car.position],
      rotation: [...car.rotation],
      linearVelocity: [...car.linearVelocity],
      angularVelocity: [...car.angularVelocity],
      boost: car.boost,
    }),
    projectBall: ({ ball: authoritativeBall }) => ({
      position: [...authoritativeBall.position],
      rotation: [...authoritativeBall.rotation],
      linearVelocity: [...authoritativeBall.linearVelocity],
      angularVelocity: [...authoritativeBall.angularVelocity],
    }),
    dispose: () => { world.disposeCount += 1; },
  };
}

async function makeCore(): Promise<{ readonly core: TestCore; readonly world: TestWorld }> {
  const world = makeWorld();
  const core = createCustomRoomCore<TestWorld, TestCar, TestBall>({
    roomId: 'custom-room-test',
    initializeWorld: () => makeBundle(world),
    logger: { info: () => {}, error: () => {} },
  });
  await core.initialize();
  return { core, world };
}

async function commitMutation(
  core: TestCore,
  request: RoomMutationRequest,
): Promise<AuthoritativeRoomMutationResult> {
  const completion = core.queueMutation(request);
  const frame = core.advanceSimulation(PHYSICS.TIMESTEP * 1000);
  assert.equal(frame.scheduledFixedSteps, 1);
  return completion;
}

async function join(core: TestCore, sessionId: string): Promise<void> {
  const result = await commitMutation(core, {
    kind: 'join',
    sessionId,
    name: `Player ${sessionId}`,
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

function advanceFixedSteps(core: TestCore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const frame = core.advanceSimulation(PHYSICS.TIMESTEP * 1000);
    assert.equal(frame.scheduledFixedSteps, 1);
    assert.equal(frame.executedFixedSteps, 1);
  }
}

function projection(core: TestCore): Readonly<AuthoritativeRoomProjection> {
  const value = core.projectAuthoritativeState();
  assert.ok(value, 'ready Custom core must expose an authoritative projection');
  return value;
}

function internalState(core: TestCore): TestState {
  const value = (core as unknown as { stateValue: TestState | null }).stateValue;
  assert.ok(value, 'Custom core must retain its transactional state');
  return value;
}

function replaceCoreState(
  core: TestCore,
  update: (state: TestState) => TestState,
): void {
  const holder = core as unknown as { stateValue: TestState | null };
  assert.ok(holder.stateValue);
  holder.stateValue = update(holder.stateValue);
}

function stableEntries(
  roster: ReadonlyMap<string, Readonly<RosterEntry>>,
): readonly Readonly<RosterEntry>[] {
  return [...roster.values()].sort((left, right) => (
    left.acceptedJoinOrdinal - right.acceptedJoinOrdinal
    || left.sessionId.localeCompare(right.sessionId)
  ));
}

function rejectionPreservationSnapshot(core: TestCore) {
  const state = internalState(core);
  const projected = projection(core);
  const sortedPairs = <T>(values: ReadonlyMap<string, T>): readonly (readonly [string, T])[] => (
    [...values.entries()].sort(([left], [right]) => left.localeCompare(right))
  );

  return structuredClone({
    policy: state.policy,
    revision: state.revision,
    roster: stableEntries(state.roster),
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
    cars: sortedPairs(state.cars),
    inputs: sortedPairs(state.inputs),
    kickoffAssignments: sortedPairs(state.kickoffAssignments),
    tombstones: [...state.tombstones].sort(),
    projection: {
      policy: projected.policy,
      tuning: projected.tuning,
      revision: projected.revision,
      phase: projected.phase,
      countdownKind: projected.countdownKind,
      countdownStepsRemaining: projected.countdownStepsRemaining,
      regulationStepsRemaining: projected.regulationStepsRemaining,
      blueScore: projected.blueScore,
      orangeScore: projected.orangeScore,
      occupancy: projected.occupancy,
      hostSessionId: projected.hostSessionId,
      cars: projected.cars,
      ball: projected.ball,
    },
  });
}

async function assertRejectedWithoutMutation(
  core: TestCore,
  request: RoomMutationRequest,
  expectedCode: RoomMutationErrorCode,
): Promise<void> {
  const beforeProjection = projection(core);
  const before = rejectionPreservationSnapshot(core);
  const result = await commitMutation(core, request);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, expectedCode);
  assert.equal(result.fatal, false);

  const expected = structuredClone(before);
  if (beforeProjection.phase === 'countdown') {
    assert.ok(beforeProjection.countdownStepsRemaining > 1);
    expected.countdownStepsRemaining = beforeProjection.countdownStepsRemaining - 1;
    expected.projection.countdownStepsRemaining = beforeProjection.countdownStepsRemaining - 1;
  } else if (beforeProjection.phase === 'playing') {
    expected.regulationStepsRemaining = beforeProjection.regulationStepsRemaining - 1;
    expected.projection.regulationStepsRemaining = beforeProjection.regulationStepsRemaining - 1;
  }
  assert.deepEqual(
    rejectionPreservationSnapshot(core),
    expected,
    `${expectedCode} rejection must preserve authority apart from independent fixed-step clock progress`,
  );
}

function syntheticRoster(count: number, hostSessionId: string | null = null): Map<string, RosterEntry> {
  return new Map(Array.from({ length: count }, (_, index) => {
    const sessionId = `synthetic-${index}`;
    return [sessionId, {
      sessionId,
      acceptedJoinOrdinal: index,
      team: 'blue' as const,
      name: sessionId,
      isHost: sessionId === hostSessionId,
    }];
  }));
}

// Validates: Requirements 4.1-4.9, 18.15

test('Custom policy binds immutable 8/4 limits, sole first Host, and one-team-full assignment', async () => {
  const { core, world } = await makeCore();
  try {
    assert.equal(core.policy, CUSTOM_ROOM_POLICY);
    assert.ok(Object.isFrozen(core.policy));
    assert.deepEqual(
      {
        mode: core.policy.mode,
        totalCapacity: core.policy.totalCapacity,
        teamCapacity: core.policy.teamCapacity,
        startRule: core.policy.startRule,
        allowWaitingTeamSwitch: core.policy.allowWaitingTeamSwitch,
      },
      {
        mode: 'custom',
        totalCapacity: 8,
        teamCapacity: 4,
        startRule: 'host-request',
        allowWaitingTeamSwitch: true,
      },
    );
    assert.equal(core.isStartEligible, false);

    await join(core, 'player-0');
    let current = projection(core);
    assert.equal(current.hostSessionId, 'player-0');
    assert.deepEqual(
      current.cars.map(({ sessionId, team, isHost }) => ({ sessionId, team, isHost })),
      [{ sessionId: 'player-0', team: 'blue', isHost: true }],
    );
    assert.equal(core.isStartEligible, true);
    assert.equal(isCustomRoomCapacityValidRoster(internalState(core).roster), true);
    assert.equal(isCustomRoomHostStartEligible(internalState(core), 'player-0'), true);

    for (let index = 1; index < 7; index += 1) await join(core, `player-${index}`);
    current = projection(core);
    assert.deepEqual(current.occupancy, { total: 7, blue: 4, orange: 3 });
    assert.equal(current.cars.filter(({ isHost }) => isHost).length, 1);
    assert.equal(current.hostSessionId, 'player-0');

    await join(core, 'player-7');
    current = projection(core);
    assert.deepEqual(current.occupancy, { total: 8, blue: 4, orange: 4 });
    assert.equal(current.cars.at(-1)?.sessionId, 'player-7');
    assert.equal(
      current.cars.at(-1)?.team,
      'orange',
      'when Blue is full, the eighth accepted identity must use available Orange capacity',
    );
    assert.deepEqual(
      current.cars.map(({ team }) => team),
      ['blue', 'orange', 'blue', 'orange', 'blue', 'orange', 'blue', 'orange'],
    );
    assert.equal(world.cars.size, 8);
  } finally {
    core.dispose();
  }
});

// Validates: Requirements 4.3, 4.9, 18.15

test('duplicate and ninth-player joins reject without any partial authoritative mutation', async (t) => {
  await t.test('duplicate identity', async () => {
    const { core } = await makeCore();
    try {
      await join(core, 'duplicate');
      await assertRejectedWithoutMutation(
        core,
        { kind: 'join', sessionId: 'duplicate', name: 'Duplicate Again' },
        'duplicate-identity',
      );
    } finally {
      core.dispose();
    }
  });

  await t.test('ninth identity at total capacity', async () => {
    const { core, world } = await makeCore();
    try {
      for (let index = 0; index < 8; index += 1) await join(core, `full-${index}`);
      await assertRejectedWithoutMutation(
        core,
        { kind: 'join', sessionId: 'ninth', name: 'Ninth' },
        'total-capacity',
      );
      assert.equal(world.cars.has('ninth'), false);
      assert.equal(world.cars.size, 8);
    } finally {
      core.dispose();
    }
  });
});

// Validates: Requirements 4.10-4.12, 18.15

test('waiting-only opposite-team switches are atomic and reject a full destination', async (t) => {
  await t.test('valid opposite-team switch changes only the requester', async () => {
    const { core } = await makeCore();
    try {
      await join(core, 'host');
      await join(core, 'guest');
      const before = projection(core);
      const guestBefore = before.cars.find(({ sessionId }) => sessionId === 'guest');

      const result = await commitMutation(core, {
        kind: 'switch-team',
        sessionId: 'host',
        team: 'orange',
      });
      assert.equal(result.ok, true, result.ok ? undefined : result.message);
      if (!result.ok) return;
      assert.deepEqual(result.effect, {
        kind: 'team-switched',
        sessionId: 'host',
        from: 'blue',
        to: 'orange',
      });

      const after = projection(core);
      assert.deepEqual(after.occupancy, { total: 2, blue: 0, orange: 2 });
      assert.equal(after.hostSessionId, 'host');
      assert.equal(after.cars.find(({ sessionId }) => sessionId === 'host')?.isHost, true);
      assert.deepEqual(after.cars.find(({ sessionId }) => sessionId === 'guest'), guestBefore);
      assert.equal(after.phase, 'waiting');

      await assertRejectedWithoutMutation(
        core,
        { kind: 'switch-team', sessionId: 'host', team: 'orange' },
        'not-opposite-team',
      );

      const started = await commitMutation(core, { kind: 'start', sessionId: 'host' });
      assert.equal(started.ok, true, started.ok ? undefined : started.message);
      assert.equal(projection(core).phase, 'countdown');
      assert.equal(projection(core).countdownStepsRemaining, 180);
      await assertRejectedWithoutMutation(
        core,
        { kind: 'switch-team', sessionId: 'host', team: 'blue' },
        'wrong-phase',
      );
    } finally {
      core.dispose();
    }
  });

  await t.test('full destination rejects with all roster, Host, phase, body, and timer state intact', async () => {
    const { core } = await makeCore();
    try {
      for (let index = 0; index < 7; index += 1) await join(core, `switch-${index}`);
      assert.deepEqual(projection(core).occupancy, { total: 7, blue: 4, orange: 3 });
      await assertRejectedWithoutMutation(
        core,
        { kind: 'switch-team', sessionId: 'switch-1', team: 'blue' },
        'team-capacity',
      );
    } finally {
      core.dispose();
    }
  });
});

// Validates: Requirements 4.13-4.15, 13.5-13.7, 18.15

test('only the current Host starts one full fixed-step countdown and rejections are atomic', async () => {
  const { core } = await makeCore();
  try {
    await join(core, 'host');
    await join(core, 'guest');
    assert.equal(core.isStartEligible, true);
    assert.equal(isCustomRoomHostStartEligible(internalState(core), 'host'), true);
    assert.equal(isCustomRoomHostStartEligible(internalState(core), 'guest'), false);
    assert.equal(isCustomRoomCapacityValidRoster(new Map()), false);
    assert.equal(isCustomRoomCapacityValidRoster(syntheticRoster(5)), false);

    await assertRejectedWithoutMutation(
      core,
      { kind: 'start', sessionId: 'guest' },
      'not-host',
    );

    const accepted = await commitMutation(core, { kind: 'start', sessionId: 'host' });
    assert.equal(accepted.ok, true, accepted.ok ? undefined : accepted.message);
    if (!accepted.ok) return;
    assert.deepEqual(accepted.effect, { kind: 'start-validated', sessionId: 'host' });
    assert.equal(projection(core).phase, 'countdown');
    assert.equal(projection(core).countdownKind, 'initial');
    assert.equal(projection(core).countdownStepsRemaining, 180);
    assert.equal(projection(core).regulationStepsRemaining, 18_000);
    assert.equal(core.isStartEligible, false);
    assert.equal(isCustomRoomHostStartEligible(internalState(core), 'host'), false);

    await assertRejectedWithoutMutation(
      core,
      { kind: 'start', sessionId: 'host' },
      'wrong-phase',
    );
    assert.equal(projection(core).phase, 'countdown');
    assert.equal(projection(core).countdownStepsRemaining, 179);
  } finally {
    core.dispose();
  }
});

// Validates: Requirements 4.16-4.19, 18.15

test('Host leave during countdown preserves progress and chooses the earliest stable successor', async () => {
  const { core, world } = await makeCore();
  try {
    await join(core, 'host');
    await join(core, 'second');
    await join(core, 'third');
    const teamsBefore = new Map(projection(core).cars.map(({ sessionId, team }) => [sessionId, team]));
    const started = await commitMutation(core, { kind: 'start', sessionId: 'host' });
    assert.equal(started.ok, true, started.ok ? undefined : started.message);
    assert.equal(projection(core).countdownStepsRemaining, 180);
    advanceFixedSteps(core, 23);
    const countdownBeforeLeave = projection(core).countdownStepsRemaining;
    assert.equal(countdownBeforeLeave, 157);

    replaceCoreState(core, (state) => {
      const reordered = new Map<string, RosterEntry>();
      for (const sessionId of ['third', 'host', 'second']) {
        const entry = state.roster.get(sessionId);
        assert.ok(entry);
        reordered.set(sessionId, entry);
      }
      return createRoomMutationState({ ...state, roster: reordered });
    });

    const removedCar = world.cars.get('host');
    assert.ok(removedCar);
    const result = await commitMutation(core, { kind: 'leave', sessionId: 'host' });
    assert.equal(result.ok, true, result.ok ? undefined : result.message);
    if (!result.ok) return;
    assert.deepEqual(result.effect, {
      kind: 'left',
      sessionId: 'host',
      successorHostSessionId: 'second',
    });

    const after = projection(core);
    assert.equal(after.hostSessionId, 'second');
    assert.equal(after.phase, 'countdown');
    assert.equal(after.countdownKind, 'initial');
    assert.equal(
      after.countdownStepsRemaining,
      countdownBeforeLeave - 1,
      'Host succession preserves the countdown while its enclosing fixed step advances once',
    );
    assert.deepEqual(
      after.cars.filter(({ isHost }) => isHost).map(({ sessionId }) => sessionId),
      ['second'],
    );
    assert.deepEqual(after.cars.map(({ sessionId }) => sessionId), ['second', 'third']);
    for (const car of after.cars) assert.equal(car.team, teamsBefore.get(car.sessionId));
    assert.deepEqual(after.occupancy, { total: 2, blue: 1, orange: 1 });
    assert.deepEqual(world.removedSessionIds, ['host']);
    assert.equal(removedCar.removed, true);
    assert.equal(world.cars.size, 2);
  } finally {
    core.dispose();
  }
});

// Validates: Requirements 4.18-4.20

test('final leave clears roster, Host, occupancy, cars, inputs, kickoff assignments, and world once', async () => {
  const { core, world } = await makeCore();
  await join(core, 'only-host');
  replaceCoreState(core, (state) => createRoomMutationState({
    ...state,
    kickoffAssignments: new Map([['only-host', 'legacy-slot']]),
  }));

  const result = await commitMutation(core, { kind: 'leave', sessionId: 'only-host' });
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  if (!result.ok) return;
  assert.deepEqual(result.effect, {
    kind: 'left',
    sessionId: 'only-host',
    successorHostSessionId: null,
  });

  const state = internalState(core);
  assert.equal(core.lifecycle, 'disposed');
  assert.equal(core.projectAuthoritativeState(), null);
  assert.equal(state.roster.size, 0);
  assert.equal(state.hostSessionId, null);
  assert.deepEqual(state.occupancy, { total: 0, blue: 0, orange: 0 });
  assert.equal(state.cars.size, 0);
  assert.equal(state.inputs.size, 0);
  assert.equal(state.kickoffAssignments.size, 0);
  assert.equal(state.tombstones.size, 0);
  assert.deepEqual(core.diagnostics.rosterSessionIds, []);
  assert.deepEqual(core.diagnostics.bodySessionIds, []);
  assert.deepEqual(core.diagnostics.inputSessionIds, []);
  assert.equal(core.diagnostics.kickoffAssignmentCount, 0);
  assert.deepEqual(world.removedSessionIds, ['only-host']);
  assert.equal(world.cars.size, 0);
  assert.equal(world.disposeCount, 1);

  core.dispose();
  assert.equal(world.disposeCount, 1, 'cleanup remains idempotent after empty-room disposal');
});

// Validates: Requirements 6.2-6.8, 18.17

test('Custom core produces full-capacity V2 snapshots and omits a tombstoned leave next', async () => {
  const { core } = await makeCore();
  try {
    for (let index = 0; index < 8; index += 1) await join(core, `transport-${index}`);

    const full = core.buildSnapshotV2(projection(core), 10_000);
    assert.ok(full);
    assert.equal(full.protocolVersion, SNAPSHOT_PROTOCOL_VERSION);
    assert.equal(full.roomMode, 'custom');
    assert.equal(full.totalCapacity, 8);
    assert.equal(full.teamCapacity, 4);
    assert.equal(full.sequence, 0);
    assert.equal(full.cars.length, 8);
    assert.equal(new Set(full.cars.map((car) => car.sessionId)).size, 8);
    assert.equal('players' in (full as unknown as Record<string, unknown>), false);
    assert.equal(
      full.cars.filter((car) => car.isHost).map((car) => car.sessionId).join(','),
      'transport-0',
    );

    const roundTripped = deserializeSnapshotEnvelopeV2(serializeSnapshotEnvelopeV2(full));
    assert.deepEqual(roundTripped, full);

    const leaveCompletion = core.queueMutation({
      kind: 'leave',
      sessionId: 'transport-3',
    });
    const next = core.buildSnapshotV2(projection(core), 10_033);
    assert.ok(next);
    assert.equal(next.sequence, 1);
    assert.equal(next.cars.length, 7);
    assert.equal(next.cars.some((car) => car.sessionId === 'transport-3'), false);
    assert.deepEqual(
      next.cars.map((car) => car.sessionId),
      full.cars
        .filter((car) => car.sessionId !== 'transport-3')
        .map((car) => car.sessionId),
    );

    const frame = core.advanceSimulation(PHYSICS.TIMESTEP * 1000);
    assert.equal(frame.scheduledFixedSteps, 1);
    const leaveResult = await leaveCompletion;
    assert.equal(leaveResult.ok, true, leaveResult.ok ? undefined : leaveResult.message);
  } finally {
    core.dispose();
  }
});

interface CustomAdapterBroadcast {
  readonly type: string | number | object;
  readonly message: unknown;
}

interface CustomAdapterClient {
  readonly sessionId: string;
  readonly sent: Array<readonly [string, unknown]>;
  send(type: string, message: unknown): void;
}

function customAdapterClient(sessionId: string): CustomAdapterClient {
  const sent: Array<readonly [string, unknown]> = [];
  return {
    sessionId,
    sent,
    send(type, message) {
      sent.push([type, message]);
    },
  };
}

async function createCustomAdapterHarness(core: unknown) {
  const { CustomRoom } = await import('./custom-room.js');

  class CustomAdapterHarness extends CustomRoom {
    simulationCallback: ((deltaTimeMs: number) => void) | null = null;
    simulationDelayMs: number | null = null;
    publicationError: Error | null = null;
    broadcastAttempts = 0;
    readonly broadcasts: CustomAdapterBroadcast[] = [];
    readonly metadataUpdates: Array<Record<string, unknown>> = [];

    constructor() {
      super();
      this.autoDispose = false;
    }

    protected override createAuthoritativeCore(): never {
      return core as never;
    }

    override setPatchRate(_milliseconds: number | null): void {
      // Avoid framework timers; onCreate still crosses the real adapter method.
    }

    override setSimulationInterval(
      callback?: (deltaTimeMs: number) => void,
      delay?: number,
    ): void {
      this.simulationCallback = callback ?? null;
      this.simulationDelayMs = delay ?? null;
    }

    override setMetadata(meta: Record<string, unknown>): Promise<void> {
      this.metadataUpdates.push({ ...meta });
      return Promise.resolve();
    }

    override broadcast(
      typeOrSchema: string | number | object,
      message?: unknown,
    ): any {
      this.broadcastAttempts += 1;
      if (this.publicationError !== null) throw this.publicationError;
      this.broadcasts.push({ type: typeOrSchema, message });
    }

    tick(deltaTimeMs: number): void {
      assert.ok(this.simulationCallback, 'CustomRoom must install one simulation callback');
      this.simulationCallback(deltaTimeMs);
    }
  }

  const room = new CustomAdapterHarness();
  room.roomId = 'custom-room-test';
  room.onCreate({});
  await Promise.resolve();
  return room;
}

function staleCustomSnapshotPort(core: TestCore) {
  let buildCalls = 0;
  return {
    get buildCalls(): number {
      return buildCalls;
    },
    get lifecycle() {
      return core.lifecycle;
    },
    initialize: () => core.initialize(),
    submitInput: core.submitInput.bind(core),
    queueMutation: core.queueMutation.bind(core),
    advanceSimulation: core.advanceSimulation.bind(core),
    projectAuthoritativeState: core.projectAuthoritativeState.bind(core),
    buildSnapshotV2(value: Readonly<AuthoritativeRoomProjection>, serverTime: number) {
      buildCalls += 1;
      return core.buildSnapshotV2(Object.freeze({
        ...value,
        revision: value.revision + 1,
      }), serverTime);
    },
    failSnapshotPublication: core.failSnapshotPublication.bind(core),
    dispose: core.dispose.bind(core),
  };
}

// Validates: Requirements 4.1-4.20, 6.2-6.8, 18.15, 18.17

test('CustomRoom production adapter publishes maximum capacity and omits the next disconnect', async () => {
  const { core, world } = await makeCore();
  const room = await createCustomAdapterHarness(core);
  const clients = Array.from({ length: 8 }, (_, index) => (
    customAdapterClient(`adapter-${index}`)
  ));

  try {
    assert.equal(room.maxClients, CUSTOM_ROOM_POLICY.totalCapacity);
    assert.equal(room.simulationDelayMs, PHYSICS.TIMESTEP * 1000);
    assert.equal(room.metadataUpdates.length, 1);
    assert.match(String(room.metadataUpdates[0]?.code), /^[A-HJ-NP-Z2-9]{6}$/);

    const joins = clients.map((client, index) => room.onJoin(
      client as never,
      { name: `Adapter Player ${index}` },
    ));
    room.tick(PHYSICS.TIMESTEP * 1000);
    await Promise.all(joins);

    assert.deepEqual(
      {
        total: room.state.totalOccupancy,
        blue: room.state.blueOccupancy,
        orange: room.state.orangeOccupancy,
      },
      { total: 8, blue: 4, orange: 4 },
    );
    assert.equal(room.state.hostSessionId, 'adapter-0');
    assert.equal(room.broadcasts.length, 1);
    const full = room.broadcasts[0]?.message as any;
    assert.equal(full.protocolVersion, SNAPSHOT_PROTOCOL_VERSION);
    assert.equal(full.roomMode, 'custom');
    assert.equal(full.totalCapacity, 8);
    assert.equal(full.teamCapacity, 4);
    assert.equal(full.cars.length, 8);
    assert.equal(new Set(full.cars.map((car: any) => car.sessionId)).size, 8);
    assert.deepEqual(
      full.cars.filter((car: any) => car.isHost).map((car: any) => car.sessionId),
      ['adapter-0'],
    );
    assert.equal('players' in full, false);

    const ninth = customAdapterClient('adapter-8');
    const rejectedJoin = assert.rejects(
      room.onJoin(ninth as never, { name: 'Ninth Adapter Player' }),
      /total-capacity/,
    );
    room.tick(PHYSICS.TIMESTEP * 1000);
    await rejectedJoin;
    assert.equal(world.cars.has('adapter-8'), false);
    assert.equal(ninth.sent[0]?.[0], 'room-rejection');

    const leave = room.onLeave(clients[3] as never);
    room.tick(PHYSICS.TIMESTEP * 1000);
    await leave;

    assert.equal(room.broadcasts.length, 2, 'the disconnect boundary reaches the next due V2 frame');
    const afterLeave = room.broadcasts[1]?.message as any;
    assert.equal(afterLeave.sequence, full.sequence + 1);
    assert.equal(afterLeave.cars.length, 7);
    assert.equal(afterLeave.cars.some((car: any) => car.sessionId === 'adapter-3'), false);
    assert.deepEqual(
      afterLeave.cars.map((car: any) => car.sessionId),
      full.cars
        .filter((car: any) => car.sessionId !== 'adapter-3')
        .map((car: any) => car.sessionId),
    );
    assert.equal(room.state.totalOccupancy, 7);
    assert.deepEqual(world.removedSessionIds, ['adapter-3']);
  } finally {
    room.onDispose();
  }
  assert.equal(world.disposeCount, 1);
});

test('CustomRoom production adapter fails closed on build and publication errors', async (t) => {
  await t.test('builder failure closes the real adapter before any publication', async () => {
    const { core, world } = await makeCore();
    const port = staleCustomSnapshotPort(core);
    const room = await createCustomAdapterHarness(port);
    try {
      assert.doesNotThrow(() => { room.tick(0); });
      assert.equal(port.buildCalls, 1);
      assert.equal(room.broadcastAttempts, 0);
      assert.equal(core.lifecycle, 'fatal');
      assert.match(core.fatalError?.message ?? '', /snapshot build failed/i);
      assert.equal(world.disposeCount, 1);

      room.tick(1000);
      assert.equal(port.buildCalls, 1);
      assert.equal(room.broadcastAttempts, 0);
      assert.equal(world.fixedSteps, 0);
    } finally {
      room.onDispose();
    }
    assert.equal(world.disposeCount, 1);
  });

  await t.test('serializer failure is swallowed and fatalizes the real adapter once', async () => {
    const { core, world } = await makeCore();
    const room = await createCustomAdapterHarness(core);
    const publicationError = new Error('injected CustomRoom serializer failure');
    room.publicationError = publicationError;
    try {
      assert.doesNotThrow(() => { room.tick(0); });
      assert.equal(room.broadcastAttempts, 1);
      assert.equal(room.broadcasts.length, 0);
      assert.equal(core.lifecycle, 'fatal');
      assert.strictEqual(core.fatalError?.cause, publicationError);
      assert.match(core.fatalError?.message ?? '', /snapshot publication failed/i);
      assert.equal(world.disposeCount, 1);

      room.tick(1000);
      assert.equal(room.broadcastAttempts, 1, 'fatal rooms cannot attempt a later publication');
      assert.equal(world.fixedSteps, 0, 'fatal rooms cannot execute later simulation work');
    } finally {
      room.onDispose();
    }
    assert.equal(world.disposeCount, 1);
  });
});

test('CustomRoom forwards repeated terminal snapshots without changing terminal event identity', async () => {
  const { SnapshotBuilder } = await import('../systems/snapshot-builder.js');
  const { core } = await makeCore();
  const baseProjection = projection(core);
  const builder = new SnapshotBuilder({ policy: CUSTOM_ROOM_POLICY });
  const terminalTransition = builder.commitTransition({
    kind: 'hard-cutoff',
    winner: 'blue',
    blueScore: 5,
    orangeScore: 4,
  });
  assert.ok(terminalTransition.terminal);
  let simulationTime = 1_000;
  const terminalProjection = Object.freeze({
    ...baseProjection,
    phase: 'ended' as const,
    countdownKind: null,
    phaseSecondsRemaining: 0,
    countdownStepsRemaining: 0,
    goalResetStepsRemaining: 0,
    regulationStepsRemaining: 0,
    regulationActivePlayStepsCompleted: baseProjection.regulationStepsRemaining,
    regulationStarted: true,
    regulationCutoffResolved: true,
    blueScore: 5,
    orangeScore: 4,
    winner: terminalTransition.terminal.winner,
    terminalResult: terminalTransition.terminal,
    latestTransition: terminalTransition,
    transitionSequence: terminalTransition.eventId,
  });
  const port = {
    lifecycle: 'ready' as const,
    initialize: () => Promise.resolve(),
    advanceSimulation: () => ({ snapshotDue: true }),
    projectAuthoritativeState: () => terminalProjection,
    buildSnapshotV2: (_value: Readonly<AuthoritativeRoomProjection>, serverTime: number) => {
      const snapshot = builder.build({
        serverTime,
        simulationTime,
        phase: 'ended',
        countdownKind: null,
        phaseSecondsRemaining: 0,
        regulationSecondsRemaining: 0,
        kickoffEpoch: 0,
        blueScore: 5,
        orangeScore: 4,
        winner: 'blue',
        roster: [],
        cars: new Map(),
        ball: {
          position: terminalProjection.ball.position,
          rotation: terminalProjection.ball.rotation,
          linearVelocity: terminalProjection.ball.linearVelocity,
        },
      });
      simulationTime += PHYSICS.TIMESTEP * 1000;
      return snapshot;
    },
    failSnapshotPublication: () => { assert.fail('terminal publication should succeed'); },
    dispose: () => { core.dispose(); },
  };
  const room = await createCustomAdapterHarness(port);

  try {
    room.tick(0);
    room.tick(0);
    assert.equal(room.broadcasts.length, 2);
    const first = room.broadcasts[0]?.message as any;
    const second = room.broadcasts[1]?.message as any;
    assert.equal(second.sequence, first.sequence + 1);
    assert.equal(second.blueScore, first.blueScore);
    assert.equal(second.orangeScore, first.orangeScore);
    assert.equal(second.winner, first.winner);
    assert.deepEqual(second.terminalResult, first.terminalResult);
    assert.deepEqual(second.latestTransition, first.latestTransition);
    assert.equal(second.terminalResult.eventId, second.latestTransition.eventId);
  } finally {
    room.onDispose();
  }
});