import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOM_POLICIES, type RoomMode, type Team } from '@rocket-arena/shared';
import {
  assignTeamsInStableRosterOrder,
  type AcceptedJoinIdentity,
  type AssignedRosterIdentity,
} from './team-assignment.js';

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

// The shared helper is test infrastructure outside the server project's emit root.
// Loading its source URL at runtime lets this test use that single implementation
// while keeping the production server build rooted at server/src.
const generatedCasesModuleUrl = new URL(
  '../../../shared/tests/support/generated-cases.ts',
  import.meta.url,
).href;
const {
  assertGeneratedCases,
  generateCases,
  replayCase,
} = await import(generatedCasesModuleUrl) as unknown as GeneratedCasesModule;

const RECORDED_SEED = 'rocket-arena-property-2-v1';
const GENERATED_CASE_COUNT = 200;
const REPLAY_CASE_INDEX = 137;

type AssignmentScenario =
  | 'quick-prefix'
  | 'custom-equal'
  | 'custom-unequal'
  | 'custom-sole-blue'
  | 'custom-sole-orange';

interface GeneratedAssignmentCase {
  readonly caseIndex: number;
  readonly mode: RoomMode;
  readonly scenario: AssignmentScenario;
  readonly existingRoster: readonly AssignedRosterIdentity[];
  readonly queuedAcceptedJoins: readonly AcceptedJoinIdentity[];
}

interface MutableTeamCounts {
  blue: number;
  orange: number;
}

function shuffle<T>(values: readonly T[], random: SeededRandom): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = random.integer(0, index);
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function compareStableRosterOrder(
  left: AcceptedJoinIdentity,
  right: AcceptedJoinIdentity,
): number {
  const ordinalDifference = left.acceptedJoinOrdinal - right.acceptedJoinOrdinal;
  if (ordinalDifference !== 0) return ordinalDifference;
  return left.sessionId.localeCompare(right.sessionId);
}

function countRosterTeams(
  roster: readonly AssignedRosterIdentity[],
): MutableTeamCounts {
  const counts: MutableTeamCounts = { blue: 0, orange: 0 };
  for (const entry of roster) counts[entry.team] += 1;
  return counts;
}

function makeCustomRoster(
  caseIndex: number,
  blueCount: number,
  orangeCount: number,
  random: SeededRandom,
): readonly AssignedRosterIdentity[] {
  const entries: AssignedRosterIdentity[] = [];
  let ordinal = 0;

  for (let index = 0; index < blueCount; index += 1) {
    entries.push({
      sessionId: `case-${caseIndex}-existing-blue-${index}`,
      acceptedJoinOrdinal: ordinal,
      team: 'blue',
    });
    ordinal += 1;
  }
  for (let index = 0; index < orangeCount; index += 1) {
    entries.push({
      sessionId: `case-${caseIndex}-existing-orange-${index}`,
      acceptedJoinOrdinal: ordinal,
      team: 'orange',
    });
    ordinal += 1;
  }

  return shuffle(entries, random);
}

function makeQuickPrefix(
  caseIndex: number,
  size: number,
  random: SeededRandom,
): readonly AssignedRosterIdentity[] {
  const entries = Array.from({ length: size }, (_, index): AssignedRosterIdentity => ({
    sessionId: `case-${caseIndex}-existing-quick-${index}`,
    acceptedJoinOrdinal: index,
    team: index % 2 === 0 ? 'blue' : 'orange',
  }));
  return shuffle(entries, random);
}

function makeQueuedJoins(
  caseIndex: number,
  existingCount: number,
  count: number,
  random: SeededRandom,
): readonly AcceptedJoinIdentity[] {
  const stableSequence = Array.from({ length: count }, (_, index): AcceptedJoinIdentity => ({
    sessionId: `case-${caseIndex.toString().padStart(3, '0')}-join-${index
      .toString()
      .padStart(2, '0')}`,
    // Adjacent joins deliberately share ordinals so sessionId tie-breaking is exercised.
    acceptedJoinOrdinal: existingCount + Math.floor(index / 2),
  }));
  return shuffle(stableSequence, random);
}

function generateAssignmentCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedAssignmentCase {
  const scenarioIndex = caseIndex % 5;
  let mode: RoomMode;
  let scenario: AssignmentScenario;
  let blueCount: number;
  let orangeCount: number;
  let existingRoster: readonly AssignedRosterIdentity[];

  if (scenarioIndex === 0) {
    mode = 'quick';
    scenario = 'quick-prefix';
    const prefixSize = Math.floor(caseIndex / 5) % ROOM_POLICIES.quick.totalCapacity;
    existingRoster = makeQuickPrefix(caseIndex, prefixSize, random);
    const queueCount = random.integer(
      1,
      ROOM_POLICIES.quick.totalCapacity - prefixSize,
    );
    return {
      caseIndex,
      mode,
      scenario,
      existingRoster,
      queuedAcceptedJoins: makeQueuedJoins(
        caseIndex,
        existingRoster.length,
        queueCount,
        random,
      ),
    };
  }

  mode = 'custom';
  if (scenarioIndex === 1) {
    scenario = 'custom-equal';
    blueCount = Math.floor(caseIndex / 5) % ROOM_POLICIES.custom.teamCapacity;
    orangeCount = blueCount;
  } else if (scenarioIndex === 2) {
    scenario = 'custom-unequal';
    const smallerCount = random.integer(0, ROOM_POLICIES.custom.teamCapacity - 2);
    const largerCount = random.integer(
      smallerCount + 1,
      ROOM_POLICIES.custom.teamCapacity - 1,
    );
    if (random.integer(0, 1) === 0) {
      blueCount = smallerCount;
      orangeCount = largerCount;
    } else {
      blueCount = largerCount;
      orangeCount = smallerCount;
    }
  } else if (scenarioIndex === 3) {
    scenario = 'custom-sole-blue';
    blueCount = Math.floor(caseIndex / 5) % ROOM_POLICIES.custom.teamCapacity;
    orangeCount = ROOM_POLICIES.custom.teamCapacity;
  } else {
    scenario = 'custom-sole-orange';
    blueCount = ROOM_POLICIES.custom.teamCapacity;
    orangeCount = Math.floor(caseIndex / 5) % ROOM_POLICIES.custom.teamCapacity;
  }

  existingRoster = makeCustomRoster(
    caseIndex,
    blueCount,
    orangeCount,
    random,
  );
  const remainingCapacity = ROOM_POLICIES.custom.totalCapacity - existingRoster.length;
  const queueCount = random.integer(1, remainingCapacity);

  return {
    caseIndex,
    mode,
    scenario,
    existingRoster,
    queuedAcceptedJoins: makeQueuedJoins(
      caseIndex,
      existingRoster.length,
      queueCount,
      random,
    ),
  };
}

function expectedNextTeam(teamCapacity: number, counts: MutableTeamCounts): Team {
  const blueAvailable = counts.blue < teamCapacity;
  const orangeAvailable = counts.orange < teamCapacity;

  assert.ok(blueAvailable || orangeAvailable, 'a generated accepted join must have capacity');
  if (blueAvailable && !orangeAvailable) return 'blue';
  if (!blueAvailable && orangeAvailable) return 'orange';
  if (counts.blue === counts.orange) return 'blue';
  return counts.blue < counts.orange ? 'blue' : 'orange';
}

/**
 * Feature: rocket-arena, Property 2: Deterministic team assignment
 * **Validates: Requirements 3.3-3.6, 4.4-4.6**
 */
test(
  `Property 2: deterministic team assignment (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  () => {
    const generatedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateAssignmentCase,
    });

    assert.equal(generatedCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(generatedCases, generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateAssignmentCase,
    }));
    assert.deepEqual(
      replayCase(RECORDED_SEED, REPLAY_CASE_INDEX, generateAssignmentCase),
      generatedCases[REPLAY_CASE_INDEX],
    );

    const scenarioCounts = generatedCases.reduce<Record<AssignmentScenario, number>>(
      (counts, generatedCase) => {
        counts[generatedCase.value.scenario] += 1;
        return counts;
      },
      {
        'quick-prefix': 0,
        'custom-equal': 0,
        'custom-unequal': 0,
        'custom-sole-blue': 0,
        'custom-sole-orange': 0,
      },
    );
    assert.deepEqual(scenarioCounts, {
      'quick-prefix': 40,
      'custom-equal': 40,
      'custom-unequal': 40,
      'custom-sole-blue': 40,
      'custom-sole-orange': 40,
    });

    assertGeneratedCases(generatedCases, (generated, generatedCase) => {
      assert.equal(generatedCase.seed, RECORDED_SEED);
      assert.equal(generatedCase.index, generated.caseIndex);

      const policy = ROOM_POLICIES[generated.mode];
      const rosterBefore = structuredClone(generated.existingRoster);
      const queueBefore = structuredClone(generated.queuedAcceptedJoins);
      const orderedJoins = [...generated.queuedAcceptedJoins]
        .sort(compareStableRosterOrder);

      const firstPlan = assignTeamsInStableRosterOrder(
        policy,
        generated.existingRoster,
        generated.queuedAcceptedJoins,
      );
      const repeatedPlan = assignTeamsInStableRosterOrder(
        policy,
        generated.existingRoster,
        generated.queuedAcceptedJoins,
      );
      const canonicalOrderPlan = assignTeamsInStableRosterOrder(
        policy,
        generated.existingRoster,
        orderedJoins,
      );

      assert.deepEqual(firstPlan, repeatedPlan);
      assert.deepEqual(firstPlan, canonicalOrderPlan);
      assert.deepEqual(generated.existingRoster, rosterBefore);
      assert.deepEqual(generated.queuedAcceptedJoins, queueBefore);
      assert.deepEqual(
        firstPlan.assignments.map(({ sessionId, acceptedJoinOrdinal }) => ({
          sessionId,
          acceptedJoinOrdinal,
        })),
        orderedJoins,
      );

      const counts = countRosterTeams(generated.existingRoster);
      assert.ok(counts.blue <= policy.teamCapacity);
      assert.ok(counts.orange <= policy.teamCapacity);
      assert.ok(
        generated.existingRoster.length + generated.queuedAcceptedJoins.length
          <= policy.totalCapacity,
      );

      for (let index = 0; index < orderedJoins.length; index += 1) {
        const expectedTeam = expectedNextTeam(policy.teamCapacity, counts);
        const assignment = firstPlan.assignments[index];
        assert.ok(assignment, `missing assignment ${index}`);
        assert.equal(assignment.team, expectedTeam);

        counts[assignment.team] += 1;
        assert.ok(counts[assignment.team] <= policy.teamCapacity);
        if (generated.mode === 'quick') {
          assert.ok(Math.abs(counts.blue - counts.orange) <= 1);
        }
      }

      assert.deepEqual(firstPlan.finalCounts, counts);
      if (generated.scenario === 'custom-sole-blue') {
        assert.ok(firstPlan.assignments.every(({ team }) => team === 'blue'));
      }
      if (generated.scenario === 'custom-sole-orange') {
        assert.ok(firstPlan.assignments.every(({ team }) => team === 'orange'));
      }
    });
  },
);
