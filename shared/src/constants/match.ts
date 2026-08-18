import type { RoomMode } from '../types/room.js';

export const FIXED_STEPS_PER_SECOND = 60 as const;
export const REGULATION_DURATION_SECONDS = 300 as const;
export const REGULATION_ACTIVE_PLAY_STEPS = 18_000 as const;
export const KICKOFF_COUNTDOWN_SECONDS = 3 as const;
export const KICKOFF_COUNTDOWN_STEPS = 180 as const;
export const Regulation_Goal_Target = 6 as const;
export const Regulation_Win_Margin = 2 as const;

export const REGULATION_GOAL_TARGET = Regulation_Goal_Target;
export const REGULATION_WIN_MARGIN = Regulation_Win_Margin;

export interface SharedMatchRules {
  readonly fixedStepsPerSecond: 60;
  readonly regulationDurationSeconds: 300;
  readonly regulationActivePlaySteps: 18_000;
  readonly kickoffCountdownSeconds: 3;
  readonly kickoffCountdownSteps: 180;
  readonly Regulation_Goal_Target: 6;
  readonly Regulation_Win_Margin: 2;
}

/** One confirmed regulation and kickoff ruleset used by every room mode. */
export const MATCH_RULES: SharedMatchRules = Object.freeze({
  fixedStepsPerSecond: FIXED_STEPS_PER_SECOND,
  regulationDurationSeconds: REGULATION_DURATION_SECONDS,
  regulationActivePlaySteps: REGULATION_ACTIVE_PLAY_STEPS,
  kickoffCountdownSeconds: KICKOFF_COUNTDOWN_SECONDS,
  kickoffCountdownSteps: KICKOFF_COUNTDOWN_STEPS,
  Regulation_Goal_Target,
  Regulation_Win_Margin,
});

/** Both modes intentionally reference the exact same immutable rules object. */
export const MATCH_RULES_BY_MODE: Readonly<Record<RoomMode, SharedMatchRules>> = Object.freeze({
  quick: MATCH_RULES,
  custom: MATCH_RULES,
});

export function getMatchRules(_mode: RoomMode): SharedMatchRules {
  return MATCH_RULES;
}

/**
 * Compatibility registry surface. Room capacities and goal-reset tuning are
 * intentionally absent: capacities belong to ROOM_POLICIES and reset duration
 * belongs to the versioned tuning registry.
 */
export const MATCH = Object.freeze({
  FIXED_STEPS_PER_SECOND,
  REGULATION_DURATION_SECONDS,
  REGULATION_ACTIVE_PLAY_STEPS,
  KICKOFF_COUNTDOWN_SECONDS,
  KICKOFF_COUNTDOWN_STEPS,
  REGULATION_GOAL_TARGET,
  REGULATION_WIN_MARGIN,
  MAX_ROOMS: 20,
  ROOM_CODE_LENGTH: 6,
} as const);
