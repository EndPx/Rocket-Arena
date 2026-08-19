import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPUT_PROTOCOL_VERSION,
  PHYSICS,
  SNAPSHOT_PROTOCOL_VERSION,
  type InputCommandV2,
  type RoomMutationErrorCode,
} from '@rocket-arena/shared';
import {
  type RoomMutationRequest,
  type RoomMutationState,
} from '../systems/room-mutations.js';
import {
  createQuickMatchCore,
  QUICK_MATCH_POLICY,
} from './arena-room.js';
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
            position: [ordinal, 0.5, entry.team === 'blue' ? -10 : 10],
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
  const core = createQuickMatchCore<TestWorld, TestCar, TestBall>({
    roomId: 'quick-room-test',
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
  assert.equal(frame.executedFixedSteps, 1);
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
  assert.ok(value, 'ready Quick core must expose an authoritative projection');
  return value;
}

function rejectionPreservationSnapshot(value: Readonly<AuthoritativeRoomProjection>) {
  return structuredClone({
    policy: value.policy,
    tuning: value.tuning,
    revision: value.revision,
    phase: value.phase,
    countdownKind: value.countdownKind,
    countdownStepsRemaining: value.countdownStepsRemaining,
    regulationStepsRemaining: value.regulationStepsRemaining,
    blueScore: value.blueScore,
    orangeScore: value.orangeScore,
    occupancy: value.occupancy,
    hostSessionId: value.hostSessionId,
    cars: value.cars,
    ball: value.ball,
  });
}

async function assertRejectedWithoutMutation(
  core: TestCore,
  request: RoomMutationRequest,
  expectedCode: RoomMutationErrorCode,
): Promise<void> {
  const beforeProjection = projection(core);
  const before = rejectionPreservationSnapshot(beforeProjection);
  const result = await commitMutation(core, request);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, expectedCode);
  assert.equal(result.fatal, false);

  const expected = structuredClone(before);
  if (beforeProjection.phase === 'countdown') {
    assert.ok(beforeProjection.countdownStepsRemaining > 1);
    expected.countdownStepsRemaining = beforeProjection.countdownStepsRemaining - 1;
  } else if (beforeProjection.phase === 'playing') {
    expected.regulationStepsRemaining = beforeProjection.regulationStepsRemaining - 1;
  }
  assert.deepEqual(
    rejectionPreservationSnapshot(projection(core)),
    expected,
    `${expectedCode} rejection must preserve authority apart from independent fixed-step clock progress`,
  );
}

// Validates: Requirements 3.1-3.10, 13.5-13.7, 18.12-18.13

test('Quick policy binds 6/3 and starts exactly one 180-step countdown only at balanced 3+3', async () => {
  const { core, world } = await makeCore();
  try {
    assert.equal(core.policy, QUICK_MATCH_POLICY);
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
        mode: 'quick',
        totalCapacity: 6,
        teamCapacity: 3,
        startRule: 'full-balanced',
        allowWaitingTeamSwitch: false,
      },
    );

    const expectedTeams = ['blue', 'orange', 'blue', 'orange', 'blue', 'orange'];
    for (let index = 0; index < expectedTeams.length; index += 1) {
      await join(core, `player-${index}`);
      const current = projection(core);
      assert.deepEqual(
        current.cars.map(({ sessionId, acceptedJoinOrdinal, team }) => ({
          sessionId,
          acceptedJoinOrdinal,
          team,
        })),
        expectedTeams.slice(0, index + 1).map((team, ordinal) => ({
          sessionId: `player-${ordinal}`,
          acceptedJoinOrdinal: ordinal,
          team,
        })),
      );
      assert.ok(Math.abs(current.occupancy.blue - current.occupancy.orange) <= 1);
      assert.ok(current.occupancy.blue <= 3);
      assert.ok(current.occupancy.orange <= 3);
      assert.equal(core.isStartEligible, false);
      if (index < expectedTeams.length - 1) {
        assert.equal(current.phase, 'waiting');
        assert.equal(current.countdownKind, null);
        assert.equal(current.countdownStepsRemaining, 0);
      } else {
        assert.equal(current.phase, 'countdown');
        assert.equal(current.countdownKind, 'initial');
        assert.equal(current.countdownStepsRemaining, 180);
      }
    }

    const full = projection(core);
    assert.deepEqual(full.occupancy, { total: 6, blue: 3, orange: 3 });
    assert.equal(full.phase, 'countdown');
    assert.equal(full.countdownKind, 'initial');
    assert.equal(full.countdownStepsRemaining, 180);
    assert.equal(full.regulationStepsRemaining, 18_000);
    assert.equal(world.cars.size, 6);

    advanceFixedSteps(core, 179);
    const finalCountdownStep = projection(core);
    assert.equal(finalCountdownStep.phase, 'countdown');
    assert.equal(finalCountdownStep.countdownStepsRemaining, 1);
    assert.equal(finalCountdownStep.regulationStepsRemaining, 18_000);

    advanceFixedSteps(core, 1);
    const active = projection(core);
    assert.equal(active.phase, 'playing');
    assert.equal(active.countdownKind, null);
    assert.equal(active.countdownStepsRemaining, 0);
    assert.equal(active.regulationStepsRemaining, 18_000);
  } finally {
    core.dispose();
  }
});

// Validates: Requirements 3.2, 3.8

test('duplicate and seventh-player requests reject with complete state preservation', async (t) => {
  await t.test('duplicate identity', async () => {
    const { core } = await makeCore();
    try {
      await join(core, 'duplicate');
      await assertRejectedWithoutMutation(
        core,
        { kind: 'join', sessionId: 'duplicate', name: 'Duplicate Again' },
        'duplicate-identity',
      );
      assert.equal(core.isStartEligible, false);
    } finally {
      core.dispose();
    }
  });

  await t.test('seventh identity at total capacity', async () => {
    const { core, world } = await makeCore();
    try {
      for (let index = 0; index < 6; index += 1) await join(core, `full-${index}`);
      assert.equal(projection(core).phase, 'countdown');
      assert.equal(projection(core).countdownStepsRemaining, 180);
      await assertRejectedWithoutMutation(
        core,
        { kind: 'join', sessionId: 'seventh', name: 'Seventh' },
        'total-capacity',
      );
      assert.equal(projection(core).phase, 'countdown');
      assert.equal(projection(core).countdownStepsRemaining, 179);
      assert.equal(world.cars.has('seventh'), false);
      assert.equal(world.cars.size, 6);
    } finally {
      core.dispose();
    }
  });
});

// Validates: Requirements 3.1, 3.11-3.13, 18.13

test('pre-active leave cancels Quick countdown, reopens admission, and restarts all 180 steps', async () => {
  const { core, world } = await makeCore();
  try {
    for (let index = 0; index < 6; index += 1) await join(core, `waiting-${index}`);
    assert.equal(projection(core).countdownStepsRemaining, 180);
    advanceFixedSteps(core, 37);
    assert.equal(projection(core).countdownStepsRemaining, 143);
    const before = projection(core);
    const beforeAssignments = new Map(before.cars.map((car) => [car.sessionId, car.team]));
    const removedCar = world.cars.get('waiting-3');
    assert.ok(removedCar);

    const result = await commitMutation(core, { kind: 'leave', sessionId: 'waiting-3' });
    assert.equal(result.ok, true, result.ok ? undefined : result.message);
    if (!result.ok) return;
    assert.deepEqual(result.effect, {
      kind: 'left',
      sessionId: 'waiting-3',
      successorHostSessionId: null,
    });

    const after = projection(core);
    assert.deepEqual(after.occupancy, { total: 5, blue: 3, orange: 2 });
    assert.equal(after.phase, 'waiting');
    assert.equal(after.countdownKind, null);
    assert.equal(after.countdownStepsRemaining, 0);
    assert.equal(core.isStartEligible, false);
    assert.equal(after.cars.some(({ sessionId }) => sessionId === 'waiting-3'), false);
    assert.deepEqual(world.removedSessionIds, ['waiting-3']);
    assert.equal(removedCar.removed, true);
    assert.equal(world.cars.size, 5);

    for (const car of after.cars) {
      assert.equal(car.team, beforeAssignments.get(car.sessionId));
    }

    await join(core, 'replacement');
    const restored = projection(core);
    assert.deepEqual(restored.occupancy, { total: 6, blue: 3, orange: 3 });
    assert.equal(restored.phase, 'countdown');
    assert.equal(restored.countdownKind, 'initial');
    assert.equal(restored.countdownStepsRemaining, 180);
    assert.equal(restored.cars.at(-1)?.sessionId, 'replacement');
    assert.equal(restored.cars.at(-1)?.team, 'orange');
    assert.equal(core.isStartEligible, false);
    for (const car of restored.cars.filter(({ sessionId }) => sessionId !== 'replacement')) {
      assert.equal(car.team, beforeAssignments.get(car.sessionId));
    }
  } finally {
    core.dispose();
  }
});

// Validates: Requirements 3.14-3.15, 18.14

test('active-play disconnect removes only one identity and preserves all remaining authority', async () => {
  const { core, world } = await makeCore();
  try {
    for (let index = 0; index < 6; index += 1) await join(core, `active-${index}`);
    assert.equal(projection(core).countdownStepsRemaining, 180);
    advanceFixedSteps(core, 180);
    assert.equal(projection(core).phase, 'playing');

    const authoritativeBall = projection(core).ball;
    const internalBall = (core as unknown as { stateValue: TestState }).stateValue.ball;
    internalBall.position.splice(0, 3, 7, 8, 9);
    internalBall.linearVelocity.splice(0, 3, 1, 2, 3);
    for (const [index, car] of [...world.cars.values()].entries()) {
      car.position.splice(0, 3, index + 10, index + 20, index + 30);
      car.linearVelocity.splice(0, 3, index / 2, index / 3, index / 4);
      car.boost = 70 - index;
    }
    assert.notDeepEqual(internalBall.position, authoritativeBall.position);

    const before = projection(core);
    const expectedBall = {
      position: [...internalBall.position],
      rotation: [...internalBall.rotation],
      linearVelocity: [...internalBall.linearVelocity],
      angularVelocity: [...internalBall.angularVelocity],
    };
    const expectedCars = before.cars
      .filter(({ sessionId }) => sessionId !== 'active-2')
      .map((car) => {
        const body = world.cars.get(car.sessionId);
        assert.ok(body);
        return {
          ...car,
          position: [...body.position],
          rotation: [...body.rotation],
          linearVelocity: [...body.linearVelocity],
          angularVelocity: [...body.angularVelocity],
          boost: body.boost,
        };
      });
    assert.equal(core.isStartEligible, false, 'active play never reopens the pre-play start gate');
    const removedCar = world.cars.get('active-2');
    assert.ok(removedCar);

    const result = await commitMutation(core, { kind: 'leave', sessionId: 'active-2' });
    assert.equal(result.ok, true, result.ok ? undefined : result.message);
    const after = projection(core);

    assert.equal(after.phase, 'playing');
    assert.equal(after.blueScore, before.blueScore);
    assert.equal(after.orangeScore, before.orangeScore);
    assert.equal(
      after.regulationStepsRemaining,
      before.regulationStepsRemaining - 1,
      'the disconnect does not reset regulation; the enclosing Active_Play step advances normally',
    );
    assert.equal(after.countdownKind, before.countdownKind);
    assert.equal(after.countdownStepsRemaining, before.countdownStepsRemaining);
    assert.deepEqual(
      after.ball,
      expectedBall,
      'the next fixed-step artifact projects the latest live authoritative ball body',
    );
    assert.deepEqual(
      after.cars,
      expectedCars,
      'the next artifact omits only the leaver and projects every surviving live body',
    );
    assert.deepEqual(after.occupancy, { total: 5, blue: 2, orange: 3 });
    assert.deepEqual(world.removedSessionIds, ['active-2']);
    assert.equal(removedCar.removed, true);
    assert.equal(world.cars.size, 5);
    assert.equal(core.isStartEligible, false);
  } finally {
    core.dispose();
  }
});

// Validates: Requirements 6.2-6.8

test('Quick core produces one monotonic policy-bound V2 snapshot stream', async () => {
  const { core } = await makeCore();
  try {
    await join(core, 'quick-transport');
    const first = core.buildSnapshotV2(projection(core), 20_000);
    assert.ok(first);
    assert.equal(first.protocolVersion, SNAPSHOT_PROTOCOL_VERSION);
    assert.equal(first.policyVersion, QUICK_MATCH_POLICY.version);
    assert.equal(first.roomMode, 'quick');
    assert.equal(first.totalCapacity, 6);
    assert.equal(first.teamCapacity, 3);
    assert.equal(first.sequence, 0);
    assert.equal(first.cars.length, 1);
    assert.equal(first.cars[0]?.sessionId, 'quick-transport');
    assert.equal(first.cars[0]?.isHost, false);
    assert.equal('players' in (first as unknown as Record<string, unknown>), false);

    const second = core.buildSnapshotV2(projection(core), 20_033);
    assert.ok(second);
    assert.equal(second.sequence, 1);
    assert.ok(second.serverTime >= first.serverTime);
    assert.ok(second.simulationTime >= first.simulationTime);
    assert.deepEqual(second.cars, first.cars);
  } finally {
    core.dispose();
  }
});

interface ArenaAdapterBroadcast {
  readonly type: string | number | object;
  readonly message: unknown;
}

async function createArenaAdapterHarness(core: unknown) {
  const { ArenaRoom } = await import('./arena-room.js');

  class ArenaAdapterHarness extends ArenaRoom {
    simulationCallback: ((deltaTimeMs: number) => void) | null = null;
    simulationDelayMs: number | null = null;
    publicationError: Error | null = null;
    broadcastAttempts = 0;
    readonly broadcasts: ArenaAdapterBroadcast[] = [];

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

    override broadcast(
      typeOrSchema: string | number | object,
      message?: unknown,
    ): any {
      this.broadcastAttempts += 1;
      if (this.publicationError !== null) throw this.publicationError;
      this.broadcasts.push({ type: typeOrSchema, message });
    }

    tick(deltaTimeMs: number): void {
      assert.ok(this.simulationCallback, 'ArenaRoom must install one simulation callback');
      this.simulationCallback(deltaTimeMs);
    }
  }

  const room = new ArenaAdapterHarness();
  room.roomId = 'quick-room-test';
  room.onCreate({});
  await Promise.resolve();
  return room;
}

function staleQuickSnapshotPort(core: TestCore) {
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

// Validates: Requirements 6.2-6.8

test('ArenaRoom production adapter gates V2 cadence and fails closed on build/publication errors', async (t) => {
  await t.test('due and non-due callbacks publish only V2 through the exported adapter', async () => {
    const { core, world } = await makeCore();
    const room = await createArenaAdapterHarness(core);
    try {
      assert.equal(room.maxClients, QUICK_MATCH_POLICY.totalCapacity);
      assert.equal(room.simulationDelayMs, PHYSICS.TIMESTEP * 1000);

      room.tick(0);
      assert.equal(room.broadcasts.length, 1);
      const first = room.broadcasts[0]?.message as Record<string, unknown> | undefined;
      assert.ok(first);
      assert.equal(first.protocolVersion, SNAPSHOT_PROTOCOL_VERSION);
      assert.equal(first.roomMode, 'quick');
      assert.equal(first.totalCapacity, 6);
      assert.equal('players' in first, false);

      room.tick(0);
      assert.equal(room.broadcasts.length, 1, 'a non-due callback must not build or publish');
    } finally {
      room.onDispose();
    }
    assert.equal(world.disposeCount, 1);
  });

  await t.test('builder failure closes the real adapter before any publication', async () => {
    const { core, world } = await makeCore();
    const port = staleQuickSnapshotPort(core);
    const room = await createArenaAdapterHarness(port);
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
    const room = await createArenaAdapterHarness(core);
    const publicationError = new Error('injected ArenaRoom serializer failure');
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

test('ArenaRoom forwards repeated terminal snapshots without changing terminal event identity', async () => {
  const { SnapshotBuilder } = await import('../systems/snapshot-builder.js');
  const { core } = await makeCore();
  const baseProjection = projection(core);
  const builder = new SnapshotBuilder({ policy: QUICK_MATCH_POLICY });
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
  const room = await createArenaAdapterHarness(port);

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