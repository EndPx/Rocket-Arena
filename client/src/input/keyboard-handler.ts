import type { Room } from 'colyseus.js';
import type { InputCommandV2, InputPayload } from '@rocket-arena/shared';
import {
  InputController,
  isEditableTarget,
  type AxisInversion,
} from './input-controller.js';

const controller = new InputController();
let activeRoom: Room | null = null;
let inputSuspended = false;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function forceNeutralSync(): void {
  controller.resetHeldKeys();
  if (!activeRoom) return;

  try {
    controller.send(activeRoom, nowMs(), true);
  } catch (error) {
    console.warn('[Input] Could not force neutral state:', error);
  }
}

/**
 * Suspend gameplay input without tearing down the transport.
 *
 * A menu overlay needs the car to stop, but the room connection and the monotonic
 * jump and camera edge floors have to survive so resuming does not fire a phantom
 * jump. Suspending drops new presses and flushes whatever was held.
 */
export function setInputSuspended(suspended: boolean): void {
  if (inputSuspended === suspended) return;
  inputSuspended = suspended;
  if (suspended) forceNeutralSync();
}

export function isInputSuspended(): boolean {
  return inputSuspended;
}

/**
 * Read the W/S, A/D, and Q/E axes backwards.
 *
 * No explicit send is needed: the controller forces its next transmission, and
 * the frame loop already calls `sendInput` continuously, so a flip made from the
 * settings panel reaches the server on the following frame.
 */
export function setAxisInversion(inversion: Partial<AxisInversion>): void {
  controller.setAxisInversion(inversion);
}

export function getAxisInversion(): AxisInversion {
  return controller.getAxisInversion();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('keydown', (event) => {
    if (inputSuspended || isEditableTarget(event.target)) return;
    if (controller.handleKeyDown(event.code, event.repeat)) event.preventDefault();
  });

  window.addEventListener('keyup', (event) => {
    // Releases are always accepted, so a key held as the menu opened cannot stay
    // latched once it is let go.
    const handled = controller.handleKeyUp(event.code);
    if (handled && !isEditableTarget(event.target)) event.preventDefault();
  });

  window.addEventListener('blur', forceNeutralSync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') forceNeutralSync();
  });
  document.addEventListener('focusin', (event) => {
    if (isEditableTarget(event.target)) forceNeutralSync();
  });
}

/** Read a fresh immutable legacy view for presentation systems only. */
export function getCurrentInput(): Readonly<InputPayload> {
  const command = controller.getPayload();
  return Object.freeze({
    throttle: command.throttle,
    steer: command.steer,
    jump: command.jumpHeld,
    boost: command.boostHeld,
    jumpSequence: command.jumpSequence,
  });
}

/** Read the exact V2 command sent to the authoritative server. */
export function getCurrentInputCommandV2(): Readonly<InputCommandV2> {
  return controller.getPayload();
}

/** Send current input when changed, on room entry, or on the input heartbeat. */
export function sendInput(room: Room | null): void {
  if (!room) {
    activeRoom = null;
    controller.detachRoom();
    return;
  }

  activeRoom = room;
  controller.send(room, nowMs());
}
