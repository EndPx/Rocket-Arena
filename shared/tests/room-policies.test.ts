import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InvalidRoomPolicyError,
  ROOM_POLICIES,
  getRoomPolicy,
  isRoomPolicy,
  validateRoomPolicy,
} from '../src/config/room-policies.js';
import {
  FIXED_STEPS_PER_SECOND,
  MATCH,
  MATCH_RULES,
  MATCH_RULES_BY_MODE,
  getMatchRules,
} from '../src/constants/match.js';
import { NETCODE } from '../src/constants/netcode.js';

test('room modes map to exact independent 6/3 and 8/4 capacity policies', () => {
  assert.deepEqual(
    {
      mode: ROOM_POLICIES.quick.mode,
      total: ROOM_POLICIES.quick.totalCapacity,
      team: ROOM_POLICIES.quick.teamCapacity,
    },
    { mode: 'quick', total: 6, team: 3 },
  );
  assert.deepEqual(
    {
      mode: ROOM_POLICIES.custom.mode,
      total: ROOM_POLICIES.custom.totalCapacity,
      team: ROOM_POLICIES.custom.teamCapacity,
    },
    { mode: 'custom', total: 8, team: 4 },
  );
  assert.notStrictEqual(ROOM_POLICIES.quick, ROOM_POLICIES.custom);
  assert.strictEqual(getRoomPolicy('quick'), ROOM_POLICIES.quick);
  assert.strictEqual(getRoomPolicy('custom'), ROOM_POLICIES.custom);
});

test('canonical policies and their mode mapping are immutable', () => {
  assert.equal(Object.isFrozen(ROOM_POLICIES), true);
  assert.equal(Object.isFrozen(ROOM_POLICIES.quick), true);
  assert.equal(Object.isFrozen(ROOM_POLICIES.custom), true);

  assert.throws(() => {
    (ROOM_POLICIES.quick as unknown as { totalCapacity: number }).totalCapacity = 99;
  }, TypeError);
  assert.throws(() => {
    (ROOM_POLICIES as unknown as Record<string, unknown>).quick = ROOM_POLICIES.custom;
  }, TypeError);

  assert.equal(ROOM_POLICIES.quick.totalCapacity, 6);
  assert.equal(ROOM_POLICIES.custom.totalCapacity, 8);
});

test('policy validation accepts exact descriptors and rejects mismatches atomically', () => {
  const quickDescriptor = { ...ROOM_POLICIES.quick };
  assert.strictEqual(validateRoomPolicy(quickDescriptor), ROOM_POLICIES.quick);
  assert.equal(isRoomPolicy(quickDescriptor), true);

  const invalidPolicies: readonly unknown[] = [
    null,
    { ...ROOM_POLICIES.quick, totalCapacity: 8 },
    { ...ROOM_POLICIES.quick, teamCapacity: 4 },
    { ...ROOM_POLICIES.quick, startRule: 'host-request' },
    { ...ROOM_POLICIES.quick, allowWaitingTeamSwitch: true },
    { ...ROOM_POLICIES.custom, version: 2 },
    { ...ROOM_POLICIES.custom, assignmentTieBreak: 'orange' },
    { ...ROOM_POLICIES.custom, mode: 'ranked' },
    { ...ROOM_POLICIES.quick, clientCapacityOverride: 6 },
  ];

  for (const policy of invalidPolicies) {
    assert.throws(() => validateRoomPolicy(policy), InvalidRoomPolicyError);
    assert.equal(isRoomPolicy(policy), false);
  }
  assert.throws(() => getRoomPolicy('ranked'), InvalidRoomPolicyError);

  assert.equal(ROOM_POLICIES.quick.totalCapacity, 6);
  assert.equal(ROOM_POLICIES.quick.teamCapacity, 3);
  assert.equal(ROOM_POLICIES.custom.totalCapacity, 8);
  assert.equal(ROOM_POLICIES.custom.teamCapacity, 4);
});

test('Quick and Custom share the same confirmed 300/18000/6/2 ruleset', () => {
  assert.equal(MATCH_RULES.fixedStepsPerSecond, 60);
  assert.equal(MATCH_RULES.regulationDurationSeconds, 300);
  assert.equal(MATCH_RULES.regulationActivePlaySteps, 18_000);
  assert.equal(MATCH_RULES.kickoffCountdownSeconds, 3);
  assert.equal(MATCH_RULES.kickoffCountdownSteps, 180);
  assert.equal(MATCH_RULES.Regulation_Goal_Target, 6);
  assert.equal(MATCH_RULES.Regulation_Win_Margin, 2);
  assert.equal(
    MATCH_RULES.regulationActivePlaySteps,
    MATCH_RULES.regulationDurationSeconds * MATCH_RULES.fixedStepsPerSecond,
  );
  assert.equal(
    MATCH_RULES.kickoffCountdownSteps,
    MATCH_RULES.kickoffCountdownSeconds * MATCH_RULES.fixedStepsPerSecond,
  );

  assert.equal(Object.isFrozen(MATCH_RULES), true);
  assert.equal(Object.isFrozen(MATCH_RULES_BY_MODE), true);
  assert.strictEqual(MATCH_RULES_BY_MODE.quick, MATCH_RULES);
  assert.strictEqual(MATCH_RULES_BY_MODE.custom, MATCH_RULES);
  assert.strictEqual(getMatchRules('quick'), getMatchRules('custom'));
});

test('shared match rules contain no score cap or room capacity', () => {
  const ruleKeys = Object.keys(MATCH_RULES).map((key) => key.toLowerCase());
  assert.equal(ruleKeys.some((key) => key.includes('scorecap') || key.includes('score_cap')), false);
  assert.equal(ruleKeys.some((key) => key.includes('capacity') || key.includes('maxplayer')), false);

  for (const obsoleteField of [
    'MAX_PLAYERS',
    'TEAM_SIZE',
    'DURATION_SECONDS',
    'COUNTDOWN_SECONDS',
    'GOAL_RESET_DELAY',
  ]) {
    assert.equal(obsoleteField in MATCH, false, `${obsoleteField} must not remain in MATCH`);
  }
});

test('snapshot scheduling tolerance is finite, non-negative, and transport-specific', () => {
  assert.equal(NETCODE.SNAPSHOT_TARGET_INTERVAL_MS, 33);
  assert.equal(NETCODE.PATCH_RATE_MS, NETCODE.SNAPSHOT_TARGET_INTERVAL_MS);
  assert.equal(Number.isFinite(NETCODE.SNAPSHOT_SCHEDULING_TOLERANCE_MS), true);
  assert.ok(NETCODE.SNAPSHOT_SCHEDULING_TOLERANCE_MS >= 0);
  assert.notEqual(NETCODE.SNAPSHOT_TARGET_INTERVAL_MS, 1000 / FIXED_STEPS_PER_SECOND);
  assert.equal(Object.isFrozen(NETCODE), true);
});
