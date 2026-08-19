import {
  ARENA_GEOMETRY_SPEC,
  KICKOFF_SLOTS,
  createKickoffArenaBounds,
  resolveCarColliderDimensions,
  validateKickoffSlotTable,
  type CarColliderDimensions,
  type KickoffArenaBounds,
  type KickoffSlot,
  type KickoffSlotId,
  type KickoffSlotIndex,
  type KickoffSlotTable,
  type RegistryEntrySource,
  type RoomPolicy,
  type RosterEntry,
  type Team,
} from '@rocket-arena/shared';

type Vector3Tuple = KickoffSlot['position'];
type QuaternionTuple = KickoffSlot['rotation'];

const OVERLAP_EPSILON = 1e-10;

export type KickoffAssignmentErrorCode =
  | 'invalid-roster'
  | 'invalid-slot-table'
  | 'incomplete-bijection'
  | 'overlapping-spawn'
  | 'stale-transaction';

export class InvalidKickoffAssignmentError extends Error {
  readonly code: KickoffAssignmentErrorCode;

  constructor(code: KickoffAssignmentErrorCode, message: string, options?: ErrorOptions) {
    super(`[KickoffAssignment:${code}] ${message}`, options);
    this.name = 'InvalidKickoffAssignmentError';
    this.code = code;
  }
}

export interface KickoffAssignment {
  readonly sessionId: string;
  readonly team: Team;
  readonly slotId: KickoffSlotId;
  readonly slotIndex: KickoffSlotIndex;
  readonly position: Vector3Tuple;
  readonly rotation: QuaternionTuple;
}

export interface KickoffAssignmentSet {
  /** The epoch that will become active when this kickoff countdown completes. */
  readonly epoch: number;
  /** Identity, team, and team-local Stable_Roster_Order fingerprint. */
  readonly rosterSignature: string;
  readonly assignments: ReadonlyMap<string, Readonly<KickoffAssignment>>;
}

export interface PreparedKickoffAssignmentReplacement {
  readonly candidate: Readonly<KickoffAssignmentSet>;
  readonly reusedAssignments: boolean;
  readonly settled: boolean;
  commit(): Readonly<KickoffAssignmentSet>;
  abort(): void;
}

export type KickoffAssignmentPreparationResult =
  | {
    readonly ok: true;
    readonly prepared: PreparedKickoffAssignmentReplacement;
  }
  | {
    readonly ok: false;
    readonly code: KickoffAssignmentErrorCode;
    readonly message: string;
    readonly cause?: unknown;
    readonly retained: Readonly<KickoffAssignmentSet> | null;
  };

export interface KickoffAssignmentServiceOptions {
  readonly policy: RoomPolicy;
  readonly tuningRegistry: RegistryEntrySource;
  readonly slots?: KickoffSlotTable;
  readonly arenaBounds?: KickoffArenaBounds;
}

interface OrientedBox {
  readonly center: Vector3Tuple;
  /** Local X/Y/Z axes expressed in world space. */
  readonly axes: readonly [Vector3Tuple, Vector3Tuple, Vector3Tuple];
  /** Width/height/length half extents corresponding to local X/Y/Z. */
  readonly halfExtents: Vector3Tuple;
}

/**
 * A runtime-read-only map view. `ReadonlyMap` alone is only a TypeScript
 * constraint, while exposing a frozen native Map would still allow set/delete.
 */
class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: K): V | undefined {
    return this.#values.get(key);
  }

  has(key: K): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#values.entries();
  }

  keys(): MapIterator<K> {
    return this.#values.keys();
  }

  values(): MapIterator<V> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    this.#values.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

function isReadonlyMap(value: unknown): value is ReadonlyMap<unknown, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as ReadonlyMap<unknown, unknown>;
  return Number.isSafeInteger(candidate.size)
    && candidate.size >= 0
    && typeof candidate.get === 'function'
    && typeof candidate.has === 'function'
    && typeof candidate.entries === 'function'
    && typeof candidate[Symbol.iterator] === 'function';
}

function fail(
  code: KickoffAssignmentErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new InvalidKickoffAssignmentError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isTeam(value: unknown): value is Team {
  return value === 'blue' || value === 'orange';
}

function stableRosterCompare(
  left: Pick<RosterEntry, 'acceptedJoinOrdinal' | 'sessionId'>,
  right: Pick<RosterEntry, 'acceptedJoinOrdinal' | 'sessionId'>,
): number {
  return left.acceptedJoinOrdinal - right.acceptedJoinOrdinal
    || left.sessionId.localeCompare(right.sessionId);
}

function freezeVector3(value: readonly number[]): Vector3Tuple {
  return Object.freeze([value[0], value[1], value[2]]) as Vector3Tuple;
}

function freezeQuaternion(value: readonly number[]): QuaternionTuple {
  return Object.freeze([value[0], value[1], value[2], value[3]]) as QuaternionTuple;
}

function normalizeQuaternion(value: QuaternionTuple): QuaternionTuple {
  const magnitude = Math.hypot(value[0], value[1], value[2], value[3]);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    fail('invalid-slot-table', 'Kickoff assignment rotations must be finite non-zero quaternions.');
  }
  return freezeQuaternion(value.map((component) => component / magnitude));
}

function quaternionAxes(rotation: QuaternionTuple): readonly [Vector3Tuple, Vector3Tuple, Vector3Tuple] {
  const [x, y, z, w] = normalizeQuaternion(rotation);
  return Object.freeze([
    freezeVector3([
      1 - 2 * (y * y + z * z),
      2 * (x * y + z * w),
      2 * (x * z - y * w),
    ]),
    freezeVector3([
      2 * (x * y - z * w),
      1 - 2 * (x * x + z * z),
      2 * (y * z + x * w),
    ]),
    freezeVector3([
      2 * (x * z + y * w),
      2 * (y * z - x * w),
      1 - 2 * (x * x + y * y),
    ]),
  ] as const);
}

function dot(left: Vector3Tuple, right: Vector3Tuple): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function subtract(left: Vector3Tuple, right: Vector3Tuple): Vector3Tuple {
  return freezeVector3([
    left[0] - right[0],
    left[1] - right[1],
    left[2] - right[2],
  ]);
}

function assignmentBox(
  assignment: Pick<KickoffAssignment, 'position' | 'rotation'>,
  dimensions: CarColliderDimensions,
): OrientedBox {
  return Object.freeze({
    center: assignment.position,
    axes: quaternionAxes(assignment.rotation),
    halfExtents: freezeVector3([
      dimensions.width / 2,
      dimensions.height / 2,
      dimensions.length / 2,
    ]),
  });
}

/**
 * Full 15-axis separating-axis test for two independently oriented cuboids.
 * Touching volumes count as overlapping because Unique_Spawn requires a gap.
 */
export function orientedBoxesOverlap(left: OrientedBox, right: OrientedBox): boolean {
  const rotation = Array.from({ length: 3 }, () => [0, 0, 0]);
  const absolute = Array.from({ length: 3 }, () => [0, 0, 0]);

  for (let leftAxis = 0; leftAxis < 3; leftAxis += 1) {
    for (let rightAxis = 0; rightAxis < 3; rightAxis += 1) {
      const value = dot(left.axes[leftAxis]!, right.axes[rightAxis]!);
      rotation[leftAxis]![rightAxis] = value;
      absolute[leftAxis]![rightAxis] = Math.abs(value) + OVERLAP_EPSILON;
    }
  }

  const centerDelta = subtract(right.center, left.center);
  const translation = left.axes.map((axis) => dot(centerDelta, axis));

  for (let axis = 0; axis < 3; axis += 1) {
    const leftRadius = left.halfExtents[axis];
    const rightRadius = right.halfExtents[0] * absolute[axis]![0]!
      + right.halfExtents[1] * absolute[axis]![1]!
      + right.halfExtents[2] * absolute[axis]![2]!;
    if (Math.abs(translation[axis]!) > leftRadius + rightRadius) return false;
  }

  for (let axis = 0; axis < 3; axis += 1) {
    const leftRadius = left.halfExtents[0] * absolute[0]![axis]!
      + left.halfExtents[1] * absolute[1]![axis]!
      + left.halfExtents[2] * absolute[2]![axis]!;
    const rightRadius = right.halfExtents[axis];
    const projected = Math.abs(
      translation[0]! * rotation[0]![axis]!
      + translation[1]! * rotation[1]![axis]!
      + translation[2]! * rotation[2]![axis]!,
    );
    if (projected > leftRadius + rightRadius) return false;
  }

  for (let leftAxis = 0; leftAxis < 3; leftAxis += 1) {
    for (let rightAxis = 0; rightAxis < 3; rightAxis += 1) {
      const nextLeft = (leftAxis + 1) % 3;
      const finalLeft = (leftAxis + 2) % 3;
      const nextRight = (rightAxis + 1) % 3;
      const finalRight = (rightAxis + 2) % 3;
      const leftRadius = left.halfExtents[nextLeft] * absolute[finalLeft]![rightAxis]!
        + left.halfExtents[finalLeft] * absolute[nextLeft]![rightAxis]!;
      const rightRadius = right.halfExtents[nextRight] * absolute[leftAxis]![finalRight]!
        + right.halfExtents[finalRight] * absolute[leftAxis]![nextRight]!;
      const projected = Math.abs(
        translation[finalLeft]! * rotation[nextLeft]![rightAxis]!
        - translation[nextLeft]! * rotation[finalLeft]![rightAxis]!,
      );
      if (projected > leftRadius + rightRadius) return false;
    }
  }

  return true;
}

function validateRoster(
  roster: readonly Readonly<RosterEntry>[],
  policy: RoomPolicy,
): readonly Readonly<RosterEntry>[] {
  if (!Array.isArray(roster) || roster.length === 0) {
    fail('invalid-roster', 'A kickoff requires at least one represented roster identity.');
  }
  if (roster.length > policy.totalCapacity) {
    fail('invalid-roster', `Roster exceeds ${policy.mode} total capacity.`);
  }

  const identities = new Set<string>();
  let blue = 0;
  let orange = 0;
  for (const entry of roster) {
    if (typeof entry !== 'object' || entry === null
      || typeof entry.sessionId !== 'string' || entry.sessionId.length === 0
      || identities.has(entry.sessionId)
      || !Number.isSafeInteger(entry.acceptedJoinOrdinal)
      || entry.acceptedJoinOrdinal < 0
      || !isTeam(entry.team)) {
      fail('invalid-roster', 'Kickoff roster identities, teams, and stable ordinals must be valid and unique.');
    }
    identities.add(entry.sessionId);
    if (entry.team === 'blue') blue += 1;
    else orange += 1;
  }
  if (blue > policy.teamCapacity || orange > policy.teamCapacity) {
    fail('invalid-roster', `Roster exceeds ${policy.mode} team capacity.`);
  }

  return Object.freeze([...roster].sort(stableRosterCompare));
}

function rosterSignature(roster: readonly Readonly<RosterEntry>[]): string {
  const teamLocal = (team: Team) => roster
    .filter((entry) => entry.team === team)
    .sort(stableRosterCompare)
    .map((entry) => [entry.sessionId, entry.acceptedJoinOrdinal, entry.team]);
  return JSON.stringify({ blue: teamLocal('blue'), orange: teamLocal('orange') });
}

function assignmentFromSlot(entry: Readonly<RosterEntry>, slot: KickoffSlot): KickoffAssignment {
  return Object.freeze({
    sessionId: entry.sessionId,
    team: entry.team,
    slotId: slot.id,
    slotIndex: slot.index,
    position: freezeVector3(slot.position),
    rotation: freezeQuaternion(slot.rotation),
  });
}

function exactFiniteNumericTupleEquals(
  left: readonly number[],
  right: readonly number[],
  expectedLength: number,
): boolean {
  if (!Array.isArray(left)
    || !Array.isArray(right)
    || left.length !== expectedLength
    || right.length !== expectedLength) {
    return false;
  }

  for (let index = 0; index < expectedLength; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(left, index)
      || !Object.prototype.hasOwnProperty.call(right, index)
      || typeof left[index] !== 'number'
      || typeof right[index] !== 'number'
      || !Number.isFinite(left[index])
      || !Number.isFinite(right[index])
      || left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function snapshotKickoffSlot(slot: KickoffSlot): KickoffSlot {
  return Object.freeze({
    id: slot.id,
    index: slot.index,
    team: slot.team,
    position: freezeVector3(slot.position),
    rotation: freezeQuaternion(slot.rotation),
  });
}

function snapshotKickoffSlotTable(slots: KickoffSlotTable): KickoffSlotTable {
  return Object.freeze({
    blue: Object.freeze(slots.blue.map(snapshotKickoffSlot)),
    orange: Object.freeze(slots.orange.map(snapshotKickoffSlot)),
  });
}

/**
 * Validate exact roster coverage, configured slot transforms, same-team
 * uniqueness, and full OBB separation.
 */
export function validateKickoffAssignmentBijection(
  assignments: ReadonlyMap<string, Readonly<KickoffAssignment>>,
  roster: readonly Readonly<RosterEntry>[],
  policy: RoomPolicy,
  dimensions: CarColliderDimensions,
  slots: KickoffSlotTable,
): void {
  const orderedRoster = validateRoster(roster, policy);
  if (!isReadonlyMap(assignments) || assignments.size !== orderedRoster.length) {
    fail('incomplete-bijection', 'Kickoff assignments must cover the roster exactly once.');
  }

  const rosterById = new Map(orderedRoster.map((entry) => [entry.sessionId, entry]));
  const expectedSlotIndexById = new Map<string, number>();
  for (const team of ['blue', 'orange'] as const) {
    orderedRoster
      .filter((entry) => entry.team === team)
      .sort(stableRosterCompare)
      .forEach((entry, index) => expectedSlotIndexById.set(entry.sessionId, index));
  }

  const usedSlots = new Set<string>();
  for (const [sessionId, assignment] of assignments) {
    const entry = rosterById.get(sessionId);
    const expectedSlotIndex = expectedSlotIndexById.get(sessionId);
    if (
      entry === undefined
      || expectedSlotIndex === undefined
      || typeof assignment !== 'object'
      || assignment === null
      || assignment.sessionId !== sessionId
    ) {
      fail('incomplete-bijection', `Assignment ${sessionId} does not identify a current roster member.`);
    }

    const expectedSlot = slots?.[entry.team]?.[expectedSlotIndex];
    if (
      expectedSlot === undefined
      || expectedSlot.team !== entry.team
      || expectedSlot.index !== expectedSlotIndex
      || expectedSlot.id !== `${entry.team}-${expectedSlotIndex}`
    ) {
      fail(
        'invalid-slot-table',
        `Configured ${entry.team} slot ${expectedSlotIndex} is missing or has inconsistent metadata.`,
      );
    }
    if (assignment.team !== entry.team
      || assignment.slotIndex !== expectedSlotIndex
      || assignment.slotId !== expectedSlot.id) {
      fail(
        'incomplete-bijection',
        `${sessionId} must receive ${entry.team} slot ${expectedSlotIndex} from team-local Stable_Roster_Order.`,
      );
    }
    if (
      !exactFiniteNumericTupleEquals(assignment.position, expectedSlot.position, 3)
      || !exactFiniteNumericTupleEquals(assignment.rotation, expectedSlot.rotation, 4)
    ) {
      fail(
        'incomplete-bijection',
        `${sessionId}/${assignment.slotId} must use the exact configured kickoff transform.`,
      );
    }
    if (usedSlots.has(assignment.slotId)) {
      fail('incomplete-bijection', `Kickoff slot ${assignment.slotId} is assigned more than once.`);
    }
    usedSlots.add(assignment.slotId);
  }
  for (const entry of orderedRoster) {
    if (!assignments.has(entry.sessionId)) {
      fail('incomplete-bijection', `Roster identity ${entry.sessionId} has no kickoff assignment.`);
    }
  }

  const orderedAssignments = [...assignments.values()]
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  for (let leftIndex = 0; leftIndex < orderedAssignments.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < orderedAssignments.length; rightIndex += 1) {
      const left = orderedAssignments[leftIndex]!;
      const right = orderedAssignments[rightIndex]!;
      if (orientedBoxesOverlap(
        assignmentBox(left, dimensions),
        assignmentBox(right, dimensions),
      )) {
        fail(
          'overlapping-spawn',
          `${left.sessionId}/${left.slotId} overlaps ${right.sessionId}/${right.slotId}.`,
        );
      }
    }
  }
}

function buildAssignmentSet(
  roster: readonly Readonly<RosterEntry>[],
  epoch: number,
  policy: RoomPolicy,
  slots: KickoffSlotTable,
  dimensions: CarColliderDimensions,
): Readonly<KickoffAssignmentSet> {
  const orderedRoster = validateRoster(roster, policy);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    fail('invalid-roster', 'Kickoff epoch must be a non-negative safe integer.');
  }

  const assignments = new Map<string, Readonly<KickoffAssignment>>();
  for (const team of ['blue', 'orange'] as const) {
    const teamEntries = orderedRoster
      .filter((entry) => entry.team === team)
      .sort(stableRosterCompare);
    teamEntries.forEach((entry, index) => {
      const slot = slots[team][index];
      if (slot === undefined) {
        fail('incomplete-bijection', `${team} roster index ${index} has no configured slot.`);
      }
      assignments.set(entry.sessionId, assignmentFromSlot(entry, slot));
    });
  }

  validateKickoffAssignmentBijection(
    assignments,
    orderedRoster,
    policy,
    dimensions,
    slots,
  );
  return Object.freeze({
    epoch,
    rosterSignature: rosterSignature(orderedRoster),
    assignments: new ImmutableMap(assignments),
  });
}

class PreparedReplacement implements PreparedKickoffAssignmentReplacement {
  private isSettled = false;

  constructor(
    readonly candidate: Readonly<KickoffAssignmentSet>,
    readonly reusedAssignments: boolean,
    private readonly assignmentSlots: KickoffSlotTable,
    private readonly expectedGeneration: number,
    private readonly service: DeterministicKickoffAssignmentService,
  ) {}

  get settled(): boolean {
    return this.isSettled;
  }

  commit(): Readonly<KickoffAssignmentSet> {
    if (this.isSettled) {
      fail('stale-transaction', 'A prepared kickoff replacement can be settled only once.');
    }
    this.isSettled = true;
    return this.service.commitPrepared(
      this.candidate,
      this.expectedGeneration,
      this.assignmentSlots,
    );
  }

  abort(): void {
    this.isSettled = true;
  }
}

/**
 * Room-local assignment cache. Candidate maps are complete and validated before
 * a transaction is returned; `current` changes only when that transaction is
 * explicitly committed after body placement succeeds.
 */
export class DeterministicKickoffAssignmentService {
  readonly policy: RoomPolicy;
  readonly tuningRegistry: RegistryEntrySource;
  readonly arenaBounds: KickoffArenaBounds;
  readonly slots: KickoffSlotTable;
  readonly colliderDimensions: CarColliderDimensions;

  private currentValue: Readonly<KickoffAssignmentSet> | null = null;
  private currentSlotsValue: KickoffSlotTable | null = null;
  private generation = 0;

  constructor(options: KickoffAssignmentServiceOptions) {
    this.policy = options.policy;
    this.tuningRegistry = options.tuningRegistry;
    this.arenaBounds = options.arenaBounds ?? createKickoffArenaBounds({
      width: ARENA_GEOMETRY_SPEC.width,
      length: ARENA_GEOMETRY_SPEC.length,
      ceilingHeight: ARENA_GEOMETRY_SPEC.ceilingHeight,
      floorHeight: ARENA_GEOMETRY_SPEC.floorY,
      centerX: ARENA_GEOMETRY_SPEC.center[0],
      centerZ: ARENA_GEOMETRY_SPEC.center[2],
    });
    this.slots = options.slots ?? KICKOFF_SLOTS;
    this.colliderDimensions = resolveCarColliderDimensions(this.tuningRegistry);
  }

  get current(): Readonly<KickoffAssignmentSet> | null {
    return this.currentValue;
  }

  prepare(
    roster: readonly Readonly<RosterEntry>[],
    epoch: number,
    candidateSlots: KickoffSlotTable = this.slots,
  ): KickoffAssignmentPreparationResult {
    try {
      const orderedRoster = validateRoster(roster, this.policy);
      const signature = rosterSignature(orderedRoster);
      const current = this.currentValue;
      let assignmentSlots: KickoffSlotTable;
      let candidate: Readonly<KickoffAssignmentSet>;

      if (current !== null && current.rosterSignature === signature) {
        if (this.currentSlotsValue === null) {
          fail('invalid-slot-table', 'A committed assignment map has no owned source slot table.');
        }
        assignmentSlots = this.currentSlotsValue;
        candidate = current.epoch === epoch
          ? current
          : Object.freeze({
            epoch,
            rosterSignature: signature,
            assignments: current.assignments,
          });
      } else {
        validateKickoffSlotTable(candidateSlots, {
          arenaBounds: this.arenaBounds,
          tuningRegistry: this.tuningRegistry,
        });
        assignmentSlots = snapshotKickoffSlotTable(candidateSlots);
        candidate = buildAssignmentSet(
          orderedRoster,
          epoch,
          this.policy,
          assignmentSlots,
          this.colliderDimensions,
        );
      }

      // Revalidate reused maps against their owned source table, current roster, and dimensions.
      validateKickoffAssignmentBijection(
        candidate.assignments,
        orderedRoster,
        this.policy,
        this.colliderDimensions,
        assignmentSlots,
      );

      return Object.freeze({
        ok: true,
        prepared: new PreparedReplacement(
          candidate,
          this.currentValue?.assignments === candidate.assignments,
          assignmentSlots,
          this.generation,
          this,
        ),
      });
    } catch (cause) {
      const error = cause instanceof InvalidKickoffAssignmentError
        ? cause
        : new InvalidKickoffAssignmentError(
          'invalid-slot-table',
          cause instanceof Error ? cause.message : String(cause),
          { cause },
        );
      return Object.freeze({
        ok: false,
        code: error.code,
        message: error.message,
        cause,
        retained: this.currentValue,
      });
    }
  }

  replace(
    roster: readonly Readonly<RosterEntry>[],
    epoch: number,
    candidateSlots: KickoffSlotTable = this.slots,
  ): KickoffAssignmentPreparationResult {
    const result = this.prepare(roster, epoch, candidateSlots);
    if (result.ok) result.prepared.commit();
    return result;
  }

  /** Internal transaction endpoint; exposed for the prepared object only. */
  commitPrepared(
    candidate: Readonly<KickoffAssignmentSet>,
    expectedGeneration: number,
    assignmentSlots: KickoffSlotTable,
  ): Readonly<KickoffAssignmentSet> {
    if (expectedGeneration !== this.generation) {
      fail('stale-transaction', 'Another kickoff replacement committed before this candidate.');
    }
    this.currentValue = candidate;
    this.currentSlotsValue = assignmentSlots;
    this.generation += 1;
    return candidate;
  }

  clear(): void {
    this.currentValue = null;
    this.currentSlotsValue = null;
    this.generation += 1;
  }
}
