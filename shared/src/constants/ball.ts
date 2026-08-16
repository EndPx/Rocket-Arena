/** Ball physics constants.
 *  Mass ratio car:ball is critical for impact feel.
 *  At 150:30 (5:1), a car at full speed launches the ball hard
 *  but doesn't feel like hitting a beach ball. Tune from here. */
export const BALL = {
  RADIUS: 1.8,            // meters — oversized for readability
  MASS: 30,               // kg — 1:5 ratio vs car (150kg)
  RESTITUTION: 0.6,       // bounciness (0-1)
  LINEAR_DAMPING: 0.3,    // air drag equivalent
  ANGULAR_DAMPING: 0.1,   // spin decay
} as const;
