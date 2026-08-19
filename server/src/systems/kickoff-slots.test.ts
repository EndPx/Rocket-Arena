import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BLUE_KICKOFF_SLOTS,
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  KICKOFF_SLOTS,
  ORANGE_KICKOFF_SLOTS,
  ROOM_POLICIES,
  mirrorBlueKickoffSlot,
  type KickoffSlot,
  type KickoffSlotTable,
  type RosterEntry,
  type Team,
} from '@rocket-arena/shared';
import {
  DeterministicKickoffAssignmentService,
  InvalidKickoffAssignmentError,
  validateKickoffAssignmentBijection,
  type KickoffAssignment,
} from './kickoff-slots.js';

function rosterShape(blueCount: number, orangeCount: number, prefix = 'player'): RosterEntry[] {
  const entries: RosterEntry[] = [];
  let ordinal = 0;
  const maximum = Math.max(blueCount, orangeCount);
  for (let index = 0; index < maximum; index += 1) {
    for (const [team, count] of [['blue', blueCount], ['orange', orangeCount]] as const) {
      if (index >= count) continue;
      const sessionId = `${prefix}-${team}-${index}`;
      entries.push({
        sessionId,
        acceptedJoinOrdinal: ordinal,
        team,
        name: sessionId,
        isHost: team === 'blue' && index === 0,
      });
      ordinal += 1;
    }
  }
  return entries;
}

function service(mode: 'quick' | 'custom' = 'custom'): DeterministicKickoffAssignmentService {
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

function teamLocalOrder(roster: readonly RosterEntry[], team: Team): readonly RosterEntry[] {
  return roster
    .filter((entry) => entry.team === team)
    .sort((left, right) => (
      left.acceptedJoinOrdinal - right.acceptedJoinOrdinal
      || left.sessionId.localeCompare(right.sessionId)
    ));
}

function overlappingMirroredTable(): KickoffSlotTable {
  const blueZero: KickoffSlot = Object.freeze({
    ...BLUE_KICKOFF_SLOTS[0]!,
    position: Object.freeze([0, 0.26, -0.1] as const),
    rotation: Object.freeze([0, 0, 0, 1] as const),
  });
  const blue = Object.freeze([
    blueZero,
    BLUE_KICKOFF_SLOTS[1]!,
    BLUE_KICKOFF_SLOTS[2]!,
    BLUE_KICKOFF_SLOTS[3]!,
  ] as const);
  const orange = Object.freeze([
    mirrorBlueKickoffSlot(blueZero),
    ORANGE_KICKOFF_SLOTS[1]!,
    ORANGE_KICKOFF_SLOTS[2]!,
    ORANGE_KICKOFF_SLOTS[3]!,
  ] as const);
  return Object.freeze({ blue, orange });
}

// Validates: Requirements 5.5-5.9

test('maps every one-through-four-player team shape by team-local Stable_Roster_Order', () => {
  const assignmentService = service('custom');
  let epoch = 1;

  for (let blueCount = 0; blueCount <= 4; blueCount += 1) {
    for (let orangeCount = 0; orangeCount <= 4; orangeCount += 1) {
      if (blueCount + orangeCount === 0) continue;
      const roster = rosterShape(blueCount, orangeCount, `shape-${blueCount}-${orangeCount}`);
      // Input map/array order is deliberately unrelated to Stable_Roster_Order.
      roster.reverse();
      const prepared = requirePrepared(assignmentService.prepare(roster, epoch));
      const committed = prepared.commit();

      assert.equal(committed.assignments.size, roster.length);
      assert.equal(new Set(committed.assignments.keys()).size, roster.length);
      for (const team of ['blue', 'orange'] as const) {
        teamLocalOrder(roster, team).forEach((entry, index) => {
          const assignment = committed.assignments.get(entry.sessionId);
          assert.ok(assignment);
          assert.equal(assignment.team, team);
          assert.equal(assignment.slotIndex, index);
          assert.equal(assignment.slotId, `${team}-${index}`);
          assert.deepEqual(assignment.position, KICKOFF_SLOTS[team][index]?.position);
          assert.deepEqual(assignment.rotation, KICKOFF_SLOTS[team][index]?.rotation);
          assert.ok(Object.isFrozen(assignment));
        });
      }
      epoch += 1;
    }
  }

  const quickService = service('quick');
  const quickRoster = rosterShape(3, 3, 'quick');
  const quick = requirePrepared(quickService.prepare(quickRoster, 1)).commit();
  assert.equal(quick.assignments.size, 6);
  assert.deepEqual(
    [...quick.assignments.values()].filter(({ team }) => team === 'blue').map(({ slotIndex }) => slotIndex),
    [0, 1, 2],
  );
});

// Validates: Requirements 5.5-5.6, 5.9, 5.11

test('rejects duplicate identities, outsiders, missing identities, duplicate slots, and OBB overlap', () => {
  const assignmentService = service();
  const roster = rosterShape(2, 2, 'bijection');
  const duplicateRoster = [...roster, { ...roster[0]! }];
  const duplicateResult = assignmentService.prepare(duplicateRoster, 1);
  assert.equal(duplicateResult.ok, false);
  if (!duplicateResult.ok) assert.equal(duplicateResult.code, 'invalid-roster');
  assert.equal(assignmentService.current, null);

  const valid = requirePrepared(assignmentService.prepare(roster, 1)).commit();
  assert.equal(
    typeof (valid.assignments as ReadonlyMap<string, KickoffAssignment> & { set?: unknown }).set,
    'undefined',
    'committed assignment maps expose no runtime mutator',
  );
  const dimensions = assignmentService.colliderDimensions;
  const missing = new Map(valid.assignments);
  missing.delete(roster[0]!.sessionId);
  assert.throws(
    () => validateKickoffAssignmentBijection(missing, roster, ROOM_POLICIES.custom, dimensions),
    (error: unknown) => error instanceof InvalidKickoffAssignmentError
      && error.code === 'incomplete-bijection',
  );

  const outsider = new Map(valid.assignments);
  const first = valid.assignments.get(roster[0]!.sessionId)!;
  outsider.delete(roster[0]!.sessionId);
  outsider.set('outsider', { ...first, sessionId: 'outsider' });
  assert.throws(
    () => validateKickoffAssignmentBijection(outsider, roster, ROOM_POLICIES.custom, dimensions),
    (error: unknown) => error instanceof InvalidKickoffAssignmentError
      && error.code === 'incomplete-bijection',
  );

  const duplicateSlot = new Map(valid.assignments);
  const blue = teamLocalOrder(roster, 'blue');
  const blueZero = duplicateSlot.get(blue[0]!.sessionId)!;
  duplicateSlot.set(blue[1]!.sessionId, Object.freeze({
    ...duplicateSlot.get(blue[1]!.sessionId)!,
    slotId: blueZero.slotId,
    slotIndex: blueZero.slotIndex,
    position: blueZero.position,
    rotation: blueZero.rotation,
  }) as KickoffAssignment);
  assert.throws(
    () => validateKickoffAssignmentBijection(duplicateSlot, roster, ROOM_POLICIES.custom, dimensions),
    (error: unknown) => error instanceof InvalidKickoffAssignmentError
      && error.code === 'incomplete-bijection',
  );

  const swappedSlots = new Map(valid.assignments);
  const blueOne = valid.assignments.get(blue[1]!.sessionId)!;
  swappedSlots.set(blue[0]!.sessionId, Object.freeze({
    ...blueOne,
    sessionId: blue[0]!.sessionId,
  }));
  swappedSlots.set(blue[1]!.sessionId, Object.freeze({
    ...blueZero,
    sessionId: blue[1]!.sessionId,
  }));
  assert.throws(
    () => validateKickoffAssignmentBijection(swappedSlots, roster, ROOM_POLICIES.custom, dimensions),
    (error: unknown) => error instanceof InvalidKickoffAssignmentError
      && error.code === 'incomplete-bijection',
    'same-team identities may not swap their Stable_Roster_Order slot indices',
  );

  const retained = assignmentService.current;
  const overlap = assignmentService.prepare(
    rosterShape(1, 1, 'overlap'),
    2,
    overlappingMirroredTable(),
  );
  assert.equal(overlap.ok, false);
  if (!overlap.ok) {
    assert.equal(overlap.code, 'overlapping-spawn');
    assert.equal(overlap.retained, retained);
  }
  assert.equal(assignmentService.current, retained);
});

// Validates: Requirements 5.10-5.12

test('reuses unchanged mappings and swaps changed rosters only after explicit commit', () => {
  const assignmentService = service();
  const initialRoster = rosterShape(3, 3, 'stable');
  const initial = requirePrepared(assignmentService.prepare(initialRoster, 7)).commit();

  const repeated = requirePrepared(assignmentService.prepare([...initialRoster].reverse(), 7));
  assert.equal(repeated.reusedAssignments, true);
  assert.equal(repeated.candidate, initial, 'same epoch and roster reuse the complete set');
  assert.equal(repeated.candidate.assignments, initial.assignments);
  repeated.abort();
  assert.equal(assignmentService.current, initial);

  const nextEpoch = requirePrepared(assignmentService.prepare(initialRoster, 8));
  assert.equal(nextEpoch.reusedAssignments, true);
  assert.equal(nextEpoch.candidate.assignments, initial.assignments);
  assert.deepEqual(
    [...nextEpoch.candidate.assignments.values()],
    [...initial.assignments.values()],
    'unchanged post-goal roster preserves every transform',
  );
  const epochEight = nextEpoch.commit();
  assert.equal(epochEight.epoch, 8);
  assert.equal(epochEight.assignments, initial.assignments);

  const changedRoster = initialRoster
    .filter(({ sessionId }) => sessionId !== 'stable-orange-2')
    .concat({
      sessionId: 'replacement-orange',
      acceptedJoinOrdinal: 99,
      team: 'orange',
      name: 'Replacement',
      isHost: false,
    });
  const replacement = requirePrepared(assignmentService.prepare(changedRoster, 9));
  assert.equal(replacement.reusedAssignments, false);
  assert.equal(assignmentService.current, epochEight, 'candidate is not visible before commit');
  assert.equal(assignmentService.current?.assignments.has('stable-orange-2'), true);
  replacement.abort();
  assert.equal(assignmentService.current, epochEight, 'aborted replacement preserves prior map');

  const committedReplacement = requirePrepared(
    assignmentService.prepare(changedRoster, 9),
  ).commit();
  assert.equal(committedReplacement.assignments.has('stable-orange-2'), false);
  assert.equal(committedReplacement.assignments.has('replacement-orange'), true);
  assert.equal(assignmentService.current, committedReplacement);

  const repeatedService = service();
  const independentlyBuilt = requirePrepared(
    repeatedService.prepare([...changedRoster].reverse(), 9),
  ).commit();
  assert.deepEqual(
    [...independentlyBuilt.assignments],
    [...committedReplacement.assignments],
    'identical policy, table, roster identities, teams, and stable order are repeatable',
  );
});

// Validates: Requirements 5.11-5.12

test('a stale prepared replacement cannot overwrite a newer atomic commit', () => {
  const assignmentService = service();
  const initialRoster = rosterShape(2, 2, 'concurrent');
  requirePrepared(assignmentService.prepare(initialRoster, 1)).commit();

  const firstRoster = initialRoster
    .filter(({ sessionId }) => sessionId !== 'concurrent-orange-1')
    .concat({
      sessionId: 'first-replacement',
      acceptedJoinOrdinal: 20,
      team: 'orange',
      name: 'First replacement',
      isHost: false,
    });
  const secondRoster = initialRoster
    .filter(({ sessionId }) => sessionId !== 'concurrent-orange-1')
    .concat({
      sessionId: 'second-replacement',
      acceptedJoinOrdinal: 21,
      team: 'orange',
      name: 'Second replacement',
      isHost: false,
    });

  const first = requirePrepared(assignmentService.prepare(firstRoster, 2));
  const stale = requirePrepared(assignmentService.prepare(secondRoster, 2));
  const committed = first.commit();

  assert.throws(
    () => stale.commit(),
    (error: unknown) => error instanceof InvalidKickoffAssignmentError
      && error.code === 'stale-transaction',
  );
  assert.equal(assignmentService.current, committed);
  assert.equal(assignmentService.current?.assignments.has('first-replacement'), true);
  assert.equal(assignmentService.current?.assignments.has('second-replacement'), false);
});