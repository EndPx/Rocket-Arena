import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VersionedTuningRegistry,
  type VersionedTuningRegistryOptions,
} from '../src/tuning/registry.js';
import { TUNING_IDS, type TuningProposal } from '../src/tuning/model.js';
import {
  assertGeneratedCases,
  generateCases,
  replayCase,
  type SeededRandom,
} from './support/generated-cases.js';

const RECORDED_SEED = 'rocket-arena-property-20-v1';
const CASES_PER_CLASS = 100;

interface GeneratedProposal {
  readonly proposal: TuningProposal;
  readonly changedId: string | null;
}

function finiteValueFor(id: string, random: SeededRandom): number {
  switch (id) {
    case TUNING_IDS.ball.linearDamping:
      return random.integer(0, 200) / 1000;
    case TUNING_IDS.car.aerodynamicDragCoefficient:
      return random.integer(0, 200) / 100;
    case TUNING_IDS.match.regulationGoalResetSeconds:
      return random.integer(50, 500) / 100;
    case TUNING_IDS.camera.ball.fieldOfViewDegrees:
      return random.integer(40, 100);
    case TUNING_IDS.car.jump.secondJumpWindow:
      return random.integer(50, 200) / 100;
    default:
      throw new Error(`Unsupported valid generated tuning ID ${id}.`);
  }
}

const VALID_IDS = [
  TUNING_IDS.ball.linearDamping,
  TUNING_IDS.car.aerodynamicDragCoefficient,
  TUNING_IDS.match.regulationGoalResetSeconds,
  TUNING_IDS.camera.ball.fieldOfViewDegrees,
  TUNING_IDS.car.jump.secondJumpWindow,
] as const;

function generateValidProposal(random: SeededRandom, index: number): GeneratedProposal {
  const id = random.pick(VALID_IDS);
  return {
    changedId: id,
    proposal: {
      proposalId: `valid-${index}`,
      expectedVersion: 1,
      changes: [{
        id,
        value: finiteValueFor(id, random),
        evidenceId: `evidence-${index}`,
        approvalId: `approval-${index}`,
        verificationStatus: 'verified',
      }],
    },
  };
}

function generateInvalidProposal(random: SeededRandom, index: number): GeneratedProposal {
  const mode = random.integer(0, 6);
  const id = random.pick(VALID_IDS);
  const base = {
    proposalId: `invalid-${index}`,
    expectedVersion: 1,
  } as const;

  switch (mode) {
    case 0:
      return { changedId: id, proposal: { ...base, changes: [{ id, value: Number.NaN }] } };
    case 1:
      return {
        changedId: TUNING_IDS.ball.linearDamping,
        proposal: { ...base, changes: [{ id: TUNING_IDS.ball.linearDamping, value: 0.21 }] },
      };
    case 2:
      return {
        changedId: id,
        proposal: {
          ...base,
          changes: [{ id, value: finiteValueFor(id, random), validatedRange: { min: 2, max: 1 } }],
        },
      };
    case 3:
      return {
        changedId: id,
        proposal: {
          ...base,
          changes: [{ id, value: finiteValueFor(id, random) }, { id, value: finiteValueFor(id, random) }],
        },
      };
    case 4:
      return { changedId: null, proposal: { ...base, changes: [{ id: `unknown-${index}`, value: 1 }] } };
    case 5:
      return {
        changedId: id,
        proposal: {
          ...base,
          changes: [{ id, value: finiteValueFor(id, random), classification: 'not-classified' as never }],
        },
      };
    default:
      return {
        changedId: TUNING_IDS.car.steering.powerslideGripRate,
        proposal: {
          ...base,
          changes: [{ id: TUNING_IDS.car.steering.powerslideGripRate, value: 20 }],
        },
      };
  }
}

function registryFingerprint(registry: VersionedTuningRegistry): string {
  const { version, contentHash, entries } = registry.snapshot;
  return JSON.stringify({ version, contentHash, entries });
}

/**
 * Feature: rocket-arena, Property 20: Tuning proposal atomicity and traceability
 * **Validates: Requirements 17.1-17.16**
 */
test('Property 20: generated tuning proposals are atomic, traceable, and reproducible', () => {
  const validCases = generateCases({
    seed: `${RECORDED_SEED}:valid`,
    count: CASES_PER_CLASS,
    generate: generateValidProposal,
  });
  const invalidCases = generateCases({
    seed: `${RECORDED_SEED}:invalid`,
    count: CASES_PER_CLASS,
    generate: generateInvalidProposal,
  });

  assert.equal(validCases.length, 100);
  assert.equal(invalidCases.length, 100);
  assert.deepEqual(validCases, generateCases({
    seed: `${RECORDED_SEED}:valid`,
    count: CASES_PER_CLASS,
    generate: generateValidProposal,
  }));
  assert.deepEqual(invalidCases, generateCases({
    seed: `${RECORDED_SEED}:invalid`,
    count: CASES_PER_CLASS,
    generate: generateInvalidProposal,
  }));
  assert.deepEqual(
    replayCase(`${RECORDED_SEED}:valid`, 73, generateValidProposal),
    validCases[73],
  );
  assert.deepEqual(
    replayCase(`${RECORDED_SEED}:invalid`, 61, generateInvalidProposal),
    invalidCases[61],
  );

  assertGeneratedCases(validCases, ({ proposal, changedId }) => {
    assert.ok(changedId);
    const registry = new VersionedTuningRegistry();
    const pinnedBefore = registry.pinForRoom(`valid-room-${proposal.proposalId}`);
    const beforeEntry = registry.snapshot.get(changedId);
    const result = registry.propose(proposal);
    assert.equal(result.accepted, true);
    if (!result.accepted) return;

    const afterEntry = result.snapshot.get(changedId);
    assert.equal(result.snapshot.version, 2);
    assert.equal(result.historyRecord.accepted, true);
    assert.equal(result.historyRecord.fromVersion, 1);
    assert.equal(result.historyRecord.toVersion, 2);
    assert.equal(result.historyRecord.changes.length, 1);
    assert.deepEqual(result.historyRecord.changes[0]?.before, beforeEntry);
    assert.deepEqual(result.historyRecord.changes[0]?.after, afterEntry);
    assert.equal(afterEntry?.evidenceId, proposal.changes[0]?.evidenceId);
    assert.equal(afterEntry?.approvalId, proposal.changes[0]?.approvalId);
    assert.equal(afterEntry?.registryVersion, 2);
    assert.equal(pinnedBefore.version, 1);
    assert.deepEqual(pinnedBefore.get(changedId), beforeEntry);
  });

  assertGeneratedCases(invalidCases, ({ proposal }) => {
    const options: VersionedTuningRegistryOptions = {};
    const registry = new VersionedTuningRegistry(options);
    const before = registryFingerprint(registry);
    const pinnedBefore = registry.pinForRoom(`invalid-room-${proposal.proposalId}`);
    const result = registry.propose(proposal);
    assert.equal(result.accepted, false);
    assert.equal(registryFingerprint(registry), before);
    assert.equal(registry.snapshot.version, 1);
    assert.equal(registry.snapshot.contentHash, pinnedBefore.contentHash);
    assert.equal(result.historyRecord.accepted, false);
    assert.equal(result.historyRecord.toVersion, null);
    assert.ok(!result.accepted && result.issues.length > 0);
  });
});
