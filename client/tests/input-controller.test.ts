import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPUT_PROTOCOL_VERSION,
  NETCODE,
  type InputCommandV2,
} from '@rocket-arena/shared';
import {
  InputController,
  isEditableTarget,
  type InputSink,
} from '../src/input/input-controller.js';

class RecordingSink implements InputSink {
  readonly payloads: InputCommandV2[] = [];

  send(type: 'input', payload: InputCommandV2): void {
    assert.equal(type, 'input');
    this.payloads.push(payload);
  }
}

function neutralCommand(
  jumpSequence = 0,
  cameraToggleSequence = 0,
): Readonly<InputCommandV2> {
  return {
    protocolVersion: INPUT_PROTOCOL_VERSION,
    throttle: 0,
    steer: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    jumpHeld: false,
    jumpSequence,
    boostHeld: false,
    powerslideHeld: false,
    cameraToggleSequence,
  };
}

test('rapid Space and camera taps remain observable through monotonic V2 edges', () => {
  const controller = new InputController();
  controller.handleKeyDown('Space');
  controller.handleKeyUp('Space');
  controller.handleKeyDown('KeyC');
  controller.handleKeyUp('KeyC');

  assert.deepEqual(controller.getPayload(), neutralCommand(1, 1));
});

test('repeat and duplicate held keydown do not increment physical edge sequences', () => {
  const controller = new InputController();
  controller.handleKeyDown('Space');
  controller.handleKeyDown('Space');
  controller.handleKeyDown('KeyC');
  controller.handleKeyDown('KeyC');
  for (let repeat = 0; repeat < 20; repeat += 1) {
    controller.handleKeyDown('Space', true);
    controller.handleKeyDown('KeyC', true);
  }

  const payload = controller.getPayload();
  assert.equal(payload.jumpSequence, 1);
  assert.equal(payload.cameraToggleSequence, 1);
  assert.equal(payload.jumpHeld, true);
});

test('ground and air controls map together, then reset neutral while preserving edges', () => {
  const controller = new InputController();
  controller.handleKeyDown('KeyW');
  controller.handleKeyDown('KeyA');
  controller.handleKeyDown('KeyE');
  controller.handleKeyDown('ShiftLeft');
  controller.handleKeyDown('ControlRight');
  controller.handleKeyDown('Space');
  controller.handleKeyDown('KeyC');

  assert.deepEqual(controller.getPayload(), {
    protocolVersion: INPUT_PROTOCOL_VERSION,
    throttle: 1,
    steer: 1,
    pitch: 1,
    yaw: 1,
    roll: 1,
    jumpHeld: true,
    jumpSequence: 1,
    boostHeld: true,
    powerslideHeld: true,
    cameraToggleSequence: 1,
  });

  controller.resetHeldKeys();
  assert.deepEqual(controller.getPayload(), neutralCommand(1, 1));

  controller.handleKeyDown('KeyS');
  controller.handleKeyDown('KeyD');
  controller.handleKeyDown('KeyQ');
  const reverse = controller.getPayload();
  assert.equal(reverse.throttle, -1);
  assert.equal(reverse.pitch, -1);
  assert.equal(reverse.steer, -1);
  assert.equal(reverse.roll, -1);
  assert.equal(reverse.yaw, -1);
});

test('initial room state, exact 250ms heartbeat, neutral sync, and room switch send V2', () => {
  const controller = new InputController();
  const firstRoom = new RecordingSink();
  const secondRoom = new RecordingSink();

  assert.equal(controller.send(firstRoom, 0), true);
  assert.deepEqual(firstRoom.payloads[0], neutralCommand());
  assert.equal(controller.send(firstRoom, NETCODE.INPUT_HEARTBEAT_MS - 1), false);
  assert.equal(controller.send(firstRoom, NETCODE.INPUT_HEARTBEAT_MS), true);
  assert.deepEqual(firstRoom.payloads.at(-1), neutralCommand());

  controller.handleKeyDown('Space');
  controller.handleKeyUp('Space');
  assert.equal(controller.send(firstRoom, NETCODE.INPUT_HEARTBEAT_MS + 1), true);
  assert.equal(firstRoom.payloads.at(-1)?.jumpSequence, 1);
  assert.equal(controller.send(firstRoom, NETCODE.INPUT_HEARTBEAT_MS * 2), false);
  assert.equal(controller.send(firstRoom, NETCODE.INPUT_HEARTBEAT_MS * 2 + 1), true);
  assert.equal(firstRoom.payloads.at(-1)?.jumpSequence, 1, 'heartbeat must retain the edge floor');

  controller.handleKeyDown('KeyW');
  controller.resetHeldKeys();
  assert.equal(controller.send(firstRoom, NETCODE.INPUT_HEARTBEAT_MS * 2 + 2), true);
  assert.deepEqual(firstRoom.payloads.at(-1), neutralCommand(1, 0));

  assert.equal(controller.send(secondRoom, NETCODE.INPUT_HEARTBEAT_MS * 2 + 3), true);
  assert.equal(secondRoom.payloads.length, 1);
  assert.deepEqual(secondRoom.payloads[0], neutralCommand(1, 0));

  controller.detachRoom();
  assert.equal(controller.send(secondRoom, NETCODE.INPUT_HEARTBEAT_MS * 2 + 4), true);
  assert.equal(secondRoom.payloads.length, 2);
});

test('editable controls and editable ancestors are distinguished from gameplay targets', () => {
  assert.equal(isEditableTarget({ tagName: 'input' } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ tagName: 'select' } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ isContentEditable: true } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({
    tagName: 'SPAN',
    closest: () => ({ tagName: 'DIV' }) as unknown as Element,
  } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({
    tagName: 'CANVAS',
    closest: () => null,
  } as unknown as EventTarget), false);
  assert.equal(isEditableTarget(null), false);
});

// **Validates: Requirements 9.4-9.13, 15.2-15.3, 18.5-18.6, 19.12**
test('128 generated press streams advance each edge exactly once despite duplicates', () => {
  const controller = new InputController();
  for (let press = 1; press <= 128; press += 1) {
    controller.handleKeyDown('Space');
    controller.handleKeyDown('Space');
    controller.handleKeyDown('KeyC');
    controller.handleKeyDown('KeyC');
    for (let repeat = 0; repeat < press % 7; repeat += 1) {
      controller.handleKeyDown('Space', true);
      controller.handleKeyDown('KeyC', true);
    }
    const payload = controller.getPayload();
    assert.equal(payload.jumpSequence, press);
    assert.equal(payload.cameraToggleSequence, press);
    controller.handleKeyUp('Space');
    controller.handleKeyUp('KeyC');
  }
});
