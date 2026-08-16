/** World-level fixed-step and solver constants. */
export const PHYSICS = {
  GRAVITY: -24,
  TIMESTEP: 1 / 60,
  SOLVER_ITERATIONS: 8,
  ADDITIONAL_FRICTION_ITERATIONS: 4,
  MAX_CCD_SUBSTEPS: 2,
} as const;
