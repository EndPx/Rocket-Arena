import assert from 'node:assert/strict';
import test from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_COLLISION_GEOMETRY,
  INPUT_PROTOCOL_VERSION,
  MATCH_RULES,
  PHYSICS,
  ROOM_POLICIES,
  TUNING_IDS,
  getScalarTuningValue,
  type InputCommandV2,
  type RoomPinnedTuningSnapshot,
  type RosterEntry,
} from '@rocket-arena/shared';
import {
  AuthoritativeRoomCore,
  type AuthoritativeRoomProjection,
} from './authoritative-room-core.js';
import {
  initializeAuthoritativeRapierWorld,
  type AuthoritativeRapierCar,
  type AuthoritativeRapierRoomWorldBundle,
} from './rapier-room-world.js';

const FIXED_STEP_MS = PHYSICS.TIMESTEP * 1_000;
let nextHarnessId = 1;

const NEUTRAL_INPUT: Readonly<InputCommandV2> = Object.freeze({
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
});

type RapierCore = AuthoritativeRoomCore<
  RAPIER.World,
  AuthoritativeRapierCar,
  RAPIER.RigidBody
>;

type BundleWrapper = (
  bundle: AuthoritativeRapierRoomWorldBundle,
) => AuthoritativeRapierRoomWorldBundle;

function input(patch: Partial<InputCommandV2> = {}): Readonly<InputCommandV2> {
  return Object.freeze({ ...NEUTRAL_INPUT, ...patch });
}

function initialCarPosition(
  _entry: Pick<RosterEntry, 'acceptedJoinOrdinal' | 'team'>,
  tuning: RoomPinnedTuningSnapshot,
): Readonly<{ x: number; y: number; z: number }> {
  return Object.freeze({
    x: 0,
    y: getScalarTuningValue(tuning, TUNING_IDS.car.collider.height) / 2 + 0.02,
    z: 0,
  });
}

async function createHarness(
  wrapper: BundleWrapper = (bundle) => bundle,
): Promise<{
  readonly core: RapierCore;
  readonly bundle: AuthoritativeRapierRoomWorldBundle;
}> {
  let bundle: AuthoritativeRapierRoomWorldBundle | null = null;
  const core = new AuthoritativeRoomCore<RAPIER.World, AuthoritativeRapierCar, RAPIER.RigidBody>({
    roomId: `wave-17-${nextHarnessId++}`,
    mode: 'custom',
    policy: ROOM_POLICIES.custom,
    initializeWorld: async (context) => {
      const initialized = await initializeAuthoritativeRapierWorld(context, {
        resolvedGeometry: ARENA_COLLISION_GEOMETRY,
        initialCarPosition,
      });
      assert.strictEqual(
        initialized.resolvedGeometry,
        ARENA_COLLISION_GEOMETRY,
        'authoritative room must retain the exact pinned geometry object',
      );
      bundle = wrapper(initialized);
      return bundle;
    },
    logger: { info: () => {}, error: () => {} },
  });
  await core.initialize();
  if (bundle === null) throw new Error('Rapier room bundle was not captured');
  return { core, bundle };
}

async function join(core: RapierCore, sessionId: string): Promise<void> {
  const pending = core.queueMutation({
    kind: 'join',
    sessionId,
    name: `Player ${sessionId}`,
  });
  const frame = core.advanceSimulation(FIXED_STEP_MS);
  assert.equal(frame.executedFixedSteps, 1);
  const result = await pending;
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

async function start(core: RapierCore, hostSessionId: string): Promise<void> {
  const pending = core.queueMutation({ kind: 'start', sessionId: hostSessionId });
  const frame = core.advanceSimulation(FIXED_STEP_MS);
  assert.equal(frame.executedFixedSteps, 1);
  const result = await pending;
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
}

function advanceSteps(core: RapierCore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const frame = core.advanceSimulation(FIXED_STEP_MS);
    assert.equal(frame.scheduledFixedSteps, 1);
    assert.equal(frame.executedFixedSteps, 1);
  }
}

function projection(core: RapierCore): Readonly<AuthoritativeRoomProjection> {
  const value = core.projectAuthoritativeState();
  assert.ok(value);
  return value;
}

function assertFiniteNumbers(value: unknown, path = 'value'): void {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} must be finite, received ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => { assertFiniteNumbers(entry, `${path}[${index}]`); });
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      assertFiniteNumbers(entry, `${path}.${key}`);
    }
  }
}

// Validates: Requirements 1.1-1.3, 8.4-8.17, 9.4-9.17, 18.5-18.6

test('real room pipeline synchronizes disabled edges, boosts on Local Forward, and publishes finite state', async () => {
  let hostGrounded: boolean | null = null;
  const { core, bundle } = await createHarness((base) => ({
    ...base,
    groundCar: (context) => {
      const grounding = base.groundCar(context);
      if (context.entry.sessionId === 'host') hostGrounded = grounding.grounded;
      return grounding;
    },
  }));
  try {
    await join(core, 'host');
    const car = bundle.carsBySessionId.get('host');
    assert.ok(car);

    const forged = core.submitInput('host', {
      ...input({ throttle: 1, jumpHeld: true, jumpSequence: 1 }),
      position: [999, 999, 999],
      blueScore: 99,
      team: 'orange',
    });
    assert.deepEqual(forged, { ok: true });

    await start(core, 'host');
    assert.equal(car.jumpAirState.lastConsumedJumpSequence, 1);
    assert.equal(car.jumpAirState.firstJumpAcceptedAtStep, null);

    // Task 6.1 replaces the intentionally legacy 60 m floor with the metric
    // shell. Keep this Wave 17 integration probe on an already tagged Core
    // surface while still exercising the complete live countdown pipeline.
    const kickoffHeight = car.body.translation().y;
    car.body.setTranslation({ x: -5, y: kickoffHeight, z: 0 }, true);
    car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

    advanceSteps(core, MATCH_RULES.kickoffCountdownSteps);
    assert.equal(projection(core).phase, 'playing');

    core.advanceSimulation(FIXED_STEP_MS);
    assert.equal(car.jumpAirState.lastConsumedJumpSequence, 1);
    assert.equal(
      car.jumpAirState.firstJumpAcceptedAtStep,
      null,
      'the held countdown edge must not fire when controls open',
    );

    assert.deepEqual(
      core.submitInput('host', input({ jumpHeld: true, jumpSequence: 2 })),
      { ok: true },
    );
    core.advanceSimulation(FIXED_STEP_MS);
    assert.equal(
      hostGrounded,
      true,
      `staging floor placement must have Core support; car=${JSON.stringify(car.body.translation())}`,
    );
    assert.equal(car.jumpAirState.lastConsumedJumpSequence, 2);
    assert.ok(car.jumpAirState.firstJumpAcceptedAtStep !== null);

    car.body.setTranslation({ x: 0, y: 5, z: 0 }, true);
    car.body.setRotation({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }, true);
    car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    assert.deepEqual(
      core.submitInput('host', input({ boostHeld: true, jumpSequence: 2 })),
      { ok: true },
    );
    core.advanceSimulation(FIXED_STEP_MS);
    const boostedVelocity = car.body.linvel();
    assert.ok(boostedVelocity.x > 0.1, `expected positive Local Forward X boost, got ${boostedVelocity.x}`);
    assert.ok(Math.abs(boostedVelocity.z) < 1e-4, `boost leaked into world Z: ${boostedVelocity.z}`);

    const ball = bundle.ball;
    car.body.setTranslation({ x: Number.NaN, y: Number.POSITIVE_INFINITY, z: 0 }, true);
    car.body.setRotation({ x: Number.NaN, y: 0, z: 0, w: 1 }, true);
    car.body.setLinvel({ x: Number.NaN, y: 0, z: Number.NEGATIVE_INFINITY }, true);
    car.body.setAngvel({ x: 0, y: Number.NaN, z: 0 }, true);
    ball.setTranslation({ x: 0, y: Number.NaN, z: 0 }, true);
    ball.setLinvel({ x: Number.POSITIVE_INFINITY, y: 0, z: 0 }, true);
    ball.setAngvel({ x: 0, y: 0, z: Number.NaN }, true);
    assert.deepEqual(core.submitInput('host', input({ jumpSequence: 2 })), { ok: true });
    core.advanceSimulation(FIXED_STEP_MS);

    assertFiniteNumbers({
      carPosition: car.body.translation(),
      carRotation: car.body.rotation(),
      carLinearVelocity: car.body.linvel(),
      carAngularVelocity: car.body.angvel(),
      ballPosition: ball.translation(),
      ballLinearVelocity: ball.linvel(),
      ballAngularVelocity: ball.angvel(),
    }, 'recoveredBodies');
    const finiteProjection = projection(core);
    const snapshot = core.buildSnapshotV2(finiteProjection, 123_456);
    assert.ok(snapshot);
    assertFiniteNumbers(finiteProjection, 'projection');
    assertFiniteNumbers(snapshot, 'snapshot');
  } finally {
    core.dispose();
  }
});

// Validates: Requirements 1.6, 8.4-8.17, 18.19

test('core executes every staged callback in stable roster order and plans all cars before applying', async () => {
  const operations: string[] = [];
  let recording = false;
  const { core } = await createHarness((base) => ({
    ...base,
    synchronizeCarInput: (context) => {
      if (recording) operations.push(`sync:${context.entry.sessionId}`);
      base.synchronizeCarInput(context);
    },
    recoverBallBeforeStep: (context) => {
      if (recording) operations.push('recover-ball-before');
      base.recoverBallBeforeStep(context);
    },
    recoverCarBeforeStep: (context) => {
      if (recording) operations.push(`recover-car-before:${context.entry.sessionId}`);
      base.recoverCarBeforeStep(context);
    },
    prepareGrounding: (context) => {
      if (recording) operations.push('prepare-grounding');
      base.prepareGrounding(context);
    },
    groundCar: (context) => {
      if (recording) operations.push(`ground:${context.entry.sessionId}`);
      return base.groundCar(context);
    },
    prepareCarCommand: (context) => {
      if (recording) operations.push(`plan:${context.entry.sessionId}`);
      const prepared = base.prepareCarCommand(context);
      return {
        apply: () => {
          if (recording) operations.push(`apply:${context.entry.sessionId}`);
          prepared.apply();
        },
        commit: () => {
          if (recording) operations.push(`commit:${context.entry.sessionId}`);
          prepared.commit();
        },
      };
    },
    stepWorld: (context) => {
      if (recording) operations.push('step-world');
      base.stepWorld(context);
    },
    recoverCarAfterStep: (context) => {
      if (recording) operations.push(`recover-car-after:${context.entry.sessionId}`);
      base.recoverCarAfterStep(context);
    },
    recoverBallAfterStep: (context) => {
      if (recording) operations.push('recover-ball-after');
      base.recoverBallAfterStep(context);
    },
    extractMatchFlowInput: (context) => {
      if (recording) operations.push('extract-events');
      return base.extractMatchFlowInput(context);
    },
    projectCar: (context) => {
      if (recording) operations.push(`project-car:${context.entry.sessionId}`);
      return base.projectCar(context);
    },
    projectBall: (context) => {
      if (recording) operations.push('project-ball');
      return base.projectBall(context);
    },
  }));

  try {
    await join(core, 'host');
    await join(core, 'guest');
    await start(core, 'host');
    advanceSteps(core, MATCH_RULES.kickoffCountdownSteps);
    assert.equal(projection(core).phase, 'playing');

    operations.length = 0;
    recording = true;
    const frame = core.advanceSimulation(FIXED_STEP_MS);
    recording = false;
    assert.equal(frame.executedFixedSteps, 1);
    assert.deepEqual(operations, [
      'recover-ball-before',
      'recover-car-before:host',
      'recover-car-before:guest',
      'prepare-grounding',
      'ground:host',
      'ground:guest',
      'plan:host',
      'plan:guest',
      'apply:host',
      'apply:guest',
      'step-world',
      'recover-car-after:host',
      'recover-car-after:guest',
      'recover-ball-after',
      'commit:host',
      'commit:guest',
      'extract-events',
      'project-car:host',
      'project-car:guest',
      'project-ball',
    ]);

    const operationCount = operations.length;
    recording = true;
    const committed = projection(core);
    assert.strictEqual(projection(core), committed);
    recording = false;
    assert.equal(
      operations.length,
      operationCount,
      'adapter/publication reads must consume the retained projection without body reads',
    );
  } finally {
    core.dispose();
  }
});

// Validates: Requirements 1.6, 18.26

test('a staged simulation failure stops later work and frees the Rapier world exactly once', async () => {
  const operations: string[] = [];
  let disposeCalls = 0;
  const { core } = await createHarness((base) => ({
    ...base,
    recoverBallBeforeStep: (context) => {
      operations.push('recover-ball-before');
      base.recoverBallBeforeStep(context);
    },
    recoverCarBeforeStep: (context) => {
      operations.push(`recover-car-before:${context.entry.sessionId}`);
      base.recoverCarBeforeStep(context);
    },
    prepareGrounding: (context) => {
      operations.push('prepare-grounding');
      base.prepareGrounding(context);
    },
    groundCar: (context) => {
      operations.push(`ground:${context.entry.sessionId}`);
      throw new Error('injected grounding failure');
    },
    prepareCarCommand: (context) => {
      operations.push(`unexpected-plan:${context.entry.sessionId}`);
      return base.prepareCarCommand(context);
    },
    stepWorld: (context) => {
      operations.push('unexpected-step');
      base.stepWorld(context);
    },
    recoverCarAfterStep: (context) => {
      operations.push(`unexpected-post:${context.entry.sessionId}`);
      base.recoverCarAfterStep(context);
    },
    extractMatchFlowInput: (context) => {
      operations.push('unexpected-extract');
      return base.extractMatchFlowInput(context);
    },
    projectCar: (context) => {
      operations.push(`unexpected-project:${context.entry.sessionId}`);
      return base.projectCar(context);
    },
    dispose: () => {
      disposeCalls += 1;
      base.dispose();
    },
  }));

  const pending = core.queueMutation({ kind: 'join', sessionId: 'host', name: 'Host' });
  const frame = core.advanceSimulation(FIXED_STEP_MS);
  const result = await pending;
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  assert.equal(frame.executedFixedSteps, 0);
  assert.equal(frame.snapshotDue, false);
  assert.equal(core.lifecycle, 'fatal');
  assert.equal(core.diagnostics.fixedStepsCompleted, 0);
  assert.equal(core.projectAuthoritativeState(), null);
  assert.deepEqual(operations, [
    'recover-ball-before',
    'recover-car-before:host',
    'prepare-grounding',
    'ground:host',
  ]);
  assert.equal(disposeCalls, 1);

  core.dispose();
  core.dispose();
  assert.equal(disposeCalls, 1);
});
