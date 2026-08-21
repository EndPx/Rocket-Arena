import {
  ARENA_FLOOR_WALL_RAMP_RUN_METERS,
  ARENA_HALF_LENGTH_METERS,
  ARENA_HALF_WIDTH_METERS,
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
  getVectorTuningValue,
  type TuningRegistrySnapshot,
} from '@rocket-arena/shared';

/**
 * Authoritative large boost pads.
 *
 * This module is deliberately pure: it takes pad state, car positions, and one
 * timestep, and returns the next pad state plus the boost each car earned. It
 * touches no physics body, no room, and no schema, so the pickup rule can be
 * tested exactly without a world. The caller owns applying the grants to its own
 * inventories, which keeps boost authority in one place.
 *
 * Only the six large pads the registry seeds are modelled. Rocket League also
 * has twenty-eight small pads, but the registry carries no positions for them,
 * and inventing arena positions here would be geometry authored in the wrong
 * place.
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
  /** Whether this pad sits inside the floor-wall ramp band, for diagnostics. */
  readonly onRampBand: boolean;
  readonly boostAmount: number;
  readonly respawnSeconds: number;
}

export interface BoostPadState {
  readonly id: string;
  /** Whether the pad can be collected this step. */
  readonly available: boolean;
  /** Seconds until it returns; zero whenever it is available. */
  readonly respawnSecondsRemaining: number;
}

export interface BoostPadCollector {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  /** Current inventory, so a full car cannot waste a pad. */
  readonly boost: number;
}

export interface BoostPadGrant {
  readonly collectorId: string;
  readonly padId: string;
  readonly boostAmount: number;
}

export interface BoostPadStepResult {
  readonly pads: readonly BoostPadState[];
  readonly grants: readonly BoostPadGrant[];
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
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
  const halfExtents = Object.freeze([extents[0]!, extents[1]!, extents[2]!] as const);
  const carHeight = finitePositive(
    read(() => getScalarTuningValue(tuning, TUNING_IDS.car.collider.height), 0.8),
    0.8,
  );
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

/** Every pad available, which is the state a kickoff resets to. */
export function createBoostPadStates(
  descriptors: readonly BoostPadDescriptor[],
): readonly BoostPadState[] {
  return Object.freeze(descriptors.map((descriptor) => Object.freeze({
    id: descriptor.id,
    available: true,
    respawnSecondsRemaining: 0,
  })));
}

/**
 * A car collects a pad by driving over it.
 *
 * Horizontally this is the seeded sensor footprint, 3 m across against a 3.2 m
 * car, so a car crossing a pad has its centre inside on at least one fixed step.
 * Testing the centre rather than the whole chassis keeps the rule independent of
 * car orientation, which matters because the same inputs must reproduce the same
 * pickup.
 *
 * Vertically the seeded extent is deliberately not used. It describes the pad's
 * own slab, `+/-0.3 m` about `y = 0.15`, reaching only `0.45 m`, while a resting
 * car centre sits at about `0.40 m`. That is a 51 mm margin, and any bump would
 * drop the car out of the box and silently skip the pad.
 *
 * The window is two car-collider heights instead, and that figure is measured
 * rather than guessed. The two side pads sit at `|x| = 39`, which is `1.96 m` from
 * the wall and therefore inside the `2.56 m` floor-wall ramp band, so a car
 * reaching them is already climbing: driving onto the `[39, 0]` pad the car centre
 * was observed at `1.093 m`, which a one-height window at `0.95 m` missed while
 * the car was only `0.54 m` from the pad horizontally. Two heights covers a car on
 * the local ramp surface and still ignores one flying over, since a full jump
 * apexes near `2.6 m`.
 */
function withinSensor(
  descriptor: BoostPadDescriptor,
  position: { readonly x: number; readonly y: number; readonly z: number },
): boolean {
  if (![position.x, position.y, position.z].every(Number.isFinite)) return false;
  const height = position.y - descriptor.position[1];
  return Math.abs(position.x - descriptor.position[0]) <= descriptor.halfExtents[0]
    && Math.abs(position.z - descriptor.position[2]) <= descriptor.halfExtents[2]
    && height >= -descriptor.halfExtents[1]
    && height <= descriptor.pickupHeight;
}

/**
 * Advance every pad one fixed step.
 *
 * Collectors are consulted in the order given, so when two cars sit on the same
 * pad in the same step exactly one of them takes it, and which one is decided by
 * the caller's stable roster order rather than by iteration chance.
 */
export function stepBoostPads(
  descriptors: readonly BoostPadDescriptor[],
  pads: readonly BoostPadState[],
  collectors: readonly BoostPadCollector[],
  timestepSeconds: number,
  maximumBoost: number,
): BoostPadStepResult {
  const step = finiteNonNegative(timestepSeconds, 0);
  const cap = finitePositive(maximumBoost, 100);
  const byId = new Map(pads.map((pad) => [pad.id, pad] as const));
  const grants: BoostPadGrant[] = [];
  const claimed = new Map<string, number>();

  const next = descriptors.map((descriptor) => {
    const previous = byId.get(descriptor.id);
    const wasAvailable = previous?.available !== false;
    const remaining = finiteNonNegative(previous?.respawnSecondsRemaining ?? 0, 0);

    // A spent pad counts down first, so a pad that comes back this step is
    // immediately collectable and never idles for an extra step.
    let available = wasAvailable;
    let respawnSecondsRemaining = 0;
    if (!wasAvailable) {
      const countdown = remaining - step;
      if (countdown > 0) {
        return Object.freeze({
          id: descriptor.id,
          available: false,
          respawnSecondsRemaining: countdown,
        });
      }
      available = true;
    }

    for (const collector of collectors) {
      if (!available) break;
      const already = claimed.get(collector.id) ?? 0;
      const boost = finiteNonNegative(collector.boost, 0) + already;
      // A full tank leaves the pad standing rather than wasting it.
      if (boost >= cap - 1e-9) continue;
      if (!withinSensor(descriptor, collector.position)) continue;

      const granted = Math.min(descriptor.boostAmount, cap - boost);
      grants.push(Object.freeze({
        collectorId: collector.id,
        padId: descriptor.id,
        boostAmount: granted,
      }));
      claimed.set(collector.id, already + granted);
      available = false;
      respawnSecondsRemaining = descriptor.respawnSeconds;
    }

    return Object.freeze({ id: descriptor.id, available, respawnSecondsRemaining });
  });

  return Object.freeze({ pads: Object.freeze(next), grants: Object.freeze(grants) });
}
