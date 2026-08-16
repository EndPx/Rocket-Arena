import assert from 'node:assert/strict';
import test from 'node:test';
import { NETCODE, type InputPayload } from '@rocket-arena/shared';
import {
  InputController,
  isEditableTarget,
  type InputSink,
} from '../src/input/input-controller.js';

class RecordingSink implements InputSink {
  readonly payloads: InputPayload[] = [];

  send(type: 'input', payload: InputPayload): void {
    assert.equal(type, 'input');
    this.payloads.push(payload);
  }
}

test('a rapid Space tap remains observable through its monotonic sequence', () => {
  const controller = new InputController();
  controller.handleKeyDown('Space');
  controller.handleKeyUp('Space');

  assert.deepEqual(controller.getPayload(), {
    throttle: 0,
    steer: 0,
    jump: false,
    boost: false,
    jumpSequence: 1,
  });
});

test('repeat keydown does not increment the physical Space press sequence', () => {
  const controller = new InputController();
  controller.handleKeyDown('Space');
  for (let repeat = 0; repeat < 20; repeat++) {
    controller.handleKeyDown('Space', true);
  }

  assert.equal(controller.getPayload().jumpSequence, 1);
  assert.equal(controller.getPayload().jump, true);
});

test('continuous driving controls survive sequencing and reset to neutral', () => {
  const controller = new InputController();
  controller.handleKeyDown('KeyW');
  controller.handleKeyDown('KeyA');
  controller.handleKeyDown('ShiftLeft');
  assert.deepEqual(controller.getPayload(), {
    throttle: 1,
    steer: 1,
    jump: false,
    boost: true,
    jumpSequence: 0,
  });

  controller.resetHeldKeys();
  assert.deepEqual(controller.getPayload(), {
    throttle: 0,
    steer: 0,
    jump: false,
    boost: false,
    jumpSequence: 0,
  });
});

test('initial room payloads, forced neutral state, and heartbeats are sent', () => {
  const controller = new InputController();
  const firstRoom = new RecordingSink();
  const secondRoom = new RecordingSink();

  assert.equal(controller.send(firstRoom, 0), true);
  assert.equal(controller.send(firstRoom, NETCODE.INPUT_HEARTBEAT_MS - 1), false);
  assert.equal(controller.send(firstRoom, NETCODE.INPUT_HEARTBEAT_MS), true);

  controller.handleKeyDown('KeyW');
  assert.equal(controller.send(firstRoom, NETCODE.INPUT_HEARTBEAT_MS + 1), true);
  controller.resetHeldKeys();
  assert.equal(controller.send(firstRoom, NETCODE.INPUT_HEARTBEAT_MS + 2), true);
  assert.equal(firstRoom.payloads.at(-1)?.throttle, 0);

  assert.equal(controller.send(secondRoom, NETCODE.INPUT_HEARTBEAT_MS + 3), true);
  assert.equal(secondRoom.payloads.length, 1);
});

test('editable controls are distinguished from gameplay targets', () => {
  assert.equal(isEditableTarget({ tagName: 'input' } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ tagName: 'select' } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ tagName: 'CANVAS' } as unknown as EventTarget), false);
  assert.equal(isEditableTarget(null), false);
});

// **Validates: Requirements 3**
test('every generated non-repeat press advances exactly once despite repeats', () => {
  const controller = new InputController();
  for (let press = 1; press <= 128; press++) {
    controller.handleKeyDown('Space');
    for (let repeat = 0; repeat < press % 7; repeat++) {
      controller.handleKeyDown('Space', true);
    }
    assert.equal(controller.getPayload().jumpSequence, press);
    controller.handleKeyUp('Space');
  }
});
