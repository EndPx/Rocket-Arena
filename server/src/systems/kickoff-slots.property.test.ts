import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  KICKOFF_SLOT_INDEXES,
  KICKOFF_SLOTS,
  ROOM_POLICIES,
  TEAM_FACING_MAX_ERROR_DEGREES,
  centerFacingErrorDegrees,
  mirrorBlueKickoffSlot,
  type CarColliderDimensions,
  type KickoffSlot,
  type RoomMode,
  type RosterEntry,
  type Team,
  type Vector3Tuple,
} from '@rocket-arena/shared';
import {
  DeterministicKickoffAssignmentService,
  orientedBoxesOverlap,
  validateKickoffAssignmentBijection,
  type KickoffAssignment,
  type KickoffAssignmentSet,
} from './kickoff-slots.js';

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

// Shared generated-case support is outside the server project's emit root.
// Runtime loading keeps one deterministic implementation without widening rootDir.
const generatedCasesModuleUrl = new URL(
  '../../../shared/tests/support/generated-cases.ts',
  import.meta.url,
).href;
const {
  assertGeneratedCases,
  generateCases,
  replayCase,
} = await import(generatedCasesModuleUrl) as unknown as GeneratedCasesModule;

interface CapacityValidShape {
  readonly mode: RoomMode;
  readonly blueCount: number;
  readonly orangeCount: number;
  /** Team sequence after applying global Stable_Roster_Order. */
  readonly stableTeamOrder: readonly Team[];
}

interface GeneratedKickoffCase {
  readonly caseIndex: number;
  readonly shapeKey: string;
  readonly mode: RoomMode;
  readonly stableTeamOrder: readonly Team[];
  readonly stableRoster: readonly RosterEntry[];
  readonly inputRoster: readonly RosterEntry[];
}

type OrientedBoxInput = Parameters<typeof orientedBoxesOverlap>[0];

type SlotCoverage = Record<RoomMode, Record<Team, Set<number>>>;

const RECORDED_SEED = 'rocket-arena-property-6-kickoff-bijection-v1';
const REPLAY_CASE_INDEX = 219;

function enumerateTeamOrders(
  blueRemaining: number,
  orangeRemaining: number,
): readonly (readonly Team[])[] {
  const orders: Team[][] = [];
  const current: Team[] = [];

  const visit = (blue: number, orange: number): void => {
    if (blue === 0 && orange === 0) {
      orders.push([...current]);
      return;
    }
    if (blue > 0) {
      current.push('blue');
      visit(blue - 1, orange);
      current.pop();
    }
    if (orange > 0) {
      current.push('orange');
      visit(blue, orange - 1);
      current.pop();
    }
  };

  visit(blueRemaining, orangeRemaining);
  return Object.freeze(orders.map((order) => Object.freeze(order)));
}

function enumerateCapacityValidShapes(mode: RoomMode): readonly CapacityValidShape[] {
  const policy = ROOM_POLICIES[mode];
  const teamSizes: Array<readonly [number, number]> = [];

  if (mode === 'quick') {
    // A capacity-valid Quick kickoff is exactly the full-balanced 3v3 roster.
    teamSizes.push([policy.teamCapacity, policy.teamCapacity]);
  } else {
    // A capacity-valid Custom kickoff has at least one represented player and
    // remains within both the total and per-team policy capacities.
    for (let blue = 0; blue <= policy.teamCapacity; blue += 1) {
      for (let orange = 0; orange <= policy.teamCapacity; orange += 1) {
        const total = blue + orange;
        if (total > 0 && total <= policy.totalCapacity) teamSizes.push([blue, orange]);
      }
    }
  }

  return Object.freeze(teamSizes.flatMap(([blueCount, orangeCount]) => (
    enumerateTeamOrders(blueCount, orangeCount).map((stableTeamOrder) => Object.freeze({
      mode,
      blueCount,
      orangeCount,
      stableTeamOrder,
    }))
  )));
}

const CAPACITY_VALID_SHAPES = Object.freeze([
  ...enumerateCapacityValidShapes('quick'),
  ...enumerateCapacityValidShapes('custom'),
]);
const GENERATED_CASE_COUNT = CAPACITY_VALID_SHAPES.length;

function shapeKey(shape: Pick<CapacityValidShape, 'mode' | 'stableTeamOrder'>): string {
  return `${shape.mode}:${shape.stableTeamOrder.map((team) => team[0]).join('')}`;
}

function teamSizeKey(
  shape: Pick<CapacityValidShape, 'mode' | 'blueCount' | 'orangeCount'>,
): string {
  return `${shape.mode}:${shape.blueCount}-${shape.orangeCount}`;
}

function binomial(total: number, selected: number): number {
  const count = Math.min(selected, total - selected);
  let result = 1;
  for (let index = 1; index <= count; index += 1) {
    result = result * (total - count + index) / index;
  }
  return result;
}

function shuffle<T>(values: readonly T[], random: SeededRandom): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = random.integer(0, index);
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function generateKickoffCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedKickoffCase {
  const shape = CAPACITY_VALID_SHAPES[caseIndex];
  assert.ok(shape, `missing exhaustive shape ${caseIndex}`);

  let ordinal = random.integer(0, 20);
  const stableRoster = shape.stableTeamOrder.map((team, stableIndex): RosterEntry => {
    // Deterministically include ordinal ties, resolved by the stable-index prefix
    // in sessionId, while randomized gaps exercise non-contiguous ordinals.
    if (stableIndex > 0 && (caseIndex + stableIndex) % 3 !== 0) {
      ordinal += random.integer(1, 3);
    }
    const nonce = random.integer(0, 0xff_ffff).toString(16).padStart(6, '0');
    const sessionId = `property-6-${caseIndex.toString().padStart(3, '0')}`
      + `-${stableIndex.toString().padStart(2, '0')}-${nonce}`;
    return Object.freeze({
      sessionId,
      acceptedJoinOrdinal: ordinal,
      team,
      name: `Generated ${nonce}`,
      isHost: shape.mode === 'custom' && stableIndex === 0,
    });
  });

  return Object.freeze({
    caseIndex,
    shapeKey: shapeKey(shape),
    mode: shape.mode,
    stableTeamOrder: shape.stableTeamOrder,
    stableRoster: Object.freeze(stableRoster),
    inputRoster: Object.freeze(shuffle(stableRoster, random)),
  });
}

function stableRosterCompare(left: RosterEntry, right: RosterEntry): number {
  return left.acceptedJoinOrdinal - right.acceptedJoinOrdinal
    || left.sessionId.localeCompare(right.sessionId);
}

function makeService(mode: RoomMode): DeterministicKickoffAssignmentService {
  return new DeterministicKickoffAssignmentService({
    policy: ROOM_POLICIES[mode],
    tuningRegistry: DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  });
}

function requirePrepared(
  result: ReturnType<DeterministicKickoffAssignmentService['prepare']>,
) {
  if (!result.ok) assert.fail(result.message);
  return result.prepared;
}

function canonicalAssignments(
  assignmentSet: Readonly<KickoffAssignmentSet>,
): readonly unknown[] {
  return [...assignmentSet.assignments.values()]
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    .map((assignment) => ({
      sessionId: assignment.sessionId,
      team: assignment.team,
      slotId: assignment.slotId,
      slotIndex: assignment.slotIndex,
      position: [...assignment.position],
      rotation: [...assignment.rotation],
    }));
}

function cloneInOrder(entries: readonly RosterEntry[]): RosterEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

function reorderedEquivalentRosters(
  stableRoster: readonly RosterEntry[],
): readonly (readonly RosterEntry[])[] {
  const reversed = cloneInOrder(stableRoster).reverse();
  const rotated = stableRoster.length <= 1
    ? cloneInOrder(stableRoster)
    : cloneInOrder([...stableRoster.slice(1), stableRoster[0]!]);
  const descendingIdentity = cloneInOrder(stableRoster)
    .sort((left, right) => right.sessionId.localeCompare(left.sessionId));
  return Object.freeze([reversed, rotated, descendingIdentity]);
}

function quaternionAxes(
  rotation: KickoffAssignment['rotation'],
): readonly [Vector3Tuple, Vector3Tuple, Vector3Tuple] {
  const magnitude = Math.hypot(...rotation);
  assert.ok(Number.isFinite(magnitude) && magnitude > 0);
  const [x, y, z, w] = rotation.map((component) => component / magnitude) as [
    number,
    number,
    number,
    number,
  ];
  return [
    [
      1 - 2 * (y * y + z * z),
      2 * (x * y + z * w),
      2 * (x * z - y * w),
    ],
    [
      2 * (x * y - z * w),
      1 - 2 * (x * x + z * z),
      2 * (y * z + x * w),
    ],
    [
      2 * (x * z + y * w),
      2 * (y * z - x * w),
      1 - 2 * (x * x + y * y),
    ],
  ];
}

function assignmentBox(
  assignment: Readonly<KickoffAssignment>,
  dimensions: CarColliderDimensions,
): OrientedBoxInput {
  return {
    center: assignment.position,
    axes: quaternionAxes(assignment.rotation),
    halfExtents: [
      dimensions.width / 2,
      dimensions.height / 2,
      dimensions.length / 2,
    ],
  };
}

function assertExactSlotMirroringAndFacing(
  service: DeterministicKickoffAssignmentService,
): void {
  assert.equal(KICKOFF_SLOTS.blue.length, ROOM_POLICIES.custom.teamCapacity);
  assert.equal(KICKOFF_SLOTS.orange.length, ROOM_POLICIES.custom.teamCapacity);

  for (const index of KICKOFF_SLOT_INDEXES) {
    const blue = KICKOFF_SLOTS.blue[index];
    const orange = KICKOFF_SLOTS.orange[index];
    assert.ok(blue);
    assert.ok(orange);
    const exactMirror = mirrorBlueKickoffSlot(blue, service.arenaBounds.center);
    assert.deepEqual(orange.position, exactMirror.position);
    assert.deepEqual(orange.rotation, exactMirror.rotation);
    assert.ok(
      centerFacingErrorDegrees(blue, service.arenaBounds.center)
        <= TEAM_FACING_MAX_ERROR_DEGREES,
    );
    assert.ok(
      centerFacingErrorDegrees(orange, service.arenaBounds.center)
        <= TEAM_FACING_MAX_ERROR_DEGREES,
    );
  }
}

function assertAssignedMirrors(
  assignmentSet: Readonly<KickoffAssignmentSet>,
  service: DeterministicKickoffAssignmentService,
): void {
  const assignments = [...assignmentSet.assignments.values()];
  for (const index of KICKOFF_SLOT_INDEXES) {
    const blue = assignments.find((assignment) => (
      assignment.team === 'blue' && assignment.slotIndex === index
    ));
    const orange = assignments.find((assignment) => (
      assignment.team === 'orange' && assignment.slotIndex === index
    ));
    if (blue === undefined || orange === undefined) continue;

    const blueSlot: KickoffSlot = {
      id: `blue-${index}`,
      index,
      team: 'blue',
      position: blue.position,
      rotation: blue.rotation,
    };
    const exactMirror = mirrorBlueKickoffSlot(blueSlot, service.arenaBounds.center);
    assert.deepEqual(orange.position, exactMirror.position);
    assert.deepEqual(orange.rotation, exactMirror.rotation);
  }
}

function assertCompleteBijectionAndUniqueSpawn(
  assignmentSet: Readonly<KickoffAssignmentSet>,
  roster: readonly RosterEntry[],
  service: DeterministicKickoffAssignmentService,
  slotCoverage: SlotCoverage,
): { readonly sameTeamPairs: number; readonly crossTeamPairs: number } {
  const policy = ROOM_POLICIES[service.policy.mode];
  const assignments = assignmentSet.assignments;
  const orderedRoster = [...roster].sort(stableRosterCompare);
  const rosterIds = orderedRoster.map(({ sessionId }) => sessionId).sort();

  assert.equal(assignments.size, orderedRoster.length);
  assert.deepEqual([...assignments.keys()].sort(), rosterIds);
  assert.equal(new Set(assignments.keys()).size, orderedRoster.length);
  assert.equal(new Set([...assignments.values()].map(({ slotId }) => slotId)).size, orderedRoster.length);
  assert.doesNotThrow(() => validateKickoffAssignmentBijection(
    assignments,
    orderedRoster,
    policy,
    service.colliderDimensions,
  ));

  for (const team of ['blue', 'orange'] as const) {
    orderedRoster
      .filter((entry) => entry.team === team)
      .sort(stableRosterCompare)
      .forEach((entry, teamLocalIndex) => {
        const assignment = assignments.get(entry.sessionId);
        assert.ok(assignment, `${entry.sessionId} is missing an assignment`);
        assert.equal(assignment.sessionId, entry.sessionId);
        assert.equal(assignment.team, team);
        assert.equal(assignment.slotIndex, teamLocalIndex);
        assert.equal(assignment.slotId, `${team}-${teamLocalIndex}`);
        assert.deepEqual(assignment.position, KICKOFF_SLOTS[team][teamLocalIndex]?.position);
        assert.deepEqual(assignment.rotation, KICKOFF_SLOTS[team][teamLocalIndex]?.rotation);
        assert.ok(
          centerFacingErrorDegrees(assignment, service.arenaBounds.center)
            <= TEAM_FACING_MAX_ERROR_DEGREES,
        );
        slotCoverage[service.policy.mode][team].add(assignment.slotIndex);
      });
  }

  assertAssignedMirrors(assignmentSet, service);

  let sameTeamPairs = 0;
  let crossTeamPairs = 0;
  const orderedAssignments = [...assignments.values()]
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  for (let leftIndex = 0; leftIndex < orderedAssignments.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < orderedAssignments.length; rightIndex += 1) {
      const left = orderedAssignments[leftIndex]!;
      const right = orderedAssignments[rightIndex]!;
      assert.equal(
        orientedBoxesOverlap(
          assignmentBox(left, service.colliderDimensions),
          assignmentBox(right, service.colliderDimensions),
        ),
        false,
        `${left.sessionId}/${left.slotId} overlaps ${right.sessionId}/${right.slotId}`,
      );
      if (left.team === right.team) sameTeamPairs += 1;
      else crossTeamPairs += 1;
    }
  }

  return { sameTeamPairs, crossTeamPairs };
}

function assertExhaustiveShapeCatalog(): void {
  const quickShapes = CAPACITY_VALID_SHAPES.filter(({ mode }) => mode === 'quick');
  const customShapes = CAPACITY_VALID_SHAPES.filter(({ mode }) => mode === 'custom');
  assert.equal(quickShapes.length, 20, '3v3 has exactly C(6,3) global team-order shapes');
  assert.equal(customShapes.length, 250, 'all non-empty <=4v4 Custom order shapes are enumerated');
  assert.equal(new Set(CAPACITY_VALID_SHAPES.map(shapeKey)).size, CAPACITY_VALID_SHAPES.length);

  const quickPolicy = ROOM_POLICIES.quick;
  assert.ok(quickShapes.every(({ blueCount, orangeCount, stableTeamOrder }) => (
    blueCount === quickPolicy.teamCapacity
    && orangeCount === quickPolicy.teamCapacity
    && stableTeamOrder.length === quickPolicy.totalCapacity
  )));

  const customPolicy = ROOM_POLICIES.custom;
  const expectedCustomTeamSizes = new Set<string>();
  for (let blue = 0; blue <= customPolicy.teamCapacity; blue += 1) {
    for (let orange = 0; orange <= customPolicy.teamCapacity; orange += 1) {
      if (blue + orange === 0 || blue + orange > customPolicy.totalCapacity) continue;
      const key = `custom:${blue}-${orange}`;
      expectedCustomTeamSizes.add(key);
      const matchingShapes = customShapes.filter((shape) => teamSizeKey(shape) === key);
      assert.equal(
        matchingShapes.length,
        binomial(blue + orange, blue),
        `${key} must enumerate every global Stable_Roster_Order interleaving`,
      );
    }
  }
  assert.deepEqual(
    new Set(customShapes.map(teamSizeKey)),
    expectedCustomTeamSizes,
    'every Custom team-size shape must be represented',
  );
}

function exerciseGeneratedCase(
  generated: GeneratedKickoffCase,
  generatedCase: GeneratedCase<GeneratedKickoffCase>,
  slotCoverage: SlotCoverage,
): { readonly sameTeamPairs: number; readonly crossTeamPairs: number } {
  try {
    assert.equal(generatedCase.seed, RECORDED_SEED);
    assert.equal(generatedCase.index, generated.caseIndex);
    assert.equal(generated.shapeKey, shapeKey(CAPACITY_VALID_SHAPES[generated.caseIndex]!));

    const stableOrder = [...generated.inputRoster].sort(stableRosterCompare);
    assert.deepEqual(stableOrder, generated.stableRoster);
    assert.deepEqual(
      stableOrder.map(({ team }) => team),
      generated.stableTeamOrder,
      'generated identities and ordinal ties must realize the enumerated team-order shape',
    );
    const inputBefore = structuredClone(generated.inputRoster);
    const epoch = generated.caseIndex + 1;
    const service = makeService(generated.mode);
    assertExactSlotMirroringAndFacing(service);

    const first = requirePrepared(service.prepare(generated.inputRoster, epoch)).commit();
    const pairCoverage = assertCompleteBijectionAndUniqueSpawn(
      first,
      generated.stableRoster,
      service,
      slotCoverage,
    );
    const expectedAssignments = canonicalAssignments(first);

    const equivalentRosters = reorderedEquivalentRosters(generated.stableRoster);
    for (const equivalentRoster of equivalentRosters) {
      const repeated = requirePrepared(service.prepare(equivalentRoster, epoch));
      assert.equal(repeated.reusedAssignments, true);
      assert.equal(repeated.candidate, first);
      assert.equal(repeated.candidate.assignments, first.assignments);
      assert.deepEqual(canonicalAssignments(repeated.candidate), expectedAssignments);
      repeated.abort();

      const independentlyBuilt = requirePrepared(
        makeService(generated.mode).prepare(equivalentRoster, epoch),
      ).commit();
      assert.equal(independentlyBuilt.rosterSignature, first.rosterSignature);
      assert.deepEqual(canonicalAssignments(independentlyBuilt), expectedAssignments);
    }

    const nextEpoch = requirePrepared(
      service.prepare(equivalentRosters[0]!, epoch + 1),
    );
    assert.equal(nextEpoch.reusedAssignments, true);
    assert.equal(nextEpoch.candidate.epoch, epoch + 1);
    assert.equal(nextEpoch.candidate.assignments, first.assignments);
    assert.deepEqual(canonicalAssignments(nextEpoch.candidate), expectedAssignments);
    nextEpoch.abort();

    assert.deepEqual(generated.inputRoster, inputBefore, 'assignment must not mutate roster input');
    return pairCoverage;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const diagnostics = JSON.stringify({
      seed: generatedCase.seed,
      index: generatedCase.index,
      mode: generated.mode,
      shape: generated.shapeKey,
      roster: generated.stableRoster.map(({ sessionId, acceptedJoinOrdinal, team }) => ({
        sessionId,
        acceptedJoinOrdinal,
        team,
      })),
    });
    throw new Error(`Kickoff Property 6 case ${diagnostics} failed: ${detail}`, { cause });
  }
}

/**
 * Feature: rocket-arena, Property 6: Deterministic kickoff-slot bijection and unique spawn
 * **Validates: Requirements 5.1-5.12, 18.16, 18.25**
 */
test(
  `Property 6: deterministic kickoff-slot bijection and unique spawn (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  () => {
    assertExhaustiveShapeCatalog();
    assert.ok(GENERATED_CASE_COUNT >= 100);
    assert.ok(REPLAY_CASE_INDEX < GENERATED_CASE_COUNT);

    const generatedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateKickoffCase,
    });
    assert.equal(generatedCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(generatedCases, generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateKickoffCase,
    }));
    assert.deepEqual(
      replayCase(RECORDED_SEED, REPLAY_CASE_INDEX, generateKickoffCase),
      generatedCases[REPLAY_CASE_INDEX],
    );
    assert.deepEqual(
      generatedCases.map(({ value }) => value.shapeKey),
      CAPACITY_VALID_SHAPES.map(shapeKey),
      'the generated seed must exercise every exhaustive mode/team-size/order shape once',
    );

    const slotCoverage: SlotCoverage = {
      quick: { blue: new Set(), orange: new Set() },
      custom: { blue: new Set(), orange: new Set() },
    };
    let sameTeamPairs = 0;
    let crossTeamPairs = 0;

    assertGeneratedCases(generatedCases, (generated, generatedCase) => {
      const pairCoverage = exerciseGeneratedCase(generated, generatedCase, slotCoverage);
      sameTeamPairs += pairCoverage.sameTeamPairs;
      crossTeamPairs += pairCoverage.crossTeamPairs;
    });

    assert.deepEqual([...slotCoverage.quick.blue].sort(), [0, 1, 2]);
    assert.deepEqual([...slotCoverage.quick.orange].sort(), [0, 1, 2]);
    assert.deepEqual([...slotCoverage.custom.blue].sort(), [...KICKOFF_SLOT_INDEXES]);
    assert.deepEqual([...slotCoverage.custom.orange].sort(), [...KICKOFF_SLOT_INDEXES]);
    assert.ok(sameTeamPairs > 0, 'generated coverage must check same-team OBB pairs');
    assert.ok(crossTeamPairs > 0, 'generated coverage must check cross-team OBB pairs');
  },
);
