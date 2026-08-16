/** Match timing and room configuration */
export const MATCH = {
  DURATION_SECONDS: 300,      // 5 minutes
  COUNTDOWN_SECONDS: 5,       // pre-kickoff countdown
  GOAL_RESET_DELAY: 3,        // seconds freeze after goal
  MAX_PLAYERS: 4,
  TEAM_SIZE: 2,
  MAX_ROOMS: 20,              // server cap
  ROOM_CODE_LENGTH: 6,        // alphanumeric join code
} as const;
