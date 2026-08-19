import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULTS_REGISTRY,
  clearOverrides,
  getConstant,
  getOverrides,
  setOverride,
} from '../src/constants/index.js';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  InvalidTuningRegistryError,
  SEEDED_TUNING_ENTRIES,
  VersionedTuningRegistry,
  getScalarTuningValue,
  validateTuningEntries,
} from '../src/tuning/registry.js';
import { evaluateReleaseGate } from '../src/tuning/release-gate.js';
import {
  TUNING_IDS,
  type ReferenceEvidenceRecord,
  type ScalarTuningEntry,
  type TuningApprovalRecord,
  type TuningEntry,
  type TuningProposal,
} from '../src/tuning/model.js';
import type { FeatureStatusRecord } from '../src/types/room.js';

test('seed registry classifies and ranges every required confirmed target and hypothesis', () => {
  const snapshot = DEFAULT_TUNING_REGISTRY_SNAPSHOT;
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.entries.length, SEEDED_TUNING_ENTRIES.length);
  assert.equal(validateTuningEntries(snapshot.entries, snapshot.version).length, 0);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.entries), true);

  const expectedScalars = [
    [TUNING_IDS.car.mass, 150, 'confirmed-starting-target'],
    [TUNING_IDS.car.boost.acceleration, 9.91666, 'confirmed-starting-target'],
    [TUNING_IDS.car.maxLinearSpeed, 23, 'confirmed-starting-target'],
    [TUNING_IDS.car.jump.firstVelocityChange, 2.91667, 'confirmed-starting-target'],
    [TUNING_IDS.ball.radius, 0.9125, 'confirmed-starting-target'],
    [TUNING_IDS.ball.mass, 25, 'confirmed-starting-target'],
    [TUNING_IDS.ball.restitution, 0.6, 'confirmed-starting-target'],
    [TUNING_IDS.car.collider.length, 1.18, 'unverified-hypothesis'],
    [TUNING_IDS.car.collider.width, 0.84, 'unverified-hypothesis'],
    [TUNING_IDS.car.collider.height, 0.36, 'unverified-hypothesis'],
    [TUNING_IDS.car.throttle.targetSpeed, 14.1, 'unverified-hypothesis'],
    [TUNING_IDS.ball.linearDamping, 0.1, 'unverified-hypothesis'],
    [TUNING_IDS.car.jump.secondJumpWindow, 1.25, 'unverified-hypothesis'],
    [TUNING_IDS.car.jump.flipActuationWindow, 0.65, 'unverified-hypothesis'],
    [TUNING_IDS.match.regulationGoalResetSeconds, 2, 'unverified-hypothesis'],
  ] as const;

  for (const [id, value, classification] of expectedScalars) {
    const entry = snapshot.get(id);
    assert.equal(entry?.kind, 'scalar', id);
    assert.equal(entry?.value, value, id);
    assert.equal(entry?.classification, classification, id);
    assert.ok(entry && entry.unit.length > 0, id);
  }

  const damping = snapshot.get(TUNING_IDS.ball.linearDamping);
  assert.equal(damping?.kind, 'scalar');
  if (damping?.kind === 'scalar') assert.deepEqual(damping.validatedRange, { min: 0, max: 0.2 });
  assert.equal(snapshot.get(TUNING_IDS.car.throttle.accelerationCurve)?.kind, 'curve');
  assert.equal(snapshot.get(TUNING_IDS.car.steering.curvatureCurve)?.kind, 'curve');
  assert.equal(snapshot.get(TUNING_IDS.support.contactPoints)?.kind, 'vector');
  assert.equal(TUNING_IDS.boostPads.largePositions.length, 6);
  for (const id of TUNING_IDS.boostPads.largePositions) assert.equal(snapshot.get(id)?.kind, 'vector');
  assert.ok(snapshot.unverifiedTuningIds.includes(TUNING_IDS.camera.spring.stiffness));
});

test('proposal rejection is all-or-nothing for non-finite, range, and unknown changes', () => {
  const registry = new VersionedTuningRegistry();
  const before = registry.snapshot;
  const beforeEntries = JSON.stringify(before.entries);
  const result = registry.propose({
    proposalId: 'atomic-rejection',
    expectedVersion: before.version,
    changes: [
      {
        id: TUNING_IDS.car.aerodynamicDragCoefficient,
        value: 0.2,
      },
      {
        id: TUNING_IDS.ball.linearDamping,
        value: Number.NaN,
      },
    ],
  });

  assert.equal(result.accepted, false);
  assert.ok(!result.accepted && result.issues.some(({ code }) => code === 'non-finite-value'));
  assert.equal(registry.snapshot.version, before.version);
  assert.equal(registry.snapshot.contentHash, before.contentHash);
  assert.equal(JSON.stringify(registry.snapshot.entries), beforeEntries);
  assert.equal(getScalarTuningValue(registry.snapshot, TUNING_IDS.car.aerodynamicDragCoefficient), 0.05);
  assert.equal(result.historyRecord.accepted, false);
  assert.equal(result.historyRecord.toVersion, null);

  const unknown = registry.propose({
    proposalId: 'unknown-entry',
    changes: [{ id: 'unknown.mechanic', value: 1 }],
  });
  assert.equal(unknown.accepted, false);
  assert.ok(!unknown.accepted && unknown.issues.some(({ code }) => code === 'unknown-entry'));
});

test('curve and cross-entry validation reject invalid relationships atomically', () => {
  const registry = new VersionedTuningRegistry();
  const badCurve = registry.propose({
    proposalId: 'bad-throttle-curve',
    changes: [{
      id: TUNING_IDS.car.throttle.accelerationCurve,
      value: {
        outputOrder: 'non-increasing',
        samples: [
          { input: 0, output: 8 },
          { input: 5, output: 9 },
          { input: 14.1, output: 1 },
        ],
      },
    }],
  });
  assert.equal(badCurve.accepted, false);
  assert.ok(!badCurve.accepted && badCurve.issues.some(({ code }) => (
    code === 'curve-output-order' || code === 'cross-entry-invariant'
  )));

  const grip = registry.propose({
    proposalId: 'bad-grip-order',
    changes: [{
      id: TUNING_IDS.car.steering.powerslideGripRate,
      value: 13,
    }],
  });
  assert.equal(grip.accepted, false);
  assert.ok(!grip.accepted && grip.issues.some(({ code }) => code === 'cross-entry-invariant'));

  const support = registry.propose({
    proposalId: 'support-outside-collider',
    changes: [{
      id: TUNING_IDS.support.contactPoints,
      value: [
        -0.7, -0.18, -0.45, 0.32, -0.18, -0.45,
        -0.32, -0.18, 0.45, 0.32, -0.18, 0.45,
      ],
      validatedRange: [
        { min: -1, max: 1 }, { min: -0.2, max: 0.2 }, { min: -0.6, max: 0.6 },
        { min: -1, max: 1 }, { min: -0.2, max: 0.2 }, { min: -0.6, max: 0.6 },
        { min: -1, max: 1 }, { min: -0.2, max: 0.2 }, { min: -0.6, max: 0.6 },
        { min: -1, max: 1 }, { min: -0.2, max: 0.2 }, { min: -0.6, max: 0.6 },
      ],
    }],
  });
  assert.equal(support.accepted, false);
  assert.ok(!support.accepted && support.issues.some(({ code }) => code === 'cross-entry-invariant'));
});

test('accepted proposals create immutable versions, room pins, and traceable before/after history', () => {
  const registry = new VersionedTuningRegistry();
  const pinnedBefore = registry.pinForRoom('room-a');
  const previous = registry.snapshot.get(TUNING_IDS.ball.linearDamping);
  const result = registry.propose({
    proposalId: 'evidence-backed-damping',
    expectedVersion: 1,
    changes: [{
      id: TUNING_IDS.ball.linearDamping,
      value: 0.12,
      evidenceId: 'evidence-ball-damping',
      approvalId: 'approval-ball-damping',
      verificationStatus: 'verified',
    }],
  });

  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.snapshot.version, 2);
  assert.equal(getScalarTuningValue(result.snapshot, TUNING_IDS.ball.linearDamping), 0.12);
  assert.equal(result.snapshot.get(TUNING_IDS.ball.linearDamping)?.registryVersion, 2);
  assert.equal(result.snapshot.unverifiedTuningIds.includes(TUNING_IDS.ball.linearDamping), false);
  assert.equal(result.historyRecord.changes.length, 1);
  assert.deepEqual(result.historyRecord.changes[0]?.before, previous);
  assert.equal(result.historyRecord.changes[0]?.after.evidenceId, 'evidence-ball-damping');
  assert.equal(pinnedBefore.version, 1);
  assert.equal(getScalarTuningValue(pinnedBefore, TUNING_IDS.ball.linearDamping), 0.1);
  assert.notEqual(pinnedBefore.contentHash, result.snapshot.contentHash);
  assert.match(pinnedBefore.snapshotId, /^rocket-arena-mechanics@1:/);

  assert.throws(() => {
    (result.snapshot.get(TUNING_IDS.ball.linearDamping) as unknown as { value: number }).value = 99;
  }, TypeError);
  assert.throws(() => {
    (result.historyRecord.changes as TuningEntry[]).push(previous!);
  }, TypeError);
});

test('invalid initial registries are rejected before publication', () => {
  const malformed = SEEDED_TUNING_ENTRIES.map((entry) => (
    entry.id === TUNING_IDS.car.collider.length
      ? { ...entry, classification: 'guess' }
      : entry
  )) as unknown as readonly TuningEntry[];
  assert.throws(
    () => new VersionedTuningRegistry({ entries: malformed }),
    InvalidTuningRegistryError,
  );
});

test('release gate fails without evidence or approval and passes one fully evidenced hypothesis', () => {
  const source = DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(TUNING_IDS.ball.linearDamping);
  if (source?.kind !== 'scalar') throw new Error('Expected scalar ball damping seed.');
  const verifiedEntry = {
    ...source,
    registryVersion: 1,
    verificationStatus: 'verified',
    evidenceId: 'evidence-1',
    approvalId: 'approval-1',
  } as ScalarTuningEntry;
  const registry = new VersionedTuningRegistry({
    registryId: 'release-fixture',
    entries: [verifiedEntry],
  });
  const status: FeatureStatusRecord = {
    statusVersion: 1,
    registryVersion: 1,
    buildKind: 'mechanics-fidelity-release',
    delivered: ['ball-damping'],
    deferred: [],
    unverifiedTuningIds: [],
  };

  const missing = evaluateReleaseGate({
    snapshot: registry.snapshot,
    evidence: [],
    approvals: [],
    featureStatus: status,
  });
  assert.equal(missing.eligible, false);
  assert.ok(missing.issues.some(({ code }) => code === 'missing-evidence'));
  assert.ok(missing.issues.some(({ code }) => code === 'missing-approval'));

  const evidence: ReferenceEvidenceRecord = {
    id: 'evidence-1',
    tuningId: TUNING_IDS.ball.linearDamping,
    registryVersion: 1,
    sourceIdentity: 'authoritative-reference',
    sourceVersionOrAccessDate: 'v1',
    originalValueAndUnit: '0.1 s^-1',
    conversion: 'identity',
    resultingValueAndRange: '0.1 [0,0.2] s^-1',
    approvalStatus: 'approved',
  };
  const approval: TuningApprovalRecord = {
    id: 'approval-1',
    tuningId: TUNING_IDS.ball.linearDamping,
    registryVersion: 1,
    deterministicHarnessEvidence: ['rapier://ball-damping-seed-1'],
    browserEvidence: ['browser://ball-motion-review-1'],
    approvedBy: 'mechanics-reviewer',
    approvedAt: '2025-01-01T00:00:00.000Z',
  };
  const passed = evaluateReleaseGate({
    snapshot: registry.snapshot,
    evidence: [evidence],
    approvals: [approval],
    featureStatus: status,
  });
  assert.equal(passed.eligible, true);
  assert.deepEqual(passed.issues, []);

  const incompleteEvidence = evaluateReleaseGate({
    snapshot: registry.snapshot,
    evidence: [{ ...evidence, sourceIdentity: '' }],
    approvals: [approval],
    featureStatus: status,
  });
  assert.equal(incompleteEvidence.eligible, false);
  assert.ok(incompleteEvidence.issues.some(({ code }) => code === 'invalid-evidence-record'));

  const incompleteApproval = evaluateReleaseGate({
    snapshot: registry.snapshot,
    evidence: [evidence],
    approvals: [{ ...approval, approvedBy: '' }],
    featureStatus: status,
  });
  assert.equal(incompleteApproval.eligible, false);
  assert.ok(incompleteApproval.issues.some(({ code }) => code === 'invalid-approval-record'));

  const malformedEvidence = evaluateReleaseGate({
    snapshot: registry.snapshot,
    evidence: [null] as unknown as readonly ReferenceEvidenceRecord[],
    approvals: [approval],
    featureStatus: status,
  });
  assert.equal(malformedEvidence.eligible, false);
  assert.ok(malformedEvidence.issues.some(({ code }) => code === 'invalid-evidence-record'));

  const malformedApproval = evaluateReleaseGate({
    snapshot: registry.snapshot,
    evidence: [evidence],
    approvals: [null] as unknown as readonly TuningApprovalRecord[],
    featureStatus: status,
  });
  assert.equal(malformedApproval.eligible, false);
  assert.ok(malformedApproval.issues.some(({ code }) => code === 'invalid-approval-record'));

  const staging = evaluateReleaseGate({
    snapshot: registry.snapshot,
    evidence: [evidence],
    approvals: [approval],
    featureStatus: { ...status, buildKind: 'hackathon-staging' },
  });
  assert.equal(staging.eligible, false);
  assert.ok(staging.issues.some(({ code }) => code === 'staging-build'));
});

test('legacy numeric reads remain available while global mechanics overrides are blocked', () => {
  clearOverrides();
  assert.equal(DEFAULTS_REGISTRY.get('AUDIO.ENGINE.IDLE_FREQUENCY_HZ'), 48);
  assert.equal(getConstant('PHYSICS.TIMESTEP'), 1 / 60);
  assert.throws(() => setOverride('CAR.ENGINE.MAX_SPEED', 999), /VersionedTuningRegistry/);
  assert.throws(() => setOverride('AUDIO.ENGINE.IDLE_FREQUENCY_HZ', Number.NaN), /finite/);

  const visualPath = 'VISUAL.RENDER.EXPOSURE';
  const original = getConstant(visualPath);
  setOverride(visualPath, original + 0.1);
  assert.equal(getConstant(visualPath), original + 0.1);
  assert.equal(getOverrides().get(visualPath), original + 0.1);
  clearOverrides();
  assert.equal(getConstant(visualPath), original);
});

test('proposal schema rejects immutable and unknown metadata atomically', () => {
  const registry = new VersionedTuningRegistry();
  const before = registry.snapshot;
  const beforeEntries = JSON.stringify(before.entries);
  const attempts: readonly (readonly [string, Record<string, unknown>])[] = [
    ['classification', { classification: 'confirmed-starting-target', verificationStatus: 'confirmed' }],
    ['unit', { unit: 'untrusted-unit' }],
    ['affects', { affects: ['camera'] }],
    ['kind', { kind: 'vector' }],
    ['registry-version', { registryVersion: 999 }],
    ['unknown', { releaseEligible: true }],
  ];

  for (const [name, patch] of attempts) {
    const result = registry.propose({
      proposalId: `immutable-${name}`,
      expectedVersion: before.version,
      changes: [{ id: TUNING_IDS.ball.linearDamping, ...patch }],
    } as unknown as TuningProposal);

    assert.equal(result.accepted, false, name);
    assert.ok(!result.accepted && result.issues.some(({ code }) => code === 'invalid-patch-field'));
    assert.equal(registry.snapshot.version, before.version);
    assert.equal(registry.snapshot.contentHash, before.contentHash);
    assert.equal(JSON.stringify(registry.snapshot.entries), beforeEntries);
  }
});