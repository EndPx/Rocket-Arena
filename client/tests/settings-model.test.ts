import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIO } from '@rocket-arena/shared';
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  DEFAULT_CLIENT_SETTINGS,
  PERSISTED_SETTING_KEYS,
  composeClientSettings,
  defaultPersistedSettings,
  isDefaultClientSettings,
  loadPersistedSettings,
  normalizePersistedSettings,
  savePersistedSettings,
  type ClientSettingsStorage,
  type PersistedClientSettings,
} from '../src/ui/settings-model.js';

function memoryStorage(seed: Record<string, string> = {}): ClientSettingsStorage & {
  readonly entries: Record<string, string>;
} {
  const entries: Record<string, string> = { ...seed };
  return {
    entries,
    getItem: (key) => (key in entries ? entries[key]! : null),
    setItem: (key, value) => {
      entries[key] = value;
    },
  };
}

/**
 * Build a complete settings object from partial overrides.
 *
 * Written against the declared key list rather than a hand-listed literal so
 * that adding a setting cannot silently turn these assertions into checks of a
 * stale subset, which is exactly how this file broke when inversion was added.
 */
function persistedWith(overrides: Partial<PersistedClientSettings> = {}): PersistedClientSettings {
  return { ...defaultPersistedSettings(), ...overrides };
}

// Validates: Requirements 16.1-16.20, 19.3-19.17 (client settings persistence)

test('defaults are complete, visibility on, inversion off', () => {
  assert.equal(DEFAULT_CLIENT_SETTINGS.showBallMarker, true);
  assert.equal(DEFAULT_CLIENT_SETTINGS.showControlHints, true);
  // Inversion is opt-in, so the shipped mapping is the one the hints describe.
  assert.equal(DEFAULT_CLIENT_SETTINGS.invertDrive, false);
  assert.equal(DEFAULT_CLIENT_SETTINGS.invertSteer, false);
  assert.equal(DEFAULT_CLIENT_SETTINGS.invertAirYaw, false);
  assert.equal(DEFAULT_CLIENT_SETTINGS.muted, false);
  assert.equal(DEFAULT_CLIENT_SETTINGS.soundVolume, AUDIO.MASTER.DEFAULT_VOLUME);
  assert.equal(Object.isFrozen(DEFAULT_CLIENT_SETTINGS), true);
  assert.equal(isDefaultClientSettings(DEFAULT_CLIENT_SETTINGS), true);
});

test('every declared key is actually owned, persisted, and defaulted', () => {
  // The three sites that must agree: the key list, the defaults, and the reset.
  const defaults = defaultPersistedSettings();
  assert.deepEqual([...PERSISTED_SETTING_KEYS].sort(), Object.keys(defaults).sort());
  for (const key of PERSISTED_SETTING_KEYS) {
    assert.equal(typeof DEFAULT_CLIENT_SETTINGS[key], 'boolean', key);
    assert.equal(defaults[key], DEFAULT_CLIENT_SETTINGS[key], key);
  }
  assert.equal(Object.isFrozen(defaults), true);
});

test('any malformed candidate normalizes to the defaults it cannot read', () => {
  for (const candidate of [
    null,
    undefined,
    42,
    'showBallMarker',
    [],
    {},
    { showBallMarker: 'yes', showControlHints: 0, invertDrive: 1 },
    { showBallMarker: null, invertSteer: 'true' },
  ]) {
    assert.deepEqual(
      normalizePersistedSettings(candidate),
      defaultPersistedSettings(),
      JSON.stringify(candidate),
    );
  }

  // Only real booleans are honoured, and each field stays independent.
  for (const key of PERSISTED_SETTING_KEYS) {
    const flipped = !DEFAULT_CLIENT_SETTINGS[key];
    assert.deepEqual(
      normalizePersistedSettings({ [key]: flipped }),
      persistedWith({ [key]: flipped }),
      key,
    );
  }
});

test('settings round-trip through storage and survive a corrupt entry', () => {
  const store = memoryStorage();
  const saved = persistedWith({
    showBallMarker: false,
    showControlHints: false,
    invertDrive: true,
    invertAirYaw: true,
  });
  savePersistedSettings(store, saved);

  // Compare parsed, not stringified: key order is an implementation detail.
  assert.deepEqual(
    JSON.parse(store.entries[CLIENT_SETTINGS_STORAGE_KEY]!),
    { ...saved },
  );
  assert.deepEqual(loadPersistedSettings(store), saved);

  // Corrupt JSON must degrade to defaults rather than throw at startup.
  const corrupt = memoryStorage({ [CLIENT_SETTINGS_STORAGE_KEY]: '{not json' });
  assert.deepEqual(loadPersistedSettings(corrupt), defaultPersistedSettings());

  // An empty store and a missing store are both just defaults.
  assert.deepEqual(loadPersistedSettings(memoryStorage()), defaultPersistedSettings());
  assert.deepEqual(loadPersistedSettings(null), defaultPersistedSettings());
});

test('a storage that throws never breaks the session', () => {
  const hostile: ClientSettingsStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('full');
    },
  };
  assert.deepEqual(loadPersistedSettings(hostile), defaultPersistedSettings());
  assert.doesNotThrow(() => savePersistedSettings(hostile, persistedWith({
    showBallMarker: false,
    invertSteer: true,
  })));
});

test('the composed view takes sound from the audio owner and clamps it', () => {
  const persisted = persistedWith({ showBallMarker: false, invertSteer: true });

  const composed = composeClientSettings(persisted, { volume: 0.5, muted: true });
  assert.equal(composed.muted, true);
  assert.equal(composed.soundVolume, 0.5);
  assert.equal(composed.showBallMarker, false);
  assert.equal(composed.showControlHints, true);
  assert.equal(composed.invertSteer, true);
  assert.equal(composed.invertDrive, false);
  assert.equal(composed.invertAirYaw, false);
  assert.equal(Object.isFrozen(composed), true);

  // Out-of-range volume from a stale store is clamped, not trusted.
  assert.equal(composeClientSettings(persisted, { volume: 9, muted: false }).soundVolume, 1);
  assert.equal(composeClientSettings(persisted, { volume: -3, muted: false }).soundVolume, 0);
  assert.ok(
    Number.isFinite(
      composeClientSettings(persisted, { volume: Number.NaN, muted: false }).soundVolume,
    ),
  );
});

test('the revert action is only offered when something actually differs', () => {
  const audio = { volume: DEFAULT_CLIENT_SETTINGS.soundVolume, muted: false };
  const defaults = defaultPersistedSettings();

  assert.equal(isDefaultClientSettings(composeClientSettings(defaults, audio)), true);

  // Every owned key on its own has to be enough to enable the revert, including
  // each inversion flag; a flipped axis the panel could not reset would be a
  // setting a player is stuck with.
  for (const key of PERSISTED_SETTING_KEYS) {
    const changed = composeClientSettings(
      persistedWith({ [key]: !DEFAULT_CLIENT_SETTINGS[key] }),
      audio,
    );
    assert.equal(isDefaultClientSettings(changed), false, key);
  }

  for (const changed of [
    composeClientSettings(defaults, { volume: 0.2, muted: false }),
    composeClientSettings(defaults, { volume: DEFAULT_CLIENT_SETTINGS.soundVolume, muted: true }),
  ]) {
    assert.equal(
      isDefaultClientSettings(changed),
      false,
      `expected a difference for ${JSON.stringify(changed)}`,
    );
  }
});
