import assert from 'node:assert/strict';
import test from 'node:test';
import { ARENA, AUDIO, BALL, DEFAULTS_REGISTRY, NETCODE } from '@rocket-arena/shared';
import {
  AudioEventTracker,
  AudioTransitionQueue,
  calculateStereoPan,
  dampValue,
  dampingAlpha,
  normalizeVolume,
  parseAudioSettings,
  speedToEngineTargets,
  type AudioSnapshotSample,
  type KinematicAudioCar,
  type KinematicAudioEntity,
  type TrackedAudioEvent,
} from '../src/audio/audio-model.js';
import { getAudioDebugState } from '../src/audio/audio-manager.js';

const LOCAL_ID = 'local';

const GROUNDED_CAR: KinematicAudioCar = {
  id: LOCAL_ID,
  x: 0,
  y: 0.48,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
};

const RESTING_BALL: KinematicAudioEntity = {
  x: 8,
  y: 5,
  z: 8,
  vx: 0,
  vy: 0,
  vz: 0,
};

function car(id: string, overrides: Partial<KinematicAudioCar> = {}): KinematicAudioCar {
  return { ...GROUNDED_CAR, id, ...overrides };
}

function ball(overrides: Partial<KinematicAudioEntity> = {}): KinematicAudioEntity {
  return { ...RESTING_BALL, ...overrides };
}

function snapshot(
  sequence: number,
  overrides: Partial<AudioSnapshotSample> = {},
): AudioSnapshotSample {
  return {
    sequence,
    phase: 'playing',
    blueScore: 0,
    orangeScore: 0,
    timeRemaining: 300,
    localCar: { ...GROUNDED_CAR },
    ball: { ...RESTING_BALL },
    otherCars: [],
    ...overrides,
  };
}

function eventTypes(events: readonly TrackedAudioEvent[]): string[] {
  return events.map((event) => event.type);
}

function impactKeys(events: readonly TrackedAudioEvent[]): string[] {
  return events
    .filter((event) => event.type === 'impact')
    .map((event) => event.contactKey ?? '')
    .sort();
}

test('kickoff epochs emit GO once for countdown and each authoritative goal recovery', () => {
  const joinedInProgress = new AudioEventTracker();
  assert.deepEqual(eventTypes(joinedInProgress.observeSnapshot(snapshot(40), 0)), []);
  assert.deepEqual(eventTypes(joinedInProgress.observeSnapshot(snapshot(41), 33)), []);

  const tracker = new AudioEventTracker();
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(1, { phase: 'waiting' }), 0)), []);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(2, {
    phase: 'countdown',
    timeRemaining: 3,
  }), 33)), ['countdown']);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(3), 66)), ['go']);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(3), 67)), []);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(4), 99)), []);

  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(5, {
    phase: 'goal-scored',
    blueScore: 1,
  }), 132)), ['goal']);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(6, {
    blueScore: 1,
  }), 165)), ['go']);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(7, {
    blueScore: 1,
  }), 198)), []);

  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(8, {
    phase: 'goal-scored',
    blueScore: 1,
  }), 231)), []);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(9, {
    phase: 'overtime',
    blueScore: 1,
  }), 264)), ['go', 'overtime']);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(10, {
    phase: 'overtime',
    blueScore: 1,
  }), 297)), []);
  assert.equal(tracker.getDebugState().kickoffCount, 3);
});

test('countdown values, score changes, overtime, and match end remain deduplicated', () => {
  const tracker = new AudioEventTracker();

  tracker.observeSnapshot(snapshot(1, { phase: 'waiting' }), 0);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(2, {
    phase: 'countdown',
    timeRemaining: 5,
  }), 33)), ['countdown']);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(3, {
    phase: 'countdown',
    timeRemaining: 4.2,
  }), 66)), []);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(4, {
    phase: 'countdown',
    timeRemaining: 4,
  }), 99)), ['countdown']);
  tracker.observeSnapshot(snapshot(5), 132);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(6, {
    phase: 'goal-scored',
    orangeScore: 1,
  }), 165)), ['goal']);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(7, {
    phase: 'overtime',
    orangeScore: 1,
  }), 198)), ['go', 'overtime']);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(8, {
    phase: 'ended',
    orangeScore: 1,
  }), 231)), ['match-end']);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(9, {
    phase: 'ended',
    orangeScore: 1,
  }), 264)), []);
});

test('kickoff and active-play teleports seed motion without false landing or impact', () => {
  const kickoffTracker = new AudioEventTracker();
  kickoffTracker.observeSnapshot(snapshot(1, {
    localCar: car(LOCAL_ID, { y: 4, vy: -9 }),
    ball: ball({ x: 12, vx: 10 }),
  }), 0);
  kickoffTracker.observeSnapshot(snapshot(2, {
    phase: 'goal-scored',
    localCar: car(LOCAL_ID, { y: 3.5, vy: -9 }),
    ball: ball({ x: 13, vx: 10 }),
  }), 33);
  const kickoff = kickoffTracker.observeSnapshot(snapshot(3, {
    localCar: car(LOCAL_ID, { x: 15, y: 0.48, vx: -18, vy: 0 }),
    ball: ball({ x: 0, y: BALL.RADIUS, vx: -18, vy: 10 }),
  }), 66);
  assert.deepEqual(eventTypes(kickoff), ['go']);

  const activeTracker = new AudioEventTracker();
  activeTracker.observeSnapshot(snapshot(1), 0);
  activeTracker.observeSnapshot(snapshot(2, {
    localCar: car(LOCAL_ID, { y: 4, vy: -10 }),
  }), 33);
  const teleported = activeTracker.observeSnapshot(snapshot(3, {
    localCar: car(LOCAL_ID, { x: NETCODE.TELEPORT_THRESHOLD + 2, y: 0.48, vx: 20 }),
    ball: ball({ x: -NETCODE.TELEPORT_THRESHOLD - 2, vx: -20 }),
  }), 66);
  assert.deepEqual(eventTypes(teleported), []);

  activeTracker.resetMotionHistory();
  const visibilityBaseline = activeTracker.observeSnapshot(snapshot(4, {
    localCar: car(LOCAL_ID, { x: -18, vx: 20 }),
    ball: ball({ x: ARENA.WIDTH / 2 - BALL.RADIUS, vx: -20 }),
  }), 99);
  assert.deepEqual(eventTypes(visibilityBaseline), []);

  const regressed = activeTracker.observeSnapshot(snapshot(1, {
    localCar: car(LOCAL_ID, { x: 18, vx: -20 }),
    ball: ball({ x: -18, vx: 20 }),
  }), 132);
  assert.deepEqual(eventTypes(regressed), []);
});

// Validates Requirements 5.2, 5.3
// This is the deterministic fallback when the browser backend cannot expose real tab visibility.
test('visibility lifecycle clears transitions and baselines resumed motion before cues', () => {
  const tracker = new AudioEventTracker();
  const queue = new AudioTransitionQueue();
  tracker.observeSnapshot(snapshot(1, {
    localCar: car(LOCAL_ID, {
      y: AUDIO.DETECTION.AIRBORNE_HEIGHT + 1,
      vy: -(AUDIO.DETECTION.LANDING_MIN_DOWNWARD_SPEED + 4),
    }),
  }), 0);
  queue.enqueue({ type: 'goal', strength: 1 });

  queue.clear();
  tracker.resetMotionHistory();
  const resumedBaseline = tracker.observeSnapshot(snapshot(2, {
    localCar: car(LOCAL_ID),
    ball: ball({
      x: ARENA.WIDTH / 2 - BALL.RADIUS,
      y: 5,
      z: 0,
      vx: 9,
    }),
  }), 33);
  assert.equal(queue.size, 0);
  assert.deepEqual(eventTypes(resumedBaseline), []);

  const afterBaseline = tracker.observeSnapshot(snapshot(3, {
    localCar: car(LOCAL_ID),
    ball: ball({
      x: ARENA.WIDTH / 2 - BALL.RADIUS,
      y: 5,
      z: 0,
      vx: -7,
    }),
  }), 66);
  assert.deepEqual(impactKeys(afterBaseline), ['ball:wall:right']);
});

test('landing requires meaningful downward speed and obeys its cooldown', () => {
  const tracker = new AudioEventTracker();
  const minimum = AUDIO.DETECTION.LANDING_MIN_DOWNWARD_SPEED;
  const cooldown = AUDIO.DETECTION.LANDING_COOLDOWN_MS;

  tracker.observeSnapshot(snapshot(1), 0);
  tracker.observeSnapshot(snapshot(2, {
    localCar: car(LOCAL_ID, {
      y: AUDIO.DETECTION.AIRBORNE_HEIGHT + 1,
      vy: -(minimum - 0.1),
    }),
  }), 20);
  assert.equal(eventTypes(tracker.observeSnapshot(snapshot(3), 40)).includes('landing'), false);

  tracker.observeSnapshot(snapshot(4, {
    localCar: car(LOCAL_ID, {
      y: AUDIO.DETECTION.AIRBORNE_HEIGHT + 1,
      vy: -(minimum + 2),
    }),
  }), 60);
  const firstLanding = tracker.observeSnapshot(snapshot(5), 80);
  assert.deepEqual(eventTypes(firstLanding), ['landing']);
  assert.ok((firstLanding[0]?.strength ?? 0) > 0);

  tracker.observeSnapshot(snapshot(6, {
    localCar: car(LOCAL_ID, {
      y: AUDIO.DETECTION.AIRBORNE_HEIGHT + 1,
      vy: -(minimum + 3),
    }),
  }), 100);
  assert.equal(
    eventTypes(tracker.observeSnapshot(snapshot(7), 80 + cooldown - 1)).includes('landing'),
    false,
  );

  tracker.observeSnapshot(snapshot(8, {
    localCar: car(LOCAL_ID, {
      y: AUDIO.DETECTION.AIRBORNE_HEIGHT + 1,
      vy: -(minimum + 3),
    }),
  }), 80 + cooldown);
  assert.equal(
    eventTypes(tracker.observeSnapshot(snapshot(9), 80 + cooldown + 1)).includes('landing'),
    true,
  );
});

test('ball wall, floor, and ceiling reversals emit geometry-keyed impacts', () => {
  const cases: Array<{
    key: string;
    previous: Partial<KinematicAudioEntity>;
    current: Partial<KinematicAudioEntity>;
  }> = [
    {
      key: 'ball:wall:right',
      previous: { x: ARENA.WIDTH / 2 - BALL.RADIUS, vx: 9 },
      current: { x: ARENA.WIDTH / 2 - BALL.RADIUS, vx: -7 },
    },
    {
      key: 'ball:floor',
      previous: { x: 0, y: BALL.RADIUS, z: 0, vy: -9 },
      current: { x: 0, y: BALL.RADIUS, z: 0, vy: 7 },
    },
    {
      key: 'ball:ceiling',
      previous: { x: 0, y: ARENA.HEIGHT - BALL.RADIUS, z: 0, vy: 9 },
      current: { x: 0, y: ARENA.HEIGHT - BALL.RADIUS, z: 0, vy: -7 },
    },
  ];

  for (const scenario of cases) {
    const tracker = new AudioEventTracker();
    tracker.observeSnapshot(snapshot(1, {
      localCar: car(LOCAL_ID, { x: -12, z: -12 }),
      ball: ball(scenario.previous),
    }), 0);
    const events = tracker.observeSnapshot(snapshot(2, {
      localCar: car(LOCAL_ID, { x: -12, z: -12 }),
      ball: ball(scenario.current),
    }), 33);
    assert.deepEqual(impactKeys(events), [scenario.key]);
  }
});

test('local wall and remote car contacts are detected without sharing cooldowns', () => {
  const wallX = -ARENA.WIDTH / 2 + Math.hypot(0.9, 1.6);
  const tracker = new AudioEventTracker();
  tracker.observeSnapshot(snapshot(1, {
    localCar: car(LOCAL_ID, { x: wallX, vx: -9 }),
    ball: ball({ x: ARENA.WIDTH / 2 - BALL.RADIUS, vx: 9 }),
  }), 0);
  const simultaneous = tracker.observeSnapshot(snapshot(2, {
    localCar: car(LOCAL_ID, { x: wallX, vx: 7 }),
    ball: ball({ x: ARENA.WIDTH / 2 - BALL.RADIUS, vx: -7 }),
  }), 33);
  assert.deepEqual(impactKeys(simultaneous), [
    'ball:wall:right',
    `car:${LOCAL_ID}:wall:left`,
  ]);

  const remoteTracker = new AudioEventTracker();
  remoteTracker.observeSnapshot(snapshot(1, {
    localCar: car(LOCAL_ID, { x: -12 }),
    ball: ball({ x: 12, y: 5, z: 0 }),
    otherCars: [
      car('remote-a', { x: -1.8, vx: 8 }),
      car('remote-b', { x: 1.8, vx: -8 }),
    ],
  }), 0);
  const remoteImpact = remoteTracker.observeSnapshot(snapshot(2, {
    localCar: car(LOCAL_ID, { x: -12 }),
    ball: ball({ x: 12, y: 5, z: 0 }),
    otherCars: [
      car('remote-a', { x: -1.8, vx: -3 }),
      car('remote-b', { x: 1.8, vx: 3 }),
    ],
  }), 33);
  assert.deepEqual(impactKeys(remoteImpact), ['car-car:remote-a:remote-b']);
});

test('overlapping local car-ball detectors collapse into one physical impact cluster', () => {
  const tracker = new AudioEventTracker();
  tracker.observeSnapshot(snapshot(1, {
    localCar: car(LOCAL_ID, { x: 0, z: 2.5, vz: -10 }),
    ball: ball({ x: 0, y: BALL.RADIUS, z: 0, vy: -9 }),
  }), 0);

  const clustered = tracker.observeSnapshot(snapshot(2, {
    localCar: car(LOCAL_ID, { x: 0, z: 2.5, vz: 2 }),
    ball: ball({ x: 0, y: BALL.RADIUS, z: 0, vy: 7 }),
  }), 33);
  assert.equal(clustered.filter((event) => event.type === 'impact').length, 1);

  tracker.observeSnapshot(snapshot(3, {
    localCar: car(LOCAL_ID, { x: 0, z: 2.5, vz: -10 }),
    ball: ball({ x: 0, y: BALL.RADIUS, z: 0, vy: -9 }),
  }), 34);
  const overlappingFollowUp = tracker.observeSnapshot(snapshot(4, {
    localCar: car(LOCAL_ID, { x: 0, z: 2.5, vz: 2 }),
    ball: ball({ x: 0, y: BALL.RADIUS, z: 0, vy: 7 }),
  }), 40);
  assert.deepEqual(impactKeys(overlappingFollowUp), []);
});

test('volume normalization matches the range step across defaults and persisted values', () => {
  assert.equal(AUDIO.MASTER.DEFAULT_VOLUME, 0.7);
  assert.equal(normalizeVolume(AUDIO.MASTER.DEFAULT_VOLUME), AUDIO.MASTER.DEFAULT_VOLUME);
  assert.equal(normalizeVolume(0.72), 0.7);
  assert.equal(normalizeVolume(0.73), 0.75);
  assert.equal(normalizeVolume(0.999), 1);
  assert.equal(
    normalizeVolume(0.72) * AUDIO.MASTER.MAX_GAIN,
    AUDIO.MASTER.DEFAULT_VOLUME * AUDIO.MASTER.MAX_GAIN,
  );
  assert.deepEqual(parseAudioSettings(JSON.stringify({ muted: false, volume: 0.72 })), {
    muted: false,
    volume: 0.7,
  });
});

test('remote ball contacts emit and repeated contacts obey their own cooldown', () => {
  const tracker = new AudioEventTracker();
  tracker.observeSnapshot(snapshot(1, {
    localCar: car(LOCAL_ID, { x: -12 }),
    ball: ball({ x: 0, y: BALL.RADIUS, z: 0, vz: 0 }),
    otherCars: [car('remote', { x: 0, y: 0.48, z: 3.8, vz: -10 })],
  }), 0);
  const remoteBallImpact = tracker.observeSnapshot(snapshot(2, {
    localCar: car(LOCAL_ID, { x: -12 }),
    ball: ball({ x: 0, y: BALL.RADIUS, z: 0, vz: -8 }),
    otherCars: [car('remote', { x: 0, y: 0.48, z: 3.8, vz: -2 })],
  }), 20);
  assert.deepEqual(impactKeys(remoteBallImpact), ['ball-car:remote']);

  const wallTracker = new AudioEventTracker();
  const wallBall = { x: ARENA.WIDTH / 2 - BALL.RADIUS, y: 5, z: 0 };
  wallTracker.observeSnapshot(snapshot(1, { ball: ball({ ...wallBall, vx: 8 }) }), 0);
  assert.deepEqual(impactKeys(wallTracker.observeSnapshot(snapshot(2, {
    ball: ball({ ...wallBall, vx: -8 }),
  }), 20)), ['ball:wall:right']);
  wallTracker.observeSnapshot(snapshot(3, { ball: ball({ ...wallBall, vx: 8 }) }), 30);
  assert.deepEqual(impactKeys(wallTracker.observeSnapshot(snapshot(4, {
    ball: ball({ ...wallBall, vx: -8 }),
  }), 40)), []);
  wallTracker.observeSnapshot(snapshot(5, { ball: ball({ ...wallBall, vx: 8 }) }), 140);
  assert.deepEqual(impactKeys(wallTracker.observeSnapshot(snapshot(6, {
    ball: ball({ ...wallBall, vx: -8 }),
  }), 141)), ['ball:wall:right']);
});

test('far velocity changes and one-frame wall acceleration do not create impacts', () => {
  const tracker = new AudioEventTracker();
  tracker.observeSnapshot(snapshot(1, {
    localCar: car(LOCAL_ID, { x: 0, vx: 0 }),
    ball: ball({ x: 10, y: 8, z: 10, vx: 20 }),
    otherCars: [car('remote', { x: -10, z: -10, vx: -20 })],
  }), 0);
  const far = tracker.observeSnapshot(snapshot(2, {
    localCar: car(LOCAL_ID, { x: 0, vx: 20 }),
    ball: ball({ x: 10, y: 8, z: 10, vx: -20 }),
    otherCars: [car('remote', { x: -10, z: -10, vx: 20 })],
  }), 33);
  assert.deepEqual(impactKeys(far), []);

  const wallX = ARENA.WIDTH / 2 - Math.hypot(0.9, 1.6);
  const accelerationTracker = new AudioEventTracker();
  accelerationTracker.observeSnapshot(snapshot(1, {
    localCar: car(LOCAL_ID, { x: wallX, vx: 0 }),
  }), 0);
  const acceleration = accelerationTracker.observeSnapshot(snapshot(2, {
    localCar: car(LOCAL_ID, { x: wallX, vx: 10 }),
  }), 33);
  assert.deepEqual(impactKeys(acceleration), []);
});

test('jump feedback waits for authoritative grounded-to-upward takeoff', () => {
  const tracker = new AudioEventTracker();
  tracker.observeJump(0, true, 0);
  tracker.observeSnapshot(snapshot(1), 0);

  assert.deepEqual(tracker.observeJump(1, true, 10), []);
  assert.equal(tracker.getDebugState().pendingJumpSequence, 1);
  const accepted = tracker.observeSnapshot(snapshot(2, {
    localCar: car(LOCAL_ID, { y: 0.68, vy: 6 }),
  }), 33);
  assert.deepEqual(eventTypes(accepted), ['jump']);
  assert.equal(tracker.getDebugState().pendingJumpSequence, null);
  assert.deepEqual(tracker.observeJump(1, true, 34), []);
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(3, {
    localCar: car(LOCAL_ID, { y: 1.1, vy: 5 }),
  }), 66)), []);
});

test('airborne and expired jump requests are rejected silently and deduplicated', () => {
  const airborneTracker = new AudioEventTracker();
  airborneTracker.observeJump(0, true, 0);
  airborneTracker.observeSnapshot(snapshot(1, {
    localCar: car(LOCAL_ID, { y: 2, vy: 2 }),
  }), 0);
  airborneTracker.observeJump(1, true, 10);
  assert.equal(airborneTracker.getDebugState().pendingJumpSequence, null);
  assert.deepEqual(eventTypes(airborneTracker.observeSnapshot(snapshot(2, {
    localCar: car(LOCAL_ID, { y: 2.5, vy: 7 }),
  }), 33)), []);

  const expiredTracker = new AudioEventTracker();
  expiredTracker.observeJump(0, true, 0);
  expiredTracker.observeSnapshot(snapshot(1), 0);
  expiredTracker.observeJump(1, true, 10);
  expiredTracker.observeJump(1, true, 20);
  expiredTracker.observeSnapshot(snapshot(2), 100);
  const afterWindow = 10 + AUDIO.DETECTION.JUMP_CONFIRM_WINDOW_MS + 1;
  assert.deepEqual(eventTypes(expiredTracker.observeSnapshot(snapshot(3, {
    localCar: car(LOCAL_ID, { y: 0.7, vy: 7 }),
  }), afterWindow)), []);
  assert.equal(expiredTracker.getDebugState().pendingJumpSequence, null);

  expiredTracker.observeJump(2, false, afterWindow + 1);
  assert.deepEqual(expiredTracker.observeJump(2, true, afterWindow + 2), []);
});

test('suspended-context transition queue is bounded, latest-per-type, and excludes rapid cues', () => {
  const queue = new AudioTransitionQueue(3);
  assert.equal(queue.enqueue({ type: 'impact', strength: 1 }), false);
  assert.equal(queue.enqueue({ type: 'ui', strength: 1 }), false);
  assert.equal(queue.enqueue({ type: 'countdown', strength: 1, countdownValue: 5 }), true);
  assert.equal(queue.enqueue({ type: 'countdown', strength: 1, countdownValue: 4 }), true);
  queue.enqueue({ type: 'go', strength: 1 });
  queue.enqueue({ type: 'goal', strength: 1 });
  queue.enqueue({ type: 'overtime', strength: 1 });

  assert.equal(queue.size, 3);
  assert.deepEqual(eventTypes(queue.snapshot()), ['go', 'goal', 'overtime']);
  assert.deepEqual(eventTypes(queue.drain()), ['go', 'goal', 'overtime']);
  assert.equal(queue.size, 0);
});

test('speed mapping, volume, damping, and stereo pan remain finite and bounded', () => {
  assert.equal(normalizeVolume(Number.NaN), AUDIO.MASTER.DEFAULT_VOLUME);
  assert.equal(normalizeVolume(-10), 0);
  assert.equal(normalizeVolume(10), 1);

  const idle = speedToEngineTargets(-1, 0);
  const maximum = speedToEngineTargets(Number.POSITIVE_INFINITY, 4);
  assert.equal(idle.speedRatio, 0);
  assert.equal(idle.frequencyHz, AUDIO.ENGINE.IDLE_FREQUENCY_HZ);
  assert.equal(maximum.speedRatio, 0);

  const capped = speedToEngineTargets(AUDIO.ENGINE.SPEED_FOR_MAX * 4, 4);
  assert.equal(capped.speedRatio, 1);
  assert.equal(capped.frequencyHz, AUDIO.ENGINE.MAX_FREQUENCY_HZ);
  assert.ok(capped.gain >= 0 && capped.gain <= AUDIO.ENGINE.MAX_GAIN);

  assert.equal(calculateStereoPan(
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
  ), AUDIO.SPATIAL.PAN_STRENGTH);
  assert.equal(calculateStereoPan(
    { x: -10, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
  ), -AUDIO.SPATIAL.PAN_STRENGTH);
  assert.equal(calculateStereoPan(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
  ), 0);

  for (let index = -500; index <= 500; index++) {
    const targets = speedToEngineTargets(index / 7, index / 13);
    assert.ok(Number.isFinite(targets.frequencyHz));
    assert.ok(targets.speedRatio >= 0 && targets.speedRatio <= 1);
    assert.ok(targets.gain >= 0 && targets.gain <= AUDIO.ENGINE.MAX_GAIN);
    const alpha = dampingAlpha(index / 10, Math.abs(index) / 1000);
    assert.ok(alpha >= 0 && alpha <= 1);
  }
});

test('reset clears deduplication, pending acknowledgement, and motion history', () => {
  const tracker = new AudioEventTracker();
  tracker.observeJump(5, true, 0);
  tracker.observeSnapshot(snapshot(10, {
    phase: 'countdown',
    timeRemaining: 3,
  }), 0);
  tracker.observeSnapshot(snapshot(11), 33);
  tracker.observeJump(6, true, 40);

  tracker.reset();
  assert.deepEqual(tracker.getDebugState(), {
    lastSequence: null,
    lastPhase: null,
    countdownValues: [],
    startPlayed: false,
    kickoffCount: 0,
    overtimePlayed: false,
    matchEndPlayed: false,
    airborne: false,
    pendingJumpSequence: null,
  });
  assert.deepEqual(eventTypes(tracker.observeSnapshot(snapshot(10, {
    phase: 'countdown',
    timeRemaining: 3,
  }), 66)), ['countdown']);
  assert.deepEqual(tracker.observeJump(5, true, 67), []);
  assert.deepEqual(tracker.observeJump(6, true, 68), []);
});

test('far-apart velocity discontinuities never become collision events in stress samples', () => {
  const tracker = new AudioEventTracker();
  let state = 0x6a09e667;

  for (let sequence = 1; sequence <= 256; sequence++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const localVelocity = (state % 81) - 40;
    state = (state * 1664525 + 1013904223) >>> 0;
    const ballVelocity = (state % 81) - 40;
    state = (state * 1664525 + 1013904223) >>> 0;
    const remoteVelocity = (state % 81) - 40;

    const events = tracker.observeSnapshot(snapshot(sequence, {
      localCar: car(LOCAL_ID, { x: -12, z: 0, vx: localVelocity }),
      ball: ball({ x: 0, y: 10, z: 0, vz: ballVelocity }),
      otherCars: [car('remote', { x: 12, z: 0, vx: remoteVelocity })],
    }), sequence * 33);
    assert.deepEqual(impactKeys(events), []);
  }
});

test('audio defaults remain exported through the numeric registry', () => {
  assert.equal(DEFAULTS_REGISTRY.get('AUDIO.ENGINE.IDLE_FREQUENCY_HZ'), AUDIO.ENGINE.IDLE_FREQUENCY_HZ);
  assert.equal(DEFAULTS_REGISTRY.get('AUDIO.DETECTION.IMPACT_COOLDOWN_MS'), AUDIO.DETECTION.IMPACT_COOLDOWN_MS);
  assert.equal(DEFAULTS_REGISTRY.get('AUDIO.DETECTION.JUMP_CONFIRM_WINDOW_MS'), AUDIO.DETECTION.JUMP_CONFIRM_WINDOW_MS);
  assert.equal(DEFAULTS_REGISTRY.get('AUDIO.MASTER.DEFAULT_VOLUME'), AUDIO.MASTER.DEFAULT_VOLUME);
});

test('persisted audio settings restore valid values and reject malformed data', () => {
  const fallback = { muted: false, volume: AUDIO.MASTER.DEFAULT_VOLUME };
  assert.deepEqual(parseAudioSettings(null), fallback);
  assert.deepEqual(parseAudioSettings('{not-json'), fallback);
  assert.deepEqual(parseAudioSettings('[]'), fallback);
  assert.deepEqual(parseAudioSettings(JSON.stringify({ muted: true, volume: 1.5 })), {
    muted: true,
    volume: 1,
  });
  assert.deepEqual(parseAudioSettings(JSON.stringify({ muted: false, volume: -0.5 })), {
    muted: false,
    volume: 0,
  });
  assert.deepEqual(parseAudioSettings(JSON.stringify({ muted: 'yes', volume: 'loud' })), fallback);
});

test('audio debug state exposes bounded lifecycle counters without mutable graph access', () => {
  const state = getAudioDebugState();
  assert.equal(state.initialized, false);
  assert.equal(state.contextState, 'not-created');
  assert.equal(state.queuedTransitionCount, 0);
  assert.equal(state.liveOneShotVoiceCount, 0);
  assert.equal(state.continuousGraphCount, 0);
  assert.ok(Object.values(state.eventPlayCounts).every((count) => count === 0));
});

test('damping clamps a long render stall to the configured frame-delta limit', () => {
  const response = AUDIO.ENGINE.RESPONSE;
  assert.equal(
    dampingAlpha(response, AUDIO.MASTER.MAX_FRAME_DELTA_SECONDS * 10),
    dampingAlpha(response, AUDIO.MASTER.MAX_FRAME_DELTA_SECONDS),
  );
  assert.equal(
    dampValue(0, 1, response, AUDIO.MASTER.MAX_FRAME_DELTA_SECONDS * 10),
    dampValue(0, 1, response, AUDIO.MASTER.MAX_FRAME_DELTA_SECONDS),
  );
});

function deterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function partitionDuration(totalSeconds: number, framesPerSecond: number): number[] {
  const frameSeconds = 1 / framesPerSecond;
  const fullFrames = Math.floor(totalSeconds / frameSeconds);
  const deltas = Array.from({ length: fullFrames }, () => frameSeconds);
  const remainder = totalSeconds - fullFrames * frameSeconds;
  if (remainder > Number.EPSILON) deltas.push(remainder);
  return deltas;
}

function dampPartition(
  start: number,
  target: number,
  response: number,
  deltas: readonly number[],
): number {
  return deltas.reduce(
    (current, deltaSeconds) => dampValue(current, target, response, deltaSeconds),
    start,
  );
}

// Feature: rocket-arena, Property 1: Time-partition-independent smoothing
// **Validates: Requirements 2.4, 2.5**
test('Feature: rocket-arena, Property 1: time-partition-independent smoothing', () => {
  const random = deterministicRandom(0x243f6a88);
  for (let caseIndex = 0; caseIndex < 128; caseIndex++) {
    const start = (random() - 0.5) * 400;
    const target = (random() - 0.5) * 400;
    const response = random() * 30;
    const totalSeconds = random() * 2;
    const results = [30, 60, 120].map((framesPerSecond) => dampPartition(
      start,
      target,
      response,
      partitionDuration(totalSeconds, framesPerSecond),
    ));
    const lower = Math.min(start, target);
    const upper = Math.max(start, target);
    const tolerance = Math.max(Math.abs(target - start) * 0.001, 1e-10);

    for (const result of results) {
      assert.ok(Number.isFinite(result));
      assert.ok(result >= lower - tolerance && result <= upper + tolerance);
    }
    assert.ok(Math.max(...results) - Math.min(...results) <= tolerance);
  }
});

// Feature: rocket-arena, Property 2: Snapshot observation is idempotent
// **Validates: Requirements 3.6, 3.7, 3.8, 3.9, 3.10, 6.1, 6.2**
test('Feature: rocket-arena, Property 2: snapshot observation is idempotent', () => {
  for (let caseIndex = 0; caseIndex < 128; caseIndex++) {
    const tracker = new AudioEventTracker();
    const firstSequence = caseIndex * 10 + 1;
    let before = snapshot(firstSequence, { phase: 'playing' });
    let accepted = snapshot(firstSequence + 1, { phase: 'playing' });

    switch (caseIndex % 6) {
      case 0:
        before = snapshot(firstSequence, { phase: 'waiting' });
        accepted = snapshot(firstSequence + 1, {
          phase: 'countdown',
          timeRemaining: caseIndex % 5 + 1,
        });
        break;
      case 1:
        before = snapshot(firstSequence, { phase: 'countdown', timeRemaining: 1 });
        accepted = snapshot(firstSequence + 1, { phase: 'playing' });
        break;
      case 2:
        accepted = snapshot(firstSequence + 1, { phase: 'goal-scored', blueScore: 1 });
        break;
      case 3:
        accepted = snapshot(firstSequence + 1, { phase: 'overtime' });
        break;
      case 4:
        accepted = snapshot(firstSequence + 1, { phase: 'ended' });
        break;
      default:
        break;
    }

    tracker.observeSnapshot(before, caseIndex * 1000);
    tracker.observeSnapshot(accepted, caseIndex * 1000 + 33);
    const acceptedState = tracker.getDebugState();
    const duplicateCount = caseIndex % 4 + 1;
    for (let duplicateIndex = 0; duplicateIndex < duplicateCount; duplicateIndex++) {
      assert.deepEqual(
        tracker.observeSnapshot(accepted, caseIndex * 1000 + 34 + duplicateIndex),
        [],
      );
      assert.deepEqual(tracker.getDebugState(), acceptedState);
    }
  }
});

// Feature: rocket-arena, Property 3: Jump cues require one authoritative confirmation
// **Validates: Requirements 3.1, 3.2, 3.3**
test('Feature: rocket-arena, Property 3: jump cues require one authoritative confirmation', () => {
  for (let caseIndex = 0; caseIndex < 128; caseIndex++) {
    const tracker = new AudioEventTracker();
    const mode = caseIndex % 5;
    const firstSequence = caseIndex * 10 + 1;
    const requestAtMs = caseIndex * 1000 + 10;
    const baselineCar = mode === 3
      ? car(LOCAL_ID, { y: 2, vy: 1 })
      : car(LOCAL_ID);

    tracker.observeJump(0, true, requestAtMs - 10);
    tracker.observeSnapshot(snapshot(firstSequence, { localCar: baselineCar }), requestAtMs - 10);
    tracker.observeJump(1, mode !== 4, requestAtMs);

    const confirmationAtMs = mode === 1
      ? requestAtMs + AUDIO.DETECTION.JUMP_CONFIRM_WINDOW_MS + 1
      : requestAtMs + 33;
    const confirmationCar = mode === 2
      ? car(LOCAL_ID, {
        y: GROUNDED_CAR.y + AUDIO.DETECTION.JUMP_TAKEOFF_MIN_RISE + 0.01,
        vy: AUDIO.DETECTION.JUMP_TAKEOFF_MIN_UPWARD_SPEED - 0.1,
      })
      : car(LOCAL_ID, {
        y: baselineCar.y + AUDIO.DETECTION.JUMP_TAKEOFF_MIN_RISE + 0.01,
        vy: AUDIO.DETECTION.JUMP_TAKEOFF_MIN_UPWARD_SPEED + 1,
      });
    const confirmation = tracker.observeSnapshot(snapshot(firstSequence + 1, {
      localCar: confirmationCar,
    }), confirmationAtMs);
    const followUpCar = car(LOCAL_ID, {
      y: confirmationCar.y + 0.25,
      vy: mode === 2
        ? AUDIO.DETECTION.JUMP_TAKEOFF_MIN_UPWARD_SPEED - 0.1
        : AUDIO.DETECTION.JUMP_TAKEOFF_MIN_UPWARD_SPEED + 0.5,
    });
    const followUp = tracker.observeSnapshot(snapshot(firstSequence + 2, {
      localCar: followUpCar,
    }), confirmationAtMs + 33);
    const jumpCount = [...confirmation, ...followUp]
      .filter((event) => event.type === 'jump')
      .length;

    assert.ok(jumpCount <= 1);
    assert.equal(jumpCount, mode === 0 ? 1 : 0);
    assert.deepEqual(tracker.observeSnapshot(snapshot(firstSequence + 2, {
      localCar: followUpCar,
    }), confirmationAtMs + 34), []);
  }
});

// Feature: rocket-arena, Property 4: Teleports cannot synthesize motion cues
// **Validates: Requirements 6.4, 6.5, 6.6**
test('Feature: rocket-arena, Property 4: teleports cannot synthesize motion cues', () => {
  const random = deterministicRandom(0xb7e15162);
  for (let caseIndex = 0; caseIndex < 128; caseIndex++) {
    const tracker = new AudioEventTracker();
    const firstSequence = caseIndex * 10 + 1000;
    const direction = caseIndex % 2 === 0 ? -1 : 1;
    tracker.observeSnapshot(snapshot(firstSequence, {
      localCar: car(LOCAL_ID, {
        y: AUDIO.DETECTION.AIRBORNE_HEIGHT + 1,
        vy: -(AUDIO.DETECTION.LANDING_MIN_DOWNWARD_SPEED + 5),
      }),
      ball: ball({ x: 0, y: 5, vx: 10 }),
    }), caseIndex * 1000);

    const nextSequence = caseIndex % 3 === 0 ? 1 : firstSequence + 1;
    const events = tracker.observeSnapshot(snapshot(nextSequence, {
      localCar: car(LOCAL_ID, {
        x: direction * (NETCODE.TELEPORT_THRESHOLD + 1 + random()),
        y: GROUNDED_CAR.y,
        vy: 0,
      }),
      ball: ball({
        x: direction * (ARENA.WIDTH / 2 - BALL.RADIUS),
        y: BALL.RADIUS,
        vx: -direction * 10,
      }),
    }), caseIndex * 1000 + 33);

    assert.equal(events.some((event) => event.type === 'landing'), false);
    assert.equal(events.some((event) => event.type === 'impact'), false);
    assert.equal(tracker.getDebugState().lastSequence, nextSequence);
  }
});

// Feature: rocket-arena, Property 5: Numeric audio mappings remain finite and bounded
// **Validates: Requirements 2.1, 2.3, 2.5, 4.1, 4.2**
test('Feature: rocket-arena, Property 5: numeric audio mappings remain finite and bounded', () => {
  const random = deterministicRandom(0x9e3779b9);
  const exceptionalValues = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    0,
  ];

  for (let caseIndex = 0; caseIndex < 256; caseIndex++) {
    const first = caseIndex % 3 === 0
      ? exceptionalValues[caseIndex % exceptionalValues.length]
      : (random() - 0.5) * 1_000_000;
    const second = caseIndex % 5 === 0
      ? exceptionalValues[(caseIndex + 3) % exceptionalValues.length]
      : (random() - 0.5) * 1_000_000;
    const third = caseIndex % 7 === 0
      ? exceptionalValues[(caseIndex + 5) % exceptionalValues.length]
      : (random() - 0.5) * 1_000_000;

    const targets = speedToEngineTargets(first, second);
    assert.ok(Object.values(targets).every(Number.isFinite));
    assert.ok(targets.speedRatio >= 0 && targets.speedRatio <= 1);
    assert.ok(targets.frequencyHz >= AUDIO.ENGINE.IDLE_FREQUENCY_HZ);
    assert.ok(targets.frequencyHz <= AUDIO.ENGINE.MAX_FREQUENCY_HZ);
    assert.ok(targets.filterHz >= AUDIO.ENGINE.FILTER_MIN_HZ);
    assert.ok(targets.filterHz <= AUDIO.ENGINE.FILTER_MAX_HZ);
    assert.ok(targets.gain >= 0 && targets.gain <= AUDIO.ENGINE.MAX_GAIN);

    const volume = normalizeVolume(first);
    const alpha = dampingAlpha(second, third);
    const smoothed = dampValue(first, second, third, first);
    assert.ok(Number.isFinite(volume) && volume >= 0 && volume <= 1);
    assert.ok(Number.isFinite(alpha) && alpha >= 0 && alpha <= 1);
    assert.ok(Number.isFinite(smoothed));
    const safeStart = Number.isFinite(first) ? first : 0;
    const safeTarget = Number.isFinite(second) ? second : safeStart;
    assert.ok(smoothed >= Math.min(safeStart, safeTarget));
    assert.ok(smoothed <= Math.max(safeStart, safeTarget));

    const pan = calculateStereoPan(
      { x: first, y: second, z: third },
      { x: second, y: third, z: first },
      { x: third, y: first, z: second },
    );
    assert.ok(Number.isFinite(pan));
    assert.ok(pan >= -1 && pan <= 1);
  }
});
