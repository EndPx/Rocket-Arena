import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
} from '@rocket-arena/shared/tuning';

export interface TimerState {
  timeRemaining: number;
  phase: string;
  goalResetTimer: number;
}

/** Legacy fixed-step timer compatibility path pending the pure match reducer. */
export function updateTimer(state: TimerState, dt: number): string | null {
  if (state.phase === 'playing') {
    state.timeRemaining -= dt;
    if (state.timeRemaining <= 0) {
      state.timeRemaining = 0;
      return 'time-up';
    }
  }

  if (state.phase === 'goal-reset') {
    state.goalResetTimer -= dt;
    if (state.goalResetTimer <= 0) {
      state.goalResetTimer = 0;
      return 'reset-complete';
    }
  }

  return null;
}

export function resolveTimeUp(blueScore: number, orangeScore: number): 'ended' | 'overtime' {
  return blueScore === orangeScore ? 'overtime' : 'ended';
}

/** Read the staged two-second hypothesis from the immutable tuning snapshot. */
export function getGoalResetDelay(): number {
  return getScalarTuningValue(
    DEFAULT_TUNING_REGISTRY_SNAPSHOT,
    TUNING_IDS.match.regulationGoalResetSeconds,
  );
}
