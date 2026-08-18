import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOM_POLICIES, type Team } from '@rocket-arena/shared';
import {
  assignTeamsInStableRosterOrder,
  chooseTeam,
  type AcceptedJoinIdentity,
  type AssignedRosterIdentity,
} from './team-assignment.js';

function assigned(
  sessionId: string,
  acceptedJoinOrdinal: number,
  team: Team,
): AssignedRosterIdentity {
  return { sessionId, acceptedJoinOrdinal, team };
}

function countTeams(teams: readonly Team[]): { blue: number; orange: number } {
  return teams.reduce(
    (counts, team) => ({ ...counts, [team]: counts[team] + 1 }),
    { blue: 0, orange: 0 },
  );
}

// Validates: Requirements 3.3-3.7

test('Quick Match prefixes break ties toward Blue and always choose the smaller team', () => {
  const stableQueue: AcceptedJoinIdentity[] = Array.from({ length: 6 }, (_, index) => ({
    sessionId: `quick-${index}`,
    acceptedJoinOrdinal: index,
  }));

  for (let prefixLength = 0; prefixLength <= stableQueue.length; prefixLength += 1) {
    const unorderedPrefix = stableQueue.slice(0, prefixLength).reverse();
    const plan = assignTeamsInStableRosterOrder(
      ROOM_POLICIES.quick,
      [],
      unorderedPrefix,
    );

    const expectedTeams = stableQueue
      .slice(0, prefixLength)
      .map((_, index): Team => (index % 2 === 0 ? 'blue' : 'orange'));

    assert.deepEqual(
      plan.assignments.map(({ sessionId }) => sessionId),
      stableQueue.slice(0, prefixLength).map(({ sessionId }) => sessionId),
    );
    assert.deepEqual(plan.assignments.map(({ team }) => team), expectedTeams);

    const counts = countTeams(expectedTeams);
    assert.deepEqual(plan.finalCounts, counts);
    assert.ok(Math.abs(counts.blue - counts.orange) <= 1);
    assert.ok(counts.blue <= ROOM_POLICIES.quick.teamCapacity);
    assert.ok(counts.orange <= ROOM_POLICIES.quick.teamCapacity);
  }
});

test('chooseTeam handles equal, unequal, sole-available, and full Quick counts', () => {
  const policy = ROOM_POLICIES.quick;

  assert.equal(chooseTeam(policy, 0, 0), 'blue');
  assert.equal(chooseTeam(policy, 1, 0), 'orange');
  assert.equal(chooseTeam(policy, 1, 1), 'blue');
  assert.equal(chooseTeam(policy, 3, 2), 'orange');
  assert.equal(chooseTeam(policy, 3, 3), null);
});

// Validates: Requirements 4.4-4.8

test('Custom Room assigns queued joins to the only team with capacity', () => {
  const existingRoster: AssignedRosterIdentity[] = [
    assigned('blue-0', 0, 'blue'),
    assigned('blue-1', 1, 'blue'),
    assigned('blue-2', 2, 'blue'),
    assigned('blue-3', 3, 'blue'),
    assigned('orange-0', 4, 'orange'),
    assigned('orange-1', 5, 'orange'),
  ];
  const queuedJoins: AcceptedJoinIdentity[] = [
    { sessionId: 'orange-3', acceptedJoinOrdinal: 7 },
    { sessionId: 'orange-2', acceptedJoinOrdinal: 6 },
  ];

  const plan = assignTeamsInStableRosterOrder(
    ROOM_POLICIES.custom,
    existingRoster,
    queuedJoins,
  );

  assert.deepEqual(plan.assignments, [
    { sessionId: 'orange-2', acceptedJoinOrdinal: 6, team: 'orange' },
    { sessionId: 'orange-3', acceptedJoinOrdinal: 7, team: 'orange' },
  ]);
  assert.deepEqual(plan.finalCounts, { blue: 4, orange: 4 });

  const oppositeEdge = assignTeamsInStableRosterOrder(
    ROOM_POLICIES.custom,
    [
      assigned('blue-0', 0, 'blue'),
      assigned('blue-1', 1, 'blue'),
      assigned('blue-2', 2, 'blue'),
      assigned('orange-0', 3, 'orange'),
      assigned('orange-1', 4, 'orange'),
      assigned('orange-2', 5, 'orange'),
      assigned('orange-3', 6, 'orange'),
    ],
    [{ sessionId: 'blue-3', acceptedJoinOrdinal: 7 }],
  );

  assert.equal(oppositeEdge.assignments[0]?.team, 'blue');
  assert.deepEqual(oppositeEdge.finalCounts, { blue: 4, orange: 4 });
});

test('Custom Room returns no choice at 4v4 and refuses an over-capacity accepted queue', () => {
  const fullRoster: AssignedRosterIdentity[] = [
    assigned('blue-0', 0, 'blue'),
    assigned('orange-0', 1, 'orange'),
    assigned('blue-1', 2, 'blue'),
    assigned('orange-1', 3, 'orange'),
    assigned('blue-2', 4, 'blue'),
    assigned('orange-2', 5, 'orange'),
    assigned('blue-3', 6, 'blue'),
    assigned('orange-3', 7, 'orange'),
  ];

  assert.equal(chooseTeam(ROOM_POLICIES.custom, 4, 4), null);
  assert.throws(
    () => assignTeamsInStableRosterOrder(
      ROOM_POLICIES.custom,
      fullRoster,
      [{ sessionId: 'ninth', acceptedJoinOrdinal: 8 }],
    ),
    /No team capacity remains/,
  );
});

test('Stable_Roster_Order uses session identity to break equal-ordinal ties', () => {
  const plan = assignTeamsInStableRosterOrder(
    ROOM_POLICIES.custom,
    [],
    [
      { sessionId: 'zeta', acceptedJoinOrdinal: 4 },
      { sessionId: 'alpha', acceptedJoinOrdinal: 4 },
      { sessionId: 'middle', acceptedJoinOrdinal: 4 },
    ],
  );

  assert.deepEqual(
    plan.assignments.map(({ sessionId, team }) => [sessionId, team]),
    [
      ['alpha', 'blue'],
      ['middle', 'orange'],
      ['zeta', 'blue'],
    ],
  );
});

test('repeated evaluation is identical and does not mutate caller-owned inputs', () => {
  const existingRoster: AssignedRosterIdentity[] = [
    assigned('existing-blue', 0, 'blue'),
    assigned('existing-orange', 1, 'orange'),
  ];
  const queuedJoins: AcceptedJoinIdentity[] = [
    { sessionId: 'later', acceptedJoinOrdinal: 3 },
    { sessionId: 'earlier', acceptedJoinOrdinal: 2 },
  ];
  const rosterBefore = structuredClone(existingRoster);
  const queueBefore = structuredClone(queuedJoins);

  const first = assignTeamsInStableRosterOrder(
    ROOM_POLICIES.custom,
    existingRoster,
    queuedJoins,
  );
  const second = assignTeamsInStableRosterOrder(
    ROOM_POLICIES.custom,
    existingRoster,
    queuedJoins,
  );

  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.deepEqual(existingRoster, rosterBefore);
  assert.deepEqual(queuedJoins, queueBefore);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.assignments));
  assert.ok(first.assignments.every(Object.isFrozen));
  assert.ok(Object.isFrozen(first.finalCounts));
});
