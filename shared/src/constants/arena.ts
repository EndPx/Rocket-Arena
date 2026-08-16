/** Arena dimensions, contact material, and goal geometry. */
export const ARENA = {
  /** Playing field dimensions in meters. */
  WIDTH: 40,
  LENGTH: 60,
  HEIGHT: 20,
  WALL_THICKNESS: 0.5,

  /** Shared static-surface material for predictable wall and floor contacts. */
  SURFACE: {
    FRICTION: 0.35,
    RESTITUTION: 0.18,
    CONTACT_SKIN: 0,
  },

  /** Goal dimensions — centered on each short wall. */
  GOAL: {
    WIDTH: 10,
    HEIGHT: 5,
    DEPTH: 3,
    SENSOR_INSET: 0.5,
  },

  /** Kickoff positions and initial floor clearance. */
  KICKOFF: {
    BLUE_X_OFFSET: 5,
    BLUE_Z_OFFSET: -15,
    ORANGE_X_OFFSET: 5,
    ORANGE_Z_OFFSET: 15,
    SPAWN_CLEARANCE: 0.08,
  },
} as const;
