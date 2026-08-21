import { ARENA_FLOOR_WALL_RAMP_RUN_METERS } from '../geometry/arena-collision.js';
import {
  ARENA_HALF_LENGTH_METERS,
  ARENA_HALF_WIDTH_METERS,
} from '../geometry/arena-spec.js';
import { TUNING_IDS } from '../tuning/model.js';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  getScalarTuningValue,
  getVectorTuningValue,
} from '../tuning/registry.js';
import type { TuningRegistrySnapshot } from '../tuning/model.js';

/**
 * One large boost pad, derived from the seeded registry entries.
 *
 * This lives in shared because two very different consumers need the same table
 * from the same source: the authoritative room grants from it, and the renderer
 * draws it. Deriving it twice would let the drawn pads drift away from the ones
 * that actually pay out.
 *
 * Only the six large pads are modelled. Rocket League also has twenty-eight
 * small pads, but the registry carries no positions for them, and inventing arena
 * positions here would be geometry authored in the wrong place.
 */
export interface BoostPadDescriptor {
  readonly id: string;
  readonly position: readonly [number, number, number];
  readonly halfExtents: readonly [number, number, number];
  /**
   * How far above the pad a car centre may sit and still collect, measured from
   * the pad. Derived from the car collider height rather than from the pad slab,
   * which is far too thin to catch a car reliably.
   */
  readonly pickupHeight: number;
  /** Whether this pad sits inside the floor-wall ramp band. */
  readonly onRampBand: boolean;
  readonly boostAmount: number;
  readonly respawnSeconds: number;
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Resolve the seeded pad table once.
 *
 * A malformed or missing entry drops that pad rather than substituting an
 * invented position, so a broken registry yields fewer pads instead of pads in
 * the wrong place. An empty result is a valid arena with no pads.
 */
export function resolveBoostPadDescriptors(
  tuning: TuningRegistrySnapshot = DEFAULT_TUNING_REGISTRY_SNAPSHOT,
): readonly BoostPadDescriptor[] {
  const read = <T>(resolve: () => T, fallback: T): T => {
    try {
      return resolve();
    } catch {
      return fallback;
    }
  };

  const boostAmount = finitePositive(
    read(() => getScalarTuningValue(tuning, TUNING_IDS.boostPads.largeBoostAmount), 100),
    100,
  );
  const respawnSeconds = finitePositive(
    read(() => getScalarTuningValue(tuning, TUNING_IDS.boostPads.largeRespawnSeconds), 10),
    10,
  );
  const extents = read(
    () => getVectorTuningValue(tuning, TUNING_IDS.boostPads.largeSensorHalfExtents),
    [1.5, 0.3, 1.5] as readonly number[],
  );
  if (extents.length !== 3 || !extents.every((value) => Number.isFinite(value) && value > 0)) {
    return Object.freeze([]);
  }
  const halfExtents = Object.freeze([
    extents[0] as number,
    extents[1] as number,
    extents[2] as number,
  ] as const);
  const carHeight = finitePositive(
    read(() => getScalarTuningValue(tuning, TUNING_IDS.car.collider.height), 0.8),
    0.8,
  );
  // Two car heights. One was measured to be too little: the side pads sit inside
  // the ramp band, and a car climbing onto [39, 0] was observed at 1.093 m.
  const pickupHeight = carHeight * 2;

  const descriptors: BoostPadDescriptor[] = [];
  for (const id of TUNING_IDS.boostPads.largePositions) {
    const position = read(() => getVectorTuningValue(tuning, id), null as readonly number[] | null);
    if (position === null || position.length !== 3 || !position.every(Number.isFinite)) continue;
    descriptors.push(Object.freeze({
      id,
      position: Object.freeze([position[0]!, position[1]!, position[2]!] as const),
      halfExtents,
      pickupHeight,
      onRampBand: Math.abs(position[0]!) > ARENA_HALF_WIDTH_METERS - ARENA_FLOOR_WALL_RAMP_RUN_METERS
        || Math.abs(position[2]!) > ARENA_HALF_LENGTH_METERS - ARENA_FLOOR_WALL_RAMP_RUN_METERS,
      boostAmount,
      respawnSeconds,
    }));
  }
  return Object.freeze(descriptors);
}
