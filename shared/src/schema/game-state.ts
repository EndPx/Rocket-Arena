import { MapSchema, Schema, defineTypes } from '@colyseus/schema';
import {
  ROOM_POLICIES,
  validateRoomPolicy,
  type RoomPolicy,
} from '../config/room-policies.js';
import { MATCH_RULES } from '../constants/match.js';
import {
  COUNTDOWN_KINDS,
  MATCH_PHASES,
  TEAMS,
  createGoalResult,
  createTerminalResult,
  isAuthoritativeEventId,
  terminalResultsEqual,
  type CountdownKind,
  type GoalResult,
  type MatchPhase,
  type RoomMode,
  type Team,
  type TerminalReason,
  type TerminalResult,
} from '../types/room.js';
import {
  MATCH_TRANSITION_KINDS,
  SNAPSHOT_PROTOCOL_VERSION,
  type MatchTransitionKind,
  type MatchTransitionSnapshot,
} from '../types/snapshot.js';
import { BallState, type AuthoritativeBallProjection } from './ball-state.js';
import { PlayerState, type AuthoritativePlayerProjection } from './player-state.js';

const UINT32_MAX = 0xffff_ffff;

function uint32(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new TypeError(`${field} must fit an unsigned 32-bit integer.`);
  }
  return value;
}

function nonNegativeFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative number.`);
  }
  return value;
}

function validTeam(value: Team | null, field: string): Team | null {
  if (value !== null && !TEAMS.some((team) => team === value)) {
    throw new TypeError(`${field} must be a valid team or null.`);
  }
  return value;
}

export class GoalResultState extends Schema {
  declare eventId: number;
  declare team: Team;
  declare kickoffEpoch: number;
  declare blueScore: number;
  declare orangeScore: number;

  constructor() {
    super();
    this.eventId = 0;
    this.team = 'blue';
    this.kickoffEpoch = 0;
    this.blueScore = 0;
    this.orangeScore = 0;
  }

  static fromContract(result: GoalResult): GoalResultState {
    const frozen = createGoalResult(result);
    return new GoalResultState().assign({ ...frozen });
  }

  toContract(): Readonly<GoalResult> {
    return createGoalResult({
      eventId: this.eventId,
      team: this.team,
      kickoffEpoch: this.kickoffEpoch,
      blueScore: this.blueScore,
      orangeScore: this.orangeScore,
    });
  }
}

defineTypes(GoalResultState, {
  eventId: 'uint64',
  team: 'string',
  kickoffEpoch: 'uint32',
  blueScore: 'uint32',
  orangeScore: 'uint32',
});

export class TerminalResultState extends Schema {
  declare eventId: number;
  declare reason: TerminalReason;
  declare winner: Team;
  declare blueScore: number;
  declare orangeScore: number;
  declare goal: GoalResultState | null;

  constructor() {
    super();
    this.eventId = 0;
    this.reason = 'hard-regulation-cutoff';
    this.winner = 'blue';
    this.blueScore = 0;
    this.orangeScore = 0;
    this.goal = null;
  }

  static fromContract(result: TerminalResult): TerminalResultState {
    const frozen = createTerminalResult(result);
    const state = new TerminalResultState();
    state.eventId = frozen.eventId;
    state.reason = frozen.reason;
    state.winner = frozen.winner;
    state.blueScore = frozen.blueScore;
    state.orangeScore = frozen.orangeScore;
    state.goal = frozen.goal === null ? null : GoalResultState.fromContract(frozen.goal);
    return state;
  }

  toContract(): Readonly<TerminalResult> {
    return createTerminalResult({
      eventId: this.eventId,
      reason: this.reason,
      winner: this.winner,
      blueScore: this.blueScore,
      orangeScore: this.orangeScore,
      goal: this.goal?.toContract() ?? null,
    });
  }
}

defineTypes(TerminalResultState, {
  eventId: 'uint64',
  reason: 'string',
  winner: 'string',
  blueScore: 'uint32',
  orangeScore: 'uint32',
  goal: GoalResultState,
});

function contractValuesEqual(
  left: Readonly<GoalResult> | null,
  right: Readonly<GoalResult> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.eventId === right.eventId
    && left.team === right.team
    && left.kickoffEpoch === right.kickoffEpoch
    && left.blueScore === right.blueScore
    && left.orangeScore === right.orangeScore;
}

function validateTransition(transition: MatchTransitionSnapshot): MatchTransitionSnapshot {
  if (!isAuthoritativeEventId(transition.eventId)) {
    throw new TypeError('latestTransition.eventId must be a non-negative safe integer.');
  }
  if (!MATCH_TRANSITION_KINDS.some((kind) => kind === transition.kind)) {
    throw new TypeError(`Invalid transition kind: ${String(transition.kind)}.`);
  }
  const goal = transition.goal === null ? null : createGoalResult(transition.goal);
  const terminal = transition.terminal === null ? null : createTerminalResult(transition.terminal);
  if (goal !== null && goal.eventId !== transition.eventId) {
    throw new TypeError('Transition and goal event IDs must agree.');
  }
  if (terminal !== null && terminal.eventId !== transition.eventId) {
    throw new TypeError('Transition and terminal event IDs must agree.');
  }

  switch (transition.kind) {
    case 'countdown':
      if (goal !== null || terminal !== null) {
        throw new TypeError('Countdown transitions cannot carry goal or terminal data.');
      }
      break;
    case 'regulation-goal-reset':
      if (goal === null || terminal !== null) {
        throw new TypeError('Regulation goal-reset transitions require one non-terminal goal.');
      }
      break;
    case 'regulation-terminal-goal':
      if (goal === null || terminal === null || terminal.reason !== 'regulation-target-and-margin') {
        throw new TypeError(
          'Regulation terminal-goal transitions require matching goal and terminal data.',
        );
      }
      break;
    case 'hard-cutoff':
      if (terminal === null || terminal.reason !== 'hard-regulation-cutoff') {
        throw new TypeError('Hard-cutoff transitions require a hard-cutoff terminal result.');
      }
      break;
    case 'overtime-entry':
      if (terminal !== null) {
        throw new TypeError('Overtime-entry transitions cannot carry terminal data.');
      }
      break;
    case 'overtime-terminal-goal':
      if (goal === null || terminal === null || terminal.reason !== 'overtime-goal') {
        throw new TypeError(
          'Overtime terminal-goal transitions require matching goal and terminal data.',
        );
      }
      break;
  }

  if (terminal !== null && !contractValuesEqual(goal, terminal.goal)) {
    throw new TypeError(
      'Transition goal and terminal goal must be identically present and equal.',
    );
  }

  return Object.freeze({ eventId: transition.eventId, kind: transition.kind, goal, terminal });
}

export class MatchTransitionState extends Schema {
  declare eventId: number;
  declare kind: MatchTransitionKind;
  declare goal: GoalResultState | null;
  declare terminal: TerminalResultState | null;

  constructor() {
    super();
    this.eventId = 0;
    this.kind = 'countdown';
    this.goal = null;
    this.terminal = null;
  }

  static fromContract(transition: MatchTransitionSnapshot): MatchTransitionState {
    const valid = validateTransition(transition);
    const state = new MatchTransitionState();
    state.eventId = valid.eventId;
    state.kind = valid.kind;
    state.goal = valid.goal === null ? null : GoalResultState.fromContract(valid.goal);
    state.terminal = valid.terminal === null ? null : TerminalResultState.fromContract(valid.terminal);
    return state;
  }

  toContract(): Readonly<MatchTransitionSnapshot> {
    return validateTransition({
      eventId: this.eventId,
      kind: this.kind,
      goal: this.goal?.toContract() ?? null,
      terminal: this.terminal?.toContract() ?? null,
    });
  }
}

defineTypes(MatchTransitionState, {
  eventId: 'uint64',
  kind: 'string',
  goal: GoalResultState,
  terminal: TerminalResultState,
});

export interface AuthoritativeGameProjection {
  /** Complete Stable_Roster_Order car set staged before any live schema mutation. */
  readonly cars: readonly Readonly<AuthoritativePlayerProjection>[];
  readonly ball: Readonly<AuthoritativeBallProjection>;
  readonly policy: RoomPolicy;
  readonly phase: MatchPhase;
  readonly countdownKind: CountdownKind | null;
  readonly phaseSecondsRemaining: number;
  readonly countdownStepsRemaining: number;
  readonly goalResetStepsRemaining: number;
  readonly regulationStepsRemaining: number;
  readonly regulationActivePlayStepsCompleted: number;
  readonly regulationStarted: boolean;
  readonly regulationCutoffResolved: boolean;
  readonly kickoffEpoch: number;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly winner: Team | null;
  readonly terminalResult: TerminalResult | null;
  readonly latestTransition: MatchTransitionSnapshot | null;
  readonly transitionSequence: number;
}

interface AuthoritativeOccupancyProjection {
  readonly totalOccupancy: number;
  readonly blueOccupancy: number;
  readonly orangeOccupancy: number;
  readonly hostSessionId: string;
}

function deriveAuthoritativeOccupancy(
  players: MapSchema<PlayerState>,
  policy: RoomPolicy,
): Readonly<AuthoritativeOccupancyProjection> {
  const canonical = validateRoomPolicy(policy);
  let blueOccupancy = 0;
  let orangeOccupancy = 0;
  let hostSessionId = '';
  let hostCount = 0;

  for (const [sessionId, player] of players) {
    if (player.team === 'blue') blueOccupancy += 1;
    else if (player.team === 'orange') orangeOccupancy += 1;
    else throw new TypeError(`Player ${sessionId} has an invalid authoritative team.`);
    if (player.isHost) {
      hostCount += 1;
      hostSessionId = sessionId;
    }
  }

  const totalOccupancy = blueOccupancy + orangeOccupancy;
  if (
    totalOccupancy > canonical.totalCapacity
    || blueOccupancy > canonical.teamCapacity
    || orangeOccupancy > canonical.teamCapacity
  ) {
    throw new RangeError('Authoritative occupancy exceeds the selected room policy.');
  }
  if (canonical.mode === 'quick' && hostCount !== 0) {
    throw new TypeError('Quick Match cannot project Host metadata.');
  }
  if (hostCount > 1) throw new TypeError('At most one authoritative Host is allowed.');

  return Object.freeze({
    totalOccupancy,
    blueOccupancy,
    orangeOccupancy,
    hostSessionId,
  });
}

/** Internal authoritative state projection; client messages never assign it. */
export class GameState extends Schema {
  declare players: MapSchema<PlayerState>;
  declare ball: BallState;

  declare protocolVersion: number;
  declare policyVersion: number;
  declare roomMode: RoomMode;
  declare totalCapacity: number;
  declare teamCapacity: number;

  declare phase: MatchPhase;
  declare countdownKind: CountdownKind | null;
  declare phaseSecondsRemaining: number;
  declare countdownStepsRemaining: number;
  declare goalResetStepsRemaining: number;
  declare regulationStepsRemaining: number;
  declare regulationActivePlayStepsCompleted: number;
  declare regulationSecondsRemaining: number;
  declare regulationStarted: boolean;
  declare regulationCutoffResolved: boolean;
  declare kickoffEpoch: number;

  declare blueScore: number;
  declare orangeScore: number;
  declare winner: Team | null;
  declare terminalResult: TerminalResultState | null;
  declare latestTransition: MatchTransitionState | null;
  declare transitionSequence: number;

  declare totalOccupancy: number;
  declare blueOccupancy: number;
  declare orangeOccupancy: number;
  declare hostSessionId: string;

  /** Temporary V1 schema field retained until all consumers use typed phase timing. */
  declare timeRemaining: number;

  constructor() {
    super();
    this.players = new MapSchema<PlayerState>();
    this.ball = new BallState();
    this.protocolVersion = SNAPSHOT_PROTOCOL_VERSION;
    this.policyVersion = ROOM_POLICIES.quick.version;
    this.roomMode = 'quick';
    this.totalCapacity = ROOM_POLICIES.quick.totalCapacity;
    this.teamCapacity = ROOM_POLICIES.quick.teamCapacity;
    this.phase = 'waiting';
    this.countdownKind = null;
    this.phaseSecondsRemaining = 0;
    this.countdownStepsRemaining = 0;
    this.goalResetStepsRemaining = 0;
    this.regulationStepsRemaining = MATCH_RULES.regulationActivePlaySteps;
    this.regulationActivePlayStepsCompleted = 0;
    this.regulationSecondsRemaining = MATCH_RULES.regulationDurationSeconds;
    this.regulationStarted = false;
    this.regulationCutoffResolved = false;
    this.kickoffEpoch = 0;
    this.blueScore = 0;
    this.orangeScore = 0;
    this.winner = null;
    this.terminalResult = null;
    this.latestTransition = null;
    this.transitionSequence = 0;
    this.totalOccupancy = 0;
    this.blueOccupancy = 0;
    this.orangeOccupancy = 0;
    this.hostSessionId = '';
    this.timeRemaining = MATCH_RULES.regulationDurationSeconds;
  }

  stableRosterSessionIds(): readonly string[] {
    return [...this.players.entries()]
      .sort(([leftId, left], [rightId, right]) => (
        left.acceptedJoinOrdinal - right.acceptedJoinOrdinal
        || (left.sessionId || leftId).localeCompare(right.sessionId || rightId)
      ))
      .map(([sessionId]) => sessionId);
  }

  /** Derive occupancy and Host identity from server-owned roster entries only. */
  refreshAuthoritativeOccupancy(policy: RoomPolicy = ROOM_POLICIES[this.roomMode]): void {
    const occupancy = deriveAuthoritativeOccupancy(this.players, policy);
    this.totalOccupancy = occupancy.totalOccupancy;
    this.blueOccupancy = occupancy.blueOccupancy;
    this.orangeOccupancy = occupancy.orangeOccupancy;
    this.hostSessionId = occupancy.hostSessionId;
  }

  /** Validate a complete server-owned room projection before committing any field. */
  applyAuthoritativeProjection(projection: AuthoritativeGameProjection): this {
    const policy = validateRoomPolicy(projection.policy);
    if (!Array.isArray(projection.cars)) {
      throw new TypeError('cars must be a complete Stable_Roster_Order array.');
    }

    const candidatePlayers = new MapSchema<PlayerState>();
    const sessionIds = new Set<string>();
    let previousJoinOrdinal = -1;
    for (const car of projection.cars) {
      const player = PlayerState.fromAuthoritative(car);
      if (sessionIds.has(player.sessionId)) {
        throw new TypeError(`Duplicate authoritative player identity: ${player.sessionId}.`);
      }
      if (player.acceptedJoinOrdinal <= previousJoinOrdinal) {
        throw new TypeError('cars must be ordered by strictly increasing Stable_Roster_Order.');
      }
      sessionIds.add(player.sessionId);
      previousJoinOrdinal = player.acceptedJoinOrdinal;
      candidatePlayers.set(player.sessionId, player);
    }
    const candidateBall = BallState.fromAuthoritative(projection.ball);

    if (!MATCH_PHASES.some((phase) => phase === projection.phase)) {
      throw new TypeError(`Invalid match phase: ${String(projection.phase)}.`);
    }
    if (
      projection.countdownKind !== null
      && !COUNTDOWN_KINDS.some((kind) => kind === projection.countdownKind)
    ) {
      throw new TypeError(`Invalid countdown kind: ${String(projection.countdownKind)}.`);
    }
    if ((projection.phase === 'countdown') !== (projection.countdownKind !== null)) {
      throw new TypeError('Countdown kind must be present exactly during countdown phase.');
    }

    const phaseSecondsRemaining = nonNegativeFinite(
      projection.phaseSecondsRemaining,
      'phaseSecondsRemaining',
    );
    const countdownStepsRemaining = uint32(
      projection.countdownStepsRemaining,
      'countdownStepsRemaining',
    );
    const goalResetStepsRemaining = uint32(
      projection.goalResetStepsRemaining,
      'goalResetStepsRemaining',
    );
    const regulationStepsRemaining = uint32(
      projection.regulationStepsRemaining,
      'regulationStepsRemaining',
    );
    const regulationActivePlayStepsCompleted = uint32(
      projection.regulationActivePlayStepsCompleted,
      'regulationActivePlayStepsCompleted',
    );
    if (
      regulationStepsRemaining > MATCH_RULES.regulationActivePlaySteps
      || regulationActivePlayStepsCompleted > MATCH_RULES.regulationActivePlaySteps
      || regulationStepsRemaining + regulationActivePlayStepsCompleted
        > MATCH_RULES.regulationActivePlaySteps
    ) {
      throw new RangeError('Regulation step state exceeds the confirmed 18,000-step budget.');
    }
    if (typeof projection.regulationStarted !== 'boolean') {
      throw new TypeError('regulationStarted must be boolean.');
    }
    if (typeof projection.regulationCutoffResolved !== 'boolean') {
      throw new TypeError('regulationCutoffResolved must be boolean.');
    }

    const kickoffEpoch = uint32(projection.kickoffEpoch, 'kickoffEpoch');
    const blueScore = uint32(projection.blueScore, 'blueScore');
    const orangeScore = uint32(projection.orangeScore, 'orangeScore');
    const winner = validTeam(projection.winner, 'winner');
    const terminal = projection.terminalResult === null
      ? null
      : createTerminalResult(projection.terminalResult);
    const transition = projection.latestTransition === null
      ? null
      : validateTransition(projection.latestTransition);
    const transitionSequence = projection.transitionSequence;
    if (!isAuthoritativeEventId(transitionSequence)) {
      throw new TypeError('transitionSequence must be a non-negative safe integer.');
    }
    if (transition !== null && transition.eventId !== transitionSequence) {
      throw new TypeError('Latest transition event ID must equal transitionSequence.');
    }

    if (projection.phase === 'ended') {
      if (winner === null || terminal === null || transition === null || transition.terminal === null) {
        throw new TypeError('Ended state requires winner, terminal result, and terminal transition.');
      }
      const expectedKind: MatchTransitionKind = terminal.reason === 'hard-regulation-cutoff'
        ? 'hard-cutoff'
        : terminal.reason === 'overtime-goal'
          ? 'overtime-terminal-goal'
          : 'regulation-terminal-goal';
      if (
        terminal.winner !== winner
        || terminal.blueScore !== blueScore
        || terminal.orangeScore !== orangeScore
        || transition.eventId !== terminal.eventId
        || transition.kind !== expectedKind
        || !terminalResultsEqual(transition.terminal, terminal)
      ) {
        throw new TypeError('Ended score, winner, terminal result, and transition must agree.');
      }
    } else {
      if (winner !== null || terminal !== null) {
        throw new TypeError('Only Ended state may project winner or terminal result.');
      }
      if (transition !== null && transition.terminal !== null) {
        throw new TypeError('Only Ended state may project terminal transition data.');
      }
    }

    const existingTerminal = this.terminalResult?.toContract() ?? null;
    if (existingTerminal !== null && !terminalResultsEqual(existingTerminal, terminal)) {
      throw new TypeError('Committed terminal result is immutable.');
    }
    const existingTransition = this.latestTransition?.toContract() ?? null;
    if (
      existingTransition !== null
      && transition !== null
      && transition.eventId === existingTransition.eventId
      && JSON.stringify(transition) !== JSON.stringify(existingTransition)
    ) {
      throw new TypeError('A committed transition event ID cannot change payload.');
    }
    if (existingTransition !== null && transition !== null && transition.eventId < existingTransition.eventId) {
      throw new TypeError('Authoritative transition IDs cannot decrease.');
    }

    const occupancy = deriveAuthoritativeOccupancy(candidatePlayers, policy);
    const terminalState = terminal === null ? null : TerminalResultState.fromContract(terminal);
    const transitionState = transition === null ? null : MatchTransitionState.fromContract(transition);
    const regulationSecondsRemaining = regulationStepsRemaining / MATCH_RULES.fixedStepsPerSecond;
    const timeRemaining = projection.phase === 'countdown' || projection.phase === 'goal-reset'
      ? phaseSecondsRemaining
      : regulationSecondsRemaining;

    // Every candidate above has been fully validated. This synchronous,
    // non-throwing assignment block is the single observable schema commit.
    this.players = candidatePlayers;
    this.ball = candidateBall;
    this.protocolVersion = SNAPSHOT_PROTOCOL_VERSION;
    this.policyVersion = policy.version;
    this.roomMode = policy.mode;
    this.totalCapacity = policy.totalCapacity;
    this.teamCapacity = policy.teamCapacity;
    this.phase = projection.phase;
    this.countdownKind = projection.countdownKind;
    this.phaseSecondsRemaining = phaseSecondsRemaining;
    this.countdownStepsRemaining = countdownStepsRemaining;
    this.goalResetStepsRemaining = goalResetStepsRemaining;
    this.regulationStepsRemaining = regulationStepsRemaining;
    this.regulationActivePlayStepsCompleted = regulationActivePlayStepsCompleted;
    this.regulationSecondsRemaining = regulationSecondsRemaining;
    this.regulationStarted = projection.regulationStarted;
    this.regulationCutoffResolved = projection.regulationCutoffResolved;
    this.kickoffEpoch = kickoffEpoch;
    this.blueScore = blueScore;
    this.orangeScore = orangeScore;
    this.winner = winner;
    this.terminalResult = terminalState;
    this.latestTransition = transitionState;
    this.transitionSequence = transitionSequence;
    this.timeRemaining = timeRemaining;
    this.totalOccupancy = occupancy.totalOccupancy;
    this.blueOccupancy = occupancy.blueOccupancy;
    this.orangeOccupancy = occupancy.orangeOccupancy;
    this.hostSessionId = occupancy.hostSessionId;
    return this;
  }
}

defineTypes(GameState, {
  players: { map: PlayerState },
  ball: BallState,
  protocolVersion: 'uint8',
  policyVersion: 'uint8',
  roomMode: 'string',
  totalCapacity: 'uint8',
  teamCapacity: 'uint8',
  phase: 'string',
  countdownKind: 'string',
  phaseSecondsRemaining: 'float64',
  countdownStepsRemaining: 'uint32',
  goalResetStepsRemaining: 'uint32',
  regulationStepsRemaining: 'uint32',
  regulationActivePlayStepsCompleted: 'uint32',
  regulationSecondsRemaining: 'float64',
  regulationStarted: 'boolean',
  regulationCutoffResolved: 'boolean',
  kickoffEpoch: 'uint32',
  blueScore: 'uint32',
  orangeScore: 'uint32',
  winner: 'string',
  terminalResult: TerminalResultState,
  latestTransition: MatchTransitionState,
  transitionSequence: 'uint64',
  totalOccupancy: 'uint8',
  blueOccupancy: 'uint8',
  orangeOccupancy: 'uint8',
  hostSessionId: 'string',
  timeRemaining: 'float64',
});
