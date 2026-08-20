import {
  TUNING_IDS,
  type CurveTuningEntry,
  type CurveValidatedRange,
  type FiniteRange,
  type RoomPinnedTuningSnapshot,
  type ScalarTuningEntry,
  type StructuredCurve,
  type TuningAffect,
  type TuningClassification,
  type TuningEntry,
  type TuningEntryPatch,
  type TuningProposal,
  type TuningProposalHistoryRecord,
  type TuningProposalResult,
  type TuningRegistrySnapshot,
  type TuningValidationIssue,
  type VectorTuningEntry,
} from './model.js';

export const TUNING_REGISTRY_ID = 'rocket-arena-mechanics' as const;
export const INITIAL_TUNING_REGISTRY_VERSION = 1 as const;

const VALID_CLASSIFICATIONS = new Set<TuningClassification>([
  'confirmed-starting-target',
  'unverified-hypothesis',
]);
const VALID_STATUSES = new Set(['confirmed', 'unverified', 'verified'] as const);
const VALID_AFFECTS = new Set<TuningAffect>([
  'authority',
  'camera',
  'hud',
  'perceived-control',
]);
const VALID_CURVE_ORDERS = new Set(['any', 'non-increasing', 'non-decreasing'] as const);
const MUTABLE_TUNING_PATCH_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'label',
  'value',
  'validatedRange',
  'evidenceId',
  'approvalId',
  'approvalRationale',
  'verificationStatus',
] as const);

function scalar(
  id: string,
  label: string,
  unit: string,
  value: number,
  min: number,
  max: number,
  classification: TuningClassification = 'confirmed-starting-target',
  affects: readonly TuningAffect[] = ['authority'],
): ScalarTuningEntry {
  return {
    id,
    label,
    registryVersion: INITIAL_TUNING_REGISTRY_VERSION,
    unit,
    classification,
    verificationStatus: classification === 'unverified-hypothesis' ? 'unverified' : 'confirmed',
    affects,
    evidenceId: null,
    approvalId: null,
    approvalRationale: null,
    kind: 'scalar',
    value,
    validatedRange: { min, max },
  };
}

function vector(
  id: string,
  label: string,
  unit: string,
  value: readonly number[],
  validatedRange: readonly FiniteRange[],
  affects: readonly TuningAffect[] = ['authority'],
): VectorTuningEntry {
  return {
    id,
    label,
    registryVersion: INITIAL_TUNING_REGISTRY_VERSION,
    unit,
    classification: 'unverified-hypothesis',
    verificationStatus: 'unverified',
    affects,
    evidenceId: null,
    approvalId: null,
    approvalRationale: null,
    kind: 'vector',
    value,
    validatedRange,
  };
}

function curve(
  id: string,
  label: string,
  unit: string,
  value: StructuredCurve,
  validatedRange: CurveValidatedRange,
): CurveTuningEntry {
  return {
    id,
    label,
    registryVersion: INITIAL_TUNING_REGISTRY_VERSION,
    unit,
    classification: 'unverified-hypothesis',
    verificationStatus: 'unverified',
    affects: ['authority', 'perceived-control'],
    evidenceId: null,
    approvalId: null,
    approvalRationale: null,
    kind: 'curve',
    value,
    validatedRange,
  };
}

const pointRanges = (count: number, range: FiniteRange): readonly FiniteRange[] => (
  Array.from({ length: count }, () => ({ ...range }))
);

const padPosition = (
  id: string,
  index: number,
  position: readonly [number, number, number],
): VectorTuningEntry => vector(
  id,
  `Large boost pad ${index + 1} position`,
  'm [x,y,z]',
  position,
  [
    { min: -40.96, max: 40.96 },
    { min: 0, max: 2.56 },
    { min: -51.2, max: 51.2 },
  ],
);

/**
 * Checked-in finite staging seeds. Every uncertain value remains explicitly
 * unverified until reference evidence and approval are linked.
 */
export const SEEDED_TUNING_ENTRIES: readonly TuningEntry[] = deepFreeze([
  scalar(TUNING_IDS.physics.fixedStepSeconds, 'Authoritative fixed step', 's', 1 / 60, 1 / 60, 1 / 60),
  scalar(TUNING_IDS.physics.gravityY, 'World gravity Y', 'm/s^2', -6.5, -6.5, -6.5),
  scalar(TUNING_IDS.car.mass, 'Car mass', 'kg', 150, 150, 150),
  scalar(TUNING_IDS.car.maxLinearSpeed, 'Car maximum propulsion speed', 'm/s', 23, 23, 23),
  scalar(TUNING_IDS.car.maxAngularSpeed, 'Car maximum angular speed', 'rad/s', 5.5, 5.5, 5.5),
  scalar(TUNING_IDS.car.boost.acceleration, 'Boost acceleration', 'm/s^2', 9.91666, 9.91666, 9.91666),
  scalar(TUNING_IDS.car.boost.initialInventory, 'Kickoff boost inventory', 'boost units', 33, 33, 33),
  scalar(TUNING_IDS.car.boost.consumptionPerSecond, 'Boost consumption rate', 'boost units/s', 33.3, 33.3, 33.3),
  scalar(TUNING_IDS.car.jump.firstVelocityChange, 'First jump velocity change', 'm/s', 2.91667, 2.91667, 2.91667),
  scalar(TUNING_IDS.ball.radius, 'Ball radius', 'm', 1.8, 1.8, 1.8),
  scalar(TUNING_IDS.ball.mass, 'Ball mass', 'kg', 25, 25, 25),
  scalar(TUNING_IDS.ball.restitution, 'Ball restitution', 'ratio', 0.6, 0.6, 0.6),
  scalar(TUNING_IDS.ball.maxLinearSpeed, 'Ball maximum linear speed', 'm/s', 60, 60, 60),
  scalar(TUNING_IDS.ball.maxAngularSpeed, 'Ball maximum angular speed', 'rad/s', 6, 6, 6),

  scalar(TUNING_IDS.car.collider.length, 'Car collider length', 'm', 3.2, 2.4, 4, 'unverified-hypothesis'),
  scalar(TUNING_IDS.car.collider.width, 'Car collider width', 'm', 1.8, 1.4, 2.2, 'unverified-hypothesis'),
  scalar(TUNING_IDS.car.collider.height, 'Car collider height', 'm', 0.8, 0.6, 1.2, 'unverified-hypothesis'),
  scalar(TUNING_IDS.car.throttle.targetSpeed, 'Throttle target speed provenance', 'm/s', 14.1, 10, 18, 'unverified-hypothesis', ['authority', 'perceived-control']),
  curve(
    TUNING_IDS.car.throttle.accelerationCurve,
    'Throttle acceleration curve provenance',
    'm/s^2 by m/s',
    {
      outputOrder: 'non-increasing',
      samples: [
        { input: 0, output: 10 },
        { input: 5, output: 8 },
        { input: 10, output: 4 },
        { input: 14.1, output: 0 },
      ],
    },
    { input: { min: 0, max: 23 }, output: { min: 0, max: 20 } },
  ),
  curve(
    TUNING_IDS.car.steering.curvatureCurve,
    'Steering curvature curve provenance',
    '1/m by m/s',
    {
      outputOrder: 'non-increasing',
      samples: [
        { input: 0, output: 0.18 },
        { input: 5, output: 0.14 },
        { input: 14.1, output: 0.08 },
        { input: 23, output: 0.04 },
      ],
    },
    { input: { min: 0, max: 23 }, output: { min: 0, max: 0.5 } },
  ),
  scalar(TUNING_IDS.car.steering.normalGripRate, 'Normal lateral grip rate', 's^-1', 12, 1, 30, 'unverified-hypothesis', ['authority', 'perceived-control']),
  scalar(TUNING_IDS.car.steering.powerslideGripRate, 'Powerslide lateral grip rate', 's^-1', 4, 0.1, 20, 'unverified-hypothesis', ['authority', 'perceived-control']),
  scalar(TUNING_IDS.car.steering.powerslideCurvatureMultiplier, 'Powerslide curvature multiplier', 'ratio', 1.5, 1.01, 3, 'unverified-hypothesis', ['authority', 'perceived-control']),
  scalar(TUNING_IDS.car.aerodynamicDragCoefficient, 'Aerodynamic drag coefficient', 's^-1', 0.05, 0, 2, 'unverified-hypothesis', ['authority', 'perceived-control']),
  scalar(TUNING_IDS.ball.linearDamping, 'Ball linear damping', 's^-1', 0.1, 0, 0.2, 'unverified-hypothesis', ['authority', 'perceived-control']),
  scalar(TUNING_IDS.car.jump.holdForce, 'Jump hold force', 'N', 1450, 0, 5000, 'unverified-hypothesis', ['authority', 'perceived-control']),
  scalar(TUNING_IDS.car.jump.holdDuration, 'Jump hold duration', 's', 0.2, 0, 0.5, 'unverified-hypothesis', ['authority', 'perceived-control']),
  scalar(TUNING_IDS.car.jump.secondJumpWindow, 'Second jump window', 's', 1.25, 0.5, 2, 'unverified-hypothesis', ['authority', 'perceived-control']),
  scalar(TUNING_IDS.car.jump.flipActuationWindow, 'Flip actuation window', 's', 0.65, 0.1, 1, 'unverified-hypothesis', ['authority', 'perceived-control']),
  scalar(TUNING_IDS.car.jump.directionalDeadzone, 'Directional flip deadzone', 'normalized', 0.3, 0, 1, 'unverified-hypothesis', ['authority', 'perceived-control']),
  vector(
    TUNING_IDS.support.contactPoints,
    'Local support contact points',
    'm [x,y,z] x4',
    [-0.72, -0.4, -1.28, 0.72, -0.4, -1.28, -0.72, -0.4, 1.28, 0.72, -0.4, 1.28],
    [
      { min: -0.9, max: 0.9 }, { min: -0.4, max: 0.4 }, { min: -1.6, max: 1.6 },
      { min: -0.9, max: 0.9 }, { min: -0.4, max: 0.4 }, { min: -1.6, max: 1.6 },
      { min: -0.9, max: 0.9 }, { min: -0.4, max: 0.4 }, { min: -1.6, max: 1.6 },
      { min: -0.9, max: 0.9 }, { min: -0.4, max: 0.4 }, { min: -1.6, max: 1.6 },
    ],
  ),
  scalar(TUNING_IDS.support.rayDistance, 'Local-down support ray distance', 'm', 0.25, 0.05, 1, 'unverified-hypothesis'),
  scalar(TUNING_IDS.support.normalAngleThresholdDegrees, 'Support normal angle threshold', 'degrees', 60, 0, 90, 'unverified-hypothesis'),
  padPosition(TUNING_IDS.boostPads.largePositions[0], 0, [-30, 0.15, -35]),
  padPosition(TUNING_IDS.boostPads.largePositions[1], 1, [30, 0.15, -35]),
  padPosition(TUNING_IDS.boostPads.largePositions[2], 2, [-39, 0.15, 0]),
  padPosition(TUNING_IDS.boostPads.largePositions[3], 3, [39, 0.15, 0]),
  padPosition(TUNING_IDS.boostPads.largePositions[4], 4, [-30, 0.15, 35]),
  padPosition(TUNING_IDS.boostPads.largePositions[5], 5, [30, 0.15, 35]),
  vector(TUNING_IDS.boostPads.largeSensorHalfExtents, 'Large boost pad sensor half extents', 'm [x,y,z]', [1.5, 0.3, 1.5], pointRanges(3, { min: 0.05, max: 3 })),
  vector(TUNING_IDS.boostPads.smallSensorHalfExtents, 'Small boost pad sensor half extents', 'm [x,y,z]', [0.8, 0.2, 0.8], pointRanges(3, { min: 0.05, max: 2 })),
  scalar(TUNING_IDS.camera.ball.distance, 'Ball camera distance', 'm', 12, 5, 25, 'unverified-hypothesis', ['camera', 'perceived-control']),
  scalar(TUNING_IDS.camera.ball.height, 'Ball camera height', 'm', 5, 1, 12, 'unverified-hypothesis', ['camera', 'perceived-control']),
  scalar(TUNING_IDS.camera.ball.lookAhead, 'Ball camera look-ahead', 'm', 5, 0, 15, 'unverified-hypothesis', ['camera', 'perceived-control']),
  scalar(TUNING_IDS.camera.ball.fieldOfViewDegrees, 'Ball camera field of view', 'degrees', 65, 40, 100, 'unverified-hypothesis', ['camera', 'perceived-control']),
  scalar(TUNING_IDS.camera.spring.distance, 'Spring camera distance', 'm', 12, 5, 25, 'unverified-hypothesis', ['camera', 'perceived-control']),
  scalar(TUNING_IDS.camera.spring.height, 'Spring camera height', 'm', 5, 1, 12, 'unverified-hypothesis', ['camera', 'perceived-control']),
  scalar(TUNING_IDS.camera.spring.stiffness, 'Spring camera stiffness', 's^-2', 7.2, 0.1, 30, 'unverified-hypothesis', ['camera', 'perceived-control']),
  scalar(TUNING_IDS.camera.spring.damping, 'Spring camera damping', 's^-1', 5, 0.1, 30, 'unverified-hypothesis', ['camera', 'perceived-control']),
  scalar(TUNING_IDS.camera.spring.lookAhead, 'Spring camera look-ahead', 'm', 5, 0, 15, 'unverified-hypothesis', ['camera', 'perceived-control']),
  scalar(TUNING_IDS.camera.spring.fieldOfViewDegrees, 'Spring camera field of view', 'degrees', 60, 40, 100, 'unverified-hypothesis', ['camera', 'perceived-control']),
  scalar(TUNING_IDS.match.regulationGoalResetSeconds, 'Regulation goal reset duration', 's', 2, 0.5, 5, 'unverified-hypothesis', ['authority', 'hud']),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function issue(
  code: TuningValidationIssue['code'],
  entryId: string | null,
  message: string,
): TuningValidationIssue {
  return Object.freeze({ code, entryId, message });
}

function isFiniteRange(value: unknown): value is FiniteRange {
  return isRecord(value)
    && typeof value.min === 'number'
    && Number.isFinite(value.min)
    && typeof value.max === 'number'
    && Number.isFinite(value.max);
}

function validateRange(
  range: unknown,
  entryId: string,
  issues: TuningValidationIssue[],
): range is FiniteRange {
  if (!isFiniteRange(range)) {
    issues.push(issue('non-finite-range', entryId, 'Validated range bounds must be finite.'));
    return false;
  }
  if (range.min > range.max) {
    issues.push(issue('range-order', entryId, 'Validated range minimum must not exceed maximum.'));
    return false;
  }
  return true;
}

function validateBaseEntry(
  entry: Record<string, unknown>,
  registryVersion: number,
  issues: TuningValidationIssue[],
): string | null {
  const id = typeof entry.id === 'string' ? entry.id : null;
  if (id === null || id.trim().length === 0) {
    issues.push(issue('invalid-id', null, 'Every tuning entry requires a non-empty ID.'));
    return null;
  }
  if (typeof entry.label !== 'string' || entry.label.trim().length === 0) {
    issues.push(issue('invalid-label', id, 'Every tuning entry requires a non-empty label.'));
  }
  if (typeof entry.unit !== 'string' || entry.unit.trim().length === 0) {
    issues.push(issue('invalid-unit', id, 'Every tuning entry requires a non-empty unit label.'));
  }
  if (!Number.isSafeInteger(entry.registryVersion)
    || (entry.registryVersion as number) < 1
    || (entry.registryVersion as number) > registryVersion) {
    issues.push(issue('invalid-registry-version', id, 'Entry registryVersion must be within the active registry history.'));
  }
  if (!VALID_CLASSIFICATIONS.has(entry.classification as TuningClassification)) {
    issues.push(issue('invalid-classification', id, 'Every entry requires a supported classification.'));
  }
  if (!VALID_STATUSES.has(entry.verificationStatus as 'confirmed' | 'unverified' | 'verified')) {
    issues.push(issue('invalid-verification-status', id, 'Entry verification status is invalid.'));
  }
  if (entry.classification === 'confirmed-starting-target' && entry.verificationStatus !== 'confirmed') {
    issues.push(issue('invalid-verification-status', id, 'Confirmed targets must retain confirmed status.'));
  }
  if (entry.classification === 'unverified-hypothesis' && entry.verificationStatus === 'confirmed') {
    issues.push(issue('invalid-verification-status', id, 'Hypotheses are unverified until evidence-backed verification.'));
  }
  if (!Array.isArray(entry.affects) || entry.affects.length === 0
    || entry.affects.some((affect) => !VALID_AFFECTS.has(affect as TuningAffect))
    || new Set(entry.affects).size !== entry.affects.length) {
    issues.push(issue('invalid-affect', id, 'Entry affects must be a non-empty unique supported list.'));
  }
  for (const field of ['evidenceId', 'approvalId', 'approvalRationale'] as const) {
    const link = entry[field];
    if (link !== null && (typeof link !== 'string' || link.trim().length === 0)) {
      issues.push(issue('invalid-link', id, `${field} must be null or a non-empty string.`));
    }
  }
  if (entry.approvalId !== null && entry.evidenceId === null) {
    issues.push(issue('invalid-link', id, 'An approval cannot be linked without reference evidence.'));
  }
  if (entry.verificationStatus === 'verified'
    && (entry.evidenceId === null || entry.approvalId === null)) {
    issues.push(issue('invalid-link', id, 'Verified hypotheses require evidence and approval links.'));
  }
  return id;
}

/** Validate every entry and all relational invariants without mutating input. */
export function validateTuningEntries(
  entries: readonly TuningEntry[],
  registryVersion: number,
): readonly TuningValidationIssue[] {
  const issues: TuningValidationIssue[] = [];
  if (!Number.isSafeInteger(registryVersion) || registryVersion < 1) {
    return Object.freeze([
      issue('invalid-registry-version', null, 'Registry version must be a positive safe integer.'),
    ]);
  }
  if (!Array.isArray(entries)) {
    return Object.freeze([issue('empty-proposal', null, 'Registry entries must be an array.')]);
  }

  const seen = new Set<string>();
  const records = new Map<string, Record<string, unknown>>();
  for (const rawEntry of entries as readonly unknown[]) {
    if (!isRecord(rawEntry)) {
      issues.push(issue('invalid-id', null, 'Every tuning entry must be an object.'));
      continue;
    }
    const id = validateBaseEntry(rawEntry, registryVersion, issues);
    if (id === null) continue;
    if (seen.has(id)) issues.push(issue('duplicate-entry', id, `Duplicate tuning entry ${id}.`));
    seen.add(id);
    records.set(id, rawEntry);

    if (rawEntry.kind === 'scalar') {
      if (typeof rawEntry.value !== 'number' || !Number.isFinite(rawEntry.value)) {
        issues.push(issue('non-finite-value', id, 'Scalar value must be finite.'));
      }
      if (validateRange(rawEntry.validatedRange, id, issues)
        && typeof rawEntry.value === 'number'
        && Number.isFinite(rawEntry.value)
        && (rawEntry.value < rawEntry.validatedRange.min || rawEntry.value > rawEntry.validatedRange.max)) {
        issues.push(issue('value-out-of-range', id, 'Scalar value lies outside its inclusive range.'));
      }
    } else if (rawEntry.kind === 'vector') {
      const value = rawEntry.value;
      const ranges = rawEntry.validatedRange;
      if (!Array.isArray(value) || !Array.isArray(ranges)
        || value.length === 0 || value.length !== ranges.length) {
        issues.push(issue('vector-length', id, 'Vector value and range arrays must have equal non-zero lengths.'));
      } else {
        for (let index = 0; index < value.length; index += 1) {
          const component = value[index];
          const range = ranges[index];
          if (typeof component !== 'number' || !Number.isFinite(component)) {
            issues.push(issue('non-finite-value', id, `Vector component ${index} must be finite.`));
          }
          if (validateRange(range, id, issues)
            && typeof component === 'number'
            && Number.isFinite(component)
            && (component < range.min || component > range.max)) {
            issues.push(issue('value-out-of-range', id, `Vector component ${index} is outside its inclusive range.`));
          }
        }
      }
    } else if (rawEntry.kind === 'curve') {
      const value = rawEntry.value;
      const range = rawEntry.validatedRange;
      if (!isRecord(value) || !Array.isArray(value.samples) || value.samples.length < 2) {
        issues.push(issue('curve-empty', id, 'A structured curve requires at least two samples.'));
      }
      if (!isRecord(range)
        || !validateRange(range.input, id, issues)
        || !validateRange(range.output, id, issues)) {
        issues.push(issue('non-finite-range', id, 'Curve input and output ranges are required.'));
      }
      if (isRecord(value) && !VALID_CURVE_ORDERS.has(value.outputOrder as StructuredCurve['outputOrder'])) {
        issues.push(issue('curve-output-order', id, 'Curve output order is invalid.'));
      }
      if (isRecord(value) && Array.isArray(value.samples)
        && isRecord(range) && isFiniteRange(range.input) && isFiniteRange(range.output)) {
        let previousInput = Number.NEGATIVE_INFINITY;
        let previousOutput: number | null = null;
        for (let index = 0; index < value.samples.length; index += 1) {
          const sample = value.samples[index];
          if (!isRecord(sample)
            || typeof sample.input !== 'number' || !Number.isFinite(sample.input)
            || typeof sample.output !== 'number' || !Number.isFinite(sample.output)) {
            issues.push(issue('non-finite-value', id, `Curve sample ${index} must be finite.`));
            continue;
          }
          if (sample.input <= previousInput) {
            issues.push(issue('curve-input-order', id, 'Curve sample inputs must strictly increase.'));
          }
          if (sample.input < range.input.min || sample.input > range.input.max
            || sample.output < range.output.min || sample.output > range.output.max) {
            issues.push(issue('value-out-of-range', id, `Curve sample ${index} lies outside its ranges.`));
          }
          if (previousOutput !== null && value.outputOrder === 'non-increasing'
            && sample.output > previousOutput) {
            issues.push(issue('curve-output-order', id, 'Curve outputs must be non-increasing.'));
          }
          if (previousOutput !== null && value.outputOrder === 'non-decreasing'
            && sample.output < previousOutput) {
            issues.push(issue('curve-output-order', id, 'Curve outputs must be non-decreasing.'));
          }
          previousInput = sample.input;
          previousOutput = sample.output;
        }
      }
    } else {
      issues.push(issue('kind-mismatch', id, 'Entry kind must be scalar, vector, or curve.'));
    }
  }

  const scalarValue = (id: string): number | undefined => {
    const entry = records.get(id);
    return entry?.kind === 'scalar' && typeof entry.value === 'number' && Number.isFinite(entry.value)
      ? entry.value
      : undefined;
  };
  const vectorValue = (id: string): readonly number[] | undefined => {
    const entry = records.get(id);
    return entry?.kind === 'vector' && Array.isArray(entry.value)
      && entry.value.every((value) => typeof value === 'number' && Number.isFinite(value))
      ? entry.value as readonly number[]
      : undefined;
  };

  const damping = records.get(TUNING_IDS.ball.linearDamping);
  if (damping?.kind === 'scalar' && isFiniteRange(damping.validatedRange)
    && (damping.validatedRange.min < 0 || damping.validatedRange.max > 0.2)) {
    issues.push(issue('cross-entry-invariant', TUNING_IDS.ball.linearDamping, 'Ball damping range must stay inside [0, 0.2] s^-1.'));
  }

  const targetSpeed = scalarValue(TUNING_IDS.car.throttle.targetSpeed);
  const throttleCurve = records.get(TUNING_IDS.car.throttle.accelerationCurve);
  if (targetSpeed !== undefined && throttleCurve?.kind === 'curve'
    && isRecord(throttleCurve.value) && Array.isArray(throttleCurve.value.samples)
    && throttleCurve.value.samples.length > 0) {
    const last = throttleCurve.value.samples[throttleCurve.value.samples.length - 1];
    if (!isRecord(last) || last.input !== targetSpeed || last.output !== 0) {
      issues.push(issue('cross-entry-invariant', TUNING_IDS.car.throttle.accelerationCurve, 'Throttle curve must end at target speed with zero acceleration.'));
    }
  }

  const normalGrip = scalarValue(TUNING_IDS.car.steering.normalGripRate);
  const powerslideGrip = scalarValue(TUNING_IDS.car.steering.powerslideGripRate);
  const powerslideCurvature = scalarValue(TUNING_IDS.car.steering.powerslideCurvatureMultiplier);
  if (normalGrip !== undefined && powerslideGrip !== undefined
    && !(powerslideGrip > 0 && powerslideGrip < normalGrip)) {
    issues.push(issue('cross-entry-invariant', TUNING_IDS.car.steering.powerslideGripRate, 'Powerslide grip must be positive and lower than normal grip.'));
  }
  if (powerslideCurvature !== undefined && powerslideCurvature <= 1) {
    issues.push(issue('cross-entry-invariant', TUNING_IDS.car.steering.powerslideCurvatureMultiplier, 'Powerslide curvature multiplier must exceed one.'));
  }

  const colliderWidth = scalarValue(TUNING_IDS.car.collider.width);
  const colliderHeight = scalarValue(TUNING_IDS.car.collider.height);
  const colliderLength = scalarValue(TUNING_IDS.car.collider.length);
  const supportPoints = vectorValue(TUNING_IDS.support.contactPoints);
  if (supportPoints !== undefined) {
    if (supportPoints.length < 12 || supportPoints.length % 3 !== 0) {
      issues.push(issue('cross-entry-invariant', TUNING_IDS.support.contactPoints, 'At least four support-point triples are required.'));
    } else {
      const distinct = new Set<string>();
      for (let index = 0; index < supportPoints.length; index += 3) {
        const x = supportPoints[index]!;
        const y = supportPoints[index + 1]!;
        const z = supportPoints[index + 2]!;
        distinct.add(`${x},${y},${z}`);
        if ((colliderWidth !== undefined && Math.abs(x) > colliderWidth / 2)
          || (colliderHeight !== undefined && Math.abs(y) > colliderHeight / 2)
          || (colliderLength !== undefined && Math.abs(z) > colliderLength / 2)) {
          issues.push(issue('cross-entry-invariant', TUNING_IDS.support.contactPoints, 'Support points must remain inside the collider footprint.'));
          break;
        }
      }
      if (distinct.size < 4) {
        issues.push(issue('cross-entry-invariant', TUNING_IDS.support.contactPoints, 'Support points must contain at least four distinct points.'));
      }
    }
  }

  for (const id of [
    TUNING_IDS.boostPads.largeSensorHalfExtents,
    TUNING_IDS.boostPads.smallSensorHalfExtents,
  ]) {
    const extents = vectorValue(id);
    if (extents !== undefined && (extents.length !== 3 || extents.some((value) => value <= 0))) {
      issues.push(issue('cross-entry-invariant', id, 'Pad sensor half extents must be three positive values.'));
    }
  }
  for (const id of TUNING_IDS.boostPads.largePositions) {
    const position = vectorValue(id);
    if (position !== undefined && (position.length !== 3
      || Math.abs(position[0]!) > 40.96 || position[1]! < 0 || position[1]! > 2.56
      || Math.abs(position[2]!) > 51.2)) {
      issues.push(issue('cross-entry-invariant', id, 'Large pad positions must stay inside the metric field bounds.'));
    }
  }

  for (const id of [
    TUNING_IDS.camera.ball.fieldOfViewDegrees,
    TUNING_IDS.camera.spring.fieldOfViewDegrees,
  ]) {
    const fieldOfView = records.get(id);
    if (fieldOfView?.kind === 'scalar' && isFiniteRange(fieldOfView.validatedRange)
      && (fieldOfView.validatedRange.min <= 0 || fieldOfView.validatedRange.max >= 180)) {
      issues.push(issue('cross-entry-invariant', id, 'Camera field-of-view range must remain inside (0, 180) degrees.'));
    }
  }

  const resetDuration = scalarValue(TUNING_IDS.match.regulationGoalResetSeconds);
  if (resetDuration !== undefined && resetDuration <= 0) {
    issues.push(issue('cross-entry-invariant', TUNING_IDS.match.regulationGoalResetSeconds, 'Goal reset duration must be positive.'));
  }

  return Object.freeze(issues);
}

function cloneUnknown<T>(value: T): T {
  if (Array.isArray(value)) return value.map((child) => cloneUnknown(child)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneUnknown(child)])) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneAndFreezeEntry(entry: TuningEntry): TuningEntry {
  return deepFreeze(cloneUnknown(entry));
}

function cloneAndFreezeIssue(value: TuningValidationIssue): TuningValidationIssue {
  return deepFreeze({ ...value });
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function makeSnapshot(
  registryId: string,
  version: number,
  entries: readonly TuningEntry[],
  history: readonly TuningProposalHistoryRecord[],
): TuningRegistrySnapshot {
  const frozenEntries = Object.freeze(
    [...entries].sort((left, right) => left.id.localeCompare(right.id)).map(cloneAndFreezeEntry),
  );
  const frozenHistory = deepFreeze(cloneUnknown(history));
  const entriesById = new Map(frozenEntries.map((entry) => [entry.id, entry]));
  const contentHash = hashText(JSON.stringify({ version, entries: frozenEntries }));
  const unverifiedTuningIds = Object.freeze(frozenEntries
    .filter((entry) => entry.classification === 'unverified-hypothesis'
      && entry.verificationStatus !== 'verified')
    .map((entry) => entry.id));

  return Object.freeze({
    registryId,
    version,
    contentHash,
    entries: frozenEntries,
    history: frozenHistory,
    unverifiedTuningIds,
    get(id: string): TuningEntry | undefined {
      return entriesById.get(id);
    },
    has(id: string): boolean {
      return entriesById.has(id);
    },
  });
}

export interface VersionedTuningRegistryOptions {
  readonly registryId?: string;
  readonly version?: number;
  readonly entries?: readonly TuningEntry[];
}

export class InvalidTuningRegistryError extends Error {
  readonly issues: readonly TuningValidationIssue[];

  constructor(message: string, issues: readonly TuningValidationIssue[]) {
    super(message);
    this.name = 'InvalidTuningRegistryError';
    this.issues = Object.freeze(issues.map(cloneAndFreezeIssue));
  }
}

/** Mutable coordinator whose published snapshots are deeply immutable and version-pinned. */
export class VersionedTuningRegistry {
  readonly registryId: string;
  #snapshot: TuningRegistrySnapshot;
  #historySequence = 0;

  constructor(options: VersionedTuningRegistryOptions = {}) {
    const registryId = options.registryId ?? TUNING_REGISTRY_ID;
    const version = options.version ?? INITIAL_TUNING_REGISTRY_VERSION;
    const entries = options.entries ?? SEEDED_TUNING_ENTRIES;
    if (typeof registryId !== 'string' || registryId.trim().length === 0) {
      throw new InvalidTuningRegistryError('Registry ID must be non-empty.', [
        issue('invalid-id', null, 'Registry ID must be non-empty.'),
      ]);
    }
    const issues = validateTuningEntries(entries, version);
    if (issues.length > 0) {
      throw new InvalidTuningRegistryError('Initial tuning registry is invalid.', issues);
    }
    this.registryId = registryId;
    this.#snapshot = makeSnapshot(registryId, version, entries, []);
  }

  get snapshot(): TuningRegistrySnapshot {
    return this.#snapshot;
  }

  get(id: string): TuningEntry | undefined {
    return this.#snapshot.get(id);
  }

  pinForRoom(roomId: string): RoomPinnedTuningSnapshot {
    if (typeof roomId !== 'string' || roomId.trim().length === 0) {
      throw new TypeError('A non-empty roomId is required to pin tuning.');
    }
    const snapshot = this.#snapshot;
    return Object.freeze({
      ...snapshot,
      roomId,
      snapshotId: `${snapshot.registryId}@${snapshot.version}:${snapshot.contentHash}:${roomId}`,
    });
  }

  propose(proposal: TuningProposal): TuningProposalResult {
    const from = this.#snapshot;
    const proposalIssues: TuningValidationIssue[] = [];
    if (!isRecord(proposal) || typeof proposal.proposalId !== 'string'
      || proposal.proposalId.trim().length === 0) {
      proposalIssues.push(issue('invalid-proposal-id', null, 'Proposal ID must be non-empty.'));
    }
    if (!isRecord(proposal) || !Array.isArray(proposal.changes) || proposal.changes.length === 0) {
      proposalIssues.push(issue('empty-proposal', null, 'A proposal requires at least one change.'));
    }
    if (isRecord(proposal) && proposal.expectedVersion !== undefined
      && proposal.expectedVersion !== from.version) {
      proposalIssues.push(issue('version-conflict', null, `Expected version ${String(proposal.expectedVersion)} does not match ${from.version}.`));
    }

    const changes = isRecord(proposal) && Array.isArray(proposal.changes)
      ? proposal.changes as readonly TuningEntryPatch[]
      : [];
    const changedIds = new Set<string>();
    for (const patch of changes as readonly unknown[]) {
      if (!isRecord(patch) || typeof patch.id !== 'string' || patch.id.trim().length === 0) {
        proposalIssues.push(issue('invalid-id', null, 'Every proposal change requires a non-empty tuning ID.'));
        continue;
      }
      const immutableOrUnknownFields = Object.keys(patch)
        .filter((field) => !MUTABLE_TUNING_PATCH_FIELDS.has(field));
      for (const field of immutableOrUnknownFields) {
        proposalIssues.push(issue(
          'invalid-patch-field',
          patch.id,
          `Proposal field "${field}" is immutable or unsupported.`,
        ));
      }
      if (changedIds.has(patch.id)) {
        proposalIssues.push(issue('duplicate-change', patch.id, `Proposal changes ${patch.id} more than once.`));
      }
      changedIds.add(patch.id);
      const current = from.get(patch.id);
      if (current === undefined) {
        proposalIssues.push(issue('unknown-entry', patch.id, `Unknown tuning entry ${patch.id}.`));
        continue;
      }
      if (hasOwn(patch, 'value')) {
        const compatible = current.kind === 'scalar'
          ? typeof patch.value === 'number'
          : current.kind === 'vector'
            ? Array.isArray(patch.value)
            : isRecord(patch.value);
        if (!compatible) proposalIssues.push(issue('kind-mismatch', patch.id, 'Patch value does not match entry kind.'));
      }
      if (hasOwn(patch, 'validatedRange')) {
        const compatible = current.kind === 'scalar'
          ? isRecord(patch.validatedRange)
          : current.kind === 'vector'
            ? Array.isArray(patch.validatedRange)
            : isRecord(patch.validatedRange);
        if (!compatible) proposalIssues.push(issue('kind-mismatch', patch.id, 'Patch range does not match entry kind.'));
      }
    }

    const nextVersion = from.version + 1;
    const candidateEntries = from.entries.map((entry) => {
      const patch = changes.find((change) => isRecord(change) && change.id === entry.id);
      if (patch === undefined) return entry;
      return {
        ...cloneUnknown(entry),
        ...cloneUnknown(patch),
        id: entry.id,
        kind: entry.kind,
        registryVersion: nextVersion,
      } as TuningEntry;
    });
    if (proposalIssues.length === 0) {
      proposalIssues.push(...validateTuningEntries(candidateEntries, nextVersion));
    }

    this.#historySequence += 1;
    const proposalId = isRecord(proposal) && typeof proposal.proposalId === 'string'
      ? proposal.proposalId
      : '<invalid-proposal>';

    if (proposalIssues.length > 0) {
      const historyRecord: TuningProposalHistoryRecord = deepFreeze({
        sequence: this.#historySequence,
        proposalId,
        accepted: false,
        fromVersion: from.version,
        toVersion: null,
        changes: [],
        issues: proposalIssues,
      });
      this.#snapshot = makeSnapshot(
        this.registryId,
        from.version,
        from.entries,
        [...from.history, historyRecord],
      );
      return Object.freeze({
        accepted: false,
        snapshot: this.#snapshot,
        historyRecord,
        issues: historyRecord.issues,
      });
    }

    const acceptedEntries = candidateEntries.map(cloneAndFreezeEntry);
    const preliminary = makeSnapshot(this.registryId, nextVersion, acceptedEntries, from.history);
    const historyChanges = changes.map((patch) => ({
      id: patch.id,
      before: from.get(patch.id)!,
      after: preliminary.get(patch.id)!,
    }));
    const historyRecord: TuningProposalHistoryRecord = deepFreeze({
      sequence: this.#historySequence,
      proposalId,
      accepted: true,
      fromVersion: from.version,
      toVersion: nextVersion,
      changes: historyChanges,
      issues: [],
    });
    this.#snapshot = makeSnapshot(
      this.registryId,
      nextVersion,
      acceptedEntries,
      [...from.history, historyRecord],
    );
    return Object.freeze({ accepted: true, snapshot: this.#snapshot, historyRecord });
  }
}

export function createVersionedTuningRegistry(
  options: VersionedTuningRegistryOptions = {},
): VersionedTuningRegistry {
  return new VersionedTuningRegistry(options);
}

export const DEFAULT_TUNING_REGISTRY_SNAPSHOT: TuningRegistrySnapshot =
  new VersionedTuningRegistry().snapshot;

export const UNVERIFIED_TUNING_IDS: readonly string[] =
  DEFAULT_TUNING_REGISTRY_SNAPSHOT.unverifiedTuningIds;

export function getScalarTuningValue(
  snapshot: Pick<TuningRegistrySnapshot, 'get'>,
  id: string,
): number {
  const entry = snapshot.get(id);
  if (entry?.kind !== 'scalar') throw new TypeError(`Tuning entry ${id} is not scalar.`);
  return entry.value;
}

export function getVectorTuningValue(
  snapshot: Pick<TuningRegistrySnapshot, 'get'>,
  id: string,
): readonly number[] {
  const entry = snapshot.get(id);
  if (entry?.kind !== 'vector') throw new TypeError(`Tuning entry ${id} is not a vector.`);
  return entry.value;
}

export function getCurveTuningValue(
  snapshot: Pick<TuningRegistrySnapshot, 'get'>,
  id: string,
): StructuredCurve {
  const entry = snapshot.get(id);
  if (entry?.kind !== 'curve') throw new TypeError(`Tuning entry ${id} is not a curve.`);
  return entry.value;
}
