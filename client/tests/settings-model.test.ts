import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIO } from '@rocket-arena/shared';
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  DEFAULT_CLIENT_SETTINGS,
  composeClientSettings,
  isDefaultClientSettings,
  loadPersistedSettings,
  normalizePersistedSettings,
  savePersistedSettings,
  type ClientSettingsStorage,
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

// Validates: Requirements 16.1-16.20, 19.3-19.17 (client settings persistence)

test('defaults are complete and both toggles start enabled', () => {
  assert.equal(DEFAULT_CLIENT_SETTINGS.showBallMarker, true);
  assert.equal(DEFAULT_CLIENT_SETTINGS.showControlHints, true);
  assert.equal(DEFAULT_CLIENT_SETTINGS.muted, false);
  assert.equal(DEFAULT_CLIENT_SETTINGS.soundVolume, AUDIO.MASTER.DEFAULT_VOLUME);
  assert.equal(Object.isFrozen(DEFAULT_CLIENT_SETTINGS), true);
  assert.equal(isDefaultClientSettings(DEFAULT_CLIENT_SETTINGS), true);
});

test('any malformed candidate normalizes to the defaults it cannot read', () => {
  for (const candidate of [
    null,
    undefined,
    42,
    'showBallMarker',
    [],
    {},
    { showBallMarker: 'yes', showControlHints: 0 },
    { showBallMarker: null },
  ]) {
    const normalized = normalizePersistedSettings(candidate);
    assert.equal(normalized.showBallMarker, true, JSON.stringify(candidate));
    assert.equal(normalized.showControlHints, true, JSON.stringify(candidate));
  }

  // Only real booleans are honoured, and each field is independent.
  assert.deepEqual(
    normalizePersistedSettings({ showBallMarker: false, showControlHints: true }),
    { showBallMarker: false, showControlHints: true },
  );
  assert.deepEqual(
    normalizePersistedSettings({ showBallMarker: true, showControlHints: false }),
    { showBallMarker: true, showControlHints: false },
  );
});

test('settings round-trip through storage and survive a corrupt entry', () => {
  const store = memoryStorage();
  savePersistedSettings(store, { showBallMarker: false, showControlHints: false });
  assert.equal(
    store.entries[CLIENT_SETTINGS_STORAGE_KEY],
    '{"showBallMarker":false,"showControlHints":false}',
  );
  assert.deepEqual(loadPersistedSettings(store), {
    showBallMarker: false,
    showControlHints: false,
  });

  // Corrupt JSON must degrade to defaults rather than throw at startup.
  const corrupt = memoryStorage({ [CLIENT_SETTINGS_STORAGE_KEY]: '{not json' });
  assert.deepEqual(loadPersistedSettings(corrupt), {
    showBallMarker: true,
    showControlHints: true,
  });

  // An empty store and a missing store are both just defaults.
  assert.deepEqual(loadPersistedSettings(memoryStorage()), {
    showBallMarker: true,
    showControlHints: true,
  });
  assert.deepEqual(loadPersistedSettings(null), {
    showBallMarker: true,
    showControlHints: true,
  });
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
  assert.deepEqual(loadPersistedSettings(hostile), {
    showBallMarker: true,
    showControlHints: true,
  });
  assert.doesNotThrow(() => savePersistedSettings(hostile, {
    showBallMarker: false,
    showControlHints: false,
  }));
});

test('the composed view takes sound from the audio owner and clamps it', () => {
  const persisted = { showBallMarker: false, showControlHints: true };

  const composed = composeClientSettings(persisted, { volume: 0.5, muted: true });
  assert.equal(composed.muted, true);
  assert.equal(composed.soundVolume, 0.5);
  assert.equal(composed.showBallMarker, false);
  assert.equal(composed.showControlHints, true);
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
  const defaults = { showBallMarker: true, showControlHints: true };

  assert.equal(isDefaultClientSettings(composeClientSettings(defaults, audio)), true);

  for (const changed of [
    composeClientSettings({ showBallMarker: false, showControlHints: true }, audio),
    composeClientSettings({ showBallMarker: true, showControlHints: false }, audio),
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
