import {
  INPUT_PROTOCOL_VERSION,
  MATCH_RULES,
  NETCODE,
  PHYSICS,
  createVersionedTuningRegistry,
  getRoomPolicy,
  normalizeInputCommandV2,
  validateRoomPolicy,
  type InputCommandV2,
  type QuaternionTuple,
  type RoomMode,
  type RoomMutationErrorCode,
  type RoomPinnedTuningSnapshot,
  type RoomPolicy,
  type RosterEntry,
  type Vector3Tuple,
  type VersionedTuningRegistry,
} from '@rocket-arena/shared';
import {
  RoomMutationCommitError,
  canAcceptRoomInput,
  createRoomMutationState,
  planRoomMutation,
  prepareRoomMutation,
  tombstoneRoomIdentity,
  visibleRosterEntries,
  type RoomMutationEffect,
  type RoomMutationRequest,
  type RoomMutationResourcePreparer,
  type RoomMutationState,
} from '../systems/room-mutations.js';
import { FixedStepScheduler } from './fixed-step-scheduler.js';

const DEFAULT_TUNING_REGISTRY = createVersionedTuningRegistry();

const NEUTRAL_INPUT: Readonly<InputCommandV2> = Object.freeze({
  protocolVersion: INPUT_PROTOCOL_VERSION,
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jumpHeld: false,
  jumpSequence: 0,
  boostHeld: false,
  powerslideHeld: false,
  cameraToggleSequence: 0,
});

export function createNeutralInputCommandV2(): Readonly<InputCommandV2> {
  return NEUTRAL_INPUT;
}

export type AuthoritativeRoomLifecycle =
  | 'created'
  | 'initializing'
  | 'ready'
  | 'fatal'
  | 'disposed';

export interface AuthoritativeCarBodyProjection {
  readonly position: Vector3Tuple;
  readonly rotation: QuaternionTuple;
  readonly linearVelocity: Vector3Tuple;
  readonly angularVelocity: Vector3Tuple;
  readonly boost: number;
}

export interface AuthoritativeBallBodyProjection {
  readonly position: Vector3Tuple;
  readonly rotation: QuaternionTuple;
  readonly linearVelocity: Vector3Tuple;
  readonly angularVelocity: Vector3Tuple;
}

export interface AuthoritativeFixedStepContext<
  TWorld,
  TCar,
  TBall,
  TKickoffAssignment,
> {
  readonly world: TWorld;
  readonly ball: TBall;
  readonly fixedStepSeconds: number;
  /** Zero-based count of successfully completed authoritative steps. */
  readonly fixedStepIndex: number;
  readonly policy: RoomPolicy;
  readonly tuning: RoomPinnedTuningSnapshot;
  readonly state: Readonly<
    RoomMutationState<TCar, InputCommandV2, TBall, TKickoffAssignment>
  >;
}

export interface AuthoritativeCarProjectionContext<TWorld, TCar> {
  readonly world: TWorld;
  readonly car: TCar;
  readonly entry: Readonly<RosterEntry>;
}

export interface AuthoritativeBallProjectionContext<TWorld, TBall> {
  readonly world: TWorld;
  readonly ball: TBall;
}

/**
 * One fully prepared world. Its mutation preparers close over the authoritative
 * world so no logical identity can be committed without a corresponding body.
 */
export interface AuthoritativeRoomWorldBundle<
  TWorld,
  TCar,
  TBall,
  TKickoffAssignment = unknown,
> {
  readonly world: TWorld;
  readonly ball: TBall;
  readonly mutationResources: RoomMutationResourcePreparer<TCar, InputCommandV2>;
  readonly fixedStep: (
    context: AuthoritativeFixedStepContext<TWorld, TCar, TBall, TKickoffAssignment>,
  ) => void;
  readonly projectCar: (
    context: AuthoritativeCarProjectionContext<TWorld, TCar>,
  ) => AuthoritativeCarBodyProjection;
  readonly projectBall: (
    context: AuthoritativeBallProjectionContext<TWorld, TBall>,
  ) => AuthoritativeBallBodyProjection;
  readonly dispose: () => void;
}

export interface AuthoritativeRoomLogger {
  info(message: string): void;
  error(message: string, cause?: unknown): void;
}

export interface AuthoritativeRoomCoreOptions<
  TWorld,
  TCar,
  TBall,
  TKickoffAssignment = unknown,
> {
  readonly roomId: string;
  /** Untrusted at the construction boundary; resolved to the shared mapping. */
  readonly mode: unknown;
  /** Optional descriptor supplied by an adapter; it must be exactly canonical. */
  readonly policy?: unknown;
  /** Optional requested values are assertions, never authority. */
  readonly totalCapacity?: unknown;
  readonly teamCapacity?: unknown;
  readonly tuningRegistry?: Pick<VersionedTuningRegistry, 'pinForRoom'>;
  readonly initializeWorld: (context: {
    readonly roomId: string;
    readonly policy: RoomPolicy;
    readonly tuning: RoomPinnedTuningSnapshot;
  }) => Promise<AuthoritativeRoomWorldBundle<TWorld, TCar, TBall, TKickoffAssignment>>
    | AuthoritativeRoomWorldBundle<TWorld, TCar, TBall, TKickoffAssignment>;
  readonly logger?: AuthoritativeRoomLogger;
  readonly onFatal?: (error: Error) => void;
  readonly onMutationResult?: (result: AuthoritativeRoomMutationResult) => void;
}

export interface AuthoritativeRoomMutationSuccess {
  readonly ok: true;
  readonly queueSequence: number;
  readonly effect: RoomMutationEffect;
  readonly revision: number;
}

export interface AuthoritativeRoomMutationFailure {
  readonly ok: false;
  readonly queueSequence: number;
  readonly code: RoomMutationErrorCode;
  readonly message: string;
  readonly fatal: boolean;
  readonly cause?: unknown;
}

export type AuthoritativeRoomMutationResult =
  | AuthoritativeRoomMutationSuccess
  | AuthoritativeRoomMutationFailure;

export type AuthoritativeInputFailureCode =
  | 'invalid-input'
  | 'not-represented'
  | 'physics-not-ready';

export type AuthoritativeInputResult =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly code: AuthoritativeInputFailureCode;
    readonly message: string;
    readonly cause?: unknown;
  };

export interface AuthoritativeCarProjection
  extends RosterEntry, AuthoritativeCarBodyProjection {}

export interface AuthoritativeRoomProjection {
  readonly roomId: string;
  readonly policy: RoomPolicy;
  readonly tuning: Readonly<{
    registryId: string;
    version: number;
    contentHash: string;
    snapshotId: string;
  }>;
  readonly revision: number;
  readonly simulationTimeMs: number;
  readonly fixedStepsCompleted: number;
  readonly phase: RoomMutationState<unknown, unknown, unknown>['phase'];
  readonly countdownKind: RoomMutationState<unknown, unknown, unknown>['countdownKind'];
  readonly countdownStepsRemaining: number;
  readonly regulationStepsRemaining: number;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly occupancy: Readonly<{ total: number; blue: number; orange: number }>;
  readonly hostSessionId: string | null;
  readonly cars: readonly Readonly<AuthoritativeCarProjection>[];
  readonly ball: Readonly<AuthoritativeBallBodyProjection>;
}

export interface AuthoritativeRoomDiagnostics {
  readonly lifecycle: AuthoritativeRoomLifecycle;
  readonly roomId: string;
  readonly mode: RoomMode;
  readonly totalCapacity: number;
  readonly teamCapacity: number;
  readonly tuningSnapshotId: string;
  readonly pendingMutationCount: number;
  readonly mutationRevision: number | null;
  readonly rosterSessionIds: readonly string[];
  readonly bodySessionIds: readonly string[];
  readonly inputSessionIds: readonly string[];
  readonly tombstonedSessionIds: readonly string[];
  readonly kickoffAssignmentCount: number;
  readonly fixedStepsCompleted: number;
  readonly simulationTimeMs: number;
  readonly canPublishSnapshots: boolean;
  readonly worldDisposalAttempted: boolean;
  readonly fatalMessage: string | null;
}

export interface AuthoritativeRoomFrame {
  readonly scheduledFixedSteps: number;
  readonly executedFixedSteps: number;
  readonly clampedDeltaMs: number;
  readonly droppedTimeMs: number;
  readonly snapshotDue: boolean;
  readonly simulationTimeMs: number;
  readonly mutationResults: readonly AuthoritativeRoomMutationResult[];
}

export class AuthoritativeRoomCreationError extends Error {
  readonly code = 'policy-mismatch' as const;
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AuthoritativeRoomCreationError';
    this.cause = cause;
  }
}

interface QueuedMutation {
  readonly sequence: number;
  readonly request: RoomMutationRequest;
  readonly resolve: (result: AuthoritativeRoomMutationResult) => void;
}

const DEFAULT_LOGGER: AuthoritativeRoomLogger = Object.freeze({
  info(message: string): void {
    console.log(message);
  },
  error(message: string, cause?: unknown): void {
    console.error(message, cause);
  },
});

function resolvePolicy(options: Pick<
  AuthoritativeRoomCoreOptions<unknown, unknown, unknown>,
  'mode' | 'policy' | 'totalCapacity' | 'teamCapacity'
>): RoomPolicy {
  try {
    const expected = getRoomPolicy(options.mode);
    const policy = validateRoomPolicy(options.policy ?? expected);
    if (policy.mode !== expected.mode) {
      throw new TypeError(`Selected mode ${expected.mode} cannot use ${policy.mode} policy.`);
    }
    if (
      options.totalCapacity !== undefined
      && options.totalCapacity !== expected.totalCapacity
    ) {
      throw new TypeError(
        `Requested total capacity ${String(options.totalCapacity)} does not match ${expected.totalCapacity}.`,
      );
    }
    if (
      options.teamCapacity !== undefined
      && options.teamCapacity !== expected.teamCapacity
    ) {
      throw new TypeError(
        `Requested team capacity ${String(options.teamCapacity)} does not match ${expected.teamCapacity}.`,
      );
    }
    return policy;
  } catch (error) {
    throw new AuthoritativeRoomCreationError(
      'Room creation rejected because mode/capacity policy does not match the shared mapping.',
      error,
    );
  }
}

function cloneRequest(request: RoomMutationRequest): RoomMutationRequest {
  if (request.kind === 'join') {
    return Object.freeze({ kind: 'join', sessionId: request.sessionId, name: request.name });
  }
  if (request.kind === 'switch-team') {
    return Object.freeze({
      kind: 'switch-team',
      sessionId: request.sessionId,
      team: request.team,
    });
  }
  return Object.freeze({ kind: request.kind, sessionId: request.sessionId });
}

function finiteTuple(
  value: readonly number[],
  length: 3 | 4,
  field: string,
): Vector3Tuple | QuaternionTuple {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${field} must contain exactly ${length} components.`);
  }
  const copy = value.map((component, index) => {
    if (!Number.isFinite(component)) {
      throw new TypeError(`${field}[${index}] must be finite.`);
    }
    return component;
  });
  return Object.freeze(copy) as unknown as Vector3Tuple | QuaternionTuple;
}

function cloneCarBodyProjection(
  value: AuthoritativeCarBodyProjection,
): Readonly<AuthoritativeCarBodyProjection> {
  if (!Number.isFinite(value.boost) || value.boost < 0 || value.boost > 100) {
    throw new TypeError('Authoritative boost must be finite and within [0, 100].');
  }
  const rotation = finiteTuple(value.rotation, 4, 'car.rotation') as QuaternionTuple;
  if (rotation.every((component) => component === 0)) {
    throw new TypeError('Authoritative car rotation cannot be the zero quaternion.');
  }
  return Object.freeze({
    position: finiteTuple(value.position, 3, 'car.position') as Vector3Tuple,
    rotation,
    linearVelocity: finiteTuple(
      value.linearVelocity,
      3,
      'car.linearVelocity',
    ) as Vector3Tuple,
    angularVelocity: finiteTuple(
      value.angularVelocity,
      3,
      'car.angularVelocity',
    ) as Vector3Tuple,
    boost: value.boost,
  });
}

function cloneBallBodyProjection(
  value: AuthoritativeBallBodyProjection,
): Readonly<AuthoritativeBallBodyProjection> {
  const rotation = finiteTuple(value.rotation, 4, 'ball.rotation') as QuaternionTuple;
  if (rotation.every((component) => component === 0)) {
    throw new TypeError('Authoritative ball rotation cannot be the zero quaternion.');
  }
  return Object.freeze({
    position: finiteTuple(value.position, 3, 'ball.position') as Vector3Tuple,
    rotation,
    linearVelocity: finiteTuple(
      value.linearVelocity,
      3,
      'ball.linearVelocity',
    ) as Vector3Tuple,
    angularVelocity: finiteTuple(
      value.angularVelocity,
      3,
      'ball.angularVelocity',
    ) as Vector3Tuple,
  });
}

function initialFrame(simulationTimeMs: number): AuthoritativeRoomFrame {
  return Object.freeze({
    scheduledFixedSteps: 0,
    executedFixedSteps: 0,
    clampedDeltaMs: 0,
    droppedTimeMs: 0,
    snapshotDue: false,
    simulationTimeMs,
    mutationResults: Object.freeze([]),
  });
}

function failureResult(
  queueSequence: number,
  code: RoomMutationErrorCode,
  message: string,
  fatal: boolean,
  cause?: unknown,
): AuthoritativeRoomMutationFailure {
  return Object.freeze({
    ok: false,
    queueSequence,
    code,
    message,
    fatal,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Shared transactional room coordinator. Colyseus adapters enqueue intents and
 * supply callback elapsed time; this class is the only owner that converts the
 * latter through FixedStepScheduler before invoking an authoritative step.
 */
export class AuthoritativeRoomCore<
  TWorld,
  TCar,
  TBall,
  TKickoffAssignment = unknown,
> {
  readonly roomId: string;
  readonly policy: RoomPolicy;
  readonly tuningSnapshot: RoomPinnedTuningSnapshot;

  private readonly initializeWorld: AuthoritativeRoomCoreOptions<
    TWorld,
    TCar,
    TBall,
    TKickoffAssignment
  >['initializeWorld'];
  private readonly logger: AuthoritativeRoomLogger;
  private readonly onFatal?: (error: Error) => void;
  private readonly onMutationResult?: (result: AuthoritativeRoomMutationResult) => void;
  private readonly scheduler: FixedStepScheduler;

  private lifecycleValue: AuthoritativeRoomLifecycle = 'created';
  private stateValue: Readonly<
    RoomMutationState<TCar, InputCommandV2, TBall, TKickoffAssignment>
  > | null = null;
  private worldBundle: AuthoritativeRoomWorldBundle<
    TWorld,
    TCar,
    TBall,
    TKickoffAssignment
  > | null = null;
  private initializationPromise: Promise<void> | null = null;
  private readonly mutationQueue: QueuedMutation[] = [];
  private nextMutationSequence = 1;
  private fixedStepsCompleted = 0;
  private acceptedAnIdentity = false;
  private worldDisposalAttempted = false;
  private fatalErrorValue: Error | null = null;

  constructor(options: AuthoritativeRoomCoreOptions<TWorld, TCar, TBall, TKickoffAssignment>) {
    if (typeof options.roomId !== 'string' || options.roomId.trim().length === 0) {
      throw new TypeError('Authoritative room core requires a non-empty roomId.');
    }
    if (typeof options.initializeWorld !== 'function') {
      throw new TypeError('Authoritative room core requires an initializeWorld function.');
    }

    this.logger = options.logger ?? DEFAULT_LOGGER;
    this.policy = resolvePolicy(options);
    this.roomId = options.roomId;
    this.initializeWorld = options.initializeWorld;
    this.onFatal = options.onFatal;
    this.onMutationResult = options.onMutationResult;
    this.tuningSnapshot = (options.tuningRegistry ?? DEFAULT_TUNING_REGISTRY)
      .pinForRoom(this.roomId);
    this.scheduler = new FixedStepScheduler({
      fixedStepSeconds: PHYSICS.TIMESTEP,
      maxFrameDeltaSeconds: PHYSICS.MAX_FRAME_DELTA_SECONDS,
      maxSubsteps: PHYSICS.MAX_FIXED_SUBSTEPS,
      snapshotIntervalMs: NETCODE.SNAPSHOT_TARGET_INTERVAL_MS,
      snapshotSchedulingToleranceMs: NETCODE.SNAPSHOT_SCHEDULING_TOLERANCE_MS,
    });

    this.logger.info(
      `[AuthoritativeRoomCore] room-created roomId=${this.roomId}`
      + ` mode=${this.policy.mode}`
      + ` totalCapacity=${this.policy.totalCapacity}`
      + ` teamCapacity=${this.policy.teamCapacity}`,
    );
  }

  get lifecycle(): AuthoritativeRoomLifecycle {
    return this.lifecycleValue;
  }

  get canPublishSnapshots(): boolean {
    return this.lifecycleValue === 'ready'
      && this.stateValue !== null
      && this.worldBundle !== null;
  }

  /**
   * Read-only mode-policy start gate. MatchFlow owns the later transition and
   * countdown; exposing this predicate must never mutate phase or timing state.
   */
  get isStartEligible(): boolean {
    const state = this.stateValue;
    if (
      this.lifecycleValue !== 'ready'
      || state === null
      || state.phase !== 'waiting'
    ) {
      return false;
    }

    if (this.policy.startRule === 'full-balanced') {
      return state.occupancy.total === this.policy.totalCapacity
        && state.occupancy.blue === this.policy.teamCapacity
        && state.occupancy.orange === this.policy.teamCapacity;
    }

    return state.occupancy.total > 0
      && state.occupancy.total <= this.policy.totalCapacity
      && state.occupancy.blue <= this.policy.teamCapacity
      && state.occupancy.orange <= this.policy.teamCapacity;
  }

  get fatalError(): Error | null {
    return this.fatalErrorValue;
  }

  get diagnostics(): Readonly<AuthoritativeRoomDiagnostics> {
    const state = this.stateValue;
    const stableEntries = state === null
      ? []
      : [...state.roster.values()].sort((left, right) => (
        left.acceptedJoinOrdinal - right.acceptedJoinOrdinal
        || left.sessionId.localeCompare(right.sessionId)
      ));
    const sortedKeys = (values: Iterable<string>): readonly string[] => (
      Object.freeze([...values].sort((left, right) => left.localeCompare(right)))
    );

    return Object.freeze({
      lifecycle: this.lifecycleValue,
      roomId: this.roomId,
      mode: this.policy.mode,
      totalCapacity: this.policy.totalCapacity,
      teamCapacity: this.policy.teamCapacity,
      tuningSnapshotId: this.tuningSnapshot.snapshotId,
      pendingMutationCount: this.mutationQueue.length,
      mutationRevision: state?.revision ?? null,
      rosterSessionIds: Object.freeze(stableEntries.map(({ sessionId }) => sessionId)),
      bodySessionIds: sortedKeys(state?.cars.keys() ?? []),
      inputSessionIds: sortedKeys(state?.inputs.keys() ?? []),
      tombstonedSessionIds: sortedKeys(state?.tombstones.values() ?? []),
      kickoffAssignmentCount: state?.kickoffAssignments.size ?? 0,
      fixedStepsCompleted: this.fixedStepsCompleted,
      simulationTimeMs: this.scheduler.simulationTimeMs,
      canPublishSnapshots: this.canPublishSnapshots,
      worldDisposalAttempted: this.worldDisposalAttempted,
      fatalMessage: this.fatalErrorValue?.message ?? null,
    });
  }

  /** Initialize once; queued mutations remain behind the next fixed-step boundary. */
  initialize(): Promise<void> {
    if (this.lifecycleValue === 'ready') return Promise.resolve();
    if (this.lifecycleValue === 'initializing') return this.initializationPromise!;
    if (this.lifecycleValue === 'fatal') {
      return Promise.reject(this.fatalErrorValue ?? new Error('Authoritative room is fatal.'));
    }
    if (this.lifecycleValue === 'disposed') {
      return Promise.reject(new Error('Authoritative room is disposed.'));
    }

    this.lifecycleValue = 'initializing';
    this.initializationPromise = (async () => {
      let candidate: AuthoritativeRoomWorldBundle<
        TWorld,
        TCar,
        TBall,
        TKickoffAssignment
      > | null = null;
      try {
        candidate = await this.initializeWorld({
          roomId: this.roomId,
          policy: this.policy,
          tuning: this.tuningSnapshot,
        });
        this.assertWorldBundle(candidate);

        if (this.lifecycleValue === 'disposed') {
          this.disposeDetachedBundle(candidate);
          return;
        }

        this.worldBundle = candidate;
        this.stateValue = createRoomMutationState({
          policy: this.policy,
          roster: new Map(),
          nextJoinOrdinal: 0,
          hostSessionId: null,
          phase: 'waiting',
          countdownKind: null,
          countdownStepsRemaining: 0,
          blueScore: 0,
          orangeScore: 0,
          regulationStepsRemaining: MATCH_RULES.regulationActivePlaySteps,
          ball: candidate.ball,
          cars: new Map(),
          inputs: new Map(),
          kickoffAssignments: new Map(),
          tombstones: new Set(),
        });
        this.lifecycleValue = 'ready';
        this.logger.info(`[AuthoritativeRoomCore] physics-ready roomId=${this.roomId}`);
      } catch (cause) {
        if (candidate !== null && this.worldBundle !== candidate) {
          this.disposeDetachedBundle(candidate);
        }
        this.failRoom(cause, 'Authoritative world initialization failed.');
        throw this.fatalErrorValue ?? cause;
      }
    })();
    return this.initializationPromise;
  }

  /**
   * Enqueue in receive order. Represented leaves are tombstoned immediately so
   * later inputs and projections cannot observe a disconnecting identity.
   */
  queueMutation(request: RoomMutationRequest): Promise<AuthoritativeRoomMutationResult> {
    const sequence = this.nextMutationSequence;
    this.nextMutationSequence += 1;

    if (this.lifecycleValue === 'fatal' || this.lifecycleValue === 'disposed') {
      const result = failureResult(
        sequence,
        'physics-not-ready',
        `Room cannot accept mutations while ${this.lifecycleValue}.`,
        this.lifecycleValue === 'fatal',
        this.fatalErrorValue ?? undefined,
      );
      this.notifyMutationResult(result);
      return Promise.resolve(result);
    }

    const ownedRequest = cloneRequest(request);
    const completion = new Promise<AuthoritativeRoomMutationResult>((resolve) => {
      this.mutationQueue.push({ sequence, request: ownedRequest, resolve });
    });

    if (
      ownedRequest.kind === 'leave'
      && this.stateValue !== null
      && this.stateValue.roster.has(ownedRequest.sessionId)
    ) {
      const tombstoned = tombstoneRoomIdentity(this.stateValue, ownedRequest.sessionId);
      if (tombstoned.ok) this.stateValue = tombstoned.next;
    }

    return completion;
  }

  /** Store only normalized control intent for a represented, non-tombstoned identity. */
  submitInput(sessionId: string, candidate: unknown): AuthoritativeInputResult {
    const state = this.stateValue;
    if (this.lifecycleValue !== 'ready' || state === null) {
      return Object.freeze({
        ok: false,
        code: 'physics-not-ready',
        message: 'Authoritative input is unavailable until physics is ready.',
      });
    }
    if (!canAcceptRoomInput(state, sessionId)) {
      return Object.freeze({
        ok: false,
        code: 'not-represented',
        message: `Identity ${sessionId} is not represented or is disconnecting.`,
      });
    }

    const previous = state.inputs.get(sessionId) ?? NEUTRAL_INPUT;
    let normalized: Readonly<InputCommandV2>;
    try {
      normalized = normalizeInputCommandV2(candidate, {
        jumpSequence: previous.jumpSequence,
        cameraToggleSequence: previous.cameraToggleSequence,
      });
    } catch (cause) {
      return Object.freeze({
        ok: false,
        code: 'invalid-input' as const,
        message: 'Input was rejected at the control-only authority boundary.',
        cause,
      });
    }

    const inputs = new Map(state.inputs);
    inputs.set(sessionId, normalized);
    this.stateValue = createRoomMutationState({
      revision: state.revision,
      policy: state.policy,
      roster: state.roster,
      nextJoinOrdinal: state.nextJoinOrdinal,
      hostSessionId: state.hostSessionId,
      occupancy: state.occupancy,
      phase: state.phase,
      countdownKind: state.countdownKind,
      countdownStepsRemaining: state.countdownStepsRemaining,
      blueScore: state.blueScore,
      orangeScore: state.orangeScore,
      regulationStepsRemaining: state.regulationStepsRemaining,
      ball: state.ball,
      cars: state.cars,
      inputs,
      kickoffAssignments: state.kickoffAssignments,
      tombstones: state.tombstones,
    });
    return Object.freeze({ ok: true });
  }

  /**
   * The sole callback-delta entry point. FixedStepScheduler decides exact work;
   * raw callback time is never passed to a world or body controller.
   */
  advanceSimulation(rawDeltaMs: number): AuthoritativeRoomFrame {
    if (this.lifecycleValue !== 'ready' || this.stateValue === null || this.worldBundle === null) {
      return initialFrame(this.scheduler.simulationTimeMs);
    }

    const scheduled = this.scheduler.advance(rawDeltaMs);
    const mutationResults: AuthoritativeRoomMutationResult[] = [];
    let executedFixedSteps = 0;

    for (let index = 0; index < scheduled.fixedSteps; index += 1) {
      mutationResults.push(...this.drainMutationQueue());
      if (this.lifecycleValue !== 'ready' || this.stateValue === null || this.worldBundle === null) {
        break;
      }

      try {
        this.worldBundle.fixedStep({
          world: this.worldBundle.world,
          ball: this.worldBundle.ball,
          fixedStepSeconds: PHYSICS.TIMESTEP,
          fixedStepIndex: this.fixedStepsCompleted,
          policy: this.policy,
          tuning: this.tuningSnapshot,
          state: this.stateValue,
        });
        this.fixedStepsCompleted += 1;
        executedFixedSteps += 1;
      } catch (cause) {
        this.failRoom(cause, 'Authoritative fixed-step execution failed.');
        break;
      }
    }

    return Object.freeze({
      scheduledFixedSteps: scheduled.fixedSteps,
      executedFixedSteps,
      clampedDeltaMs: scheduled.clampedDeltaMs,
      droppedTimeMs: scheduled.droppedTimeMs,
      snapshotDue: scheduled.snapshotDue && this.canPublishSnapshots,
      simulationTimeMs: scheduled.simulationTimeMs,
      mutationResults: Object.freeze(mutationResults),
    });
  }

  /** Build one immutable, body-derived state; no client payload participates. */
  projectAuthoritativeState(): Readonly<AuthoritativeRoomProjection> | null {
    if (!this.canPublishSnapshots || this.stateValue === null || this.worldBundle === null) {
      return null;
    }

    try {
      const state = this.stateValue;
      const bundle = this.worldBundle;
      const entries = visibleRosterEntries(state);
      const cars = entries.map((entry): Readonly<AuthoritativeCarProjection> => {
        const car = state.cars.get(entry.sessionId);
        if (car === undefined) {
          throw new Error(`Represented identity ${entry.sessionId} has no authoritative car.`);
        }
        const body = cloneCarBodyProjection(bundle.projectCar({
          world: bundle.world,
          car,
          entry,
        }));
        return Object.freeze({
          sessionId: entry.sessionId,
          acceptedJoinOrdinal: entry.acceptedJoinOrdinal,
          team: entry.team,
          name: entry.name,
          isHost: entry.isHost,
          ...body,
        });
      });
      const occupancy = cars.reduce(
        (counts, car) => ({
          total: counts.total + 1,
          blue: counts.blue + Number(car.team === 'blue'),
          orange: counts.orange + Number(car.team === 'orange'),
        }),
        { total: 0, blue: 0, orange: 0 },
      );
      const visibleHost = cars.find(({ isHost }) => isHost)?.sessionId ?? null;
      const ball = cloneBallBodyProjection(bundle.projectBall({
        world: bundle.world,
        ball: bundle.ball,
      }));

      return Object.freeze({
        roomId: this.roomId,
        policy: this.policy,
        tuning: Object.freeze({
          registryId: this.tuningSnapshot.registryId,
          version: this.tuningSnapshot.version,
          contentHash: this.tuningSnapshot.contentHash,
          snapshotId: this.tuningSnapshot.snapshotId,
        }),
        revision: state.revision,
        simulationTimeMs: this.scheduler.simulationTimeMs,
        fixedStepsCompleted: this.fixedStepsCompleted,
        phase: state.phase,
        countdownKind: state.countdownKind,
        countdownStepsRemaining: state.countdownStepsRemaining,
        regulationStepsRemaining: state.regulationStepsRemaining,
        blueScore: state.blueScore,
        orangeScore: state.orangeScore,
        occupancy: Object.freeze(occupancy),
        hostSessionId: visibleHost,
        cars: Object.freeze(cars),
        ball,
      });
    } catch (cause) {
      this.failRoom(cause, 'Authoritative state projection failed.');
      return null;
    }
  }

  /** Idempotent external room cleanup. Fatal rooms retain fatal diagnostics. */
  dispose(): void {
    if (this.lifecycleValue === 'disposed') return;
    if (this.lifecycleValue !== 'fatal') this.lifecycleValue = 'disposed';
    this.rejectPendingMutations(
      'Room was disposed before the queued mutation reached a fixed-step boundary.',
      this.lifecycleValue === 'fatal',
    );
    const disposalError = this.disposeCurrentWorld();
    if (disposalError !== null && this.lifecycleValue !== 'fatal') {
      this.failRoom(disposalError, 'Authoritative world disposal failed.');
    }
  }

  private assertWorldBundle(
    candidate: AuthoritativeRoomWorldBundle<TWorld, TCar, TBall, TKickoffAssignment>,
  ): void {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new TypeError('initializeWorld must return a world bundle.');
    }
    if (
      typeof candidate.fixedStep !== 'function'
      || typeof candidate.projectCar !== 'function'
      || typeof candidate.projectBall !== 'function'
      || typeof candidate.dispose !== 'function'
      || typeof candidate.mutationResources !== 'object'
      || candidate.mutationResources === null
      || typeof candidate.mutationResources.prepareJoin !== 'function'
      || typeof candidate.mutationResources.prepareLeave !== 'function'
    ) {
      throw new TypeError(
        'A ready world bundle requires fixed-step, projection, join/leave, and disposal functions.',
      );
    }
    if (!Object.prototype.hasOwnProperty.call(candidate, 'world')) {
      throw new TypeError('A ready world bundle must expose its authoritative world.');
    }
    if (!Object.prototype.hasOwnProperty.call(candidate, 'ball')) {
      throw new TypeError('A ready world bundle must expose its authoritative ball.');
    }
  }

  private drainMutationQueue(): readonly AuthoritativeRoomMutationResult[] {
    const results: AuthoritativeRoomMutationResult[] = [];
    while (this.mutationQueue.length > 0 && this.lifecycleValue === 'ready') {
      const queued = this.mutationQueue.shift()!;
      const result = this.commitQueuedMutation(queued);
      results.push(result);
      queued.resolve(result);
      this.notifyMutationResult(result);
    }
    return results;
  }

  private commitQueuedMutation(queued: QueuedMutation): AuthoritativeRoomMutationResult {
    const state = this.stateValue;
    const bundle = this.worldBundle;
    if (state === null || bundle === null || this.lifecycleValue !== 'ready') {
      return failureResult(
        queued.sequence,
        'physics-not-ready',
        'Mutation reached a boundary without a ready authoritative world.',
        false,
      );
    }

    const planned = planRoomMutation(state, queued.request, { physicsReady: true });
    if (!planned.ok) {
      return failureResult(
        queued.sequence,
        planned.code,
        planned.message,
        false,
        planned.cause,
      );
    }

    const resources: RoomMutationResourcePreparer<TCar, InputCommandV2> = {
      prepareJoin: (context, scope) => {
        const prepared = bundle.mutationResources.prepareJoin!(context, scope);
        return {
          car: prepared.car,
          input: normalizeInputCommandV2(prepared.input, {
            jumpSequence: 0,
            cameraToggleSequence: 0,
          }),
        };
      },
      prepareLeave: (context, scope) => (
        bundle.mutationResources.prepareLeave!(context, scope)
      ),
    };
    const preparation = prepareRoomMutation<
      TCar,
      InputCommandV2,
      TBall,
      TKickoffAssignment
    >(planned.plan, resources);
    if (!preparation.ok) {
      return failureResult(
        queued.sequence,
        preparation.code,
        preparation.message,
        false,
        preparation.cause,
      );
    }

    try {
      const committed = preparation.prepared.commit(state);
      if (!committed.ok) {
        return failureResult(
          queued.sequence,
          committed.code,
          committed.message,
          false,
          committed.cause,
        );
      }
      this.stateValue = committed.next;
      if (committed.effect.kind === 'joined') this.acceptedAnIdentity = true;
      const result: AuthoritativeRoomMutationSuccess = Object.freeze({
        ok: true,
        queueSequence: queued.sequence,
        effect: committed.effect,
        revision: committed.next.revision,
      });

      if (
        committed.effect.kind === 'left'
        && committed.next.roster.size === 0
        && this.acceptedAnIdentity
      ) {
        this.disposeEmptyRoom();
      }
      return result;
    } catch (cause) {
      const fatalCause = cause instanceof RoomMutationCommitError
        ? cause
        : new RoomMutationCommitError('Unexpected room mutation commit failure.', cause);
      this.failRoom(
        fatalCause,
        'Authoritative body removal failed; snapshots and simulation are stopped.',
      );
      return failureResult(
        queued.sequence,
        'physics-not-ready',
        'Authoritative body removal failed; the room is fatal.',
        true,
        fatalCause,
      );
    }
  }

  private disposeEmptyRoom(): void {
    const state = this.stateValue;
    if (state !== null && state.roster.size === 0 && state.tombstones.size > 0) {
      this.stateValue = createRoomMutationState({
        ...state,
        roster: state.roster,
        cars: state.cars,
        inputs: state.inputs,
        kickoffAssignments: state.kickoffAssignments,
        tombstones: new Set(),
      });
    }
    this.lifecycleValue = 'disposed';
    this.rejectPendingMutations(
      'Room became empty before the queued mutation could be committed.',
      false,
    );
    const disposalError = this.disposeCurrentWorld();
    if (disposalError !== null) {
      this.logger.error(
        `[AuthoritativeRoomCore] empty-room disposal failed roomId=${this.roomId}`,
        disposalError,
      );
    }
  }

  private rejectPendingMutations(message: string, fatal: boolean): void {
    while (this.mutationQueue.length > 0) {
      const queued = this.mutationQueue.shift()!;
      const result = failureResult(
        queued.sequence,
        'physics-not-ready',
        message,
        fatal,
        this.fatalErrorValue ?? undefined,
      );
      queued.resolve(result);
      this.notifyMutationResult(result);
    }
  }

  private notifyMutationResult(result: AuthoritativeRoomMutationResult): void {
    if (this.onMutationResult === undefined) return;
    try {
      this.onMutationResult(result);
    } catch (cause) {
      this.logger.error(
        `[AuthoritativeRoomCore] mutation-result observer failed roomId=${this.roomId}`,
        cause,
      );
    }
  }

  private failRoom(cause: unknown, message: string): void {
    if (this.lifecycleValue === 'fatal' || this.lifecycleValue === 'disposed') return;
    const primary = cause instanceof Error ? cause : new Error(String(cause));
    this.lifecycleValue = 'fatal';
    this.fatalErrorValue = new Error(`${message} ${primary.message}`, { cause: primary });
    const disposalError = this.disposeCurrentWorld();
    if (disposalError !== null) {
      this.fatalErrorValue = new AggregateError(
        [this.fatalErrorValue, disposalError],
        `${message} World disposal also failed.`,
      );
    }
    this.rejectPendingMutations(message, true);
    this.logger.error(
      `[AuthoritativeRoomCore] room-fatal roomId=${this.roomId}: ${this.fatalErrorValue.message}`,
      this.fatalErrorValue,
    );
    if (this.onFatal !== undefined) {
      try {
        this.onFatal(this.fatalErrorValue);
      } catch (observerError) {
        this.logger.error(
          `[AuthoritativeRoomCore] fatal observer failed roomId=${this.roomId}`,
          observerError,
        );
      }
    }
  }

  private disposeCurrentWorld(): Error | null {
    if (this.worldDisposalAttempted || this.worldBundle === null) return null;
    this.worldDisposalAttempted = true;
    const bundle = this.worldBundle;
    this.worldBundle = null;
    try {
      bundle.dispose();
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause : new Error(String(cause));
    }
  }

  private disposeDetachedBundle(
    bundle: AuthoritativeRoomWorldBundle<TWorld, TCar, TBall, TKickoffAssignment>,
  ): void {
    if (this.worldDisposalAttempted) return;
    this.worldDisposalAttempted = true;
    try {
      bundle.dispose();
    } catch (cause) {
      this.logger.error(
        `[AuthoritativeRoomCore] detached world disposal failed roomId=${this.roomId}`,
        cause,
      );
    }
  }
}
