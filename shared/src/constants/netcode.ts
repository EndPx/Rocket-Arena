/** Netcode and input transport tuning. */
export const NETCODE = {
  /** Target cadence for authoritative manual state snapshots (~30 Hz). */
  PATCH_RATE_MS: 33,
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
} as const;
