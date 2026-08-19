import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  MATCH_RULES,
  TUNING_IDS,
  createGoalResult,
  createTerminalResult,
  getMatchRules,
  getScalarTuningValue,
  type CountdownKind,
  type GoalResult,
  type MatchPhase,
  type RoomMode,
  type SharedMatchRules,
  type Team,
  type TerminalResult,
  type TuningRegistrySnapshot,
} from '@rocket-arena/shared';

export interface MatchFlowConfig {
  readonly mode: RoomMode;
  /** Quick and Custom deliberately retain the same confirmed object identity. */
  readonly rules: SharedMatchRules;
  readonly goalResetDurationSeconds: number;
  readonly goalResetSteps: number;
}

export type MatchOutcomeHook =
  | Readonly<{
    readonly kind: 'evaluate-above-zero-regulation-goal';
    readonly scoringTeam: Team;
    readonly regulationStepsRemaining: number;
    readonly effectiveAfterStep: true;
  }>
  | Readonly<{
    readonly kind: 'resolve-hard-regulation-cutoff';
    readonly sameStepScoringTeam: Team | null;
    readonly regulationStepsRemaining: 0;
    readonly effectiveAfterStep: true;
  }>
  | Readonly<{
    readonly kind: 'resolve-overtime-sudden-death-goal';
    readonly scoringTeam: Team;
    readonly effectiveAfterStep: true;
  }>;

/**
 * Task 4.4 owns timing and phase gates only. A pending outcome is an explicit
 * boundary for Task 6.4, which will apply scores and choose reset/overtime/end.
 */
export interface MatchFlowState {
  readonly phase: MatchPhase;
  readonly countdownKind: CountdownKind | null;
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
  readonly latestGoal: GoalResult | null;
  readonly terminalResult: TerminalResult | null;
  readonly transitionSequence: number;
  readonly pendingOutcome: MatchOutcomeHook | null;
}

export interface MatchFlowSeed {
  readonly blueScore?: number;
  readonly orangeScore?: number;
  readonly kickoffEpoch?: number;
  readonly transitionSequence?: number;
}

export interface ResolvedGoalResetInput {
  /** Scores have already been resolved by the future outcome reducer. */
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly latestGoal?: GoalResult | null;
}

export interface MatchFlowStepInput {
  /** A swept, already-validated goal candidate; this skeleton does not score it. */
  readonly validGoal?: Readonly<{ readonly scoringTeam: Team }> | null;
}

export interface MatchFlowStepGates {
  readonly controlsEnabled: boolean;
  readonly physicsEnabled: boolean;
  /** Disabled phases consume edge sequences without applying their actuation. */
  readonly synchronizeInputEdges: boolean;
  /** Overtime kickoff countdowns must remain at deterministic zero-motion state. */
  readonly freezeKickoffState: boolean;
}

export type MatchFlowTransitionKind = 'countdown-complete' | 'goal-reset-complete';

export interface MatchFlowTransition {
  readonly sequence: number;
  readonly kind: MatchFlowTransitionKind;
  readonly fromPhase: MatchPhase;
  readonly toPhase: MatchPhase;
  readonly countdownKind: CountdownKind | null;
  readonly effectiveAfterStep: true;
}

export interface KickoffResetDirective {
  readonly reason: 'post-goal';
  readonly targetKickoffEpoch: number;
  readonly resetCars: true;
  readonly resetBall: true;
  readonly zeroLinearVelocity: true;
  readonly zeroAngularVelocity: true;
  readonly effectiveAfterStep: true;
}

export interface MatchFlowStepResult {
  /** Phase and gates used for the fixed step that just completed. */
  readonly phaseDuringStep: MatchPhase;
  readonly gates: MatchFlowStepGates;
  /** State committed only after that fixed step completes. */
  readonly state: Readonly<MatchFlowState>;
  readonly transition: Readonly<MatchFlowTransition> | null;
  readonly kickoffReset: Readonly<KickoffResetDirective> | null;
  readonly outcomeHook: MatchOutcomeHook | null;
}

const ENABLED_GATES: Readonly<MatchFlowStepGates> = Object.freeze({
  controlsEnabled: true,
  physicsEnabled: true,
  synchronizeInputEdges: false,
  freezeKickoffState: false,
});

const DISABLED_STATIC_GATES: Readonly<MatchFlowStepGates> = Object.freeze({
  controlsEnabled: false,
  physicsEnabled: false,
  synchronizeInputEdges: true,
  freezeKickoffState: false,
});

const DISABLED_PHYSICS_GATES: Readonly<MatchFlowStepGates> = Object.freeze({
  controlsEnabled: false,
  physicsEnabled: true,
  synchronizeInputEdges: true,
  freezeKickoffState: false,
});

const FROZEN_KICKOFF_GATES: Readonly<MatchFlowStepGates> = Object.freeze({
  controlsEnabled: false,
  physicsEnabled: false,
  synchronizeInputEdges: true,
  freezeKickoffState: true,
});

function assertRoomMode(mode: RoomMode): void {
  if (mode !== 'quick' && mode !== 'custom') {
    throw new TypeError(`Invalid room mode: ${String(mode)}.`);
  }
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
}

function assertScore(value: number, field: string): void {
  assertNonNegativeSafeInteger(value, field);
}

function incrementSafeInteger(value: number, field: string): number {
  assertNonNegativeSafeInteger(value, field);
  if (value === Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${field} cannot be incremented safely.`);
  }
  return value + 1;
}

function assertTeam(value: unknown, field: string): asserts value is Team {
  if (value !== 'blue' && value !== 'orange') {
    throw new TypeError(`${field} must be blue or orange.`);
  }
}

function assertConfig(config: MatchFlowConfig): void {
  assertRoomMode(config.mode);
  if (config.rules !== getMatchRules(config.mode) || config.rules !== MATCH_RULES) {
    throw new TypeError('Match flow must use the one confirmed shared MATCH_RULES object.');
  }
  if (!Number.isFinite(config.goalResetDurationSeconds) || config.goalResetDurationSeconds <= 0) {
    throw new RangeError('Goal reset duration must be finite and positive.');
  }
  assertNonNegativeSafeInteger(config.goalResetSteps, 'goalResetSteps');
  if (config.goalResetSteps === 0) {
    throw new RangeError('Goal reset duration must occupy at least one fixed step.');
  }
  if (
    config.goalResetSteps
    !== goalResetDurationToSteps(config.goalResetDurationSeconds, config.rules)
  ) {
    throw new TypeError('goalResetSteps must be derived from the configured duration.');
  }
}

function freezeOutcome(outcome: MatchOutcomeHook | null): MatchOutcomeHook | null {
  return outcome === null || Object.isFrozen(outcome)
    ? outcome
    : Object.freeze({ ...outcome });
}

function freezeState(value: MatchFlowState, config: MatchFlowConfig): Readonly<MatchFlowState> {
  const latestGoal = value.latestGoal === null
    ? null
    : (Object.isFrozen(value.latestGoal) ? value.latestGoal : createGoalResult(value.latestGoal));
  const terminalResult = value.terminalResult === null
    ? null
    : (Object.isFrozen(value.terminalResult)
      ? value.terminalResult
      : createTerminalResult(value.terminalResult));
  const state = Object.freeze({
    ...value,
    latestGoal,
    terminalResult,
    pendingOutcome: freezeOutcome(value.pendingOutcome),
  });
  assertMatchFlowState(state, config);
  return state;
}

function baseState(config: MatchFlowConfig, seed: MatchFlowSeed): Omit<
  MatchFlowState,
  'phase' | 'countdownKind' | 'countdownStepsRemaining'
> {
  const blueScore = seed.blueScore ?? 0;
  const orangeScore = seed.orangeScore ?? 0;
  const kickoffEpoch = seed.kickoffEpoch ?? 0;
  const transitionSequence = seed.transitionSequence ?? 0;
  assertScore(blueScore, 'blueScore');
  assertScore(orangeScore, 'orangeScore');
  assertNonNegativeSafeInteger(kickoffEpoch, 'kickoffEpoch');
  assertNonNegativeSafeInteger(transitionSequence, 'transitionSequence');

  return {
    goalResetStepsRemaining: 0,
    regulationStepsRemaining: config.rules.regulationActivePlaySteps,
    regulationActivePlayStepsCompleted: 0,
    regulationStarted: false,
    regulationCutoffResolved: false,
    kickoffEpoch,
    blueScore,
    orangeScore,
    winner: null,
    latestGoal: null,
    terminalResult: null,
    transitionSequence,
    pendingOutcome: null,
  };
}

function transition(
  sequence: number,
  kind: MatchFlowTransitionKind,
  fromPhase: MatchPhase,
  toPhase: MatchPhase,
  countdownKind: CountdownKind | null,
): Readonly<MatchFlowTransition> {
  return Object.freeze({
    sequence,
    kind,
    fromPhase,
    toPhase,
    countdownKind,
    effectiveAfterStep: true,
  });
}

function stepResult(
  prior: MatchFlowState,
  gates: MatchFlowStepGates,
  state: Readonly<MatchFlowState>,
  transitionResult: Readonly<MatchFlowTransition> | null = null,
  kickoffReset: Readonly<KickoffResetDirective> | null = null,
  outcomeHook: MatchOutcomeHook | null = null,
): Readonly<MatchFlowStepResult> {
  return Object.freeze({
    phaseDuringStep: prior.phase,
    gates,
    state,
    transition: transitionResult,
    kickoffReset,
    outcomeHook,
  });
}

/** Convert a validated seconds hypothesis to deterministic whole fixed steps. */
export function goalResetDurationToSteps(
  seconds: number,
  rules: SharedMatchRules = MATCH_RULES,
): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new RangeError('Goal reset duration must be finite and positive.');
  }
  const steps = Math.round(seconds * rules.fixedStepsPerSecond);
  if (!Number.isSafeInteger(steps) || steps <= 0) {
    throw new RangeError('Goal reset duration cannot be represented as positive fixed steps.');
  }
  return steps;
}

/** Build room-local timing config from shared rules and a pinned tuning snapshot. */
export function createMatchFlowConfig(
  mode: RoomMode,
  tuning: Pick<TuningRegistrySnapshot, 'get'> = DEFAULT_TUNING_REGISTRY_SNAPSHOT,
): Readonly<MatchFlowConfig> {
  assertRoomMode(mode);
  const rules = getMatchRules(mode);
  const goalResetDurationSeconds = getScalarTuningValue(
    tuning,
    TUNING_IDS.match.regulationGoalResetSeconds,
  );
  const config = Object.freeze({
    mode,
    rules,
    goalResetDurationSeconds,
    goalResetSteps: goalResetDurationToSteps(goalResetDurationSeconds, rules),
  });
  assertConfig(config);
  return config;
}

/** Empty-room state before either mode's start predicate creates a countdown. */
export function createWaitingMatchFlowState(
  config: MatchFlowConfig,
  seed: MatchFlowSeed = {},
): Readonly<MatchFlowState> {
  assertConfig(config);
  return freezeState({
    ...baseState(config, seed),
    phase: 'waiting',
    countdownKind: null,
    countdownStepsRemaining: 0,
  }, config);
}

/**
 * The first countdown reserves all 18,000 future regulation Active_Play steps;
 * countdown work itself never spends that budget.
 */
export function createInitialMatchFlowState(
  config: MatchFlowConfig,
  seed: MatchFlowSeed = {},
): Readonly<MatchFlowState> {
  assertConfig(config);
  return freezeState({
    ...baseState(config, seed),
    phase: 'countdown',
    countdownKind: 'initial',
    countdownStepsRemaining: config.rules.kickoffCountdownSteps,
  }, config);
}

export const createInitialCountdownState = createInitialMatchFlowState;

export function beginInitialCountdown(
  state: MatchFlowState,
  config: MatchFlowConfig,
): Readonly<MatchFlowState> {
  assertMatchFlowState(state, config);
  if (state.phase !== 'waiting') {
    throw new Error('Initial countdown can begin only from Waiting_State.');
  }
  return freezeState({
    ...state,
    phase: 'countdown',
    countdownKind: 'initial',
    countdownStepsRemaining: config.rules.kickoffCountdownSteps,
    goalResetStepsRemaining: 0,
    regulationStepsRemaining: config.rules.regulationActivePlaySteps,
    regulationActivePlayStepsCompleted: 0,
    regulationStarted: false,
    regulationCutoffResolved: false,
    winner: null,
    terminalResult: null,
    pendingOutcome: null,
  }, config);
}

/**
 * Cancel only a pre-regulation initial countdown. Quick Match uses this when
 * its exact 3+3 gate becomes false before Active_Play; no partial progress is
 * retained, so a later eligible roster must start from all 180 steps again.
 */
export function cancelInitialCountdown(
  state: MatchFlowState,
  config: MatchFlowConfig,
): Readonly<MatchFlowState> {
  assertMatchFlowState(state, config);
  if (
    state.phase !== 'countdown'
    || state.countdownKind !== 'initial'
    || state.regulationStarted
  ) {
    throw new Error('Only a pre-regulation initial countdown can be cancelled.');
  }

  return freezeState({
    ...state,
    phase: 'waiting',
    countdownKind: null,
    countdownStepsRemaining: 0,
    goalResetStepsRemaining: 0,
    regulationStepsRemaining: config.rules.regulationActivePlaySteps,
    regulationActivePlayStepsCompleted: 0,
    pendingOutcome: null,
  }, config);
}

/**
 * Commit an already-resolved non-winning regulation goal to Goal_Reset_State.
 * This function deliberately does not evaluate target/margin or increment score.
 */
export function beginGoalReset(
  state: MatchFlowState,
  config: MatchFlowConfig,
  resolved: ResolvedGoalResetInput = {
    blueScore: state.blueScore,
    orangeScore: state.orangeScore,
    latestGoal: state.latestGoal,
  },
): Readonly<MatchFlowState> {
  assertMatchFlowState(state, config);
  if (state.phase !== 'playing' || state.regulationStepsRemaining <= 0) {
    throw new Error('Goal reset can begin only from above-zero regulation Active_Play.');
  }
  assertScore(resolved.blueScore, 'resolved.blueScore');
  assertScore(resolved.orangeScore, 'resolved.orangeScore');
  const latestGoal = resolved.latestGoal ?? null;
  if (
    latestGoal !== null
    && (latestGoal.blueScore !== resolved.blueScore
      || latestGoal.orangeScore !== resolved.orangeScore)
  ) {
    throw new TypeError('Resolved goal scores must match the Goal_Reset_State scores.');
  }

  return freezeState({
    ...state,
    phase: 'goal-reset',
    countdownKind: null,
    countdownStepsRemaining: 0,
    goalResetStepsRemaining: config.goalResetSteps,
    blueScore: resolved.blueScore,
    orangeScore: resolved.orangeScore,
    latestGoal,
    pendingOutcome: null,
  }, config);
}

export const startGoalReset = beginGoalReset;

/** Explicit Task 6.4 integration hook for an already-resolved tied cutoff. */
export function beginOvertimeCountdown(
  state: MatchFlowState,
  config: MatchFlowConfig,
): Readonly<MatchFlowState> {
  assertMatchFlowState(state, config);
  if (state.blueScore !== state.orangeScore) {
    throw new Error('Golden-goal overtime countdown requires a tied score.');
  }
  if (state.phase === 'ended') {
    throw new Error('Ended_State cannot enter overtime.');
  }

  return freezeState({
    ...state,
    phase: 'countdown',
    countdownKind: 'overtime',
    countdownStepsRemaining: config.rules.kickoffCountdownSteps,
    goalResetStepsRemaining: 0,
    regulationStepsRemaining: 0,
    regulationActivePlayStepsCompleted: config.rules.regulationActivePlaySteps,
    regulationStarted: true,
    regulationCutoffResolved: true,
    winner: null,
    terminalResult: null,
    pendingOutcome: null,
  }, config);
}

/** Commit a terminal result already resolved by the future outcome reducer. */
export function createEndedMatchFlowState(
  state: MatchFlowState,
  config: MatchFlowConfig,
  terminal: TerminalResult,
): Readonly<MatchFlowState> {
  assertMatchFlowState(state, config);
  const terminalResult = createTerminalResult(terminal);
  if (terminalResult.eventId < state.transitionSequence) {
    throw new RangeError('Terminal event ID cannot regress the transition sequence.');
  }

  const cutoffResolved = terminalResult.reason === 'hard-regulation-cutoff'
    || terminalResult.reason === 'overtime-goal'
    || state.regulationCutoffResolved;
  const regulationStepsRemaining = cutoffResolved ? 0 : state.regulationStepsRemaining;
  const regulationActivePlayStepsCompleted = cutoffResolved
    ? config.rules.regulationActivePlaySteps
    : state.regulationActivePlayStepsCompleted;

  return freezeState({
    ...state,
    phase: 'ended',
    countdownKind: null,
    countdownStepsRemaining: 0,
    goalResetStepsRemaining: 0,
    regulationStepsRemaining,
    regulationActivePlayStepsCompleted,
    regulationStarted: true,
    regulationCutoffResolved: cutoffResolved,
    blueScore: terminalResult.blueScore,
    orangeScore: terminalResult.orangeScore,
    winner: terminalResult.winner,
    latestGoal: terminalResult.goal ?? state.latestGoal,
    terminalResult,
    transitionSequence: terminalResult.eventId,
    pendingOutcome: null,
  }, config);
}

export const commitEndedMatchFlowState = createEndedMatchFlowState;

export function getMatchFlowStepGates(state: MatchFlowState): Readonly<MatchFlowStepGates> {
  if (state.pendingOutcome !== null) return DISABLED_STATIC_GATES;
  if (state.phase === 'playing' || state.phase === 'overtime') return ENABLED_GATES;
  if (state.phase === 'countdown' && state.countdownKind === 'overtime') {
    return FROZEN_KICKOFF_GATES;
  }
  if (state.phase === 'countdown' || state.phase === 'goal-reset') {
    return DISABLED_PHYSICS_GATES;
  }
  if (state.phase === 'ended') {
    return Object.freeze({ ...DISABLED_STATIC_GATES, freezeKickoffState: true });
  }
  return DISABLED_STATIC_GATES;
}

export function getRegulationSecondsRemaining(
  state: MatchFlowState,
  config: MatchFlowConfig,
): number {
  assertMatchFlowState(state, config);
  return state.regulationStepsRemaining / config.rules.fixedStepsPerSecond;
}

export function getPhaseSecondsRemaining(
  state: MatchFlowState,
  config: MatchFlowConfig,
): number {
  assertMatchFlowState(state, config);
  const steps = state.phase === 'countdown'
    ? state.countdownStepsRemaining
    : state.phase === 'goal-reset'
      ? state.goalResetStepsRemaining
      : 0;
  return steps / config.rules.fixedStepsPerSecond;
}

export function assertMatchFlowState(
  state: MatchFlowState,
  config: MatchFlowConfig,
): void {
  assertConfig(config);
  assertNonNegativeSafeInteger(state.countdownStepsRemaining, 'countdownStepsRemaining');
  assertNonNegativeSafeInteger(state.goalResetStepsRemaining, 'goalResetStepsRemaining');
  assertNonNegativeSafeInteger(state.regulationStepsRemaining, 'regulationStepsRemaining');
  assertNonNegativeSafeInteger(
    state.regulationActivePlayStepsCompleted,
    'regulationActivePlayStepsCompleted',
  );
  assertNonNegativeSafeInteger(state.kickoffEpoch, 'kickoffEpoch');
  assertNonNegativeSafeInteger(state.transitionSequence, 'transitionSequence');
  assertScore(state.blueScore, 'blueScore');
  assertScore(state.orangeScore, 'orangeScore');

  if (
    state.regulationStepsRemaining > config.rules.regulationActivePlaySteps
    || state.regulationActivePlayStepsCompleted > config.rules.regulationActivePlaySteps
    || state.regulationStepsRemaining + state.regulationActivePlayStepsCompleted
      !== config.rules.regulationActivePlaySteps
  ) {
    throw new RangeError('Regulation counters must partition the confirmed 18,000-step budget.');
  }

  const isCountdown = state.phase === 'countdown';
  if (isCountdown !== (state.countdownKind !== null)) {
    throw new TypeError('countdownKind must be present exactly during Countdown_State.');
  }
  if (isCountdown !== (state.countdownStepsRemaining > 0)) {
    throw new TypeError('Countdown_State must have positive countdown steps, and other phases zero.');
  }
  const isGoalReset = state.phase === 'goal-reset';
  if (isGoalReset !== (state.goalResetStepsRemaining > 0)) {
    throw new TypeError('Goal_Reset_State must have positive reset steps, and other phases zero.');
  }
  if (state.countdownKind === 'overtime') {
    if (!state.regulationCutoffResolved || state.regulationStepsRemaining !== 0) {
      throw new TypeError('Overtime countdown requires a resolved zero-time regulation cutoff.');
    }
  }
  if (state.phase === 'overtime') {
    if (!state.regulationCutoffResolved || state.regulationStepsRemaining !== 0) {
      throw new TypeError('Active overtime requires a resolved zero-time regulation cutoff.');
    }
  }

  if (state.phase === 'ended') {
    if (state.terminalResult === null || state.winner === null) {
      throw new TypeError('Ended_State requires immutable terminal result and winner fields.');
    }
    if (
      state.terminalResult.winner !== state.winner
      || state.terminalResult.blueScore !== state.blueScore
      || state.terminalResult.orangeScore !== state.orangeScore
      || state.terminalResult.eventId !== state.transitionSequence
    ) {
      throw new TypeError('Ended_State score, winner, event, and terminal result must agree.');
    }
  } else if (state.terminalResult !== null || state.winner !== null) {
    throw new TypeError('Only Ended_State may carry winner or terminal result fields.');
  }

  if (state.pendingOutcome !== null) {
    if (state.phase !== 'playing' && state.phase !== 'overtime') {
      throw new TypeError('Outcome hooks may be pending only from Active_Play.');
    }
    if (
      state.pendingOutcome.kind === 'resolve-hard-regulation-cutoff'
      && state.regulationStepsRemaining !== 0
    ) {
      throw new TypeError('Hard-cutoff resolution may be pending only at zero regulation steps.');
    }
  }
}

/**
 * Advance exactly one completed 1/60-second simulation step. Timing transitions
 * return next state but expose the prior phase gates, making the transition
 * effective only after the completing step.
 */
export function reduceMatchFlowStep(
  state: MatchFlowState,
  config: MatchFlowConfig,
  input: MatchFlowStepInput = {},
): Readonly<MatchFlowStepResult> {
  assertMatchFlowState(state, config);
  const gates = getMatchFlowStepGates(state);
  const goal = input.validGoal ?? null;
  if (goal !== null) assertTeam(goal.scoringTeam, 'validGoal.scoringTeam');

  if (state.pendingOutcome !== null) {
    throw new Error('Pending match outcome must be resolved before another fixed step.');
  }

  if (state.phase === 'waiting' || state.phase === 'ended') {
    return stepResult(state, gates, state);
  }

  if (state.phase === 'countdown') {
    if (state.countdownStepsRemaining > 1) {
      const next = freezeState({
        ...state,
        countdownStepsRemaining: state.countdownStepsRemaining - 1,
      }, config);
      return stepResult(state, gates, next);
    }

    const completedKind = state.countdownKind;
    if (completedKind === null) throw new TypeError('Countdown kind is required.');
    const nextSequence = incrementSafeInteger(state.transitionSequence, 'transitionSequence');
    const nextKickoffEpoch = incrementSafeInteger(state.kickoffEpoch, 'kickoffEpoch');
    const nextPhase: MatchPhase = completedKind === 'overtime' ? 'overtime' : 'playing';
    const next = freezeState({
      ...state,
      phase: nextPhase,
      countdownKind: null,
      countdownStepsRemaining: 0,
      regulationStarted: true,
      kickoffEpoch: nextKickoffEpoch,
      transitionSequence: nextSequence,
    }, config);
    return stepResult(
      state,
      gates,
      next,
      transition(nextSequence, 'countdown-complete', 'countdown', nextPhase, completedKind),
    );
  }

  if (state.phase === 'goal-reset') {
    if (state.goalResetStepsRemaining > 1) {
      const next = freezeState({
        ...state,
        goalResetStepsRemaining: state.goalResetStepsRemaining - 1,
      }, config);
      return stepResult(state, gates, next);
    }

    const nextSequence = incrementSafeInteger(state.transitionSequence, 'transitionSequence');
    const targetKickoffEpoch = incrementSafeInteger(state.kickoffEpoch, 'kickoffEpoch');
    const reset = Object.freeze({
      reason: 'post-goal',
      targetKickoffEpoch,
      resetCars: true,
      resetBall: true,
      zeroLinearVelocity: true,
      zeroAngularVelocity: true,
      effectiveAfterStep: true,
    } satisfies KickoffResetDirective);
    const next = freezeState({
      ...state,
      phase: 'countdown',
      countdownKind: 'post-goal',
      countdownStepsRemaining: config.rules.kickoffCountdownSteps,
      goalResetStepsRemaining: 0,
      transitionSequence: nextSequence,
    }, config);
    return stepResult(
      state,
      gates,
      next,
      transition(nextSequence, 'goal-reset-complete', 'goal-reset', 'countdown', 'post-goal'),
      reset,
    );
  }

  if (state.phase === 'playing') {
    if (state.regulationStepsRemaining === 0) {
      throw new Error('Regulation cannot advance after its fixed-step budget reaches zero.');
    }
    const regulationStepsRemaining = state.regulationStepsRemaining - 1;
    const regulationActivePlayStepsCompleted = state.regulationActivePlayStepsCompleted + 1;
    let outcomeHook: MatchOutcomeHook | null = null;

    if (regulationStepsRemaining === 0) {
      outcomeHook = Object.freeze({
        kind: 'resolve-hard-regulation-cutoff',
        sameStepScoringTeam: goal?.scoringTeam ?? null,
        regulationStepsRemaining: 0,
        effectiveAfterStep: true,
      });
    } else if (goal !== null) {
      outcomeHook = Object.freeze({
        kind: 'evaluate-above-zero-regulation-goal',
        scoringTeam: goal.scoringTeam,
        regulationStepsRemaining,
        effectiveAfterStep: true,
      });
    }

    const next = freezeState({
      ...state,
      regulationStepsRemaining,
      regulationActivePlayStepsCompleted,
      pendingOutcome: outcomeHook,
    }, config);
    return stepResult(state, gates, next, null, null, outcomeHook);
  }

  if (state.phase === 'overtime') {
    if (goal === null) return stepResult(state, gates, state);
    const outcomeHook: MatchOutcomeHook = Object.freeze({
      kind: 'resolve-overtime-sudden-death-goal',
      scoringTeam: goal.scoringTeam,
      effectiveAfterStep: true,
    });
    const next = freezeState({ ...state, pendingOutcome: outcomeHook }, config);
    return stepResult(state, gates, next, null, null, outcomeHook);
  }

  const exhaustivePhase: never = state.phase;
  throw new TypeError(`Unsupported match phase: ${String(exhaustivePhase)}.`);
}
