import { NETCODE } from '@rocket-arena/shared';

export interface EntitySnapshot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly qx: number;
  readonly qy: number;
  readonly qz: number;
  readonly qw: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
}

/**
 * Compatibility input for the legacy state-sync adapter. Validated V2 callers
 * should use ValidatedTimelineSnapshot and SnapshotBuffer.accept().
 */
export interface AuthoritativeSnapshot {
  readonly sequence: number;
  readonly serverTime: number;
  readonly simulationTime: number;
  readonly kickoffEpoch?: number;
  readonly entities: Readonly<Record<string, Readonly<EntitySnapshot>>>;
}

/** Deeply immutable interpolation input produced after snapshot validation. */
export interface ValidatedTimelineSnapshot extends AuthoritativeSnapshot {
  readonly kickoffEpoch: number;
}

export type InterpolationMode = 'held' | 'interpolated' | 'extrapolated' | 'teleport';

export interface InterpolatedFrame {
  readonly simulationTime: number;
  readonly kickoffEpoch: number;
  readonly mode: InterpolationMode;
  readonly underrun: boolean;
  readonly entities: Readonly<Record<string, EntitySnapshot>>;
}

export interface InterpolationStats {
  readonly size: number;
  readonly delayMs: number;
  readonly latestSequence: number | null;
  readonly bufferedSpanMs: number;
  readonly acceptedSnapshots: number;
  readonly rejectedSnapshots: number;
  readonly underrunFrames: number;
  readonly extrapolatedFrames: number;
  readonly teleportFrames: number;
}

export interface SnapshotBufferOptions {
  readonly capacity?: number;
  readonly interpolationDelayMs?: number;
  readonly maxExtrapolationMs?: number;
  readonly teleportThreshold?: number;
}

interface QuaternionLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeQuaternion(quaternion: QuaternionLike): QuaternionLike {
  const length = Math.hypot(
    quaternion.x,
    quaternion.y,
    quaternion.z,
    quaternion.w,
  );
  if (!Number.isFinite(length) || length <= Number.EPSILON) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return {
    x: quaternion.x / length,
    y: quaternion.y / length,
    z: quaternion.z / length,
    w: quaternion.w / length,
  };
}

/** Normalized shortest-path quaternion interpolation. */
export function slerpShortest(
  from: QuaternionLike,
  to: QuaternionLike,
  amount: number,
): QuaternionLike {
  const start = normalizeQuaternion(from);
  let end = normalizeQuaternion(to);
  let cosine = start.x * end.x + start.y * end.y + start.z * end.z + start.w * end.w;

  if (cosine < 0) {
    cosine = -cosine;
    end = { x: -end.x, y: -end.y, z: -end.z, w: -end.w };
  }

  const t = clamp(amount, 0, 1);
  if (cosine > 0.9995) {
    return normalizeQuaternion({
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
      z: start.z + (end.z - start.z) * t,
      w: start.w + (end.w - start.w) * t,
    });
  }

  const angle = Math.acos(clamp(cosine, -1, 1));
  const sine = Math.sin(angle);
  if (Math.abs(sine) <= Number.EPSILON) return start;

  const startWeight = Math.sin((1 - t) * angle) / sine;
  const endWeight = Math.sin(t * angle) / sine;
  return normalizeQuaternion({
    x: start.x * startWeight + end.x * endWeight,
    y: start.y * startWeight + end.y * endWeight,
    z: start.z * startWeight + end.z * endWeight,
    w: start.w * startWeight + end.w * endWeight,
  });
}

function cloneEntity(entity: EntitySnapshot): EntitySnapshot {
  const rotation = normalizeQuaternion({
    x: entity.qx,
    y: entity.qy,
    z: entity.qz,
    w: entity.qw,
  });
  return {
    x: entity.x,
    y: entity.y,
    z: entity.z,
    qx: rotation.x,
    qy: rotation.y,
    qz: rotation.z,
    qw: rotation.w,
    vx: entity.vx,
    vy: entity.vy,
    vz: entity.vz,
  };
}

function immutableSnapshot(
  snapshot: ValidatedTimelineSnapshot,
): Readonly<ValidatedTimelineSnapshot> {
  const entities: Record<string, Readonly<EntitySnapshot>> = {};
  for (const [id, entity] of Object.entries(snapshot.entities)) {
    entities[id] = Object.freeze(cloneEntity(entity));
  }
  return Object.freeze({
    sequence: snapshot.sequence,
    serverTime: snapshot.serverTime,
    simulationTime: snapshot.simulationTime,
    kickoffEpoch: snapshot.kickoffEpoch,
    entities: Object.freeze(entities),
  });
}

function isFiniteEntity(value: unknown): value is EntitySnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entity = value as Partial<Record<keyof EntitySnapshot, unknown>>;
  return [
    entity.x,
    entity.y,
    entity.z,
    entity.qx,
    entity.qy,
    entity.qz,
    entity.qw,
    entity.vx,
    entity.vy,
    entity.vz,
  ].every((component) => typeof component === 'number' && Number.isFinite(component));
}

function isValidSnapshot(snapshot: ValidatedTimelineSnapshot): boolean {
  if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) return false;
  if (!Number.isSafeInteger(snapshot.kickoffEpoch) || snapshot.kickoffEpoch < 0) return false;
  if (!Number.isFinite(snapshot.serverTime) || !Number.isFinite(snapshot.simulationTime)) {
    return false;
  }
  if (
    typeof snapshot.entities !== 'object'
    || snapshot.entities === null
    || Array.isArray(snapshot.entities)
  ) {
    return false;
  }
  return Object.values(snapshot.entities).every(isFiniteEntity);
}

function interpolateEntity(
  before: EntitySnapshot,
  after: EntitySnapshot,
  amount: number,
): EntitySnapshot {
  const t = clamp(amount, 0, 1);
  const rotation = slerpShortest(
    { x: before.qx, y: before.qy, z: before.qz, w: before.qw },
    { x: after.qx, y: after.qy, z: after.qz, w: after.qw },
    t,
  );
  return {
    x: before.x + (after.x - before.x) * t,
    y: before.y + (after.y - before.y) * t,
    z: before.z + (after.z - before.z) * t,
    qx: rotation.x,
    qy: rotation.y,
    qz: rotation.z,
    qw: rotation.w,
    vx: before.vx + (after.vx - before.vx) * t,
    vy: before.vy + (after.vy - before.vy) * t,
    vz: before.vz + (after.vz - before.vz) * t,
  };
}

function extrapolateEntity(entity: EntitySnapshot, deltaMs: number): EntitySnapshot {
  const deltaSeconds = deltaMs / 1000;
  return {
    ...cloneEntity(entity),
    x: entity.x + entity.vx * deltaSeconds,
    y: entity.y + entity.vy * deltaSeconds,
    z: entity.z + entity.vz * deltaSeconds,
  };
}

function distanceSquared(a: EntitySnapshot, b: EntitySnapshot): number {
  const x = b.x - a.x;
  const y = b.y - a.y;
  const z = b.z - a.z;
  return x * x + y * y + z * z;
}

/** Immutable, sequence-ordered authoritative snapshot timeline. */
export class SnapshotBuffer {
  private readonly capacity: number;
  private readonly delayMs: number;
  private readonly maxExtrapolationMs: number;
  private readonly teleportThresholdSquared: number;
  private snapshots: readonly Readonly<ValidatedTimelineSnapshot>[] = [];
  private localTimelineOffsetMs: number | null = null;
  private acceptedSnapshots = 0;
  private rejectedSnapshots = 0;
  private underrunFrames = 0;
  private extrapolatedFrames = 0;
  private teleportFrames = 0;

  constructor(options: SnapshotBufferOptions = {}) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? NETCODE.SNAPSHOT_BUFFER_SIZE));
    this.delayMs = Math.max(0, options.interpolationDelayMs ?? NETCODE.INTERPOLATION_DELAY_MS);
    this.maxExtrapolationMs = Math.max(
      0,
      options.maxExtrapolationMs ?? NETCODE.MAX_EXTRAPOLATION_MS,
    );
    const teleportThreshold = Math.max(
      0,
      options.teleportThreshold ?? NETCODE.TELEPORT_THRESHOLD,
    );
    this.teleportThresholdSquared = teleportThreshold * teleportThreshold;
  }

  reset(): void {
    this.snapshots = [];
    this.localTimelineOffsetMs = null;
    this.acceptedSnapshots = 0;
    this.rejectedSnapshots = 0;
    this.underrunFrames = 0;
    this.extrapolatedFrames = 0;
    this.teleportFrames = 0;
  }

  /** Accept a validated immutable timeline without mutating the caller's value. */
  accept(snapshot: ValidatedTimelineSnapshot, receivedAtMs: number): boolean {
    const latest = this.snapshots.at(-1);
    if (
      !isValidSnapshot(snapshot)
      || !Number.isFinite(receivedAtMs)
      || (latest !== undefined && (
        snapshot.sequence <= latest.sequence
        || snapshot.simulationTime <= latest.simulationTime
        || snapshot.kickoffEpoch < latest.kickoffEpoch
      ))
    ) {
      this.rejectedSnapshots += 1;
      return false;
    }

    const copy = immutableSnapshot(snapshot);
    this.snapshots = Object.freeze([...this.snapshots, copy].slice(-this.capacity));
    const offsetCandidate = receivedAtMs - snapshot.simulationTime;
    this.localTimelineOffsetMs = this.localTimelineOffsetMs === null
      ? offsetCandidate
      : Math.min(this.localTimelineOffsetMs, offsetCandidate);
    this.acceptedSnapshots += 1;
    return true;
  }

  /** Temporary compatibility adapter for unversioned V1 snapshots. */
  push(snapshot: AuthoritativeSnapshot, receivedAtMs: number): boolean {
    return this.accept({
      sequence: snapshot.sequence,
      serverTime: snapshot.serverTime,
      simulationTime: snapshot.simulationTime,
      kickoffEpoch: snapshot.kickoffEpoch ?? 0,
      entities: snapshot.entities,
    }, receivedAtMs);
  }

  sample(localNowMs: number): InterpolatedFrame | null {
    if (this.localTimelineOffsetMs === null || !Number.isFinite(localNowMs)) return null;
    return this.sampleAt(
      localNowMs - this.localTimelineOffsetMs - this.delayMs,
    );
  }

  /** Sample directly in authoritative simulation time (used by focused tests). */
  sampleAt(simulationTime: number): InterpolatedFrame | null {
    if (this.snapshots.length === 0 || !Number.isFinite(simulationTime)) return null;
    const first = this.snapshots[0];
    const latest = this.snapshots[this.snapshots.length - 1];

    if (simulationTime <= first.simulationTime) {
      return {
        simulationTime: first.simulationTime,
        kickoffEpoch: first.kickoffEpoch,
        mode: 'held',
        underrun: false,
        entities: this.cloneEntities(first.entities),
      };
    }

    if (simulationTime > latest.simulationTime) {
      const extrapolationMs = Math.min(
        simulationTime - latest.simulationTime,
        this.maxExtrapolationMs,
      );
      const entities: Record<string, EntitySnapshot> = {};
      for (const [id, entity] of Object.entries(latest.entities)) {
        entities[id] = extrapolateEntity(entity, extrapolationMs);
      }
      this.underrunFrames += 1;
      if (extrapolationMs > 0) this.extrapolatedFrames += 1;
      return {
        simulationTime: latest.simulationTime + extrapolationMs,
        kickoffEpoch: latest.kickoffEpoch,
        mode: extrapolationMs > 0 ? 'extrapolated' : 'held',
        underrun: true,
        entities,
      };
    }

    let before = first;
    let after = latest;
    for (let index = 1; index < this.snapshots.length; index++) {
      if (simulationTime <= this.snapshots[index].simulationTime) {
        before = this.snapshots[index - 1];
        after = this.snapshots[index];
        break;
      }
    }

    const span = after.simulationTime - before.simulationTime;
    const amount = span > 0 ? (simulationTime - before.simulationTime) / span : 1;

    if (before.kickoffEpoch !== after.kickoffEpoch) {
      const epochSnapshot = amount < 1 ? before : after;
      this.teleportFrames += 1;
      return {
        simulationTime,
        kickoffEpoch: epochSnapshot.kickoffEpoch,
        mode: 'teleport',
        underrun: false,
        entities: this.cloneEntities(epochSnapshot.entities),
      };
    }

    const entities: Record<string, EntitySnapshot> = {};
    let teleported = false;
    for (const [id, afterEntity] of Object.entries(after.entities)) {
      const beforeEntity = before.entities[id];
      if (!beforeEntity) {
        entities[id] = cloneEntity(afterEntity);
        continue;
      }

      if (distanceSquared(beforeEntity, afterEntity) > this.teleportThresholdSquared) {
        teleported = true;
        entities[id] = cloneEntity(amount < 1 ? beforeEntity : afterEntity);
      } else {
        entities[id] = interpolateEntity(beforeEntity, afterEntity, amount);
      }
    }

    if (teleported) this.teleportFrames += 1;
    return {
      simulationTime,
      kickoffEpoch: after.kickoffEpoch,
      mode: teleported ? 'teleport' : 'interpolated',
      underrun: false,
      entities,
    };
  }

  getSnapshotSequences(): readonly number[] {
    return Object.freeze(this.snapshots.map((snapshot) => snapshot.sequence));
  }

  getStats(): InterpolationStats {
    const first = this.snapshots[0];
    const latest = this.snapshots.at(-1);
    return {
      size: this.snapshots.length,
      delayMs: this.delayMs,
      latestSequence: latest?.sequence ?? null,
      bufferedSpanMs: first && latest ? latest.simulationTime - first.simulationTime : 0,
      acceptedSnapshots: this.acceptedSnapshots,
      rejectedSnapshots: this.rejectedSnapshots,
      underrunFrames: this.underrunFrames,
      extrapolatedFrames: this.extrapolatedFrames,
      teleportFrames: this.teleportFrames,
    };
  }

  private cloneEntities(
    source: Readonly<Record<string, Readonly<EntitySnapshot>>>,
  ): Readonly<Record<string, EntitySnapshot>> {
    const entities: Record<string, EntitySnapshot> = {};
    for (const [id, entity] of Object.entries(source)) {
      entities[id] = cloneEntity(entity);
    }
    return entities;
  }
}
