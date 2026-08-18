import { ARENA } from './arena.js';
import { AUDIO } from './audio.js';
import { BALL } from './ball.js';
import { CAMERA } from './camera.js';
import { CAR } from './car.js';
import { MATCH } from './match.js';
import { NETCODE } from './netcode.js';
import { PHYSICS } from './physics.js';
import { VISUAL } from './visual.js';

function flatten(obj: Record<string, unknown>, prefix: string, map: Map<string, number>): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'number') map.set(path, value);
    else if (typeof value === 'object' && value !== null) {
      flatten(value as Record<string, unknown>, path, map);
    }
  }
}

class ImmutableNumericMap implements ReadonlyMap<string, number> {
  readonly #values: Map<string, number>;

  constructor(values: ReadonlyMap<string, number>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  get(key: string): number | undefined { return this.#values.get(key); }
  has(key: string): boolean { return this.#values.has(key); }
  entries(): MapIterator<[string, number]> { return this.#values.entries(); }
  keys(): MapIterator<string> { return this.#values.keys(); }
  values(): MapIterator<number> { return this.#values.values(); }
  [Symbol.iterator](): MapIterator<[string, number]> { return this.#values[Symbol.iterator](); }
  forEach(
    callbackfn: (value: number, key: string, map: ReadonlyMap<string, number>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
  get [Symbol.toStringTag](): string { return 'ImmutableNumericMap'; }
}

const defaults = new Map<string, number>();
flatten(CAR as unknown as Record<string, unknown>, 'CAR', defaults);
flatten(BALL as unknown as Record<string, unknown>, 'BALL', defaults);
flatten(ARENA as unknown as Record<string, unknown>, 'ARENA', defaults);
flatten(MATCH as unknown as Record<string, unknown>, 'MATCH', defaults);
flatten(NETCODE as unknown as Record<string, unknown>, 'NETCODE', defaults);
flatten(PHYSICS as unknown as Record<string, unknown>, 'PHYSICS', defaults);
flatten(CAMERA as unknown as Record<string, unknown>, 'CAMERA', defaults);
flatten(VISUAL as unknown as Record<string, unknown>, 'VISUAL', defaults);
flatten(AUDIO as unknown as Record<string, unknown>, 'AUDIO', defaults);

/** Immutable numeric compatibility view used by existing presentation/dev tooling. */
export const DEFAULTS_REGISTRY: ReadonlyMap<string, number> = new ImmutableNumericMap(defaults);

/** Paths whose mutable values must go through a room-scoped VersionedTuningRegistry. */
export const MECHANICS_CONSTANT_PREFIXES = Object.freeze([
  'ARENA.',
  'BALL.',
  'CAMERA.',
  'CAR.',
  'MATCH.',
  'NETCODE.',
  'PHYSICS.',
] as const);

export function isMechanicsConstantPath(path: string): boolean {
  return MECHANICS_CONSTANT_PREFIXES.some((prefix) => path.startsWith(prefix));
}
