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
  /**
   * Must stay zero. A non-zero soft-CCD prediction lets the solver see a
   * surface one step before the ball reaches it and brake the approach, which
   * discards restitution. Whether that happens depends on where the impact
   * falls inside the fixed step, so a non-zero value makes the bounce
   * non-deterministic: measured effective restitution was `0.592` from a 10 m
   * drop and `0.585` from 3 m but only `0.159` from 5 m, which reads in game as
   * the ball refusing to bounce and simply rolling. Full nonlinear CCD covers
   * fast-motion robustness instead.
   */
  SOFT_CCD_PREDICTION: 0,
  ADDITIONAL_SOLVER_ITERATIONS: 2,
} as const;
