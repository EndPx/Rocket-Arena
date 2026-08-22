import { AUDIO } from '@rocket-arena/shared';
import { normalizeVolume } from '../audio/audio-model.js';

/**
 * Client presentation and input-mapping settings.
 *
 * Sound is included because players expect to find it here, but this module is
 * not its owner: `audio-manager` holds the live mute/volume state and persists it
 * under its own key. Those two fields are a view of that state, passed through so
 * one panel can present everything, and applied back through the audio setters.
 * Every boolean below is owned here outright.
 *
 * The three inversion flags are input mapping, not gameplay: they change how this
 * client reads its own keyboard before building a command. The server keeps one
 * sign convention and never learns that an axis was flipped.
 */
export interface ClientSettings {
  readonly soundVolume: number;
  readonly muted: boolean;
  /** Show the floor circle that reports where the ball is. */
  readonly showBallMarker: boolean;
  /** Show the on-screen control reference along the bottom edge. */
  readonly showControlHints: boolean;
  /** Cast shadows. Off by default; one key light over a 102 m field is expensive. */
  readonly shadows: boolean;
  /** Invert air pitch, taken from W/S. Driving on the ground is unaffected. */
  readonly invertAirPitch: boolean;
  /** Invert air roll, taken from A/D. Steering on the ground is unaffected. */
  readonly invertAirRoll: boolean;
  /** Invert air yaw, taken from Q/E. */
  readonly invertAirYaw: boolean;
}

/**
 * The keys this module owns and persists; sound lives with the audio manager.
 *
 * Declared once as a list so loading, saving, and the default comparison are all
 * derived from it. A setting added here cannot be silently forgotten by one of
 * those three, which is exactly the bug this shape exists to prevent.
 */
export const PERSISTED_SETTING_KEYS = Object.freeze([
  'showBallMarker',
  'showControlHints',
  'shadows',
  'invertAirPitch',
  'invertAirRoll',
  'invertAirYaw',
] as const);

export type PersistedSettingKey = typeof PERSISTED_SETTING_KEYS[number];

export type PersistedClientSettings = { readonly [K in PersistedSettingKey]: boolean };

export const CLIENT_SETTINGS_STORAGE_KEY = 'rocket-arena-settings-v1';

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Object.freeze({
  soundVolume: AUDIO.MASTER.DEFAULT_VOLUME,
  muted: false,
  showBallMarker: true,
  showControlHints: true,
  // Off by default, and offered rather than forced. One directional key light over
  // a 102 m field produced large blocky blobs that read as dirt on the turf and
  // competed with the ball's floor circle for the same cue, which is why this was
  // turned off in the first place. It costs a whole render pass, so a player who
  // wants it should be the one asking for it.
  shadows: false,
  // Inversion is opt-in: the shipped mapping is the one the control hints show.
  invertAirPitch: false,
  invertAirRoll: false,
  invertAirYaw: false,
});

/**
 * Storage seam so the settings can be tested without a browser and so a blocked
 * or full store degrades to defaults instead of throwing. Mirrors the shape
 * `ui/lobby-state.ts` already uses for the player name.
 */
export interface ClientSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Coerce any candidate into a complete settings object, key by declared key. */
export function normalizePersistedSettings(candidate: unknown): PersistedClientSettings {
  const source: Record<string, unknown> = typeof candidate === 'object' && candidate !== null
    ? candidate as Record<string, unknown>
    : {};
  const result: Record<PersistedSettingKey, boolean> = {} as Record<PersistedSettingKey, boolean>;
  for (const key of PERSISTED_SETTING_KEYS) {
    const value = source[key];
    result[key] = typeof value === 'boolean' ? value : DEFAULT_CLIENT_SETTINGS[key];
  }
  return Object.freeze(result);
}

/** Load the owned settings, falling back to defaults on anything unusable. */
export function loadPersistedSettings(
  storage: ClientSettingsStorage | null | undefined,
): PersistedClientSettings {
  if (!storage) return normalizePersistedSettings(null);
  try {
    const raw = storage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
    return normalizePersistedSettings(raw === null ? null : JSON.parse(raw));
  } catch {
    // Corrupt JSON, a blocked store, or a hostile getter all mean defaults.
    return normalizePersistedSettings(null);
  }
}

/** Persist the owned settings. Failure is never fatal; the session still works. */
export function savePersistedSettings(
  storage: ClientSettingsStorage | null | undefined,
  settings: PersistedClientSettings,
): void {
  if (!storage) return;
  try {
    const payload: Record<string, boolean> = {};
    for (const key of PERSISTED_SETTING_KEYS) payload[key] = settings[key] === true;
    storage.setItem(CLIENT_SETTINGS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Settings stay in memory for this session when storage refuses the write.
  }
}

/** Compose the full view from the owned settings plus live audio state. */
export function composeClientSettings(
  persisted: PersistedClientSettings,
  audio: { readonly volume: number; readonly muted: boolean },
): ClientSettings {
  return Object.freeze({
    soundVolume: normalizeVolume(audio.volume),
    muted: audio.muted === true,
    showBallMarker: persisted.showBallMarker === true,
    showControlHints: persisted.showControlHints === true,
    shadows: persisted.shadows === true,
    invertAirPitch: persisted.invertAirPitch === true,
    invertAirRoll: persisted.invertAirRoll === true,
    invertAirYaw: persisted.invertAirYaw === true,
  });
}

/** The owned half of the defaults, which is what a reset writes back. */
export function defaultPersistedSettings(): PersistedClientSettings {
  const result: Record<PersistedSettingKey, boolean> = {} as Record<PersistedSettingKey, boolean>;
  for (const key of PERSISTED_SETTING_KEYS) result[key] = DEFAULT_CLIENT_SETTINGS[key];
  return Object.freeze(result);
}

/**
 * Whether a candidate settings view already matches the shipped defaults, which
 * is what lets the panel disable its own revert action instead of offering a
 * button that would do nothing.
 */
export function isDefaultClientSettings(settings: ClientSettings): boolean {
  if (normalizeVolume(settings.soundVolume) !== normalizeVolume(
    DEFAULT_CLIENT_SETTINGS.soundVolume,
  )) {
    return false;
  }
  if (settings.muted !== DEFAULT_CLIENT_SETTINGS.muted) return false;
  return PERSISTED_SETTING_KEYS.every((key) => settings[key] === DEFAULT_CLIENT_SETTINGS[key]);
}
