import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPUT_PROTOCOL_VERSION,
  PHYSICS,
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
    fixedStep: () => { world.fixedSteps += 1; },
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
