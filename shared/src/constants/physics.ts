/** World-level fixed-step and solver constants. */
export const PHYSICS = {
  GRAVITY: -24,
  /** Immutable authoritative Rapier step: exactly 60 Hz. */
  TIMESTEP: 1 / 60,
  /** Clamp callback stalls before feeding time into the fixed-step accumulator. */
  MAX_FRAME_DELTA_SECONDS: 0.1,
  /** Bound catch-up work so a stalled event loop cannot spiral indefinitely. */
  MAX_FIXED_SUBSTEPS: 5,
  SOLVER_ITERATIONS: 8,
  ADDITIONAL_FRICTION_ITERATIONS: 4,
  MAX_CCD_SUBSTEPS: 2,
} as const;
