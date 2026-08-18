export const ROOM_MODES = Object.freeze(['quick', 'custom'] as const);
export type RoomMode = (typeof ROOM_MODES)[number];

export const TEAMS = Object.freeze(['blue', 'orange'] as const);
export type Team = (typeof TEAMS)[number];
export type Winner = Team;

/** One accepted human identity in deterministic roster order. */
export interface RosterEntry {
  readonly sessionId: string;
  readonly acceptedJoinOrdinal: number;
  readonly team: Team;
  readonly name: string;
  readonly isHost: boolean;
}

export type StableRosterEntry = RosterEntry;

export interface RoomRoster {
  readonly entries: ReadonlyMap<string, RosterEntry>;
  readonly nextJoinOrdinal: number;
  readonly hostSessionId: string | null;
}

export const MATCH_PHASES = Object.freeze([
  'waiting',
  'countdown',
  'playing',
  'goal-reset',
  'overtime',
  'ended',
] as const);
export type MatchPhase = (typeof MATCH_PHASES)[number];

export const COUNTDOWN_KINDS = Object.freeze(['initial', 'post-goal', 'overtime'] as const);
export type CountdownKind = (typeof COUNTDOWN_KINDS)[number];

export const ROOM_REJECTION_CODES = Object.freeze([
  'duplicate-identity',
  'total-capacity',
  'team-capacity',
  'not-represented',
  'not-opposite-team',
  'wrong-phase',
  'not-host',
  'invalid-roster',
  'policy-mismatch',
  'physics-not-ready',
] as const);
export type RoomMutationErrorCode = (typeof ROOM_REJECTION_CODES)[number];
export type RoomRejectionCode = RoomMutationErrorCode;

export const TERMINAL_REASONS = Object.freeze([
  'regulation-target-and-margin',
  'hard-regulation-cutoff',
  'overtime-goal',
] as const);
export type TerminalReason = (typeof TERMINAL_REASONS)[number];

/** Room-local, non-negative, stable identity for one atomic match event. */
export type AuthoritativeEventId = number;
export type AuthoritativeTransitionId = AuthoritativeEventId;

export function isAuthoritativeEventId(value: unknown): value is AuthoritativeEventId {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export interface GoalResult {
  readonly eventId: AuthoritativeEventId;
  readonly team: Team;
  readonly kickoffEpoch: number;
  readonly blueScore: number;
  readonly orangeScore: number;
}

export interface TerminalResult {
  readonly eventId: AuthoritativeTransitionId;
  readonly reason: TerminalReason;
  readonly winner: Winner;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly goal: GoalResult | null;
}

function isNonNegativeScore(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTeam(value: unknown): value is Team {
  return TEAMS.some((team) => team === value);
}

function isTerminalReason(value: unknown): value is TerminalReason {
  return TERMINAL_REASONS.some((reason) => reason === value);
}

/** Validate and freeze one authoritative score event. */
export function createGoalResult(value: GoalResult): Readonly<GoalResult> {
  if (!isAuthoritativeEventId(value.eventId)) {
    throw new TypeError('Goal eventId must be a non-negative safe integer.');
  }
  if (!isTeam(value.team)) throw new TypeError(`Invalid scoring team: ${String(value.team)}.`);
  if (!isNonNegativeScore(value.kickoffEpoch)) {
    throw new TypeError('Goal kickoffEpoch must be a non-negative safe integer.');
  }
  if (!isNonNegativeScore(value.blueScore) || !isNonNegativeScore(value.orangeScore)) {
    throw new TypeError('Goal scores must be non-negative safe integers.');
  }
  return Object.freeze({ ...value });
}

/**
 * Validate and deeply freeze a terminal result. Goal-driven terminal outcomes
 * share one event ID so clients consume the composite transition exactly once.
 */
export function createTerminalResult(value: TerminalResult): Readonly<TerminalResult> {
  if (!isAuthoritativeEventId(value.eventId)) {
    throw new TypeError('Terminal eventId must be a non-negative safe integer.');
  }
  if (!isTerminalReason(value.reason)) {
    throw new TypeError(`Invalid terminal reason: ${String(value.reason)}.`);
  }
  if (!isTeam(value.winner)) throw new TypeError(`Invalid terminal winner: ${String(value.winner)}.`);
  if (!isNonNegativeScore(value.blueScore) || !isNonNegativeScore(value.orangeScore)) {
    throw new TypeError('Terminal scores must be non-negative safe integers.');
  }

  const winnerScore = value.winner === 'blue' ? value.blueScore : value.orangeScore;
  const loserScore = value.winner === 'blue' ? value.orangeScore : value.blueScore;
  if (winnerScore <= loserScore) {
    throw new TypeError('Terminal winner must lead in the terminal score.');
  }

  const goal = value.goal === null ? null : createGoalResult(value.goal);
  if (goal !== null) {
    if (goal.eventId !== value.eventId) {
      throw new TypeError('Terminal and goal event IDs must identify the same composite event.');
    }
    if (goal.blueScore !== value.blueScore || goal.orangeScore !== value.orangeScore) {
      throw new TypeError('Terminal and goal scores must agree.');
    }
  }

  if (value.reason === 'regulation-target-and-margin' || value.reason === 'overtime-goal') {
    if (goal === null || goal.team !== value.winner) {
      throw new TypeError('Goal-driven terminal results require the winning goal in the same event.');
    }
  }

  return Object.freeze({
    eventId: value.eventId,
    reason: value.reason,
    winner: value.winner,
    blueScore: value.blueScore,
    orangeScore: value.orangeScore,
    goal,
  });
}

export function terminalResultsEqual(
  left: TerminalResult | null,
  right: TerminalResult | null,
): boolean {
  if (left === null || right === null) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

export const BUILD_KINDS = Object.freeze([
  'hackathon-staging',
  'mechanics-fidelity-release',
] as const);
export type BuildKind = (typeof BUILD_KINDS)[number];

export interface FeatureStatusRecord {
  readonly statusVersion: 1;
  readonly registryVersion: number;
  readonly buildKind: BuildKind;
  readonly delivered: readonly string[];
  readonly deferred: readonly string[];
  readonly unverifiedTuningIds: readonly string[];
}

export type FeatureStatus = FeatureStatusRecord;
