import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCompleteRoomCode,
  normalizePlayerName,
  normalizeRoomCode,
  PLAYER_NAME_MAX_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from '../src/ui/lobby-input.js';

test('player names are trimmed, bounded, and default only when empty', () => {
  assert.equal(normalizePlayerName('  KiroPilot  '), 'KiroPilot');
  assert.equal(normalizePlayerName(' \n\t '), 'Player');
  assert.equal(normalizePlayerName(null), 'Player');
  assert.equal(
    normalizePlayerName('1234567890abcdefghijklmnop'),
    '1234567890abcdef',
  );
  assert.equal(normalizePlayerName('x'.repeat(PLAYER_NAME_MAX_LENGTH)).length, PLAYER_NAME_MAX_LENGTH);
});

test('room codes uppercase, remove unsupported characters, and stop at six', () => {
  assert.equal(normalizeRoomCode('abio01-z29!'), 'ABZ29');
  assert.equal(normalizeRoomCode('abc234extra'), 'ABC234');
  assert.equal(normalizeRoomCode(''), '');
});

test('only complete normalized server-alphabet codes are accepted', () => {
  assert.equal(isCompleteRoomCode('ABC234'), true);
  assert.equal(isCompleteRoomCode('ABC23'), false);
  assert.equal(isCompleteRoomCode('abc234'), false);
  assert.equal(isCompleteRoomCode('ABCI01'), false);
});

// **Validates: Requirements 2, 5**
test('generated room-code inputs always normalize idempotently into the server alphabet', () => {
  const sourceAlphabet = `${ROOM_CODE_ALPHABET}io01- !@#$%^&*()abcdefghijklmnopqrstuvwxyz`;
  let state = 0x524f434b;

  for (let sample = 0; sample < 256; sample++) {
    let value = '';
    const length = sample % 24;
    for (let index = 0; index < length; index++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      value += sourceAlphabet[state % sourceAlphabet.length];
    }

    const normalized = normalizeRoomCode(value);
    assert.ok(normalized.length <= ROOM_CODE_LENGTH);
    assert.ok([...normalized].every((character) => ROOM_CODE_ALPHABET.includes(character)));
    assert.equal(normalizeRoomCode(normalized), normalized);
  }
});
