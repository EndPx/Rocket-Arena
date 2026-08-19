import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SEEDED_TUNING_ENTRIES,
  VersionedTuningRegistry,
} from '../src/tuning/registry.js';
import { evaluateReleaseGate } from '../src/tuning/release-gate.js';
import {
  TUNING_IDS,
  type RoomPinnedTuningSnapshot,
  type StructuredCurve,
  type TuningEntry,
  type TuningEntryPatch,
  type TuningProposal,
  type TuningRegistrySnapshot,
  type TuningValidationCode,
} from '../src/tuning/model.js';
import type { FeatureStatusRecord } from '../src/types/room.js';
import {
  assertGeneratedCases,
  generateCases,
  replayCase,
  type SeededRandom,
} from './support/generated-cases.js';

const RECORDED_SEED = 'rocket-arena-property-20-v2';
const ORDERED_CASE_COUNT = 100;

const RANGE_SHAPES = ['scalar', 'vector', 'curve'] as const;
type RangeShape = typeof RANGE_SHAPES[number];

const INVALID_SHAPES = [
  'scalar-non-finite',
  'scalar-range-order',
  'vector-sparse',
  'vector-non-finite',
  'vector-range-order',
  'curve-empty',
  'curve-non-finite',
  'curve-input-order',
  'curve-output-order',
  'curve-range-order',
] as const;
type InvalidShape = typeof INVALID_SHAPES[number];

interface GeneratedInvalidChange {
  readonly shape: InvalidShape;
  readonly patch: TuningEntryPatch;
  readonly expectedCode: TuningValidationCode;
  readonly expectedEntryId: string;
  readonly validCompanionValue: number;
}

interface GeneratedRangeUpdate {
  readonly shape: RangeShape;
  readonly patch: TuningEntryPatch;
}

interface GeneratedLifecycle {
  readonly ordinal: number;
  readonly scalarValue: number;
  readonly vectorValue: readonly [number, number, number];
  readonly curveValue: StructuredCurve;
  readonly rangeUpdate: GeneratedRangeUpdate;
  readonly invalidChange: GeneratedInvalidChange;
  readonly finalResetSeconds: number;
  readonly confirmedPatch: TuningEntryPatch;
}

function valueDifferentFrom(value: number, disallowed: number, replacement: number): number {
  return value === disallowed ? replacement : value;
}

function verifiedTrace(prefix: string, index: number) {
  return {
    evidenceId: `evidence-${prefix}-${index}`,
    approvalId: `approval-${prefix}-${index}`,
    verificationStatus: 'verified' as const,
  };
}

function generateRangeUpdate(
  random: SeededRandom,
  index: number,
): GeneratedRangeUpdate {
  const shape = RANGE_SHAPES[index % RANGE_SHAPES.length]!;
  switch (shape) {
    case 'scalar':
      return {
        shape,
        patch: {
          id: TUNING_IDS.camera.ball.fieldOfViewDegrees,
          validatedRange: {
            min: random.integer(45, 60),
            max: random.integer(70, 95),
          },
        },
      };
    case 'vector':
      return {
        shape,
        patch: {
          id: TUNING_IDS.boostPads.largeSensorHalfExtents,
          validatedRange: [
            { min: 0.05, max: 2.25 },
            { min: 0.05, max: 1.25 },
            { min: 0.05, max: 2.25 },
          ],
        },
      };
    case 'curve':
      return {
        shape,
        patch: {
          id: TUNING_IDS.car.steering.curvatureCurve,
          validatedRange: {
            input: { min: 0, max: 23 },
            output: { min: 0, max: 0.4 },
          },
        },
      };
  }
}

function generateInvalidChange(
  random: SeededRandom,
  index: number,
): GeneratedInvalidChange {
  const shape = INVALID_SHAPES[index % INVALID_SHAPES.length]!;
  const validCompanionValue = random.integer(20, 150) / 100;

  switch (shape) {
    case 'scalar-non-finite':
      return {
        shape,
        patch: { id: TUNING_IDS.ball.linearDamping, value: Number.NaN },
        expectedCode: 'non-finite-value',
        expectedEntryId: TUNING_IDS.ball.linearDamping,
        validCompanionValue,
      };
    case 'scalar-range-order':
      return {
        shape,
        patch: {
          id: TUNING_IDS.ball.linearDamping,
          validatedRange: { min: 0.15, max: 0.05 },
        },
        expectedCode: 'range-order',
        expectedEntryId: TUNING_IDS.ball.linearDamping,
        validCompanionValue,
      };
    case 'vector-sparse': {
      const sparseValue = Array<number>(3);
      sparseValue[0] = random.integer(20, 120) / 100;
      sparseValue[2] = random.integer(20, 120) / 100;
      return {
        shape,
        patch: {
          id: TUNING_IDS.boostPads.largeSensorHalfExtents,
          value: sparseValue,
        },
        expectedCode: 'non-finite-value',
        expectedEntryId: TUNING_IDS.boostPads.largeSensorHalfExtents,
        validCompanionValue,
      };
    }
    case 'vector-non-finite':
      return {
        shape,
        patch: {
          id: TUNING_IDS.boostPads.largeSensorHalfExtents,
          value: [0.75, Number.POSITIVE_INFINITY, 0.75],
        },
        expectedCode: 'non-finite-value',
        expectedEntryId: TUNING_IDS.boostPads.largeSensorHalfExtents,
        validCompanionValue,
      };
    case 'vector-range-order':
      return {
        shape,
        patch: {
          id: TUNING_IDS.boostPads.largeSensorHalfExtents,
          validatedRange: [
            { min: 2, max: 1 },
            { min: 0.05, max: 1.25 },
            { min: 0.05, max: 2.25 },
          ],
        },
        expectedCode: 'range-order',
        expectedEntryId: TUNING_IDS.boostPads.largeSensorHalfExtents,
        validCompanionValue,
      };
    case 'curve-empty':
      return {
        shape,
        patch: {
          id: TUNING_IDS.car.steering.curvatureCurve,
          value: {
            outputOrder: 'non-increasing',
            samples: [{ input: 0, output: 0.2 }],
          },
        },
        expectedCode: 'curve-empty',
        expectedEntryId: TUNING_IDS.car.steering.curvatureCurve,
        validCompanionValue,
      };
    case 'curve-non-finite':
      return {
        shape,
        patch: {
          id: TUNING_IDS.car.steering.curvatureCurve,
          value: {
            outputOrder: 'non-increasing',
            samples: [
              { input: 0, output: 0.2 },
              { input: 10, output: Number.NaN },
              { input: 23, output: 0.02 },
            ],
          },
        },
        expectedCode: 'non-finite-value',
        expectedEntryId: TUNING_IDS.car.steering.curvatureCurve,
        validCompanionValue,
      };
    case 'curve-input-order':
      return {
        shape,
        patch: {
          id: TUNING_IDS.car.steering.curvatureCurve,
          value: {
            outputOrder: 'non-increasing',
            samples: [
              { input: 0, output: 0.2 },
              { input: 10, output: 0.1 },
              { input: 10, output: 0.05 },
            ],
          },
        },
        expectedCode: 'curve-input-order',
        expectedEntryId: TUNING_IDS.car.steering.curvatureCurve,
        validCompanionValue,
      };
    case 'curve-output-order':
      return {
        shape,
        patch: {
          id: TUNING_IDS.car.steering.curvatureCurve,
          value: {
            outputOrder: 'non-increasing',
            samples: [
              { input: 0, output: 0.2 },
              { input: 10, output: 0.25 },
              { input: 23, output: 0.02 },
            ],
          },
        },
        expectedCode: 'curve-output-order',
        expectedEntryId: TUNING_IDS.car.steering.curvatureCurve,
        validCompanionValue,
      };
    case 'curve-range-order':
      return {
        shape,
        patch: {
          id: TUNING_IDS.car.steering.curvatureCurve,
          validatedRange: {
            input: { min: 0, max: 23 },
            output: { min: 0.4, max: 0.1 },
          },
        },
        expectedCode: 'range-order',
        expectedEntryId: TUNING_IDS.car.steering.curvatureCurve,
        validCompanionValue,
      };
  }
}

function generateLifecycle(random: SeededRandom, index: number): GeneratedLifecycle {
  const scalarValue = valueDifferentFrom(
    random.integer(10, 190) / 1000,
    0.1,
    0.101,
  );
  const vectorValue = [
    random.integer(20, 120) / 100,
    random.integer(10, 25) / 100,
    random.integer(20, 120) / 100,
  ] as const;
  const curveHigh = random.integer(260, 340) / 1000;
  const curveValue: StructuredCurve = {
    outputOrder: 'non-increasing',
    samples: [
      { input: 0, output: curveHigh },
      { input: 7, output: curveHigh - 0.06 },
      { input: 15, output: curveHigh - 0.14 },
      { input: 23, output: 0.03 },
    ],
  };
  const finalResetSeconds = valueDifferentFrom(
    random.integer(75, 375) / 100,
    2,
    2.01,
  );
  const confirmedPatch: TuningEntryPatch = index % 2 === 0
    ? (() => {
      const value = random.integer(151, 180);
      return {
        id: TUNING_IDS.car.mass,
        value,
        validatedRange: { min: value, max: value },
      };
    })()
    : {
      id: TUNING_IDS.car.mass,
      validatedRange: {
        min: random.integer(140, 149),
        max: random.integer(151, 160),
      },
    };

  return {
    ordinal: index,
    scalarValue,
    vectorValue,
    curveValue,
    rangeUpdate: generateRangeUpdate(random, index),
    invalidChange: generateInvalidChange(random, index),
    finalResetSeconds,
    confirmedPatch,
  };
}

function mechanicsFingerprint(snapshot: TuningRegistrySnapshot): string {
  return JSON.stringify({
    version: snapshot.version,
    contentHash: snapshot.contentHash,
    entries: snapshot.entries,
    unverifiedTuningIds: snapshot.unverifiedTuningIds,
  });
}

function pinFingerprint(pin: RoomPinnedTuningSnapshot): string {
  return JSON.stringify({
    registryId: pin.registryId,
    roomId: pin.roomId,
    snapshotId: pin.snapshotId,
    version: pin.version,
    contentHash: pin.contentHash,
    entries: pin.entries,
    history: pin.history,
    unverifiedTuningIds: pin.unverifiedTuningIds,
  });
}

function assertEntryDeeplyFrozen(entry: TuningEntry | undefined): void {
  assert.ok(entry);
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(Object.isFrozen(entry.validatedRange), true);

  if (entry.kind === 'vector') {
    assert.equal(Object.isFrozen(entry.value), true);
    for (const range of entry.validatedRange) assert.equal(Object.isFrozen(range), true);
  } else if (entry.kind === 'curve') {
    assert.equal(Object.isFrozen(entry.value), true);
    assert.equal(Object.isFrozen(entry.value.samples), true);
    for (const sample of entry.value.samples) assert.equal(Object.isFrozen(sample), true);
    assert.equal(Object.isFrozen(entry.validatedRange.input), true);
    assert.equal(Object.isFrozen(entry.validatedRange.output), true);
  }
}

function applyAcceptedProposal(
  registry: VersionedTuningRegistry,
  proposalId: string,
  changes: readonly TuningEntryPatch[],
): TuningRegistrySnapshot {
  const before = registry.snapshot;
  const result = registry.propose({
    proposalId,
    expectedVersion: before.version,
    changes,
  });

  assert.equal(result.accepted, true, proposalId);
  if (!result.accepted) throw new Error(`Expected accepted proposal ${proposalId}.`);

  assert.strictEqual(registry.snapshot, result.snapshot);
  assert.equal(result.snapshot.version, before.version + 1);
  assert.notEqual(result.snapshot.contentHash, before.contentHash);
  assert.equal(result.snapshot.history.length, before.history.length + 1);
  assert.deepEqual(result.snapshot.history.slice(0, -1), before.history);
  assert.deepEqual(
    result.snapshot.history[result.snapshot.history.length - 1],
    result.historyRecord,
  );
  assert.equal(result.historyRecord.sequence, before.history.length + 1);
  assert.equal(result.historyRecord.proposalId, proposalId);
  assert.equal(result.historyRecord.accepted, true);
  assert.equal(result.historyRecord.fromVersion, before.version);
  assert.equal(result.historyRecord.toVersion, before.version + 1);
  assert.deepEqual(result.historyRecord.issues, []);
  assert.deepEqual(
    result.historyRecord.changes.map(({ id }) => id),
    changes.map(({ id }) => id),
  );
  assert.equal(Object.isFrozen(result.historyRecord), true);
  assert.equal(Object.isFrozen(result.historyRecord.changes), true);

  for (const change of result.historyRecord.changes) {
    assert.deepEqual(change.before, before.get(change.id));
    assert.deepEqual(change.after, result.snapshot.get(change.id));
    assert.equal(change.after.registryVersion, before.version + 1);
    assertEntryDeeplyFrozen(change.before);
    assertEntryDeeplyFrozen(change.after);
  }

  assert.deepEqual(
    result.snapshot.get(TUNING_IDS.physics.gravityY),
    before.get(TUNING_IDS.physics.gravityY),
  );
  return result.snapshot;
}

function applyRejectedProposal(
  registry: VersionedTuningRegistry,
  proposal: TuningProposal,
  expectedCode: TuningValidationCode,
  expectedEntryId: string,
): void {
  const before = registry.snapshot;
  const beforeMechanics = mechanicsFingerprint(before);
  const companionBefore = before.get(TUNING_IDS.car.aerodynamicDragCoefficient);
  const result = registry.propose(proposal);

  assert.equal(result.accepted, false, proposal.proposalId);
  if (result.accepted) throw new Error(`Expected rejected proposal ${proposal.proposalId}.`);

  assert.equal(mechanicsFingerprint(result.snapshot), beforeMechanics);
  assert.equal(result.snapshot.version, before.version);
  assert.equal(result.snapshot.contentHash, before.contentHash);
  assert.deepEqual(result.snapshot.entries, before.entries);
  assert.deepEqual(result.snapshot.unverifiedTuningIds, before.unverifiedTuningIds);
  assert.deepEqual(
    result.snapshot.get(TUNING_IDS.car.aerodynamicDragCoefficient),
    companionBefore,
  );
  assert.equal(result.snapshot.history.length, before.history.length + 1);
  assert.deepEqual(result.snapshot.history.slice(0, -1), before.history);
  assert.equal(result.historyRecord.sequence, before.history.length + 1);
  assert.equal(result.historyRecord.proposalId, proposal.proposalId);
  assert.equal(result.historyRecord.accepted, false);
  assert.equal(result.historyRecord.fromVersion, before.version);
  assert.equal(result.historyRecord.toVersion, null);
  assert.deepEqual(result.historyRecord.changes, []);
  assert.deepEqual(result.issues, result.historyRecord.issues);
  assert.ok(result.issues.length > 0);
  assert.ok(result.issues.every(({ message }) => message.length > 0));
  assert.ok(result.issues.some(({ code, entryId }) => (
    code === expectedCode && entryId === expectedEntryId
  )));
  assert.equal(Object.isFrozen(result.historyRecord), true);
  assert.equal(Object.isFrozen(result.issues), true);
}

function assertPinIsImmutable(pin: RoomPinnedTuningSnapshot): void {
  assert.equal(Object.isFrozen(pin), true);
  assert.equal(Object.isFrozen(pin.entries), true);
  assert.equal(Object.isFrozen(pin.history), true);

  const vector = pin.get(TUNING_IDS.boostPads.largeSensorHalfExtents);
  assert.equal(vector?.kind, 'vector');
  if (vector?.kind !== 'vector') throw new Error('Expected pinned vector tuning entry.');
  assert.equal(Object.isFrozen(vector.value), true);
  assert.throws(() => {
    (vector.value as unknown as number[])[0] = 999;
  }, TypeError);
  assert.throws(() => {
    (pin.history as unknown as unknown[]).push({});
  }, TypeError);
}

function assertConfirmedTargetReleaseBlocked(
  lifecycle: GeneratedLifecycle,
  caseIndex: number,
): string {
  const confirmedSeed = SEEDED_TUNING_ENTRIES.find(({ id }) => id === TUNING_IDS.car.mass);
  assert.equal(confirmedSeed?.kind, 'scalar');
  if (confirmedSeed?.kind !== 'scalar') throw new Error('Expected confirmed car mass seed.');

  const registry = new VersionedTuningRegistry({
    registryId: `confirmed-release-fixture-${caseIndex}`,
    entries: [confirmedSeed],
  });
  const snapshot = applyAcceptedProposal(
    registry,
    `confirmed-change-${caseIndex}`,
    [lifecycle.confirmedPatch],
  );
  const featureStatus: FeatureStatusRecord = {
    statusVersion: 1,
    registryVersion: snapshot.version,
    buildKind: 'mechanics-fidelity-release',
    delivered: ['generated-confirmed-target-change'],
    deferred: [],
    unverifiedTuningIds: [],
  };
  const gate = evaluateReleaseGate({
    snapshot,
    evidence: [],
    approvals: [],
    featureStatus,
  });

  assert.equal(gate.eligible, false);
  assert.deepEqual(
    gate.issues.map(({ code }) => code).sort(),
    ['confirmed-change-without-evidence', 'confirmed-change-without-rationale'],
  );
  assert.ok(gate.issues.every(({ tuningId }) => tuningId === TUNING_IDS.car.mass));
  return JSON.stringify(gate);
}

/**
 * Feature: rocket-arena, Property 20: Tuning proposal atomicity and traceability
 * **Validates: Requirements 17.1-17.16**
 */
test('Property 20: generated tuning lifecycles are atomic, traceable, and reproducible', () => {
  const cases = generateCases({
    seed: RECORDED_SEED,
    count: ORDERED_CASE_COUNT,
    generate: generateLifecycle,
  });
  const repeatedCases = generateCases({
    seed: RECORDED_SEED,
    count: ORDERED_CASE_COUNT,
    generate: generateLifecycle,
  });

  assert.equal(cases.length, 100);
  assert.deepEqual(cases, repeatedCases);
  for (const index of [0, 37, 73, 99]) {
    assert.deepEqual(replayCase(RECORDED_SEED, index, generateLifecycle), cases[index]);
  }
  assert.deepEqual(
    RANGE_SHAPES.map((shape) => cases.filter(({ value }) => value.rangeUpdate.shape === shape).length),
    [34, 33, 33],
  );
  assert.deepEqual(
    INVALID_SHAPES.map((shape) => cases.filter(({ value }) => value.invalidChange.shape === shape).length),
    Array.from({ length: INVALID_SHAPES.length }, () => 10),
  );
  assert.equal(cases.filter(({ value }) => value.ordinal % 2 === 0).length, 50);
  assert.equal(cases.filter(({ value }) => value.ordinal % 2 === 1).length, 50);

  const executeGeneratedLifecycle = (
    lifecycle: GeneratedLifecycle,
    generatedCase: (typeof cases)[number],
    resultTraces: string[],
  ): void => {
    assert.equal(lifecycle.ordinal, generatedCase.index);
    const registry = new VersionedTuningRegistry();
    const roomId = `property-20-room-${generatedCase.index}`;
    const initialPin = registry.pinForRoom(roomId);
    const initialPinFingerprint = pinFingerprint(initialPin);
    assertPinIsImmutable(initialPin);

    const scalarSnapshot = applyAcceptedProposal(
      registry,
      `scalar-${generatedCase.index}`,
      [{
        id: TUNING_IDS.ball.linearDamping,
        value: lifecycle.scalarValue,
        ...verifiedTrace('scalar', generatedCase.index),
      }],
    );
    assert.equal(scalarSnapshot.get(TUNING_IDS.ball.linearDamping)?.value, lifecycle.scalarValue);
    const scalarPin = registry.pinForRoom(roomId);
    const scalarPinFingerprint = pinFingerprint(scalarPin);

    const vectorSnapshot = applyAcceptedProposal(
      registry,
      `vector-${generatedCase.index}`,
      [{
        id: TUNING_IDS.boostPads.largeSensorHalfExtents,
        value: lifecycle.vectorValue,
        ...verifiedTrace('vector', generatedCase.index),
      }],
    );
    assert.deepEqual(
      vectorSnapshot.get(TUNING_IDS.boostPads.largeSensorHalfExtents)?.value,
      lifecycle.vectorValue,
    );

    const curveSnapshot = applyAcceptedProposal(
      registry,
      `curve-${generatedCase.index}`,
      [{
        id: TUNING_IDS.car.steering.curvatureCurve,
        value: lifecycle.curveValue,
        ...verifiedTrace('curve', generatedCase.index),
      }],
    );
    assert.deepEqual(
      curveSnapshot.get(TUNING_IDS.car.steering.curvatureCurve)?.value,
      lifecycle.curveValue,
    );

    const rangeSnapshot = applyAcceptedProposal(
      registry,
      `range-${lifecycle.rangeUpdate.shape}-${generatedCase.index}`,
      [{
        ...lifecycle.rangeUpdate.patch,
        ...verifiedTrace(`range-${lifecycle.rangeUpdate.shape}`, generatedCase.index),
      }],
    );
    assert.deepEqual(
      rangeSnapshot.get(lifecycle.rangeUpdate.patch.id)?.validatedRange,
      lifecycle.rangeUpdate.patch.validatedRange,
    );
    const preRejectionPin = registry.pinForRoom(roomId);
    const preRejectionPinFingerprint = pinFingerprint(preRejectionPin);

    applyRejectedProposal(
      registry,
      {
        proposalId: `invalid-${lifecycle.invalidChange.shape}-${generatedCase.index}`,
        expectedVersion: registry.snapshot.version,
        changes: [
          {
            id: TUNING_IDS.car.aerodynamicDragCoefficient,
            value: lifecycle.invalidChange.validCompanionValue,
          },
          lifecycle.invalidChange.patch,
        ],
      },
      lifecycle.invalidChange.expectedCode,
      lifecycle.invalidChange.expectedEntryId,
    );

    const finalSnapshot = applyAcceptedProposal(
      registry,
      `post-rejection-${generatedCase.index}`,
      [{
        id: TUNING_IDS.match.regulationGoalResetSeconds,
        value: lifecycle.finalResetSeconds,
        ...verifiedTrace('post-rejection', generatedCase.index),
      }],
    );
    assert.equal(
      finalSnapshot.get(TUNING_IDS.match.regulationGoalResetSeconds)?.value,
      lifecycle.finalResetSeconds,
    );
    assert.equal(finalSnapshot.version, 6);
    assert.deepEqual(
      finalSnapshot.history.map(({ sequence, accepted, fromVersion, toVersion }) => ({
        sequence,
        accepted,
        fromVersion,
        toVersion,
      })),
      [
        { sequence: 1, accepted: true, fromVersion: 1, toVersion: 2 },
        { sequence: 2, accepted: true, fromVersion: 2, toVersion: 3 },
        { sequence: 3, accepted: true, fromVersion: 3, toVersion: 4 },
        { sequence: 4, accepted: true, fromVersion: 4, toVersion: 5 },
        { sequence: 5, accepted: false, fromVersion: 5, toVersion: null },
        { sequence: 6, accepted: true, fromVersion: 5, toVersion: 6 },
      ],
    );

    assert.equal(pinFingerprint(initialPin), initialPinFingerprint);
    assert.equal(pinFingerprint(scalarPin), scalarPinFingerprint);
    assert.equal(pinFingerprint(preRejectionPin), preRejectionPinFingerprint);
    assert.equal(initialPin.version, 1);
    assert.equal(scalarPin.version, 2);
    assert.equal(preRejectionPin.version, 5);
    assert.equal(initialPin.get(TUNING_IDS.ball.linearDamping)?.value, 0.1);
    assert.equal(scalarPin.get(TUNING_IDS.ball.linearDamping)?.value, lifecycle.scalarValue);

    const latestPin = registry.pinForRoom(roomId);
    assert.equal(latestPin.version, 6);
    assert.notEqual(latestPin.snapshotId, initialPin.snapshotId);
    assert.notEqual(latestPin.snapshotId, scalarPin.snapshotId);
    assert.notEqual(latestPin.snapshotId, preRejectionPin.snapshotId);

    const releaseGateTrace = assertConfirmedTargetReleaseBlocked(
      lifecycle,
      generatedCase.index,
    );
    resultTraces.push(JSON.stringify({
      generatedCase,
      pinnedSnapshots: [
        initialPinFingerprint,
        scalarPinFingerprint,
        preRejectionPinFingerprint,
        pinFingerprint(latestPin),
      ],
      releaseGateTrace,
    }));
  };

  const runGeneratedLifecycles = (
    generatedLifecycles: typeof cases,
  ): readonly string[] => {
    const resultTraces: string[] = [];
    assertGeneratedCases(generatedLifecycles, (lifecycle, generatedCase) => {
      executeGeneratedLifecycle(lifecycle, generatedCase, resultTraces);
    });
    return Object.freeze(resultTraces);
  };

  const resultTraces = runGeneratedLifecycles(cases);
  const repeatedResultTraces = runGeneratedLifecycles(repeatedCases);
  assert.deepEqual(resultTraces, repeatedResultTraces);
});

test('generated-case diagnostics preserve reproducible seed, ordered index, and cause', () => {
  const diagnosticSeed = `${RECORDED_SEED}:diagnostics`;
  const diagnosticCases = generateCases({
    seed: diagnosticSeed,
    count: 5,
    generate: (random, index) => ({ index, value: random.integer(0, 1_000) }),
  });
  assert.deepEqual(
    replayCase(
      diagnosticSeed,
      3,
      (random, index) => ({ index, value: random.integer(0, 1_000) }),
    ),
    diagnosticCases[3],
  );

  let failure: unknown;
  try {
    assertGeneratedCases(diagnosticCases, (_value, generatedCase) => {
      if (generatedCase.index === 3) assert.fail('diagnostic-sentinel');
    });
  } catch (cause) {
    failure = cause;
  }

  assert.ok(failure instanceof Error);
  assert.match(failure.message, /rocket-arena-property-20-v2:diagnostics/);
  assert.match(failure.message, /index=3/);
  const originalCause = (failure as Error & { cause?: unknown }).cause;
  assert.ok(originalCause instanceof Error);
  assert.match(originalCause.message, /diagnostic-sentinel/);
});
