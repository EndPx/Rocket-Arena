import type { SnapshotEnvelopeV2 } from '@rocket-arena/shared';
import type { AuthoritativeRoomProjection } from './authoritative-room-core.js';

export interface V2SnapshotSource {
  buildSnapshotV2(
    projection: Readonly<AuthoritativeRoomProjection>,
    serverTime: number,
  ): Readonly<SnapshotEnvelopeV2> | null;
  failSnapshotPublication(cause: unknown): void;
}

export type StateSyncBroadcaster = (
  type: 'state-sync',
  snapshot: Readonly<SnapshotEnvelopeV2>,
) => void;

/** The one cadence/failure gate used by both production Colyseus adapters. */
export function broadcastDueV2Snapshot(
  snapshotDue: boolean,
  projection: Readonly<AuthoritativeRoomProjection> | null,
  source: V2SnapshotSource,
  serverTime: number,
  broadcast: StateSyncBroadcaster,
): boolean {
  if (!snapshotDue || projection === null) return false;
  const snapshot = source.buildSnapshotV2(projection, serverTime);
  if (snapshot === null) return false;

  try {
    broadcast('state-sync', snapshot);
    return true;
  } catch (cause) {
    source.failSnapshotPublication(cause);
    return false;
  }
}
