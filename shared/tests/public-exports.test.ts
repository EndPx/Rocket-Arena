import assert from 'node:assert/strict';
import test from 'node:test';
import * as shared from '@rocket-arena/shared';
import * as config from '@rocket-arena/shared/config';
import * as constants from '@rocket-arena/shared/constants';
import * as geometry from '@rocket-arena/shared/geometry';
import * as schema from '@rocket-arena/shared/schema';
import * as tuning from '@rocket-arena/shared/tuning';
import * as types from '@rocket-arena/shared/types';

test('package root exposes every foundational shared contract', () => {
  assert.strictEqual(shared.ROOM_POLICIES, config.ROOM_POLICIES);
  assert.strictEqual(shared.MATCH_RULES, constants.MATCH_RULES);
  assert.strictEqual(shared.ARENA_GEOMETRY_SPEC, geometry.ARENA_GEOMETRY_SPEC);
  assert.strictEqual(shared.GameState, schema.GameState);
  assert.strictEqual(shared.GoalResultState, schema.GoalResultState);
  assert.strictEqual(shared.TerminalResultState, schema.TerminalResultState);
  assert.strictEqual(shared.MatchTransitionState, schema.MatchTransitionState);
  assert.strictEqual(
    shared.DEFAULT_TUNING_REGISTRY_SNAPSHOT,
    tuning.DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  );
  assert.strictEqual(shared.VersionedTuningRegistry, tuning.VersionedTuningRegistry);
  assert.strictEqual(shared.evaluateReleaseGate, tuning.evaluateReleaseGate);
  assert.strictEqual(shared.normalizeInputCommandV2, types.normalizeInputCommandV2);
  assert.strictEqual(shared.parseSnapshotEnvelopeV2, types.parseSnapshotEnvelopeV2);
  assert.strictEqual(shared.createGoalResult, types.createGoalResult);
  assert.strictEqual(shared.createTerminalResult, types.createTerminalResult);
  assert.strictEqual(shared.MATCH_TRANSITION_KINDS, types.MATCH_TRANSITION_KINDS);
});

test('public match exports preserve the confirmed shared rules', () => {
  assert.equal(shared.REGULATION_DURATION_SECONDS, 300);
  assert.equal(shared.REGULATION_ACTIVE_PLAY_STEPS, 18_000);
  assert.equal(shared.KICKOFF_COUNTDOWN_SECONDS, 3);
  assert.equal(shared.KICKOFF_COUNTDOWN_STEPS, 180);
  assert.equal(shared.Regulation_Goal_Target, 6);
  assert.equal(shared.Regulation_Win_Margin, 2);
  assert.strictEqual(shared.MATCH_RULES_BY_MODE.quick, shared.MATCH_RULES);
  assert.strictEqual(shared.MATCH_RULES_BY_MODE.custom, shared.MATCH_RULES);
});

test('package root preserves baseline presentation and audio exports', () => {
  const baselineExports = [
    'CAR',
    'BALL',
    'ARENA',
    'CAMERA',
    'VISUAL',
    'AUDIO',
    'NETCODE',
    'DEFAULTS_REGISTRY',
  ] as const;

  for (const exportName of baselineExports) {
    assert.notEqual(shared[exportName], undefined, `${exportName} must remain public`);
    assert.strictEqual(shared[exportName], constants[exportName]);
  }
});
