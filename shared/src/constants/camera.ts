/** Camera follow parameters */
export const CAMERA = {
  FOLLOW_DISTANCE: 12,       // meters behind car
  HEIGHT_OFFSET: 5,          // meters above car
  LOOK_AHEAD_DISTANCE: 5,    // meters in front of car for look-at target
  LERP_SPEED: 0.08,          // smoothing factor per frame (0-1)
} as const;
