import { AUDIO } from '@rocket-arena/shared';
import { normalizeVolume } from '../audio/audio-model.js';

/**
 * Client presentation settings.
 *
 * Sound is included because players expect to find it here, but this module is
 * not its owner: `audio-manager` holds the live mute/volume state and persists it
 * under its own key. These two fields are a view of that state, passed through so
 * one panel can present everything, and applied back through the audio setters.
 * The two toggles below are owned here outright.
 */
export interface ClientSettings {
  readonly soundVolume: number;
  readonly muted: boolean;
  /** Show the floor circle that reports where the ball is. */
  readonly showBallMarker: boolean;
  /** Show the on-screen control reference along the bottom edge. */
  readonly showControlHints: boolean;
}

/** The settings this module owns and persists; sound lives with the audio manager. */
export type PersistedClientSettings = Pick<
  ClientSettings,
  'showBallMarker' | 'showControlHints'
>;

export const CLIENT_SETTINGS_STORAGE_KEY = 'rocket-arena-settings-v1';

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Object.freeze({
  soundVolume: AUDIO.MASTER.DEFAULT_VOLUME,
  muted: false,
  showBallMarker: true,
  showControlHints: true,
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

function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** Coerce any candidate into a complete, finite settings object. */
export function normalizePersistedSettings(candidate: unknown): PersistedClientSettings {
  if (typeof candidate !== 'object' || candidate === null) {
    return {
      showBallMarker: DEFAULT_CLIENT_SETTINGS.showBallMarker,
      showControlHints: DEFAULT_CLIENT_SETTINGS.showControlHints,
    };
  }
  const source = candidate as Record<string, unknown>;
  return {
    showBallMarker: readBoolean(
      source,
      'showBallMarker',
      DEFAULT_CLIENT_SETTINGS.showBallMarker,
    ),
    showControlHints: readBoolean(
      source,
      'showControlHints',
      DEFAULT_CLIENT_SETTINGS.showControlHints,
    ),
  };
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
    storage.setItem(CLIENT_SETTINGS_STORAGE_KEY, JSON.stringify({
      showBallMarker: settings.showBallMarker === true,
      showControlHints: settings.showControlHints === true,
    }));
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
  });
}

/**
 * Whether a candidate settings view already matches the shipped defaults, which
 * is what lets the panel disable its own revert action instead of offering a
 * button that would do nothing.
 */
export function isDefaultClientSettings(settings: ClientSettings): boolean {
  return normalizeVolume(settings.soundVolume) === normalizeVolume(
    DEFAULT_CLIENT_SETTINGS.soundVolume,
  )
    && settings.muted === DEFAULT_CLIENT_SETTINGS.muted
    && settings.showBallMarker === DEFAULT_CLIENT_SETTINGS.showBallMarker
    && settings.showControlHints === DEFAULT_CLIENT_SETTINGS.showControlHints;
}
