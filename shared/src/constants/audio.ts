/**
 * Procedural Web Audio tuning. All values are numeric so the existing runtime
 * registry can expose them without coupling shared code to browser APIs.
 */
export const AUDIO = {
  /** Master output, limiter, persistence control, and frame safety bounds. */
  MASTER: {
    DEFAULT_VOLUME: 0.7,
    MAX_GAIN: 0.82,
    VOLUME_STEP: 0.05,
    SILENCE_GAIN: 0.0001,
    ACTIVE_GAIN_THRESHOLD: 0.001,
    FADE_OUT_SECONDS: 0.08,
    PARAMETER_SMOOTH_SECONDS: 0.025,
    MAX_FRAME_DELTA_SECONDS: 0.1,
    MAX_QUEUED_TRANSITIONS: 5,
    LIMITER_THRESHOLD_DB: -8,
    LIMITER_KNEE_DB: 4,
    LIMITER_RATIO: 14,
    LIMITER_ATTACK_SECONDS: 0.003,
    LIMITER_RELEASE_SECONDS: 0.18,
  },

  /** Persistent two-oscillator motor layer driven by synchronized car speed. */
  ENGINE: {
    IDLE_FREQUENCY_HZ: 48,
    MAX_FREQUENCY_HZ: 156,
    HARMONIC_RATIO: 2.03,
    SPEED_FOR_MAX: 34,
    BASE_GAIN: 0.045,
    SPEED_GAIN: 0.08,
    THROTTLE_GAIN: 0.025,
    MAX_GAIN: 0.15,
    PRIMARY_MIX: 0.76,
    HARMONIC_MIX: 0.24,
    FILTER_MIN_HZ: 260,
    FILTER_MAX_HZ: 1320,
    FILTER_Q: 1.15,
    RESPONSE: 8,
  },

  /** Persistent filtered-noise rocket layer while boost is actually available. */
  BOOST: {
    NOISE_BUFFER_SECONDS: 2,
    FILTER_FREQUENCY_HZ: 1750,
    FILTER_Q: 0.72,
    GAIN: 0.13,
    RESPONSE: 13,
  },

  /** Thresholds, margins, windows, and cooldowns for authoritative event inference. */
  DETECTION: {
    COUNTDOWN_MIN_VALUE: 1,
    COUNTDOWN_MAX_VALUE: 5,
    AIRBORNE_HEIGHT: 0.82,
    LANDING_MIN_DOWNWARD_SPEED: 2.8,
    LANDING_FULL_STRENGTH_SPEED: 12,
    LANDING_COOLDOWN_MS: 240,
    BALL_IMPACT_MIN_DELTA_SPEED: 4.5,
    CAR_IMPACT_MIN_DELTA_SPEED: 5.5,
    IMPACT_FULL_STRENGTH_DELTA_SPEED: 20,
    SURFACE_CONTACT_MARGIN: 0.5,
    ENTITY_CONTACT_MARGIN: 0.6,
    MIN_CONTACT_APPROACH_SPEED: 1.25,
    IMPACT_COOLDOWN_MS: 120,
    MAX_IMPACTS_PER_SNAPSHOT: 8,
    MAX_TRACKED_IMPACT_CONTACTS: 32,
    JUMP_CONFIRM_WINDOW_MS: 400,
    JUMP_GROUNDED_MARGIN: 0.22,
    JUMP_TAKEOFF_MIN_UPWARD_SPEED: 2.25,
    JUMP_TAKEOFF_MIN_RISE: 0.025,
  },

  /** Camera-relative stereo placement. */
  SPATIAL: {
    PAN_STRENGTH: 0.9,
  },

  /** Short upward launch chirp plus filtered exhaust puff. */
  JUMP: {
    START_FREQUENCY_HZ: 165,
    END_FREQUENCY_HZ: 430,
    GAIN: 0.12,
    ATTACK_SECONDS: 0.008,
    DURATION_SECONDS: 0.22,
    NOISE_GAIN: 0.035,
    NOISE_FILTER_HZ: 1450,
    NOISE_FILTER_Q: 0.8,
  },

  /** Low suspension thump, scaled by downward landing speed. */
  LANDING: {
    START_FREQUENCY_HZ: 105,
    END_FREQUENCY_HZ: 48,
    MIN_GAIN: 0.055,
    MAX_GAIN: 0.16,
    ATTACK_SECONDS: 0.004,
    DURATION_SECONDS: 0.2,
    NOISE_GAIN: 0.06,
    NOISE_FILTER_HZ: 260,
    NOISE_FILTER_Q: 1.1,
  },

  /** Metallic body/ball collision transient, scaled by velocity discontinuity. */
  IMPACT: {
    START_FREQUENCY_HZ: 150,
    END_FREQUENCY_HZ: 72,
    MIN_GAIN: 0.05,
    MAX_GAIN: 0.18,
    ATTACK_SECONDS: 0.003,
    DURATION_SECONDS: 0.18,
    NOISE_MIN_GAIN: 0.035,
    NOISE_MAX_GAIN: 0.13,
    NOISE_FILTER_HZ: 920,
    NOISE_FILTER_Q: 2.4,
  },

  /** Match countdown pulse. */
  COUNTDOWN: {
    BASE_FREQUENCY_HZ: 440,
    STEP_FREQUENCY_HZ: 36,
    GAIN: 0.1,
    ATTACK_SECONDS: 0.006,
    DURATION_SECONDS: 0.13,
  },

  /** Kickoff confirmation made from two rising synthesized voices. */
  GO: {
    LOW_START_FREQUENCY_HZ: 330,
    LOW_END_FREQUENCY_HZ: 660,
    HIGH_START_FREQUENCY_HZ: 495,
    HIGH_END_FREQUENCY_HZ: 990,
    LOW_GAIN: 0.11,
    HIGH_GAIN: 0.065,
    ATTACK_SECONDS: 0.012,
    DURATION_SECONDS: 0.46,
  },

  /** Original three-voice goal horn; no sampled or external audio is used. */
  GOAL: {
    ROOT_FREQUENCY_HZ: 146.83,
    THIRD_RATIO: 1.25,
    FIFTH_RATIO: 1.5,
    START_RATIO: 0.88,
    ROOT_GAIN: 0.15,
    THIRD_GAIN: 0.09,
    FIFTH_GAIN: 0.08,
    ATTACK_SECONDS: 0.035,
    DURATION_SECONDS: 1.35,
    SECOND_HIT_DELAY_SECONDS: 0.34,
    SECOND_HIT_GAIN_RATIO: 0.58,
  },

  /** Urgent two-pulse overtime warning. */
  OVERTIME: {
    LOW_FREQUENCY_HZ: 196,
    HIGH_FREQUENCY_HZ: 293.66,
    GAIN: 0.12,
    ATTACK_SECONDS: 0.012,
    DURATION_SECONDS: 0.3,
    SECOND_PULSE_DELAY_SECONDS: 0.34,
  },

  /** Descending three-note match-end cadence. */
  MATCH_END: {
    HIGH_FREQUENCY_HZ: 392,
    MID_FREQUENCY_HZ: 293.66,
    LOW_FREQUENCY_HZ: 196,
    GAIN: 0.1,
    ATTACK_SECONDS: 0.015,
    DURATION_SECONDS: 0.38,
    NOTE_SPACING_SECONDS: 0.26,
  },

  /** Restrained interface acknowledgement for delegated button activation. */
  UI: {
    START_FREQUENCY_HZ: 520,
    END_FREQUENCY_HZ: 680,
    GAIN: 0.045,
    ATTACK_SECONDS: 0.003,
    DURATION_SECONDS: 0.065,
  },
} as const;
