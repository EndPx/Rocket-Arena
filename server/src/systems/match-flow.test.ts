import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MATCH_RULES,
  createGoalResult,
  createTerminalResult,
} from '@rocket-arena/shared';
import {
  beginGoalReset,
  beginOvertimeCountdown,
  createEndedMatchFlowState,
  createInitialMatchFlowState,
  createMatchFlowConfig,
  createWaitingMatchFlowState,
  getMatchFlowStepGates,
  getPhaseSecondsRemaining,
  getRegulationSecondsRemaining,
  reduceMatchFlowStep,
  type MatchFlowState,
} from './match-flow.js';

function completeInitialCountdown(
  state: Readonly<MatchFlowState>,
  mode: 'quick' | 'custom' = 'quick',
): Readonly<MatchFlowState> {
  const config = createMatchFlowConfig(mode);
  let current = state;
  for (let step = 0; step < MATCH_RULES.kickoffCountdownSteps; step += 1) {
    current = reduceMatchFlowStep(current, config).state;
  }
  return current;
}

// Validates: Requirements 13.1-13.4

test('Quick and Custom configs share confirmed rules and derive 120 reset steps', () => {
  const quick = createMatchFlowConfig('quick');
  const custom = createMatchFlowConfig('custom');

  assert.equal(quick.rules, MATCH_RULES);
  assert.equal(custom.rules, MATCH_RULES);
  assert.equal(quick.rules, custom.rules);
  assert.equal(quick.rules.regulationActivePlaySteps, 18_000);
  assert.equal(quick.rules.kickoffCountdownSteps, 180);
  assert.equal(quick.goalResetDurationSeconds, 2);
  assert.equal(quick.goalResetSteps, 120);
  assert.equal(custom.goalResetSteps, 120);
  assert.ok(Object.isFrozen(quick));
  assert.ok(Object.isFrozen(custom));
});

// Validates: Requirements 13.1-13.3, 13.5-13.8, 18.22

test('initial countdown completes after exactly 180 disabled steps and never early', () => {
  const config = createMatchFlowConfig('quick');
  let state = createInitialMatchFlowState(config, {
    blueScore: 2,
    orangeScore: 1,
  });

  assert.equal(state.countdownStepsRemaining, 180);
  assert.equal(state.regulationStepsRemaining, 18_000);
  assert.equal(getRegulationSecondsRemaining(state, config), 300);
  assert.equal(getPhaseSecondsRemaining(state, config), 3);

  for (let completed = 1; completed < 180; completed += 1) {
    const result = reduceMatchFlowStep(state, config);
    assert.equal(result.phaseDuringStep, 'countdown');
    assert.deepEqual(result.gates, {
      controlsEnabled: false,
      physicsEnabled: true,
      synchronizeInputEdges: true,
      freezeKickoffState: false,
    });
    assert.equal(result.state.phase, 'countdown');
    assert.equal(result.state.countdownStepsRemaining, 180 - completed);
    assert.equal(result.state.regulationStepsRemaining, 18_000);
    assert.equal(result.state.blueScore, 2);
    assert.equal(result.state.orangeScore, 1);
    assert.equal(result.transition, null);
    state = result.state;
  }

  const completing = reduceMatchFlowStep(state, config);
  assert.equal(completing.phaseDuringStep, 'countdown');
  assert.equal(completing.gates.controlsEnabled, false);
  assert.equal(completing.gates.synchronizeInputEdges, true);
  assert.equal(completing.state.phase, 'playing');
  assert.equal(completing.state.countdownStepsRemaining, 0);
  assert.equal(completing.state.regulationStepsRemaining, 18_000);
  assert.equal(completing.state.regulationActivePlayStepsCompleted, 0);
  assert.equal(completing.state.kickoffEpoch, 1);
  assert.deepEqual(completing.transition, {
    sequence: 1,
    kind: 'countdown-complete',
    fromPhase: 'countdown',
    toPhase: 'playing',
    countdownKind: 'initial',
    effectiveAfterStep: true,
  });

  const firstActiveStep = reduceMatchFlowStep(completing.state, config);
  assert.equal(firstActiveStep.phaseDuringStep, 'playing');
  assert.equal(firstActiveStep.gates.controlsEnabled, true);
  assert.equal(firstActiveStep.gates.synchronizeInputEdges, false);
  assert.equal(firstActiveStep.state.regulationStepsRemaining, 17_999);
  assert.equal(firstActiveStep.state.regulationActivePlayStepsCompleted, 1);
});

// Validates: Requirements 13.5-13.8, 13.15-13.16, 18.23

test('goal reset lasts exactly 120 disabled steps and emits deterministic reset output', () => {
  const config = createMatchFlowConfig('custom');
  const playing = completeInitialCountdown(createInitialMatchFlowState(config), 'custom');
  const resetStart = beginGoalReset(playing, config, {
    blueScore: 1,
    orangeScore: 0,
    latestGoal: createGoalResult({
      eventId: 2,
      team: 'blue',
      kickoffEpoch: playing.kickoffEpoch,
      blueScore: 1,
      orangeScore: 0,
    }),
  });
  const preservedRegulationSteps = resetStart.regulationStepsRemaining;
  let state = resetStart;

  assert.equal(state.goalResetStepsRemaining, 120);
  assert.equal(getPhaseSecondsRemaining(state, config), 2);

  for (let completed = 1; completed < 120; completed += 1) {
    const result = reduceMatchFlowStep(state, config);
    assert.equal(result.phaseDuringStep, 'goal-reset');
    assert.equal(result.gates.controlsEnabled, false);
    assert.equal(result.gates.synchronizeInputEdges, true);
    assert.equal(result.state.phase, 'goal-reset');
    assert.equal(result.state.goalResetStepsRemaining, 120 - completed);
    assert.equal(result.state.regulationStepsRemaining, preservedRegulationSteps);
    assert.equal(result.state.blueScore, 1);
    assert.equal(result.state.orangeScore, 0);
    assert.equal(result.kickoffReset, null);
    state = result.state;
  }

  const firstCompletion = reduceMatchFlowStep(state, config);
  const repeatedCompletion = reduceMatchFlowStep(state, config);
  assert.deepEqual(firstCompletion, repeatedCompletion);
  assert.equal(firstCompletion.phaseDuringStep, 'goal-reset');
  assert.equal(firstCompletion.gates.controlsEnabled, false);
  assert.equal(firstCompletion.state.phase, 'countdown');
  assert.equal(firstCompletion.state.countdownKind, 'post-goal');
  assert.equal(firstCompletion.state.countdownStepsRemaining, 180);
  assert.equal(firstCompletion.state.goalResetStepsRemaining, 0);
  assert.equal(firstCompletion.state.regulationStepsRemaining, preservedRegulationSteps);
  assert.equal(firstCompletion.state.blueScore, 1);
  assert.equal(firstCompletion.state.orangeScore, 0);
  assert.deepEqual(firstCompletion.kickoffReset, {
    reason: 'post-goal',
    targetKickoffEpoch: playing.kickoffEpoch + 1,
    resetCars: true,
    resetBall: true,
    zeroLinearVelocity: true,
    zeroAngularVelocity: true,
    effectiveAfterStep: true,
  });
  assert.equal(firstCompletion.transition?.effectiveAfterStep, true);
});

// Validates: Requirements 13.5-13.8, 13.22-13.23

test('disabled phases synchronize input edges and overtime countdown freezes physics', () => {
  const config = createMatchFlowConfig('quick');
  const waiting = createWaitingMatchFlowState(config);
  const playing = completeInitialCountdown(createInitialMatchFlowState(config));
  const goalReset = beginGoalReset(playing, config, {
    blueScore: 1,
    orangeScore: 0,
  });
  const overtimeCountdown = beginOvertimeCountdown(
    completeInitialCountdown(createInitialMatchFlowState(config)),
    config,
  );

  assert.deepEqual(getMatchFlowStepGates(waiting), {
    controlsEnabled: false,
    physicsEnabled: false,
    synchronizeInputEdges: true,
    freezeKickoffState: false,
  });
  assert.deepEqual(getMatchFlowStepGates(goalReset), {
    controlsEnabled: false,
    physicsEnabled: true,
    synchronizeInputEdges: true,
    freezeKickoffState: false,
  });
  assert.deepEqual(getMatchFlowStepGates(overtimeCountdown), {
    controlsEnabled: false,
    physicsEnabled: false,
    synchronizeInputEdges: true,
    freezeKickoffState: true,
  });

  let state = overtimeCountdown;
  for (let completed = 1; completed < 180; completed += 1) {
    const result = reduceMatchFlowStep(state, config);
    assert.equal(result.phaseDuringStep, 'countdown');
    assert.equal(result.gates.freezeKickoffState, true);
    assert.equal(result.gates.physicsEnabled, false);
    assert.equal(result.state.phase, 'countdown');
    assert.equal(result.state.regulationStepsRemaining, 0);
    assert.equal(result.state.blueScore, result.state.orangeScore);
    state = result.state;
  }

  const completing = reduceMatchFlowStep(state, config);
  assert.equal(completing.phaseDuringStep, 'countdown');
  assert.equal(completing.gates.freezeKickoffState, true);
  assert.equal(completing.gates.controlsEnabled, false);
  assert.equal(completing.state.phase, 'overtime');
  assert.equal(completing.state.regulationStepsRemaining, 0);
  assert.equal(completing.state.blueScore, completing.state.orangeScore);

  const firstOvertimeStep = reduceMatchFlowStep(completing.state, config);
  assert.equal(firstOvertimeStep.phaseDuringStep, 'overtime');
  assert.equal(firstOvertimeStep.gates.controlsEnabled, true);
  assert.equal(firstOvertimeStep.gates.physicsEnabled, true);
  assert.equal(firstOvertimeStep.state, completing.state);
});

// Validates: Requirements 13.2, 13.6-13.7

test('regulation time and scores advance only during regulation Active_Play', () => {
  const config = createMatchFlowConfig('quick');
  let countdown = createInitialMatchFlowState(config, { blueScore: 4, orangeScore: 3 });
  const initialRegulation = countdown.regulationStepsRemaining;

  for (let index = 0; index < 25; index += 1) {
    countdown = reduceMatchFlowStep(countdown, config).state;
  }
  assert.equal(countdown.regulationStepsRemaining, initialRegulation);
  assert.equal(countdown.blueScore, 4);
  assert.equal(countdown.orangeScore, 3);

  const playing = completeInitialCountdown(createInitialMatchFlowState(config, {
    blueScore: 4,
    orangeScore: 3,
  }));
  const activeResult = reduceMatchFlowStep(playing, config);
  assert.equal(activeResult.state.regulationStepsRemaining, initialRegulation - 1);
  assert.equal(activeResult.state.blueScore, 4);
  assert.equal(activeResult.state.orangeScore, 3);

  const reset = beginGoalReset(activeResult.state, config, {
    blueScore: 4,
    orangeScore: 4,
  });
  const resetResult = reduceMatchFlowStep(reset, config);
  assert.equal(resetResult.state.regulationStepsRemaining, initialRegulation - 1);
  assert.equal(resetResult.state.blueScore, 4);
  assert.equal(resetResult.state.orangeScore, 4);
});

// Task 6.4 owns these decisions; 4.4 exposes ordered hooks only.

test('outcome hooks defer scoring, target/margin, cutoff, and sudden death decisions', () => {
  const config = createMatchFlowConfig('quick');
  const playing = completeInitialCountdown(createInitialMatchFlowState(config));
  const aboveZero = reduceMatchFlowStep(playing, config, {
    validGoal: { scoringTeam: 'blue' },
  });

  assert.deepEqual(aboveZero.outcomeHook, {
    kind: 'evaluate-above-zero-regulation-goal',
    scoringTeam: 'blue',
    regulationStepsRemaining: 17_999,
    effectiveAfterStep: true,
  });
  assert.equal(aboveZero.state.blueScore, 0);
  assert.equal(aboveZero.state.orangeScore, 0);
  assert.throws(
    () => reduceMatchFlowStep(aboveZero.state, config),
    /must be resolved/,
  );

  const overtime = beginOvertimeCountdown(playing, config);
  const suddenDeath = completeInitialCountdown(overtime);
  const overtimeGoal = reduceMatchFlowStep(suddenDeath, config, {
    validGoal: { scoringTeam: 'orange' },
  });
  assert.equal(overtimeGoal.outcomeHook?.kind, 'resolve-overtime-sudden-death-goal');
  assert.equal(overtimeGoal.state.blueScore, 0);
  assert.equal(overtimeGoal.state.orangeScore, 0);
});

// Validates: Requirements 13.22

test('Ended_State projection and terminal fields remain immutable across later steps', () => {
  const config = createMatchFlowConfig('custom');
  const playing = completeInitialCountdown(createInitialMatchFlowState(config));
  const terminal = createTerminalResult({
    eventId: 2,
    reason: 'hard-regulation-cutoff',
    winner: 'blue',
    blueScore: 2,
    orangeScore: 1,
    goal: null,
  });
  const ended = createEndedMatchFlowState(playing, config, terminal);

  assert.ok(Object.isFrozen(ended));
  assert.ok(Object.isFrozen(ended.terminalResult));
  assert.equal(ended.phase, 'ended');
  assert.equal(ended.blueScore, 2);
  assert.equal(ended.orangeScore, 1);
  assert.equal(ended.winner, 'blue');
  assert.equal(ended.regulationStepsRemaining, 0);
  assert.deepEqual(getMatchFlowStepGates(ended), {
    controlsEnabled: false,
    physicsEnabled: false,
    synchronizeInputEdges: true,
    freezeKickoffState: true,
  });

  const firstLaterStep = reduceMatchFlowStep(ended, config, {
    validGoal: { scoringTeam: 'orange' },
  });
  const secondLaterStep = reduceMatchFlowStep(firstLaterStep.state, config);
  assert.equal(firstLaterStep.state, ended);
  assert.equal(secondLaterStep.state, ended);
  assert.equal(firstLaterStep.transition, null);
  assert.equal(firstLaterStep.outcomeHook, null);
  assert.equal(firstLaterStep.state.terminalResult, ended.terminalResult);
  assert.deepEqual(firstLaterStep.state.terminalResult, terminal);
});
