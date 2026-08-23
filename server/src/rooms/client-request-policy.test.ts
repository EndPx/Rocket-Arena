import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PLAYER_NAME_LENGTH,
  devControlsEnabled,
  sanitizePlayerName,
} from './client-request-policy.js';

const FALLBACK = 'Player 1';

test('keeps an ordinary name untouched', () => {
  assert.equal(sanitizePlayerName('Ayu', FALLBACK), 'Ayu');
});

test('falls back when the candidate is not a string', () => {
  for (const candidate of [undefined, null, 42, {}, []]) {
    assert.equal(sanitizePlayerName(candidate, FALLBACK), FALLBACK);
  }
});

test('falls back when the candidate is blank or only control characters', () => {
  assert.equal(sanitizePlayerName('   ', FALLBACK), FALLBACK);
  assert.equal(sanitizePlayerName('\u0000\u200b\u001b', FALLBACK), FALLBACK);
});

test('bounds a hostile name to the advertised cap', () => {
  const flooded = 'a'.repeat(100_000);
  const sanitized = sanitizePlayerName(flooded, FALLBACK);
  assert.equal(sanitized.length, MAX_PLAYER_NAME_LENGTH);
});

test('strips control characters that would corrupt rendering', () => {
  assert.equal(sanitizePlayerName('Ay\u0000u\u001b', FALLBACK), 'Ayu');
});

test('bounds by codepoint so astral characters are never split', () => {
  const rockets = '\u{1F680}'.repeat(MAX_PLAYER_NAME_LENGTH + 10);
  const sanitized = sanitizePlayerName(rockets, FALLBACK);
  assert.equal([...sanitized].length, MAX_PLAYER_NAME_LENGTH);
  assert.ok(!/[\uD800-\uDFFF]/.test(sanitized.replace(/\u{1F680}/gu, '')));
});

test('dev transports stay off in production', () => {
  assert.equal(devControlsEnabled({ NODE_ENV: 'production' }), false);
});

test('dev transports stay on outside production', () => {
  assert.equal(devControlsEnabled({ NODE_ENV: 'development' }), true);
  assert.equal(devControlsEnabled({}), true);
});

test('an operator can opt dev transports back on in production', () => {
  assert.equal(
    devControlsEnabled({ NODE_ENV: 'production', ROCKET_ARENA_DEV_CONTROLS: 'true' }),
    true,
  );
});
