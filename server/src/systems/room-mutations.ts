import {
  COUNTDOWN_KINDS,
  MATCH_PHASES,
  ROOM_POLICIES,
  TEAMS,
  validateRoomPolicy,
  type CountdownKind,
  type MatchPhase,
  type RoomMutationErrorCode,
  type RoomPolicy,
  type RosterEntry,
  type Team,
} from '@rocket-arena/shared';
import { assignTeamsInStableRosterOrder } from './team-assignment.js';

export interface RoomOccupancy {
  readonly total: number;
  readonly blue: number;
  readonly orange: number;
}

/**
 * The complete logical boundary changed by a room mutation. Opaque gameplay
 * state is carried through unchanged so a rejected mutation cannot partially
 * alter score, timing, ball, car, or input state.
 */
export interface RoomMutationState<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment = unknown,
> {
  readonly revision: number;
  readonly policy: RoomPolicy;
  readonly roster: ReadonlyMap<string, Readonly<RosterEntry>>;
  readonly nextJoinOrdinal: number;
  readonly hostSessionId: string | null;
  readonly occupancy: Readonly<RoomOccupancy>;
  readonly phase: MatchPhase;
  readonly countdownKind: CountdownKind | null;
  readonly countdownStepsRemaining: number;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly regulationStepsRemaining: number;
  readonly ball: TBall;
  readonly cars: ReadonlyMap<string, TCar>;
  readonly inputs: ReadonlyMap<string, TInput>;
  readonly kickoffAssignments: ReadonlyMap<string, TKickoffAssignment>;
  /** Disconnect identities gated from input and snapshot projection. */
  readonly tombstones: ReadonlySet<string>;
}

export interface RoomMutationStateSeed<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment = unknown,
> {
  readonly revision?: number;
  readonly policy: RoomPolicy;
  readonly roster: ReadonlyMap<string, RosterEntry>;
  readonly nextJoinOrdinal: number;
  readonly hostSessionId: string | null;
  readonly occupancy?: RoomOccupancy;
  readonly phase: MatchPhase;
  readonly countdownKind: CountdownKind | null;
  readonly countdownStepsRemaining: number;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly regulationStepsRemaining: number;
  readonly ball: TBall;
  readonly cars: ReadonlyMap<string, TCar>;
  readonly inputs: ReadonlyMap<string, TInput>;
  readonly kickoffAssignments?: ReadonlyMap<string, TKickoffAssignment>;
  readonly tombstones?: ReadonlySet<string>;
}

export type RoomMutationRequest =
  | {
    readonly kind: 'join';
    readonly sessionId: string;
    readonly name: string;
  }
  | {
    readonly kind: 'leave';
    readonly sessionId: string;
  }
  | {
    readonly kind: 'switch-team';
    readonly sessionId: string;
    readonly team: Team;
  }
  | {
    readonly kind: 'start';
    readonly sessionId: string;
  };

export interface RoomMutationPlanningContext {
  readonly physicsReady: boolean;
}

export type RoomMutationEffect =
  | {
    readonly kind: 'joined';
    readonly entry: Readonly<RosterEntry>;
  }
  | {
    readonly kind: 'left';
    readonly sessionId: string;
    readonly successorHostSessionId: string | null;
  }
  | {
    readonly kind: 'team-switched';
    readonly sessionId: string;
    readonly from: Team;
    readonly to: Team;
  }
  | {
    /** MatchFlow consumes this validated request in a later task. */
    readonly kind: 'start-validated';
    readonly sessionId: string;
  };

export interface RoomMutationRejection {
  readonly ok: false;
  readonly code: RoomMutationErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export interface RoomMutationPlan {
  readonly requestKind: RoomMutationRequest['kind'];
  readonly effect: RoomMutationEffect;
}

export type RoomMutationPlanningResult =
  | { readonly ok: true; readonly plan: RoomMutationPlan }
  | RoomMutationRejection;

export interface PrepareJoinContext {
  readonly policy: RoomPolicy;
  readonly entry: Readonly<RosterEntry>;
}

export interface PrepareLeaveContext<TCar> {
  readonly policy: RoomPolicy;
  readonly entry: Readonly<RosterEntry>;
  readonly car: TCar;
}

/**
 * Resource factories register temporary ownership before any later operation
 * can fail. The service rolls registered resources back in reverse order.
 */
export interface RoomMutationPreparationScope {
  track<T>(resource: T, dispose: (resource: T) => void): T;
}

export interface PreparedJoinResources<TCar, TInput> {
  readonly car: TCar;
  readonly input: TInput;
}

export interface PreparedLeaveResources {
  /** Removes the authoritative body. Throwing is a room-fatal invariant error. */
  readonly commitRemoval: () => void;
}

export interface RoomMutationResourcePreparer<TCar, TInput> {
  readonly prepareJoin?: (
    context: PrepareJoinContext,
    scope: RoomMutationPreparationScope,
  ) => PreparedJoinResources<TCar, TInput>;
  readonly prepareLeave?: (
    context: PrepareLeaveContext<TCar>,
    scope: RoomMutationPreparationScope,
  ) => PreparedLeaveResources;
}

export interface RoomMutationCommitSuccess<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment,
> {
  readonly ok: true;
  readonly next: Readonly<RoomMutationState<TCar, TInput, TBall, TKickoffAssignment>>;
  readonly effect: RoomMutationEffect;
}

export type RoomMutationCommitResult<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment,
> = RoomMutationCommitSuccess<TCar, TInput, TBall, TKickoffAssignment>
  | RoomMutationRejection;

export interface PreparedRoomMutation<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment = unknown,
> {
  readonly effect: RoomMutationEffect;
  readonly settled: boolean;
  /**
   * The caller replaces its authoritative state only with a successful `next`.
   * A prepared transaction is single-use and rejects a stale base state.
   */
  commit(
    current: Readonly<RoomMutationState<TCar, TInput, TBall, TKickoffAssignment>>,
  ): RoomMutationCommitResult<TCar, TInput, TBall, TKickoffAssignment>;
  /** Dispose prepared temporary resources without exposing a logical change. */
  abort(): void;
}

export type RoomMutationPreparationResult<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment = unknown,
> =
  | {
    readonly ok: true;
    readonly prepared: PreparedRoomMutation<TCar, TInput, TBall, TKickoffAssignment>;
  }
  | RoomMutationRejection;

export class RoomMutationCommitError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RoomMutationCommitError';
    this.cause = cause;
  }
}

interface InternalPlan<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment,
> {
  readonly base: Readonly<RoomMutationState<TCar, TInput, TBall, TKickoffAssignment>>;
  readonly effect: RoomMutationEffect;
  readonly roster: ReadonlyMap<string, Readonly<RosterEntry>>;
  readonly nextJoinOrdinal: number;
  readonly hostSessionId: string | null;
  readonly occupancy: Readonly<RoomOccupancy>;
  readonly kickoffAssignments: ReadonlyMap<string, TKickoffAssignment>;
  readonly tombstones: ReadonlySet<string>;
  readonly operation:
    | { readonly kind: 'join'; readonly entry: Readonly<RosterEntry> }
    | {
      readonly kind: 'leave';
      readonly entry: Readonly<RosterEntry>;
      readonly car: TCar;
    }
    | { readonly kind: 'logical-only' };
}

const INTERNAL_PLAN = Symbol('room-mutation-plan');

type OpaquePlan<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment,
> = RoomMutationPlan & {
  readonly [INTERNAL_PLAN]: InternalPlan<TCar, TInput, TBall, TKickoffAssignment>;
};

function reject(
  code: RoomMutationErrorCode,
  message: string,
  cause?: unknown,
): RoomMutationRejection {
  return Object.freeze({ ok: false, code, message, ...(cause === undefined ? {} : { cause }) });
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTeam(value: unknown): value is Team {
  return TEAMS.some((team) => team === value);
}

function compareStableRosterOrder(left: RosterEntry, right: RosterEntry): number {
  return left.acceptedJoinOrdinal - right.acceptedJoinOrdinal
    || left.sessionId.localeCompare(right.sessionId);
}

function stableRosterEntries(
  roster: ReadonlyMap<string, Readonly<RosterEntry>>,
): readonly Readonly<RosterEntry>[] {
  return [...roster.values()].sort(compareStableRosterOrder);
}

function calculateOccupancy(
  roster: ReadonlyMap<string, Readonly<RosterEntry>>,
): Readonly<RoomOccupancy> {
  let blue = 0;
  let orange = 0;
  for (const entry of roster.values()) {
    if (entry.team === 'blue') blue += 1;
    else if (entry.team === 'orange') orange += 1;
  }
  return Object.freeze({ total: blue + orange, blue, orange });
}

function freezeRosterEntry(entry: RosterEntry): Readonly<RosterEntry> {
  return Object.freeze({
    sessionId: entry.sessionId,
    acceptedJoinOrdinal: entry.acceptedJoinOrdinal,
    team: entry.team,
    name: entry.name,
    isHost: entry.isHost,
  });
}

function freezeRoster(
  roster: ReadonlyMap<string, RosterEntry>,
): ReadonlyMap<string, Readonly<RosterEntry>> {
  return Object.freeze(new Map(
    [...roster.entries()].map(([sessionId, entry]) => [sessionId, freezeRosterEntry(entry)]),
  ));
}

function stateValidationError(
  state: Readonly<RoomMutationState<unknown, unknown, unknown, unknown>>,
): RoomMutationRejection | null {
  let policy: RoomPolicy;
  try {
    policy = validateRoomPolicy(state.policy);
  } catch (error) {
    return reject('policy-mismatch', 'Room state does not use its canonical immutable policy.', error);
  }

  if (!isSafeNonNegativeInteger(state.revision)) {
    return reject('invalid-roster', 'Room revision must be a non-negative safe integer.');
  }
  if (!MATCH_PHASES.some((phase) => phase === state.phase)) {
    return reject('invalid-roster', `Room has an invalid phase: ${String(state.phase)}.`);
  }
  if (
    state.countdownKind !== null
    && !COUNTDOWN_KINDS.some((kind) => kind === state.countdownKind)
  ) {
    return reject('invalid-roster', 'Room has an invalid countdown kind.');
  }
  if ((state.phase === 'countdown') !== (state.countdownKind !== null)) {
    return reject('invalid-roster', 'Countdown metadata is incoherent with the room phase.');
  }
  if (
    !isSafeNonNegativeInteger(state.countdownStepsRemaining)
    || !isSafeNonNegativeInteger(state.blueScore)
    || !isSafeNonNegativeInteger(state.orangeScore)
    || !isSafeNonNegativeInteger(state.regulationStepsRemaining)
  ) {
    return reject('invalid-roster', 'Room counters and scores must be non-negative safe integers.');
  }
  if (state.phase !== 'countdown' && state.countdownStepsRemaining !== 0) {
    return reject('invalid-roster', 'Only countdown phase may retain countdown steps.');
  }
  if (!isSafeNonNegativeInteger(state.nextJoinOrdinal)) {
    return reject('invalid-roster', 'nextJoinOrdinal must be a non-negative safe integer.');
  }

  const seenSessionIds = new Set<string>();
  let hostCount = 0;
  let maxOrdinal = -1;
  for (const [sessionId, entry] of state.roster) {
    if (
      typeof sessionId !== 'string'
      || sessionId.length === 0
      || entry.sessionId !== sessionId
      || seenSessionIds.has(sessionId)
    ) {
      return reject('invalid-roster', 'Roster identities must be unique, non-empty, and match map keys.');
    }
    if (
      !isSafeNonNegativeInteger(entry.acceptedJoinOrdinal)
      || !isTeam(entry.team)
      || typeof entry.name !== 'string'
      || typeof entry.isHost !== 'boolean'
    ) {
      return reject('invalid-roster', `Roster entry ${sessionId} is malformed.`);
    }
    seenSessionIds.add(sessionId);
    maxOrdinal = Math.max(maxOrdinal, entry.acceptedJoinOrdinal);
    if (entry.isHost) hostCount += 1;
  }
  if (state.nextJoinOrdinal <= maxOrdinal) {
    return reject('invalid-roster', 'nextJoinOrdinal must be greater than every accepted join ordinal.');
  }

  const occupancy = calculateOccupancy(state.roster);
  if (
    occupancy.total > policy.totalCapacity
    || occupancy.blue > policy.teamCapacity
    || occupancy.orange > policy.teamCapacity
  ) {
    return reject('invalid-roster', 'Roster occupancy exceeds the selected room policy.');
  }
  if (
    state.occupancy.total !== occupancy.total
    || state.occupancy.blue !== occupancy.blue
    || state.occupancy.orange !== occupancy.orange
  ) {
    return reject('invalid-roster', 'Stored occupancy does not match the authoritative roster.');
  }

  if (policy.mode === 'quick') {
    if (state.hostSessionId !== null || hostCount !== 0) {
      return reject('invalid-roster', 'Quick Match cannot contain Host metadata.');
    }
  } else if (occupancy.total === 0) {
    if (state.hostSessionId !== null || hostCount !== 0) {
      return reject('invalid-roster', 'An empty Custom Room cannot contain Host metadata.');
    }
  } else {
    const host = state.hostSessionId === null ? undefined : state.roster.get(state.hostSessionId);
    if (host === undefined || hostCount !== 1 || !host.isHost) {
      return reject('invalid-roster', 'A non-empty Custom Room must have exactly one represented Host.');
    }
  }

  if (state.cars.size !== state.roster.size || state.inputs.size !== state.roster.size) {
    return reject(
      'invalid-roster',
      'Every represented identity must have exactly one authoritative car and input slot.',
    );
  }
  for (const sessionId of state.roster.keys()) {
    const car = state.cars.get(sessionId);
    const input = state.inputs.get(sessionId);
    if (
      !state.cars.has(sessionId)
      || !state.inputs.has(sessionId)
      || car === null
      || car === undefined
      || input === null
      || input === undefined
    ) {
      return reject(
        'invalid-roster',
        `Represented identity ${sessionId} is missing a valid authoritative car or input slot.`,
      );
    }
  }
  for (const sessionId of state.cars.keys()) {
    if (!state.roster.has(sessionId)) {
      return reject('invalid-roster', `Car ${sessionId} has no represented identity.`);
    }
  }
  for (const sessionId of state.inputs.keys()) {
    if (!state.roster.has(sessionId)) {
      return reject('invalid-roster', `Input slot ${sessionId} has no represented identity.`);
    }
  }
  for (const sessionId of state.tombstones) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return reject('invalid-roster', 'Tombstones must contain non-empty session identities.');
    }
  }

  return null;
}

/** Validate, copy, and freeze the logical state used at mutation boundaries. */
export function createRoomMutationState<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment = unknown,
>(
  seed: RoomMutationStateSeed<TCar, TInput, TBall, TKickoffAssignment>,
): Readonly<RoomMutationState<TCar, TInput, TBall, TKickoffAssignment>> {
  const roster = freezeRoster(seed.roster);
  const occupancy = calculateOccupancy(roster);
  if (
    seed.occupancy !== undefined
    && (
      seed.occupancy.total !== occupancy.total
      || seed.occupancy.blue !== occupancy.blue
      || seed.occupancy.orange !== occupancy.orange
    )
  ) {
    throw new TypeError('Seed occupancy does not match the seed roster.');
  }

  const state = Object.freeze({
    revision: seed.revision ?? 0,
    policy: seed.policy,
    roster,
    nextJoinOrdinal: seed.nextJoinOrdinal,
    hostSessionId: seed.hostSessionId,
    occupancy,
    phase: seed.phase,
    countdownKind: seed.countdownKind,
    countdownStepsRemaining: seed.countdownStepsRemaining,
    blueScore: seed.blueScore,
    orangeScore: seed.orangeScore,
    regulationStepsRemaining: seed.regulationStepsRemaining,
    ball: seed.ball,
    cars: Object.freeze(new Map(seed.cars)),
    inputs: Object.freeze(new Map(seed.inputs)),
    kickoffAssignments: Object.freeze(new Map(seed.kickoffAssignments ?? [])),
    tombstones: Object.freeze(new Set(seed.tombstones ?? [])),
  }) satisfies Readonly<RoomMutationState<TCar, TInput, TBall, TKickoffAssignment>>;

  const invalid = stateValidationError(
    state as Readonly<RoomMutationState<unknown, unknown, unknown, unknown>>,
  );
  if (invalid !== null) throw new TypeError(invalid.message);
  return state;
}

/** Policy-specific start predicate, independent of countdown progression. */
export function isCapacityValidRoster(
  policy: RoomPolicy,
  roster: ReadonlyMap<string, Readonly<RosterEntry>>,
): boolean {
  let canonical: RoomPolicy;
  try {
    canonical = validateRoomPolicy(policy);
  } catch {
    return false;
  }
  const occupancy = calculateOccupancy(roster);
  if (
    occupancy.total > canonical.totalCapacity
    || occupancy.blue > canonical.teamCapacity
    || occupancy.orange > canonical.teamCapacity
  ) {
    return false;
  }
  if (canonical.startRule === 'full-balanced') {
    return occupancy.total === canonical.totalCapacity
      && occupancy.blue === canonical.teamCapacity
      && occupancy.orange === canonical.teamCapacity;
  }
  return occupancy.total > 0;
}

function createPlan<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment,
>(
  requestKind: RoomMutationRequest['kind'],
  internal: InternalPlan<TCar, TInput, TBall, TKickoffAssignment>,
): RoomMutationPlan {
  return Object.freeze({
    requestKind,
    effect: internal.effect,
    [INTERNAL_PLAN]: internal,
  } satisfies OpaquePlan<TCar, TInput, TBall, TKickoffAssignment>);
}

/**
 * Plan and validate a mutation without creating a body or changing authoritative
 * state. The returned plan deliberately exposes no candidate roster.
 */
export function planRoomMutation<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment = unknown,
>(
  state: Readonly<RoomMutationState<TCar, TInput, TBall, TKickoffAssignment>>,
  request: RoomMutationRequest,
  context: RoomMutationPlanningContext,
): RoomMutationPlanningResult {
  const invalid = stateValidationError(
    state as Readonly<RoomMutationState<unknown, unknown, unknown, unknown>>,
  );
  if (invalid !== null) return invalid;

  const policy = state.policy;

  if (request.kind === 'join') {
    if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
      return reject('not-represented', 'Join identity must be a non-empty string.');
    }
    if (state.roster.has(request.sessionId)) {
      return reject('duplicate-identity', `Identity ${request.sessionId} is already represented.`);
    }
    if (state.occupancy.total >= policy.totalCapacity) {
      return reject('total-capacity', `${policy.mode} room is at total capacity.`);
    }
    if (state.phase !== 'waiting') {
      return reject('wrong-phase', 'Joins are accepted only while the room is waiting.');
    }
    if (typeof request.name !== 'string') {
      return reject('not-represented', 'Join display name must be a string.');
    }
    if (context.physicsReady !== true) {
      return reject('physics-not-ready', 'An authoritative body cannot be prepared yet.');
    }
    if (state.nextJoinOrdinal === Number.MAX_SAFE_INTEGER) {
      return reject('invalid-roster', 'Stable roster ordinal space is exhausted.');
    }

    const assignment = assignTeamsInStableRosterOrder(
      policy,
      stableRosterEntries(state.roster),
      [{ sessionId: request.sessionId, acceptedJoinOrdinal: state.nextJoinOrdinal }],
    ).assignments[0];
    if (assignment === undefined) {
      return reject('total-capacity', 'No team capacity remains for the joining identity.');
    }

    const isHost = policy.mode === 'custom' && state.roster.size === 0;
    const entry = freezeRosterEntry({
      sessionId: request.sessionId,
      acceptedJoinOrdinal: state.nextJoinOrdinal,
      team: assignment.team,
      name: request.name,
      isHost,
    });
    const roster = new Map(state.roster);
    roster.set(entry.sessionId, entry);
    const hostSessionId = isHost ? entry.sessionId : state.hostSessionId;
    const tombstones = new Set(state.tombstones);
    tombstones.delete(entry.sessionId);
    const effect = Object.freeze({ kind: 'joined', entry } as const);

    return Object.freeze({
      ok: true,
      plan: createPlan(request.kind, {
        base: state,
        effect,
        roster,
        nextJoinOrdinal: state.nextJoinOrdinal + 1,
        hostSessionId,
        occupancy: calculateOccupancy(roster),
        kickoffAssignments: state.kickoffAssignments,
        tombstones,
        operation: { kind: 'join', entry },
      }),
    });
  }

  const represented = state.roster.get(request.sessionId);
  if (represented === undefined) {
    return reject('not-represented', `Identity ${request.sessionId} is not represented.`);
  }

  if (request.kind === 'leave') {
    const car = state.cars.get(request.sessionId);
    if (car === undefined) {
      return reject('invalid-roster', `Identity ${request.sessionId} has no authoritative car.`);
    }

    const roster = new Map(state.roster);
    roster.delete(request.sessionId);
    let hostSessionId = state.hostSessionId;

    if (policy.mode === 'custom' && represented.isHost) {
      const successor = stableRosterEntries(roster)[0] ?? null;
      hostSessionId = successor?.sessionId ?? null;
      for (const [sessionId, entry] of roster) {
        roster.set(sessionId, freezeRosterEntry({
          ...entry,
          isHost: sessionId === hostSessionId,
        }));
      }
    }

    const tombstones = new Set(state.tombstones);
    tombstones.add(request.sessionId);
    const kickoffAssignments = roster.size === 0
      ? new Map<string, TKickoffAssignment>()
      : state.kickoffAssignments;
    const effect = Object.freeze({
      kind: 'left',
      sessionId: request.sessionId,
      successorHostSessionId: hostSessionId,
    } as const);

    return Object.freeze({
      ok: true,
      plan: createPlan(request.kind, {
        base: state,
        effect,
        roster,
        nextJoinOrdinal: state.nextJoinOrdinal,
        hostSessionId,
        occupancy: calculateOccupancy(roster),
        kickoffAssignments,
        tombstones,
        operation: { kind: 'leave', entry: represented, car },
      }),
    });
  }

  if (request.kind === 'switch-team') {
    if (state.phase !== 'waiting') {
      return reject('wrong-phase', 'Team switches are accepted only while the room is waiting.');
    }
    if (!policy.allowWaitingTeamSwitch || !isTeam(request.team) || request.team === represented.team) {
      return reject('not-opposite-team', 'A switch must target the represented player\'s opposite team.');
    }
    if (state.occupancy[request.team] >= policy.teamCapacity) {
      return reject('team-capacity', `${request.team} team is at capacity.`);
    }

    const roster = new Map(state.roster);
    roster.set(request.sessionId, freezeRosterEntry({ ...represented, team: request.team }));
    const effect = Object.freeze({
      kind: 'team-switched',
      sessionId: request.sessionId,
      from: represented.team,
      to: request.team,
    } as const);

    return Object.freeze({
      ok: true,
      plan: createPlan(request.kind, {
        base: state,
        effect,
        roster,
        nextJoinOrdinal: state.nextJoinOrdinal,
        hostSessionId: state.hostSessionId,
        occupancy: calculateOccupancy(roster),
        kickoffAssignments: state.kickoffAssignments,
        tombstones: state.tombstones,
        operation: { kind: 'logical-only' },
      }),
    });
  }

  if (state.phase !== 'waiting') {
    return reject('wrong-phase', 'A match can start only while the room is waiting.');
  }
  if (
    policy.startRule !== 'host-request'
    || state.hostSessionId !== request.sessionId
    || !represented.isHost
  ) {
    return reject('not-host', 'Only the represented Custom Room Host may request start.');
  }
  if (!isCapacityValidRoster(policy, state.roster)) {
    return reject('invalid-roster', 'The current roster is not valid for match start.');
  }
  if (context.physicsReady !== true) {
    return reject('physics-not-ready', 'The authoritative world is not ready to start.');
  }

  const effect = Object.freeze({ kind: 'start-validated', sessionId: request.sessionId } as const);
  return Object.freeze({
    ok: true,
    plan: createPlan(request.kind, {
      base: state,
      effect,
      roster: state.roster,
      nextJoinOrdinal: state.nextJoinOrdinal,
      hostSessionId: state.hostSessionId,
      occupancy: state.occupancy,
      kickoffAssignments: state.kickoffAssignments,
      tombstones: state.tombstones,
      operation: { kind: 'logical-only' },
    }),
  });
}

class TrackedPreparationScope implements RoomMutationPreparationScope {
  private disposers: Array<() => void> = [];
  private readonly trackedResources = new Set<unknown>();

  has(resource: unknown): boolean {
    return this.trackedResources.has(resource);
  }

  track<T>(resource: T, dispose: (resource: T) => void): T {
    if (typeof dispose !== 'function') throw new TypeError('Resource disposer must be a function.');
    this.trackedResources.add(resource);
    this.disposers.push(() => dispose(resource));
    return resource;
  }

  release(): void {
    this.disposers = [];
    this.trackedResources.clear();
  }

  rollback(): void {
    const errors: unknown[] = [];
    for (const dispose of this.disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.disposers = [];
    this.trackedResources.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Multiple resource disposals failed.');
  }
}

function rollbackCause(scope: TrackedPreparationScope, cause: unknown): unknown {
  try {
    scope.rollback();
    return cause;
  } catch (cleanupError) {
    return new AggregateError([cause, cleanupError], 'Preparation and rollback both failed.');
  }
}

function makeNextState<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment,
>(
  plan: InternalPlan<TCar, TInput, TBall, TKickoffAssignment>,
  cars: ReadonlyMap<string, TCar>,
  inputs: ReadonlyMap<string, TInput>,
): Readonly<RoomMutationState<TCar, TInput, TBall, TKickoffAssignment>> {
  const base = plan.base;
  return createRoomMutationState({
    revision: base.revision + 1,
    policy: base.policy,
    roster: plan.roster,
    nextJoinOrdinal: plan.nextJoinOrdinal,
    hostSessionId: plan.hostSessionId,
    occupancy: plan.occupancy,
    phase: base.phase,
    countdownKind: base.countdownKind,
    countdownStepsRemaining: base.countdownStepsRemaining,
    blueScore: base.blueScore,
    orangeScore: base.orangeScore,
    regulationStepsRemaining: base.regulationStepsRemaining,
    ball: base.ball,
    cars,
    inputs,
    kickoffAssignments: plan.kickoffAssignments,
    tombstones: plan.tombstones,
  });
}

class PreparedRoomMutationImpl<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment,
> implements PreparedRoomMutation<TCar, TInput, TBall, TKickoffAssignment> {
  private isSettled = false;

  constructor(
    readonly effect: RoomMutationEffect,
    private readonly base: Readonly<RoomMutationState<TCar, TInput, TBall, TKickoffAssignment>>,
    private readonly next: Readonly<RoomMutationState<TCar, TInput, TBall, TKickoffAssignment>>,
    private readonly scope: TrackedPreparationScope,
    private readonly ownership: 'transfer-on-commit' | 'temporary-only',
    private readonly commitRemoval: (() => void) | null,
  ) {}

  get settled(): boolean {
    return this.isSettled;
  }

  commit(
    current: Readonly<RoomMutationState<TCar, TInput, TBall, TKickoffAssignment>>,
  ): RoomMutationCommitResult<TCar, TInput, TBall, TKickoffAssignment> {
    if (this.isSettled) {
      throw new RoomMutationCommitError('A prepared room mutation can be settled only once.');
    }
    if (current !== this.base) {
      this.isSettled = true;
      const cause = rollbackCause(this.scope, new Error('Prepared mutation base state is stale.'));
      return reject('invalid-roster', 'Prepared mutation base state is stale.', cause);
    }

    try {
      this.commitRemoval?.();
      if (this.ownership === 'transfer-on-commit') this.scope.release();
      else this.scope.rollback();
      this.isSettled = true;
      return Object.freeze({ ok: true, next: this.next, effect: this.effect });
    } catch (error) {
      this.isSettled = true;
      const cause = rollbackCause(this.scope, error);
      throw new RoomMutationCommitError(
        'Authoritative body removal failed; the room must stop snapshots and dispose its world.',
        cause,
      );
    }
  }

  abort(): void {
    if (this.isSettled) return;
    this.isSettled = true;
    try {
      this.scope.rollback();
    } catch (error) {
      throw new RoomMutationCommitError('Prepared room resource disposal failed.', error);
    }
  }
}

function isPreparedJoinResources<TCar, TInput>(
  value: unknown,
): value is PreparedJoinResources<TCar, TInput> {
  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as Partial<PreparedJoinResources<TCar, TInput>>;
  return Object.prototype.hasOwnProperty.call(value, 'car')
    && Object.prototype.hasOwnProperty.call(value, 'input')
    && candidate.car !== null
    && candidate.car !== undefined
    && candidate.input !== null
    && candidate.input !== undefined;
}

/**
 * Prepare body resources against the old state, then construct a fully valid
 * candidate off to the side. No logical identity is exposed until commit.
 */
export function prepareRoomMutation<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment = unknown,
>(
  publicPlan: RoomMutationPlan,
  resources: RoomMutationResourcePreparer<TCar, TInput> = {},
): RoomMutationPreparationResult<TCar, TInput, TBall, TKickoffAssignment> {
  const opaque = publicPlan as OpaquePlan<TCar, TInput, TBall, TKickoffAssignment>;
  const plan = opaque[INTERNAL_PLAN];
  if (plan === undefined) {
    return reject('invalid-roster', 'Room mutation plan was not created by this service.');
  }

  const scope = new TrackedPreparationScope();
  let cars = new Map(plan.base.cars);
  let inputs = new Map(plan.base.inputs);
  let ownership: 'transfer-on-commit' | 'temporary-only' = 'temporary-only';
  let commitRemoval: (() => void) | null = null;

  try {
    if (plan.operation.kind === 'join') {
      if (resources.prepareJoin === undefined) {
        return reject('physics-not-ready', 'No authoritative car preparer is available.');
      }
      const prepared = resources.prepareJoin(
        { policy: plan.base.policy, entry: plan.operation.entry },
        scope,
      );
      if (!isPreparedJoinResources<TCar, TInput>(prepared) || !scope.has(prepared.car)) {
        throw new TypeError(
          'Join preparation must return non-null car/input resources and track the returned car ownership.',
        );
      }
      cars.set(plan.operation.entry.sessionId, prepared.car);
      inputs.set(plan.operation.entry.sessionId, prepared.input);
      ownership = 'transfer-on-commit';
    } else if (plan.operation.kind === 'leave') {
      if (resources.prepareLeave === undefined) {
        return reject('physics-not-ready', 'No authoritative car-removal preparer is available.');
      }
      const prepared = resources.prepareLeave(
        {
          policy: plan.base.policy,
          entry: plan.operation.entry,
          car: plan.operation.car,
        },
        scope,
      );
      if (typeof prepared?.commitRemoval !== 'function') {
        throw new TypeError('Leave preparation must return a body-removal commit function.');
      }
      commitRemoval = prepared.commitRemoval;
      cars.delete(plan.operation.entry.sessionId);
      inputs.delete(plan.operation.entry.sessionId);
    }

    const next = makeNextState(plan, cars, inputs);
    return Object.freeze({
      ok: true,
      prepared: new PreparedRoomMutationImpl(
        plan.effect,
        plan.base,
        next,
        scope,
        ownership,
        commitRemoval,
      ),
    });
  } catch (error) {
    return reject(
      'physics-not-ready',
      'Authoritative room resource preparation failed.',
      rollbackCause(scope, error),
    );
  }
}

/**
 * Immediately gate a disconnecting identity from input and snapshot consumers
 * while its queued leave transaction prepares body removal.
 */
export function tombstoneRoomIdentity<
  TCar,
  TInput,
  TBall,
  TKickoffAssignment = unknown,
>(
  state: Readonly<RoomMutationState<TCar, TInput, TBall, TKickoffAssignment>>,
  sessionId: string,
): RoomMutationCommitResult<TCar, TInput, TBall, TKickoffAssignment> {
  const invalid = stateValidationError(
    state as Readonly<RoomMutationState<unknown, unknown, unknown, unknown>>,
  );
  if (invalid !== null) return invalid;
  if (!state.roster.has(sessionId)) {
    return reject('not-represented', `Identity ${sessionId} is not represented.`);
  }
  if (state.tombstones.has(sessionId)) {
    return Object.freeze({
      ok: true,
      next: state,
      effect: Object.freeze({
        kind: 'left',
        sessionId,
        successorHostSessionId: state.hostSessionId,
      }),
    });
  }

  const tombstones = new Set(state.tombstones);
  tombstones.add(sessionId);
  const next = createRoomMutationState({
    ...state,
    revision: state.revision + 1,
    roster: state.roster,
    cars: state.cars,
    inputs: state.inputs,
    kickoffAssignments: state.kickoffAssignments,
    tombstones,
  });
  return Object.freeze({
    ok: true,
    next,
    effect: Object.freeze({
      kind: 'left',
      sessionId,
      successorHostSessionId: state.hostSessionId,
    }),
  });
}

export function canAcceptRoomInput(
  state: Readonly<RoomMutationState<unknown, unknown, unknown, unknown>>,
  sessionId: string,
): boolean {
  return state.roster.has(sessionId) && !state.tombstones.has(sessionId);
}

/** Stable snapshot projection excludes tombstoned disconnects immediately. */
export function visibleRosterEntries(
  state: Readonly<RoomMutationState<unknown, unknown, unknown, unknown>>,
): readonly Readonly<RosterEntry>[] {
  return Object.freeze(
    stableRosterEntries(state.roster).filter(({ sessionId }) => !state.tombstones.has(sessionId)),
  );
}

/** Canonical policies are referenced here so bundlers retain policy validation. */
void ROOM_POLICIES;
