import type { Room } from 'colyseus.js';
import type { InputPayload } from '@rocket-arena/shared';

const keys: Set<string> = new Set();
let lastPayload: string = '';

window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));

/**
 * Read current keyboard state and send input payload to server.
 * Call this every frame in the render loop.
 */
export function sendInput(room: Room | null): void {
  if (!room) return;

  const payload: InputPayload = {
    throttle: 0,
    steer: 0,
    jump: false,
    boost: false,
  };

  // Throttle
  if (keys.has('KeyW') || keys.has('ArrowUp')) payload.throttle = 1;
  else if (keys.has('KeyS') || keys.has('ArrowDown')) payload.throttle = -1;

  // Steer
  if (keys.has('KeyA') || keys.has('ArrowLeft')) payload.steer = 1;
  else if (keys.has('KeyD') || keys.has('ArrowRight')) payload.steer = -1;

  // Jump (any frame it's held — server does edge detection)
  if (keys.has('Space')) payload.jump = true;

  // Boost
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) payload.boost = true;

  // Only send if changed (avoid flooding)
  const serialized = JSON.stringify(payload);
  if (serialized !== lastPayload) {
    room.send('input', payload);
    lastPayload = serialized;
  }
}
