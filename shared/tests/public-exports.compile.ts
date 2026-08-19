import type {
  AuthoritativeGameProjection as RootAuthoritativeGameProjection,
  GoalResult as RootGoalResult,
  InputCommandV2 as RootInputCommandV2,
  MatchTransitionSnapshot as RootMatchTransitionSnapshot,
  RoomPolicy as RootRoomPolicy,
  SnapshotEnvelopeV2 as RootSnapshotEnvelopeV2,
  TerminalResult as RootTerminalResult,
  TuningRegistrySnapshot as RootTuningRegistrySnapshot,
} from '@rocket-arena/shared';
import type { RoomPolicy as ConfigRoomPolicy } from '@rocket-arena/shared/config';
import type { AuthoritativeGameProjection } from '@rocket-arena/shared/schema';
import type { TuningRegistrySnapshot } from '@rocket-arena/shared/tuning';
import type {
  GoalResult,
  InputCommandV2,
  MatchTransitionSnapshot,
  SnapshotEnvelopeV2,
  TerminalResult,
} from '@rocket-arena/shared/types';

/**
 * Compile-only public API fixture. This interface intentionally has no runtime
 * behavior; TypeScript compilation fails if a required root or subpath type
 * export disappears.
 */
export interface PublicExportTypeContract {
  rootRoomPolicy: RootRoomPolicy;
  configRoomPolicy: ConfigRoomPolicy;
  rootInput: RootInputCommandV2;
  typesInput: InputCommandV2;
  rootGoal: RootGoalResult;
  typesGoal: GoalResult;
  rootTerminal: RootTerminalResult;
  typesTerminal: TerminalResult;
  rootTransition: RootMatchTransitionSnapshot;
  typesTransition: MatchTransitionSnapshot;
  rootSnapshot: RootSnapshotEnvelopeV2;
  typesSnapshot: SnapshotEnvelopeV2;
  rootProjection: RootAuthoritativeGameProjection;
  schemaProjection: AuthoritativeGameProjection;
  rootTuningSnapshot: RootTuningRegistrySnapshot;
  tuningSnapshot: TuningRegistrySnapshot;
}
