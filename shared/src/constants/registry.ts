import { CAR } from './car.js';
import { BALL } from './ball.js';
import { ARENA } from './arena.js';
import { MATCH } from './match.js';
import { NETCODE } from './netcode.js';
import { PHYSICS } from './physics.js';
import { CAMERA } from './camera.js';
import { VISUAL } from './visual.js';

/**
 * Recursively flatten a nested object into a Map of dot-path keys to number values.
 * Example: { CAR: { ENGINE: { FORWARD_FORCE: 3600 } } } -> "CAR.ENGINE.FORWARD_FORCE" => 3600
 */
function flatten(obj: Record<string, unknown>, prefix: string, map: Map<string, number>): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'number') {
      map.set(path, value);
    } else if (typeof value === 'object' && value !== null) {
      flatten(value as Record<string, unknown>, path, map);
    }
  }
}

/** Flat map of all constant paths to their default numeric values */
export const DEFAULTS_REGISTRY: Map<string, number> = new Map();

flatten(CAR as unknown as Record<string, unknown>, 'CAR', DEFAULTS_REGISTRY);
flatten(BALL as unknown as Record<string, unknown>, 'BALL', DEFAULTS_REGISTRY);
flatten(ARENA as unknown as Record<string, unknown>, 'ARENA', DEFAULTS_REGISTRY);
flatten(MATCH as unknown as Record<string, unknown>, 'MATCH', DEFAULTS_REGISTRY);
flatten(NETCODE as unknown as Record<string, unknown>, 'NETCODE', DEFAULTS_REGISTRY);
flatten(PHYSICS as unknown as Record<string, unknown>, 'PHYSICS', DEFAULTS_REGISTRY);
flatten(CAMERA as unknown as Record<string, unknown>, 'CAMERA', DEFAULTS_REGISTRY);
flatten(VISUAL as unknown as Record<string, unknown>, 'VISUAL', DEFAULTS_REGISTRY);
