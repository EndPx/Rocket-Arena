/** Arena dimensions and goal geometry */
export const ARENA = {
  /** Playing field dimensions in meters */
  WIDTH: 40,              // X-axis (side to side)
  LENGTH: 60,             // Z-axis (goal to goal)
  HEIGHT: 20,             // Y-axis (ceiling)
  WALL_THICKNESS: 0.5,

  /** Goal dimensions — centered on each short wall */
  GOAL: {
    WIDTH: 10,
    HEIGHT: 5,
    DEPTH: 3,             // how deep the goal extends behind the wall
  },

  /** Kickoff positions — offset from center */
  KICKOFF: {
    BLUE_X_OFFSET: 5,
    BLUE_Z_OFFSET: -15,
    ORANGE_X_OFFSET: 5,
    ORANGE_Z_OFFSET: 15,
  },
} as const;
