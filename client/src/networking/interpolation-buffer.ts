import * as THREE from 'three';
import { NETCODE } from '@rocket-arena/shared';

interface Snapshot {
  timestamp: number;
  positions: Map<string, { x: number; y: number; z: number }>;
  rotations: Map<string, { x: number; y: number; z: number; w: number }>;
}

const buffer: Snapshot[] = [];
const BUFFER_SIZE = NETCODE.SNAPSHOT_BUFFER_SIZE;
const DELAY_MS = NETCODE.INTERPOLATION_DELAY_MS;

/**
 * Push a new snapshot into the buffer.
 * Called when server state patches arrive.
 */
export function pushSnapshot(
  entities: Map<string, { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number }>
): void {
  const snapshot: Snapshot = {
    timestamp: Date.now(),
    positions: new Map(),
    rotations: new Map(),
  };

  for (const [id, state] of entities) {
    snapshot.positions.set(id, { x: state.x, y: state.y, z: state.z });
    snapshot.rotations.set(id, { x: state.qx, y: state.qy, z: state.qz, w: state.qw });
  }

  buffer.push(snapshot);

  // Keep buffer capped
  while (buffer.length > BUFFER_SIZE) {
    buffer.shift();
  }
}

/**
 * Interpolate entity position/rotation at render time (now - delay).
 * Returns interpolated position and rotation, or null if no data.
 */
export function interpolate(entityId: string): { position: THREE.Vector3; quaternion: THREE.Quaternion } | null {
  if (buffer.length < 2) return null;

  const renderTime = Date.now() - DELAY_MS;

  // Find two surrounding snapshots
  let before: Snapshot | null = null;
  let after: Snapshot | null = null;

  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i].timestamp <= renderTime && buffer[i + 1].timestamp >= renderTime) {
      before = buffer[i];
      after = buffer[i + 1];
      break;
    }
  }

  // If render time is beyond all snapshots, use latest
  if (!before || !after) {
    const latest = buffer[buffer.length - 1];
    const pos = latest.positions.get(entityId);
    const rot = latest.rotations.get(entityId);
    if (!pos || !rot) return null;
    return {
      position: new THREE.Vector3(pos.x, pos.y, pos.z),
      quaternion: new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w),
    };
  }

  const posA = before.positions.get(entityId);
  const posB = after.positions.get(entityId);
  const rotA = before.rotations.get(entityId);
  const rotB = after.rotations.get(entityId);

  if (!posA || !posB || !rotA || !rotB) return null;

  // Compute interpolation factor
  const totalTime = after.timestamp - before.timestamp;
  const t = totalTime > 0 ? (renderTime - before.timestamp) / totalTime : 0;
  const clamped = Math.max(0, Math.min(1, t));

  // Lerp position
  const position = new THREE.Vector3(
    posA.x + (posB.x - posA.x) * clamped,
    posA.y + (posB.y - posA.y) * clamped,
    posA.z + (posB.z - posA.z) * clamped,
  );

  // Slerp rotation
  const qA = new THREE.Quaternion(rotA.x, rotA.y, rotA.z, rotA.w);
  const qB = new THREE.Quaternion(rotB.x, rotB.y, rotB.z, rotB.w);
  const quaternion = qA.clone().slerp(qB, clamped);

  return { position, quaternion };
}

/**
 * Get buffer stats for debugging
 */
export function getBufferStats(): { size: number; delayMs: number } {
  return { size: buffer.length, delayMs: DELAY_MS };
}
