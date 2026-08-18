import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BLUE_KICKOFF_SLOTS,
  CAR_COLLIDER_TUNING_IDS,
  InvalidKickoffSlotTableError,
  KICKOFF_SLOT_COUNT_PER_TEAM,
  KICKOFF_SLOTS,
  KICKOFF_SLOT_INDEXES,
  ORANGE_KICKOFF_SLOTS,
  TEAM_FACING_MAX_ERROR_DEGREES,
  centerFacingErrorDegrees,
  colliderWorldHalfExtents,
  createKickoffArenaBounds,
  isValidKickoffSlotTable,
  mirrorBlueKickoffSlot,
  resolveCarColliderDimensions,
  validateKickoffSlotTable,
  type KickoffSlotValidationCode,
  type KickoffSlotValidationOptions,
  type RegistryEntrySource,
} from '../src/geometry/kickoff-slots.js';

const METRIC_ARENA_BOUNDS = createKickoffArenaBounds({
  width: 81.92,
  length: 102.4,
  ceilingHeight: 20.44,
});

interface ColliderValues {
  readonly length: number;
  readonly width: number;
  readonly height: number;
}

function createColliderRegistry(
  values: ColliderValues = { length: 1.18, width: 0.84, height: 0.36 },
): RegistryEntrySource {
  const entries = new Map<string, unknown>([
    [CAR_COLLIDER_TUNING_IDS.length, {
      kind: 'scalar',
      value: values.length,
      validatedRange: { min: 0.1, max: 200 },
    }],
    [CAR_COLLIDER_TUNING_IDS.width, {
      kind: 'scalar',
      value: values.width,
      validatedRange: { min: 0.1, max: 200 },
    }],
    [CAR_COLLIDER_TUNING_IDS.height, {
      kind: 'scalar',
      value: values.height,
      validatedRange: { min: 0.1, max: 200 },
    }],
  ]);

  return Object.freeze({
    get(id: string): unknown {
      return entries.get(id);
    },
  });
}

const VALIDATION_OPTIONS: KickoffSlotValidationOptions = Object.freeze({
  arenaBounds: METRIC_ARENA_BOUNDS,
  tuningRegistry: createColliderRegistry(),
});

type MutableSlot = {
  id: string;
  index: number;
  team: string;
  position: number[];
  rotation: number[];
};

type MutableTable = {
  blue: MutableSlot[];
  orange: MutableSlot[];
};

function cloneCanonicalTable(): MutableTable {
  const cloneSlot = (slot: (typeof KICKOFF_SLOTS.blue)[number]): MutableSlot => ({
    id: slot.id,
    index: slot.index,
    team: slot.team,
    position: [...slot.position],
    rotation: [...slot.rotation],
  });

  return {
    blue: KICKOFF_SLOTS.blue.map(cloneSlot),
    orange: KICKOFF_SLOTS.orange.map(cloneSlot),
  };
}

function assertValidationCode(
  candidate: unknown,
  expectedCode: KickoffSlotValidationCode,
  options: KickoffSlotValidationOptions = VALIDATION_OPTIONS,
): void {
  assert.throws(
    () => validateKickoffSlotTable(candidate, options),
    (error: unknown) => error instanceof InvalidKickoffSlotTableError
      && error.code === expectedCode,
  );
}

test('defines exactly four stable canonical slots for each team', () => {
  assert.equal(KICKOFF_SLOT_COUNT_PER_TEAM, 4);
  assert.equal(BLUE_KICKOFF_SLOTS.length, 4);
  assert.equal(ORANGE_KICKOFF_SLOTS.length, 4);
  assert.strictEqual(KICKOFF_SLOTS.blue, BLUE_KICKOFF_SLOTS);
  assert.strictEqual(KICKOFF_SLOTS.orange, ORANGE_KICKOFF_SLOTS);

  for (const index of KICKOFF_SLOT_INDEXES) {
    assert.deepEqual(
      {
        id: BLUE_KICKOFF_SLOTS[index].id,
        index: BLUE_KICKOFF_SLOTS[index].index,
        team: BLUE_KICKOFF_SLOTS[index].team,
      },
      { id: `blue-${index}`, index, team: 'blue' },
    );
    assert.deepEqual(
      {
        id: ORANGE_KICKOFF_SLOTS[index].id,
        index: ORANGE_KICKOFF_SLOTS[index].index,
        team: ORANGE_KICKOFF_SLOTS[index].team,
      },
      { id: `orange-${index}`, index, team: 'orange' },
    );
  }

  assert.equal(Object.isFrozen(KICKOFF_SLOTS), true);
  assert.equal(Object.isFrozen(BLUE_KICKOFF_SLOTS), true);
  assert.equal(Object.isFrozen(ORANGE_KICKOFF_SLOTS), true);
});

test('derives every Orange transform as the exact arena-center mirror of Blue', () => {
  for (const index of KICKOFF_SLOT_INDEXES) {
    const blue = BLUE_KICKOFF_SLOTS[index];
    const orange = ORANGE_KICKOFF_SLOTS[index];
    const expected = mirrorBlueKickoffSlot(blue, METRIC_ARENA_BOUNDS.center);

    assert.deepEqual(orange, expected);
    assert.deepEqual(
      orange.position,
      [-blue.position[0], blue.position[1], -blue.position[2]],
    );
    assert.notStrictEqual(orange.position, blue.position);
    assert.notStrictEqual(orange.rotation, blue.rotation);
  }
});

test('keeps every finite slot transform team-facing within one degree', () => {
  for (const slot of [...BLUE_KICKOFF_SLOTS, ...ORANGE_KICKOFF_SLOTS]) {
    assert.equal(slot.position.every(Number.isFinite), true, `${slot.id} position is finite`);
    assert.equal(slot.rotation.every(Number.isFinite), true, `${slot.id} rotation is finite`);

    const errorDegrees = centerFacingErrorDegrees(slot, METRIC_ARENA_BOUNDS.center);
    assert.equal(Number.isFinite(errorDegrees), true);
    assert.ok(
      errorDegrees <= TEAM_FACING_MAX_ERROR_DEGREES,
      `${slot.id} has ${errorDegrees} degrees of center-facing error`,
    );
  }
});

test('validates complete collider volumes inside the metric arena using registry dimensions', () => {
  assert.doesNotThrow(() => validateKickoffSlotTable(KICKOFF_SLOTS, VALIDATION_OPTIONS));
  assert.equal(isValidKickoffSlotTable(KICKOFF_SLOTS, VALIDATION_OPTIONS), true);

  const dimensions = resolveCarColliderDimensions(VALIDATION_OPTIONS.tuningRegistry);
  assert.deepEqual(dimensions, { length: 1.18, width: 0.84, height: 0.36 });

  for (const slot of [...BLUE_KICKOFF_SLOTS, ...ORANGE_KICKOFF_SLOTS]) {
    const halfExtents = colliderWorldHalfExtents(slot.rotation, dimensions);
    for (let axis = 0; axis < 3; axis += 1) {
      assert.ok(slot.position[axis] - halfExtents[axis] >= METRIC_ARENA_BOUNDS.min[axis]);
      assert.ok(slot.position[axis] + halfExtents[axis] <= METRIC_ARENA_BOUNDS.max[axis]);
    }
  }

  const oversizedRegistry = createColliderRegistry({
    length: 1.18,
    width: 200,
    height: 0.36,
  });
  assertValidationCode(
    KICKOFF_SLOTS,
    'outside-arena',
    { ...VALIDATION_OPTIONS, tuningRegistry: oversizedRegistry },
  );
});

test('rejects incomplete, malformed, non-mirrored, non-facing, and uncontained tables', () => {
  const incomplete = cloneCanonicalTable();
  incomplete.blue.pop();
  assertValidationCode(incomplete, 'invalid-team-count');

  const unstableId = cloneCanonicalTable();
  unstableId.blue[1].id = 'blue-0';
  assertValidationCode(unstableId, 'invalid-slot');

  const nonFinite = cloneCanonicalTable();
  nonFinite.blue[0].position[0] = Number.NaN;
  assertValidationCode(nonFinite, 'invalid-transform');

  const nonNormalized = cloneCanonicalTable();
  nonNormalized.blue[0].rotation = [0, 0, 0, 2];
  assertValidationCode(nonNormalized, 'invalid-transform');

  const facingAway = cloneCanonicalTable();
  facingAway.blue[0].rotation = [0, 1, 0, 0];
  assertValidationCode(facingAway, 'invalid-facing');

  const outsideArena = cloneCanonicalTable();
  outsideArena.blue[0].position[0] *= 4;
  outsideArena.blue[0].position[2] *= 4;
  assertValidationCode(outsideArena, 'outside-arena');

  const independentlyAuthoredOrange = cloneCanonicalTable();
  independentlyAuthoredOrange.orange[2].position[0] += 0.001;
  assertValidationCode(independentlyAuthoredOrange, 'invalid-mirror');

  const extraTeam = { ...cloneCanonicalTable(), green: [] };
  assertValidationCode(extraTeam, 'invalid-table');

  assert.equal(isValidKickoffSlotTable(incomplete, VALIDATION_OPTIONS), false);
});

test('rejects non-finite arena bounds and missing or invalid collider registry entries', () => {
  assert.throws(
    () => createKickoffArenaBounds({
      width: Number.POSITIVE_INFINITY,
      length: 102.4,
      ceilingHeight: 20.44,
    }),
    (error: unknown) => error instanceof InvalidKickoffSlotTableError
      && error.code === 'invalid-bounds',
  );

  assertValidationCode(
    KICKOFF_SLOTS,
    'invalid-bounds',
    {
      ...VALIDATION_OPTIONS,
      arenaBounds: {
        ...METRIC_ARENA_BOUNDS,
        max: [METRIC_ARENA_BOUNDS.max[0], Number.NaN, METRIC_ARENA_BOUNDS.max[2]],
      },
    },
  );

  const missingHeightRegistry: RegistryEntrySource = {
    get(id: string): unknown {
      if (id === CAR_COLLIDER_TUNING_IDS.height) return undefined;
      return createColliderRegistry().get(id);
    },
  };
  assertValidationCode(
    KICKOFF_SLOTS,
    'invalid-collider-tuning',
    { ...VALIDATION_OPTIONS, tuningRegistry: missingHeightRegistry },
  );

  assertValidationCode(
    KICKOFF_SLOTS,
    'invalid-collider-tuning',
    {
      ...VALIDATION_OPTIONS,
      colliderTuningIds: {
        length: CAR_COLLIDER_TUNING_IDS.length,
        width: CAR_COLLIDER_TUNING_IDS.length,
        height: CAR_COLLIDER_TUNING_IDS.height,
      },
    },
  );
});
