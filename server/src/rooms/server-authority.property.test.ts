import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPUT_PROTOCOL_VERSION,
  MATCH_RULES,
  PHYSICS,
  ROOM_POLICIES,
  findAuthoritativeInputField,
  isInputCommandV2,
  normalizeInputCommandV2,
  type InputCommandV2,
} from '@rocket-arena/shared';
import type { RoomMutationRequest } from '../systems/room-mutations.js';
import {
  AuthoritativeRoomCore,
  createNeutralInputCommandV2,
  type AuthoritativeRoomMutationResult,
  type AuthoritativeRoomProjection,
  type AuthoritativeRoomWorldBundle,
} from './authoritative-room-core.js';

interface SeededRandom {
  readonly seed: string;
  next(): number;
  integer(minInclusive: number, maxInclusive: number): number;
  boolean(probability?: number): boolean;
  pick<T>(values: readonly T[]): T;
}

interface GeneratedCase<T> {
  readonly seed: string;
  readonly index: number;
  readonly value: T;
}

type CaseGenerator<T> = (random: SeededRandom, index: number) => T;

interface GeneratedCasesModule {
  generateCases<T>(options: {
    readonly seed: string | number;
    readonly count: number;
    readonly generate: CaseGenerator<T>;
  }): readonly GeneratedCase<T>[];
  replayCase<T>(
    seed: string | number,
    index: number,
    generate: CaseGenerator<T>,
  ): GeneratedCase<T>;
  assertGeneratedCases<T>(
    cases: readonly GeneratedCase<T>[],
    assertion: (value: T, generatedCase: GeneratedCase<T>) => void,
  ): void;
}

// Runtime loading preserves the shared seeded algorithm without widening the
// production server compiler's rootDir to include shared test sources.
const generatedCasesModuleUrl = new URL(
  '../../../shared/tests/support/generated-cases.ts',
  import.meta.url,
).href;
const {
  assertGeneratedCases,
  generateCases,
  replayCase,
} = await import(generatedCasesModuleUrl) as unknown as GeneratedCasesModule;

const RECORDED_SEED = 'rocket-arena-property-19-server-authority-v1';
const GENERATED_CASE_COUNT = 100;
const REPLAY_CASE_INDEX = 79;
const FIXED_STEP_MS = PHYSICS.TIMESTEP * 1_000;
const HOST_SESSION_ID = 'property-19-host';
const SERVER_TIME = 987_654;

type MutableVector3 = [number, number, number];
type MutableQuaternion = [number, number, number, number];

interface TestCar {
  readonly id: string;
  readonly position: MutableVector3;
  readonly rotation: MutableQuaternion;
  readonly linearVelocity: MutableVector3;
  readonly angularVelocity: MutableVector3;
  readonly boost: number;
  commandCommits: number;
  removed: boolean;
}

interface TestBall {
  readonly position: MutableVector3;
  readonly rotation: MutableQuaternion;
  readonly linearVelocity: MutableVector3;
  readonly angularVelocity: MutableVector3;
}

interface TestWorld {
  readonly cars: Map<string, TestCar>;
  readonly ball: TestBall;
  readonly plannedInputs: InputCommandV2[];
  physicsSteps: number;
  contactDigest: string;
  kickoffApplications: number;
  disposeCount: number;
  disposed: boolean;
}

type TestCore = AuthoritativeRoomCore<TestWorld, TestCar, TestBall>;
type MutationSuccess = Extract<AuthoritativeRoomMutationResult, { readonly ok: true }>;

interface ForgedAuthorityFields {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly transform: Readonly<{
    readonly position: readonly [number, number, number];
    readonly rotation: readonly [number, number, number, number];
  }>;
  readonly velocity: readonly [number, number, number];
  readonly linearVelocity: readonly [number, number, number];
  readonly angularVelocity: readonly [number, number, number];
  readonly contact: Readonly<Record<string, unknown>>;
  readonly contacts: readonly Readonly<Record<string, unknown>>[];
  readonly boost: number;
  readonly boostAmount: number;
  readonly boostInventory: number;
  readonly score: number;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly team: 'orange';
  readonly isHost: boolean;
  readonly phase: 'ended';
  readonly matchPhase: 'overtime';
  readonly winner: 'orange';
  readonly terminalResult: Readonly<Record<string, unknown>>;
  readonly latestTransition: Readonly<Record<string, unknown>>;
  readonly authority: Readonly<Record<string, unknown>>;
}

interface GeneratedAuthorityCase {
  readonly caseIndex: number;
  readonly controls: Readonly<InputCommandV2>;
  readonly forged: Readonly<ForgedAuthorityFields>;
}

interface AuthorityTrace {
  readonly plannedInput: Readonly<InputCommandV2>;
  readonly projection: Readonly<AuthoritativeRoomProjection>;
  readonly snapshot: unknown;
  readonly world: Readonly<{
    physicsSteps: number;
    contactDigest: string;
    commandCommits: number;
  }>;
}

interface Harness {
  readonly core: TestCore;
  readonly world: TestWorld;
}

const FLAT_GROUNDING = Object.freeze({
  grounded: true,
  basis: Object.freeze({
    normal: Object.freeze({ x: 0, y: 1, z: 0 }),
    forward: Object.freeze({ x: 0, y: 0, z: 1 }),
    right: Object.freeze({ x: 1, y: 0, z: 0 }),
  }),
});

function generatedAxis(random: SeededRandom): number {
  return random.integer(-1_000, 1_000) / 1_000;
}

function generateAuthorityCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedAuthorityCase {
  let throttle = generatedAxis(random);
  const steer = generatedAxis(random);
  const pitch = generatedAxis(random);
  const yaw = generatedAxis(random);
  const roll = generatedAxis(random);
  if ([throttle, steer, pitch, yaw, roll].every((value) => value === 0)) {
    throttle = caseIndex % 2 === 0 ? 0.5 : -0.5;
  }

  const controls: Readonly<InputCommandV2> = Object.freeze({
    protocolVersion: INPUT_PROTOCOL_VERSION,
    throttle,
    steer,
    pitch,
    yaw,
    roll,
    jumpHeld: random.boolean(),
    jumpSequence: random.integer(0, 1_000_000),
    boostHeld: random.boolean(),
    powerslideHeld: random.boolean(),
    cameraToggleSequence: random.integer(0, 1_000_000),
  });
  const forgedBase = 100_000 + caseIndex * 1_000 + random.integer(1, 999);
  const forgedPosition = Object.freeze([
    forgedBase,
    -forgedBase - 1,
    forgedBase + 2,
  ] as const);
  const forgedRotation = Object.freeze([
    0.5,
    -0.5,
    0.5,
    -0.5,
  ] as const);
  const forged: Readonly<ForgedAuthorityFields> = Object.freeze({
    x: forgedPosition[0],
    y: forgedPosition[1],
    z: forgedPosition[2],
    position: forgedPosition,
    rotation: forgedRotation,
    transform: Object.freeze({
      position: forgedPosition,
      rotation: forgedRotation,
    }),
    velocity: Object.freeze([forgedBase + 3, forgedBase + 4, forgedBase + 5] as const),
    linearVelocity: Object.freeze([
      -forgedBase - 6,
      forgedBase + 7,
      forgedBase + 8,
    ] as const),
    angularVelocity: Object.freeze([
      forgedBase + 9,
      -forgedBase - 10,
      forgedBase + 11,
    ] as const),
    contact: Object.freeze({
      grounded: false,
      colliderHandle: forgedBase,
      impulse: forgedBase + 12,
    }),
    contacts: Object.freeze([
      Object.freeze({ otherSessionId: `forged-${caseIndex}`, touching: true }),
    ]),
    boost: forgedBase + 13,
    boostAmount: forgedBase + 14,
    boostInventory: forgedBase + 15,
    score: forgedBase + 16,
    blueScore: forgedBase + 17,
    orangeScore: forgedBase + 18,
    team: 'orange',
    isHost: false,
    phase: 'ended',
    matchPhase: 'overtime',
    winner: 'orange',
    terminalResult: Object.freeze({
      eventId: forgedBase + 19,
      winner: 'orange',
      blueScore: 0,
      orangeScore: forgedBase + 20,
    }),
    latestTransition: Object.freeze({
      eventId: forgedBase + 21,
      kind: 'hard-cutoff',
    }),
    authority: Object.freeze({
      car: Object.freeze({ position: forgedPosition, team: 'orange' }),
      ball: Object.freeze({ position: forgedPosition }),
      match: Object.freeze({ phase: 'ended', score: forgedBase + 22 }),
    }),
  });

  return Object.freeze({ caseIndex, controls, forged });
}

function makeWorld(): TestWorld {
  return {
    cars: new Map(),
    ball: {
      position: [0, 1, 0],
      rotation: [0, 0, 0, 1],
      linearVelocity: [0.125, 0, -0.25],
      angularVelocity: [0, 0.1, 0],
    },
    plannedInputs: [],
    physicsSteps: 0,
    contactDigest: 'server-contact:initial',
    kickoffApplications: 0,
    disposeCount: 0,
    disposed: false,
  };
}

function cloneInput(input: Readonly<InputCommandV2>): InputCommandV2 {
  return { ...input };
}

function makeBundle(
  world: TestWorld,
): AuthoritativeRoomWorldBundle<TestWorld, TestCar, TestBall> {
  return {
    world,
    ball: world.ball,
    mutationResources: {
      prepareJoin: ({ entry }, scope) => {
        const car = scope.track<TestCar>(
          {
            id: entry.sessionId,
            position: [entry.acceptedJoinOrdinal, 0.5, entry.team === 'blue' ? -4 : 4],
            rotation: entry.team === 'blue' ? [0, 0, 0, 1] : [0, 1, 0, 0],
            linearVelocity: [0, 0, 0],
            angularVelocity: [0, 0, 0],
            boost: 41.25,
            commandCommits: 0,
            removed: false,
          },
          (temporary) => {
            temporary.removed = true;
            world.cars.delete(temporary.id);
          },
        );
        world.cars.set(entry.sessionId, car);
        return {
          car,
          input: createNeutralInputCommandV2(),
        };
      },
      prepareLeave: ({ car }) => ({
        commitRemoval: () => {
          car.removed = true;
          world.cars.delete(car.id);
        },
      }),
    },
    prepareKickoffPlacement: ({ ball, cars, assignmentSet }) => {
      const carSnapshots = new Map([...cars].map(([sessionId, car]) => [
        sessionId,
        {
          position: [...car.position] as MutableVector3,
          rotation: [...car.rotation] as MutableQuaternion,
          linearVelocity: [...car.linearVelocity] as MutableVector3,
          angularVelocity: [...car.angularVelocity] as MutableVector3,
        },
      ]));
      const ballSnapshot = {
        position: [...ball.position] as MutableVector3,
        linearVelocity: [...ball.linearVelocity] as MutableVector3,
        angularVelocity: [...ball.angularVelocity] as MutableVector3,
      };
      let applied = false;
      return {
        apply: () => {
          ball.position.splice(0, 3, 0, 1, 0);
          ball.linearVelocity.splice(0, 3, 0.125, 0, -0.25);
          ball.angularVelocity.splice(0, 3, 0, 0.1, 0);
          for (const [sessionId, car] of cars) {
            const assignment = assignmentSet.assignments.get(sessionId);
            assert.ok(assignment, `kickoff assignment missing for ${sessionId}`);
            car.position.splice(0, 3, ...assignment.position);
            car.rotation.splice(0, 4, ...assignment.rotation);
            car.linearVelocity.splice(0, 3, 0, 0, 0);
            car.angularVelocity.splice(0, 3, 0, 0, 0);
          }
          world.kickoffApplications += 1;
          applied = true;
        },
        rollback: () => {
          ball.position.splice(0, 3, ...ballSnapshot.position);
          ball.linearVelocity.splice(0, 3, ...ballSnapshot.linearVelocity);
          ball.angularVelocity.splice(0, 3, ...ballSnapshot.angularVelocity);
          for (const [sessionId, snapshot] of carSnapshots) {
            const car = cars.get(sessionId);
            assert.ok(car, `kickoff rollback car missing for ${sessionId}`);
            car.position.splice(0, 3, ...snapshot.position);
            car.rotation.splice(0, 4, ...snapshot.rotation);
            car.linearVelocity.splice(0, 3, ...snapshot.linearVelocity);
            car.angularVelocity.splice(0, 3, ...snapshot.angularVelocity);
          }
          if (applied) {
            world.kickoffApplications -= 1;
            applied = false;
          }
        },
      };
    },
    synchronizeCarInput: () => {},
    recoverBallBeforeStep: () => {},
    recoverCarBeforeStep: () => {},
    prepareGrounding: () => {},
    groundCar: () => FLAT_GROUNDING,
    prepareCarCommand: ({ car, input, fixedStepSeconds }) => {
      const plannedInput = cloneInput(input);
      world.plannedInputs.push(plannedInput);
      const boostDelta = input.boostHeld ? 0.3 : 0;
      const jumpDelta = input.jumpHeld ? 0.2 : 0;
      const nextLinearVelocity: MutableVector3 = [
        car.linearVelocity[0] + input.steer * 0.4 + input.roll * 0.1,
        car.linearVelocity[1] + input.pitch * 0.15 + jumpDelta,
        car.linearVelocity[2] + input.throttle * 0.6 + input.yaw * 0.1 + boostDelta,
      ];
      const nextAngularVelocity: MutableVector3 = [
        input.pitch * 0.5,
        input.steer * 0.75 + input.yaw * 0.25,
        input.roll * 0.5,
      ];
      let applied = false;
      let committed = false;
      return {
        apply: () => {
          assert.equal(applied, false, 'prepared command may apply only once');
          car.linearVelocity.splice(0, 3, ...nextLinearVelocity);
          car.angularVelocity.splice(0, 3, ...nextAngularVelocity);
          // Retain the exact fixed-step dependency in this meaningful fixture.
          assert.equal(fixedStepSeconds, PHYSICS.TIMESTEP);
          applied = true;
        },
        commit: () => {
          assert.equal(applied, true, 'command commit requires apply');
          assert.equal(committed, false, 'prepared command may commit only once');
          car.commandCommits += 1;
          committed = true;
        },
      };
    },
    stepWorld: ({ fixedStepSeconds }) => {
      world.physicsSteps += 1;
      for (const car of world.cars.values()) {
        car.position[0] += car.linearVelocity[0] * fixedStepSeconds;
        car.position[1] += car.linearVelocity[1] * fixedStepSeconds;
        car.position[2] += car.linearVelocity[2] * fixedStepSeconds;
      }
      world.ball.position[0] += world.ball.linearVelocity[0] * fixedStepSeconds;
      world.ball.position[1] += world.ball.linearVelocity[1] * fixedStepSeconds;
      world.ball.position[2] += world.ball.linearVelocity[2] * fixedStepSeconds;
      world.contactDigest = [...world.cars.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((car) => `${car.id}:${car.position.map((value) => value.toFixed(8)).join(',')}`)
        .join('|');
    },
    recoverCarAfterStep: () => {},
    recoverBallAfterStep: () => {},
    extractMatchFlowInput: () => Object.freeze({}),
    projectCar: ({ car }) => ({
      position: [...car.position] as MutableVector3,
      rotation: [...car.rotation] as MutableQuaternion,
      linearVelocity: [...car.linearVelocity] as MutableVector3,
      angularVelocity: [...car.angularVelocity] as MutableVector3,
      boost: car.boost,
    }),
    projectBall: ({ ball }) => ({
      position: [...ball.position] as MutableVector3,
      rotation: [...ball.rotation] as MutableQuaternion,
      linearVelocity: [...ball.linearVelocity] as MutableVector3,
      angularVelocity: [...ball.angularVelocity] as MutableVector3,
    }),
    dispose: () => {
      if (world.disposed) return;
      world.disposed = true;
      world.disposeCount += 1;
      world.cars.clear();
    },
  };
}

async function makeCore(caseIndex: number): Promise<Harness> {
  const world = makeWorld();
  const core = new AuthoritativeRoomCore<TestWorld, TestCar, TestBall>({
    roomId: `property-19-authority-${caseIndex}`,
    mode: 'custom',
    policy: ROOM_POLICIES.custom,
    initializeWorld: () => makeBundle(world),
    logger: { info: () => {}, error: () => {} },
  });
  await core.initialize();
  return { core, world };
}

function requireProjection(core: TestCore): Readonly<AuthoritativeRoomProjection> {
  const projection = core.projectAuthoritativeState();
  assert.ok(projection, 'ready authority fixture must expose a projection');
  return projection;
}

async function commitMutation(
  core: TestCore,
  request: RoomMutationRequest,
): Promise<MutationSuccess> {
  const completion = core.queueMutation(request);
  const frame = core.advanceSimulation(FIXED_STEP_MS);
  const result = await completion;
  assert.equal(frame.scheduledFixedSteps, 1);
  assert.equal(frame.executedFixedSteps, 1);
  assert.equal(frame.mutationResults.length, 1);
  if (!result.ok) assert.fail(`${result.code}: ${result.message}`);
  return result;
}

async function enterMeaningfulActivePlay(core: TestCore): Promise<void> {
  const joined = await commitMutation(core, {
    kind: 'join',
    sessionId: HOST_SESSION_ID,
    name: 'Property 19 Host',
  });
  assert.equal(joined.effect.kind, 'joined');
  const started = await commitMutation(core, {
    kind: 'start',
    sessionId: HOST_SESSION_ID,
  });
  assert.equal(started.effect.kind, 'start-validated');

  for (let index = 0; index < MATCH_RULES.kickoffCountdownSteps; index += 1) {
    const frame = core.advanceSimulation(FIXED_STEP_MS);
    assert.equal(frame.scheduledFixedSteps, 1);
    assert.equal(frame.executedFixedSteps, 1);
  }
  const projection = requireProjection(core);
  assert.equal(projection.phase, 'playing');
  assert.equal(projection.regulationStepsRemaining, MATCH_RULES.regulationActivePlaySteps);
  assert.equal(projection.cars.length, 1);
}

function canonicalWorld(world: TestWorld): Readonly<Record<string, unknown>> {
  return Object.freeze({
    physicsSteps: world.physicsSteps,
    contactDigest: world.contactDigest,
    kickoffApplications: world.kickoffApplications,
    ball: Object.freeze({
      position: [...world.ball.position],
      rotation: [...world.ball.rotation],
      linearVelocity: [...world.ball.linearVelocity],
      angularVelocity: [...world.ball.angularVelocity],
    }),
    cars: Object.freeze([...world.cars.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((car) => Object.freeze({
        id: car.id,
        position: [...car.position],
        rotation: [...car.rotation],
        linearVelocity: [...car.linearVelocity],
        angularVelocity: [...car.angularVelocity],
        boost: car.boost,
        commandCommits: car.commandCommits,
      }))),
  });
}

function forgedPayload(generated: GeneratedAuthorityCase): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...generated.controls,
    ...generated.forged,
  });
}

function assertForgedClaimsDifferFromAuthority(
  generated: GeneratedAuthorityCase,
  projection: Readonly<AuthoritativeRoomProjection>,
  world: TestWorld,
): void {
  const car = projection.cars[0];
  assert.ok(car);
  assert.notDeepEqual(generated.forged.position, car.position);
  assert.notDeepEqual(generated.forged.linearVelocity, car.linearVelocity);
  assert.notDeepEqual(generated.forged.angularVelocity, car.angularVelocity);
  assert.notEqual(generated.forged.boostInventory, car.boost);
  assert.notEqual(generated.forged.blueScore, projection.blueScore);
  assert.notEqual(generated.forged.orangeScore, projection.orangeScore);
  assert.notEqual(generated.forged.team, car.team);
  assert.notEqual(generated.forged.phase, projection.phase);
  assert.notEqual(JSON.stringify(generated.forged.contact), world.contactDigest);
}

async function exerciseAuthorityCase(
  generated: GeneratedAuthorityCase,
): Promise<AuthorityTrace> {
  let controlHarness: Harness | null = null;
  let forgedHarness: Harness | null = null;
  try {
    controlHarness = await makeCore(generated.caseIndex);
    forgedHarness = await makeCore(generated.caseIndex);
    await enterMeaningfulActivePlay(controlHarness.core);
    await enterMeaningfulActivePlay(forgedHarness.core);

    const beforeControl = requireProjection(controlHarness.core);
    const beforeForged = requireProjection(forgedHarness.core);
    assert.deepEqual(beforeForged, beforeControl);
    assert.deepEqual(canonicalWorld(forgedHarness.world), canonicalWorld(controlHarness.world));
    const controlPhysicsStepsBefore = controlHarness.world.physicsSteps;
    const forgedPhysicsStepsBefore = forgedHarness.world.physicsSteps;
    assert.equal(forgedPhysicsStepsBefore, controlPhysicsStepsBefore);
    assertForgedClaimsDifferFromAuthority(generated, beforeControl, controlHarness.world);

    const payload = forgedPayload(generated);
    assert.ok(findAuthoritativeInputField(payload) !== null);
    assert.equal(isInputCommandV2(payload), true, 'unknown extras must not suppress valid controls');
    assert.deepEqual(normalizeInputCommandV2(payload), generated.controls);
    assert.deepEqual(
      controlHarness.core.submitInput(HOST_SESSION_ID, generated.controls),
      { ok: true },
    );
    assert.deepEqual(
      forgedHarness.core.submitInput(HOST_SESSION_ID, payload),
      { ok: true },
      'the allow-list rejects forged authority by omission while retaining valid controls',
    );

    const controlFrame = controlHarness.core.advanceSimulation(FIXED_STEP_MS);
    const forgedFrame = forgedHarness.core.advanceSimulation(FIXED_STEP_MS);
    assert.equal(controlFrame.scheduledFixedSteps, 1);
    assert.equal(controlFrame.executedFixedSteps, 1);
    assert.equal(forgedFrame.scheduledFixedSteps, 1);
    assert.equal(forgedFrame.executedFixedSteps, 1);
    assert.equal(controlHarness.world.physicsSteps, controlPhysicsStepsBefore + 1);
    assert.equal(forgedHarness.world.physicsSteps, forgedPhysicsStepsBefore + 1);

    const nextControl = requireProjection(controlHarness.core);
    const nextForged = requireProjection(forgedHarness.core);
    assert.equal(nextControl.fixedStepsCompleted, beforeControl.fixedStepsCompleted + 1);
    assert.equal(nextForged.fixedStepsCompleted, beforeForged.fixedStepsCompleted + 1);
    assert.equal(
      nextControl.regulationStepsRemaining,
      beforeControl.regulationStepsRemaining - 1,
    );
    assert.equal(nextControl.phase, 'playing');
    assert.deepEqual(nextForged, nextControl);
    assert.deepEqual(canonicalWorld(forgedHarness.world), canonicalWorld(controlHarness.world));

    assert.equal(controlHarness.world.plannedInputs.length, 1);
    assert.equal(forgedHarness.world.plannedInputs.length, 1);
    assert.deepEqual(controlHarness.world.plannedInputs[0], generated.controls);
    assert.deepEqual(forgedHarness.world.plannedInputs[0], generated.controls);
    assert.notDeepEqual(
      nextControl.cars[0]!.position,
      beforeControl.cars[0]!.position,
      'non-neutral valid controls must produce meaningful Active Play motion',
    );

    const controlSnapshot = controlHarness.core.buildSnapshotV2(nextControl, SERVER_TIME);
    const forgedSnapshot = forgedHarness.core.buildSnapshotV2(nextForged, SERVER_TIME);
    assert.ok(controlSnapshot);
    assert.ok(forgedSnapshot);
    assert.deepEqual(forgedSnapshot, controlSnapshot);

    const authoritativeCar = nextForged.cars[0]!;
    assert.equal(authoritativeCar.team, beforeForged.cars[0]!.team);
    assert.equal(authoritativeCar.boost, beforeForged.cars[0]!.boost);
    assert.equal(nextForged.blueScore, beforeForged.blueScore);
    assert.equal(nextForged.orangeScore, beforeForged.orangeScore);
    assert.equal(nextForged.phase, 'playing');
    assert.notDeepEqual(authoritativeCar.position, generated.forged.position);
    assert.notDeepEqual(authoritativeCar.linearVelocity, generated.forged.linearVelocity);
    assert.notDeepEqual(authoritativeCar.angularVelocity, generated.forged.angularVelocity);

    return Object.freeze({
      plannedInput: Object.freeze({ ...controlHarness.world.plannedInputs[0]! }),
      projection: nextControl,
      snapshot: controlSnapshot,
      world: Object.freeze({
        physicsSteps: controlHarness.world.physicsSteps,
        contactDigest: controlHarness.world.contactDigest,
        commandCommits: controlHarness.world.cars.get(HOST_SESSION_ID)!.commandCommits,
      }),
    });
  } finally {
    if (controlHarness !== null) {
      controlHarness.core.dispose();
      assert.equal(controlHarness.world.disposeCount, 1);
    }
    if (forgedHarness !== null) {
      forgedHarness.core.dispose();
      assert.equal(forgedHarness.world.disposeCount, 1);
    }
  }
}

async function exerciseWithDiagnostics(
  generatedCase: GeneratedCase<GeneratedAuthorityCase>,
): Promise<AuthorityTrace> {
  try {
    return await exerciseAuthorityCase(generatedCase.value);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Generated case failed (seed=${JSON.stringify(generatedCase.seed)}, index=${generatedCase.index}): ${detail}`,
      { cause },
    );
  }
}

function canonicalInputTrace(generatedCase: GeneratedCase<GeneratedAuthorityCase>): unknown {
  return Object.freeze({
    seed: generatedCase.seed,
    index: generatedCase.index,
    ...generatedCase.value,
  });
}

async function executeGeneratedCases(
  cases: readonly GeneratedCase<GeneratedAuthorityCase>[],
): Promise<readonly AuthorityTrace[]> {
  const traces: AuthorityTrace[] = [];
  for (const generatedCase of cases) {
    traces.push(await exerciseWithDiagnostics(generatedCase));
  }
  return Object.freeze(traces);
}

/**
 * Feature: rocket-arena, Property 19: Server authority preservation
 * **Validates: Requirements 1.1-1.3, 18.18, 18.25**
 *
 * Requirement 18.18's loose "rejection" wording is enforced at the authority
 * field level: the allow-list discards forged extras while equal valid controls
 * remain accepted and drive the same next authoritative fixed step.
 */
test(
  `Property 19: control allow-list preserves server authority (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  async () => {
    const cases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateAuthorityCase,
    });
    const regeneratedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateAuthorityCase,
    });
    const replayedCase = replayCase(
      RECORDED_SEED,
      REPLAY_CASE_INDEX,
      generateAuthorityCase,
    );

    assert.equal(cases.length, GENERATED_CASE_COUNT);
    assert.equal(regeneratedCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(
      cases.map(canonicalInputTrace),
      regeneratedCases.map(canonicalInputTrace),
    );
    assert.deepEqual(
      canonicalInputTrace(replayedCase),
      canonicalInputTrace(cases[REPLAY_CASE_INDEX]!),
    );

    assertGeneratedCases(cases, (generated, generatedCase) => {
      assert.equal(generated.caseIndex, generatedCase.index);
      assert.equal(isInputCommandV2(generated.controls), true);
      const payload = forgedPayload(generated);
      assert.equal(isInputCommandV2(payload), true);
      assert.deepEqual(normalizeInputCommandV2(payload), generated.controls);
      assert.ok(findAuthoritativeInputField(payload) !== null);
      for (const requiredField of [
        'transform',
        'contact',
        'boostInventory',
        'score',
        'team',
        'phase',
      ] as const) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(payload, requiredField),
          true,
          `generated forged payload must include ${requiredField}`,
        );
      }
    });

    const firstTraces = await executeGeneratedCases(cases);
    const regeneratedTraces = await executeGeneratedCases(regeneratedCases);
    assert.deepEqual(regeneratedTraces, firstTraces);

    const replayedTrace = await exerciseWithDiagnostics(replayedCase);
    assert.deepEqual(replayedTrace, firstTraces[REPLAY_CASE_INDEX]);
    assertGeneratedCases(cases, (_generated, generatedCase) => {
      assert.deepEqual(
        regeneratedTraces[generatedCase.index],
        firstTraces[generatedCase.index],
      );
    });
  },
);
