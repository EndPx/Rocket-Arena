import { getConstant } from '@rocket-arena/shared/constants';

export interface TimerState {
  timeRemaining: number;
  phase: string;
  goalResetTimer: number;
}

/**
 * Update match timer. Call each physics tick.
 * Returns the new phase if a transition occurred, null otherwise.
 */
export function updateTimer(state: TimerState, dt: number): string | null {
  // Only count down during 'playing' phase
  if (state.phase === 'playing') {
    state.timeRemaining -= dt;

    if (state.timeRemaining <= 0) {
      state.timeRemaining = 0;
      return 'time-up'; // Caller decides: end or overtime
    }
  }

  // Goal reset countdown
  if (state.phase === 'goal-scored') {
    state.goalResetTimer -= dt;
    if (state.goalResetTimer <= 0) {
      state.goalResetTimer = 0;
      return 'reset-complete'; // Caller resets and resumes
    }
  }

  return null;
}

/**
 * Determine what happens when time runs out.
 */
export function resolveTimeUp(blueScore: number, orangeScore: number): 'ended' | 'overtime' {
  if (blueScore === orangeScore) return 'overtime';
  return 'ended';
}

/**
 * Get the goal reset delay from constants.
 */
export function getGoalResetDelay(): number {
  return getConstant('MATCH.GOAL_RESET_DELAY');
}
