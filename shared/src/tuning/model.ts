/** Classification assigned to every tuning value in the versioned registry. */
export type TuningClassification =
  | 'confirmed-starting-target'
  | 'unverified-hypothesis';

/** Verification is explicit; passing a test never verifies a hypothesis by itself. */
export type TuningVerificationStatus = 'confirmed' | 'unverified' | 'verified';

export type TuningAffect = 'authority' | 'camera' | 'hud' | 'perceived-control';
export type TuningUnit = string;

export interface FiniteRange {
  readonly min: number;
  readonly max: number;
}

export interface CurveSample {
  readonly input: number;
  readonly output: number;
}

export type CurveOutputOrder = 'any' | 'non-increasing' | 'non-decreasing';

export interface StructuredCurve {
  readonly samples: readonly CurveSample[];
  readonly outputOrder: CurveOutputOrder;
}

export interface CurveValidatedRange {
  readonly input: FiniteRange;
  readonly output: FiniteRange;
}

export interface TuningEntryBase {
  readonly id: string;
  readonly label: string;
  /** Registry version in which this exact entry payload was last accepted. */
  readonly registryVersion: number;
  readonly unit: TuningUnit;
  readonly classification: TuningClassification;
  readonly verificationStatus: TuningVerificationStatus;
  readonly affects: readonly TuningAffect[];
  readonly evidenceId: string | null;
  readonly approvalId: string | null;
  readonly approvalRationale: string | null;
}

export interface ScalarTuningEntry extends TuningEntryBase {
  readonly kind: 'scalar';
  readonly value: number;
  readonly validatedRange: FiniteRange;
}

export interface VectorTuningEntry extends TuningEntryBase {
  readonly kind: 'vector';
  readonly value: readonly number[];
  readonly validatedRange: readonly FiniteRange[];
}

export interface CurveTuningEntry extends TuningEntryBase {
  readonly kind: 'curve';
  readonly value: StructuredCurve;
  readonly validatedRange: CurveValidatedRange;
}

export type TuningEntry = ScalarTuningEntry | VectorTuningEntry | CurveTuningEntry;
export type TuningValue = number | readonly number[] | StructuredCurve;
export type TuningValidatedRange = FiniteRange | readonly FiniteRange[] | CurveValidatedRange;

export type TuningValidationCode =
  | 'invalid-registry-version'
  | 'duplicate-entry'
  | 'unknown-entry'
  | 'duplicate-change'
  | 'empty-proposal'
  | 'version-conflict'
  | 'invalid-proposal-id'
  | 'invalid-patch-field'
  | 'invalid-id'
  | 'invalid-label'
  | 'invalid-unit'
  | 'invalid-classification'
  | 'invalid-verification-status'
  | 'invalid-affect'
  | 'invalid-link'
  | 'kind-mismatch'
  | 'non-finite-value'
  | 'non-finite-range'
  | 'range-order'
  | 'value-out-of-range'
  | 'vector-length'
  | 'curve-empty'
  | 'curve-input-order'
  | 'curve-output-order'
  | 'cross-entry-invariant';

export interface TuningValidationIssue {
  readonly code: TuningValidationCode;
  readonly entryId: string | null;
  readonly message: string;
}

/**
 * One atomic patch. Identity, kind, unit, classification, and affected domains
 * are immutable registry schema; verification can advance only through linked
 * evidence and approval fields validated by the registry.
 */
export interface TuningEntryPatch {
  readonly id: string;
  readonly label?: string;
  readonly value?: TuningValue;
  readonly validatedRange?: TuningValidatedRange;
  readonly evidenceId?: string | null;
  readonly approvalId?: string | null;
  readonly approvalRationale?: string | null;
  readonly verificationStatus?: TuningVerificationStatus;
}

export interface TuningProposal {
  readonly proposalId: string;
  readonly expectedVersion?: number;
  readonly changes: readonly TuningEntryPatch[];
}

export interface TuningHistoryChange {
  readonly id: string;
  readonly before: TuningEntry;
  readonly after: TuningEntry;
}

export interface TuningProposalHistoryRecord {
  readonly sequence: number;
  readonly proposalId: string;
  readonly accepted: boolean;
  readonly fromVersion: number;
  readonly toVersion: number | null;
  readonly changes: readonly TuningHistoryChange[];
  readonly issues: readonly TuningValidationIssue[];
}

export interface TuningRegistrySnapshot {
  readonly registryId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly entries: readonly TuningEntry[];
  readonly history: readonly TuningProposalHistoryRecord[];
  readonly unverifiedTuningIds: readonly string[];
  get(id: string): TuningEntry | undefined;
  has(id: string): boolean;
}

export interface RoomPinnedTuningSnapshot extends TuningRegistrySnapshot {
  readonly roomId: string;
  readonly snapshotId: string;
}

export type TuningProposalResult =
  | {
    readonly accepted: true;
    readonly snapshot: TuningRegistrySnapshot;
    readonly historyRecord: TuningProposalHistoryRecord;
  }
  | {
    readonly accepted: false;
    readonly snapshot: TuningRegistrySnapshot;
    readonly historyRecord: TuningProposalHistoryRecord;
    readonly issues: readonly TuningValidationIssue[];
  };

export interface ReferenceEvidenceRecord {
  readonly id: string;
  readonly tuningId: string;
  readonly registryVersion: number;
  readonly sourceIdentity: string;
  readonly sourceVersionOrAccessDate: string;
  readonly originalValueAndUnit: string;
  readonly conversion: string;
  readonly resultingValueAndRange: string;
  readonly approvalStatus: 'pending' | 'approved' | 'rejected';
}

export interface TuningApprovalRecord {
  readonly id: string;
  readonly tuningId: string;
  readonly registryVersion: number;
  readonly deterministicHarnessEvidence: readonly string[];
  readonly browserEvidence: readonly string[];
  readonly approvedBy: string;
  readonly approvedAt: string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

/** Stable IDs shared by mechanics, arena descriptors, tests, and evidence files. */
export const TUNING_IDS = deepFreeze({
  physics: {
    fixedStepSeconds: 'physics.fixed-step-seconds',
    gravityY: 'physics.gravity-y',
  },
  car: {
    collider: {
      length: 'car.collider.length',
      width: 'car.collider.width',
      height: 'car.collider.height',
    },
    mass: 'car.mass',
    maxLinearSpeed: 'car.max-linear-speed',
    maxAngularSpeed: 'car.max-angular-speed',
    throttle: {
      targetSpeed: 'car.throttle.target-speed',
      accelerationCurve: 'car.throttle.acceleration-curve',
    },
    boost: {
      acceleration: 'car.boost.acceleration',
      initialInventory: 'car.boost.initial-inventory',
      consumptionPerSecond: 'car.boost.consumption-per-second',
    },
    steering: {
      curvatureCurve: 'car.steering.curvature-curve',
      normalGripRate: 'car.steering.normal-grip-rate',
      powerslideGripRate: 'car.steering.powerslide-grip-rate',
      powerslideCurvatureMultiplier: 'car.steering.powerslide-curvature-multiplier',
    },
    aerodynamicDragCoefficient: 'car.aerodynamic-drag.coefficient',
    /**
     * Airborne rotation authority. Rocket League drives each local axis with its
     * own torque and its own damping, which is why roll snaps and yaw is heavy.
     */
    air: {
      pitchTorque: 'car.air.pitch-torque',
      yawTorque: 'car.air.yaw-torque',
      rollTorque: 'car.air.roll-torque',
      pitchDamping: 'car.air.pitch-damping',
      yawDamping: 'car.air.yaw-damping',
      rollDamping: 'car.air.roll-damping',
    },
    jump: {
      firstVelocityChange: 'car.jump.first-velocity-change',
      holdForce: 'car.jump.hold-force',
      holdDuration: 'car.jump.hold-duration',
      secondJumpWindow: 'car.jump.second-window',
      flipActuationWindow: 'car.jump.flip-actuation-window',
      directionalDeadzone: 'car.jump.directional-deadzone',
    },
  },
  ball: {
    radius: 'ball.radius',
    mass: 'ball.mass',
    restitution: 'ball.restitution',
    linearDamping: 'ball.linear-damping',
    maxLinearSpeed: 'ball.max-linear-speed',
    maxAngularSpeed: 'ball.max-angular-speed',
  },
  support: {
    contactPoints: 'support.contact-points',
    rayDistance: 'support.ray-distance',
    normalAngleThresholdDegrees: 'support.normal-angle-threshold-degrees',
  },
  boostPads: {
    largePositions: [
      'boost-pad.large.0.position',
      'boost-pad.large.1.position',
      'boost-pad.large.2.position',
      'boost-pad.large.3.position',
      'boost-pad.large.4.position',
      'boost-pad.large.5.position',
    ],
    largeSensorHalfExtents: 'boost-pad.large.sensor-half-extents',
    smallSensorHalfExtents: 'boost-pad.small.sensor-half-extents',
  },
  camera: {
    ball: {
      distance: 'camera.ball.distance',
      height: 'camera.ball.height',
      lookAhead: 'camera.ball.look-ahead',
      fieldOfViewDegrees: 'camera.ball.field-of-view-degrees',
    },
    spring: {
      distance: 'camera.spring.distance',
      height: 'camera.spring.height',
      stiffness: 'camera.spring.stiffness',
      damping: 'camera.spring.damping',
      lookAhead: 'camera.spring.look-ahead',
      fieldOfViewDegrees: 'camera.spring.field-of-view-degrees',
    },
  },
  match: {
    regulationGoalResetSeconds: 'match.regulation-goal-reset-seconds',
  },
} as const);
