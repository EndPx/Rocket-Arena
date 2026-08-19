import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPUT_PROTOCOL_VERSION,
  KICKOFF_SLOTS,
  PHYSICS,
  ROOM_POLICIES,
  createVersionedTuningRegistry,
  type InputCommandV2,
  type RoomPolicy,
} from '@rocket-arena/shared';
import type { KickoffAssignment } from '../systems/kickoff-slots.js';
import {
  AuthoritativeRoomCore,
  AuthoritativeRoomCreationError,
  createNeutralInputCommandV2,
  type AuthoritativeRoomCoreOptions,
  type AuthoritativeRoomLogger,
  type AuthoritativeRoomWorldBundle,
} from './authoritative-room-core.js';

interface FakeCar {
  readonly id: string;
  readonly position: [number, number, number];
  readonly rotation: [number, number, number, number];
  readonly linearVelocity: [number, number, number];
  readonly angularVelocity: [number, number, number];
  boost: number;
  removed: boolean;
}

interface FakeBall {
  readonly position: [number, number, number];
  readonly rotation: [number, number, number, number];
  readonly linearVelocity: [number, number, number];
  readonly angularVelocity: [number, number, number];
}

interface FakeWorld {
  readonly cars: Map<string, FakeCar>;
  readonly operations: string[];
  readonly stepDurations: number[];
  ball: FakeBall | null;
  projectCarCount: number;
  projectBallCount: number;
  disposeCount: number;
  throwOnRemove: boolean;
  kickoffApplyFailureAfter: number | null;
}

type TestCore = AuthoritativeRoomCore<FakeWorld, FakeCar, FakeBall>;
type TestOptions = AuthoritativeRoomCoreOptions<FakeWorld, FakeCar, FakeBall>;

function makeWorld(): FakeWorld {
  return {
    cars: new Map(),
    operations: [],
    stepDurations: [],
    ball: null,
    projectCarCount: 0,
    projectBallCount: 0,
    disposeCount: 0,
    throwOnRemove: false,
    kickoffApplyFailureAfter: null,
  };
}

function makeBall(): FakeBall {
  return {
    position: [0, 1, 0],
    rotation: [0, 0, 0, 1],
    linearVelocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  };
}

function makeBundle(
  world: FakeWorld,
): AuthoritativeRoomWorldBundle<FakeWorld, FakeCar, FakeBall> {
  const ball = makeBall();
  world.ball = ball;
  return {
    world,
    ball,
    mutationResources: {
      prepareJoin: ({ entry }, scope) => {
        world.operations.push(`prepare:${entry.sessionId}`);
        const car: FakeCar = {
          id: entry.sessionId,
          position: [0, 0.5, 0],
          rotation: [0, 0, 0, 1],
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          boost: 33,
          removed: false,
        };
        world.cars.set(entry.sessionId, car);
        scope.track(car, (temporary) => {
          temporary.removed = true;
          world.cars.delete(temporary.id);
          world.operations.push(`rollback:${temporary.id}`);
        });
        return { car, input: createNeutralInputCommandV2() };
      },
      prepareLeave: ({ car }) => ({
        commitRemoval: () => {
          world.operations.push(`remove:${car.id}`);
          if (world.throwOnRemove) throw new Error(`cannot remove ${car.id}`);
          car.removed = true;
          world.cars.delete(car.id);
        },
      }),
    },
    prepareKickoffPlacement: ({ roster, cars, assignmentSet }) => {
      if (roster.length !== cars.size || cars.size !== assignmentSet.assignments.size) {
        throw new Error('kickoff placement requires exact roster/body/assignment coverage');
      }
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

      for (const entry of roster) {
        const assignment = assignmentSet.assignments.get(entry.sessionId);
        if (assignment === undefined || cars.get(entry.sessionId) === undefined) {
          throw new Error(`incomplete kickoff placement for ${entry.sessionId}`);
        }
      }

      return {
        apply: () => {
          ball.position.splice(0, 3, 0, 1, 0);
          ball.linearVelocity.splice(0, 3, 0, 0, 0);
          ball.angularVelocity.splice(0, 3, 0, 0, 0);
          let placements = 0;
          for (const entry of roster) {
            const car = cars.get(entry.sessionId)!;
            const assignment = assignmentSet.assignments.get(entry.sessionId)!;
            car.position.splice(0, 3, ...assignment.position);
            car.rotation.splice(0, 4, ...assignment.rotation);
            car.linearVelocity.splice(0, 3, 0, 0, 0);
            car.angularVelocity.splice(0, 3, 0, 0, 0);
            placements += 1;
            if (world.kickoffApplyFailureAfter === placements) {
              throw new Error(`injected kickoff failure after ${placements} placement(s)`);
            }
          }
          world.operations.push(`kickoff:${assignmentSet.epoch}`);
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
          world.operations.push(`rollback-kickoff:${assignmentSet.epoch}`);
        },
      };
    },
    synchronizeCarInput: () => {},
    recoverBallBeforeStep: ({ fixedStepSeconds }) => {
      world.stepDurations.push(fixedStepSeconds);
    },
    recoverCarBeforeStep: () => {},
    prepareGrounding: () => {},
    groundCar: () => ({ grounded: false, basis: null }),
    prepareCarCommand: ({ car, input }) => ({
      apply: () => {
        car.position[0] += input.throttle * PHYSICS.TIMESTEP;
        car.linearVelocity[0] = input.throttle;
      },
      commit: () => {},
    }),
    stepWorld: () => {},
    recoverCarAfterStep: () => {},
    recoverBallAfterStep: () => {},
    extractMatchFlowInput: () => ({}),
    projectCar: ({ car }) => {
      world.projectCarCount += 1;
      return {
        position: [...car.position],
        rotation: [...car.rotation],
        linearVelocity: [...car.linearVelocity],
        angularVelocity: [...car.angularVelocity],
        boost: car.boost,
      };
    },
    projectBall: ({ ball: authoritativeBall }) => {
      world.projectBallCount += 1;
      return {
        position: [...authoritativeBall.position],
        rotation: [...authoritativeBall.rotation],
        linearVelocity: [...authoritativeBall.linearVelocity],
        angularVelocity: [...authoritativeBall.angularVelocity],
      };
    },
    dispose: () => {
      world.disposeCount += 1;
      world.operations.push('dispose-world');
    },
  };
}

function makeLogger(info: string[], errors: string[] = []): AuthoritativeRoomLogger {
  return {
    info: (message) => { info.push(message); },
    error: (message) => { errors.push(message); },
  };
}

function makeCore(
  world: FakeWorld,
  options: Partial<TestOptions> = {},
): TestCore {
  return new AuthoritativeRoomCore({
    roomId: 'test-room',
    mode: 'custom',
    policy: ROOM_POLICIES.custom,
    initializeWorld: () => makeBundle(world),
    logger: makeLogger([]),
    ...options,
  });
}

function input(overrides: Partial<InputCommandV2> = {}): InputCommandV2 {
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
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function initializeAndJoin(
  core: TestCore,
  sessionId = 'host',
): Promise<void> {
  await core.initialize();
  const joined = core.queueMutation({ kind: 'join', sessionId, name: `Player ${sessionId}` });
  const frame = core.advanceSimulation(1000 / 60);
  assert.equal(frame.executedFixedSteps, 1);
  const result = await joined;
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

async function joinMany(core: TestCore, count: number, prefix: string): Promise<void> {
  const joins = Array.from({ length: count }, (_, index) => core.queueMutation({
    kind: 'join',
    sessionId: `${prefix}-${index}`,
    name: `${prefix} ${index}`,
  }));
  core.advanceSimulation(1000 / 60);
  const results = await Promise.all(joins);
  for (const result of results) {
    assert.equal(result.ok, true, result.ok ? undefined : result.message);
  }
}

function bodySnapshot(core: TestCore): unknown {
  const projection = core.projectAuthoritativeState();
  assert.ok(projection);
  return structuredClone({ cars: projection.cars, ball: projection.ball });
}

// Validates: Requirements 2.8-2.10

test('room creation rejects policy/capacity mismatch before initialization or logging', () => {
  const world = makeWorld();
  const info: string[] = [];
  let initializeCalls = 0;
  const invalidPolicy = {
    ...ROOM_POLICIES.quick,
    totalCapacity: ROOM_POLICIES.custom.totalCapacity,
  };

  assert.throws(
    () => new AuthoritativeRoomCore({
      roomId: 'invalid-room',
      mode: 'quick',
      policy: invalidPolicy,
      initializeWorld: () => {
        initializeCalls += 1;
        return makeBundle(world);
      },
      logger: makeLogger(info),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AuthoritativeRoomCreationError);
      assert.equal(error.code, 'policy-mismatch');
      return true;
    },
  );
  assert.equal(initializeCalls, 0);
  assert.deepEqual(info, []);

  assert.throws(
    () => new AuthoritativeRoomCore({
      roomId: 'capacity-override',
      mode: 'quick',
      totalCapacity: 8,
      teamCapacity: 3,
      initializeWorld: () => makeBundle(world),
      logger: makeLogger(info),
    }),
    AuthoritativeRoomCreationError,
  );

  const valid = new AuthoritativeRoomCore({
    roomId: 'valid-room',
    mode: 'quick',
    policy: ROOM_POLICIES.quick,
    initializeWorld: () => makeBundle(world),
    logger: makeLogger(info),
  });
  assert.match(
    info[0] ?? '',
    /mode=quick totalCapacity=6 teamCapacity=3/,
    'canonical mode and capacities are logged at construction before any join',
  );
  assert.deepEqual(valid.diagnostics.rosterSessionIds, []);
  valid.dispose();
});

// Validates: Requirements 1.4-1.7, 2.8

test('readiness barrier retains ordered joins until a ready world reaches a fixed step', async () => {
  const world = makeWorld();
  const ready = deferred<AuthoritativeRoomWorldBundle<FakeWorld, FakeCar, FakeBall>>();
  const events: string[] = [];
  const registry = createVersionedTuningRegistry({ registryId: 'test-registry' });
  const core = new AuthoritativeRoomCore({
    roomId: 'readiness-room',
    mode: 'custom',
    policy: ROOM_POLICIES.custom,
    tuningRegistry: registry,
    initializeWorld: () => {
      events.push('initialize-world');
      return ready.promise;
    },
    logger: {
      info: (message) => { events.push(message); },
      error: (message) => { events.push(`error:${message}`); },
    },
  });

  const queued = core.queueMutation({ kind: 'join', sessionId: 'early', name: 'Early' });
  let settled = false;
  void queued.then(() => { settled = true; });
  const initialization = core.initialize();
  const blockedFrame = core.advanceSimulation(1000 / 60);
  await Promise.resolve();

  assert.equal(core.lifecycle, 'initializing');
  assert.equal(blockedFrame.scheduledFixedSteps, 0);
  assert.equal(world.stepDurations.length, 0);
  assert.equal(settled, false);
  assert.equal(core.diagnostics.pendingMutationCount, 1);
  assert.equal(core.projectAuthoritativeState(), null);
  assert.match(events[0] ?? '', /room-created/);
  assert.equal(events[1], 'initialize-world');

  ready.resolve(makeBundle(world));
  await initialization;
  assert.equal(core.lifecycle, 'ready');
  assert.deepEqual(core.diagnostics.rosterSessionIds, []);
  assert.equal(core.diagnostics.pendingMutationCount, 1);
  assert.equal(core.tuningSnapshot.roomId, 'readiness-room');
  assert.equal(core.tuningSnapshot.registryId, 'test-registry');
  assert.ok(Object.isFrozen(core.tuningSnapshot));

  const frame = core.advanceSimulation(1000 / 60);
  const joined = await queued;
  assert.equal(joined.ok, true, joined.ok ? undefined : joined.message);
  assert.equal(settled, true);
  assert.equal(frame.scheduledFixedSteps, 1);
  assert.equal(frame.executedFixedSteps, 1);
  assert.deepEqual(world.stepDurations, [PHYSICS.TIMESTEP]);
  assert.deepEqual(core.diagnostics.rosterSessionIds, ['early']);
  assert.deepEqual(core.diagnostics.bodySessionIds, ['early']);
  assert.deepEqual(core.diagnostics.inputSessionIds, ['early']);

  const projection = core.projectAuthoritativeState();
  assert.ok(projection);
  assert.equal(projection.cars.length, 1);
  assert.equal(projection.policy, ROOM_POLICIES.custom);
  assert.equal(projection.tuning.snapshotId, core.tuningSnapshot.snapshotId);
  core.dispose();
  assert.equal(world.disposeCount, 1);
});

test('validated step projection is retained and publication reads never re-project bodies', async () => {
  const world = makeWorld();
  const core = makeCore(world);
  await core.initialize();

  const initialized = core.projectAuthoritativeState();
  assert.ok(initialized);
  assert.equal(world.projectCarCount, 0);
  assert.equal(world.projectBallCount, 1);
  assert.strictEqual(core.projectAuthoritativeState(), initialized);
  assert.equal(world.projectBallCount, 1);

  const joined = core.queueMutation({ kind: 'join', sessionId: 'cached', name: 'Cached' });
  const frame = core.advanceSimulation(1000 / 60);
  assert.equal((await joined).ok, true);
  assert.equal(frame.executedFixedSteps, 1);
  const committed = core.projectAuthoritativeState();
  assert.ok(committed);
  assert.equal(committed.fixedStepsCompleted, 1);
  assert.equal(world.projectCarCount, 1);
  assert.equal(world.projectBallCount, 2);

  const zeroStep = core.advanceSimulation(0);
  assert.equal(zeroStep.executedFixedSteps, 0);
  assert.strictEqual(core.projectAuthoritativeState(), committed);
  assert.equal(world.projectCarCount, 1);
  assert.equal(world.projectBallCount, 2);

  assert.ok(core.buildSnapshotV2(committed, 1234));
  assert.strictEqual(core.projectAuthoritativeState(), committed);
  assert.equal(world.projectCarCount, 1);
  assert.equal(world.projectBallCount, 2);
  core.dispose();
});

// Validates: Requirements 1.4-1.7, 2.8, 2.10

test('invalid world initialization rejects queued mutations, becomes fatal, and disposes the detached candidate once', async () => {
  const world = makeWorld();
  const fatalErrors: Error[] = [];
  const logErrors: string[] = [];
  const invalidCandidate = {
    ...makeBundle(world),
    projectBall: undefined,
  } as unknown as AuthoritativeRoomWorldBundle<FakeWorld, FakeCar, FakeBall>;
  const core = makeCore(world, {
    initializeWorld: () => invalidCandidate,
    logger: makeLogger([], logErrors),
    onFatal: (error) => { fatalErrors.push(error); },
  });

  const queued = core.queueMutation({
    kind: 'join',
    sessionId: 'waiting-player',
    name: 'Waiting Player',
  });
  await assert.rejects(
    core.initialize(),
    /Authoritative world initialization failed.*ready world bundle requires/i,
  );
  const result = await queued;

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'physics-not-ready');
    assert.equal(result.fatal, true);
    assert.equal(result.cause, core.fatalError);
  }
  assert.equal(core.lifecycle, 'fatal');
  assert.equal(core.canPublishSnapshots, false);
  assert.equal(core.projectAuthoritativeState(), null);
  assert.equal(core.diagnostics.pendingMutationCount, 0);
  assert.equal(world.disposeCount, 1);
  assert.deepEqual(world.operations, ['dispose-world']);
  assert.equal(fatalErrors.length, 1);
  assert.equal(fatalErrors[0], core.fatalError);
  assert.equal(logErrors.length, 1);

  const frame = core.advanceSimulation(1000 / 60);
  assert.equal(frame.scheduledFixedSteps, 0);
  assert.equal(frame.executedFixedSteps, 0);
  assert.equal(frame.snapshotDue, false);
  core.dispose();
  core.dispose();
  assert.equal(world.disposeCount, 1, 'fatal cleanup never disposes a detached candidate twice');
});

test('disposing during initialization stays disposed and disposes the late world exactly once', async () => {
  const world = makeWorld();
  const ready = deferred<AuthoritativeRoomWorldBundle<FakeWorld, FakeCar, FakeBall>>();
  const fatalErrors: Error[] = [];
  const logErrors: string[] = [];
  const core = makeCore(world, {
    initializeWorld: () => ready.promise,
    logger: makeLogger([], logErrors),
    onFatal: (error) => { fatalErrors.push(error); },
  });

  const queued = core.queueMutation({
    kind: 'join',
    sessionId: 'cancelled-player',
    name: 'Cancelled Player',
  });
  const initialization = core.initialize();
  await Promise.resolve();
  assert.equal(core.lifecycle, 'initializing');

  core.dispose();
  const result = await queued;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'physics-not-ready');
    assert.equal(result.fatal, false);
  }
  assert.equal(core.lifecycle, 'disposed');
  assert.equal(core.canPublishSnapshots, false);
  assert.equal(core.diagnostics.pendingMutationCount, 0);
  assert.equal(world.disposeCount, 0, 'no world exists at the time disposal is requested');

  ready.resolve(makeBundle(world));
  await initialization;
  assert.equal(core.lifecycle, 'disposed');
  assert.equal(core.canPublishSnapshots, false);
  assert.equal(core.projectAuthoritativeState(), null);
  assert.equal(world.disposeCount, 1);
  assert.deepEqual(world.operations, ['dispose-world']);
  assert.deepEqual(fatalErrors, []);
  assert.deepEqual(logErrors, []);

  const rejectedAfterDisposal = await core.queueMutation({
    kind: 'join',
    sessionId: 'late-player',
    name: 'Late Player',
  });
  assert.equal(rejectedAfterDisposal.ok, false);
  if (!rejectedAfterDisposal.ok) assert.equal(rejectedAfterDisposal.fatal, false);
  await assert.rejects(core.initialize(), /disposed/i);
  core.dispose();
  assert.equal(world.disposeCount, 1, 'late-world disposal remains idempotent');
});

// Validates: Requirements 2.8, 2.10

test('queued mutations commit in receive order against each preceding committed state', async () => {
  const world = makeWorld();
  const core = makeCore(world);
  await core.initialize();

  const first = core.queueMutation({ kind: 'join', sessionId: 'alpha', name: 'Alpha' });
  const second = core.queueMutation({ kind: 'join', sessionId: 'beta', name: 'Beta' });
  const third = core.queueMutation({ kind: 'leave', sessionId: 'alpha' });
  const fourth = core.queueMutation({ kind: 'join', sessionId: 'gamma', name: 'Gamma' });
  const frame = core.advanceSimulation(1000 / 60);
  const results = await Promise.all([first, second, third, fourth]);

  assert.deepEqual(results.map(({ queueSequence }) => queueSequence), [1, 2, 3, 4]);
  assert.deepEqual(
    results.map((result) => result.ok ? result.effect.kind : result.code),
    ['joined', 'joined', 'left', 'joined'],
  );
  assert.deepEqual(
    frame.mutationResults.map(({ queueSequence }) => queueSequence),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    world.operations.slice(0, 4),
    ['prepare:alpha', 'prepare:beta', 'remove:alpha', 'prepare:gamma'],
  );

  const projection = core.projectAuthoritativeState();
  assert.ok(projection);
  assert.deepEqual(projection.cars.map(({ sessionId }) => sessionId), ['beta', 'gamma']);
  assert.equal(projection.hostSessionId, 'beta');
  assert.equal(projection.cars[0]?.team, 'orange');
  assert.equal(projection.cars[0]?.isHost, true);
  assert.equal(projection.cars[1]?.team, 'blue');
  assert.deepEqual(projection.occupancy, { total: 2, blue: 1, orange: 1 });
  assert.deepEqual(core.diagnostics.bodySessionIds, ['beta', 'gamma']);
  assert.deepEqual(core.diagnostics.inputSessionIds, ['beta', 'gamma']);
  core.dispose();
});

// Validates: Requirements 1.1-1.3

test('client input allow-list discards forged authority without bypassing the phase gate', async () => {
  const world = makeWorld();
  const core = makeCore(world);
  await initializeAndJoin(core);
  const before = core.projectAuthoritativeState();
  assert.ok(before);

  const forged = {
    ...input({ throttle: 1, jumpSequence: 1 }),
    position: [999, 999, 999],
    blueScore: 99,
    boostInventory: 100,
    team: 'orange',
    phase: 'ended',
  };
  const acceptedForgedControls = core.submitInput('host', forged);
  assert.deepEqual(acceptedForgedControls, { ok: true });
  assert.strictEqual(
    core.projectAuthoritativeState(),
    before,
    'input submission never replaces the committed authoritative artifact',
  );

  const accepted = core.submitInput('host', input({ throttle: 1, jumpSequence: 1 }));
  assert.deepEqual(accepted, { ok: true });
  assert.deepEqual(
    core.projectAuthoritativeState(),
    before,
    'accepted controls do not directly write an authoritative body or score',
  );

  core.advanceSimulation(1000 / 60);
  const after = core.projectAuthoritativeState();
  assert.ok(after);
  assert.equal(after.cars[0]?.position[0], 0);
  assert.equal(after.cars[0]?.linearVelocity[0], 0);
  assert.equal(after.phase, 'waiting');
  assert.notEqual(after.cars[0]?.position[0], 999);
  assert.equal(after.blueScore, 0);
  assert.equal(after.orangeScore, 0);
  assert.ok(Object.isFrozen(after));
  assert.ok(Object.isFrozen(after.cars));
  assert.ok(Object.isFrozen(after.cars[0]));
  core.dispose();
});

// Validates: Requirements 2.8, 2.10

test('final leave performs complete empty-room cleanup and idempotent world disposal', async () => {
  const world = makeWorld();
  const core = makeCore(world);
  await initializeAndJoin(core, 'only');

  const leaving = core.queueMutation({ kind: 'leave', sessionId: 'only' });
  const tombstonedProjection = core.projectAuthoritativeState();
  assert.ok(tombstonedProjection);
  assert.deepEqual(tombstonedProjection.cars, []);
  assert.deepEqual(tombstonedProjection.occupancy, { total: 0, blue: 0, orange: 0 });
  assert.deepEqual(core.diagnostics.rosterSessionIds, ['only']);
  assert.deepEqual(core.diagnostics.tombstonedSessionIds, ['only']);

  const frame = core.advanceSimulation(1000 / 60);
  const result = await leaving;
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  assert.equal(frame.executedFixedSteps, 0, 'cleanup occurs before another world step');
  assert.equal(frame.snapshotDue, false);
  assert.equal(core.lifecycle, 'disposed');
  assert.deepEqual(core.diagnostics.rosterSessionIds, []);
  assert.deepEqual(core.diagnostics.bodySessionIds, []);
  assert.deepEqual(core.diagnostics.inputSessionIds, []);
  assert.deepEqual(core.diagnostics.tombstonedSessionIds, []);
  assert.equal(core.diagnostics.kickoffAssignmentCount, 0);
  assert.equal(core.projectAuthoritativeState(), null);
  assert.equal(world.disposeCount, 1);

  core.dispose();
  core.dispose();
  assert.equal(world.disposeCount, 1, 'world disposal is idempotent');
  assert.equal(core.submitInput('only', input()).ok, false);
});

// Validates: Requirements 1.1, 2.10

test('body-removal failure makes the room fatal, stops snapshots, and disposes once', async () => {
  const world = makeWorld();
  const fatalErrors: Error[] = [];
  const logErrors: string[] = [];
  const core = makeCore(world, {
    logger: makeLogger([], logErrors),
    onFatal: (error) => { fatalErrors.push(error); },
  });
  await initializeAndJoin(core);
  const stepsBeforeFailure = world.stepDurations.length;
  world.throwOnRemove = true;

  const leaving = core.queueMutation({ kind: 'leave', sessionId: 'host' });
  const frame = core.advanceSimulation(1000 / 60);
  const result = await leaving;

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.fatal, true);
    assert.equal(result.code, 'physics-not-ready');
  }
  assert.equal(core.lifecycle, 'fatal');
  assert.equal(core.canPublishSnapshots, false);
  assert.equal(core.projectAuthoritativeState(), null);
  assert.equal(frame.executedFixedSteps, 0);
  assert.equal(frame.snapshotDue, false);
  assert.equal(world.stepDurations.length, stepsBeforeFailure);
  assert.equal(world.disposeCount, 1);
  assert.equal(fatalErrors.length, 1);
  assert.equal(logErrors.length, 1);
  assert.deepEqual(core.diagnostics.rosterSessionIds, ['host']);
  assert.deepEqual(core.diagnostics.bodySessionIds, ['host']);
  assert.deepEqual(core.diagnostics.inputSessionIds, ['host']);
  assert.deepEqual(core.diagnostics.tombstonedSessionIds, ['host']);

  const laterFrame = core.advanceSimulation(1000);
  assert.equal(laterFrame.scheduledFixedSteps, 0);
  assert.equal(laterFrame.snapshotDue, false);
  assert.equal(world.stepDurations.length, stepsBeforeFailure);
  core.dispose();
  assert.equal(world.disposeCount, 1);
});

// Validates: Requirements 1.4-1.7

test('callback deltas reach the world only as exact bounded fixed steps', async () => {
  const world = makeWorld();
  const core = makeCore(world);
  await core.initialize();

  const negative = core.advanceSimulation(-10);
  const nonFinite = core.advanceSimulation(Number.NaN);
  const stalled = core.advanceSimulation(1000);

  assert.equal(negative.clampedDeltaMs, 0);
  assert.equal(negative.executedFixedSteps, 0);
  assert.equal(nonFinite.clampedDeltaMs, 0);
  assert.equal(nonFinite.executedFixedSteps, 0);
  assert.equal(stalled.clampedDeltaMs, PHYSICS.MAX_FRAME_DELTA_SECONDS * 1000);
  assert.equal(stalled.scheduledFixedSteps, PHYSICS.MAX_FIXED_SUBSTEPS);
  assert.equal(stalled.executedFixedSteps, PHYSICS.MAX_FIXED_SUBSTEPS);
  assert.ok(stalled.droppedTimeMs > 0);
  assert.equal(world.stepDurations.length, PHYSICS.MAX_FIXED_SUBSTEPS);
  assert.ok(world.stepDurations.every((duration) => duration === PHYSICS.TIMESTEP));
  core.dispose();
});

// Validates: Requirements 5.5-5.9

test('atomic kickoff placement gives three Quick and four Custom teammates distinct canonical transforms', async () => {
  for (const mode of ['quick', 'custom'] as const) {
    const policy = ROOM_POLICIES[mode];
    const world = makeWorld();
    const core = makeCore(world, {
      roomId: `${mode}-kickoff-room`,
      mode,
      policy,
    });

    try {
      await core.initialize();
      await joinMany(core, policy.totalCapacity, mode);
      for (const [index, car] of [...world.cars.values()].entries()) {
        car.linearVelocity.splice(0, 3, index + 1, index + 2, index + 3);
        car.angularVelocity.splice(0, 3, index + 4, index + 5, index + 6);
      }

      const placed = core.placeKickoff(1);
      assert.equal(placed.ok, true, placed.ok ? undefined : placed.message);
      if (!placed.ok) continue;

      const projection = core.projectAuthoritativeState();
      assert.ok(projection);
      const blue = projection.cars.filter(({ team }) => team === 'blue');
      assert.equal(blue.length, policy.teamCapacity);
      assert.equal(
        new Set(blue.map(({ position }) => JSON.stringify(position))).size,
        policy.teamCapacity,
      );
      blue.forEach((car, index) => {
        assert.deepEqual(car.position, KICKOFF_SLOTS.blue[index]?.position);
        assert.deepEqual(car.rotation, KICKOFF_SLOTS.blue[index]?.rotation);
      });
      for (const car of projection.cars) {
        assert.deepEqual(car.linearVelocity, [0, 0, 0]);
        assert.deepEqual(car.angularVelocity, [0, 0, 0]);
      }
      assert.equal(placed.assignmentSet.assignments.size, policy.totalCapacity);
      assert.equal(core.diagnostics.kickoffEpoch, 1);
    } finally {
      core.dispose();
    }
  }
});

// Validates: Requirements 5.10, 5.12

test('unchanged goal-reset rosters reuse mappings while restoring transforms and zero motion', async () => {
  const world = makeWorld();
  const core = makeCore(world, { roomId: 'stable-reset-room' });

  try {
    await core.initialize();
    await joinMany(core, ROOM_POLICIES.custom.totalCapacity, 'stable');
    const initial = core.placeKickoff(7);
    assert.equal(initial.ok, true, initial.ok ? undefined : initial.message);
    if (!initial.ok) return;

    for (const [index, car] of [...world.cars.values()].entries()) {
      car.position.splice(0, 3, 100 + index, 10 + index, -100 - index);
      car.rotation.splice(0, 4, 0.5, 0.5, 0.5, 0.5);
      car.linearVelocity.splice(0, 3, 8, 9, 10);
      car.angularVelocity.splice(0, 3, 2, 3, 4);
    }
    assert.ok(world.ball);
    world.ball.position.splice(0, 3, 12, 13, 14);
    world.ball.linearVelocity.splice(0, 3, 5, 6, 7);
    world.ball.angularVelocity.splice(0, 3, 1, 2, 3);

    const reset = core.placeKickoff(8);
    assert.equal(reset.ok, true, reset.ok ? undefined : reset.message);
    if (!reset.ok) return;
    assert.equal(reset.reusedAssignments, true);
    assert.equal(reset.assignmentSet.assignments, initial.assignmentSet.assignments);
    assert.equal(reset.assignmentSet.epoch, 8);

    const projection = core.projectAuthoritativeState();
    assert.ok(projection);
    for (const car of projection.cars) {
      const kickoffAssignment: Readonly<KickoffAssignment> | undefined =
        initial.assignmentSet.assignments.get(car.sessionId);
      assert.ok(kickoffAssignment);
      assert.deepEqual(car.position, kickoffAssignment.position);
      assert.deepEqual(car.rotation, kickoffAssignment.rotation);
      assert.deepEqual(car.linearVelocity, [0, 0, 0]);
      assert.deepEqual(car.angularVelocity, [0, 0, 0]);
    }
    assert.deepEqual(projection.ball.position, [0, 1, 0]);
    assert.deepEqual(projection.ball.linearVelocity, [0, 0, 0]);
    assert.deepEqual(projection.ball.angularVelocity, [0, 0, 0]);
    assert.equal(core.diagnostics.kickoffEpoch, 8);
  } finally {
    core.dispose();
  }
});

// Validates: Requirements 5.11-5.12

test('failed changed-roster placement rolls every body back and retains the last complete assignment', async () => {
  const world = makeWorld();
  const core = makeCore(world, { roomId: 'failed-replacement-room' });

  try {
    await core.initialize();
    await joinMany(core, 4, 'replacement');
    const initial = core.placeKickoff(3);
    assert.equal(initial.ok, true, initial.ok ? undefined : initial.message);
    if (!initial.ok) return;

    const leaving = core.queueMutation({ kind: 'leave', sessionId: 'replacement-3' });
    core.advanceSimulation(1000 / 60);
    assert.equal((await leaving).ok, true);
    const joining = core.queueMutation({
      kind: 'join',
      sessionId: 'replacement-new',
      name: 'Replacement New',
    });
    core.advanceSimulation(1000 / 60);
    assert.equal((await joining).ok, true);

    for (const [index, car] of [...world.cars.values()].entries()) {
      car.position.splice(0, 3, 20 + index, 30 + index, 40 + index);
      car.rotation.splice(0, 4, 0, 0, 0, 1);
      car.linearVelocity.splice(0, 3, index + 1, index + 2, index + 3);
      car.angularVelocity.splice(0, 3, index + 4, index + 5, index + 6);
    }
    assert.ok(world.ball);
    world.ball.position.splice(0, 3, 9, 8, 7);
    world.ball.linearVelocity.splice(0, 3, 6, 5, 4);
    world.ball.angularVelocity.splice(0, 3, 3, 2, 1);
    const beforeFailure = bodySnapshot(core);

    world.kickoffApplyFailureAfter = 1;
    const failed = core.placeKickoff(4);
    assert.equal(failed.ok, false);
    if (failed.ok) return;
    assert.equal(failed.code, 'placement-failed');
    assert.equal(failed.fatal, false);
    assert.equal(failed.retained, initial.assignmentSet);
    assert.equal(core.kickoffAssignmentSet, initial.assignmentSet);
    assert.equal(core.diagnostics.kickoffEpoch, 3);
    assert.equal(core.diagnostics.kickoffAssignmentCount, 4);
    assert.deepEqual(bodySnapshot(core), beforeFailure);
    assert.equal(world.operations.includes('kickoff:4'), false);
    assert.equal(world.operations.includes('rollback-kickoff:4'), true);
  } finally {
    core.dispose();
  }
});