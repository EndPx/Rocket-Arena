import type { RoomPolicy, Team } from '@rocket-arena/shared';

/** Identity fields that define Stable_Roster_Order before team assignment. */
export interface AcceptedJoinIdentity {
  readonly sessionId: string;
  readonly acceptedJoinOrdinal: number;
}

/** Existing roster information needed to seed the assignment fold. */
export interface AssignedRosterIdentity extends AcceptedJoinIdentity {
  readonly team: Team;
}

export interface TeamAssignment extends AcceptedJoinIdentity {
  readonly team: Team;
}

export interface TeamAssignmentCounts {
  readonly blue: number;
  readonly orange: number;
}

export interface TeamAssignmentPlan {
  /** Assignments ordered by Stable_Roster_Order, regardless of queue iteration order. */
  readonly assignments: readonly TeamAssignment[];
  readonly finalCounts: TeamAssignmentCounts;
}

function assertRosterIdentity(entry: AcceptedJoinIdentity, label: string): void {
  if (typeof entry.sessionId !== 'string' || entry.sessionId.length === 0) {
    throw new TypeError(`${label} sessionId must be a non-empty string.`);
  }
  if (!Number.isSafeInteger(entry.acceptedJoinOrdinal) || entry.acceptedJoinOrdinal < 0) {
    throw new TypeError(`${label} acceptedJoinOrdinal must be a non-negative safe integer.`);
  }
}

function assertTeamCount(
  team: Team,
  count: number,
  policy: RoomPolicy,
): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`${team} team count must be a non-negative safe integer.`);
  }
  if (count > policy.teamCapacity) {
    throw new RangeError(
      `${team} team count ${count} exceeds ${policy.mode} capacity ${policy.teamCapacity}.`,
    );
  }
}

function compareStableRosterOrder(
  left: AcceptedJoinIdentity,
  right: AcceptedJoinIdentity,
): number {
  const ordinalDifference = left.acceptedJoinOrdinal - right.acceptedJoinOrdinal;
  if (ordinalDifference !== 0) return ordinalDifference;
  if (left.sessionId === right.sessionId) return 0;
  return left.sessionId < right.sessionId ? -1 : 1;
}

/**
 * Choose one team from authoritative counts without mutating room state.
 * Equal available teams use the policy's Blue tie break; unequal available
 * teams choose the smaller team; a sole available team always receives the
 * assignment.
 */
export function chooseTeam(
  policy: RoomPolicy,
  blueCount: number,
  orangeCount: number,
): Team | null {
  assertTeamCount('blue', blueCount, policy);
  assertTeamCount('orange', orangeCount, policy);

  const totalCount = blueCount + orangeCount;
  if (totalCount > policy.totalCapacity) {
    throw new RangeError(
      `Roster count ${totalCount} exceeds ${policy.mode} capacity ${policy.totalCapacity}.`,
    );
  }
  if (totalCount === policy.totalCapacity) return null;

  const blueAvailable = blueCount < policy.teamCapacity;
  const orangeAvailable = orangeCount < policy.teamCapacity;

  if (!blueAvailable && !orangeAvailable) return null;
  if (blueAvailable && !orangeAvailable) return 'blue';
  if (!blueAvailable && orangeAvailable) return 'orange';
  if (blueCount === orangeCount) return policy.assignmentTieBreak;
  return blueCount < orangeCount ? 'blue' : 'orange';
}

/**
 * Fold queued accepted joins through updated team counts in Stable_Roster_Order.
 * Inputs are read-only and copied before sorting, so repeated evaluation with
 * identical values produces an identical plan without changing caller state.
 *
 * A queue that cannot fit the policy is an invariant error: accepted joins
 * must be capacity-validated by the mutation planner before this fold runs.
 */
export function assignTeamsInStableRosterOrder(
  policy: RoomPolicy,
  existingRoster: readonly AssignedRosterIdentity[],
  queuedAcceptedJoins: readonly AcceptedJoinIdentity[],
): Readonly<TeamAssignmentPlan> {
  const representedSessionIds = new Set<string>();
  let blueCount = 0;
  let orangeCount = 0;

  for (const entry of existingRoster) {
    assertRosterIdentity(entry, 'Existing roster entry');
    if (entry.team !== 'blue' && entry.team !== 'orange') {
      throw new TypeError(`Existing roster entry has invalid team: ${String(entry.team)}.`);
    }
    if (representedSessionIds.has(entry.sessionId)) {
      throw new TypeError(`Duplicate roster identity: ${entry.sessionId}.`);
    }
    representedSessionIds.add(entry.sessionId);
    if (entry.team === 'blue') blueCount += 1;
    else orangeCount += 1;
  }

  assertTeamCount('blue', blueCount, policy);
  assertTeamCount('orange', orangeCount, policy);
  if (existingRoster.length > policy.totalCapacity) {
    throw new RangeError(
      `Roster count ${existingRoster.length} exceeds ${policy.mode} capacity ${policy.totalCapacity}.`,
    );
  }

  for (const entry of queuedAcceptedJoins) {
    assertRosterIdentity(entry, 'Queued accepted join');
    if (representedSessionIds.has(entry.sessionId)) {
      throw new TypeError(`Duplicate roster identity: ${entry.sessionId}.`);
    }
    representedSessionIds.add(entry.sessionId);
  }

  const orderedJoins = [...queuedAcceptedJoins].sort(compareStableRosterOrder);
  const assignments: TeamAssignment[] = [];

  for (const entry of orderedJoins) {
    const team = chooseTeam(policy, blueCount, orangeCount);
    if (team === null) {
      throw new RangeError(
        `No team capacity remains for accepted join ${entry.sessionId} in ${policy.mode}.`,
      );
    }

    assignments.push(Object.freeze({
      sessionId: entry.sessionId,
      acceptedJoinOrdinal: entry.acceptedJoinOrdinal,
      team,
    }));

    if (team === 'blue') blueCount += 1;
    else orangeCount += 1;
  }

  return Object.freeze({
    assignments: Object.freeze(assignments),
    finalCounts: Object.freeze({ blue: blueCount, orange: orangeCount }),
  });
}
