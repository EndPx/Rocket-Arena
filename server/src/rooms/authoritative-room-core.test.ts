import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPUT_PROTOCOL_VERSION,
  PHYSICS,
  ROOM_POLICIES,
  createVersionedTuningRegistry,
  type InputCommandV2,
  type RoomPolicy,
} from '@rocket-arena/shared';
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
  disposeCount: number;
  throwOnRemove: boolean;
}

type TestCore = AuthoritativeRoomCore<FakeWorld, FakeCar, FakeBall, string>;
type TestOptions = AuthoritativeRoomCoreOptions<FakeWorld, FakeCar, FakeBall, string>;

function makeWorld(): FakeWorld {
  return {
    cars: new Map(),
    operations: [],
    stepDurations: [],
    disposeCount: 0,
    throwOnRemove: false,
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
): AuthoritativeRoomWorldBundle<FakeWorld, FakeCar, FakeBall, string> {
  const ball = makeBall();
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
    fixedStep: ({ fixedStepSeconds, state }) => {
      world.stepDurations.push(fixedStepSeconds);
      for (const [sessionId, car] of state.cars) {
        const input = state.inputs.get(sessionId) ?? createNeutralInputCommandV2();
        car.position[0] += input.throttle * fixedStepSeconds;
        car.linearVelocity[0] = input.throttle;
      }
    },
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
  const ready = deferred<AuthoritativeRoomWorldBundle<FakeWorld, FakeCar, FakeBall, string>>();
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

test('client input can change only normalized controls for subsequent fixed steps', async () => {
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
  const rejected = core.submitInput('host', forged);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, 'invalid-input');
  assert.deepEqual(core.projectAuthoritativeState(), before);

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
  assert.ok(Math.abs((after.cars[0]?.position[0] ?? 0) - PHYSICS.TIMESTEP) < 1e-12);
  assert.equal(after.cars[0]?.linearVelocity[0], 1);
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
