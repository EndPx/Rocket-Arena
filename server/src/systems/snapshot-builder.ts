import {
  ARENA_CEILING_HEIGHT_METERS,
  ARENA_HALF_LENGTH_METERS,
  ARENA_HALF_WIDTH_METERS,
  COUNTDOWN_KINDS,
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  GOAL_DEPTH_METERS,
  MATCH_PHASES,
  MATCH_RULES,
  SNAPSHOT_PROTOCOL_VERSION,
  TEAMS,
  TUNING_IDS,
  createGoalResult,
  createSnapshotEnvelopeV2,
  createTerminalResult,
  getScalarTuningValue,
  validateRoomPolicy,
  type BallSnapshot,
  type CarSnapshot,
  type CountdownKind,
  type GoalResult,
  type MatchPhase,
  type MatchTransitionSnapshot,
  type QuaternionTuple,
  type RoomPolicy,
  type RosterEntry,
  type SnapshotEnvelopeV2,
  type Team,
  type TerminalResult,
  type Vector3Tuple,
} from '@rocket-arena/shared';

const MAX_SAFE_SEQUENCE = Number.MAX_SAFE_INTEGER;
const CAR_LINEAR_SPEED_LIMIT = 23.05;
const BALL_LINEAR_SPEED_LIMIT = 60.05;
const MAX_GOAL_RESET_SECONDS = 5;
const BALL_FALLBACK_HEIGHT = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.ball.radius,
);

export const SNAPSHOT_FIELD_BOUNDS = Object.freeze({
  position: Object.freeze({
    min: Object.freeze([
      -ARENA_HALF_WIDTH_METERS,
      0,
      -(ARENA_HALF_LENGTH_METERS + GOAL_DEPTH_METERS),
    ] as const),
    max: Object.freeze([
      ARENA_HALF_WIDTH_METERS,
      ARENA_CEILING_HEIGHT_METERS,
      ARENA_HALF_LENGTH_METERS + GOAL_DEPTH_METERS,
    ] as const),
  }),
  carLinearSpeed: CAR_LINEAR_SPEED_LIMIT,
  ballLinearSpeed: BALL_LINEAR_SPEED_LIMIT,
  boost: Object.freeze({ min: 0, max: 100 }),
  regulationSeconds: Object.freeze({
    min: 0,
    max: MATCH_RULES.regulationDurationSeconds,
  }),
  kickoffCountdownSeconds: MATCH_RULES.kickoffCountdownSeconds,
  goalResetSeconds: MAX_GOAL_RESET_SECONDS,
} as const);

export type SnapshotBuildErrorCode =
  | 'policy-mismatch'
  | 'invalid-roster'
  | 'count-mismatch'
  | 'identity-mismatch'
  | 'invalid-match-state'
  | 'invalid-transition'
  | 'transition-after-terminal'
  | 'sequence-exhausted';

export class SnapshotBuildError extends Error {
  readonly code: SnapshotBuildErrorCode;
  readonly cause: unknown;

  constructor(code: SnapshotBuildErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'SnapshotBuildError';
    this.code = code;
    this.cause = cause;
  }
}

export interface SnapshotCarBodyInput {
  readonly position: Vector3Tuple;
  readonly rotation: QuaternionTuple;
  readonly linearVelocity: Vector3Tuple;
  readonly boost: number;
}

export interface SnapshotBallBodyInput {
  readonly position: Vector3Tuple;
  readonly rotation: QuaternionTuple;
  readonly linearVelocity: Vector3Tuple;
}

export interface SnapshotBuildInput {
  readonly serverTime: number;
  readonly simulationTime: number;
  readonly phase: MatchPhase;
  readonly countdownKind: CountdownKind | null;
  readonly phaseSecondsRemaining: number;
  readonly regulationSecondsRemaining: number;
  readonly kickoffEpoch: number;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly winner: Team | null;
  readonly roster: readonly Readonly<RosterEntry>[];
  readonly cars: ReadonlyMap<string, Readonly<SnapshotCarBodyInput>>;
  readonly ball: Readonly<SnapshotBallBodyInput>;
}

export interface SnapshotGoalTransitionInput {
  readonly team: Team;
  readonly kickoffEpoch: number;
  readonly blueScore: number;
  readonly orangeScore: number;
}

export type SnapshotTransitionInput =
  | Readonly<{ readonly kind: 'countdown' }>
  | Readonly<{
    readonly kind: 'regulation-goal-reset';
    readonly goal: SnapshotGoalTransitionInput;
  }>
  | Readonly<{
    readonly kind: 'regulation-terminal-goal';
    readonly goal: SnapshotGoalTransitionInput;
  }>
  | Readonly<{
    readonly kind: 'hard-cutoff';
    readonly winner: Team;
    readonly blueScore: number;
    readonly orangeScore: number;
    readonly goal?: SnapshotGoalTransitionInput | null;
  }>
  | Readonly<{
    readonly kind: 'overtime-entry';
    readonly goal?: SnapshotGoalTransitionInput | null;
  }>
  | Readonly<{
    readonly kind: 'overtime-terminal-goal';
    readonly goal: SnapshotGoalTransitionInput;
  }>;

export interface SnapshotBuilderOptions {
  readonly policy: unknown;
  /** Sequence assigned to the first successfully produced snapshot. */
  readonly initialSnapshotSequence?: number;
  /** Last committed transition ID; the first new event receives this value plus one. */
  readonly initialTransitionSequence?: number;
}

interface RecoveredCarState extends SnapshotCarBodyInput {}
interface RecoveredBallState extends SnapshotBallBodyInput {}

interface RecoveredScalarState {
  readonly serverTime: number;
  readonly simulationTime: number;
  readonly phaseSecondsRemaining: number;
  readonly regulationSecondsRemaining: number;
}

interface ValidatedBuildState {
  readonly phase: MatchPhase;
  readonly countdownKind: CountdownKind | null;
  readonly kickoffEpoch: number;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly winner: Team | null;
}

function fail(code: SnapshotBuildErrorCode, message: string, cause?: unknown): never {
  throw new SnapshotBuildError(code, message, cause);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function requireSafeNonNegativeInteger(value: unknown, field: string): number {
  if (!isSafeNonNegativeInteger(value)) {
    fail('invalid-match-state', `${field} must be a non-negative safe integer.`);
  }
  return value;
}

function requireInitialSequence(value: unknown, field: string): number {
  const sequence = requireSafeNonNegativeInteger(value, field);
  if (sequence >= MAX_SAFE_SEQUENCE) {
    fail('sequence-exhausted', `${field} does not leave room for a later sequence.`);
  }
  return sequence;
}

function isTeam(value: unknown): value is Team {
  return TEAMS.some((team) => team === value);
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function recoverScalar(
  value: unknown,
  previous: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = typeof value === 'number' && Number.isFinite(value)
    ? value
    : previous ?? fallback;
  return clamp(candidate, minimum, maximum);
}

function recoverMonotonicScalar(
  value: unknown,
  previous: number | undefined,
): number {
  const recovered = recoverScalar(value, previous, 0, 0, Number.MAX_SAFE_INTEGER);
  return previous === undefined ? recovered : Math.max(previous, recovered);
}

function sourceTuple(value: unknown, length: number): readonly unknown[] | null {
  return Array.isArray(value) && value.length === length ? value : null;
}

function recoverVector3(
  value: unknown,
  previous: Vector3Tuple | undefined,
  fallback: Vector3Tuple,
  minimum: Vector3Tuple,
  maximum: Vector3Tuple,
): Vector3Tuple {
  const source = sourceTuple(value, 3);
  return Object.freeze([
    recoverScalar(source?.[0], previous?.[0], fallback[0], minimum[0], maximum[0]),
    recoverScalar(source?.[1], previous?.[1], fallback[1], minimum[1], maximum[1]),
    recoverScalar(source?.[2], previous?.[2], fallback[2], minimum[2], maximum[2]),
  ] as const);
}

function capVectorMagnitude(value: Vector3Tuple, maximumMagnitude: number): Vector3Tuple {
  const magnitude = Math.hypot(value[0], value[1], value[2]);
  if (magnitude <= maximumMagnitude || magnitude === 0) return value;
  const scale = maximumMagnitude / magnitude;
  return Object.freeze([
    value[0] * scale,
    value[1] * scale,
    value[2] * scale,
  ] as const);
}

function recoverVelocity(
  value: unknown,
  previous: Vector3Tuple | undefined,
  maximumMagnitude: number,
): Vector3Tuple {
  const componentBounds = Object.freeze([
    maximumMagnitude,
    maximumMagnitude,
    maximumMagnitude,
  ] as const);
  const minimum = Object.freeze(componentBounds.map((component) => -component) as [
    number,
    number,
    number,
  ]);
  return capVectorMagnitude(
    recoverVector3(value, previous, ZERO_VECTOR, minimum, componentBounds),
    maximumMagnitude,
  );
}

function recoverQuaternion(
  value: unknown,
  previous: QuaternionTuple | undefined,
): QuaternionTuple {
  const source = sourceTuple(value, 4);
  let components: [number, number, number, number] = [
    recoverScalar(source?.[0], previous?.[0], 0, -Number.MAX_VALUE, Number.MAX_VALUE),
    recoverScalar(source?.[1], previous?.[1], 0, -Number.MAX_VALUE, Number.MAX_VALUE),
    recoverScalar(source?.[2], previous?.[2], 0, -Number.MAX_VALUE, Number.MAX_VALUE),
    recoverScalar(source?.[3], previous?.[3], 1, -Number.MAX_VALUE, Number.MAX_VALUE),
  ];
  let magnitude = Math.hypot(...components);
  if (!Number.isFinite(magnitude) || magnitude <= Number.EPSILON) {
    components = previous === undefined ? [0, 0, 0, 1] : [...previous];
    magnitude = Math.hypot(...components);
  }
  if (!Number.isFinite(magnitude) || magnitude <= Number.EPSILON) {
    components = [0, 0, 0, 1];
    magnitude = 1;
  }
  return Object.freeze(components.map((component) => component / magnitude) as [
    number,
    number,
    number,
    number,
  ]);
}

const ZERO_VECTOR = Object.freeze([0, 0, 0] as const);
const IDENTITY_ROTATION = Object.freeze([0, 0, 0, 1] as const);
const BALL_FALLBACK_POSITION = Object.freeze([0, BALL_FALLBACK_HEIGHT, 0] as const);

function freezeRosterEntry(entry: Readonly<RosterEntry>): Readonly<RosterEntry> {
  return Object.freeze({
    sessionId: entry.sessionId,
    acceptedJoinOrdinal: entry.acceptedJoinOrdinal,
    team: entry.team,
    name: entry.name,
    isHost: entry.isHost,
  });
}

function validateRosterAndCars(
  policy: RoomPolicy,
  rosterInput: readonly Readonly<RosterEntry>[],
  cars: ReadonlyMap<string, Readonly<SnapshotCarBodyInput>>,
): readonly Readonly<RosterEntry>[] {
  if (!Array.isArray(rosterInput)) {
    fail('invalid-roster', 'Snapshot roster must be an array.');
  }
  if (
    typeof cars !== 'object'
    || cars === null
    || typeof cars.size !== 'number'
    || typeof cars.get !== 'function'
    || typeof cars.keys !== 'function'
  ) {
    fail('count-mismatch', 'Snapshot cars must be a readable identity map.');
  }
  if (rosterInput.length > policy.totalCapacity || rosterInput.length > 8) {
    fail('count-mismatch', 'Snapshot roster exceeds the selected room capacity.');
  }
  if (cars.size !== rosterInput.length) {
    fail(
      'count-mismatch',
      `Snapshot car count ${cars.size} does not match roster count ${rosterInput.length}.`,
    );
  }

  const seen = new Set<string>();
  const roster: Readonly<RosterEntry>[] = [];
  let blueCount = 0;
  let orangeCount = 0;
  let hostCount = 0;

  for (const rawEntry of rosterInput) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      fail('invalid-roster', 'Snapshot roster entries must be objects.');
    }
    if (typeof rawEntry.sessionId !== 'string' || rawEntry.sessionId.length === 0) {
      fail('invalid-roster', 'Snapshot roster identities must be non-empty strings.');
    }
    if (seen.has(rawEntry.sessionId)) {
      fail('identity-mismatch', `Duplicate roster identity ${rawEntry.sessionId}.`);
    }
    if (!isSafeNonNegativeInteger(rawEntry.acceptedJoinOrdinal)) {
      fail('invalid-roster', `Roster ordinal for ${rawEntry.sessionId} is invalid.`);
    }
    if (!isTeam(rawEntry.team)) {
      fail('invalid-roster', `Roster team for ${rawEntry.sessionId} is invalid.`);
    }
    if (typeof rawEntry.name !== 'string' || typeof rawEntry.isHost !== 'boolean') {
      fail('invalid-roster', `Roster metadata for ${rawEntry.sessionId} is malformed.`);
    }
    if (!cars.has(rawEntry.sessionId)) {
      fail('identity-mismatch', `Roster identity ${rawEntry.sessionId} has no authoritative car.`);
    }

    seen.add(rawEntry.sessionId);
    roster.push(freezeRosterEntry(rawEntry));
    if (rawEntry.team === 'blue') blueCount += 1;
    else orangeCount += 1;
    if (rawEntry.isHost) hostCount += 1;
  }

  for (const sessionId of cars.keys()) {
    if (typeof sessionId !== 'string' || !seen.has(sessionId)) {
      fail('identity-mismatch', `Authoritative car ${String(sessionId)} has no roster identity.`);
    }
    const body = cars.get(sessionId);
    if (typeof body !== 'object' || body === null) {
      fail('identity-mismatch', `Authoritative car ${sessionId} has no readable body projection.`);
    }
  }

  if (blueCount > policy.teamCapacity || orangeCount > policy.teamCapacity) {
    fail('count-mismatch', 'Snapshot team occupancy exceeds the selected room policy.');
  }
  if (policy.mode === 'quick' && hostCount !== 0) {
    fail('invalid-roster', 'Quick Match cannot serialize Host metadata.');
  }
  if (policy.mode === 'custom' && roster.length > 0 && hostCount !== 1) {
    fail('invalid-roster', 'A non-empty Custom Room must serialize exactly one Host.');
  }
  if (hostCount > 1) {
    fail('invalid-roster', 'At most one roster identity may be Host.');
  }

  return Object.freeze([...roster].sort(compareStableRosterOrder));
}

function validateBuildState(input: SnapshotBuildInput): ValidatedBuildState {
  if (!MATCH_PHASES.some((phase) => phase === input.phase)) {
    fail('invalid-match-state', `Unsupported match phase ${String(input.phase)}.`);
  }
  if (
    input.countdownKind !== null
    && !COUNTDOWN_KINDS.some((kind) => kind === input.countdownKind)
  ) {
    fail('invalid-match-state', `Unsupported countdown kind ${String(input.countdownKind)}.`);
  }
  if ((input.phase === 'countdown') !== (input.countdownKind !== null)) {
    fail('invalid-match-state', 'Countdown kind must be present exactly during countdown phase.');
  }
  if (input.winner !== null && !isTeam(input.winner)) {
    fail('invalid-match-state', `Unsupported winner ${String(input.winner)}.`);
  }

  return Object.freeze({
    phase: input.phase,
    countdownKind: input.countdownKind,
    kickoffEpoch: requireSafeNonNegativeInteger(input.kickoffEpoch, 'kickoffEpoch'),
    blueScore: requireSafeNonNegativeInteger(input.blueScore, 'blueScore'),
    orangeScore: requireSafeNonNegativeInteger(input.orangeScore, 'orangeScore'),
    winner: input.winner,
  });
}

function recoverCar(
  body: Readonly<SnapshotCarBodyInput>,
  previous: RecoveredCarState | undefined,
): Readonly<RecoveredCarState> {
  const position = recoverVector3(
    body.position,
    previous?.position,
    ZERO_VECTOR,
    SNAPSHOT_FIELD_BOUNDS.position.min,
    SNAPSHOT_FIELD_BOUNDS.position.max,
  );
  const rotation = recoverQuaternion(body.rotation, previous?.rotation ?? IDENTITY_ROTATION);
  const linearVelocity = recoverVelocity(
    body.linearVelocity,
    previous?.linearVelocity,
    SNAPSHOT_FIELD_BOUNDS.carLinearSpeed,
  );
  const boost = recoverScalar(
    body.boost,
    previous?.boost,
    0,
    SNAPSHOT_FIELD_BOUNDS.boost.min,
    SNAPSHOT_FIELD_BOUNDS.boost.max,
  );
  return Object.freeze({ position, rotation, linearVelocity, boost });
}

function recoverBall(
  body: Readonly<SnapshotBallBodyInput>,
  previous: RecoveredBallState | null,
): Readonly<RecoveredBallState> {
  return Object.freeze({
    position: recoverVector3(
      body.position,
      previous?.position,
      BALL_FALLBACK_POSITION,
      SNAPSHOT_FIELD_BOUNDS.position.min,
      SNAPSHOT_FIELD_BOUNDS.position.max,
    ),
    rotation: recoverQuaternion(body.rotation, previous?.rotation ?? IDENTITY_ROTATION),
    linearVelocity: recoverVelocity(
      body.linearVelocity,
      previous?.linearVelocity,
      SNAPSHOT_FIELD_BOUNDS.ballLinearSpeed,
    ),
  });
}

function phaseSecondsMaximum(phase: MatchPhase): number {
  if (phase === 'countdown') return SNAPSHOT_FIELD_BOUNDS.kickoffCountdownSeconds;
  if (phase === 'goal-reset') return SNAPSHOT_FIELD_BOUNDS.goalResetSeconds;
  return 0;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function goalFromInput(
  eventId: number,
  input: SnapshotGoalTransitionInput,
): Readonly<GoalResult> {
  return createGoalResult({
    eventId,
    team: input.team,
    kickoffEpoch: input.kickoffEpoch,
    blueScore: input.blueScore,
    orangeScore: input.orangeScore,
  });
}

function assertRegulationTerminalGoal(goal: GoalResult): void {
  const winnerScore = goal.team === 'blue' ? goal.blueScore : goal.orangeScore;
  const loserScore = goal.team === 'blue' ? goal.orangeScore : goal.blueScore;
  if (
    winnerScore < MATCH_RULES.Regulation_Goal_Target
    || winnerScore - loserScore < MATCH_RULES.Regulation_Win_Margin
  ) {
    fail(
      'invalid-transition',
      'A regulation terminal goal must satisfy the confirmed target-and-margin rule.',
    );
  }
}

function terminalFingerprint(
  snapshot: Pick<
    SnapshotEnvelopeV2,
    'blueScore' | 'orangeScore' | 'winner' | 'terminalResult' | 'latestTransition'
  >,
): string {
  return JSON.stringify({
    blueScore: snapshot.blueScore,
    orangeScore: snapshot.orangeScore,
    winner: snapshot.winner,
    terminalResult: snapshot.terminalResult,
    latestTransition: snapshot.latestTransition,
  });
}

/**
 * Policy-pinned, room-local V2 snapshot serializer. Snapshot emission and
 * authoritative transition commits use independent sequences: producing
 * another envelope never creates another gameplay event.
 */
export class SnapshotBuilder {
  readonly policy: RoomPolicy;

  private nextSnapshotSequenceValue: number;
  private transitionSequenceValue: number;
  private latestTransitionValue: Readonly<MatchTransitionSnapshot> | null = null;
  private terminalResultValue: Readonly<TerminalResult> | null = null;
  private terminalFingerprintValue: string | null = null;
  private carRecovery = new Map<string, Readonly<RecoveredCarState>>();
  private ballRecovery: Readonly<RecoveredBallState> | null = null;
  private scalarRecovery: RecoveredScalarState | null = null;

  constructor(options: SnapshotBuilderOptions) {
    try {
      this.policy = validateRoomPolicy(options.policy);
    } catch (cause) {
      fail('policy-mismatch', 'SnapshotBuilder requires one canonical immutable room policy.', cause);
    }
    this.nextSnapshotSequenceValue = requireInitialSequence(
      options.initialSnapshotSequence ?? 0,
      'initialSnapshotSequence',
    );
    this.transitionSequenceValue = requireInitialSequence(
      options.initialTransitionSequence ?? 0,
      'initialTransitionSequence',
    );
  }

  get nextSnapshotSequence(): number {
    return this.nextSnapshotSequenceValue;
  }

  get transitionSequence(): number {
    return this.transitionSequenceValue;
  }

  get latestTransition(): Readonly<MatchTransitionSnapshot> | null {
    return this.latestTransitionValue;
  }

  /**
   * Commit exactly one authoritative transition and assign one room-local ID.
   * This is deliberately separate from build(), so cadence-only snapshots
   * cannot regenerate goal, cutoff, overtime, or terminal event identities.
   */
  commitTransition(input: SnapshotTransitionInput): Readonly<MatchTransitionSnapshot> {
    if (this.terminalResultValue !== null) {
      fail(
        'transition-after-terminal',
        'No authoritative transition may be committed after terminal state.',
      );
    }
    if (this.transitionSequenceValue >= MAX_SAFE_SEQUENCE) {
      fail('sequence-exhausted', 'Room-local transition sequence is exhausted.');
    }

    const eventId = this.transitionSequenceValue + 1;
    let goal: Readonly<GoalResult> | null = null;
    let terminal: Readonly<TerminalResult> | null = null;

    try {
      switch (input.kind) {
        case 'countdown':
          break;
        case 'regulation-goal-reset':
          goal = goalFromInput(eventId, input.goal);
          break;
        case 'regulation-terminal-goal':
          goal = goalFromInput(eventId, input.goal);
          assertRegulationTerminalGoal(goal);
          terminal = createTerminalResult({
            eventId,
            reason: 'regulation-target-and-margin',
            winner: goal.team,
            blueScore: goal.blueScore,
            orangeScore: goal.orangeScore,
            goal,
          });
          break;
        case 'hard-cutoff':
          goal = input.goal === null || input.goal === undefined
            ? null
            : goalFromInput(eventId, input.goal);
          terminal = createTerminalResult({
            eventId,
            reason: 'hard-regulation-cutoff',
            winner: input.winner,
            blueScore: input.blueScore,
            orangeScore: input.orangeScore,
            goal,
          });
          break;
        case 'overtime-entry':
          goal = input.goal === null || input.goal === undefined
            ? null
            : goalFromInput(eventId, input.goal);
          break;
        case 'overtime-terminal-goal':
          goal = goalFromInput(eventId, input.goal);
          terminal = createTerminalResult({
            eventId,
            reason: 'overtime-goal',
            winner: goal.team,
            blueScore: goal.blueScore,
            orangeScore: goal.orangeScore,
            goal,
          });
          break;
      }
    } catch (cause) {
      if (cause instanceof SnapshotBuildError) throw cause;
      fail('invalid-transition', 'Authoritative transition payload is incoherent.', cause);
    }

    const transition = Object.freeze({
      eventId,
      kind: input.kind,
      goal,
      terminal,
    } satisfies MatchTransitionSnapshot);

    this.transitionSequenceValue = eventId;
    this.latestTransitionValue = transition;
    if (terminal !== null) this.terminalResultValue = terminal;
    return transition;
  }

  /**
   * Validate and atomically build one deeply immutable V2 envelope. Any error
   * leaves sequences, finite recovery caches, and terminal state unchanged.
   */
  build(input: SnapshotBuildInput): Readonly<SnapshotEnvelopeV2> {
    if (this.nextSnapshotSequenceValue >= MAX_SAFE_SEQUENCE) {
      fail('sequence-exhausted', 'Room-local snapshot sequence is exhausted.');
    }

    const match = validateBuildState(input);
    const orderedRoster = validateRosterAndCars(this.policy, input.roster, input.cars);
    this.assertTransitionAndTerminalCoherence(match, input.regulationSecondsRemaining);

    const nextCars = new Map<string, Readonly<RecoveredCarState>>();
    const cars: Readonly<CarSnapshot>[] = orderedRoster.map((entry) => {
      const body = input.cars.get(entry.sessionId);
      if (body === undefined) {
        fail('identity-mismatch', `Roster identity ${entry.sessionId} lost its car during build.`);
      }
      const recovered = recoverCar(body, this.carRecovery.get(entry.sessionId));
      nextCars.set(entry.sessionId, recovered);
      return Object.freeze({
        sessionId: entry.sessionId,
        team: entry.team,
        name: entry.name,
        isHost: entry.isHost,
        position: recovered.position,
        rotation: recovered.rotation,
        linearVelocity: recovered.linearVelocity,
        boost: recovered.boost,
      });
    });
    const ball = recoverBall(input.ball, this.ballRecovery);

    const previousScalars = this.scalarRecovery;
    const scalars: RecoveredScalarState = Object.freeze({
      serverTime: recoverMonotonicScalar(input.serverTime, previousScalars?.serverTime),
      simulationTime: recoverMonotonicScalar(
        input.simulationTime,
        previousScalars?.simulationTime,
      ),
      phaseSecondsRemaining: recoverScalar(
        input.phaseSecondsRemaining,
        previousScalars?.phaseSecondsRemaining,
        0,
        0,
        phaseSecondsMaximum(match.phase),
      ),
      regulationSecondsRemaining: recoverScalar(
        input.regulationSecondsRemaining,
        previousScalars?.regulationSecondsRemaining,
        0,
        SNAPSHOT_FIELD_BOUNDS.regulationSeconds.min,
        SNAPSHOT_FIELD_BOUNDS.regulationSeconds.max,
      ),
    });

    this.assertRecoveredTerminalTiming(match.phase, scalars.regulationSecondsRemaining);

    let snapshot: Readonly<SnapshotEnvelopeV2>;
    try {
      snapshot = createSnapshotEnvelopeV2({
        protocolVersion: SNAPSHOT_PROTOCOL_VERSION,
        policyVersion: this.policy.version,
        roomMode: this.policy.mode,
        totalCapacity: this.policy.totalCapacity,
        teamCapacity: this.policy.teamCapacity,
        sequence: this.nextSnapshotSequenceValue,
        serverTime: scalars.serverTime,
        simulationTime: scalars.simulationTime,
        phase: match.phase,
        countdownKind: match.countdownKind,
        phaseSecondsRemaining: scalars.phaseSecondsRemaining,
        regulationSecondsRemaining: scalars.regulationSecondsRemaining,
        kickoffEpoch: match.kickoffEpoch,
        blueScore: match.blueScore,
        orangeScore: match.orangeScore,
        winner: match.winner,
        terminalResult: match.phase === 'ended' ? this.terminalResultValue : null,
        latestTransition: this.latestTransitionValue,
        cars,
        ball: Object.freeze({
          position: ball.position,
          rotation: ball.rotation,
          linearVelocity: ball.linearVelocity,
        } satisfies BallSnapshot),
      });
    } catch (cause) {
      if (cause instanceof SnapshotBuildError) throw cause;
      fail('invalid-match-state', 'Snapshot contract validation failed before broadcast.', cause);
    }

    if (snapshot.phase === 'ended') {
      const fingerprint = terminalFingerprint(snapshot);
      if (
        this.terminalFingerprintValue !== null
        && this.terminalFingerprintValue !== fingerprint
      ) {
        fail(
          'invalid-match-state',
          'Ended snapshot score, winner, terminal result, or transition changed.',
        );
      }
      this.terminalFingerprintValue = fingerprint;
    }

    this.carRecovery = nextCars;
    this.ballRecovery = ball;
    this.scalarRecovery = scalars;
    this.nextSnapshotSequenceValue += 1;
    return snapshot;
  }

  private assertTransitionAndTerminalCoherence(
    match: ValidatedBuildState,
    rawRegulationSecondsRemaining: number,
  ): void {
    const transition = this.latestTransitionValue;
    const terminal = this.terminalResultValue;

    if (transition?.goal !== null && transition?.goal !== undefined) {
      if (
        transition.goal.blueScore !== match.blueScore
        || transition.goal.orangeScore !== match.orangeScore
        || transition.goal.kickoffEpoch > match.kickoffEpoch
      ) {
        fail(
          'invalid-match-state',
          'Latest goal score/epoch must agree with the authoritative match projection.',
        );
      }
    }

    if (match.phase !== 'ended') {
      if (match.winner !== null || terminal !== null || transition?.terminal !== null && transition !== null) {
        fail('invalid-match-state', 'Only Ended_State may project terminal match data.');
      }
      return;
    }

    if (match.winner === null || terminal === null || transition?.terminal === null || transition === null) {
      fail(
        'invalid-match-state',
        'Ended_State requires one committed terminal transition and winner.',
      );
    }
    if (
      terminal.eventId !== transition.eventId
      || terminal.winner !== match.winner
      || terminal.blueScore !== match.blueScore
      || terminal.orangeScore !== match.orangeScore
      || !sameValue(transition.terminal, terminal)
    ) {
      fail(
        'invalid-match-state',
        'Final scores, winner, terminal result, and transition/event ID must agree.',
      );
    }

    if (
      terminal.reason === 'hard-regulation-cutoff'
      || terminal.reason === 'overtime-goal'
    ) {
      if (Number.isFinite(rawRegulationSecondsRemaining) && rawRegulationSecondsRemaining !== 0) {
        fail(
          'invalid-match-state',
          `${terminal.reason} requires regulation time to be zero.`,
        );
      }
    } else if (
      Number.isFinite(rawRegulationSecondsRemaining)
      && rawRegulationSecondsRemaining <= 0
    ) {
      fail(
        'invalid-match-state',
        'A target-and-margin regulation terminal goal must occur above zero.',
      );
    }
  }

  private assertRecoveredTerminalTiming(
    phase: MatchPhase,
    regulationSecondsRemaining: number,
  ): void {
    if (phase !== 'ended' || this.terminalResultValue === null) return;
    if (
      this.terminalResultValue.reason === 'regulation-target-and-margin'
      && regulationSecondsRemaining <= 0
    ) {
      fail(
        'invalid-match-state',
        'Recovered target-and-margin terminal time must remain above zero.',
      );
    }
    if (
      this.terminalResultValue.reason !== 'regulation-target-and-margin'
      && regulationSecondsRemaining !== 0
    ) {
      fail(
        'invalid-match-state',
        'Recovered cutoff/overtime terminal time must remain at zero.',
      );
    }
  }
}
