import {
  MATCH_PHASES,
  REGULATION_GOAL_TARGET,
  REGULATION_WIN_MARGIN,
  ROOM_POLICIES,
  SNAPSHOT_PROTOCOL_VERSION,
  SnapshotContractError,
  parseSnapshotEnvelopeV2,
  type BallSnapshot,
  type CarSnapshot,
  type CountdownKind,
  type MatchPhase,
  type MatchTransitionSnapshot,
  type QuaternionTuple,
  type RoomMode,
  type RoomPolicyVersion,
  type RoomTeamCapacity,
  type RoomTotalCapacity,
  type SnapshotEnvelopeV2,
  type Team,
  type TerminalResult,
} from '@rocket-arena/shared';

export const LEGACY_SNAPSHOT_PROTOCOL_VERSION = 1 as const;
export type LegacySnapshotProtocolVersion = typeof LEGACY_SNAPSHOT_PROTOCOL_VERSION;
export type SnapshotWireFormat = 'v2' | 'legacy-v1';

export interface LegacySnapshotV1Entity {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly qx: number;
  readonly qy: number;
  readonly qz: number;
  readonly qw: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
}

export interface LegacySnapshotV1Player extends LegacySnapshotV1Entity {
  readonly boost: number;
  readonly team: Team;
  readonly name: string;
  readonly isHost: boolean;
}

/** The current unversioned, keyed state-sync payload retained only for migration. */
export interface LegacySnapshotV1 {
  readonly sequence: number;
  readonly serverTime: number;
  readonly simulationTime: number;
  readonly players: Readonly<Record<string, LegacySnapshotV1Player>>;
  readonly ball: LegacySnapshotV1Entity;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly timeRemaining: number;
  readonly phase: MatchPhase;
}

/**
 * Records what the wire format can prove. A keyed V1 player record has already
 * collapsed duplicate keys and has no authoritative terminal event identity.
 */
export interface SnapshotValidationEvidence {
  readonly duplicateIdentityProof: boolean;
  readonly terminalEventIdentityProof: boolean;
  readonly finalReleaseProtocolProof: boolean;
}

export interface DomainSnapshot extends Omit<SnapshotEnvelopeV2, 'protocolVersion'> {
  readonly protocolVersion: typeof SNAPSHOT_PROTOCOL_VERSION | LegacySnapshotProtocolVersion;
  readonly wireFormat: SnapshotWireFormat;
  readonly validationEvidence: SnapshotValidationEvidence;
}

export const SNAPSHOT_VALIDATION_ERROR_CODES = Object.freeze([
  'malformed-snapshot',
  'unsupported-protocol-version',
  'mixed-protocol-payload',
  'room-mode-mismatch',
  'policy-mismatch',
  'capacity-exceeded',
  'duplicate-identity',
  'invalid-team',
  'invalid-phase',
  'non-finite-number',
  'number-out-of-range',
  'invalid-quaternion',
  'sequence-regression',
  'simulation-time-regression',
  'terminal-coherence',
  'terminal-payload-changed',
  'legacy-terminal-unverifiable',
  'protocol-downgrade',
] as const);

export type SnapshotValidationErrorCode = (typeof SNAPSHOT_VALIDATION_ERROR_CODES)[number];

export class SnapshotValidationError extends Error {
  readonly code: SnapshotValidationErrorCode;
  readonly path: string | null;

  constructor(code: SnapshotValidationErrorCode, message: string, path: string | null = null) {
    super(message);
    this.name = 'SnapshotValidationError';
    this.code = code;
    this.path = path;
  }
}

export interface SnapshotValidationContext {
  readonly roomMode: RoomMode;
  readonly previousSnapshot?: Readonly<DomainSnapshot> | null;
}

export type SnapshotValidationResult =
  | Readonly<{ ok: true; snapshot: Readonly<DomainSnapshot> }>
  | Readonly<{ ok: false; error: SnapshotValidationError }>;

const V2_VALIDATION_EVIDENCE = Object.freeze({
  duplicateIdentityProof: true,
  terminalEventIdentityProof: true,
  finalReleaseProtocolProof: true,
} satisfies SnapshotValidationEvidence);

const LEGACY_VALIDATION_EVIDENCE = Object.freeze({
  duplicateIdentityProof: false,
  terminalEventIdentityProof: false,
  finalReleaseProtocolProof: false,
} satisfies SnapshotValidationEvidence);

function fail(
  code: SnapshotValidationErrorCode,
  path: string,
  message: string,
): never {
  throw new SnapshotValidationError(code, `${path}: ${message}`, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail('malformed-snapshot', path, 'expected an object');
  return value;
}

function finiteNumberAt(
  value: unknown,
  path: string,
  minimum?: number,
  maximum?: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('non-finite-number', path, 'expected a finite number');
  }
  if (minimum !== undefined && value < minimum) {
    fail('number-out-of-range', path, `must be at least ${minimum}`);
  }
  if (maximum !== undefined && value > maximum) {
    fail('number-out-of-range', path, `must be at most ${maximum}`);
  }
  return value;
}

function safeIntegerAt(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail('number-out-of-range', path, `expected a safe integer at least ${minimum}`);
  }
  return value as number;
}

function stringAt(value: unknown, path: string, allowEmpty = true): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    fail(
      'malformed-snapshot',
      path,
      allowEmpty ? 'expected a string' : 'expected a non-empty string',
    );
  }
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('malformed-snapshot', path, 'expected a boolean');
  return value;
}

function teamAt(value: unknown, path: string): Team {
  if (value !== 'blue' && value !== 'orange') {
    fail('invalid-team', path, `unsupported team ${String(value)}`);
  }
  return value;
}

function phaseAt(value: unknown, path: string): MatchPhase {
  if (
    typeof value !== 'string'
    || !MATCH_PHASES.some((phase) => phase === value)
  ) {
    fail('invalid-phase', path, `unsupported phase ${String(value)}`);
  }
  return value as MatchPhase;
}

function normalizeQuaternion(
  value: readonly [number, number, number, number],
  path: string,
): QuaternionTuple {
  const magnitude = Math.hypot(value[0], value[1], value[2], value[3]);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    fail('invalid-quaternion', path, 'expected a finite non-zero quaternion');
  }

  const normalized = value.map((component) => component / magnitude) as [
    number,
    number,
    number,
    number,
  ];
  if (!normalized.every(Number.isFinite)) {
    fail('invalid-quaternion', path, 'normalization produced a non-finite component');
  }
  return Object.freeze(normalized);
}

function legacyEntityAt(
  value: unknown,
  path: string,
): Readonly<LegacySnapshotV1Entity> {
  const record = recordAt(value, path);
  return Object.freeze({
    x: finiteNumberAt(record.x, `${path}.x`),
    y: finiteNumberAt(record.y, `${path}.y`),
    z: finiteNumberAt(record.z, `${path}.z`),
    qx: finiteNumberAt(record.qx, `${path}.qx`),
    qy: finiteNumberAt(record.qy, `${path}.qy`),
    qz: finiteNumberAt(record.qz, `${path}.qz`),
    qw: finiteNumberAt(record.qw, `${path}.qw`),
    vx: finiteNumberAt(record.vx, `${path}.vx`),
    vy: finiteNumberAt(record.vy, `${path}.vy`),
    vz: finiteNumberAt(record.vz, `${path}.vz`),
  });
}

function normalizeLegacyEntity(
  entity: Readonly<LegacySnapshotV1Entity>,
  path: string,
): Pick<CarSnapshot, 'position' | 'rotation' | 'linearVelocity'> {
  return {
    position: Object.freeze([entity.x, entity.y, entity.z] as const),
    rotation: normalizeQuaternion(
      [entity.qx, entity.qy, entity.qz, entity.qw],
      `${path}.rotation`,
    ),
    linearVelocity: Object.freeze([entity.vx, entity.vy, entity.vz] as const),
  };
}

function validateHostPolicy(
  roomMode: RoomMode,
  phase: MatchPhase,
  cars: readonly CarSnapshot[],
): void {
  const hostCount = cars.reduce((count, car) => count + (car.isHost ? 1 : 0), 0);
  if (roomMode === 'quick' && hostCount !== 0) {
    fail('policy-mismatch', 'snapshot.cars', 'Quick Match cannot assign a Host');
  }
  if (hostCount > 1) {
    fail('policy-mismatch', 'snapshot.cars', 'at most one car may carry Host metadata');
  }
  if (
    roomMode === 'custom'
    && cars.length > 0
    && (phase === 'waiting' || phase === 'countdown')
    && hostCount !== 1
  ) {
    fail(
      'policy-mismatch',
      'snapshot.cars',
      'non-empty Custom waiting/countdown state requires exactly one Host',
    );
  }
}

function validateTerminalSemantics(snapshot: SnapshotEnvelopeV2): void {
  if (snapshot.phase !== 'ended') {
    if ((snapshot.latestTransition?.terminal ?? null) !== null) {
      fail(
        'terminal-coherence',
        'snapshot.latestTransition',
        'a non-ended phase cannot carry a terminal transition',
      );
    }
    return;
  }

  const terminal = snapshot.terminalResult;
  if (terminal === null) {
    fail('terminal-coherence', 'snapshot.terminalResult', 'Ended_State requires a result');
  }

  if (terminal.reason === 'regulation-target-and-margin') {
    const winnerScore = terminal.winner === 'blue' ? terminal.blueScore : terminal.orangeScore;
    const loserScore = terminal.winner === 'blue' ? terminal.orangeScore : terminal.blueScore;
    if (
      winnerScore < REGULATION_GOAL_TARGET
      || winnerScore - loserScore < REGULATION_WIN_MARGIN
    ) {
      fail(
        'terminal-coherence',
        'snapshot.terminalResult',
        'regulation terminal score must satisfy the shared goal-target and win-margin rule',
      );
    }
  }
}

function normalizeV2Snapshot(
  snapshot: Readonly<SnapshotEnvelopeV2>,
  expectedRoomMode: RoomMode,
): Readonly<DomainSnapshot> {
  if (snapshot.roomMode !== expectedRoomMode) {
    fail(
      'room-mode-mismatch',
      'snapshot.roomMode',
      `joined ${expectedRoomMode} room received ${snapshot.roomMode} policy`,
    );
  }

  validateHostPolicy(snapshot.roomMode, snapshot.phase, snapshot.cars);
  validateTerminalSemantics(snapshot);

  const cars = Object.freeze(snapshot.cars.map((car, index): Readonly<CarSnapshot> => Object.freeze({
    sessionId: car.sessionId,
    team: car.team,
    name: car.name,
    isHost: car.isHost,
    position: car.position,
    rotation: normalizeQuaternion(car.rotation, `snapshot.cars[${index}].rotation`),
    linearVelocity: car.linearVelocity,
    boost: car.boost,
  })));
  const ball = Object.freeze({
    position: snapshot.ball.position,
    rotation: normalizeQuaternion(snapshot.ball.rotation, 'snapshot.ball.rotation'),
    linearVelocity: snapshot.ball.linearVelocity,
  } satisfies BallSnapshot);

  return Object.freeze({
    ...snapshot,
    protocolVersion: SNAPSHOT_PROTOCOL_VERSION,
    wireFormat: 'v2',
    validationEvidence: V2_VALIDATION_EVIDENCE,
    cars,
    ball,
  });
}

function adaptLegacySnapshotV1OrThrow(
  value: unknown,
  roomMode: RoomMode,
): Readonly<DomainSnapshot> {
  const record = recordAt(value, 'snapshot');
  if (Object.prototype.hasOwnProperty.call(record, 'protocolVersion')) {
    fail(
      'unsupported-protocol-version',
      'snapshot.protocolVersion',
      'LegacySnapshotV1 must be unversioned',
    );
  }
  if (Object.prototype.hasOwnProperty.call(record, 'cars')) {
    fail(
      'mixed-protocol-payload',
      'snapshot.cars',
      'unversioned V1 payload cannot carry the V2 cars field',
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(record, 'terminalResult')
    || Object.prototype.hasOwnProperty.call(record, 'latestTransition')
    || Object.prototype.hasOwnProperty.call(record, 'winner')
  ) {
    fail(
      'mixed-protocol-payload',
      'snapshot',
      'unversioned V1 payload cannot claim V2 terminal identity fields',
    );
  }

  const policy = ROOM_POLICIES[roomMode];
  const phase = phaseAt(record.phase, 'snapshot.phase');
  if (phase === 'ended') {
    fail(
      'legacy-terminal-unverifiable',
      'snapshot.phase',
      'LegacySnapshotV1 cannot prove winner, terminal reason, or transition identity',
    );
  }

  const players = recordAt(record.players, 'snapshot.players');
  const entries = Object.entries(players);
  if (entries.length > policy.totalCapacity || entries.length > 8) {
    fail('capacity-exceeded', 'snapshot.players', 'player count exceeds joined room capacity');
  }

  let blueCount = 0;
  let orangeCount = 0;
  const cars = Object.freeze(entries.map(([sessionId, value], index): Readonly<CarSnapshot> => {
    stringAt(sessionId, `snapshot.players key ${index}`, false);
    const path = `snapshot.players[${JSON.stringify(sessionId)}]`;
    const entity = legacyEntityAt(value, path);
    const player = recordAt(value, path);
    const team = teamAt(player.team, `${path}.team`);
    if (team === 'blue') blueCount += 1;
    else orangeCount += 1;

    return Object.freeze({
      sessionId,
      team,
      name: stringAt(player.name, `${path}.name`),
      isHost: booleanAt(player.isHost, `${path}.isHost`),
      ...normalizeLegacyEntity(entity, path),
      boost: finiteNumberAt(player.boost, `${path}.boost`, 0, 100),
    });
  }));

  if (blueCount > policy.teamCapacity || orangeCount > policy.teamCapacity) {
    fail('capacity-exceeded', 'snapshot.players', 'team occupancy exceeds joined room policy');
  }
  validateHostPolicy(roomMode, phase, cars);

  const legacyBall = legacyEntityAt(record.ball, 'snapshot.ball');
  const ball = Object.freeze(normalizeLegacyEntity(legacyBall, 'snapshot.ball')) as Readonly<BallSnapshot>;
  const timeRemaining = finiteNumberAt(record.timeRemaining, 'snapshot.timeRemaining', 0);

  return Object.freeze({
    protocolVersion: LEGACY_SNAPSHOT_PROTOCOL_VERSION,
    policyVersion: policy.version as RoomPolicyVersion,
    roomMode,
    totalCapacity: policy.totalCapacity as RoomTotalCapacity,
    teamCapacity: policy.teamCapacity as RoomTeamCapacity,
    sequence: safeIntegerAt(record.sequence, 'snapshot.sequence'),
    serverTime: finiteNumberAt(record.serverTime, 'snapshot.serverTime', 0),
    simulationTime: finiteNumberAt(record.simulationTime, 'snapshot.simulationTime', 0),
    phase,
    countdownKind: null as CountdownKind | null,
    phaseSecondsRemaining: phase === 'countdown' ? timeRemaining : 0,
    regulationSecondsRemaining: phase === 'countdown' ? 0 : timeRemaining,
    kickoffEpoch: 0,
    blueScore: safeIntegerAt(record.blueScore, 'snapshot.blueScore'),
    orangeScore: safeIntegerAt(record.orangeScore, 'snapshot.orangeScore'),
    winner: null,
    terminalResult: null,
    latestTransition: null,
    cars,
    ball,
    // The legacy wire format carries no pad state at all, so nothing is reported
    // as spent. Presentation then draws every pad available, which is the honest
    // reading of a snapshot that cannot say otherwise.
    boostPadCooldowns: Object.freeze([]),
    wireFormat: 'legacy-v1',
    validationEvidence: LEGACY_VALIDATION_EVIDENCE,
  });
}

function sameTerminalPayload(
  left: Readonly<DomainSnapshot>,
  right: Readonly<DomainSnapshot>,
): boolean {
  return left.blueScore === right.blueScore
    && left.orangeScore === right.orangeScore
    && left.winner === right.winner
    && JSON.stringify(left.terminalResult) === JSON.stringify(right.terminalResult)
    && JSON.stringify(left.latestTransition) === JSON.stringify(right.latestTransition);
}

function validateStreamProgression(
  candidate: Readonly<DomainSnapshot>,
  previous: Readonly<DomainSnapshot> | null | undefined,
): void {
  if (previous === null || previous === undefined) return;

  if (candidate.roomMode !== previous.roomMode) {
    fail(
      'room-mode-mismatch',
      'snapshot.roomMode',
      'a snapshot stream cannot change joined room mode',
    );
  }
  if (candidate.sequence <= previous.sequence) {
    fail(
      'sequence-regression',
      'snapshot.sequence',
      `expected a value greater than ${previous.sequence}`,
    );
  }
  if (candidate.simulationTime < previous.simulationTime) {
    fail(
      'simulation-time-regression',
      'snapshot.simulationTime',
      `expected a value at least ${previous.simulationTime}`,
    );
  }
  if (previous.wireFormat === 'v2' && candidate.wireFormat === 'legacy-v1') {
    fail(
      'protocol-downgrade',
      'snapshot',
      'a stream cannot return to LegacySnapshotV1 after accepting V2',
    );
  }

  if (previous.phase === 'ended') {
    if (candidate.phase !== 'ended' || candidate.wireFormat !== 'v2') {
      fail(
        'terminal-payload-changed',
        'snapshot.phase',
        'a committed terminal transition cannot return to a non-terminal payload',
      );
    }
    if (!sameTerminalPayload(previous, candidate)) {
      fail(
        'terminal-payload-changed',
        'snapshot.terminalResult',
        'repeated Ended_State snapshots must retain the immutable terminal payload',
      );
    }
  }
}

function sharedContractError(error: SnapshotContractError): SnapshotValidationError {
  const message = error.message;
  const path = message.split(':', 1)[0] || null;
  let code: SnapshotValidationErrorCode = 'malformed-snapshot';

  if (message.includes('duplicate sessionId')) code = 'duplicate-identity';
  else if (
    message.includes('car count exceeds')
    || message.includes('team occupancy exceeds')
  ) code = 'capacity-exceeded';
  else if (
    message.includes('policyVersion')
    || message.includes('totalCapacity')
    || message.includes('teamCapacity')
    || message.includes('Quick Match cannot assign a Host')
  ) code = 'policy-mismatch';
  else if (message.includes('.team') && message.includes('unsupported value')) code = 'invalid-team';
  else if (
    message.includes('snapshot.phase')
    || message.includes('snapshot.countdownKind')
  ) code = 'invalid-phase';
  else if (message.includes('finite number')) code = 'non-finite-number';
  else if (message.includes('quaternion')) code = 'invalid-quaternion';
  else if (
    message.includes('must be at least')
    || message.includes('must be at most')
    || message.includes('safe integer')
  ) code = 'number-out-of-range';
  else if (
    message.includes('ended phase')
    || message.includes('terminal')
    || message.includes('event IDs must agree')
    || message.includes('winner')
    || message.includes('hard cutoff')
    || message.includes('terminal goal')
  ) code = 'terminal-coherence';

  return new SnapshotValidationError(code, message, path);
}

function normalizeError(error: unknown): SnapshotValidationError {
  if (error instanceof SnapshotValidationError) return error;
  if (error instanceof SnapshotContractError) return sharedContractError(error);
  return new SnapshotValidationError(
    'malformed-snapshot',
    error instanceof Error ? error.message : String(error),
  );
}

function success(snapshot: Readonly<DomainSnapshot>): SnapshotValidationResult {
  return Object.freeze({ ok: true, snapshot });
}

function failure(error: unknown): SnapshotValidationResult {
  return Object.freeze({ ok: false, error: normalizeError(error) });
}

function validateContext(context: SnapshotValidationContext): void {
  if (context.roomMode !== 'quick' && context.roomMode !== 'custom') {
    fail(
      'room-mode-mismatch',
      'context.roomMode',
      `unsupported joined room mode ${String(context.roomMode)}`,
    );
  }
}

/**
 * Decode one unknown state-sync payload without changing the payload, previous
 * accepted state, or validator-owned state. The caller decides whether to
 * commit a successful immutable candidate.
 */
export function decodeSnapshot(
  value: unknown,
  context: SnapshotValidationContext,
): SnapshotValidationResult {
  try {
    validateContext(context);
    const record = recordAt(value, 'snapshot');
    const hasProtocolVersion = Object.prototype.hasOwnProperty.call(record, 'protocolVersion');
    let candidate: Readonly<DomainSnapshot>;

    if (hasProtocolVersion) {
      if (record.protocolVersion !== SNAPSHOT_PROTOCOL_VERSION) {
        fail(
          'unsupported-protocol-version',
          'snapshot.protocolVersion',
          `expected ${SNAPSHOT_PROTOCOL_VERSION} or an unversioned LegacySnapshotV1 payload`,
        );
      }
      if (Object.prototype.hasOwnProperty.call(record, 'players')) {
        fail(
          'mixed-protocol-payload',
          'snapshot.players',
          'V2 payload cannot carry the keyed V1 players field',
        );
      }
      candidate = normalizeV2Snapshot(parseSnapshotEnvelopeV2(value), context.roomMode);
    } else {
      candidate = adaptLegacySnapshotV1OrThrow(value, context.roomMode);
    }

    validateStreamProgression(candidate, context.previousSnapshot);
    return success(candidate);
  } catch (error) {
    return failure(error);
  }
}

/** Force the temporary V1 branch while retaining the same typed result API. */
export function adaptLegacySnapshotV1(
  value: unknown,
  context: SnapshotValidationContext,
): SnapshotValidationResult {
  try {
    validateContext(context);
    const candidate = adaptLegacySnapshotV1OrThrow(value, context.roomMode);
    validateStreamProgression(candidate, context.previousSnapshot);
    return success(candidate);
  } catch (error) {
    return failure(error);
  }
}

export function isV2DomainSnapshot(
  snapshot: DomainSnapshot,
): snapshot is DomainSnapshot & { readonly protocolVersion: 2; readonly wireFormat: 'v2' } {
  return snapshot.wireFormat === 'v2' && snapshot.protocolVersion === SNAPSHOT_PROTOCOL_VERSION;
}

export function hasFinalReleaseProtocolProof(snapshot: DomainSnapshot): boolean {
  return snapshot.validationEvidence.finalReleaseProtocolProof;
}

export type {
  MatchTransitionSnapshot,
  TerminalResult,
};
