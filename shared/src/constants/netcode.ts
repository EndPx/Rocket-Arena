export const SNAPSHOT_TARGET_INTERVAL_MS = 33 as const;

/**
 * Network scheduling tolerance is a wall-clock transport allowance. It is
 * deliberately declared in milliseconds here and is not derived from the
 * authoritative simulation fixed step.
 */
export const SNAPSHOT_SCHEDULING_TOLERANCE_MS = 1 as const;

/** Netcode and input transport tuning. */
export const NETCODE = Object.freeze({
  /** Target cadence for authoritative manual state snapshots (~30 Hz). */
  SNAPSHOT_TARGET_INTERVAL_MS,
  /** Finite non-negative wall-clock tolerance for snapshot due decisions. */
  SNAPSHOT_SCHEDULING_TOLERANCE_MS,
  /** Temporary compatibility name for the snapshot target interval. */
  PATCH_RATE_MS: SNAPSHOT_TARGET_INTERVAL_MS,
  /**
   * Delayed render timeline, tuned to roughly three snapshots so normal jitter
   * does not repeatedly drain the interpolation buffer.
   */
  INTERPOLATION_DELAY_MS: 100,
  /** Maximum time presentation may extrapolate beyond the newest snapshot. */
  MAX_EXTRAPOLATION_MS: 80,
  /** Position discontinuity that is treated as a teleport/kickoff. */
  TELEPORT_THRESHOLD: 8,
  /** Maximum number of immutable authoritative snapshots retained client-side. */
  SNAPSHOT_BUFFER_SIZE: 24,
  /** Resend unchanged input so lost/stale transport state self-heals. */
  INPUT_HEARTBEAT_MS: 250,
} as const);
