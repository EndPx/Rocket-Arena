/** World-level physics constants */
export const PHYSICS = {
  GRAVITY: -30,               // m/s^2 — stronger than real (9.8) for game feel
  TIMESTEP: 1 / 60,          // fixed step, never variable
  SOLVER_ITERATIONS: 4,       // Rapier solver iteration count
} as const;
