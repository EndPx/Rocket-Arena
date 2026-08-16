/** Ball physics constants.
 *  The 120:32 car-to-ball mass ratio keeps taps controlled while preserving punchy hits. */
export const BALL = {
  RADIUS: 1.8,
  MASS: 32,
  RESTITUTION: 0.55,
  FRICTION: 0.32,
  LINEAR_DAMPING: 0.16,
  ANGULAR_DAMPING: 0.18,
  SPAWN_CLEARANCE: 0.08,
  CONTACT_SKIN: 0,
  SOFT_CCD_PREDICTION: 0,
  ADDITIONAL_SOLVER_ITERATIONS: 2,
} as const;
