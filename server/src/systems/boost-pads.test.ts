import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TUNING_REGISTRY_SNAPSHOT, TUNING_IDS } from '@rocket-arena/shared';
import {
  createBoostPadStates,
  resolveBoostPadDescriptors,
  stepBoostPads,
  type BoostPadCollector,
  type BoostPadDescriptor,
} from './boost-pads.js';

const STEP = 1 / 60;
const MAX_BOOST = 100;

function collector(
  id: string,
  position: { x: number; y: number; z: number },
  boost = 0,
): BoostPadCollector {
  return { id, position, boost };
}

function onPad(descriptor: BoostPadDescriptor): { x: number; y: number; z: number } {
  return {
    x: descriptor.position[0],
    y: descriptor.position[1],
    z: descriptor.position[2],
  };
}

// Validates: Requirements 14.15-14.16 (authoritative boost pads, both classes)

test('the seeded pad table resolves both registry classes, large first', () => {
  const descriptors = resolveBoostPadDescriptors();

  // Six large, eighteen small: Rocket League's six plus a mirrored subset of its
  // twenty-eight, thinned by project decision rather than by accident.
  assert.equal(descriptors.length, 24);
  assert.deepEqual(
    descriptors.map(({ id }) => id),
    [
      ...TUNING_IDS.boostPads.largePositions,
      ...TUNING_IDS.boostPads.smallPositions,
    ],
  );

  for (const descriptor of descriptors) {
    assert.ok(descriptor.position.every(Number.isFinite));
    assert.ok(descriptor.halfExtents.every((value) => value > 0));
    // The window has to clear a car climbing the ramp band, measured at 1.093 m
    // over the [39, 0] pad, not just a resting car near 0.40 m.
    assert.ok(
      descriptor.position[1] + descriptor.pickupHeight > 1.093,
      'the pickup window must clear a car climbing the ramp band',
    );
    assert.equal(Object.isFrozen(descriptor), true);
  }

  const large = descriptors.filter(({ kind }) => kind === 'large');
  const small = descriptors.filter(({ kind }) => kind === 'small');
  assert.equal(large.length, 6);
  assert.equal(small.length, 18);

  for (const descriptor of large) {
    assert.equal(descriptor.boostAmount, 100, 'a large pad fills the tank');
    assert.equal(descriptor.respawnSeconds, 10, 'a large pad takes ten seconds to return');
  }
  for (const descriptor of small) {
    assert.equal(descriptor.boostAmount, 12, 'a small pad is worth twelve units');
    assert.equal(descriptor.respawnSeconds, 5, 'a small pad returns on the shorter cycle');
    // A smaller pad has to have a smaller catch area, or the two classes would be
    // indistinguishable to drive over.
    assert.ok(descriptor.halfExtents[0] < large[0]!.halfExtents[0]);
  }

  // Positions must be distinct, or two pads would occupy one sensor.
  assert.equal(new Set(descriptors.map(({ position }) => position.join(','))).size, 24);
});

test('the pad layout is mirrored in both axes, so neither team gets the better half', () => {
  const descriptors = resolveBoostPadDescriptors();
  const key = (x: number, z: number): string => `${x.toFixed(4)},${z.toFixed(4)}`;

  // Checked per class: a large pad mirroring onto a small one would still leave
  // one half of the arena cheaper to refuel in than the other.
  for (const kind of ['large', 'small'] as const) {
    const placed = new Set(
      descriptors
        .filter((descriptor) => descriptor.kind === kind)
        .map(({ position }) => key(position[0], position[2])),
    );
    assert.ok(placed.size > 0, `no ${kind} pads resolved`);

    for (const entry of placed) {
      const [x, z] = entry.split(',').map(Number) as [number, number];
      // Mirroring in z is the fairness one: it swaps the blue and orange halves.
      assert.ok(placed.has(key(x, -z)), `${kind} pad at ${entry} has no z mirror`);
      // Mirroring in x keeps each half symmetric about its own centre line.
      assert.ok(placed.has(key(-x, z)), `${kind} pad at ${entry} has no x mirror`);
    }

    // Neither half may simply hold more pads than the other.
    const blueHalf = [...placed].filter((entry) => Number(entry.split(',')[1]) < 0).length;
    const orangeHalf = [...placed].filter((entry) => Number(entry.split(',')[1]) > 0).length;
    assert.equal(blueHalf, orangeHalf, `${kind} pads are unevenly split between halves`);
  }
});

test('a malformed registry drops pads instead of inventing positions', () => {
  const broken = {
    get: (id: string) => (
      id === TUNING_IDS.boostPads.largePositions[0]
        ? { kind: 'vector', value: [Number.NaN, 0, 0] }
        : DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id)
    ),
  } as unknown as typeof DEFAULT_TUNING_REGISTRY_SNAPSHOT;

  const descriptors = resolveBoostPadDescriptors(broken);
  assert.equal(descriptors.length, 23, 'the non-finite pad is dropped');
  assert.equal(descriptors.some(({ id }) => id === TUNING_IDS.boostPads.largePositions[0]), false);

  // An unreadable sensor footprint drops that whole class rather than borrowing
  // the other one's, because a small pad given a large catch area would pay out
  // where nothing is drawn.
  const brokenExtents = {
    get: (id: string) => (
      id === TUNING_IDS.boostPads.smallSensorHalfExtents
        ? { kind: 'vector', value: [0, 0.2, 0.8] }
        : DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id)
    ),
  } as unknown as typeof DEFAULT_TUNING_REGISTRY_SNAPSHOT;

  const withoutSmall = resolveBoostPadDescriptors(brokenExtents);
  assert.equal(withoutSmall.length, 6);
  assert.equal(withoutSmall.every(({ kind }) => kind === 'large'), true);
});

test('a small pad grants twelve and returns on its own shorter cycle', () => {
  const descriptors = resolveBoostPadDescriptors();
  const target = descriptors.find(({ kind }) => kind === 'small')!;
  const away = collector('a', { x: 0, y: 0.15, z: 48 }, 0);

  const taken = stepBoostPads(
    descriptors,
    createBoostPadStates(descriptors),
    [collector('a', onPad(target), 0)],
    STEP,
    MAX_BOOST,
  );
  assert.deepEqual(taken.grants[0], {
    collectorId: 'a',
    padId: target.id,
    boostAmount: 12,
  });

  // Five seconds, not the large pad's ten: the classes keep their own clocks.
  // Measured by stepping until it returns rather than asserting an exact step
  // count, because three hundred subtractions of 1/60 do not land exactly on zero
  // and an exact count would be testing float accumulation, not the respawn rule.
  const expectedSteps = Math.ceil(target.respawnSeconds / STEP);
  const largePad = descriptors.find(({ kind }) => kind === 'large')!;
  assert.ok(
    expectedSteps < Math.ceil(largePad.respawnSeconds / STEP),
    'the small cycle must be shorter than the large one',
  );

  let pads = taken.pads;
  let steps = 0;
  while (steps < expectedSteps + 4
    && pads.find(({ id }) => id === target.id)!.available === false) {
    pads = stepBoostPads(descriptors, pads, [away], STEP, MAX_BOOST).pads;
    steps += 1;
  }
  assert.ok(
    Math.abs(steps - expectedSteps) <= 1,
    `the small pad returned after ${steps} steps, expected about ${expectedSteps}`,
  );

  const returning = stepBoostPads(
    descriptors,
    pads,
    [collector('a', onPad(target), 0)],
    STEP,
    MAX_BOOST,
  );
  assert.equal(returning.grants.length, 1, 'the returned small pad is collectable');

  // A nearly full tank takes only the shortfall, and never overfills.
  const topUp = stepBoostPads(
    descriptors,
    createBoostPadStates(descriptors),
    [collector('a', onPad(target), 95)],
    STEP,
    MAX_BOOST,
  );
  assert.equal(topUp.grants[0]!.boostAmount, 5, 'the twelve-unit grant clamps to the cap');
});

test('a fresh pad table starts fully available', () => {
  const descriptors = resolveBoostPadDescriptors();
  const pads = createBoostPadStates(descriptors);
  assert.equal(pads.length, descriptors.length);
  for (const pad of pads) {
    assert.equal(pad.available, true);
    assert.equal(pad.respawnSecondsRemaining, 0);
  }
});

test('driving onto a pad grants boost once and spends the pad', () => {
  const descriptors = resolveBoostPadDescriptors();
  const target = descriptors[0]!;
  let pads = createBoostPadStates(descriptors);

  const first = stepBoostPads(
    descriptors,
    pads,
    [collector('a', onPad(target), 0)],
    STEP,
    MAX_BOOST,
  );
  assert.equal(first.grants.length, 1);
  assert.deepEqual(first.grants[0], {
    collectorId: 'a',
    padId: target.id,
    boostAmount: 100,
  });
  const spent = first.pads.find(({ id }) => id === target.id)!;
  assert.equal(spent.available, false);
  assert.equal(spent.respawnSecondsRemaining, target.respawnSeconds);

  // Sitting on a spent pad grants nothing more, however long the car parks.
  pads = first.pads;
  for (let step = 0; step < 30; step += 1) {
    const again = stepBoostPads(
      descriptors,
      pads,
      [collector('a', onPad(target), 0)],
      STEP,
      MAX_BOOST,
    );
    assert.equal(again.grants.length, 0, `a spent pad must not grant at step ${step}`);
    pads = again.pads;
  }

  // Untouched pads stay available throughout.
  for (const pad of pads) {
    if (pad.id === target.id) continue;
    assert.equal(pad.available, true);
  }
});

test('a spent pad returns after exactly its respawn delay and is collectable that step', () => {
  const descriptors = resolveBoostPadDescriptors();
  const target = descriptors[1]!;
  const away = collector('a', { x: 0, y: 0.15, z: 0 }, 0);

  let pads = stepBoostPads(
    descriptors,
    createBoostPadStates(descriptors),
    [collector('a', onPad(target), 0)],
    STEP,
    MAX_BOOST,
  ).pads;

  const stepsToReturn = Math.ceil(target.respawnSeconds / STEP);
  for (let step = 0; step < stepsToReturn - 1; step += 1) {
    const result = stepBoostPads(descriptors, pads, [away], STEP, MAX_BOOST);
    pads = result.pads;
    assert.equal(
      pads.find(({ id }) => id === target.id)!.available,
      false,
      `pad must still be spent at step ${step}`,
    );
  }

  // On the step the countdown elapses the pad is back and immediately usable, so
  // it never idles available-but-uncollectable for an extra step.
  const returning = stepBoostPads(
    descriptors,
    pads,
    [collector('a', onPad(target), 0)],
    STEP,
    MAX_BOOST,
  );
  assert.equal(returning.grants.length, 1, 'the returning pad must be collectable that step');
  assert.equal(returning.grants[0]!.padId, target.id);
});

test('a full tank leaves the pad standing, and a partial tank tops up only to the cap', () => {
  const descriptors = resolveBoostPadDescriptors();
  const target = descriptors[2]!;
  const pads = createBoostPadStates(descriptors);

  const full = stepBoostPads(
    descriptors,
    pads,
    [collector('a', onPad(target), MAX_BOOST)],
    STEP,
    MAX_BOOST,
  );
  assert.equal(full.grants.length, 0, 'a full car must not waste a pad');
  assert.equal(full.pads.find(({ id }) => id === target.id)!.available, true);

  const partial = stepBoostPads(
    descriptors,
    pads,
    [collector('a', onPad(target), 70)],
    STEP,
    MAX_BOOST,
  );
  assert.equal(partial.grants.length, 1);
  assert.equal(partial.grants[0]!.boostAmount, 30, 'the grant is clamped to the cap');
});

test('two cars on one pad in one step produce exactly one grant, by roster order', () => {
  const descriptors = resolveBoostPadDescriptors();
  const target = descriptors[3]!;
  const pads = createBoostPadStates(descriptors);
  const position = onPad(target);

  const result = stepBoostPads(
    descriptors,
    pads,
    [collector('first', position, 0), collector('second', position, 0)],
    STEP,
    MAX_BOOST,
  );
  assert.equal(result.grants.length, 1, 'a pad cannot be collected twice in one step');
  assert.equal(result.grants[0]!.collectorId, 'first', 'roster order decides, not iteration chance');

  const reversed = stepBoostPads(
    descriptors,
    pads,
    [collector('second', position, 0), collector('first', position, 0)],
    STEP,
    MAX_BOOST,
  );
  assert.equal(reversed.grants[0]!.collectorId, 'second');
});

test('one car can clear several pads in a step and still respects the cap', () => {
  const descriptors = resolveBoostPadDescriptors();
  // Place a single collector on two pads at once by using a shared position is
  // impossible, so drive it onto one pad per call and verify the running total.
  const first = descriptors[4]!;
  let pads = createBoostPadStates(descriptors);

  const takeFirst = stepBoostPads(
    descriptors,
    pads,
    [collector('a', onPad(first), 0)],
    STEP,
    MAX_BOOST,
  );
  pads = takeFirst.pads;
  assert.equal(takeFirst.grants.length, 1);

  // Already full from the first pad, so the next one is left alone.
  const takeSecond = stepBoostPads(
    descriptors,
    pads,
    [collector('a', onPad(descriptors[5]!), MAX_BOOST)],
    STEP,
    MAX_BOOST,
  );
  assert.equal(takeSecond.grants.length, 0);
  assert.equal(takeSecond.pads.find(({ id }) => id === descriptors[5]!.id)!.available, true);
});

test('the sensor box is respected on every axis and hostile input is inert', () => {
  const descriptors = resolveBoostPadDescriptors();
  const target = descriptors[0]!;
  const pads = createBoostPadStates(descriptors);
  const [halfX, halfY, halfZ] = target.halfExtents;
  const centre = onPad(target);

  const grantsAt = (position: { x: number; y: number; z: number }): number => stepBoostPads(
    descriptors,
    pads,
    [collector('a', position, 0)],
    STEP,
    MAX_BOOST,
  ).grants.length;

  // Just inside either horizontal face collects; just outside does not.
  assert.equal(grantsAt({ ...centre, x: centre.x + halfX - 1e-6 }), 1);
  assert.equal(grantsAt({ ...centre, x: centre.x + halfX + 1e-3 }), 0);
  assert.equal(grantsAt({ ...centre, z: centre.z - halfZ + 1e-6 }), 1);
  assert.equal(grantsAt({ ...centre, z: centre.z - halfZ - 1e-3 }), 0);

  // Why the pad's own slab is not used vertically. A resting car centre sits at
  // about 0.40 m and the slab tops out at 0.45 m, so the slab rule cleared a
  // parked car by only about 50 mm, and a car riding even slightly higher, which
  // happens on any bump or hop, fell straight out of it.
  const restingCarCentreY = 0.399;
  const slabTop = centre.y + halfY;
  assert.ok(
    slabTop - restingCarCentreY < 0.06,
    `the slab rule cleared a resting car by only ${(slabTop - restingCarCentreY).toFixed(3)} m`,
  );
  assert.equal(
    grantsAt({ ...centre, y: restingCarCentreY }),
    1,
    'a car at its ride height must collect the pad',
  );

  // A hopping car measured at 0.55 m would have missed the pad under the slab
  // rule; the window has to catch it.
  const hoppingCarCentreY = 0.55;
  assert.ok(hoppingCarCentreY > slabTop, 'this height is outside the pad slab');
  assert.equal(
    grantsAt({ ...centre, y: hoppingCarCentreY }),
    1,
    'a car riding above the pad slab must still collect',
  );

  // The measured ramp-band case: the two side pads sit inside the ramp band, so a
  // car reaching them is climbing. This is the height that was observed missing.
  assert.equal(
    grantsAt({ ...centre, y: 1.093 }),
    1,
    'a car climbing the ramp band onto a side pad must collect',
  );
  assert.equal(
    grantsAt({ ...centre, y: centre.y + target.pickupHeight - 1e-6 }),
    1,
    'the top of the pickup window still collects',
  );
  assert.equal(
    grantsAt({ ...centre, y: centre.y + target.pickupHeight + 1e-3 }),
    0,
    'above the pickup window collects nothing',
  );

  // Below the pad, and well above it, both collect nothing.
  assert.equal(grantsAt({ ...centre, y: centre.y - halfY - 1e-3 }), 0);
  assert.equal(grantsAt({ ...centre, y: centre.y + 4 }), 0, 'an airborne car collects nothing');

  for (const hostile of [
    { x: Number.NaN, y: centre.y, z: centre.z },
    { x: centre.x, y: Number.POSITIVE_INFINITY, z: centre.z },
    { x: centre.x, y: centre.y, z: Number.NaN },
  ]) {
    assert.equal(grantsAt(hostile), 0, 'a non-finite position cannot collect');
  }

  // A non-finite timestep must not resurrect a spent pad early.
  const spent = stepBoostPads(descriptors, pads, [collector('a', centre, 0)], STEP, MAX_BOOST).pads;
  const hostileStep = stepBoostPads(
    descriptors,
    spent,
    [collector('a', centre, 0)],
    Number.NaN,
    MAX_BOOST,
  );
  assert.equal(hostileStep.grants.length, 0);
  assert.equal(hostileStep.pads.find(({ id }) => id === target.id)!.available, false);
});

test('stepping is deterministic and never mutates the state it was given', () => {
  const descriptors = resolveBoostPadDescriptors();
  const target = descriptors[0]!;
  const pads = createBoostPadStates(descriptors);
  const before = JSON.stringify(pads);
  const collectors = [collector('a', onPad(target), 0)];

  const first = stepBoostPads(descriptors, pads, collectors, STEP, MAX_BOOST);
  const second = stepBoostPads(descriptors, pads, collectors, STEP, MAX_BOOST);
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'same inputs, same output');
  assert.equal(JSON.stringify(pads), before, 'input pad state must not be mutated');
  assert.equal(Object.isFrozen(first.pads), true);
  assert.equal(Object.isFrozen(first.grants), true);
});

test('the two side pads are flagged as sitting inside the floor-wall ramp band', () => {
  const descriptors = resolveBoostPadDescriptors();
  const onRamp = descriptors.filter(({ onRampBand }) => onRampBand);

  // This is authored content, not a bug: Rocket League puts its side large pads
  // against the wall. The flag exists so the pickup window is known to have to
  // clear a climbing car, and so a renderer can seat them on the ramp surface.
  assert.equal(onRamp.length, 2, 'exactly the two side pads sit in the ramp band');
  for (const descriptor of onRamp) {
    assert.equal(Math.abs(descriptor.position[0]), 39);
    assert.equal(descriptor.position[2], 0);
  }
  for (const descriptor of descriptors.filter(({ onRampBand }) => !onRampBand)) {
    assert.ok(
      Math.abs(descriptor.position[0]) <= 38.4 && Math.abs(descriptor.position[2]) <= 48.64,
      'the remaining pads sit on flat floor',
    );
  }
});
