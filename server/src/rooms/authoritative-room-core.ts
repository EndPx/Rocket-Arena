import {
  INPUT_PROTOCOL_VERSION,
  NETCODE,
  PHYSICS,
  createVersionedTuningRegistry,
  getRoomPolicy,
  normalizeInputCommandV2,
  validateRoomPolicy,
  type InputCommandV2,
  type MatchTransitionSnapshot,
  type QuaternionTuple,
  type RoomMode,
  type RoomMutationErrorCode,
  type RoomPinnedTuningSnapshot,
  type RoomPolicy,
  type RosterEntry,
  type SnapshotEnvelopeV2,
  type Vector3Tuple,
  type VersionedTuningRegistry,
} from '@rocket-arena/shared';
import {
  DeterministicKickoffAssignmentService,
  type KickoffAssignment,
  type KickoffAssignmentErrorCode,
  type KickoffAssignmentSet,
} from '../systems/kickoff-slots.js';
import {
  beginInitialCountdown,
  cancelInitialCountdown,
  createMatchFlowConfig,
  createWaitingMatchFlowState,
  getMatchFlowStepGates,
  reduceMatchFlowStep,
  type MatchFlowConfig,
  type MatchFlowState,
  type MatchFlowStepGates,
  type MatchFlowStepInput,
} from '../systems/match-flow.js';
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
import { SnapshotBuilder } from '../systems/snapshot-builder.js';

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

export interface AuthoritativeFixedStepContext<TWorld, TCar, TBall> {
  readonly world: TWorld;
  readonly ball: TBall;
  readonly fixedStepSeconds: number;
  /** Zero-based count of successfully completed authoritative steps. */
  readonly fixedStepIndex: number;
  readonly policy: RoomPolicy;
  readonly tuning: RoomPinnedTuningSnapshot;
  readonly gates: Readonly<MatchFlowStepGates>;
  readonly state: Readonly<
    RoomMutationState<TCar, InputCommandV2, TBall, Readonly<KickoffAssignment>>
  >;
}

export interface AuthoritativeVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface AuthoritativeSurfaceBasis {
  readonly normal: AuthoritativeVector3;
  readonly forward: AuthoritativeVector3;
  readonly right: AuthoritativeVector3;
}

export interface AuthoritativeGroundingResult {
  readonly grounded: boolean;
  readonly basis: AuthoritativeSurfaceBasis | null;
}

export interface AuthoritativeCarStepContext<TWorld, TCar, TBall>
  extends AuthoritativeFixedStepContext<TWorld, TCar, TBall> {
  readonly car: TCar;
  readonly entry: Readonly<RosterEntry>;
  readonly input: Readonly<InputCommandV2>;
}

export interface AuthoritativeCarPlanningContext<TWorld, TCar, TBall>
  extends AuthoritativeCarStepContext<TWorld, TCar, TBall> {
  readonly grounding: Readonly<AuthoritativeGroundingResult>;
}

export interface PreparedAuthoritativeCarCommand {
  /** Apply the already-planned command without observing another car. */
  apply(): void;
  /** Commit per-car controller state only after the physical step succeeds. */
  commit(): void;
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
 * A world-specific prepared placement. `apply` may mutate bodies only after the
 * core has validated a complete assignment set. `rollback` must be safe before
 * or after `apply` and restore every touched body when placement cannot commit.
 */
export interface PreparedAuthoritativeKickoffPlacement {
  apply(): void;
  rollback(): void;
}

export interface AuthoritativeKickoffPlacementContext<TWorld, TCar, TBall> {
  readonly world: TWorld;
  readonly ball: TBall;
  readonly roster: readonly Readonly<RosterEntry>[];
  readonly cars: ReadonlyMap<string, TCar>;
  readonly assignmentSet: Readonly<KickoffAssignmentSet>;
}

/**
 * One fully prepared world. Its mutation preparers close over the authoritative
 * world so no logical identity can be committed without a corresponding body.
 */
export interface AuthoritativeRoomWorldBundle<TWorld, TCar, TBall> {
  readonly world: TWorld;
  readonly ball: TBall;
  readonly mutationResources: RoomMutationResourcePreparer<TCar, InputCommandV2>;
  readonly synchronizeCarInput: (
    context: AuthoritativeCarStepContext<TWorld, TCar, TBall>,
  ) => void;
  readonly recoverBallBeforeStep: (
    context: AuthoritativeFixedStepContext<TWorld, TCar, TBall>,
  ) => void;
  readonly recoverCarBeforeStep: (
    context: AuthoritativeCarStepContext<TWorld, TCar, TBall>,
  ) => void;
  readonly prepareGrounding: (
    context: AuthoritativeFixedStepContext<TWorld, TCar, TBall>,
  ) => void;
  readonly groundCar: (
    context: AuthoritativeCarStepContext<TWorld, TCar, TBall>,
  ) => Readonly<AuthoritativeGroundingResult>;
  readonly prepareCarCommand: (
    context: AuthoritativeCarPlanningContext<TWorld, TCar, TBall>,
  ) => PreparedAuthoritativeCarCommand;
  readonly stepWorld: (
    context: AuthoritativeFixedStepContext<TWorld, TCar, TBall>,
  ) => void;
  readonly recoverCarAfterStep: (
    context: AuthoritativeCarStepContext<TWorld, TCar, TBall>,
  ) => void;
  readonly recoverBallAfterStep: (
    context: AuthoritativeFixedStepContext<TWorld, TCar, TBall>,
  ) => void;
  readonly extractMatchFlowInput: (
    context: AuthoritativeFixedStepContext<TWorld, TCar, TBall>,
  ) => Readonly<MatchFlowStepInput>;
  /**
   * Optional only for transitional harnesses that never place a kickoff. Real
   * room adapters provide this transaction before MatchFlow can request one.
   */
  readonly prepareKickoffPlacement?: (
    context: AuthoritativeKickoffPlacementContext<TWorld, TCar, TBall>,
  ) => PreparedAuthoritativeKickoffPlacement;
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

export interface AuthoritativeRoomCoreOptions<TWorld, TCar, TBall> {
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
  }) => Promise<AuthoritativeRoomWorldBundle<TWorld, TCar, TBall>>
    | AuthoritativeRoomWorldBundle<TWorld, TCar, TBall>;
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

export type AuthoritativeKickoffPlacementFailureCode =
  | KickoffAssignmentErrorCode
  | 'physics-not-ready'
  | 'placement-unavailable'
  | 'placement-failed';

export type AuthoritativeKickoffPlacementResult =
  | {
    readonly ok: true;
    readonly epoch: number;
    readonly revision: number;
    readonly reusedAssignments: boolean;
    readonly assignmentSet: Readonly<KickoffAssignmentSet>;
  }
  | {
    readonly ok: false;
    readonly code: AuthoritativeKickoffPlacementFailureCode;
    readonly message: string;
    readonly fatal: boolean;
    readonly cause?: unknown;
    readonly retained: Readonly<KickoffAssignmentSet> | null;
  };

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
  readonly phase: MatchFlowState['phase'];
  readonly countdownKind: MatchFlowState['countdownKind'];
  readonly phaseSecondsRemaining: number;
  readonly countdownStepsRemaining: number;
  readonly goalResetStepsRemaining: number;
  readonly regulationStepsRemaining: number;
  readonly regulationActivePlayStepsCompleted: number;
  readonly regulationStarted: boolean;
  readonly regulationCutoffResolved: boolean;
  readonly kickoffEpoch: number;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly winner: MatchFlowState['winner'];
  readonly terminalResult: MatchFlowState['terminalResult'];
  readonly latestTransition: Readonly<MatchTransitionSnapshot> | null;
  readonly transitionSequence: number;
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
  readonly kickoffEpoch: number | null;
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
export class AuthoritativeRoomCore<TWorld, TCar, TBall> {
  readonly roomId: string;
  readonly policy: RoomPolicy;
  readonly tuningSnapshot: RoomPinnedTuningSnapshot;

  private readonly initializeWorld: AuthoritativeRoomCoreOptions<
    TWorld,
    TCar,
    TBall
  >['initializeWorld'];
  private readonly logger: AuthoritativeRoomLogger;
  private readonly onFatal?: (error: Error) => void;
  private readonly onMutationResult?: (result: AuthoritativeRoomMutationResult) => void;
  private readonly scheduler: FixedStepScheduler;
  private readonly snapshotBuilder: SnapshotBuilder;
  private readonly kickoffAssignmentService: DeterministicKickoffAssignmentService;
  private readonly matchFlowConfig: Readonly<MatchFlowConfig>;

  private lifecycleValue: AuthoritativeRoomLifecycle = 'created';
  private stateValue: Readonly<
    RoomMutationState<TCar, InputCommandV2, TBall, Readonly<KickoffAssignment>>
  > | null = null;
  private matchFlowStateValue: Readonly<MatchFlowState> | null = null;
  /** Exact last projection validated at the same boundary as its step/state commit. */
  private committedProjectionValue: Readonly<AuthoritativeRoomProjection> | null = null;
  private initialCountdownStartedAtBoundary = false;
  private worldBundle: AuthoritativeRoomWorldBundle<TWorld, TCar, TBall> | null = null;
  private initializationPromise: Promise<void> | null = null;
  private readonly mutationQueue: QueuedMutation[] = [];
  private nextMutationSequence = 1;
  private fixedStepsCompleted = 0;
  private acceptedAnIdentity = false;
  private worldDisposalAttempted = false;
  private fatalErrorValue: Error | null = null;

  constructor(options: AuthoritativeRoomCoreOptions<TWorld, TCar, TBall>) {
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
    this.matchFlowConfig = createMatchFlowConfig(this.policy.mode, this.tuningSnapshot);
    this.snapshotBuilder = new SnapshotBuilder({ policy: this.policy });
    this.kickoffAssignmentService = new DeterministicKickoffAssignmentService({
      policy: this.policy,
      tuningRegistry: this.tuningSnapshot,
    });
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
      && this.worldBundle !== null
      && this.committedProjectionValue !== null;
  }

  /** Immutable fixed-step phase state owned by the room core. */
  get matchFlowState(): Readonly<MatchFlowState> | null {
    return this.matchFlowStateValue;
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

  /** Last fully committed assignment set; failed replacements never change it. */
  get kickoffAssignmentSet(): Readonly<KickoffAssignmentSet> | null {
    return this.kickoffAssignmentService.current;
  }

  /**
   * Prepare a complete assignment and a reversible body transaction before any
   * transform changes. MatchFlow calls this for initial and post-goal epochs.
   */
  placeKickoff(epoch: number): AuthoritativeKickoffPlacementResult {
    const state = this.stateValue;
    const bundle = this.worldBundle;
    const failure = (
      code: AuthoritativeKickoffPlacementFailureCode,
      message: string,
      fatal: boolean,
      cause?: unknown,
    ): AuthoritativeKickoffPlacementResult => Object.freeze({
      ok: false,
      code,
      message,
      fatal,
      ...(cause === undefined ? {} : { cause }),
      retained: this.kickoffAssignmentService.current,
    });

    if (this.lifecycleValue !== 'ready' || state === null || bundle === null) {
      return failure(
        'physics-not-ready',
        'Kickoff placement requires a ready authoritative world.',
        this.lifecycleValue === 'fatal',
        this.fatalErrorValue ?? undefined,
      );
    }
    if (bundle.prepareKickoffPlacement === undefined) {
      return failure(
        'placement-unavailable',
        'The authoritative world does not provide a kickoff placement transaction.',
        false,
      );
    }
    const hasPendingRepresentedLeave = [...state.tombstones]
      .some((sessionId) => state.roster.has(sessionId));
    if (hasPendingRepresentedLeave) {
      return failure(
        'invalid-roster',
        'Kickoff placement cannot begin while a represented leave is pending.',
        false,
      );
    }

    const roster = visibleRosterEntries(state);
    const assignmentPreparation = this.kickoffAssignmentService.prepare(roster, epoch);
    if (!assignmentPreparation.ok) {
      return failure(
        assignmentPreparation.code,
        assignmentPreparation.message,
        false,
        assignmentPreparation.cause,
      );
    }

    const assignmentTransaction = assignmentPreparation.prepared;
    const cars = new Map<string, TCar>();
    for (const entry of roster) {
      const car = state.cars.get(entry.sessionId);
      if (car === undefined) {
        assignmentTransaction.abort();
        return failure(
          'incomplete-bijection',
          `Roster identity ${entry.sessionId} has no authoritative car to place.`,
          false,
        );
      }
      cars.set(entry.sessionId, car);
    }

    let candidateState: Readonly<
      RoomMutationState<TCar, InputCommandV2, TBall, Readonly<KickoffAssignment>>
    >;
    try {
      candidateState = createRoomMutationState({
        ...state,
        revision: state.revision + 1,
        roster: state.roster,
        cars: state.cars,
        inputs: state.inputs,
        kickoffAssignments: assignmentTransaction.candidate.assignments,
        tombstones: state.tombstones,
      });
    } catch (cause) {
      assignmentTransaction.abort();
      return failure(
        'placement-failed',
        'Kickoff candidate state could not be prepared.',
        false,
        cause,
      );
    }

    let placement: PreparedAuthoritativeKickoffPlacement;
    try {
      placement = bundle.prepareKickoffPlacement({
        world: bundle.world,
        ball: bundle.ball,
        roster,
        cars,
        assignmentSet: assignmentTransaction.candidate,
      });
      if (
        typeof placement !== 'object'
        || placement === null
        || typeof placement.apply !== 'function'
        || typeof placement.rollback !== 'function'
      ) {
        throw new TypeError('Kickoff placement preparation must return apply/rollback functions.');
      }
    } catch (cause) {
      assignmentTransaction.abort();
      return failure(
        'placement-failed',
        'Kickoff body placement could not be prepared.',
        false,
        cause,
      );
    }

    try {
      placement.apply();
      const projection = this.createAuthoritativeProjection(
        this.fixedStepsCompleted,
        candidateState,
        this.matchFlowStateValue,
      );
      const committed = assignmentTransaction.commit();
      this.stateValue = candidateState;
      this.committedProjectionValue = projection;
      return Object.freeze({
        ok: true,
        epoch: committed.epoch,
        revision: candidateState.revision,
        reusedAssignments: assignmentTransaction.reusedAssignments,
        assignmentSet: committed,
      });
    } catch (cause) {
      if (!assignmentTransaction.settled) assignmentTransaction.abort();
      try {
        placement.rollback();
      } catch (rollbackCause) {
        const fatalCause = new AggregateError(
          [cause, rollbackCause],
          'Kickoff placement and rollback both failed.',
        );
        this.failRoom(fatalCause, 'Atomic kickoff placement could not be restored.');
        return failure(
          'placement-failed',
          'Kickoff placement rollback failed; the room is fatal.',
          true,
          fatalCause,
        );
      }
      return failure(
        'placement-failed',
        'Kickoff placement failed and the prior complete assignment was retained.',
        false,
        cause,
      );
    }
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
      kickoffAssignmentCount: this.kickoffAssignmentService.current?.assignments.size
        ?? state?.kickoffAssignments.size
        ?? 0,
      kickoffEpoch: this.kickoffAssignmentService.current?.epoch ?? null,
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
      let candidate: AuthoritativeRoomWorldBundle<TWorld, TCar, TBall> | null = null;
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
        const matchFlow = createWaitingMatchFlowState(this.matchFlowConfig);
        const initialState = createRoomMutationState({
          policy: this.policy,
          roster: new Map(),
          nextJoinOrdinal: 0,
          hostSessionId: null,
          phase: matchFlow.phase,
          countdownKind: matchFlow.countdownKind,
          countdownStepsRemaining: matchFlow.countdownStepsRemaining,
          blueScore: matchFlow.blueScore,
          orangeScore: matchFlow.orangeScore,
          regulationStepsRemaining: matchFlow.regulationStepsRemaining,
          ball: candidate.ball,
          cars: new Map(),
          inputs: new Map(),
          kickoffAssignments: new Map(),
          tombstones: new Set(),
        });
        const initialProjection = this.createAuthoritativeProjection(
          0,
          initialState,
          matchFlow,
        );
        this.matchFlowStateValue = matchFlow;
        this.stateValue = initialState;
        this.committedProjectionValue = initialProjection;
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
      if (tombstoned.ok) {
        try {
          const projection = this.createAuthoritativeProjection(
            this.fixedStepsCompleted,
            tombstoned.next,
            this.matchFlowStateValue,
          );
          this.stateValue = tombstoned.next;
          this.committedProjectionValue = projection;
        } catch (cause) {
          this.failRoom(cause, 'Disconnect tombstone projection failed.');
        }
      }
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
      this.initialCountdownStartedAtBoundary = false;
      mutationResults.push(...this.drainMutationQueue());
      this.reconcileQuickCountdownGate();
      if (this.lifecycleValue !== 'ready' || this.stateValue === null || this.worldBundle === null) {
        break;
      }

      try {
        const nextFixedStepsCompleted = this.fixedStepsCompleted + 1;
        const projection = this.executeOrderedFixedStep(nextFixedStepsCompleted);
        this.fixedStepsCompleted = nextFixedStepsCompleted;
        this.committedProjectionValue = projection;
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

  private executeOrderedFixedStep(
    nextFixedStepsCompleted: number,
  ): Readonly<AuthoritativeRoomProjection> {
    const state = this.stateValue;
    const bundle = this.worldBundle;
    const flow = this.matchFlowStateValue;
    if (state === null || bundle === null || flow === null) {
      throw new Error('A ready fixed step requires room, world, and match-flow state.');
    }

    const gates = getMatchFlowStepGates(flow);
    const stepContext = Object.freeze({
      world: bundle.world,
      ball: bundle.ball,
      fixedStepSeconds: PHYSICS.TIMESTEP,
      fixedStepIndex: this.fixedStepsCompleted,
      policy: this.policy,
      tuning: this.tuningSnapshot,
      gates,
      state,
    } satisfies AuthoritativeFixedStepContext<TWorld, TCar, TBall>);
    const carContexts = visibleRosterEntries(state).map((entry) => {
      const car = state.cars.get(entry.sessionId);
      if (car === undefined) {
        throw new Error(`Represented identity ${entry.sessionId} has no authoritative car.`);
      }
      return Object.freeze({
        ...stepContext,
        car,
        entry,
        input: state.inputs.get(entry.sessionId) ?? NEUTRAL_INPUT,
      } satisfies AuthoritativeCarStepContext<TWorld, TCar, TBall>);
    });

    // Input recovery and disabled-phase edge consumption precede all body reads.
    if (gates.synchronizeInputEdges) {
      for (const context of carContexts) bundle.synchronizeCarInput(context);
    }

    bundle.recoverBallBeforeStep(stepContext);
    for (const context of carContexts) bundle.recoverCarBeforeStep(context);

    bundle.prepareGrounding(stepContext);
    const planningContexts = carContexts.map((context) => Object.freeze({
      ...context,
      grounding: bundle.groundCar(context),
    }) satisfies AuthoritativeCarPlanningContext<TWorld, TCar, TBall>);

    const commands = gates.controlsEnabled
      ? planningContexts.map((context) => {
        const command = bundle.prepareCarCommand(context);
        if (
          typeof command !== 'object'
          || command === null
          || typeof command.apply !== 'function'
          || typeof command.commit !== 'function'
        ) {
          throw new TypeError('Car planning must return prepared apply and commit functions.');
        }
        return command;
      })
      : [];

    // Every car observes the same pre-application world before any command mutates a body.
    for (const command of commands) command.apply();
    if (gates.physicsEnabled) bundle.stepWorld(stepContext);

    for (const context of carContexts) bundle.recoverCarAfterStep(context);
    bundle.recoverBallAfterStep(stepContext);
    for (const command of commands) command.commit();

    const matchFlowInput = bundle.extractMatchFlowInput(stepContext);
    if (!this.initialCountdownStartedAtBoundary) {
      this.advanceMatchFlowStep(matchFlowInput);
    }

    // Validate and materialize the final bounded body/match state before this
    // step index and projection artifact commit together in advanceSimulation().
    const committedFlow = this.matchFlowStateValue;
    if (committedFlow === null) {
      throw new Error('Fixed-step projection requires committed match-flow state.');
    }
    this.ensureTerminalSnapshotTransition(committedFlow);
    return this.createAuthoritativeProjection(
      nextFixedStepsCompleted,
      this.stateValue,
      committedFlow,
    );
  }

  /** Return the exact immutable artifact committed by initialization or a step. */
  projectAuthoritativeState(): Readonly<AuthoritativeRoomProjection> | null {
    if (!this.canPublishSnapshots) return null;
    return this.committedProjectionValue;
  }

  private createAuthoritativeProjection(
    fixedStepsCompleted: number,
    state: Readonly<
      RoomMutationState<TCar, InputCommandV2, TBall, Readonly<KickoffAssignment>>
    > | null = this.stateValue,
    flow: Readonly<MatchFlowState> | null = this.matchFlowStateValue,
  ): Readonly<AuthoritativeRoomProjection> {
    const bundle = this.worldBundle;
    if (state === null || bundle === null || flow === null) {
      throw new Error('Authoritative projection requires ready room, world, and match-flow state.');
    }
    if (this.snapshotBuilder.transitionSequence !== flow.transitionSequence) {
      throw new Error('Match-flow and authoritative transition sequences diverged.');
    }
    const latestTransition = this.snapshotBuilder.latestTransition;
    if (
      (latestTransition === null) !== (flow.transitionSequence === 0)
      || (latestTransition !== null && latestTransition.eventId !== flow.transitionSequence)
    ) {
      throw new Error('Latest authoritative transition does not match match-flow state.');
    }
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
      fixedStepsCompleted,
      phase: flow.phase,
      countdownKind: flow.countdownKind,
      phaseSecondsRemaining: (
        flow.phase === 'countdown'
          ? flow.countdownStepsRemaining
          : flow.phase === 'goal-reset'
            ? flow.goalResetStepsRemaining
            : 0
      ) / this.matchFlowConfig.rules.fixedStepsPerSecond,
      countdownStepsRemaining: flow.countdownStepsRemaining,
      goalResetStepsRemaining: flow.goalResetStepsRemaining,
      regulationStepsRemaining: flow.regulationStepsRemaining,
      regulationActivePlayStepsCompleted: flow.regulationActivePlayStepsCompleted,
      regulationStarted: flow.regulationStarted,
      regulationCutoffResolved: flow.regulationCutoffResolved,
      kickoffEpoch: flow.kickoffEpoch,
      blueScore: flow.blueScore,
      orangeScore: flow.orangeScore,
      winner: flow.winner,
      terminalResult: flow.terminalResult,
      latestTransition,
      transitionSequence: flow.transitionSequence,
      occupancy: Object.freeze(occupancy),
      hostSessionId: visibleHost,
      cars: Object.freeze(cars),
      ball,
    });
  }

  /**
   * Convert one current authoritative projection into the room's next V2 wire
   * snapshot. The builder is room-long-lived, so sequence, recovery, and
   * terminal-event identity survive across broadcasts.
   */
  buildSnapshotV2(
    projection: Readonly<AuthoritativeRoomProjection>,
    serverTime: number,
  ): Readonly<SnapshotEnvelopeV2> | null {
    if (!this.canPublishSnapshots) return null;

    try {
      if (
        projection !== this.committedProjectionValue
        || projection.roomId !== this.roomId
        || projection.policy !== this.policy
        || projection.latestTransition !== this.snapshotBuilder.latestTransition
        || projection.transitionSequence !== this.snapshotBuilder.transitionSequence
      ) {
        throw new Error('V2 snapshot requires the exact current committed room projection.');
      }

      const roster = Object.freeze(projection.cars.map((car) => Object.freeze({
        sessionId: car.sessionId,
        acceptedJoinOrdinal: car.acceptedJoinOrdinal,
        team: car.team,
        name: car.name,
        isHost: car.isHost,
      } satisfies RosterEntry)));
      const cars = new Map(projection.cars.map((car) => [car.sessionId, Object.freeze({
        position: car.position,
        rotation: car.rotation,
        linearVelocity: car.linearVelocity,
        boost: car.boost,
      })]));
      return this.snapshotBuilder.build({
        serverTime,
        simulationTime: projection.simulationTimeMs,
        phase: projection.phase,
        countdownKind: projection.countdownKind,
        phaseSecondsRemaining: projection.phaseSecondsRemaining,
        regulationSecondsRemaining: projection.regulationStepsRemaining
          / this.matchFlowConfig.rules.fixedStepsPerSecond,
        kickoffEpoch: projection.kickoffEpoch,
        blueScore: projection.blueScore,
        orangeScore: projection.orangeScore,
        winner: projection.winner,
        roster,
        cars,
        ball: Object.freeze({
          position: projection.ball.position,
          rotation: projection.ball.rotation,
          linearVelocity: projection.ball.linearVelocity,
        }),
      });
    } catch (cause) {
      this.failRoom(cause, 'Authoritative V2 snapshot build failed.');
      return null;
    }
  }

  /**
   * Convert a synchronous encoder/broadcaster failure into the same idempotent
   * fatal boundary used by authoritative build failures. A partially delivered
   * snapshot is never retried because its room-local sequence may be observable.
   */
  failSnapshotPublication(cause: unknown): void {
    this.failRoom(cause, 'Authoritative V2 snapshot publication failed.');
  }

  private ensureTerminalSnapshotTransition(flow: Readonly<MatchFlowState>): void {
    if (flow.phase !== 'ended') return;
    const terminal = flow.terminalResult;
    if (terminal === null) {
      throw new Error('Ended match-flow state is missing its terminal result.');
    }
    if (terminal.eventId !== flow.transitionSequence) {
      throw new Error('Terminal result event ID must equal match-flow transitionSequence.');
    }

    const latest = this.snapshotBuilder.latestTransition;
    const committedTerminal = latest?.terminal ?? null;
    if (committedTerminal !== null) {
      if (
        latest?.eventId !== terminal.eventId
        || committedTerminal.reason !== terminal.reason
        || committedTerminal.winner !== terminal.winner
        || committedTerminal.blueScore !== terminal.blueScore
        || committedTerminal.orangeScore !== terminal.orangeScore
      ) {
        throw new Error('Authoritative terminal result changed after transition commit.');
      }
      return;
    }
    if (terminal.eventId !== this.snapshotBuilder.transitionSequence + 1) {
      throw new Error('Terminal transition must be the next room-local transition event.');
    }

    const goal = terminal.goal === null || terminal.goal === undefined
      ? null
      : Object.freeze({
        team: terminal.goal.team,
        kickoffEpoch: terminal.goal.kickoffEpoch,
        blueScore: terminal.goal.blueScore,
        orangeScore: terminal.orangeScore,
      });
    let committed: Readonly<MatchTransitionSnapshot>;
    switch (terminal.reason) {
      case 'regulation-target-and-margin':
        if (goal === null) throw new Error('Regulation terminal goal is missing.');
        committed = this.snapshotBuilder.commitTransition({
          kind: 'regulation-terminal-goal',
          goal,
        });
        break;
      case 'hard-regulation-cutoff':
        committed = this.snapshotBuilder.commitTransition({
          kind: 'hard-cutoff',
          winner: terminal.winner,
          blueScore: terminal.blueScore,
          orangeScore: terminal.orangeScore,
          goal,
        });
        break;
      case 'overtime-goal':
        if (goal === null) throw new Error('Overtime terminal goal is missing.');
        committed = this.snapshotBuilder.commitTransition({
          kind: 'overtime-terminal-goal',
          goal,
        });
        break;
      default: {
        const exhaustiveReason: never = terminal.reason;
        throw new TypeError(`Unsupported terminal reason: ${String(exhaustiveReason)}.`);
      }
    }

    if (
      committed.eventId !== terminal.eventId
      || committed.terminal?.reason !== terminal.reason
      || committed.terminal?.winner !== terminal.winner
      || committed.terminal?.blueScore !== terminal.blueScore
      || committed.terminal?.orangeScore !== terminal.orangeScore
    ) {
      throw new Error('Committed terminal transition differs from match-flow terminal state.');
    }
  }

  /** Idempotent external room cleanup. Fatal rooms retain fatal diagnostics. */
  dispose(): void {
    if (this.lifecycleValue === 'disposed') return;
    if (this.lifecycleValue !== 'fatal') {
      this.lifecycleValue = 'disposed';
      this.kickoffAssignmentService.clear();
    }
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
    candidate: AuthoritativeRoomWorldBundle<TWorld, TCar, TBall>,
  ): void {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new TypeError('initializeWorld must return a world bundle.');
    }
    if (
      typeof candidate.synchronizeCarInput !== 'function'
      || typeof candidate.recoverBallBeforeStep !== 'function'
      || typeof candidate.recoverCarBeforeStep !== 'function'
      || typeof candidate.prepareGrounding !== 'function'
      || typeof candidate.groundCar !== 'function'
      || typeof candidate.prepareCarCommand !== 'function'
      || typeof candidate.stepWorld !== 'function'
      || typeof candidate.recoverCarAfterStep !== 'function'
      || typeof candidate.recoverBallAfterStep !== 'function'
      || typeof candidate.extractMatchFlowInput !== 'function'
      || typeof candidate.projectCar !== 'function'
      || typeof candidate.projectBall !== 'function'
      || typeof candidate.dispose !== 'function'
      || typeof candidate.mutationResources !== 'object'
      || candidate.mutationResources === null
      || typeof candidate.mutationResources.prepareJoin !== 'function'
      || typeof candidate.mutationResources.prepareLeave !== 'function'
    ) {
      throw new TypeError(
        'A ready world bundle requires every simulation stage, projection, join/leave, and disposal function.',
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
      Readonly<KickoffAssignment>
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

      if (committed.effect.kind === 'start-validated') {
        const started = this.beginInitialCountdownAtBoundary();
        if (!started.ok) {
          if (!started.fatal && this.lifecycleValue === 'ready') {
            this.stateValue = state;
          }
          return failureResult(
            queued.sequence,
            started.code === 'physics-not-ready' ? 'physics-not-ready' : 'invalid-roster',
            `Match start could not prepare a complete kickoff: ${started.message}`,
            started.fatal,
            started.cause,
          );
        }
      }

      this.reconcileQuickCountdownGate();
      const result: AuthoritativeRoomMutationSuccess = Object.freeze({
        ok: true,
        queueSequence: queued.sequence,
        effect: committed.effect,
        revision: this.stateValue?.revision ?? committed.next.revision,
      });

      if (
        committed.effect.kind === 'left'
        && this.stateValue?.roster.size === 0
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

  /**
   * Place every represented car before committing a fresh initial countdown.
   * The boundary step itself is not charged against the new 180-step budget.
   */
  private beginInitialCountdownAtBoundary(): AuthoritativeKickoffPlacementResult {
    const flow = this.matchFlowStateValue;
    if (this.lifecycleValue !== 'ready' || this.stateValue === null || flow === null) {
      return Object.freeze({
        ok: false,
        code: 'physics-not-ready',
        message: 'Initial countdown requires a ready room and match-flow state.',
        fatal: this.lifecycleValue === 'fatal',
        retained: this.kickoffAssignmentService.current,
      });
    }
    if (flow.phase !== 'waiting') {
      return Object.freeze({
        ok: false,
        code: 'invalid-roster',
        message: 'Initial countdown can begin only while the room is waiting.',
        fatal: false,
        retained: this.kickoffAssignmentService.current,
      });
    }

    const nextFlow = beginInitialCountdown(flow, this.matchFlowConfig);
    const placement = this.placeKickoff(flow.kickoffEpoch + 1);
    if (!placement.ok) return placement;

    this.commitMatchFlowState(nextFlow);
    this.initialCountdownStartedAtBoundary = true;
    return placement;
  }

  /** Quick alone automatically starts/cancels from its exact balanced gate. */
  private reconcileQuickCountdownGate(): void {
    if (this.policy.mode !== 'quick') return;
    const state = this.stateValue;
    const flow = this.matchFlowStateValue;
    if (this.lifecycleValue !== 'ready' || state === null || flow === null) return;

    const exactBalancedRoster = state.occupancy.total === this.policy.totalCapacity
      && state.occupancy.blue === this.policy.teamCapacity
      && state.occupancy.orange === this.policy.teamCapacity;

    if (flow.phase === 'waiting' && exactBalancedRoster) {
      const started = this.beginInitialCountdownAtBoundary();
      if (!started.ok) {
        this.logger.error(
          `[AuthoritativeRoomCore] Quick countdown preparation failed roomId=${this.roomId}: ${started.message}`,
          started.cause,
        );
      }
      return;
    }

    if (
      flow.phase === 'countdown'
      && flow.countdownKind === 'initial'
      && !exactBalancedRoster
    ) {
      this.commitMatchFlowState(cancelInitialCountdown(flow, this.matchFlowConfig));
    }
  }

  /** Advance one reducer step after the world callback has completed. */
  private advanceMatchFlowStep(input: Readonly<MatchFlowStepInput>): void {
    const flow = this.matchFlowStateValue;
    if (flow === null || this.stateValue === null) {
      throw new Error('A ready fixed step requires initialized match-flow state.');
    }

    const reduced = reduceMatchFlowStep(flow, this.matchFlowConfig, input);
    if (reduced.kickoffReset !== null) {
      const placement = this.placeKickoff(reduced.kickoffReset.targetKickoffEpoch);
      if (!placement.ok) {
        throw new Error(`Post-goal kickoff placement failed: ${placement.message}`, {
          cause: placement.cause,
        });
      }
    }
    if (reduced.transition !== null) {
      const committed = this.snapshotBuilder.commitTransition({ kind: 'countdown' });
      if (committed.eventId !== reduced.transition.sequence) {
        throw new Error('Reducer and snapshot transition sequences diverged.');
      }
    }
    this.commitMatchFlowState(reduced.state);
  }

  /** Keep transactional roster state and the pure reducer projection coherent. */
  private commitMatchFlowState(flow: Readonly<MatchFlowState>): void {
    const state = this.stateValue;
    if (state === null) {
      throw new Error('Match-flow state cannot commit without transactional room state.');
    }

    this.matchFlowStateValue = flow;
    this.stateValue = createRoomMutationState({
      ...state,
      phase: flow.phase,
      countdownKind: flow.countdownKind,
      countdownStepsRemaining: flow.countdownStepsRemaining,
      blueScore: flow.blueScore,
      orangeScore: flow.orangeScore,
      regulationStepsRemaining: flow.regulationStepsRemaining,
    });
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
    this.kickoffAssignmentService.clear();
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
    bundle: AuthoritativeRoomWorldBundle<TWorld, TCar, TBall>,
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
