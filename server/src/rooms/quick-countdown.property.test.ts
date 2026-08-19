import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MATCH_RULES,
  PHYSICS,
  type InputCommandV2,
} from '@rocket-arena/shared';
import {
  type RoomMutationRequest,
} from '../systems/room-mutations.js';
import { createQuickMatchCore } from './arena-room.js';
import {
  createNeutralInputCommandV2,
  type AuthoritativeRoomCore,
  type AuthoritativeRoomMutationResult,
  type AuthoritativeRoomProjection,
  type AuthoritativeRoomWorldBundle,
} from './authoritative-room-core.js';

interface SeededRandom {
  integer(minInclusive: number, maxInclusive: number): number;
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

// This shared test helper is outside server/tsconfig.json's rootDir. Loading its
// source URL at runtime keeps the production server build rooted at server/src.
const generatedCasesModuleUrl = new URL(
  '../../../shared/tests/support/generated-cases.ts',
  import.meta.url,
).href;
const {
  assertGeneratedCases,
  generateCases,
  replayCase,
} = await import(generatedCasesModuleUrl) as unknown as GeneratedCasesModule;

const RECORDED_SEED = 'rocket-arena-property-4-quick-countdown-v1';
const GENERATED_CASE_COUNT = 100;
const REPLAY_CASE_INDEX = 73;
const QUICK_PLAYER_COUNT = 6;
const FULL_COUNTDOWN_STEPS = MATCH_RULES.kickoffCountdownSteps;

type Team = 'blue' | 'orange';

interface GeneratedIdentity {
  readonly sessionId: string;
  readonly name: string;
}

interface GeneratedQuickCountdownCase {
  readonly caseIndex: number;
  readonly initialPlayers: readonly GeneratedIdentity[];
  readonly countdownStepsBeforeLeave: number;
  readonly leavingIndex: number;
  readonly replacement: GeneratedIdentity;
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
  readonly removedSessionIds: string[];
  fixedSteps: number;
  kickoffApplyCount: number;
  disposeCount: number;
}

type TestCore = AuthoritativeRoomCore<TestWorld, TestCar, TestBall>;
type MutationSuccess = Extract<AuthoritativeRoomMutationResult, { readonly ok: true }>;

interface CanonicalRosterEntry {
  readonly sessionId: string;
  readonly acceptedJoinOrdinal: number;
  readonly team: Team;
}

interface CanonicalMutationTrace {
  readonly requestKind: 'join' | 'leave';
  readonly sessionId: string;
  readonly queueSequence: number;
  readonly revision: number;
  readonly effectKind: string;
}

interface CanonicalCheckpoint {
  readonly stage: string;
  readonly revision: number;
  readonly fixedStepsCompleted: number;
  readonly phase: AuthoritativeRoomProjection['phase'];
  readonly countdownKind: AuthoritativeRoomProjection['countdownKind'];
  readonly countdownStepsRemaining: number;
  readonly regulationStepsRemaining: number;
  readonly occupancy: Readonly<{ total: number; blue: number; orange: number }>;
  readonly roster: readonly CanonicalRosterEntry[];
  readonly representedCarIds: readonly string[];
  readonly removedSessionIds: readonly string[];
  readonly kickoffApplyCount: number;
  readonly kickoffEpoch: number | null;
}

interface CanonicalResultTrace {
  readonly operations: readonly CanonicalMutationTrace[];
  readonly checkpoints: readonly CanonicalCheckpoint[];
}

function paddedHex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function generateQuickCountdownCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedQuickCountdownCase {
  const caseToken = `${caseIndex.toString().padStart(3, '0')}-${paddedHex(
    random.integer(0, 0xff_ffff),
    6,
  )}`;
  const initialPlayers = Object.freeze(Array.from(
    { length: QUICK_PLAYER_COUNT },
    (_, playerIndex): GeneratedIdentity => {
      const sessionId = `property-4-${caseToken}-initial-${playerIndex}-${paddedHex(
        random.integer(0, 0xffff),
        4,
      )}`;
      return Object.freeze({
        sessionId,
        name: `Generated Quick ${caseToken} Player ${playerIndex}`,
      });
    },
  ));
  const sampledCountdownProgress = random.integer(0, FULL_COUNTDOWN_STEPS - 1);
  const countdownStepsBeforeLeave = caseIndex === 0
    ? 0
    : caseIndex === 1
      ? FULL_COUNTDOWN_STEPS - 1
      : sampledCountdownProgress;
  const leavingIndex = caseIndex % QUICK_PLAYER_COUNT;
  const replacementSessionId = `property-4-${caseToken}-replacement-${leavingIndex}-${paddedHex(
    random.integer(0, 0xffff),
    4,
  )}`;

  return Object.freeze({
    caseIndex,
    initialPlayers,
    countdownStepsBeforeLeave,
    leavingIndex,
    replacement: Object.freeze({
      sessionId: replacementSessionId,
      name: `Generated Quick ${caseToken} Replacement ${leavingIndex}`,
    }),
  });
}

function makeWorld(): TestWorld {
  return {
    cars: new Map(),
    removedSessionIds: [],
    fixedSteps: 0,
    kickoffApplyCount: 0,
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
            boost: 50,
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
          input: createNeutralInputCommandV2() as InputCommandV2,
        };
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
      let applied = false;

      return {
        apply: () => {
          ball.position.splice(0, 3, 0, 1, 0);
          ball.linearVelocity.splice(0, 3, 0, 0, 0);
          ball.angularVelocity.splice(0, 3, 0, 0, 0);
          for (const [sessionId, car] of cars) {
            const assignment = assignmentSet.assignments.get(sessionId);
            assert.ok(assignment, `kickoff assignment missing for ${sessionId}`);
            car.position.splice(0, 3, ...assignment.position);
            car.rotation.splice(0, 4, ...assignment.rotation);
            car.linearVelocity.splice(0, 3, 0, 0, 0);
            car.angularVelocity.splice(0, 3, 0, 0, 0);
          }
          world.kickoffApplyCount += 1;
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
            world.kickoffApplyCount -= 1;
            applied = false;
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

async function makeCore(
  caseIndex: number,
): Promise<{ readonly core: TestCore; readonly world: TestWorld }> {
  const world = makeWorld();
  const core = createQuickMatchCore<TestWorld, TestCar, TestBall>({
    roomId: `property-4-quick-countdown-${caseIndex}`,
    initializeWorld: () => makeBundle(world),
    logger: { info: () => {}, error: () => {} },
  });
  await core.initialize();
  return { core, world };
}

function requireProjection(core: TestCore): Readonly<AuthoritativeRoomProjection> {
  const value = core.projectAuthoritativeState();
  assert.ok(value, 'an initialized Quick core must expose authoritative state');
  return value;
}

async function commitSuccessfulMutation(
  core: TestCore,
  request: RoomMutationRequest,
): Promise<MutationSuccess> {
  const completion = core.queueMutation(request);
  const frame = core.advanceSimulation(PHYSICS.TIMESTEP * 1000);
  const result = await completion;

  assert.equal(frame.scheduledFixedSteps, 1);
  assert.equal(frame.executedFixedSteps, 1);
  assert.equal(frame.mutationResults.length, 1);
  assert.equal(frame.mutationResults[0]?.queueSequence, result.queueSequence);
  if (!result.ok) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function rosterTrace(
  projection: Readonly<AuthoritativeRoomProjection>,
): readonly CanonicalRosterEntry[] {
  return projection.cars.map(({ sessionId, acceptedJoinOrdinal, team }) => ({
    sessionId,
    acceptedJoinOrdinal,
    team,
  }));
}

function canonicalCheckpoint(
  stage: string,
  core: TestCore,
  world: TestWorld,
): CanonicalCheckpoint {
  const projection = requireProjection(core);
  return {
    stage,
    revision: projection.revision,
    fixedStepsCompleted: projection.fixedStepsCompleted,
    phase: projection.phase,
    countdownKind: projection.countdownKind,
    countdownStepsRemaining: projection.countdownStepsRemaining,
    regulationStepsRemaining: projection.regulationStepsRemaining,
    occupancy: { ...projection.occupancy },
    roster: rosterTrace(projection),
    representedCarIds: [...world.cars.keys()].sort((left, right) => left.localeCompare(right)),
    removedSessionIds: [...world.removedSessionIds],
    kickoffApplyCount: world.kickoffApplyCount,
    kickoffEpoch: core.kickoffAssignmentSet?.epoch ?? null,
  };
}

function mutationTrace(
  requestKind: 'join' | 'leave',
  sessionId: string,
  result: MutationSuccess,
): CanonicalMutationTrace {
  return {
    requestKind,
    sessionId,
    queueSequence: result.queueSequence,
    revision: result.revision,
    effectKind: result.effect.kind,
  };
}

function assertWaitingWithoutCountdown(
  projection: Readonly<AuthoritativeRoomProjection>,
  expectedTotal: number,
): void {
  assert.equal(projection.occupancy.total, expectedTotal);
  assert.equal(projection.phase, 'waiting');
  assert.notEqual(projection.phase, 'playing');
  assert.equal(projection.countdownKind, null);
  assert.equal(projection.countdownStepsRemaining, 0);
}

function canonicalInputTrace(generatedCase: GeneratedCase<GeneratedQuickCountdownCase>) {
  const generated = generatedCase.value;
  return {
    seed: generatedCase.seed,
    index: generatedCase.index,
    caseIndex: generated.caseIndex,
    joins: generated.initialPlayers.map(({ sessionId, name }) => ({ sessionId, name })),
    countdownStepsBeforeLeave: generated.countdownStepsBeforeLeave,
    leaveSessionId: generated.initialPlayers[generated.leavingIndex]!.sessionId,
    replacement: { ...generated.replacement },
  };
}

function advancePartialCountdown(
  core: TestCore,
  world: TestWorld,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) {
    const frame = core.advanceSimulation(PHYSICS.TIMESTEP * 1000);
    assert.equal(frame.scheduledFixedSteps, 1);
    assert.equal(frame.executedFixedSteps, 1);

    const projection = requireProjection(core);
    assert.equal(projection.phase, 'countdown');
    assert.notEqual(projection.phase, 'playing');
    assert.equal(projection.countdownKind, 'initial');
    assert.equal(
      projection.countdownStepsRemaining,
      FULL_COUNTDOWN_STEPS - index - 1,
    );
    assert.equal(world.kickoffApplyCount, 1, 'a stable exact roster must not restart its gate');
  }
}

async function exerciseQuickCountdownCase(
  generated: GeneratedQuickCountdownCase,
): Promise<CanonicalResultTrace> {
  const { core, world } = await makeCore(generated.caseIndex);
  const operations: CanonicalMutationTrace[] = [];
  const checkpoints: CanonicalCheckpoint[] = [];

  try {
    assert.equal(FULL_COUNTDOWN_STEPS, 180);
    assertWaitingWithoutCountdown(requireProjection(core), 0);
    checkpoints.push(canonicalCheckpoint('empty', core, world));

    for (const [index, identity] of generated.initialPlayers.entries()) {
      const result = await commitSuccessfulMutation(core, {
        kind: 'join',
        sessionId: identity.sessionId,
        name: identity.name,
      });
      assert.equal(result.effect.kind, 'joined');
      operations.push(mutationTrace('join', identity.sessionId, result));

      const current = requireProjection(core);
      assert.deepEqual(
        current.cars.map(({ sessionId }) => sessionId),
        generated.initialPlayers.slice(0, index + 1).map(({ sessionId }) => sessionId),
      );
      assert.ok(Math.abs(current.occupancy.blue - current.occupancy.orange) <= 1);
      assert.ok(current.occupancy.blue <= 3);
      assert.ok(current.occupancy.orange <= 3);

      if (index < QUICK_PLAYER_COUNT - 1) {
        assertWaitingWithoutCountdown(current, index + 1);
        assert.equal(world.kickoffApplyCount, 0);
      } else {
        assert.deepEqual(current.occupancy, { total: 6, blue: 3, orange: 3 });
        assert.equal(current.phase, 'countdown');
        assert.notEqual(current.phase, 'playing');
        assert.equal(current.countdownKind, 'initial');
        assert.equal(current.countdownStepsRemaining, FULL_COUNTDOWN_STEPS);
        assert.equal(world.kickoffApplyCount, 1);
        assert.equal(core.kickoffAssignmentSet?.epoch, 1);
      }
      checkpoints.push(canonicalCheckpoint(`join-${index}`, core, world));
    }

    advancePartialCountdown(core, world, generated.countdownStepsBeforeLeave);
    const beforeLeave = requireProjection(core);
    assert.equal(beforeLeave.phase, 'countdown');
    assert.notEqual(beforeLeave.phase, 'playing');
    assert.equal(
      beforeLeave.countdownStepsRemaining,
      FULL_COUNTDOWN_STEPS - generated.countdownStepsBeforeLeave,
    );
    assert.equal(world.kickoffApplyCount, 1);
    checkpoints.push(canonicalCheckpoint('before-leave', core, world));

    const leavingIdentity = generated.initialPlayers[generated.leavingIndex]!;
    const leavingEntry = beforeLeave.cars.find(
      ({ sessionId }) => sessionId === leavingIdentity.sessionId,
    );
    assert.ok(leavingEntry);
    const survivorRoster = rosterTrace(beforeLeave).filter(
      ({ sessionId }) => sessionId !== leavingIdentity.sessionId,
    );
    const survivorBodies = new Map(
      [...world.cars].filter(([sessionId]) => sessionId !== leavingIdentity.sessionId),
    );
    const removedCar = world.cars.get(leavingIdentity.sessionId);
    assert.ok(removedCar);

    const leaveResult = await commitSuccessfulMutation(core, {
      kind: 'leave',
      sessionId: leavingIdentity.sessionId,
    });
    assert.equal(leaveResult.effect.kind, 'left');
    if (leaveResult.effect.kind === 'left') {
      assert.equal(leaveResult.effect.sessionId, leavingIdentity.sessionId);
    }
    operations.push(mutationTrace('leave', leavingIdentity.sessionId, leaveResult));

    const afterLeave = requireProjection(core);
    assertWaitingWithoutCountdown(afterLeave, QUICK_PLAYER_COUNT - 1);
    assert.deepEqual(afterLeave.occupancy, {
      total: 5,
      blue: 3 - Number(leavingEntry.team === 'blue'),
      orange: 3 - Number(leavingEntry.team === 'orange'),
    });
    assert.deepEqual(rosterTrace(afterLeave), survivorRoster);
    assert.deepEqual(world.removedSessionIds, [leavingIdentity.sessionId]);
    assert.equal(world.cars.has(leavingIdentity.sessionId), false);
    assert.equal(removedCar.removed, true);
    assert.deepEqual(
      [...world.cars.keys()].sort((left, right) => left.localeCompare(right)),
      survivorRoster.map(({ sessionId }) => sessionId).sort((left, right) => left.localeCompare(right)),
    );
    for (const [sessionId, survivorBody] of survivorBodies) {
      assert.equal(world.cars.get(sessionId), survivorBody);
      assert.equal(survivorBody.removed, false);
    }
    assert.equal(world.kickoffApplyCount, 1);
    checkpoints.push(canonicalCheckpoint('after-leave', core, world));

    const replacementResult = await commitSuccessfulMutation(core, {
      kind: 'join',
      sessionId: generated.replacement.sessionId,
      name: generated.replacement.name,
    });
    assert.equal(replacementResult.effect.kind, 'joined');
    operations.push(mutationTrace('join', generated.replacement.sessionId, replacementResult));

    const restored = requireProjection(core);
    assert.deepEqual(restored.occupancy, { total: 6, blue: 3, orange: 3 });
    assert.equal(restored.phase, 'countdown');
    assert.notEqual(restored.phase, 'playing');
    assert.equal(restored.countdownKind, 'initial');
    assert.equal(restored.countdownStepsRemaining, FULL_COUNTDOWN_STEPS);
    assert.equal(world.kickoffApplyCount, 2);
    assert.equal(core.kickoffAssignmentSet?.epoch, 1);
    assert.equal(core.kickoffAssignmentSet?.assignments.size, QUICK_PLAYER_COUNT);
    assert.equal(
      core.kickoffAssignmentSet?.assignments.has(leavingIdentity.sessionId),
      false,
    );
    assert.equal(
      core.kickoffAssignmentSet?.assignments.has(generated.replacement.sessionId),
      true,
    );
    assert.deepEqual(
      rosterTrace(restored).filter(
        ({ sessionId }) => sessionId !== generated.replacement.sessionId,
      ),
      survivorRoster,
    );
    const replacementEntry = restored.cars.find(
      ({ sessionId }) => sessionId === generated.replacement.sessionId,
    );
    assert.ok(replacementEntry);
    assert.equal(replacementEntry.team, leavingEntry.team);
    assert.equal(replacementEntry.acceptedJoinOrdinal, QUICK_PLAYER_COUNT);
    assert.equal(world.cars.size, QUICK_PLAYER_COUNT);
    assert.equal(world.removedSessionIds.length, 1);
    for (const [sessionId, survivorBody] of survivorBodies) {
      assert.equal(world.cars.get(sessionId), survivorBody);
      assert.equal(survivorBody.removed, false);
    }
    if (generated.countdownStepsBeforeLeave > 0) {
      assert.notEqual(
        restored.countdownStepsRemaining,
        beforeLeave.countdownStepsRemaining,
        'replacement must receive a full restart instead of the prior partial remainder',
      );
    }
    checkpoints.push(canonicalCheckpoint('replacement', core, world));

    return { operations, checkpoints };
  } finally {
    core.dispose();
    assert.equal(world.disposeCount, 1);
  }
}

async function exerciseWithDiagnostics(
  generatedCase: GeneratedCase<GeneratedQuickCountdownCase>,
): Promise<CanonicalResultTrace> {
  try {
    return await exerciseQuickCountdownCase(generatedCase.value);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Generated case failed (seed=${JSON.stringify(generatedCase.seed)}, index=${generatedCase.index}): ${detail}`,
      { cause },
    );
  }
}

/**
 * Feature: rocket-arena, Property 4: Quick exact-countdown start/cancel/restart
 * **Validates: Requirements 3.9-3.13, 18.13, 18.25**
 */
test(
  `Property 4: Quick countdown gate (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  async () => {
    const generatedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateQuickCountdownCase,
    });
    const regeneratedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateQuickCountdownCase,
    });
    const replayedCase = replayCase(
      RECORDED_SEED,
      REPLAY_CASE_INDEX,
      generateQuickCountdownCase,
    );

    assert.equal(generatedCases.length, GENERATED_CASE_COUNT);
    assert.equal(regeneratedCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(
      generatedCases.map(canonicalInputTrace),
      regeneratedCases.map(canonicalInputTrace),
    );
    assert.deepEqual(
      canonicalInputTrace(replayedCase),
      canonicalInputTrace(generatedCases[REPLAY_CASE_INDEX]!),
    );

    assertGeneratedCases(generatedCases, (generated, generatedCase) => {
      assert.equal(generatedCase.seed, RECORDED_SEED);
      assert.equal(generatedCase.index, generated.caseIndex);
      assert.equal(generated.initialPlayers.length, QUICK_PLAYER_COUNT);
      assert.ok(Number.isInteger(generated.countdownStepsBeforeLeave));
      assert.ok(generated.countdownStepsBeforeLeave >= 0);
      assert.ok(generated.countdownStepsBeforeLeave < FULL_COUNTDOWN_STEPS);
      assert.ok(generated.leavingIndex >= 0);
      assert.ok(generated.leavingIndex < QUICK_PLAYER_COUNT);
      const identities = [
        ...generated.initialPlayers.map(({ sessionId }) => sessionId),
        generated.replacement.sessionId,
      ];
      assert.equal(new Set(identities).size, identities.length);
    });

    const allIdentities = generatedCases.flatMap(({ value }) => [
      ...value.initialPlayers.map(({ sessionId }) => sessionId),
      value.replacement.sessionId,
    ]);
    assert.equal(
      new Set(allIdentities).size,
      GENERATED_CASE_COUNT * (QUICK_PLAYER_COUNT + 1),
    );
    assert.deepEqual(
      [...new Set(generatedCases.map(({ value }) => value.leavingIndex))].sort((left, right) => (
        left - right
      )),
      [0, 1, 2, 3, 4, 5],
    );
    assert.equal(
      new Set(generatedCases.map(({ value }) => value.replacement.sessionId)).size,
      GENERATED_CASE_COUNT,
    );
    const generatedProgress = generatedCases.map(
      ({ value }) => value.countdownStepsBeforeLeave,
    );
    assert.ok(generatedProgress.includes(0));
    assert.ok(generatedProgress.includes(FULL_COUNTDOWN_STEPS - 1));
    assert.ok(new Set(generatedProgress).size > 1);

    const firstResultTraces: CanonicalResultTrace[] = [];
    for (const generatedCase of generatedCases) {
      firstResultTraces.push(await exerciseWithDiagnostics(generatedCase));
    }

    const regeneratedResultTraces: CanonicalResultTrace[] = [];
    for (const generatedCase of regeneratedCases) {
      regeneratedResultTraces.push(await exerciseWithDiagnostics(generatedCase));
    }

    assert.deepEqual(regeneratedResultTraces, firstResultTraces);
    assertGeneratedCases(generatedCases, (_generated, generatedCase) => {
      assert.deepEqual(
        regeneratedResultTraces[generatedCase.index],
        firstResultTraces[generatedCase.index],
      );
    });

    const replayedResultTrace = await exerciseWithDiagnostics(replayedCase);
    assert.deepEqual(replayedResultTrace, firstResultTraces[REPLAY_CASE_INDEX]);
  },
);
