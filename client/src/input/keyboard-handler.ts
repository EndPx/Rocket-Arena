import type { Room } from 'colyseus.js';
import type { InputCommandV2, InputPayload } from '@rocket-arena/shared';
import { InputController, isEditableTarget } from './input-controller.js';

const controller = new InputController();
let activeRoom: Room | null = null;

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

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('keydown', (event) => {
    if (isEditableTarget(event.target)) return;
    if (controller.handleKeyDown(event.code, event.repeat)) event.preventDefault();
  });

  window.addEventListener('keyup', (event) => {
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
