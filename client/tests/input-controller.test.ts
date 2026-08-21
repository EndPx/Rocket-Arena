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

test('axis inversion is off by default and each axis flips independently', () => {
  const controller = new InputController();
  assert.deepEqual(controller.getAxisInversion(), {
    drive: false,
    steer: false,
    airYaw: false,
  });

  controller.handleKeyDown('KeyW');
  controller.handleKeyDown('KeyA');
  controller.handleKeyDown('KeyE');
  const upright = controller.getPayload();
  assert.equal(upright.throttle, 1);
  assert.equal(upright.steer, 1);
  assert.equal(upright.yaw, 1);

  // Drive only: steer and yaw must be untouched.
  controller.setAxisInversion({ drive: true });
  const driveFlipped = controller.getPayload();
  assert.equal(driveFlipped.throttle, -1);
  assert.equal(driveFlipped.steer, 1);
  assert.equal(driveFlipped.yaw, 1);

  // Steer only.
  controller.setAxisInversion({ steer: true });
  const steerFlipped = controller.getPayload();
  assert.equal(steerFlipped.throttle, 1);
  assert.equal(steerFlipped.steer, -1);
  assert.equal(steerFlipped.yaw, 1);

  // Air yaw only.
  controller.setAxisInversion({ airYaw: true });
  const yawFlipped = controller.getPayload();
  assert.equal(yawFlipped.throttle, 1);
  assert.equal(yawFlipped.steer, 1);
  assert.equal(yawFlipped.yaw, -1);

  // All three at once, and a partial argument means the omitted axes are off.
  controller.setAxisInversion({ drive: true, steer: true, airYaw: true });
  const allFlipped = controller.getPayload();
  assert.equal(allFlipped.throttle, -1);
  assert.equal(allFlipped.steer, -1);
  assert.equal(allFlipped.yaw, -1);
});

test('air pitch and roll follow the same physical axis they are read from', () => {
  const controller = new InputController();
  controller.handleKeyDown('KeyS');
  controller.handleKeyDown('KeyD');

  const upright = controller.getPayload();
  assert.equal(upright.pitch, upright.throttle);
  assert.equal(upright.roll, upright.steer);

  // Inverting W/S inverts the nose too, because it is one axis, not two.
  controller.setAxisInversion({ drive: true, steer: true });
  const flipped = controller.getPayload();
  assert.equal(flipped.throttle, 1);
  assert.equal(flipped.steer, 1);
  assert.equal(flipped.pitch, flipped.throttle);
  assert.equal(flipped.roll, flipped.steer);
});

test('an inverted but unheld axis reports exactly zero rather than negative zero', () => {
  const controller = new InputController();
  controller.setAxisInversion({ drive: true, steer: true, airYaw: true });

  const payload = controller.getPayload();
  for (const value of [
    payload.throttle,
    payload.steer,
    payload.yaw,
    payload.pitch,
    payload.roll,
  ]) {
    assert.equal(value, 0);
    // Negative zero would survive JSON as 0 but is still a lie about the axis.
    assert.equal(Object.is(value, -0), false);
  }
});

test('flipping an axis mid-hold reverses it without dropping the press', () => {
  const controller = new InputController();
  const sink = new RecordingSink();

  controller.handleKeyDown('KeyW');
  assert.equal(controller.send(sink, 0), true);
  assert.equal(sink.payloads[0]!.throttle, 1);

  // Nothing changed, so the transport dedupe must swallow this one.
  assert.equal(controller.send(sink, 1), false);

  // A flip changes the payload without any key event; it must still go out, and
  // the key must still be held rather than flushed.
  controller.setAxisInversion({ drive: true });
  assert.equal(controller.send(sink, 2), true);
  assert.equal(sink.payloads.length, 2);
  assert.equal(sink.payloads[1]!.throttle, -1);

  // Setting the same inversion again is not a change and must not resend.
  controller.setAxisInversion({ drive: true });
  assert.equal(controller.send(sink, 3), false);
  assert.equal(sink.payloads.length, 2);

  // Returning to the shipped mapping is itself a change.
  controller.setAxisInversion({});
  assert.equal(controller.send(sink, 4), true);
  assert.equal(sink.payloads[2]!.throttle, 1);
});
