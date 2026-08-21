import {
  INPUT_PROTOCOL_VERSION,
  NETCODE,
  type InputCommandV2,
} from '@rocket-arena/shared';

export interface InputSink {
  send(type: 'input', payload: InputCommandV2): void;
}

/**
 * Every key code this client consumes as gameplay input. Exported so the
 * on-screen control reference can be checked against the real bindings instead
 * of being maintained by hand.
 */
export const GAMEPLAY_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'KeyC',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
]);

/** Return whether an event target is an editable control rather than gameplay. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;

  const candidate = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => Element | null;
  };
  const tagName = candidate.tagName?.toUpperCase();
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return true;
  }
  if (candidate.isContentEditable === true) return true;

  return typeof candidate.closest === 'function'
    && candidate.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

/** Pure keyboard/input transport state used by browser bindings and tests. */
export class InputController {
  private readonly heldCodes = new Set<string>();
  private jumpSequence = 0;
  private cameraToggleSequence = 0;
  private lastRoom: InputSink | null = null;
  private lastPayload = '';
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private forceNextSend = true;

  handleKeyDown(code: string, repeat = false): boolean {
    if (!GAMEPLAY_CODES.has(code)) return false;

    const newPhysicalPress = !repeat && !this.heldCodes.has(code);
    if (code === 'Space' && newPhysicalPress) this.jumpSequence += 1;
    if (code === 'KeyC' && newPhysicalPress) this.cameraToggleSequence += 1;
    this.heldCodes.add(code);
    return true;
  }

  handleKeyUp(code: string): boolean {
    if (!GAMEPLAY_CODES.has(code)) return false;
    this.heldCodes.delete(code);
    return true;
  }

  /** Clear held controls without erasing monotonic physical-edge floors. */
  resetHeldKeys(): void {
    this.heldCodes.clear();
    this.forceNextSend = true;
  }

  /** Forget transport dedupe state so even the same room object is re-synced. */
  detachRoom(): void {
    this.lastRoom = null;
    this.lastPayload = '';
    this.lastSentAt = Number.NEGATIVE_INFINITY;
    this.forceNextSend = true;
  }

  getPayload(): Readonly<InputCommandV2> {
    let throttle = 0;
    let steer = 0;
    let yaw = 0;

    if (this.heldCodes.has('KeyW') || this.heldCodes.has('ArrowUp')) throttle = 1;
    else if (this.heldCodes.has('KeyS') || this.heldCodes.has('ArrowDown')) throttle = -1;

    if (this.heldCodes.has('KeyA') || this.heldCodes.has('ArrowLeft')) steer = 1;
    else if (this.heldCodes.has('KeyD') || this.heldCodes.has('ArrowRight')) steer = -1;

    if (this.heldCodes.has('KeyE')) yaw = 1;
    else if (this.heldCodes.has('KeyQ')) yaw = -1;

    return Object.freeze({
      protocolVersion: INPUT_PROTOCOL_VERSION,
      throttle,
      steer,
      pitch: throttle,
      yaw,
      roll: steer,
      jumpHeld: this.heldCodes.has('Space'),
      jumpSequence: this.jumpSequence,
      boostHeld: this.heldCodes.has('ShiftLeft') || this.heldCodes.has('ShiftRight'),
      powerslideHeld: this.heldCodes.has('ControlLeft') || this.heldCodes.has('ControlRight'),
      cameraToggleSequence: this.cameraToggleSequence,
    });
  }

  /** Send changes, room-initial state, forced neutral state, or a heartbeat. */
  send(room: InputSink, nowMs: number, force = false): boolean {
    if (room !== this.lastRoom) {
      this.lastRoom = room;
      this.lastPayload = '';
      this.lastSentAt = Number.NEGATIVE_INFINITY;
      this.forceNextSend = true;
    }

    const payload = this.getPayload();
    const serialized = JSON.stringify(payload);
    const heartbeatDue = nowMs - this.lastSentAt >= NETCODE.INPUT_HEARTBEAT_MS;
    if (!force && !this.forceNextSend && serialized === this.lastPayload && !heartbeatDue) {
      return false;
    }

    room.send('input', payload);
    this.lastPayload = serialized;
    this.lastSentAt = nowMs;
    this.forceNextSend = false;
    return true;
  }
}
