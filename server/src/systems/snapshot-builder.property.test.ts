import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROOM_POLICIES,
  assertStableTerminalSnapshots,
  deserializeSnapshotEnvelopeV2,
  serializeSnapshotEnvelopeV2,
  type RoomMode,
  type RosterEntry,
  type SnapshotEnvelopeV2,
  type Team,
} from '@rocket-arena/shared';
import {
  SNAPSHOT_FIELD_BOUNDS,
  SnapshotBuilder,
  type SnapshotBallBodyInput,
  type SnapshotBuildInput,
  type SnapshotCarBodyInput,
} from './snapshot-builder.js';

interface SeededRandom {
  readonly seed: string;
  next(): number;
  integer(minInclusive: number, maxInclusive: number): number;
  boolean(probability?: number): boolean;
  pick<T>(values: readonly T[]): T;
}

interface GeneratedCase<T> {
  readonly seed: string;
  readonly index: number;
  readonly value: T;
}

type CaseGenerator<T> = (random: SeededRandom, index: number) => T;

interface GeneratedCasesModule {
  generateCases<T>(options: {
    readonly seed: string | number;
    readonly count: number;
    readonly generate: CaseGenerator<T>;
  }): readonly GeneratedCase<T>[];
  replayCase<T>(
    seed: string | number,
    index: number,
    generate: CaseGenerator<T>,
  ): GeneratedCase<T>;
  assertGeneratedCases<T>(
    cases: readonly GeneratedCase<T>[],
    assertion: (value: T, generatedCase: GeneratedCase<T>) => void,
  ): void;
}

// The shared helper is test infrastructure outside the server project's emit root.
// Loading its source URL at runtime preserves server/tsconfig.json's server/src rootDir.
const generatedCasesModuleUrl = new URL(
  '../../../shared/tests/support/generated-cases.ts',
  import.meta.url,
).href;
const {
  assertGeneratedCases,
  generateCases,
  replayCase,
} = await import(generatedCasesModuleUrl) as unknown as GeneratedCasesModule;

const RECORDED_SEED = 'rocket-arena-property-7-snapshot-round-trip-v1';
const GENERATED_CASE_COUNT = 126;
const REPLAY_CASE_INDEX = 83;
const VECTOR_TOLERANCE = 1e-10;

type TerminalVariant = 'target-and-margin' | 'hard-cutoff' | 'overtime-goal';
type ExpectedTerminalReason =
  | 'regulation-target-and-margin'
  | 'hard-regulation-cutoff'
  | 'overtime-goal';
type ExpectedTerminalTransitionKind =
  | 'regulation-terminal-goal'
  | 'hard-cutoff'
  | 'overtime-terminal-goal';
type CarMapEntry = readonly [string, Readonly<SnapshotCarBodyInput>];

interface GeneratedIdentity {
  readonly rosterEntry: Readonly<RosterEntry>;
  readonly body: Readonly<SnapshotCarBodyInput>;
}

interface GeneratedTerminalCase {
  readonly variant: TerminalVariant;
  readonly reason: ExpectedTerminalReason;
  readonly transitionKind: ExpectedTerminalTransitionKind;
  readonly winner: Team;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly regulationSecondsRemaining: number;
  readonly kickoffEpoch: number;
}

interface GeneratedSnapshotCase {
  readonly caseIndex: number;
  readonly mode: RoomMode;
  readonly occupancy: number;
  readonly roster: readonly Readonly<RosterEntry>[];
  readonly rosterInsertion: readonly Readonly<RosterEntry>[];
  readonly carInsertion: readonly CarMapEntry[];
  readonly ball: Readonly<SnapshotBallBodyInput>;
  readonly disconnectSessionId: string | null;
  readonly emptyDisconnectProbe: GeneratedIdentity;
  readonly serverTime: number;
  readonly simulationTime: number;
  readonly playingRegulationSecondsRemaining: number;
  readonly playingKickoffEpoch: number;
  readonly playingBlueScore: number;
  readonly playingOrangeScore: number;
  readonly initialSnapshotSequence: number;
  readonly terminalSnapshotSequence: number;
  readonly initialTransitionSequence: number;
  readonly terminal: GeneratedTerminalCase;
}

const UNIT_QUATERNIONS = Object.freeze([
  Object.freeze([0, 0, 0, 1] as const),
  Object.freeze([0, 0, 0, -1] as const),
  Object.freeze([1, 0, 0, 0] as const),
  Object.freeze([-1, 0, 0, 0] as const),
  Object.freeze([0, 1, 0, 0] as const),
  Object.freeze([0, -1, 0, 0] as const),
  Object.freeze([0, 0, 1, 0] as const),
  Object.freeze([0, 0, -1, 0] as const),
]);

function shuffle<T>(values: readonly T[], random: SeededRandom): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = random.integer(0, index);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

function randomBounded(
  random: SeededRandom,
  minimum: number,
  maximum: number,
): number {
  const fraction = random.integer(0, 10_000) / 10_000;
  return minimum + (maximum - minimum) * fraction;
}

function randomPosition(random: SeededRandom): SnapshotCarBodyInput['position'] {
  return Object.freeze([
    randomBounded(
      random,
      SNAPSHOT_FIELD_BOUNDS.position.min[0],
      SNAPSHOT_FIELD_BOUNDS.position.max[0],
    ),
    randomBounded(
      random,
      SNAPSHOT_FIELD_BOUNDS.position.min[1],
      SNAPSHOT_FIELD_BOUNDS.position.max[1],
    ),
    randomBounded(
      random,
      SNAPSHOT_FIELD_BOUNDS.position.min[2],
      SNAPSHOT_FIELD_BOUNDS.position.max[2],
    ),
  ] as const);
}

function randomVelocity(
  random: SeededRandom,
  maximumMagnitude: number,
): SnapshotCarBodyInput['linearVelocity'] {
  let x = random.integer(-1_000, 1_000);
  const y = random.integer(-1_000, 1_000);
  const z = random.integer(-1_000, 1_000);
  if (x === 0 && y === 0 && z === 0) x = 1;

  const sourceMagnitude = Math.hypot(x, y, z);
  const targetMagnitude = maximumMagnitude * random.integer(1, 9_000) / 10_000;
  const scale = targetMagnitude / sourceMagnitude;
  return Object.freeze([x * scale, y * scale, z * scale] as const);
}

function randomRotation(random: SeededRandom): SnapshotCarBodyInput['rotation'] {
  return random.pick(UNIT_QUATERNIONS);
}

function generateCarBody(random: SeededRandom): Readonly<SnapshotCarBodyInput> {
  return Object.freeze({
    position: randomPosition(random),
    rotation: randomRotation(random),
    linearVelocity: randomVelocity(random, SNAPSHOT_FIELD_BOUNDS.carLinearSpeed),
    boost: randomBounded(
      random,
      SNAPSHOT_FIELD_BOUNDS.boost.min,
      SNAPSHOT_FIELD_BOUNDS.boost.max,
    ),
  });
}

function generateBallBody(random: SeededRandom): Readonly<SnapshotBallBodyInput> {
  return Object.freeze({
    position: randomPosition(random),
    rotation: randomRotation(random),
    linearVelocity: randomVelocity(random, SNAPSHOT_FIELD_BOUNDS.ballLinearSpeed),
  });
}

function scoresForWinner(
  winner: Team,
  winnerScore: number,
  loserScore: number,
): Readonly<{ blueScore: number; orangeScore: number }> {
  return winner === 'blue'
    ? Object.freeze({ blueScore: winnerScore, orangeScore: loserScore })
    : Object.freeze({ blueScore: loserScore, orangeScore: winnerScore });
}

function generateTerminalCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedTerminalCase {
  const winner: Team = random.boolean() ? 'blue' : 'orange';
  const kickoffEpoch = random.integer(1, 1_000);

  if (caseIndex % 3 === 0) {
    const loserScore = random.integer(0, 8);
    const winnerScore = Math.max(6, loserScore + 2) + random.integer(0, 3);
    return Object.freeze({
      variant: 'target-and-margin',
      reason: 'regulation-target-and-margin',
      transitionKind: 'regulation-terminal-goal',
      winner,
      ...scoresForWinner(winner, winnerScore, loserScore),
      regulationSecondsRemaining: random.integer(1, 300),
      kickoffEpoch,
    });
  }

  if (caseIndex % 3 === 1) {
    const loserScore = random.integer(0, 4);
    const winnerScore = loserScore + 1;
    return Object.freeze({
      variant: 'hard-cutoff',
      reason: 'hard-regulation-cutoff',
      transitionKind: 'hard-cutoff',
      winner,
      ...scoresForWinner(winner, winnerScore, loserScore),
      regulationSecondsRemaining: 0,
      kickoffEpoch,
    });
  }

  const tiedScore = random.integer(0, 8);
  return Object.freeze({
    variant: 'overtime-goal',
    reason: 'overtime-goal',
    transitionKind: 'overtime-terminal-goal',
    winner,
    ...scoresForWinner(winner, tiedScore + 1, tiedScore),
    regulationSecondsRemaining: 0,
    kickoffEpoch,
  });
}

function makeSessionId(caseIndex: number, ordinal: number, identityIndex: number): string {
  const tieBreaker = identityIndex % 2 === 0 ? 'z' : 'a';
  return `p7-${caseIndex.toString().padStart(3, '0')}-ordinal-${ordinal
    .toString()
    .padStart(3, '0')}-${tieBreaker}-${identityIndex.toString().padStart(2, '0')}`;
}

function generateSnapshotCase(
  random: SeededRandom,
  caseIndex: number,
): GeneratedSnapshotCase {
  const mode: RoomMode = caseIndex % 2 === 0 ? 'quick' : 'custom';
  const policy = ROOM_POLICIES[mode];
  const modeCaseIndex = Math.floor(caseIndex / 2);
  const occupancy = modeCaseIndex % (policy.totalCapacity + 1);
  const ordinalBase = random.integer(0, 50);
  const teamOffset = random.boolean() ? 0 : 1;
  const hostIdentityIndex = mode === 'custom' && occupancy > 0
    ? random.integer(0, occupancy - 1)
    : -1;

  const identities = Array.from({ length: occupancy }, (_, identityIndex): GeneratedIdentity => {
    const acceptedJoinOrdinal = ordinalBase + Math.floor(identityIndex / 2);
    const team: Team = (identityIndex + teamOffset) % 2 === 0 ? 'blue' : 'orange';
    const sessionId = makeSessionId(caseIndex, acceptedJoinOrdinal, identityIndex);
    return Object.freeze({
      rosterEntry: Object.freeze({
        sessionId,
        acceptedJoinOrdinal,
        team,
        name: `Driver ${caseIndex}-${identityIndex}-${random.integer(0, 9_999)}`,
        isHost: identityIndex === hostIdentityIndex,
      }),
      body: generateCarBody(random),
    });
  });

  const roster = Object.freeze(identities.map(({ rosterEntry }) => rosterEntry));
  const rosterInsertion = Object.freeze(shuffle(roster, random));
  const carInsertion = Object.freeze(shuffle(
    identities.map(({ rosterEntry, body }) => (
      Object.freeze([rosterEntry.sessionId, body] as const)
    )),
    random,
  ));

  const removableIdentities = mode === 'custom' && occupancy > 1
    ? identities.filter(({ rosterEntry }) => !rosterEntry.isHost)
    : identities;
  const disconnectSessionId = occupancy === 0
    ? null
    : random.pick(removableIdentities).rosterEntry.sessionId;

  const probeTeam: Team = random.boolean() ? 'blue' : 'orange';
  const emptyDisconnectProbe = Object.freeze({
    rosterEntry: Object.freeze({
      sessionId: `p7-${caseIndex.toString().padStart(3, '0')}-empty-disconnect-probe`,
      acceptedJoinOrdinal: ordinalBase + policy.totalCapacity + 1,
      team: probeTeam,
      name: `Probe ${caseIndex}`,
      isHost: mode === 'custom',
    }),
    body: generateCarBody(random),
  });

  return Object.freeze({
    caseIndex,
    mode,
    occupancy,
    roster,
    rosterInsertion,
    carInsertion,
    ball: generateBallBody(random),
    disconnectSessionId,
    emptyDisconnectProbe,
    serverTime: 100_000 + caseIndex * 100 + random.integer(0, 30),
    simulationTime: 10_000 + caseIndex * 50 + random.integer(0, 15),
    playingRegulationSecondsRemaining: randomBounded(
      random,
      SNAPSHOT_FIELD_BOUNDS.regulationSeconds.min,
      SNAPSHOT_FIELD_BOUNDS.regulationSeconds.max,
    ),
    playingKickoffEpoch: random.integer(0, 1_000),
    playingBlueScore: random.integer(0, 5),
    playingOrangeScore: random.integer(0, 5),
    initialSnapshotSequence: random.integer(0, 1_000),
    terminalSnapshotSequence: random.integer(0, 1_000),
    initialTransitionSequence: random.integer(0, 1_000),
    terminal: generateTerminalCase(random, caseIndex),
  });
}

function compareStableRosterOrder(
  left: Readonly<RosterEntry>,
  right: Readonly<RosterEntry>,
): number {
  const ordinalDifference = left.acceptedJoinOrdinal - right.acceptedJoinOrdinal;
  if (ordinalDifference !== 0) return ordinalDifference;
  if (left.sessionId === right.sessionId) return 0;
  return left.sessionId < right.sessionId ? -1 : 1;
}

function makePlayingInput(
  generated: GeneratedSnapshotCase,
  roster: readonly Readonly<RosterEntry>[],
  carEntries: readonly CarMapEntry[],
  timeStep: number,
): SnapshotBuildInput {
  return {
    serverTime: generated.serverTime + timeStep * 33,
    simulationTime: generated.simulationTime + timeStep * 16,
    phase: 'playing',
    countdownKind: null,
    phaseSecondsRemaining: 0,
    regulationSecondsRemaining: generated.playingRegulationSecondsRemaining,
    kickoffEpoch: generated.playingKickoffEpoch,
    blueScore: generated.playingBlueScore,
    orangeScore: generated.playingOrangeScore,
    winner: null,
    roster,
    cars: new Map<string, Readonly<SnapshotCarBodyInput>>(carEntries),
    ball: generated.ball,
  };
}

function makeTerminalInput(
  generated: GeneratedSnapshotCase,
  roster: readonly Readonly<RosterEntry>[],
  carEntries: readonly CarMapEntry[],
  timeStep: number,
): SnapshotBuildInput {
  return {
    serverTime: generated.serverTime + 10_000 + timeStep * 33,
    simulationTime: generated.simulationTime + 10_000 + timeStep * 16,
    phase: 'ended',
    countdownKind: null,
    phaseSecondsRemaining: 0,
    regulationSecondsRemaining: generated.terminal.regulationSecondsRemaining,
    kickoffEpoch: generated.terminal.kickoffEpoch,
    blueScore: generated.terminal.blueScore,
    orangeScore: generated.terminal.orangeScore,
    winner: generated.terminal.winner,
    roster,
    cars: new Map<string, Readonly<SnapshotCarBodyInput>>(carEntries),
    ball: generated.ball,
  };
}

function roundTrip(
  snapshot: Readonly<SnapshotEnvelopeV2>,
): Readonly<SnapshotEnvelopeV2> {
  const serialized = serializeSnapshotEnvelopeV2(snapshot);
  const decoded = deserializeSnapshotEnvelopeV2(serialized);
  assert.deepEqual(decoded, snapshot);
  assert.equal(serializeSnapshotEnvelopeV2(decoded), serialized);
  return decoded;
}

function assertAllNumbersFinite(value: unknown): void {
  if (typeof value === 'number') {
    assert.equal(Number.isFinite(value), true, `expected finite number, received ${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) assertAllNumbersFinite(child);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) assertAllNumbersFinite(child);
  }
}

function magnitude(vector: readonly [number, number, number]): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function assertPositionBounds(
  position: readonly [number, number, number],
  label: string,
): void {
  for (let component = 0; component < position.length; component += 1) {
    assert.ok(
      position[component]! >= SNAPSHOT_FIELD_BOUNDS.position.min[component]!
        - VECTOR_TOLERANCE,
      `${label}[${component}] fell below its arena bound`,
    );
    assert.ok(
      position[component]! <= SNAPSHOT_FIELD_BOUNDS.position.max[component]!
        + VECTOR_TOLERANCE,
      `${label}[${component}] exceeded its arena bound`,
    );
  }
}

function assertUnitQuaternion(
  rotation: readonly [number, number, number, number],
  label: string,
): void {
  assert.ok(
    Math.abs(Math.hypot(...rotation) - 1) <= VECTOR_TOLERANCE,
    `${label} must remain a unit quaternion`,
  );
}

function assertFiniteBounds(snapshot: Readonly<SnapshotEnvelopeV2>): void {
  assertAllNumbersFinite(snapshot);
  assert.ok(Number.isSafeInteger(snapshot.sequence) && snapshot.sequence >= 0);
  assert.ok(snapshot.serverTime >= 0);
  assert.ok(snapshot.simulationTime >= 0);
  assert.ok(snapshot.phaseSecondsRemaining >= 0);
  assert.ok(
    snapshot.regulationSecondsRemaining >= SNAPSHOT_FIELD_BOUNDS.regulationSeconds.min,
  );
  assert.ok(
    snapshot.regulationSecondsRemaining <= SNAPSHOT_FIELD_BOUNDS.regulationSeconds.max,
  );

  for (const car of snapshot.cars) {
    assertPositionBounds(car.position, `car ${car.sessionId} position`);
    assertUnitQuaternion(car.rotation, `car ${car.sessionId} rotation`);
    assert.ok(
      magnitude(car.linearVelocity)
        <= SNAPSHOT_FIELD_BOUNDS.carLinearSpeed + VECTOR_TOLERANCE,
    );
    assert.ok(car.boost >= SNAPSHOT_FIELD_BOUNDS.boost.min);
    assert.ok(car.boost <= SNAPSHOT_FIELD_BOUNDS.boost.max);
  }

  assertPositionBounds(snapshot.ball.position, 'ball position');
  assertUnitQuaternion(snapshot.ball.rotation, 'ball rotation');
  assert.ok(
    magnitude(snapshot.ball.linearVelocity)
      <= SNAPSHOT_FIELD_BOUNDS.ballLinearSpeed + VECTOR_TOLERANCE,
  );
}

function assertProjection(
  snapshot: Readonly<SnapshotEnvelopeV2>,
  mode: RoomMode,
  roster: readonly Readonly<RosterEntry>[],
  carEntries: readonly CarMapEntry[],
  expectedBall: Readonly<SnapshotBallBodyInput>,
): void {
  const policy = ROOM_POLICIES[mode];
  const orderedRoster = [...roster].sort(compareStableRosterOrder);
  const bodies = new Map<string, Readonly<SnapshotCarBodyInput>>(carEntries);

  assert.equal(snapshot.roomMode, mode);
  assert.equal(snapshot.policyVersion, policy.version);
  assert.equal(snapshot.totalCapacity, policy.totalCapacity);
  assert.equal(snapshot.teamCapacity, policy.teamCapacity);
  assert.equal(snapshot.cars.length, roster.length);
  assert.equal(new Set(snapshot.cars.map(({ sessionId }) => sessionId)).size, roster.length);
  assert.deepEqual(
    snapshot.cars.map(({ sessionId }) => sessionId),
    orderedRoster.map(({ sessionId }) => sessionId),
  );

  let blueCount = 0;
  let orangeCount = 0;
  let hostCount = 0;
  for (let index = 0; index < orderedRoster.length; index += 1) {
    const rosterEntry = orderedRoster[index]!;
    const body = bodies.get(rosterEntry.sessionId);
    const car = snapshot.cars[index];
    assert.ok(body, `missing expected body for ${rosterEntry.sessionId}`);
    assert.ok(car, `missing projected car for ${rosterEntry.sessionId}`);
    assert.deepEqual(car, {
      sessionId: rosterEntry.sessionId,
      team: rosterEntry.team,
      name: rosterEntry.name,
      isHost: rosterEntry.isHost,
      position: body.position,
      rotation: body.rotation,
      linearVelocity: body.linearVelocity,
      boost: body.boost,
    });

    if (rosterEntry.team === 'blue') blueCount += 1;
    else orangeCount += 1;
    if (rosterEntry.isHost) hostCount += 1;
  }

  assert.ok(blueCount <= policy.teamCapacity);
  assert.ok(orangeCount <= policy.teamCapacity);
  assert.equal(
    hostCount,
    mode === 'custom' && roster.length > 0 ? 1 : 0,
    `${mode} Host policy must be exact`,
  );
  assert.deepEqual(snapshot.ball, expectedBall);
  assertFiniteBounds(snapshot);
}

function assertDisconnect(
  generated: GeneratedSnapshotCase,
  builder: SnapshotBuilder,
  baseline: Readonly<SnapshotEnvelopeV2>,
): void {
  if (generated.disconnectSessionId === null) {
    assert.equal(generated.occupancy, 0);
    const probe = generated.emptyDisconnectProbe;
    const probeRoster = Object.freeze([probe.rosterEntry]);
    const probeCars = Object.freeze([
      Object.freeze([probe.rosterEntry.sessionId, probe.body] as const),
    ]);
    const connected = roundTrip(builder.build(
      makePlayingInput(generated, probeRoster, probeCars, 1),
    ));
    assert.equal(connected.sequence, baseline.sequence + 1);
    assertProjection(connected, generated.mode, probeRoster, probeCars, generated.ball);

    const disconnected = roundTrip(builder.build(
      makePlayingInput(generated, Object.freeze([]), Object.freeze([]), 2),
    ));
    assert.equal(disconnected.sequence, connected.sequence + 1);
    assert.equal(
      disconnected.cars.some(({ sessionId }) => sessionId === probe.rosterEntry.sessionId),
      false,
    );
    assertProjection(
      disconnected,
      generated.mode,
      Object.freeze([]),
      Object.freeze([]),
      generated.ball,
    );
    return;
  }

  const retainedRoster = Object.freeze(generated.rosterInsertion.filter(
    ({ sessionId }) => sessionId !== generated.disconnectSessionId,
  ));
  const retainedCars = Object.freeze(generated.carInsertion.filter(
    ([sessionId]) => sessionId !== generated.disconnectSessionId,
  ));
  const disconnected = roundTrip(builder.build(
    makePlayingInput(generated, retainedRoster, retainedCars, 1),
  ));

  assert.equal(disconnected.sequence, baseline.sequence + 1);
  assert.equal(
    disconnected.cars.some(({ sessionId }) => sessionId === generated.disconnectSessionId),
    false,
  );
  assert.deepEqual(
    disconnected.cars,
    baseline.cars.filter(({ sessionId }) => sessionId !== generated.disconnectSessionId),
    'disconnect must not disturb any retained identity-associated fields',
  );
  assertProjection(
    disconnected,
    generated.mode,
    retainedRoster,
    retainedCars,
    generated.ball,
  );
}

function commitTerminalTransition(
  builder: SnapshotBuilder,
  terminal: GeneratedTerminalCase,
): number {
  if (terminal.variant === 'hard-cutoff') {
    return builder.commitTransition({
      kind: 'hard-cutoff',
      winner: terminal.winner,
      blueScore: terminal.blueScore,
      orangeScore: terminal.orangeScore,
    }).eventId;
  }

  const goal = Object.freeze({
    team: terminal.winner,
    kickoffEpoch: terminal.kickoffEpoch,
    blueScore: terminal.blueScore,
    orangeScore: terminal.orangeScore,
  });
  return builder.commitTransition({
    kind: terminal.variant === 'target-and-margin'
      ? 'regulation-terminal-goal'
      : 'overtime-terminal-goal',
    goal,
  }).eventId;
}

function assertTerminalStability(generated: GeneratedSnapshotCase): void {
  const builder = new SnapshotBuilder({
    policy: ROOM_POLICIES[generated.mode],
    initialSnapshotSequence: generated.terminalSnapshotSequence,
    initialTransitionSequence: generated.initialTransitionSequence,
  });
  const eventId = commitTerminalTransition(builder, generated.terminal);
  const committedTransition = builder.latestTransition;
  assert.equal(eventId, generated.initialTransitionSequence + 1);
  assert.equal(builder.transitionSequence, eventId);

  const first = roundTrip(builder.build(makeTerminalInput(
    generated,
    generated.rosterInsertion,
    generated.carInsertion,
    0,
  )));
  const second = roundTrip(builder.build(makeTerminalInput(
    generated,
    Object.freeze([...generated.rosterInsertion].reverse()),
    Object.freeze([...generated.carInsertion].reverse()),
    1,
  )));

  assert.equal(first.sequence, generated.terminalSnapshotSequence);
  assert.equal(second.sequence, first.sequence + 1);
  assert.ok(second.serverTime > first.serverTime);
  assert.ok(second.simulationTime > first.simulationTime);
  assert.equal(builder.nextSnapshotSequence, second.sequence + 1);
  assert.equal(builder.transitionSequence, eventId);
  assert.strictEqual(builder.latestTransition, committedTransition);

  for (const snapshot of [first, second]) {
    assertProjection(
      snapshot,
      generated.mode,
      generated.roster,
      generated.carInsertion,
      generated.ball,
    );
    assert.equal(snapshot.phase, 'ended');
    assert.equal(snapshot.blueScore, generated.terminal.blueScore);
    assert.equal(snapshot.orangeScore, generated.terminal.orangeScore);
    assert.equal(snapshot.winner, generated.terminal.winner);
    assert.equal(snapshot.regulationSecondsRemaining, generated.terminal.regulationSecondsRemaining);
    assert.equal(snapshot.terminalResult?.reason, generated.terminal.reason);
    assert.equal(snapshot.latestTransition?.kind, generated.terminal.transitionKind);
    assert.equal(snapshot.latestTransition?.eventId, eventId);
    assert.equal(snapshot.latestTransition?.terminal?.eventId, eventId);
    assert.equal(snapshot.terminalResult?.eventId, eventId);
    assert.deepEqual(snapshot.latestTransition?.terminal, snapshot.terminalResult);
    assert.deepEqual(snapshot.latestTransition?.goal, snapshot.terminalResult?.goal);

    if (generated.terminal.variant === 'hard-cutoff') {
      assert.equal(snapshot.latestTransition?.goal, null);
      assert.equal(snapshot.terminalResult?.goal, null);
    } else {
      assert.equal(snapshot.latestTransition?.goal?.eventId, eventId);
      assert.equal(snapshot.terminalResult?.goal?.eventId, eventId);
      assert.equal(snapshot.latestTransition?.goal?.team, generated.terminal.winner);
      assert.equal(
        snapshot.latestTransition?.goal?.kickoffEpoch,
        generated.terminal.kickoffEpoch,
      );
    }
  }

  assert.deepEqual(second.cars, first.cars);
  assert.deepEqual(second.ball, first.ball);
  assert.equal(second.blueScore, first.blueScore);
  assert.equal(second.orangeScore, first.orangeScore);
  assert.equal(second.winner, first.winner);
  assert.deepEqual(second.terminalResult, first.terminalResult);
  assert.deepEqual(second.latestTransition, first.latestTransition);
  assert.doesNotThrow(() => assertStableTerminalSnapshots(first, second));
}

function assertGeneratedCoverage(
  generatedCases: readonly GeneratedCase<GeneratedSnapshotCase>[],
): void {
  const modeCounts: Record<RoomMode, number> = { quick: 0, custom: 0 };
  const terminalCounts: Record<TerminalVariant, number> = {
    'target-and-margin': 0,
    'hard-cutoff': 0,
    'overtime-goal': 0,
  };
  const modeTerminalCounts: Record<RoomMode, Record<TerminalVariant, number>> = {
    quick: { 'target-and-margin': 0, 'hard-cutoff': 0, 'overtime-goal': 0 },
    custom: { 'target-and-margin': 0, 'hard-cutoff': 0, 'overtime-goal': 0 },
  };
  const occupancies: Record<RoomMode, Set<number>> = {
    quick: new Set<number>(),
    custom: new Set<number>(),
  };

  for (const { value } of generatedCases) {
    modeCounts[value.mode] += 1;
    terminalCounts[value.terminal.variant] += 1;
    modeTerminalCounts[value.mode][value.terminal.variant] += 1;
    occupancies[value.mode].add(value.occupancy);
  }

  assert.deepEqual(modeCounts, { quick: 63, custom: 63 });
  assert.deepEqual(terminalCounts, {
    'target-and-margin': 42,
    'hard-cutoff': 42,
    'overtime-goal': 42,
  });
  assert.deepEqual(modeTerminalCounts, {
    quick: { 'target-and-margin': 21, 'hard-cutoff': 21, 'overtime-goal': 21 },
    custom: { 'target-and-margin': 21, 'hard-cutoff': 21, 'overtime-goal': 21 },
  });

  for (const mode of ['quick', 'custom'] as const) {
    assert.deepEqual(
      [...occupancies[mode]].sort((left, right) => left - right),
      Array.from({ length: ROOM_POLICIES[mode].totalCapacity + 1 }, (_, count) => count),
      `${mode} generation must cover every legal occupancy`,
    );
  }
}

/**
 * Feature: rocket-arena, Property 7: Snapshot round trip and identity completeness
 * **Validates: Requirements 6.1-6.8, 13.14, 13.19, 13.25, 18.17, 18.25**
 */
test(
  `Property 7: snapshot round trip and identity completeness (seed=${RECORDED_SEED}, cases=${GENERATED_CASE_COUNT})`,
  () => {
    const generatedCases = generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateSnapshotCase,
    });

    assert.equal(generatedCases.length, GENERATED_CASE_COUNT);
    assert.deepEqual(generatedCases, generateCases({
      seed: RECORDED_SEED,
      count: GENERATED_CASE_COUNT,
      generate: generateSnapshotCase,
    }));
    assert.deepEqual(
      replayCase(RECORDED_SEED, REPLAY_CASE_INDEX, generateSnapshotCase),
      generatedCases[REPLAY_CASE_INDEX],
    );
    assertGeneratedCoverage(generatedCases);

    assertGeneratedCases(generatedCases, (generated, generatedCase) => {
      assert.equal(generatedCase.seed, RECORDED_SEED);
      assert.equal(generatedCase.index, generated.caseIndex);
      const generatedBefore = structuredClone(generated);
      const policy = ROOM_POLICIES[generated.mode];

      assert.equal(generated.roster.length, generated.occupancy);
      assert.ok(generated.occupancy >= 0);
      assert.ok(generated.occupancy <= policy.totalCapacity);
      assert.equal(
        generated.roster.filter(({ isHost }) => isHost).length,
        generated.mode === 'custom' && generated.occupancy > 0 ? 1 : 0,
      );
      assert.ok(generated.roster.every(({ acceptedJoinOrdinal }) => (
        Number.isSafeInteger(acceptedJoinOrdinal) && acceptedJoinOrdinal >= 0
      )));

      const builder = new SnapshotBuilder({
        policy,
        initialSnapshotSequence: generated.initialSnapshotSequence,
      });
      const baseline = roundTrip(builder.build(makePlayingInput(
        generated,
        generated.rosterInsertion,
        generated.carInsertion,
        0,
      )));
      assert.equal(baseline.sequence, generated.initialSnapshotSequence);
      assert.equal(baseline.latestTransition, null);
      assertProjection(
        baseline,
        generated.mode,
        generated.roster,
        generated.carInsertion,
        generated.ball,
      );

      const deterministicBuilder = new SnapshotBuilder({
        policy,
        initialSnapshotSequence: generated.initialSnapshotSequence,
      });
      const deterministicRepeat = roundTrip(deterministicBuilder.build(makePlayingInput(
        generated,
        Object.freeze([...generated.rosterInsertion].reverse()),
        Object.freeze([...generated.carInsertion].reverse()),
        0,
      )));
      assert.deepEqual(deterministicRepeat, baseline);
      assert.equal(
        serializeSnapshotEnvelopeV2(deterministicRepeat),
        serializeSnapshotEnvelopeV2(baseline),
      );

      assertDisconnect(generated, builder, baseline);
      assertTerminalStability(generated);
      assert.deepEqual(generated, generatedBefore, 'property execution must not mutate generated data');
    });
  },
);
