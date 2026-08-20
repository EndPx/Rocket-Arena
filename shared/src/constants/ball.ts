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
  /**
   * Soft-CCD prediction expressed as a fraction of the distance the ball
   * travels during one fixed step, applied per step from the current speed.
   *
   * A prediction at or above the per-step travel makes the solver brake the
   * ball before it ever touches a surface, which discards restitution and
   * removes the bounce. A prediction far below roughly 0.6 of that travel lets
   * a fast ball visibly sink into a surface for a frame before it is pushed
   * out. This ratio keeps both bounded at every speed up to the ball's cap.
   */
  SOFT_CCD_TRAVEL_RATIO: 0.65,
  ADDITIONAL_SOLVER_ITERATIONS: 2,
} as const;
