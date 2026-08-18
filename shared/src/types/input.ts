export const INPUT_PROTOCOL_VERSION = 2 as const;
export type InputProtocolVersion = typeof INPUT_PROTOCOL_VERSION;

export const NORMALIZED_INPUT_MIN = -1 as const;
export const NORMALIZED_INPUT_MAX = 1 as const;

/**
 * Versioned control intent. This contract deliberately contains no transform,
 * contact, inventory, score, team, winner, or match-phase authority.
 */
export interface InputCommandV2 {
  readonly protocolVersion: InputProtocolVersion;
  readonly throttle: number;
  readonly steer: number;
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
  readonly jumpHeld: boolean;
  readonly jumpSequence: number;
  readonly boostHeld: boolean;
  readonly powerslideHeld: boolean;
  readonly cameraToggleSequence: number;
}

export interface InputEdgeSequences {
  readonly jumpSequence: number;
  readonly cameraToggleSequence: number;
}

/** Fields a client input message must never use to claim authoritative state. */
export const AUTHORITATIVE_INPUT_FIELDS = Object.freeze([
  'x',
  'y',
  'z',
  'qx',
  'qy',
  'qz',
  'qw',
  'position',
  'rotation',
  'transform',
  'velocity',
  'linearVelocity',
  'angularVelocity',
  'contact',
  'contacts',
  'boost',
  'boostAmount',
  'boostInventory',
  'score',
  'blueScore',
  'orangeScore',
  'team',
  'isHost',
  'phase',
  'matchPhase',
  'winner',
  'terminalResult',
  'latestTransition',
  'roomMode',
  'policyVersion',
  'totalCapacity',
  'teamCapacity',
  'kickoffEpoch',
  'serverTime',
  'simulationTime',
] as const);

const authoritativeInputFieldSet = new Set<string>(
  AUTHORITATIVE_INPUT_FIELDS.map((field) => field.toLowerCase()),
);

export class InputContractError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'InputContractError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInputEdgeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNormalizedAxis(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= NORMALIZED_INPUT_MIN
    && value <= NORMALIZED_INPUT_MAX;
}

function normalizeAxis(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(NORMALIZED_INPUT_MIN, Math.min(NORMALIZED_INPUT_MAX, value));
}

function normalizeEdgeSequence(value: unknown, previous: number): number {
  return isInputEdgeSequence(value) && value >= previous ? value : previous;
}

/**
 * Recursively detect forged authoritative state before any control component is
 * consumed. The recursion catches common wrappers such as `{ car: { position } }`.
 */
export function findAuthoritativeInputField(value: unknown): string | null {
  const visited = new WeakSet<object>();

  function visit(candidate: unknown): string | null {
    if (typeof candidate !== 'object' || candidate === null) return null;
    if (visited.has(candidate)) return null;
    visited.add(candidate);

    for (const [field, child] of Object.entries(candidate)) {
      if (authoritativeInputFieldSet.has(field.toLowerCase())) return field;
      const nested = visit(child);
      if (nested !== null) return nested;
    }
    return null;
  }

  return visit(value);
}

/** Strict structural predicate for an already-normalized V2 command. */
export function isInputCommandV2(
  value: unknown,
  previousEdges: InputEdgeSequences = { jumpSequence: 0, cameraToggleSequence: 0 },
): value is InputCommandV2 {
  if (!isRecord(value) || value.protocolVersion !== INPUT_PROTOCOL_VERSION) return false;
  if (findAuthoritativeInputField(value) !== null) return false;

  return isNormalizedAxis(value.throttle)
    && isNormalizedAxis(value.steer)
    && isNormalizedAxis(value.pitch)
    && isNormalizedAxis(value.yaw)
    && isNormalizedAxis(value.roll)
    && typeof value.jumpHeld === 'boolean'
    && typeof value.boostHeld === 'boolean'
    && typeof value.powerslideHeld === 'boolean'
    && isInputEdgeSequence(value.jumpSequence)
    && value.jumpSequence >= previousEdges.jumpSequence
    && isInputEdgeSequence(value.cameraToggleSequence)
    && value.cameraToggleSequence >= previousEdges.cameraToggleSequence;
}

export function assertInputCommandV2(
  value: unknown,
  previousEdges?: InputEdgeSequences,
): asserts value is InputCommandV2 {
  if (!isInputCommandV2(value, previousEdges)) {
    throw new InputContractError('Input is not a normalized, monotonic V2 control command.');
  }
}

/**
 * Normalize independent controls while preserving monotonic edge floors.
 * Malformed axes become neutral without erasing other valid components.
 * Authoritative-looking fields are rejected rather than copied or trusted.
 */
export function normalizeInputCommandV2(
  value: unknown,
  previousEdges: InputEdgeSequences = { jumpSequence: 0, cameraToggleSequence: 0 },
): Readonly<InputCommandV2> {
  if (!isRecord(value)) {
    throw new InputContractError('Input command must be an object.');
  }
  if (value.protocolVersion !== INPUT_PROTOCOL_VERSION) {
    throw new InputContractError(`Unsupported input protocol version: ${String(value.protocolVersion)}.`);
  }

  const authoritativeField = findAuthoritativeInputField(value);
  if (authoritativeField !== null) {
    throw new InputContractError(
      `Input command cannot contain authoritative field "${authoritativeField}".`,
    );
  }

  return Object.freeze({
    protocolVersion: INPUT_PROTOCOL_VERSION,
    throttle: normalizeAxis(value.throttle),
    steer: normalizeAxis(value.steer),
    pitch: normalizeAxis(value.pitch),
    yaw: normalizeAxis(value.yaw),
    roll: normalizeAxis(value.roll),
    jumpHeld: value.jumpHeld === true,
    jumpSequence: normalizeEdgeSequence(value.jumpSequence, previousEdges.jumpSequence),
    boostHeld: value.boostHeld === true,
    powerslideHeld: value.powerslideHeld === true,
    cameraToggleSequence: normalizeEdgeSequence(
      value.cameraToggleSequence,
      previousEdges.cameraToggleSequence,
    ),
  });
}

/**
 * Legacy V1 transport shape retained only until the staged client/server V2
 * migration. New mechanics code should consume InputCommandV2.
 */
export interface InputPayload {
  /** Forward/backward: 1 = forward, -1 = brake/reverse, 0 = neutral. */
  throttle: number;
  /** Steering: 1 = left, -1 = right, 0 = straight. */
  steer: number;
  /** Current physical jump-key state for legacy boolean edge detection. */
  jump: boolean;
  /** Legacy boost-held control. */
  boost: boolean;
  /** Monotonic physical jump-press id used by compatible clients. */
  jumpSequence?: number;
}
