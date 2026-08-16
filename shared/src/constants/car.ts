/** Car physics and handling tuning constants */
export const CAR = {
  /** Physical dimensions in meters */
  BODY: {
    WIDTH: 1.8,
    HEIGHT: 0.8,
    LENGTH: 3.2,
    MASS: 150,          // kg
  },

  /** Driving forces in Newtons */
  ENGINE: {
    FORWARD_FORCE: 3600,
    BRAKE_FORCE: 4800,
    REVERSE_FORCE: 1800,
    MAX_SPEED: 23,      // m/s (~83 km/h)
  },

  /** Boost system */
  BOOST: {
    FORCE: 7200,        // Newtons — double engine force
    MAX_AMOUNT: 100,
    USAGE_RATE: 33,     // units/sec
    START_AMOUNT: 33,
  },

  /** Steering parameters */
  STEERING: {
    TURN_RATE: 2.8,         // rad/s at low speed
    TURN_RATE_AT_MAX: 0.8,  // rad/s at max speed
    ANGULAR_DAMPING: 5.0,
    /** Lateral grip factor. 1.0 = perfect grip (no slide), 0.0 = ice.
     *  Each tick, lateral velocity is countered by:
     *  lateralVel * LATERAL_GRIP * mass = counter-force.
     *  Start high (0.85) and tune down for driftier feel. */
    LATERAL_GRIP: 0.85,
  },

  /** Jump and air control */
  JUMP: {
    IMPULSE: 420,
    /** Max jumps before needing ground contact again */
    MAX_JUMPS: 1,
    AIR_ROLL_RATE: 3.5,     // rad/s
    AIR_PITCH_RATE: 3.5,
  },

  /** Damping values */
  DAMPING: {
    LINEAR: 0.5,
    ANGULAR: 0.8,
  },
} as const;
