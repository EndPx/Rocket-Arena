import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NETCODE,
  PHYSICS,
  type RoomMode,
  type Team,
} from '@rocket-arena/shared';
import { FixedStepScheduler } from '../rooms/fixed-step-scheduler.js';
import {
  assertMatchFlowState,
  beginGoalReset,
  createInitialMatchFlowState,
  createMatchFlowConfig,
  reduceMatchFlowStep,
  type MatchFlowConfig,
  type MatchFlowSeed,
  type MatchFlowState,
  type MatchFlowStepResult,
  type ResolvedGoalResetInput,
} from './match-flow.js';

interface SeededRandom {
  integer(minInclusive: number, maxInclusive: number): number;
}

interface GeneratedCase<T> {
  readonly seed: string;
  readonly index: number;
  readonly value: T;
}

type CaseGenerator<T> = (random: SeededRandom, index: number) => T;

interface GeneratedCasesModule {
  generateCases<T>(options: {
    readonly seed: string | number;
    readonly count: number;
    readonly generate: CaseGenerator<T>;
  }): readonly GeneratedCase<T>[];
  replayCase<T>(
    seed: string | number,
    index: number,
    generate: CaseGenerator<T>,
  ): GeneratedCase<T>;
  assertGeneratedCases<T>(
    cases: readonly GeneratedCase<T>[],
    assertion: (value: T, generatedCase: GeneratedCase<T>) => void,
  ): void;
}

// This shared test helper is outside server/src, so load its source URL at
// runtime without adding it to the production server TypeScript emit graph.
const generatedCasesModuleUrl = new URL(
  '../../../shared/tests/support/generated-cases.ts',
  import.meta.url,
).href;
const {
  assertGeneratedCases,
  generateCases,
  replayCase,
} = await import(generatedCasesModuleUrl) as unknown as GeneratedCasesModule;

const RECORDED_SEED = 'rocket-arena-property-14-match-flow-timing-v1';
const GENERATED_CASE_COUNT = 100;
const REPLAY_CASE_INDEX = 79;
const COUNTDOWN_FIXED_STEPS = 180;
const GOAL_RESET_FIXED_STEPS = 120;
const MAX_CALLBACK_FIXED_STEPS = 5;

const DISABLED_TIMING_GATES = Object.freeze({
  controlsEnabled: false,
  physicsEnabled: true,
  synchronizeInputEdges: true,
  freezeKickoffState: false,
});

const ACTIVE_PLAY_GATES = Object.freeze({
  controlsEnabled: true,
  physicsEnabled: true,
  synchronizeInputEdges: false,
  freezeKickoffState: false,
});

type CallbackPartitionPair = readonly [readonly number[], readonly number[]];

interface GeneratedTimingCase {
  readonly caseIndex: number;
  readonly mode: RoomMode;
  readonly scoringTeam: Team;
  readonly initialSeed: Readonly<Required<MatchFlowSeed>>;
  readonly activeStepsBeforeGoal: number;
  readonly resolvedGoal: Readonly<ResolvedGoalResetInput>;
  readonly countdownPartitions: CallbackPartitionPair;
  readonly resetPartitions: CallbackPartitionPair;
}

interface TransitionTraceEntry {
  readonly completedStep: number;
  readonly transition: NonNullable<MatchFlowStepResult['transition']>;
}

interface KickoffResetTraceEntry {
  readonly completedStep: number;
  readonly kickoffReset: NonNullable<MatchFlowStepResult['kickoffReset']>;
}

interface SchedulerAccountingTotals {
  readonly fixedSteps: number;
  readonly simulationTimeMs: number;
  readonly droppedTimeMs: number;
}

interface CountdownPartitionResultTrace {
  readonly finalCountdownState: Readonly<MatchFlowState>;
  readonly countdownTransitionTrace: readonly TransitionTraceEntry[];
  readonly kickoffResetDirectives: readonly KickoffResetTraceEntry[];
  readonly schedulerTotals: Readonly<SchedulerAccountingTotals>;
}

interface GoalResetPartitionResultTrace {
  readonly finalPostGoalState: Readonly<MatchFlowState>;
  readonly resetTransitionTrace: readonly TransitionTraceEntry[];
  readonly kickoffResetDirectives: readonly KickoffResetTraceEntry[];
  readonly schedulerTotals: Readonly<SchedulerAccountingTotals>;
}

type PartitionResultPair<T> = readonly [T, T];

interface CanonicalTimingCaseResultTrace {
  readonly seed: string;
  readonly index: number;
  readonly countdownPartitions: PartitionResultPair<CountdownPartitionResultTrace>;
  readonly goalResetPartitions: PartitionResultPair<GoalResetPartitionResultTrace>;
}

function generateCallbackPartition(
  random: SeededRandom,
  totalFixedSteps: number,
): readonly number[] {
  const partition: number[] = [];
  let remaining = totalFixedSteps;
  while (remaining > 0) {
    const callbackSteps = random.integer(
      1,
      Math.min(MAX_CALLBACK_FIXED_STEPS, remaining),
    );
    partition.push(callbackSteps);
    remaining -= callbackSteps;
  }
  return Object.freeze(partition);
}

function partitionsEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function forceDistinctPartition(partition: readonly number[]): readonly number[] {
  const splitIndex = partition.findIndex((callbackSteps) => callbackSteps > 1);
  if (splitIndex >= 0) {
    const callbackSteps = partition[splitIndex]!;
    return Object.freeze([
      ...partition.slice(0, splitIndex),
      1,
      callbackSteps - 1,
      ...partition.slice(splitIndex + 1),
    ]);
  }

  // The timing totals are both greater than one, so two one-step callbacks can
  // always be merged if the generated partition happened to contain only ones.
  return Object.freeze([2, ...partition.slice(2)]);
}

function generatePartitionPair(
  random: SeededRandom,
  totalFixedSteps: number,
): CallbackPartitionPair {
  const first = generateCallbackPartition(random, totalFixedSteps);
  const candidate = generateCallbackPartition(random, totalFixedSteps);
  const second = partitionsEqual(first, candidate)
    ? forceDistinctPartition(candidate)
    : candidate;
  return Object.freeze([first, second]);
}

function generateTimingCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedTimingCase {
  const mode: RoomMode = caseIndex % 2 === 0 ? 'quick' : 'custom';
  const scoringTeam: Team = caseIndex % 2 === 0 ? 'blue' : 'orange';
  const blueScore = random.integer(0, 4);
  const orangeScore = random.integer(0, 4);
  const initialSeed = Object.freeze({
    blueScore,
    orangeScore,
    kickoffEpoch: random.integer(0, 10_000),
    transitionSequence: random.integer(0, 10_000),
  });
  const resolvedGoal = Object.freeze({
    blueScore: blueScore + Number(scoringTeam === 'blue'),
    orangeScore: orangeScore + Number(scoringTeam === 'orange'),
  });

  return Object.freeze({
    caseIndex,
    mode,
    scoringTeam,
    initialSeed,
    activeStepsBeforeGoal: random.integer(0, 600),
    resolvedGoal,
    countdownPartitions: generatePartitionPair(random, COUNTDOWN_FIXED_STEPS),
    resetPartitions: generatePartitionPair(random, GOAL_RESET_FIXED_STEPS),
  });
}

function createScheduler(): FixedStepScheduler {
  return new FixedStepScheduler({
    fixedStepSeconds: PHYSICS.TIMESTEP,
    maxFrameDeltaSeconds: PHYSICS.MAX_FRAME_DELTA_SECONDS,
    maxSubsteps: PHYSICS.MAX_FIXED_SUBSTEPS,
    snapshotIntervalMs: NETCODE.SNAPSHOT_TARGET_INTERVAL_MS,
    snapshotSchedulingToleranceMs: NETCODE.SNAPSHOT_SCHEDULING_TOLERANCE_MS,
  });
}

function executeScheduledPartition(
  partition: readonly number[],
  expectedFixedSteps: number,
  executeStep: (completedStep: number) => void,
): Readonly<SchedulerAccountingTotals> {
  const scheduler = createScheduler();
  let completedSteps = 0;
  let droppedTimeMs = 0;

  for (const callbackSteps of partition) {
    assert.ok(callbackSteps >= 1);
    assert.ok(callbackSteps <= MAX_CALLBACK_FIXED_STEPS);
    assert.ok(callbackSteps <= PHYSICS.MAX_FIXED_SUBSTEPS);

    const callbackDeltaMs = callbackSteps * PHYSICS.TIMESTEP * 1_000;
    assert.ok(callbackDeltaMs < PHYSICS.MAX_FRAME_DELTA_SECONDS * 1_000);

    const frame = scheduler.advance(callbackDeltaMs);
    assert.equal(frame.clampedDeltaMs, callbackDeltaMs);
    assert.equal(frame.fixedSteps, callbackSteps);
    assert.equal(frame.droppedTimeMs, 0);
    droppedTimeMs += frame.droppedTimeMs;

    for (let frameStep = 0; frameStep < frame.fixedSteps; frameStep += 1) {
      completedSteps += 1;
      executeStep(completedSteps);
    }
  }

  assert.equal(completedSteps, expectedFixedSteps);
  assert.equal(droppedTimeMs, 0);
  assert.ok(
    Math.abs(
      scheduler.simulationTimeMs
        - expectedFixedSteps * PHYSICS.TIMESTEP * 1_000,
    ) < 1e-8,
  );

  return Object.freeze({
    fixedSteps: completedSteps,
    simulationTimeMs: scheduler.simulationTimeMs,
    droppedTimeMs,
  });
}

function executeCountdownPartition(
  initialState: Readonly<MatchFlowState>,
  config: Readonly<MatchFlowConfig>,
  partition: readonly number[],
): CountdownPartitionResultTrace {
  let state = initialState;
  const transitionTrace: TransitionTraceEntry[] = [];
  const kickoffResetTrace: KickoffResetTraceEntry[] = [];
  const preservedBlueScore = initialState.blueScore;
  const preservedOrangeScore = initialState.orangeScore;
  const preservedRegulationSteps = initialState.regulationStepsRemaining;
  const preservedRegulationCompleted = initialState.regulationActivePlayStepsCompleted;

  const schedulerTotals = executeScheduledPartition(partition, COUNTDOWN_FIXED_STEPS, (completedStep) => {
    const result = reduceMatchFlowStep(state, config);

    assert.equal(result.phaseDuringStep, 'countdown');
    assert.deepEqual(result.gates, DISABLED_TIMING_GATES);
    assert.equal(result.state.blueScore, preservedBlueScore);
    assert.equal(result.state.orangeScore, preservedOrangeScore);
    assert.equal(result.state.regulationStepsRemaining, preservedRegulationSteps);
    assert.equal(
      result.state.regulationActivePlayStepsCompleted,
      preservedRegulationCompleted,
    );
    assert.equal(result.kickoffReset, null);
    assert.equal(result.outcomeHook, null);

    if (completedStep < COUNTDOWN_FIXED_STEPS) {
      assert.equal(result.state.phase, 'countdown');
      assert.equal(
        result.state.countdownStepsRemaining,
        COUNTDOWN_FIXED_STEPS - completedStep,
      );
      assert.equal(result.transition, null);
    } else {
      assert.equal(result.state.phase, 'playing');
      assert.equal(result.state.countdownKind, null);
      assert.equal(result.state.countdownStepsRemaining, 0);
      assert.equal(result.state.kickoffEpoch, initialState.kickoffEpoch + 1);
      assert.deepEqual(result.transition, {
        sequence: initialState.transitionSequence + 1,
        kind: 'countdown-complete',
        fromPhase: 'countdown',
        toPhase: 'playing',
        countdownKind: 'initial',
        effectiveAfterStep: true,
      });
    }

    if (result.transition !== null) {
      transitionTrace.push({ completedStep, transition: result.transition });
    }
    if (result.kickoffReset !== null) {
      kickoffResetTrace.push({ completedStep, kickoffReset: result.kickoffReset });
    }
    state = result.state;
  });

  assert.deepEqual(transitionTrace, [{
    completedStep: COUNTDOWN_FIXED_STEPS,
    transition: {
      sequence: initialState.transitionSequence + 1,
      kind: 'countdown-complete',
      fromPhase: 'countdown',
      toPhase: 'playing',
      countdownKind: 'initial',
      effectiveAfterStep: true,
    },
  }]);
  assert.deepEqual(kickoffResetTrace, []);
  assertMatchFlowState(state, config);

  const firstActiveStep = reduceMatchFlowStep(state, config);
  assert.equal(firstActiveStep.phaseDuringStep, 'playing');
  assert.deepEqual(firstActiveStep.gates, ACTIVE_PLAY_GATES);
  assert.equal(firstActiveStep.state.regulationStepsRemaining, preservedRegulationSteps - 1);
  assert.equal(
    firstActiveStep.state.regulationActivePlayStepsCompleted,
    preservedRegulationCompleted + 1,
  );
  assert.equal(firstActiveStep.state.blueScore, preservedBlueScore);
  assert.equal(firstActiveStep.state.orangeScore, preservedOrangeScore);
  assert.equal(firstActiveStep.transition, null);
  assert.equal(firstActiveStep.kickoffReset, null);
  assert.equal(firstActiveStep.outcomeHook, null);

  return Object.freeze({
    finalCountdownState: state,
    countdownTransitionTrace: Object.freeze(transitionTrace),
    kickoffResetDirectives: Object.freeze(kickoffResetTrace),
    schedulerTotals,
  });
}

function advanceActiveRegulationSteps(
  playingState: Readonly<MatchFlowState>,
  config: Readonly<MatchFlowConfig>,
  activeSteps: number,
): Readonly<MatchFlowState> {
  let state = playingState;
  for (let completed = 0; completed < activeSteps; completed += 1) {
    const result = reduceMatchFlowStep(state, config);
    assert.equal(result.phaseDuringStep, 'playing');
    assert.deepEqual(result.gates, ACTIVE_PLAY_GATES);
    assert.equal(result.transition, null);
    assert.equal(result.kickoffReset, null);
    assert.equal(result.outcomeHook, null);
    state = result.state;
  }
  return state;
}

function executeResetPartition(
  resetState: Readonly<MatchFlowState>,
  config: Readonly<MatchFlowConfig>,
  partition: readonly number[],
): GoalResetPartitionResultTrace {
  let state = resetState;
  const transitionTrace: TransitionTraceEntry[] = [];
  const kickoffResetTrace: KickoffResetTraceEntry[] = [];
  const preservedBlueScore = resetState.blueScore;
  const preservedOrangeScore = resetState.orangeScore;
  const preservedRegulationSteps = resetState.regulationStepsRemaining;
  const preservedRegulationCompleted = resetState.regulationActivePlayStepsCompleted;

  const schedulerTotals = executeScheduledPartition(partition, GOAL_RESET_FIXED_STEPS, (completedStep) => {
    const stateBeforeStep = state;
    const result = reduceMatchFlowStep(stateBeforeStep, config);

    assert.equal(result.phaseDuringStep, 'goal-reset');
    assert.deepEqual(result.gates, DISABLED_TIMING_GATES);
    assert.equal(result.state.blueScore, preservedBlueScore);
    assert.equal(result.state.orangeScore, preservedOrangeScore);
    assert.equal(result.state.regulationStepsRemaining, preservedRegulationSteps);
    assert.equal(
      result.state.regulationActivePlayStepsCompleted,
      preservedRegulationCompleted,
    );
    assert.equal(result.outcomeHook, null);

    if (completedStep < GOAL_RESET_FIXED_STEPS) {
      assert.equal(result.state.phase, 'goal-reset');
      assert.equal(
        result.state.goalResetStepsRemaining,
        GOAL_RESET_FIXED_STEPS - completedStep,
      );
      assert.equal(result.transition, null);
      assert.equal(result.kickoffReset, null);
    } else {
      assert.deepEqual(reduceMatchFlowStep(stateBeforeStep, config), result);
      assert.equal(result.state.phase, 'countdown');
      assert.equal(result.state.countdownKind, 'post-goal');
      assert.equal(result.state.countdownStepsRemaining, COUNTDOWN_FIXED_STEPS);
      assert.equal(result.state.goalResetStepsRemaining, 0);
      assert.equal(result.state.kickoffEpoch, resetState.kickoffEpoch);
      assert.deepEqual(result.transition, {
        sequence: resetState.transitionSequence + 1,
        kind: 'goal-reset-complete',
        fromPhase: 'goal-reset',
        toPhase: 'countdown',
        countdownKind: 'post-goal',
        effectiveAfterStep: true,
      });
      assert.deepEqual(result.kickoffReset, {
        reason: 'post-goal',
        targetKickoffEpoch: resetState.kickoffEpoch + 1,
        resetCars: true,
        resetBall: true,
        zeroLinearVelocity: true,
        zeroAngularVelocity: true,
        effectiveAfterStep: true,
      });
    }

    if (result.transition !== null) {
      transitionTrace.push({ completedStep, transition: result.transition });
    }
    if (result.kickoffReset !== null) {
      kickoffResetTrace.push({ completedStep, kickoffReset: result.kickoffReset });
    }
    state = result.state;
  });

  assert.deepEqual(transitionTrace, [{
    completedStep: GOAL_RESET_FIXED_STEPS,
    transition: {
      sequence: resetState.transitionSequence + 1,
      kind: 'goal-reset-complete',
      fromPhase: 'goal-reset',
      toPhase: 'countdown',
      countdownKind: 'post-goal',
      effectiveAfterStep: true,
    },
  }]);
  assert.deepEqual(kickoffResetTrace, [{
    completedStep: GOAL_RESET_FIXED_STEPS,
    kickoffReset: {
      reason: 'post-goal',
      targetKickoffEpoch: resetState.kickoffEpoch + 1,
      resetCars: true,
      resetBall: true,
      zeroLinearVelocity: true,
      zeroAngularVelocity: true,
      effectiveAfterStep: true,
    },
  }]);
  assertMatchFlowState(state, config);

  return Object.freeze({
    finalPostGoalState: state,
    resetTransitionTrace: Object.freeze(transitionTrace),
    kickoffResetDirectives: Object.freeze(kickoffResetTrace),
    schedulerTotals,
  });
}

function assertPartition(
  partition: readonly number[],
  expectedFixedSteps: number,
): void {
  assert.equal(
    partition.reduce((total, callbackSteps) => total + callbackSteps, 0),
    expectedFixedSteps,
  );
  for (const callbackSteps of partition) {
    assert.ok(callbackSteps >= 1 && callbackSteps <= MAX_CALLBACK_FIXED_STEPS);
    assert.ok(
      callbackSteps * PHYSICS.TIMESTEP * 1_000
        < PHYSICS.MAX_FRAME_DELTA_SECONDS * 1_000,
    );
  }
}

function executeTimingCase(
  generated: GeneratedTimingCase,
  generatedCase: GeneratedCase<GeneratedTimingCase>,
): CanonicalTimingCaseResultTrace {
  assert.equal(generatedCase.seed, RECORDED_SEED);
  assert.equal(generatedCase.index, generated.caseIndex);

  const config = createMatchFlowConfig(generated.mode);
  assert.equal(config.rules.kickoffCountdownSteps, COUNTDOWN_FIXED_STEPS);
  assert.equal(config.goalResetSteps, GOAL_RESET_FIXED_STEPS);
  assert.equal(PHYSICS.MAX_FIXED_SUBSTEPS, MAX_CALLBACK_FIXED_STEPS);

  const [firstCountdownPartition, secondCountdownPartition]
    = generated.countdownPartitions;
  assertPartition(firstCountdownPartition, COUNTDOWN_FIXED_STEPS);
  assertPartition(secondCountdownPartition, COUNTDOWN_FIXED_STEPS);
  assert.notDeepEqual(firstCountdownPartition, secondCountdownPartition);

  const initialState = createInitialMatchFlowState(config, generated.initialSeed);
  assertMatchFlowState(initialState, config);
  assert.equal(initialState.phase, 'countdown');
  assert.equal(initialState.countdownKind, 'initial');
  assert.equal(initialState.countdownStepsRemaining, COUNTDOWN_FIXED_STEPS);
  assert.equal(
    initialState.regulationStepsRemaining,
    config.rules.regulationActivePlaySteps,
  );
  assert.equal(initialState.regulationActivePlayStepsCompleted, 0);

  const firstCountdown = executeCountdownPartition(
    initialState,
    config,
    firstCountdownPartition,
  );
  const secondCountdown = executeCountdownPartition(
    initialState,
    config,
    secondCountdownPartition,
  );
  assert.deepEqual(
    firstCountdown.finalCountdownState,
    secondCountdown.finalCountdownState,
  );
  assert.deepEqual(
    firstCountdown.countdownTransitionTrace,
    secondCountdown.countdownTransitionTrace,
  );
  assert.deepEqual(
    firstCountdown.kickoffResetDirectives,
    secondCountdown.kickoffResetDirectives,
  );

  const playingBeforeGoal = advanceActiveRegulationSteps(
    firstCountdown.finalCountdownState,
    config,
    generated.activeStepsBeforeGoal,
  );
  assert.equal(
    playingBeforeGoal.regulationStepsRemaining,
    config.rules.regulationActivePlaySteps - generated.activeStepsBeforeGoal,
  );
  assert.equal(
    playingBeforeGoal.regulationActivePlayStepsCompleted,
    generated.activeStepsBeforeGoal,
  );
  assert.equal(playingBeforeGoal.blueScore, generated.initialSeed.blueScore);
  assert.equal(playingBeforeGoal.orangeScore, generated.initialSeed.orangeScore);

  assert.equal(
    generated.resolvedGoal.blueScore - playingBeforeGoal.blueScore,
    Number(generated.scoringTeam === 'blue'),
  );
  assert.equal(
    generated.resolvedGoal.orangeScore - playingBeforeGoal.orangeScore,
    Number(generated.scoringTeam === 'orange'),
  );
  const resolvedScoringTeamScore = generated.scoringTeam === 'blue'
    ? generated.resolvedGoal.blueScore
    : generated.resolvedGoal.orangeScore;
  assert.ok(resolvedScoringTeamScore < config.rules.Regulation_Goal_Target);

  const resetState = beginGoalReset(
    playingBeforeGoal,
    config,
    generated.resolvedGoal,
  );
  assertMatchFlowState(resetState, config);
  assert.equal(resetState.phase, 'goal-reset');
  assert.equal(resetState.goalResetStepsRemaining, GOAL_RESET_FIXED_STEPS);
  assert.equal(resetState.blueScore, generated.resolvedGoal.blueScore);
  assert.equal(resetState.orangeScore, generated.resolvedGoal.orangeScore);
  assert.equal(
    resetState.regulationStepsRemaining,
    playingBeforeGoal.regulationStepsRemaining,
  );
  assert.equal(
    resetState.regulationActivePlayStepsCompleted,
    playingBeforeGoal.regulationActivePlayStepsCompleted,
  );

  const [firstResetPartition, secondResetPartition] = generated.resetPartitions;
  assertPartition(firstResetPartition, GOAL_RESET_FIXED_STEPS);
  assertPartition(secondResetPartition, GOAL_RESET_FIXED_STEPS);
  assert.notDeepEqual(firstResetPartition, secondResetPartition);

  const firstReset = executeResetPartition(resetState, config, firstResetPartition);
  const secondReset = executeResetPartition(resetState, config, secondResetPartition);
  assert.deepEqual(firstReset.finalPostGoalState, secondReset.finalPostGoalState);
  assert.deepEqual(firstReset.resetTransitionTrace, secondReset.resetTransitionTrace);
  assert.deepEqual(firstReset.kickoffResetDirectives, secondReset.kickoffResetDirectives);

  return Object.freeze({
    seed: generatedCase.seed,
    index: generatedCase.index,
    countdownPartitions: Object.freeze([firstCountdown, secondCountdown] as const),
    goalResetPartitions: Object.freeze([firstReset, secondReset] as const),
  });
}

function executeTimingCases(
  cases: readonly GeneratedCase<GeneratedTimingCase>[],
): readonly CanonicalTimingCaseResultTrace[] {
  const resultTrace: CanonicalTimingCaseResultTrace[] = [];
  assertGeneratedCases(cases, (generated, generatedCase) => {
    resultTrace.push(executeTimingCase(generated, generatedCase));
  });
  return Object.freeze(resultTrace);
}

function assertCanonicalResultSequencesEqual(
  actual: readonly CanonicalTimingCaseResultTrace[],
  expected: readonly CanonicalTimingCaseResultTrace[],
  diagnosticCases: readonly GeneratedCase<GeneratedTimingCase>[],
): void {
  assert.equal(actual.length, diagnosticCases.length);
  assert.equal(expected.length, diagnosticCases.length);

  let resultIndex = 0;
  assertGeneratedCases(diagnosticCases, () => {
    assert.deepEqual(actual[resultIndex], expected[resultIndex]);
    resultIndex += 1;
  });
  assert.deepEqual(actual, expected);
}

/**
 * Feature: rocket-arena, Property 14: Fixed-step kickoff and reset timing
 * **Validates: Requirements 13.3, 13.5-13.8, 13.15-13.16, 18.22-18.23**
 */
test(
  `Property 14: fixed-step kickoff and reset timing (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  () => {
    const originalCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateTimingCase,
    });
    const regeneratedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateTimingCase,
    });
    const replayedCase = replayCase(
      RECORDED_SEED,
      REPLAY_CASE_INDEX,
      generateTimingCase,
    );
    const replayedCases = Object.freeze([replayedCase]);

    assert.equal(originalCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(
      originalCases.map((generatedCase) => generatedCase.index),
      Array.from({ length: GENERATED_CASE_COUNT }, (_, index) => index),
    );
    assert.deepEqual(originalCases, regeneratedCases);
    assert.deepEqual(replayedCase, originalCases[REPLAY_CASE_INDEX]);
    assert.deepEqual({
      quick: originalCases.filter(({ value }) => value.mode === 'quick').length,
      custom: originalCases.filter(({ value }) => value.mode === 'custom').length,
    }, {
      quick: 50,
      custom: 50,
    });

    const originalResultTrace = executeTimingCases(originalCases);
    const regeneratedResultTrace = executeTimingCases(regeneratedCases);
    const replayedResultTrace = executeTimingCases(replayedCases);

    assert.equal(originalResultTrace.length, GENERATED_CASE_COUNT);
    assert.equal(regeneratedResultTrace.length, GENERATED_CASE_COUNT);
    assert.equal(replayedResultTrace.length, 1);
    assertCanonicalResultSequencesEqual(
      regeneratedResultTrace,
      originalResultTrace,
      regeneratedCases,
    );
    assertCanonicalResultSequencesEqual(
      replayedResultTrace,
      Object.freeze([originalResultTrace[REPLAY_CASE_INDEX]!]),
      replayedCases,
    );
  },
);
