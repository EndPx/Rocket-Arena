import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPUT_PROTOCOL_VERSION,
  MATCH_RULES,
  PHYSICS,
  type InputCommandV2,
  type RoomMutationErrorCode,
} from '@rocket-arena/shared';
import type { RoomMutationRequest } from '../systems/room-mutations.js';
import {
  createCustomRoomCore,
} from './custom-room.js';
import {
  type AuthoritativeRoomCore,
  type AuthoritativeRoomMutationResult,
  type AuthoritativeRoomProjection,
  type AuthoritativeRoomWorldBundle,
} from './authoritative-room-core.js';

interface SeededRandom {
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

// Shared generated-case support is outside the server project's emit root.
// Runtime loading keeps one seeded implementation without widening rootDir.
const generatedCasesModuleUrl = new URL(
  '../../../shared/tests/support/generated-cases.ts',
  import.meta.url,
).href;
const {
  assertGeneratedCases,
  generateCases,
  replayCase,
} = await import(generatedCasesModuleUrl) as unknown as GeneratedCasesModule;

const RECORDED_SEED = 'rocket-arena-property-5-custom-host-v1';
const GENERATED_CASE_COUNT = 100;
const REPLAY_CASE_INDEX = 61;
const INITIAL_COUNTDOWN_STEPS = 180;
const REGULATION_STEPS = 18_000;
const FIXED_STEP_MS = PHYSICS.TIMESTEP * 1000;
const CLOCK_EPSILON_MS = 1e-7;

const REQUESTER_CLASSES = Object.freeze([
  'host',
  'non-host',
  'unrepresented',
] as const);
type RequesterClass = typeof REQUESTER_CLASSES[number];

type SuccessionPhase = 'waiting' | 'countdown';
type OrderVariant = 'lexical' | 'reverse' | 'seeded-shuffle';

interface GeneratedIdentity {
  readonly sessionId: string;
  readonly name: string;
}

interface GeneratedCustomHostCase {
  readonly caseIndex: number;
  readonly rosterSize: number;
  readonly successionPhase: SuccessionPhase;
  readonly orderVariant: OrderVariant;
  readonly identities: readonly GeneratedIdentity[];
  readonly waitingRequesterClasses: readonly RequesterClass[];
  readonly nonHostRequesterSessionId: string;
  readonly unrepresentedRequesterSessionId: string;
  readonly leaveBeforeHostSessionIds: readonly string[];
  readonly expectedSuccessorSessionId: string;
  readonly countdownProgressSteps: number;
}

interface TestCar {
  readonly id: string;
  readonly position: [number, number, number];
  readonly rotation: [number, number, number, number];
  readonly linearVelocity: [number, number, number];
  readonly angularVelocity: [number, number, number];
  readonly boost: number;
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
  readonly ball: TestBall;
  readonly removedSessionIds: string[];
  fixedSteps: number;
  kickoffApplyCount: number;
  kickoffRollbackCount: number;
  disposeCount: number;
}

type TestCore = AuthoritativeRoomCore<TestWorld, TestCar, TestBall>;

interface CaseTraceEvent {
  readonly label: string;
  readonly result: unknown | null;
  readonly state: unknown;
}

function shuffle<T>(values: readonly T[], random: SeededRandom): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = random.integer(0, index);
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function generateCustomHostCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedCustomHostCase {
  const rosterSize = 2 + caseIndex % 7;
  const orderVariant: OrderVariant = (
    ['lexical', 'reverse', 'seeded-shuffle'] as const
  )[caseIndex % 3]!;
  const labels = Array.from({ length: rosterSize }, (_, index) => index);
  const orderedLabels = orderVariant === 'lexical'
    ? labels
    : orderVariant === 'reverse'
      ? [...labels].reverse()
      : shuffle(labels, random);
  const identities = orderedLabels.map((label, acceptedIndex): GeneratedIdentity => {
    const nonce = random.integer(0, 0xff_ffff).toString(16).padStart(6, '0');
    const sessionId = `property-5-${caseIndex.toString().padStart(3, '0')}`
      + `-${label.toString().padStart(2, '0')}-${nonce}`;
    return Object.freeze({
      sessionId,
      name: `Identity ${caseIndex}-${acceptedIndex}-${label}-${nonce}`,
    });
  });
  const successorAcceptedIndex = random.integer(1, rosterSize - 1);
  const expectedSuccessor = identities[successorAcceptedIndex]!;
  const leaveBeforeHost = identities
    .slice(1, successorAcceptedIndex)
    .map(({ sessionId }) => sessionId);
  for (const identity of identities.slice(successorAcceptedIndex + 1)) {
    if (random.boolean(0.35)) leaveBeforeHost.push(identity.sessionId);
  }
  const rejectedClasses: readonly RequesterClass[] = random.boolean()
    ? ['non-host', 'unrepresented']
    : ['unrepresented', 'non-host'];

  return Object.freeze({
    caseIndex,
    rosterSize,
    successionPhase: caseIndex % 2 === 0 ? 'waiting' : 'countdown',
    orderVariant,
    identities: Object.freeze(identities),
    waitingRequesterClasses: Object.freeze([
      ...rejectedClasses,
      'host',
    ] satisfies readonly RequesterClass[]),
    nonHostRequesterSessionId: random.pick(identities.slice(1)).sessionId,
    unrepresentedRequesterSessionId: `property-5-${caseIndex.toString().padStart(3, '0')}`
      + `-unrepresented-${random.integer(0, 0xff_ffff).toString(16).padStart(6, '0')}`,
    leaveBeforeHostSessionIds: Object.freeze(shuffle(leaveBeforeHost, random)),
    expectedSuccessorSessionId: expectedSuccessor.sessionId,
    countdownProgressSteps: random.integer(1, 24),
  });
}

function makeBall(): TestBall {
  return {
    position: [0, 1, 0],
    rotation: [0, 0, 0, 1],
    linearVelocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  };
}

function makeWorld(): TestWorld {
  return {
    cars: new Map(),
    ball: makeBall(),
    removedSessionIds: [],
    fixedSteps: 0,
    kickoffApplyCount: 0,
    kickoffRollbackCount: 0,
    disposeCount: 0,
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
  return {
    world,
    ball: world.ball,
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
        position: [...world.ball.position] as [number, number, number],
        linearVelocity: [...world.ball.linearVelocity] as [number, number, number],
        angularVelocity: [...world.ball.angularVelocity] as [number, number, number],
      };
      return {
        apply: () => {
          world.kickoffApplyCount += 1;
          world.ball.position.splice(0, 3, 0, 1, 0);
          world.ball.linearVelocity.splice(0, 3, 0, 0, 0);
          world.ball.angularVelocity.splice(0, 3, 0, 0, 0);
          for (const [sessionId, car] of cars) {
            const assignment = assignmentSet.assignments.get(sessionId);
            assert.ok(assignment, `missing kickoff assignment for ${sessionId}`);
            car.position.splice(0, 3, ...assignment.position);
            car.rotation.splice(0, 4, ...assignment.rotation);
            car.linearVelocity.splice(0, 3, 0, 0, 0);
            car.angularVelocity.splice(0, 3, 0, 0, 0);
          }
        },
        rollback: () => {
          world.kickoffRollbackCount += 1;
          world.ball.position.splice(0, 3, ...ballSnapshot.position);
          world.ball.linearVelocity.splice(0, 3, ...ballSnapshot.linearVelocity);
          world.ball.angularVelocity.splice(0, 3, ...ballSnapshot.angularVelocity);
          for (const [sessionId, snapshot] of carSnapshots) {
            const car = cars.get(sessionId);
            assert.ok(car, `missing rollback car ${sessionId}`);
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
    projectBall: ({ ball }) => ({
      position: [...ball.position],
      rotation: [...ball.rotation],
      linearVelocity: [...ball.linearVelocity],
      angularVelocity: [...ball.angularVelocity],
    }),
    dispose: () => { world.disposeCount += 1; },
  };
}

function makeCore(generated: GeneratedCustomHostCase): {
  readonly core: TestCore;
  readonly world: TestWorld;
} {
  const world = makeWorld();
  const core = createCustomRoomCore<TestWorld, TestCar, TestBall>({
    roomId: `property-5-custom-host-${generated.caseIndex}`,
    initializeWorld: () => makeBundle(world),
    logger: { info: () => {}, error: () => {} },
  });
  return { core, world };
}

async function commitMutation(
  core: TestCore,
  request: RoomMutationRequest,
): Promise<AuthoritativeRoomMutationResult> {
  const completion = core.queueMutation(request);
  const frame = core.advanceSimulation(FIXED_STEP_MS);
  const result = await completion;

  assert.equal(frame.scheduledFixedSteps, 1);
  assert.equal(frame.executedFixedSteps, 1);
  assert.equal(frame.mutationResults.length, 1);
  assert.equal(frame.mutationResults[0]?.queueSequence, result.queueSequence);
  return result;
}

function advanceFixedSteps(core: TestCore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const frame = core.advanceSimulation(FIXED_STEP_MS);
    assert.equal(frame.scheduledFixedSteps, 1);
    assert.equal(frame.executedFixedSteps, 1);
    assert.equal(frame.mutationResults.length, 0);
  }
}

function requireProjection(core: TestCore): Readonly<AuthoritativeRoomProjection> {
  const projection = core.projectAuthoritativeState();
  assert.ok(projection, 'ready Custom core must expose an authoritative projection');
  return projection;
}

function compareStableEntries(
  left: Pick<AuthoritativeRoomProjection['cars'][number], 'acceptedJoinOrdinal' | 'sessionId'>,
  right: Pick<AuthoritativeRoomProjection['cars'][number], 'acceptedJoinOrdinal' | 'sessionId'>,
): number {
  return left.acceptedJoinOrdinal - right.acceptedJoinOrdinal
    || left.sessionId.localeCompare(right.sessionId);
}

function canonicalKickoff(core: TestCore) {
  const assignmentSet = core.kickoffAssignmentSet;
  if (assignmentSet === null) return null;
  return {
    epoch: assignmentSet.epoch,
    rosterSignature: assignmentSet.rosterSignature,
    assignments: [...assignmentSet.assignments.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sessionId, assignment]) => ({
        sessionId,
        team: assignment.team,
        slotId: assignment.slotId,
        slotIndex: assignment.slotIndex,
        position: [...assignment.position],
        rotation: [...assignment.rotation],
      })),
  };
}

function canonicalWorld(world: TestWorld) {
  return {
    cars: [...world.cars.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sessionId, car]) => ({
        sessionId,
        id: car.id,
        position: [...car.position],
        rotation: [...car.rotation],
        linearVelocity: [...car.linearVelocity],
        angularVelocity: [...car.angularVelocity],
        boost: car.boost,
        removed: car.removed,
      })),
    ball: {
      position: [...world.ball.position],
      rotation: [...world.ball.rotation],
      linearVelocity: [...world.ball.linearVelocity],
      angularVelocity: [...world.ball.angularVelocity],
    },
    removedSessionIds: [...world.removedSessionIds],
    fixedSteps: world.fixedSteps,
    kickoffApplyCount: world.kickoffApplyCount,
    kickoffRollbackCount: world.kickoffRollbackCount,
    disposeCount: world.disposeCount,
  };
}

function canonicalPublicState(core: TestCore, world: TestWorld) {
  const matchFlow = core.matchFlowState;
  assert.ok(matchFlow, 'ready Custom core must expose public match-flow state');
  return structuredClone({
    projection: requireProjection(core),
    matchFlow,
    kickoff: canonicalKickoff(core),
    diagnostics: core.diagnostics,
    world: canonicalWorld(world),
  });
}

type CanonicalPublicState = ReturnType<typeof canonicalPublicState>;

function authorityWithoutOrdinaryClock(state: CanonicalPublicState): unknown {
  return structuredClone({
    ...state,
    projection: {
      ...state.projection,
      simulationTimeMs: 0,
      fixedStepsCompleted: 0,
      phaseSecondsRemaining: 0,
      countdownStepsRemaining: 0,
    },
    matchFlow: {
      ...state.matchFlow,
      countdownStepsRemaining: 0,
    },
    diagnostics: {
      ...state.diagnostics,
      simulationTimeMs: 0,
      fixedStepsCompleted: 0,
    },
    world: {
      ...state.world,
      fixedSteps: 0,
    },
  });
}

function assertFixedStepClockProgress(
  before: CanonicalPublicState,
  after: CanonicalPublicState,
  completedSteps: number,
): void {
  assert.equal(
    after.projection.fixedStepsCompleted,
    before.projection.fixedStepsCompleted + completedSteps,
  );
  assert.equal(
    after.diagnostics.fixedStepsCompleted,
    before.diagnostics.fixedStepsCompleted + completedSteps,
  );
  assert.equal(after.world.fixedSteps, before.world.fixedSteps + completedSteps);
  const elapsedMs = after.projection.simulationTimeMs - before.projection.simulationTimeMs;
  assert.ok(
    Math.abs(elapsedMs - completedSteps * FIXED_STEP_MS) <= CLOCK_EPSILON_MS,
    `expected ${completedSteps} ordinary fixed steps, received ${elapsedMs}ms`,
  );
  assert.equal(after.diagnostics.simulationTimeMs, after.projection.simulationTimeMs);
}

function assertOnlyOrdinaryClockProgress(
  before: CanonicalPublicState,
  after: CanonicalPublicState,
  completedSteps: number,
): void {
  assertFixedStepClockProgress(before, after, completedSteps);
  assert.equal(after.projection.phase, before.projection.phase);
  assert.equal(after.matchFlow.phase, before.matchFlow.phase);
  if (before.projection.phase === 'countdown') {
    assert.ok(before.projection.countdownStepsRemaining > completedSteps);
    assert.equal(
      after.projection.countdownStepsRemaining,
      before.projection.countdownStepsRemaining - completedSteps,
    );
    assert.equal(
      after.matchFlow.countdownStepsRemaining,
      before.matchFlow.countdownStepsRemaining - completedSteps,
    );
  } else {
    assert.equal(
      after.projection.countdownStepsRemaining,
      before.projection.countdownStepsRemaining,
    );
    assert.equal(
      after.matchFlow.countdownStepsRemaining,
      before.matchFlow.countdownStepsRemaining,
    );
  }
  assert.deepEqual(
    authorityWithoutOrdinaryClock(after),
    authorityWithoutOrdinaryClock(before),
    'authority must be unchanged apart from ordinary fixed-step clock progress',
  );
}

function canonicalMutationResult(result: AuthoritativeRoomMutationResult): unknown {
  if (result.ok) {
    return structuredClone({
      ok: true,
      queueSequence: result.queueSequence,
      effect: result.effect,
      revision: result.revision,
    });
  }
  return {
    ok: false,
    queueSequence: result.queueSequence,
    code: result.code,
    fatal: result.fatal,
  };
}

function appendTrace(
  events: CaseTraceEvent[],
  label: string,
  core: TestCore,
  world: TestWorld,
  result: AuthoritativeRoomMutationResult | null = null,
): void {
  events.push(Object.freeze({
    label,
    result: result === null ? null : canonicalMutationResult(result),
    state: canonicalPublicState(core, world),
  }));
}

function assertSoleHost(
  projection: Readonly<AuthoritativeRoomProjection>,
  expectedHostSessionId: string,
): void {
  assert.equal(projection.hostSessionId, expectedHostSessionId);
  assert.deepEqual(
    projection.cars.filter(({ isHost }) => isHost).map(({ sessionId }) => sessionId),
    [expectedHostSessionId],
  );
  for (const car of projection.cars) {
    assert.equal(car.isHost, car.sessionId === expectedHostSessionId);
  }
}

function rosterFields(projection: Readonly<AuthoritativeRoomProjection>): readonly unknown[] {
  return projection.cars.map(({
    sessionId,
    acceptedJoinOrdinal,
    team,
    name,
    isHost,
  }) => ({ sessionId, acceptedJoinOrdinal, team, name, isHost }));
}

async function assertRejectedAtomically(
  core: TestCore,
  world: TestWorld,
  events: CaseTraceEvent[],
  label: string,
  request: RoomMutationRequest,
  expectedCode: RoomMutationErrorCode,
): Promise<void> {
  const before = canonicalPublicState(core, world);
  const result = await commitMutation(core, request);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, expectedCode);
  assert.equal(result.fatal, false);
  const after = canonicalPublicState(core, world);
  assertOnlyOrdinaryClockProgress(before, after, 1);
  appendTrace(events, label, core, world, result);
}

async function joinGeneratedRoster(
  core: TestCore,
  world: TestWorld,
  generated: GeneratedCustomHostCase,
  events: CaseTraceEvent[],
): Promise<string> {
  const firstIdentity = generated.identities[0]!;

  for (const [acceptedIndex, identity] of generated.identities.entries()) {
    const result = await commitMutation(core, {
      kind: 'join',
      sessionId: identity.sessionId,
      name: identity.name,
    });
    assert.equal(result.ok, true, result.ok ? undefined : result.message);
    if (!result.ok) continue;
    assert.equal(result.effect.kind, 'joined');
    if (result.effect.kind === 'joined') {
      assert.deepEqual(result.effect.entry, {
        sessionId: identity.sessionId,
        acceptedJoinOrdinal: acceptedIndex,
        team: acceptedIndex % 2 === 0 ? 'blue' : 'orange',
        name: identity.name,
        isHost: acceptedIndex === 0,
      });
    }

    const current = requireProjection(core);
    assert.equal(current.cars.length, acceptedIndex + 1);
    assertSoleHost(current, firstIdentity.sessionId);
    assert.equal(
      current.cars.find(({ sessionId }) => sessionId === identity.sessionId)?.name,
      identity.name,
    );
    appendTrace(events, `join-${acceptedIndex}`, core, world, result);
  }

  const projection = requireProjection(core);
  assert.equal(projection.cars.length, generated.rosterSize);
  assert.equal(projection.occupancy.total, generated.rosterSize);
  assert.ok(projection.occupancy.blue <= 4);
  assert.ok(projection.occupancy.orange <= 4);
  assert.equal(projection.occupancy.blue + projection.occupancy.orange, generated.rosterSize);
  assert.deepEqual(
    projection.cars.map(({ sessionId, name }) => ({ sessionId, name })),
    generated.identities,
  );
  assert.equal(core.isStartEligible, true);
  return firstIdentity.sessionId;
}

async function assertAcceptedStart(
  core: TestCore,
  world: TestWorld,
  events: CaseTraceEvent[],
  hostSessionId: string,
  label: string,
): Promise<void> {
  const before = canonicalPublicState(core, world);
  assert.equal(before.projection.phase, 'waiting');
  assertSoleHost(before.projection, hostSessionId);
  assert.equal(core.isStartEligible, true);
  assert.equal(world.kickoffApplyCount, 0);

  const result = await commitMutation(core, { kind: 'start', sessionId: hostSessionId });
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  if (!result.ok) return;
  assert.deepEqual(result.effect, { kind: 'start-validated', sessionId: hostSessionId });

  const after = canonicalPublicState(core, world);
  assertFixedStepClockProgress(before, after, 1);
  assert.equal(after.projection.phase, 'countdown');
  assert.equal(after.projection.countdownKind, 'initial');
  assert.equal(after.projection.countdownStepsRemaining, INITIAL_COUNTDOWN_STEPS);
  assert.equal(after.projection.regulationStepsRemaining, REGULATION_STEPS);
  assert.equal(after.matchFlow.phase, 'countdown');
  assert.equal(after.matchFlow.countdownKind, 'initial');
  assert.equal(after.matchFlow.countdownStepsRemaining, INITIAL_COUNTDOWN_STEPS);
  assert.equal(after.matchFlow.regulationStepsRemaining, REGULATION_STEPS);
  assertSoleHost(after.projection, hostSessionId);
  assert.deepEqual(rosterFields(after.projection), rosterFields(before.projection));
  assert.equal(core.isStartEligible, false);
  assert.equal(world.kickoffApplyCount, 1, 'accepted start must apply exactly one kickoff');
  assert.equal(world.kickoffRollbackCount, 0);
  assert.ok(after.kickoff);
  assert.equal(after.kickoff.epoch, 1);
  assert.equal(after.kickoff.assignments.length, after.projection.cars.length);
  assert.deepEqual(
    after.kickoff.assignments.map(({ sessionId }) => sessionId).sort(),
    after.projection.cars.map(({ sessionId }) => sessionId).sort(),
  );
  assert.equal(result.revision, after.projection.revision);
  appendTrace(events, label, core, world, result);
}

async function assertAcceptedLeave(
  core: TestCore,
  world: TestWorld,
  events: CaseTraceEvent[],
  sessionId: string,
  label: string,
): Promise<string> {
  const before = canonicalPublicState(core, world);
  const leavingEntry = before.projection.cars.find((car) => car.sessionId === sessionId);
  assert.ok(leavingEntry, `represented leave requires ${sessionId}`);
  const remaining = before.projection.cars.filter((car) => car.sessionId !== sessionId);
  assert.ok(remaining.length > 0, 'generated succession must retain at least one identity');
  const expectedHostSessionId = leavingEntry.isHost
    ? [...remaining].sort(compareStableEntries)[0]!.sessionId
    : before.projection.hostSessionId;
  assert.ok(expectedHostSessionId);
  const removedCar = world.cars.get(sessionId);
  assert.ok(removedCar);

  const result = await commitMutation(core, { kind: 'leave', sessionId });
  assert.equal(result.ok, true, result.ok ? undefined : result.message);
  if (!result.ok) return expectedHostSessionId;
  assert.deepEqual(result.effect, {
    kind: 'left',
    sessionId,
    successorHostSessionId: expectedHostSessionId,
  });

  const after = canonicalPublicState(core, world);
  assertFixedStepClockProgress(before, after, 1);
  assert.equal(after.projection.phase, before.projection.phase);
  assert.equal(after.projection.countdownKind, before.projection.countdownKind);
  const expectedCountdown = before.projection.phase === 'countdown'
    ? before.projection.countdownStepsRemaining - 1
    : before.projection.countdownStepsRemaining;
  assert.equal(after.projection.countdownStepsRemaining, expectedCountdown);
  assert.equal(after.matchFlow.countdownStepsRemaining, expectedCountdown);
  const expectedFlow = structuredClone({
    ...before.matchFlow,
    countdownStepsRemaining: expectedCountdown,
  });
  assert.deepEqual(after.matchFlow, expectedFlow);
  assert.deepEqual(after.kickoff, before.kickoff);
  assert.equal(
    after.projection.revision,
    before.projection.revision + 2,
    'represented leave records one tombstone revision and one committed removal revision',
  );
  assert.equal(result.revision, after.projection.revision);

  const expectedCars = remaining.map((car) => ({
    ...car,
    isHost: car.sessionId === expectedHostSessionId,
  }));
  const blue = expectedCars.filter(({ team }) => team === 'blue').length;
  const orange = expectedCars.filter(({ team }) => team === 'orange').length;
  const expectedProjection = structuredClone({
    ...before.projection,
    revision: before.projection.revision + 2,
    simulationTimeMs: after.projection.simulationTimeMs,
    fixedStepsCompleted: before.projection.fixedStepsCompleted + 1,
    phaseSecondsRemaining: before.projection.phase === 'countdown'
      ? expectedCountdown / MATCH_RULES.fixedStepsPerSecond
      : before.projection.phaseSecondsRemaining,
    countdownStepsRemaining: expectedCountdown,
    occupancy: { total: expectedCars.length, blue, orange },
    hostSessionId: expectedHostSessionId,
    cars: expectedCars,
  });
  assert.deepEqual(
    after.projection,
    expectedProjection,
    'leave must preserve every surviving name, team, ordinal, and body projection',
  );
  assertSoleHost(after.projection, expectedHostSessionId);

  const expectedWorld = structuredClone({
    ...before.world,
    cars: before.world.cars.filter((car) => car.sessionId !== sessionId),
    removedSessionIds: [...before.world.removedSessionIds, sessionId],
    fixedSteps: before.world.fixedSteps + 1,
  });
  assert.deepEqual(after.world, expectedWorld);
  assert.equal(removedCar.removed, true);
  assert.equal(world.cars.has(sessionId), false);
  assert.deepEqual(
    after.diagnostics.tombstonedSessionIds,
    [...before.diagnostics.tombstonedSessionIds, sessionId]
      .sort((left, right) => left.localeCompare(right)),
  );
  appendTrace(events, label, core, world, result);
  return expectedHostSessionId;
}

async function assertWaitingRequesterClasses(
  core: TestCore,
  world: TestWorld,
  generated: GeneratedCustomHostCase,
  events: CaseTraceEvent[],
): Promise<void> {
  assert.deepEqual(
    [...generated.waitingRequesterClasses].sort(),
    [...REQUESTER_CLASSES].sort(),
  );
  assert.equal(generated.waitingRequesterClasses.at(-1), 'host');

  for (const requesterClass of generated.waitingRequesterClasses.slice(0, -1)) {
    if (requesterClass === 'non-host') {
      await assertRejectedAtomically(
        core,
        world,
        events,
        'waiting-start-non-host',
        { kind: 'start', sessionId: generated.nonHostRequesterSessionId },
        'not-host',
      );
    } else {
      assert.equal(requesterClass, 'unrepresented');
      await assertRejectedAtomically(
        core,
        world,
        events,
        'waiting-start-unrepresented',
        { kind: 'start', sessionId: generated.unrepresentedRequesterSessionId },
        'not-represented',
      );
    }
  }
}

async function assertWrongPhaseRequests(
  core: TestCore,
  world: TestWorld,
  generated: GeneratedCustomHostCase,
  events: CaseTraceEvent[],
): Promise<void> {
  const current = requireProjection(core);
  assert.equal(current.phase, 'countdown');
  const hostSessionId = current.hostSessionId;
  assert.ok(hostSessionId);

  await assertRejectedAtomically(
    core,
    world,
    events,
    'countdown-repeat-host-start',
    { kind: 'start', sessionId: hostSessionId },
    'wrong-phase',
  );

  const representedNonHost = requireProjection(core).cars.find(({ isHost }) => !isHost);
  if (representedNonHost !== undefined) {
    await assertRejectedAtomically(
      core,
      world,
      events,
      'countdown-non-host-start',
      { kind: 'start', sessionId: representedNonHost.sessionId },
      'wrong-phase',
    );
  }

  await assertRejectedAtomically(
    core,
    world,
    events,
    'countdown-unrepresented-start',
    { kind: 'start', sessionId: generated.unrepresentedRequesterSessionId },
    'not-represented',
  );
  assert.equal(world.kickoffApplyCount, 1, 'rejected starts cannot create another countdown');
  assert.equal(world.kickoffRollbackCount, 0);
}

function assertGeneratedMetadata(
  generated: GeneratedCustomHostCase,
  generatedCase: GeneratedCase<GeneratedCustomHostCase>,
): void {
  assert.equal(generatedCase.seed, RECORDED_SEED);
  assert.equal(generatedCase.index, generated.caseIndex);
  assert.equal(generated.rosterSize, generated.identities.length);
  assert.ok(generated.rosterSize >= 2 && generated.rosterSize <= 8);
  assert.equal(new Set(generated.identities.map(({ sessionId }) => sessionId)).size, generated.rosterSize);
  assert.equal(new Set(generated.identities.map(({ name }) => name)).size, generated.rosterSize);
  assert.ok(generated.identities.every(({ name }) => name.startsWith('Identity ')));
  assert.deepEqual(
    [...generated.waitingRequesterClasses].sort(),
    [...REQUESTER_CLASSES].sort(),
  );
  assert.ok(generated.identities.slice(1).some((identity) => (
    identity.sessionId === generated.nonHostRequesterSessionId
  )));
  assert.ok(!generated.identities.some((identity) => (
    identity.sessionId === generated.unrepresentedRequesterSessionId
  )));
  assert.ok(generated.identities.some((identity) => (
    identity.sessionId === generated.expectedSuccessorSessionId
  )));
  assert.ok(!generated.leaveBeforeHostSessionIds.includes(generated.expectedSuccessorSessionId));
  assert.equal(new Set(generated.leaveBeforeHostSessionIds).size, generated.leaveBeforeHostSessionIds.length);
  assert.ok(generated.countdownProgressSteps >= 1 && generated.countdownProgressSteps <= 24);
}

async function exerciseCustomHostCase(
  generated: GeneratedCustomHostCase,
): Promise<unknown> {
  const { core, world } = makeCore(generated);
  const events: CaseTraceEvent[] = [];
  let trace: unknown;

  try {
    await core.initialize();
    const originalHostSessionId = await joinGeneratedRoster(core, world, generated, events);
    assert.equal(originalHostSessionId, generated.identities[0]!.sessionId);
    await assertWaitingRequesterClasses(core, world, generated, events);

    if (generated.successionPhase === 'waiting') {
      for (const [index, sessionId] of generated.leaveBeforeHostSessionIds.entries()) {
        const retainedHost = await assertAcceptedLeave(
          core,
          world,
          events,
          sessionId,
          `waiting-pre-host-leave-${index}`,
        );
        assert.equal(retainedHost, originalHostSessionId);
      }
      const successor = await assertAcceptedLeave(
        core,
        world,
        events,
        originalHostSessionId,
        'waiting-host-succession',
      );
      assert.equal(successor, generated.expectedSuccessorSessionId);
      assert.equal(requireProjection(core).phase, 'waiting');
      await assertAcceptedStart(core, world, events, successor, 'successor-accepted-start');
      await assertWrongPhaseRequests(core, world, generated, events);
    } else {
      await assertAcceptedStart(core, world, events, originalHostSessionId, 'host-accepted-start');
      await assertWrongPhaseRequests(core, world, generated, events);

      const beforeProgress = canonicalPublicState(core, world);
      advanceFixedSteps(core, generated.countdownProgressSteps);
      const afterProgress = canonicalPublicState(core, world);
      assertOnlyOrdinaryClockProgress(
        beforeProgress,
        afterProgress,
        generated.countdownProgressSteps,
      );
      appendTrace(events, 'partial-countdown-progress', core, world);

      for (const [index, sessionId] of generated.leaveBeforeHostSessionIds.entries()) {
        const retainedHost = await assertAcceptedLeave(
          core,
          world,
          events,
          sessionId,
          `countdown-pre-host-leave-${index}`,
        );
        assert.equal(retainedHost, originalHostSessionId);
      }
      const beforeHostLeave = requireProjection(core).countdownStepsRemaining;
      const successor = await assertAcceptedLeave(
        core,
        world,
        events,
        originalHostSessionId,
        'countdown-host-succession',
      );
      assert.equal(successor, generated.expectedSuccessorSessionId);
      const afterHostLeave = requireProjection(core);
      assert.equal(afterHostLeave.phase, 'countdown');
      assert.equal(afterHostLeave.countdownKind, 'initial');
      assert.equal(
        afterHostLeave.countdownStepsRemaining,
        beforeHostLeave - 1,
        'Host succession must preserve countdown progress while its fixed step decrements once',
      );
    }

    const finalState = canonicalPublicState(core, world);
    assert.equal(finalState.projection.phase, 'countdown');
    assert.equal(finalState.projection.countdownKind, 'initial');
    assert.ok(finalState.projection.countdownStepsRemaining < INITIAL_COUNTDOWN_STEPS);
    assert.equal(world.kickoffApplyCount, 1);
    assert.equal(world.kickoffRollbackCount, 0);
    assert.equal(core.lifecycle, 'ready');
    trace = structuredClone({ generated, events, finalState });
  } finally {
    core.dispose();
    assert.equal(world.disposeCount, 1, 'every generated core must dispose exactly once');
  }

  return Object.freeze({ trace, disposeCount: world.disposeCount });
}

async function exerciseWithDiagnostics(
  generatedCase: GeneratedCase<GeneratedCustomHostCase>,
): Promise<unknown> {
  try {
    return await exerciseCustomHostCase(generatedCase.value);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Generated case failed (seed=${JSON.stringify(generatedCase.seed)}, index=${generatedCase.index}): ${detail}`,
      { cause },
    );
  }
}

async function runGeneratedSequence(
  cases: readonly GeneratedCase<GeneratedCustomHostCase>[],
): Promise<readonly unknown[]> {
  const traces: unknown[] = [];
  for (const generatedCase of cases) {
    traces.push(await exerciseWithDiagnostics(generatedCase));
  }
  return Object.freeze(traces);
}

/**
 * Feature: rocket-arena, Property 5: Custom Host authority and succession
 * **Validates: Requirements 4.2, 4.13-4.17, 18.15, 18.25**
 */
test(
  `Property 5: Custom Host authority and succession (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  async () => {
    assert.equal(GENERATED_CASE_COUNT, 100);
    assert.equal(REPLAY_CASE_INDEX, 61);

    const generatedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateCustomHostCase,
    });
    const repeatedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateCustomHostCase,
    });
    const replayedCase = replayCase(
      RECORDED_SEED,
      REPLAY_CASE_INDEX,
      generateCustomHostCase,
    );

    assert.equal(generatedCases.length, 100);
    assert.deepEqual(repeatedCases, generatedCases);
    assert.deepEqual(replayedCase, generatedCases[REPLAY_CASE_INDEX]);
    assertGeneratedCases(generatedCases, assertGeneratedMetadata);
    assert.deepEqual(
      [...new Set(generatedCases.map(({ value }) => value.rosterSize))]
        .sort((left, right) => left - right),
      [2, 3, 4, 5, 6, 7, 8],
    );
    assert.deepEqual(
      generatedCases.reduce<Record<SuccessionPhase, number>>(
        (counts, generatedCase) => {
          counts[generatedCase.value.successionPhase] += 1;
          return counts;
        },
        { waiting: 0, countdown: 0 },
      ),
      { waiting: 50, countdown: 50 },
    );
    assert.deepEqual(
      [...new Set(generatedCases.map(({ value }) => value.orderVariant))].sort(),
      ['lexical', 'reverse', 'seeded-shuffle'],
    );

    const firstTraces = await runGeneratedSequence(generatedCases);
    const repeatedTraces = await runGeneratedSequence(repeatedCases);
    assert.deepEqual(
      repeatedTraces,
      firstTraces,
      'fresh cores must reproduce the same canonical ordered result traces',
    );

    const replayedTrace = await exerciseWithDiagnostics(replayedCase);
    assert.deepEqual(
      replayedTrace,
      firstTraces[REPLAY_CASE_INDEX],
      `replay index ${REPLAY_CASE_INDEX} must reproduce its canonical result trace`,
    );
  },
);
