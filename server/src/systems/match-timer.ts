/**
 * Compatibility entry point retained while room adapters migrate to MatchFlow.
 * Wall-clock/delta mutation has been removed; all timing now advances through
 * one exact fixed step in match-flow.ts.
 */
export * from './match-flow.js';

import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  type TuningRegistrySnapshot,
} from '@rocket-arena/shared';
import { createMatchFlowConfig } from './match-flow.js';

/** Read the room-pinnable staged goal-reset hypothesis in seconds. */
export function getGoalResetDelay(
  tuning: Pick<TuningRegistrySnapshot, 'get'> = DEFAULT_TUNING_REGISTRY_SNAPSHOT,
): number {
  return createMatchFlowConfig('quick', tuning).goalResetDurationSeconds;
}
