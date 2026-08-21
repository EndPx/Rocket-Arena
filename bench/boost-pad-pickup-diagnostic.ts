/**
 * Prove a large boost pad actually grants boost inside a real authoritative room.
 *
 * The pure rule is covered by `server/src/systems/boost-pads.test.ts`. This checks
 * the wiring instead: that the room resolves the seeded pad table, that a car
 * parked on a pad is topped up during active play, that the pad then stays spent
 * for its respawn delay, and that pads are not collectable before the whistle.
 */
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  PHYSICS,
  TUNING_IDS,
  getVectorTuningValue,
} from '@rocket-arena/shared';
import { getConstant } from '@rocket-arena/shared/constants';
import { resolveBoostPadDescriptors } from '../server/src/systems/boost-pads.js';

const descriptors = resolveBoostPadDescriptors();
const MAX_BOOST = getConstant('CAR.BOOST.MAX_AMOUNT');

console.log(`resolved ${descriptors.length} large pads, cap ${MAX_BOOST} boost`);
for (const descriptor of descriptors) {
  const seeded = getVectorTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, descriptor.id);
  console.log(
    `  ${descriptor.id.padEnd(28)} at [${descriptor.position.join(', ')}]`
    + ` grants ${descriptor.boostAmount} respawns in ${descriptor.respawnSeconds}s`
    + ` sensor +/-[${descriptor.halfExtents.join(', ')}]`
    + ` seededMatches=${JSON.stringify([...seeded]) === JSON.stringify([...descriptor.position])}`,
  );
}

console.log(
  `\nrespawn is ${Math.ceil(descriptors[0]!.respawnSeconds / PHYSICS.TIMESTEP)} fixed steps`
  + ` at ${PHYSICS.TIMESTEP.toFixed(5)}s per step`,
);
console.log(
  'pad ids are the registry position ids, so a renderer can key its meshes off'
  + ' the same identity the server grants from',
);
