import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PHYSICS,
  ROOM_POLICIES,
  type InputCommandV2,
  type RoomMode,
  type RoomPolicy,
} from '@rocket-arena/shared';
import {
  createCustomRoomCore,
  CUSTOM_ROOM_POLICY,
} from '../rooms/custom-room.js';
import {
  createQuickMatchCore,
  QUICK_MATCH_POLICY,
} from '../rooms/arena-room.js';
import {
  createNeutralInputCommandV2,
  type AuthoritativeRoomCore,
  type AuthoritativeRoomMutationResult,
  type AuthoritativeRoomProjection,
  type AuthoritativeRoomWorldBundle,
} from '../rooms/authoritative-room-core.js';

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

// The shared helper is test infrastructure outside the server project's emit root.
// Loading its source URL at runtime reuses the single seeded implementation while
// keeping the production server build rooted at server/src.
const generatedCasesModuleUrl = new URL(
  '../../../shared/tests/support/generated-cases.ts',
  import.meta.url,
).href;
const {
  assertGeneratedCases,
  generateCases,
  replayCase,
} = await import(generatedCasesModuleUrl) as unknown as GeneratedCasesModule;

const RECORDED_SEED = 'rocket-arena-property-1-capacity-v1';
const GENERATED_CASE_COUNT = 240;
const CASES_PER_MODE = GENERATED_CASE_COUNT / 2;
const REPLAY_CASE_INDEX = 173;

interface GeneratedJoinOperation {
  readonly kind: 'join';
  readonly sessionId: string;
  readonly name: string;
}

interface GeneratedCapacityCase {
  readonly caseIndex: number;
  readonly mode: RoomMode;
  readonly operations: readonly GeneratedJoinOperation[];
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
  fixedSteps: number;
  disposeCount: number;
}

type TestCore = AuthoritativeRoomCore<TestWorld, TestCar, TestBall>;

interface CapacityCaseCoverage {
  readonly mode: RoomMode;
  readonly acceptedJoins: number;
  readonly duplicateRejections: number;
  readonly totalCapacityRejections: number;
  readonly reachedTotalBoundary: boolean;
  readonly reachedBlueTeamBoundary: boolean;
  readonly reachedOrangeTeamBoundary: boolean;
}

function shuffle<T>(values: readonly T[], random: SeededRandom): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = random.integer(0, index);
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function joinOperation(sessionId: string, random: SeededRandom): GeneratedJoinOperation {
  return Object.freeze({
    kind: 'join',
    sessionId,
    name: `Generated ${sessionId} ${random.integer(0, 0xffff).toString(16).padStart(4, '0')}`,
  });
}

function generateCapacityCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedCapacityCase {
  const mode: RoomMode = caseIndex % 2 === 0 ? 'quick' : 'custom';
  const policy = ROOM_POLICIES[mode];
  const acceptedSessionIds = shuffle(
    Array.from({ length: policy.totalCapacity }, (_, index) => (
      `property-1-${mode}-${caseIndex.toString().padStart(3, '0')}`
      + `-accepted-${index.toString().padStart(2, '0')}`
    )),
    random,
  );
  const operations: GeneratedJoinOperation[] = [];
  const representedPrefix: string[] = [];

  for (const [acceptedIndex, sessionId] of acceptedSessionIds.entries()) {
    // Every generated prefix contains at least one duplicate before capacity,
    // with additional duplicate positions selected by the recorded seed.
    if (
      representedPrefix.length > 0
      && (acceptedIndex === 1 || random.boolean(0.35))
    ) {
      operations.push(joinOperation(random.pick(representedPrefix), random));
    }

    operations.push(joinOperation(sessionId, random));
    representedPrefix.push(sessionId);

    if (random.boolean(0.2)) {
      operations.push(joinOperation(random.pick(representedPrefix), random));
    }
  }

  // At least one unique post-boundary attempt proves the full room remains at
  // 6/3 or 8/4 instead of accepting a partial over-capacity mutation.
  const overflowAttempts = random.integer(1, 3);
  for (let index = 0; index < overflowAttempts; index += 1) {
    if (random.boolean(0.5)) {
      operations.push(joinOperation(random.pick(representedPrefix), random));
    }
    operations.push(joinOperation(
      `property-1-${mode}-${caseIndex.toString().padStart(3, '0')}`
      + `-overflow-${index.toString().padStart(2, '0')}`,
      random,
    ));
  }

  return Object.freeze({
    caseIndex,
    mode,
    operations: Object.freeze(operations),
  });
}

function makeWorld(): TestWorld {
  return {
    cars: new Map(),
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
            linearVelocity: [0, 0, 0],
            angularVelocity: [0, 0, 0],
            boost: 33,
            removed: false,
          },
          (temporary) => {
            temporary.removed = true;
            world.cars.delete(temporary.id);
          },
        );
        world.cars.set(entry.sessionId, car);
        return { car, input: createNeutralInputCommandV2() };
      },
      prepareLeave: ({ car }) => ({
        commitRemoval: () => {
          car.removed = true;
          world.cars.delete(car.id);
        },
      }),
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

function capacityStateSnapshot(projection: Readonly<AuthoritativeRoomProjection>): unknown {
  return structuredClone({
    policy: projection.policy,
    revision: projection.revision,
    occupancy: projection.occupancy,
    cars: projection.cars.map((car) => ({
      sessionId: car.sessionId,
      acceptedJoinOrdinal: car.acceptedJoinOrdinal,
      team: car.team,
      name: car.name,
      isHost: car.isHost,
    })),
  });
}

function requireProjection(core: TestCore): Readonly<AuthoritativeRoomProjection> {
  const projection = core.projectAuthoritativeState();
  assert.ok(projection, 'an initialized generated room must expose authoritative state');
  return projection;
}

function assertPrefixInvariants(
  core: TestCore,
  world: TestWorld,
  policy: RoomPolicy,
  expectedTeams: ReadonlyMap<string, 'blue' | 'orange'>,
  pinnedTuningSnapshotId: string,
): Readonly<AuthoritativeRoomProjection> {
  const projection = requireProjection(core);
  const diagnostics = core.diagnostics;
  const blue = projection.cars.filter(({ team }) => team === 'blue').length;
  const orange = projection.cars.filter(({ team }) => team === 'orange').length;
  const identities = projection.cars.map(({ sessionId }) => sessionId);

  assert.equal(core.policy, policy, 'the adapter must retain its canonical policy reference');
  assert.equal(projection.policy, policy, 'applied state must advertise the pinned canonical policy');
  assert.equal(Object.isFrozen(core.policy), true);
  assert.equal(Object.isFrozen(projection.policy), true);
  assert.deepEqual(
    {
      mode: policy.mode,
      totalCapacity: policy.totalCapacity,
      teamCapacity: policy.teamCapacity,
    },
    policy.mode === 'quick'
      ? { mode: 'quick', totalCapacity: 6, teamCapacity: 3 }
      : { mode: 'custom', totalCapacity: 8, teamCapacity: 4 },
  );
  assert.equal(diagnostics.mode, policy.mode);
  assert.equal(diagnostics.totalCapacity, policy.totalCapacity);
  assert.equal(diagnostics.teamCapacity, policy.teamCapacity);
  assert.equal(diagnostics.tuningSnapshotId, pinnedTuningSnapshotId);
  assert.equal(projection.tuning.snapshotId, pinnedTuningSnapshotId);

  assert.equal(new Set(identities).size, identities.length);
  assert.equal(projection.occupancy.total, projection.cars.length);
  assert.deepEqual(projection.occupancy, {
    total: projection.cars.length,
    blue,
    orange,
  });
  assert.ok(projection.occupancy.total <= policy.totalCapacity);
  assert.ok(blue <= policy.teamCapacity);
  assert.ok(orange <= policy.teamCapacity);
  assert.equal(world.cars.size, projection.cars.length);
  assert.deepEqual(new Set(identities), new Set(expectedTeams.keys()));

  for (const car of projection.cars) {
    assert.equal(car.team, expectedTeams.get(car.sessionId));
  }

  return projection;
}

async function commitJoin(
  core: TestCore,
  operation: GeneratedJoinOperation,
): Promise<AuthoritativeRoomMutationResult> {
  const completion = core.queueMutation(operation);
  const frame = core.advanceSimulation(PHYSICS.TIMESTEP * 1000);
  const result = await completion;

  assert.equal(frame.scheduledFixedSteps, 1);
  assert.equal(frame.executedFixedSteps, 1);
  assert.equal(frame.mutationResults.length, 1);
  assert.equal(frame.mutationResults[0]?.queueSequence, result.queueSequence);
  return result;
}

async function exerciseCapacityCase(
  generated: GeneratedCapacityCase,
): Promise<CapacityCaseCoverage> {
  const policy = ROOM_POLICIES[generated.mode];
  const adapterPolicy = generated.mode === 'quick'
    ? QUICK_MATCH_POLICY
    : CUSTOM_ROOM_POLICY;
  const otherPolicy = generated.mode === 'quick'
    ? ROOM_POLICIES.custom
    : ROOM_POLICIES.quick;
  const world = makeWorld();
  const infoLogs: string[] = [];
  let initializationPolicy: RoomPolicy | null = null;

  const requestedOptions = {
    roomId: `property-1-${generated.mode}-${generated.caseIndex}`,
    totalCapacity: policy.totalCapacity as unknown,
    teamCapacity: policy.teamCapacity as unknown,
    initializeWorld: ({ policy: appliedPolicy }: { readonly policy: RoomPolicy }) => {
      initializationPolicy = appliedPolicy;
      return makeBundle(world);
    },
    logger: {
      info: (message: string) => { infoLogs.push(message); },
      error: () => {},
    },
  };

  const core: TestCore = generated.mode === 'quick'
    ? createQuickMatchCore<TestWorld, TestCar, TestBall>(requestedOptions)
    : createCustomRoomCore<TestWorld, TestCar, TestBall>(requestedOptions);

  // Mutating caller-owned capacity assertions after construction cannot alter
  // the mode policy already selected and pinned by either adapter.
  requestedOptions.totalCapacity = otherPolicy.totalCapacity;
  requestedOptions.teamCapacity = otherPolicy.teamCapacity;

  const expectedTeams = new Map<string, 'blue' | 'orange'>();
  let acceptedJoins = 0;
  let duplicateRejections = 0;
  let totalCapacityRejections = 0;
  let reachedTotalBoundary = false;
  let reachedBlueTeamBoundary = false;
  let reachedOrangeTeamBoundary = false;

  try {
    assert.equal(adapterPolicy, policy);
    assert.equal(core.policy, policy);
    assert.match(
      infoLogs[0] ?? '',
      new RegExp(
        `mode=${generated.mode} totalCapacity=${policy.totalCapacity}`
        + ` teamCapacity=${policy.teamCapacity}`,
      ),
    );

    await core.initialize();
    assert.equal(initializationPolicy, policy);
    const pinnedTuningSnapshotId = core.tuningSnapshot.snapshotId;
    assertPrefixInvariants(core, world, policy, expectedTeams, pinnedTuningSnapshotId);

    for (const operation of generated.operations) {
      const representedBefore = expectedTeams.has(operation.sessionId);
      const fullBefore = expectedTeams.size === policy.totalCapacity;
      const before = capacityStateSnapshot(requireProjection(core));
      const result = await commitJoin(core, operation);

      if (representedBefore) {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'duplicate-identity');
        duplicateRejections += 1;
      } else if (fullBefore) {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'total-capacity');
        totalCapacityRejections += 1;
      } else {
        assert.equal(result.ok, true, result.ok ? undefined : result.message);
        if (result.ok) {
          assert.equal(result.effect.kind, 'joined');
          if (result.effect.kind === 'joined') {
            expectedTeams.set(operation.sessionId, result.effect.entry.team);
          }
        }
        acceptedJoins += 1;
      }

      const projection = assertPrefixInvariants(
        core,
        world,
        policy,
        expectedTeams,
        pinnedTuningSnapshotId,
      );

      if (!result.ok) {
        assert.deepEqual(
          capacityStateSnapshot(projection),
          before,
          'a rejected generated join must not change roster capacity state',
        );
      } else if (generated.mode === 'quick') {
        assert.ok(
          Math.abs(projection.occupancy.blue - projection.occupancy.orange) <= 1,
          'every accepted Quick assignment prefix must remain balanced within one player',
        );
      }

      reachedTotalBoundary ||= projection.occupancy.total === policy.totalCapacity;
      reachedBlueTeamBoundary ||= projection.occupancy.blue === policy.teamCapacity;
      reachedOrangeTeamBoundary ||= projection.occupancy.orange === policy.teamCapacity;

      assert.equal(requestedOptions.totalCapacity, otherPolicy.totalCapacity);
      assert.equal(requestedOptions.teamCapacity, otherPolicy.teamCapacity);
    }

    const finalProjection = requireProjection(core);
    assert.deepEqual(finalProjection.occupancy, {
      total: policy.totalCapacity,
      blue: policy.teamCapacity,
      orange: policy.teamCapacity,
    });
    assert.equal(core.isStartEligible, true);
    assert.equal(acceptedJoins, policy.totalCapacity);
    assert.ok(duplicateRejections >= 1);
    assert.ok(totalCapacityRejections >= 1);

    return {
      mode: generated.mode,
      acceptedJoins,
      duplicateRejections,
      totalCapacityRejections,
      reachedTotalBoundary,
      reachedBlueTeamBoundary,
      reachedOrangeTeamBoundary,
    };
  } finally {
    core.dispose();
    assert.equal(world.disposeCount, 1);
  }
}

async function exerciseWithDiagnostics(
  generatedCase: GeneratedCase<GeneratedCapacityCase>,
): Promise<CapacityCaseCoverage> {
  try {
    return await exerciseCapacityCase(generatedCase.value);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Generated case failed (seed=${JSON.stringify(generatedCase.seed)}, index=${generatedCase.index}): ${detail}`,
      { cause },
    );
  }
}

/**
 * Feature: rocket-arena, Property 1: Mode policy and capacity invariants
 * **Validates: Requirements 2.1-2.5, 2.8, 3.6-3.7, 4.7-4.8, 18.12, 18.25**
 */
test(
  `Property 1: mode policy and capacity invariants (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  async () => {
    const generatedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateCapacityCase,
    });

    assert.equal(generatedCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(generatedCases, generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateCapacityCase,
    }));
    assert.deepEqual(
      replayCase(RECORDED_SEED, REPLAY_CASE_INDEX, generateCapacityCase),
      generatedCases[REPLAY_CASE_INDEX],
    );

    assertGeneratedCases(generatedCases, (generated, generatedCase) => {
      assert.equal(generatedCase.seed, RECORDED_SEED);
      assert.equal(generatedCase.index, generated.caseIndex);
      assert.ok(generated.operations.length > ROOM_POLICIES[generated.mode].totalCapacity);
      assert.ok(generated.operations.some((operation, index, operations) => (
        operations.findIndex(({ sessionId }) => sessionId === operation.sessionId) < index
      )), 'each generated prefix must contain a duplicate request');
    });

    assert.deepEqual(
      generatedCases.reduce<Record<RoomMode, number>>(
        (counts, generatedCase) => {
          counts[generatedCase.value.mode] += 1;
          return counts;
        },
        { quick: 0, custom: 0 },
      ),
      { quick: CASES_PER_MODE, custom: CASES_PER_MODE },
    );

    const coverage: CapacityCaseCoverage[] = [];
    for (const generatedCase of generatedCases) {
      coverage.push(await exerciseWithDiagnostics(generatedCase));
    }

    for (const mode of ['quick', 'custom'] as const) {
      const modeCoverage = coverage.filter((entry) => entry.mode === mode);
      assert.equal(modeCoverage.length, CASES_PER_MODE);
      assert.ok(modeCoverage.every(({ reachedTotalBoundary }) => reachedTotalBoundary));
      assert.ok(modeCoverage.every(({ reachedBlueTeamBoundary }) => reachedBlueTeamBoundary));
      assert.ok(modeCoverage.every(({ reachedOrangeTeamBoundary }) => reachedOrangeTeamBoundary));
      assert.ok(modeCoverage.every(({ totalCapacityRejections }) => totalCapacityRejections >= 1));
      assert.ok(modeCoverage.every(({ duplicateRejections }) => duplicateRejections >= 1));
      assert.ok(modeCoverage.every(({ acceptedJoins }) => (
        acceptedJoins === ROOM_POLICIES[mode].totalCapacity
      )));
    }
  },
);
