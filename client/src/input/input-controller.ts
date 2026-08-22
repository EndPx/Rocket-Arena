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

/**
 * Which airborne axes this client reads backwards.
 *
 * Inversion is air-only. Driving and steering on the ground are never flipped,
 * because that is not what anyone means by inverting a flight axis, and it needs
 * no grounded flag to arrange: the server consults pitch, roll, and yaw only while
 * a car is off the ground, so flipping those three is air-only by construction.
 *
 * This is a local input-mapping preference and nothing more. It is applied to the
 * command this client builds, so the server keeps one sign convention and never
 * learns that a player flipped an axis; no authoritative state is involved.
 *
 * Flipping the sign rather than swapping which key is bound keeps the two halves
 * of an axis exactly symmetric, so an inverted axis cannot end up stronger in one
 * direction than the other.
 */
export interface AxisInversion {
  /** Air pitch, taken from the W/S keys. */
  readonly pitch: boolean;
  /** Air roll, taken from the A/D keys. */
  readonly roll: boolean;
  /** Air yaw, taken from the Q/E keys. */
  readonly airYaw: boolean;
}

export const NO_AXIS_INVERSION: AxisInversion = Object.freeze({
  pitch: false,
  roll: false,
  airYaw: false,
});

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
  private axisInversion: AxisInversion = NO_AXIS_INVERSION;

  /**
   * Adopt an axis-inversion preference.
   *
   * Held keys are deliberately not cleared: flipping an axis while a key is down
   * should reverse that axis on the next payload, not drop the press and make the
   * car coast. The next send is forced because the payload changes without any
   * key event, and the transport dedupe would otherwise swallow it.
   */
  setAxisInversion(inversion: Partial<AxisInversion>): void {
    const next = Object.freeze({
      pitch: inversion.pitch === true,
      roll: inversion.roll === true,
      airYaw: inversion.airYaw === true,
    });
    if (next.pitch === this.axisInversion.pitch
      && next.roll === this.axisInversion.roll
      && next.airYaw === this.axisInversion.airYaw) {
      return;
    }
    this.axisInversion = next;
    this.forceNextSend = true;
  }

  getAxisInversion(): AxisInversion {
    return this.axisInversion;
  }

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

    // Applied once, here, so pitch and roll below inherit the same flip as the
    // ground axis they are read from; a player who inverts W/S gets an inverted
    // nose in the air too, because it is the same physical axis. The zero guards
    // keep a neutral axis at exactly 0 rather than -0.
    // Inversion lands on the airborne axes only, which needs no knowledge of
    // whether the car is grounded: the server reads pitch, roll, and yaw solely
    // while a car is off the ground, so flipping them is air-only for free.
    // Throttle and steer are deliberately left alone, because inverted steering on
    // the ground is not what anyone is asking for when they invert a flight axis.
    // The zero guards keep a neutral axis at exactly 0 rather than -0.
    const pitch = this.axisInversion.pitch && throttle !== 0 ? -throttle : throttle;
    const roll = this.axisInversion.roll && steer !== 0 ? -steer : steer;
    if (this.axisInversion.airYaw && yaw !== 0) yaw = -yaw;

    return Object.freeze({
      protocolVersion: INPUT_PROTOCOL_VERSION,
      throttle,
      steer,
      pitch,
      yaw,
      roll,
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
