/** Car physics and handling tuning constants. */
export const CAR = {
  /** Physical dimensions and contact material. */
  BODY: {
    WIDTH: 1.8,
    HEIGHT: 0.8,
    LENGTH: 3.2,
    MASS: 120,
    CORNER_RADIUS: 0.12,
    FRICTION: 0.1,
    RESTITUTION: 0.08,
    CONTACT_SKIN: 0.015,
    SOFT_CCD_PREDICTION: 0,
    ADDITIONAL_SOLVER_ITERATIONS: 2,
  },

  /** Ground propulsion, braking, reverse, and soft speed caps. */
  ENGINE: {
    FORWARD_FORCE: 3200,
    BRAKE_FORCE: 6400,
    REVERSE_FORCE: 2200,
    MAX_SPEED: 24,
    REVERSE_MAX_SPEED: 12,
    CAP_START_RATIO: 0.82,
    CAP_RESPONSE: 8,
    MAX_CAP_DECELERATION: 20,
    BRAKE_TO_REVERSE_SPEED: 1.5,
    INPUT_DEADZONE: 0.05,
  },

  /** Boost capacity, recharge, propulsion, and boosted soft cap. */
  BOOST: {
    FORCE: 2800,
    MAX_SPEED: 34,
    CAP_START_RATIO: 0.8,
    MAX_AMOUNT: 100,
    USAGE_RATE: 24,
    START_AMOUNT: 60,
    RECHARGE_RATE: 12,
    RECHARGE_DELAY: 1.25,
    AIR_FORCE_MULTIPLIER: 0.8,
  },

  /** Speed-sensitive steering and progressive lateral traction. */
  STEERING: {
    TURN_RATE: 2.6,
    TURN_RATE_AT_MAX: 1.35,
    FULL_AUTHORITY_SPEED: 7,
    RESPONSE: 11,
    CENTERING_RESPONSE: 9,
    BASE_GRIP_RATE: 5.5,
    MAX_GRIP_RATE: 14,
    FULL_GRIP_LATERAL_SPEED: 8,
    STEERING_SLIP_FACTOR: 0.3,
  },

  /** Ground query and road-holding behavior. */
  GROUND: {
    CONTACT_MARGIN: 0.2,
    RAY_SPREAD_X: 0.42,
    RAY_SPREAD_Z: 0.42,
    MAX_UPWARD_SPEED: 1.5,
    STICK_FORCE: 850,
  },

  /**
   * Driving on steep surfaces. Gentle slopes always support the car; steeper
   * surfaces, including the field walls, support it only while it carries
   * enough speed to hold itself against them. The two speeds form a hysteresis
   * band so a car near the limit cannot flicker between grounded and airborne.
   */
  WALL_DRIVE: {
    /** Slope beyond which the speed gate applies, in degrees from world up. */
    GATED_SLOPE_DEGREES: 55,
    /** Slope limit while the speed gate is satisfied, in degrees. */
    MAXIMUM_SLOPE_DEGREES: 90,
    /** Slope limit while it is not, in degrees. */
    GROUNDED_SLOPE_DEGREES: 55,
    /** Speed needed to start holding a steep surface, in metres/second. */
    ENGAGE_SPEED: 9,
    /** Speed below which a steep surface stops supporting the car, in m/s. */
    RELEASE_SPEED: 5.5,
  },

  /** Jump edge detection, landing rearm, and airborne control. */
  JUMP: {
    IMPULSE: 1020,
    MAX_JUMPS: 1,
    MIN_AIRBORNE_TIME: 0.12,
    LANDING_CONFIRM_TIME: 0.05,
    AIR_ROLL_RATE: 3.2,
    AIR_PITCH_RATE: 3.2,
    AIR_CONTROL_RESPONSE: 7,
  },

  /** Ground-only stabilization; disabled in the air so jumps remain intentional. */
  UPRIGHT: {
    STRENGTH: 7,
    RESPONSE: 12,
    MAX_ANGULAR_SPEED: 4.5,
    INVERTED_ASSIST: 1,
  },

  /** Body damping plus explicit rolling/aerodynamic drag. */
  DAMPING: {
    LINEAR: 0.08,
    ANGULAR: 0.9,
    COAST_FORCE: 520,
    AERO_COEFFICIENT: 0.7,
    STOP_SPEED: 0.2,
  },
} as const;
