import {
  ROOM_POLICIES,
  type RoomPolicyVersion,
  type RoomTeamCapacity,
  type RoomTotalCapacity,
} from '../config/room-policies.js';
import {
  COUNTDOWN_KINDS,
  MATCH_PHASES,
  TEAMS,
  createGoalResult,
  createTerminalResult,
  isAuthoritativeEventId,
  type AuthoritativeTransitionId,
  type CountdownKind,
  type GoalResult,
  type MatchPhase,
  type RoomMode,
  type Team,
  type TerminalResult,
} from './room.js';

export const SNAPSHOT_PROTOCOL_VERSION = 2 as const;
export type SnapshotProtocolVersion = typeof SNAPSHOT_PROTOCOL_VERSION;
export type SnapshotSequence = number;

export type Vector3Tuple = readonly [number, number, number];
export type QuaternionTuple = readonly [number, number, number, number];

export interface CarSnapshot {
  readonly sessionId: string;
  readonly team: Team;
  readonly name: string;
  readonly isHost: boolean;
  readonly position: Vector3Tuple;
  readonly rotation: QuaternionTuple;
  readonly linearVelocity: Vector3Tuple;
  readonly boost: number;
}

export interface BallSnapshot {
  readonly position: Vector3Tuple;
  readonly rotation: QuaternionTuple;
  readonly linearVelocity: Vector3Tuple;
}

/**
 * One boost pad that is currently spent, and how long until it returns.
 *
 * Availability is authoritative: a client cannot work out that another player
 * took a pad, so presentation cannot honestly animate a recharge without being
 * told. Sending the remaining time rather than a bare spent flag means a client
 * that joins or reconnects part-way through a cooldown shows the correct progress
 * immediately instead of restarting the sweep from zero.
 *
 * Only spent pads are listed. Most of the time that is a short list or an empty
 * one, so the usual cost of carrying this is close to nothing, and the worst case
 * is bounded by the pad count.
 *
 * `index` is a position in the shared pad table that both the room and the
 * renderer resolve, which is the same table the room grants from. A positional
 * key is safe precisely because there is only one table; the protocol version
 * guards against a client whose table has a different length.
 */
export interface BoostPadCooldownSnapshot {
  readonly index: number;
  readonly secondsRemaining: number;
}

/** Bound on listed cooldowns, comfortably above the seeded pad count of 24. */
export const MAX_BOOST_PAD_COOLDOWNS = 64 as const;

export const MATCH_TRANSITION_KINDS = Object.freeze([
  'countdown',
  'regulation-goal-reset',
  'regulation-terminal-goal',
  'hard-cutoff',
  'overtime-entry',
  'overtime-terminal-goal',
] as const);
export type MatchTransitionKind = (typeof MATCH_TRANSITION_KINDS)[number];

/** One atomic, room-authored outcome consumed once by presentation systems. */
export interface MatchTransitionSnapshot {
  readonly eventId: AuthoritativeTransitionId;
  readonly kind: MatchTransitionKind;
  readonly goal: GoalResult | null;
  readonly terminal: TerminalResult | null;
}

export interface SnapshotEnvelopeV2 {
  readonly protocolVersion: SnapshotProtocolVersion;
  readonly policyVersion: RoomPolicyVersion;
  readonly roomMode: RoomMode;
  readonly totalCapacity: RoomTotalCapacity;
  readonly teamCapacity: RoomTeamCapacity;
  readonly sequence: SnapshotSequence;
  readonly serverTime: number;
  readonly simulationTime: number;
  readonly phase: MatchPhase;
  readonly countdownKind: CountdownKind | null;
  readonly phaseSecondsRemaining: number;
  readonly regulationSecondsRemaining: number;
  readonly kickoffEpoch: number;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly winner: Team | null;
  readonly terminalResult: TerminalResult | null;
  readonly latestTransition: MatchTransitionSnapshot | null;
  readonly cars: readonly CarSnapshot[];
  readonly ball: BallSnapshot;
  /** Spent boost pads only; an empty list means every pad is available. */
  readonly boostPadCooldowns: readonly BoostPadCooldownSnapshot[];
}

export class SnapshotContractError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotContractError';
  }
}

function fail(path: string, message: string): never {
  throw new SnapshotContractError(`${path}: ${message}`);
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function finiteNumberAt(value: unknown, path: string, minimum?: number, maximum?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  if (minimum !== undefined && value < minimum) fail(path, `must be at least ${minimum}`);
  if (maximum !== undefined && value > maximum) fail(path, `must be at most ${maximum}`);
  return value;
}

function safeIntegerAt(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(path, `expected a safe integer at least ${minimum}`);
  }
  return value as number;
}

function stringAt(value: unknown, path: string, allowEmpty = true): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    fail(path, allowEmpty ? 'expected a string' : 'expected a non-empty string');
  }
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}

function enumAt<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !values.some((candidate) => candidate === value)) {
    fail(path, `unsupported value ${String(value)}`);
  }
  return value as T;
}

function vector3At(value: unknown, path: string): Vector3Tuple {
  if (!Array.isArray(value) || value.length !== 3) fail(path, 'expected a three-component tuple');
  return Object.freeze([
    finiteNumberAt(value[0], `${path}[0]`),
    finiteNumberAt(value[1], `${path}[1]`),
    finiteNumberAt(value[2], `${path}[2]`),
  ] as const);
}

function quaternionAt(value: unknown, path: string): QuaternionTuple {
  if (!Array.isArray(value) || value.length !== 4) fail(path, 'expected a four-component tuple');
  const rotation = [
    finiteNumberAt(value[0], `${path}[0]`),
    finiteNumberAt(value[1], `${path}[1]`),
    finiteNumberAt(value[2], `${path}[2]`),
    finiteNumberAt(value[3], `${path}[3]`),
  ] as const;
  if (rotation.every((component) => component === 0)) fail(path, 'quaternion cannot be zero');
  return Object.freeze(rotation);
}

function teamAt(value: unknown, path: string): Team {
  return enumAt(value, TEAMS, path);
}

function nullableTeamAt(value: unknown, path: string): Team | null {
  return value === null ? null : teamAt(value, path);
}

function phaseAt(value: unknown, path: string): MatchPhase {
  return enumAt(value, MATCH_PHASES, path);
}

function countdownKindAt(value: unknown, path: string): CountdownKind | null {
  return value === null ? null : enumAt(value, COUNTDOWN_KINDS, path);
}

function goalResultAt(value: unknown, path: string): Readonly<GoalResult> {
  const record = recordAt(value, path);
  try {
    return createGoalResult({
      eventId: safeIntegerAt(record.eventId, `${path}.eventId`),
      team: teamAt(record.team, `${path}.team`),
      kickoffEpoch: safeIntegerAt(record.kickoffEpoch, `${path}.kickoffEpoch`),
      blueScore: safeIntegerAt(record.blueScore, `${path}.blueScore`),
      orangeScore: safeIntegerAt(record.orangeScore, `${path}.orangeScore`),
    });
  } catch (error) {
    fail(path, error instanceof Error ? error.message : String(error));
  }
}

function terminalResultAt(value: unknown, path: string): Readonly<TerminalResult> {
  const record = recordAt(value, path);
  try {
    return createTerminalResult({
      eventId: safeIntegerAt(record.eventId, `${path}.eventId`),
      reason: enumAt(
        record.reason,
        ['regulation-target-and-margin', 'hard-regulation-cutoff', 'overtime-goal'] as const,
        `${path}.reason`,
      ),
      winner: teamAt(record.winner, `${path}.winner`),
      blueScore: safeIntegerAt(record.blueScore, `${path}.blueScore`),
      orangeScore: safeIntegerAt(record.orangeScore, `${path}.orangeScore`),
      goal: record.goal === null ? null : goalResultAt(record.goal, `${path}.goal`),
    });
  } catch (error) {
    fail(path, error instanceof Error ? error.message : String(error));
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function boostPadCooldownsAt(
  value: unknown,
  path: string,
): readonly Readonly<BoostPadCooldownSnapshot>[] {
  // Absent reads as nothing on cooldown. That is the truthful interpretation of a
  // snapshot that carries no pad state, and it keeps this field additive rather
  // than invalidating every envelope produced before it existed.
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) fail(path, 'expected an array');
  if (value.length > MAX_BOOST_PAD_COOLDOWNS) {
    fail(path, `at most ${MAX_BOOST_PAD_COOLDOWNS} pads may be listed`);
  }

  const seen = new Set<number>();
  const entries = value.map((entry, position) => {
    const entryPath = `${path}[${position}]`;
    const record = recordAt(entry, entryPath);
    const index = safeIntegerAt(record.index, `${entryPath}.index`);
    if (index >= MAX_BOOST_PAD_COOLDOWNS) fail(`${entryPath}.index`, 'pad index is out of range');
    // Two entries for one pad would leave presentation choosing between them.
    if (seen.has(index)) fail(`${entryPath}.index`, 'duplicate pad index');
    seen.add(index);
    const secondsRemaining = finiteNumberAt(
      record.secondsRemaining,
      `${entryPath}.secondsRemaining`,
      0,
    );
    // A pad with nothing remaining is available, so listing it is a contradiction.
    if (secondsRemaining <= 0) {
      fail(`${entryPath}.secondsRemaining`, 'a listed pad must still be on cooldown');
    }
    return Object.freeze({ index, secondsRemaining });
  });

  // Ordered by pad, so two envelopes describing the same state serialize alike.
  return Object.freeze([...entries].sort((left, right) => left.index - right.index));
}

function transitionAt(value: unknown, path: string): Readonly<MatchTransitionSnapshot> {
  const record = recordAt(value, path);
  const eventId = safeIntegerAt(record.eventId, `${path}.eventId`);
  const kind = enumAt(record.kind, MATCH_TRANSITION_KINDS, `${path}.kind`);
  const goal = record.goal === null ? null : goalResultAt(record.goal, `${path}.goal`);
  const terminal = record.terminal === null
    ? null
    : terminalResultAt(record.terminal, `${path}.terminal`);

  if (goal !== null && goal.eventId !== eventId) {
    fail(path, 'goal and transition event IDs must agree');
  }
  if (terminal !== null && terminal.eventId !== eventId) {
    fail(path, 'terminal and transition event IDs must agree');
  }

  switch (kind) {
    case 'countdown':
      if (goal !== null || terminal !== null) fail(path, 'countdown cannot carry goal or terminal data');
      break;
    case 'regulation-goal-reset':
      if (goal === null || terminal !== null) fail(path, 'goal reset requires one non-terminal goal');
      break;
    case 'regulation-terminal-goal':
      if (goal === null || terminal === null || terminal.reason !== 'regulation-target-and-margin') {
        fail(path, 'regulation terminal goal requires matching goal and terminal data');
      }
      break;
    case 'hard-cutoff':
      if (terminal === null || terminal.reason !== 'hard-regulation-cutoff') {
        fail(path, 'hard cutoff requires a hard-cutoff terminal result');
      }
      break;
    case 'overtime-entry':
      if (terminal !== null) fail(path, 'overtime entry cannot be terminal');
      break;
    case 'overtime-terminal-goal':
      if (goal === null || terminal === null || terminal.reason !== 'overtime-goal') {
        fail(path, 'overtime terminal goal requires matching goal and terminal data');
      }
      break;
  }

  if (goal !== null && terminal?.goal !== null && terminal !== null && !sameValue(goal, terminal.goal)) {
    fail(path, 'transition goal and terminal goal must be identical');
  }

  return Object.freeze({ eventId, kind, goal, terminal });
}

function carAt(value: unknown, path: string): Readonly<CarSnapshot> {
  const record = recordAt(value, path);
  return Object.freeze({
    sessionId: stringAt(record.sessionId, `${path}.sessionId`, false),
    team: teamAt(record.team, `${path}.team`),
    name: stringAt(record.name, `${path}.name`),
    isHost: booleanAt(record.isHost, `${path}.isHost`),
    position: vector3At(record.position, `${path}.position`),
    rotation: quaternionAt(record.rotation, `${path}.rotation`),
    linearVelocity: vector3At(record.linearVelocity, `${path}.linearVelocity`),
    boost: finiteNumberAt(record.boost, `${path}.boost`, 0, 100),
  });
}

function ballAt(value: unknown, path: string): Readonly<BallSnapshot> {
  const record = recordAt(value, path);
  return Object.freeze({
    position: vector3At(record.position, `${path}.position`),
    rotation: quaternionAt(record.rotation, `${path}.rotation`),
    linearVelocity: vector3At(record.linearVelocity, `${path}.linearVelocity`),
  });
}

function assertMatchCoherence(snapshot: SnapshotEnvelopeV2): void {
  if (snapshot.phase === 'countdown') {
    if (snapshot.countdownKind === null) {
      fail('snapshot.countdownKind', 'countdown phase requires a countdown kind');
    }
  } else if (snapshot.countdownKind !== null) {
    fail('snapshot.countdownKind', 'only countdown phase may carry a countdown kind');
  }

  if (snapshot.phase === 'ended') {
    if (snapshot.winner === null || snapshot.terminalResult === null) {
      fail('snapshot', 'ended phase requires winner and terminalResult');
    }
    if (snapshot.latestTransition === null || snapshot.latestTransition.terminal === null) {
      fail('snapshot.latestTransition', 'ended phase requires its composite terminal transition');
    }
    if (
      snapshot.terminalResult.blueScore !== snapshot.blueScore
      || snapshot.terminalResult.orangeScore !== snapshot.orangeScore
      || snapshot.terminalResult.winner !== snapshot.winner
    ) {
      fail('snapshot.terminalResult', 'final score and winner must match the envelope');
    }
    if (
      snapshot.latestTransition.eventId !== snapshot.terminalResult.eventId
      || !sameValue(snapshot.latestTransition.terminal, snapshot.terminalResult)
    ) {
      fail('snapshot.latestTransition', 'terminal payload and event ID must remain coherent');
    }

    const expectedKind: MatchTransitionKind = snapshot.terminalResult.reason === 'hard-regulation-cutoff'
      ? 'hard-cutoff'
      : snapshot.terminalResult.reason === 'overtime-goal'
        ? 'overtime-terminal-goal'
        : 'regulation-terminal-goal';
    if (snapshot.latestTransition.kind !== expectedKind) {
      fail('snapshot.latestTransition.kind', `terminal reason requires ${expectedKind}`);
    }
  } else {
    if (snapshot.winner !== null || snapshot.terminalResult !== null) {
      fail('snapshot', 'non-ended phases cannot carry a winner or terminalResult');
    }
    if (snapshot.latestTransition !== null && snapshot.latestTransition.terminal !== null) {
      fail('snapshot.latestTransition.terminal', 'non-ended phases cannot carry terminal data');
    }
  }

  const transition = snapshot.latestTransition;
  if (
    transition !== null
    && transition.terminal !== null
    && !sameValue(transition.goal, transition.terminal.goal)
  ) {
    fail(
      'snapshot.latestTransition',
      'transition goal and terminal goal must be identically present and equal',
    );
  }

  const goal = transition?.goal ?? null;
  if (goal !== null) {
    if (goal.blueScore !== snapshot.blueScore || goal.orangeScore !== snapshot.orangeScore) {
      fail('snapshot.latestTransition.goal', 'goal score must match the envelope score');
    }
    if (goal.kickoffEpoch > snapshot.kickoffEpoch) {
      fail('snapshot.latestTransition.goal.kickoffEpoch', 'goal cannot originate in a future epoch');
    }
  }
}

/** Decode unknown data into a new deeply frozen V2 contract value. */
export function parseSnapshotEnvelopeV2(value: unknown): Readonly<SnapshotEnvelopeV2> {
  const record = recordAt(value, 'snapshot');
  if (record.protocolVersion !== SNAPSHOT_PROTOCOL_VERSION) {
    fail('snapshot.protocolVersion', `expected ${SNAPSHOT_PROTOCOL_VERSION}`);
  }

  const roomMode = enumAt(record.roomMode, ['quick', 'custom'] as const, 'snapshot.roomMode');
  const policy = ROOM_POLICIES[roomMode];
  if (record.policyVersion !== policy.version) fail('snapshot.policyVersion', `expected ${policy.version}`);
  if (record.totalCapacity !== policy.totalCapacity) {
    fail('snapshot.totalCapacity', `expected ${policy.totalCapacity} for ${roomMode}`);
  }
  if (record.teamCapacity !== policy.teamCapacity) {
    fail('snapshot.teamCapacity', `expected ${policy.teamCapacity} for ${roomMode}`);
  }

  if (!Array.isArray(record.cars)) fail('snapshot.cars', 'expected an array');
  if (record.cars.length > policy.totalCapacity || record.cars.length > 8) {
    fail('snapshot.cars', 'car count exceeds room capacity');
  }
  const cars = Object.freeze(record.cars.map((car, index) => carAt(car, `snapshot.cars[${index}]`)));
  const identities = new Set<string>();
  let blueCount = 0;
  let orangeCount = 0;
  let hostCount = 0;
  for (const car of cars) {
    if (identities.has(car.sessionId)) fail('snapshot.cars', `duplicate sessionId ${car.sessionId}`);
    identities.add(car.sessionId);
    if (car.team === 'blue') blueCount += 1;
    else orangeCount += 1;
    if (car.isHost) hostCount += 1;
  }
  if (blueCount > policy.teamCapacity || orangeCount > policy.teamCapacity) {
    fail('snapshot.cars', 'team occupancy exceeds policy capacity');
  }
  if (roomMode === 'quick' && hostCount !== 0) fail('snapshot.cars', 'Quick Match cannot assign a Host');
  if (hostCount > 1) fail('snapshot.cars', 'at most one car may carry Host metadata');

  const snapshot: SnapshotEnvelopeV2 = Object.freeze({
    protocolVersion: SNAPSHOT_PROTOCOL_VERSION,
    policyVersion: policy.version,
    roomMode,
    totalCapacity: policy.totalCapacity,
    teamCapacity: policy.teamCapacity,
    sequence: safeIntegerAt(record.sequence, 'snapshot.sequence'),
    serverTime: finiteNumberAt(record.serverTime, 'snapshot.serverTime', 0),
    simulationTime: finiteNumberAt(record.simulationTime, 'snapshot.simulationTime', 0),
    phase: phaseAt(record.phase, 'snapshot.phase'),
    countdownKind: countdownKindAt(record.countdownKind, 'snapshot.countdownKind'),
    phaseSecondsRemaining: finiteNumberAt(
      record.phaseSecondsRemaining,
      'snapshot.phaseSecondsRemaining',
      0,
    ),
    regulationSecondsRemaining: finiteNumberAt(
      record.regulationSecondsRemaining,
      'snapshot.regulationSecondsRemaining',
      0,
    ),
    kickoffEpoch: safeIntegerAt(record.kickoffEpoch, 'snapshot.kickoffEpoch'),
    blueScore: safeIntegerAt(record.blueScore, 'snapshot.blueScore'),
    orangeScore: safeIntegerAt(record.orangeScore, 'snapshot.orangeScore'),
    winner: nullableTeamAt(record.winner, 'snapshot.winner'),
    terminalResult: record.terminalResult === null
      ? null
      : terminalResultAt(record.terminalResult, 'snapshot.terminalResult'),
    latestTransition: record.latestTransition === null
      ? null
      : transitionAt(record.latestTransition, 'snapshot.latestTransition'),
    cars,
    ball: ballAt(record.ball, 'snapshot.ball'),
    boostPadCooldowns: boostPadCooldownsAt(
      record.boostPadCooldowns,
      'snapshot.boostPadCooldowns',
    ),
  });

  assertMatchCoherence(snapshot);
  return snapshot;
}

export const createSnapshotEnvelopeV2 = parseSnapshotEnvelopeV2;

export function isSnapshotEnvelopeV2(value: unknown): value is SnapshotEnvelopeV2 {
  try {
    parseSnapshotEnvelopeV2(value);
    return true;
  } catch {
    return false;
  }
}

export function serializeSnapshotEnvelopeV2(value: unknown): string {
  return JSON.stringify(parseSnapshotEnvelopeV2(value));
}

export function deserializeSnapshotEnvelopeV2(serialized: string): Readonly<SnapshotEnvelopeV2> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new SnapshotContractError(
      `snapshot: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return parseSnapshotEnvelopeV2(decoded);
}

/**
 * Verify that later Ended snapshots advance only the envelope sequence/time,
 * never regenerating or mutating the committed terminal outcome.
 */
export function assertStableTerminalSnapshots(previous: unknown, next: unknown): void {
  const prior = parseSnapshotEnvelopeV2(previous);
  const candidate = parseSnapshotEnvelopeV2(next);
  if (prior.phase !== 'ended' || candidate.phase !== 'ended') {
    fail('snapshot', 'terminal stability requires two ended snapshots');
  }
  if (candidate.sequence <= prior.sequence) {
    fail('snapshot.sequence', 'repeated terminal snapshots must increase sequence');
  }
  if (
    prior.blueScore !== candidate.blueScore
    || prior.orangeScore !== candidate.orangeScore
    || prior.winner !== candidate.winner
    || !sameValue(prior.terminalResult, candidate.terminalResult)
    || !sameValue(prior.latestTransition, candidate.latestTransition)
  ) {
    fail('snapshot', 'terminal score, winner, result, and transition must remain immutable');
  }
}

export function isStableTerminalSnapshotPair(previous: unknown, next: unknown): boolean {
  try {
    assertStableTerminalSnapshots(previous, next);
    return true;
  } catch {
    return false;
  }
}

export function isSnapshotEventId(value: unknown): value is AuthoritativeTransitionId {
  return isAuthoritativeEventId(value);
}
