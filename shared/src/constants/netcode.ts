/** Netcode tuning.
 *  PATCH_RATE_MS and INTERPOLATION_DELAY_MS are coupled:
 *  delay MUST be >= 2x patch rate to guarantee two snapshots
 *  in the buffer at all times. If you lower one, lower the other. */
export const NETCODE = {
  PATCH_RATE_MS: 33,            // ~30fps state broadcast (setPatchRate)
  INTERPOLATION_DELAY_MS: 66,   // 2x patch rate — minimum safe buffer
  SNAPSHOT_BUFFER_SIZE: 20,     // keep last N snapshots
} as const;
