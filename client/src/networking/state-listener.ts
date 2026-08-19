import * as THREE from 'three';
import type { Room } from 'colyseus.js';
import type { RoomMode } from '@rocket-arena/shared';
import { createCarMesh, type CarVisualRig } from '../renderer/car.js';
import { createBallMesh } from '../renderer/ball.js';
import {
  SnapshotBuffer,
  type EntitySnapshot,
  type InterpolationStats,
  type PreparedSnapshotAcceptance,
  type ValidatedTimelineSnapshot,
} from './interpolation-buffer.js';
import {
  acceptedSnapshotStore,
  type AcceptedSnapshotGeneration,
  type AcceptedSnapshotState,
} from './accepted-snapshot-store.js';
import {
  decodeSnapshot,
  type DomainSnapshot,
  type SnapshotValidationResult,
} from './snapshot-validator.js';

const BALL_ENTITY_ID = 'ball';
const PLAYER_ENTITY_PREFIX = 'player:';

let carMeshes: Map<string, THREE.Group> = new Map();
const snapshotBuffer = new SnapshotBuffer();
let ballMesh: THREE.Group | null = null;
let localState: Readonly<StateSync> | null = null;
let listenerGeneration = 0;
let arrivalMetrics: SnapshotArrivalMetrics = emptyArrivalMetrics();
let appliedRenderFrames = 0;

export interface StateEntity {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly qx: number;
  readonly qy: number;
  readonly qz: number;
  readonly qw: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
}

export interface StatePlayer extends StateEntity {
  readonly boost: number;
  readonly team: string;
  readonly name: string;
  readonly isHost: boolean;
}

export interface StateSync {
  readonly sequence: number;
  readonly serverTime: number;
  readonly simulationTime: number;
  readonly players: Readonly<Record<string, Readonly<StatePlayer>>>;
  readonly ball: Readonly<StateEntity>;
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly timeRemaining: number;
  readonly phase: string;
}

export interface StateListenerOptions {
  /** Explicit mode seam; production can derive arena=>quick and custom=>custom. */
  readonly roomMode?: RoomMode;
  /** Test seam for deterministic preparation failures; production uses createCarMesh. */
  readonly carMeshFactory?: (team: string) => THREE.Group;
  /** Test seam that avoids constructing the production ball model. */
  readonly ballMeshFactory?: () => THREE.Group;
  /** Test seam for deterministic arrival-time and interpolation assertions. */
  readonly clock?: () => number;
}

export interface RuntimeInterpolationStats extends InterpolationStats {
  readonly averageSnapshotIntervalMs: number;
  readonly maximumSnapshotIntervalMs: number;
  readonly snapshotRateHz: number;
  readonly appliedRenderFrames: number;
}

interface SnapshotArrivalMetrics {
  readonly lastArrivalMs: number | null;
  readonly intervalTotalMs: number;
  readonly intervalCount: number;
  readonly maximumIntervalMs: number;
}

interface PreparedCarAddition {
  readonly sessionId: string;
  readonly team: string;
  readonly mesh: THREE.Group;
}

interface PreparedCarRemoval {
  readonly sessionId: string;
  readonly mesh: THREE.Group;
}

interface PreparedReconciliation {
  readonly additions: readonly PreparedCarAddition[];
  readonly removals: readonly PreparedCarRemoval[];
  readonly nextMeshes: Map<string, THREE.Group>;
  readonly nextLocalState: Readonly<StateSync>;
  readonly nextArrivalMetrics: SnapshotArrivalMetrics;
  readonly preparedBall: THREE.Group | null;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function emptyArrivalMetrics(): SnapshotArrivalMetrics {
  return Object.freeze({
    lastArrivalMs: null,
    intervalTotalMs: 0,
    intervalCount: 0,
    maximumIntervalMs: 0,
  });
}

function nextArrivalMetrics(
  current: SnapshotArrivalMetrics,
  arrivalMs: number,
): SnapshotArrivalMetrics {
  if (current.lastArrivalMs === null) {
    return Object.freeze({ ...current, lastArrivalMs: arrivalMs });
  }

  const interval = Math.max(0, arrivalMs - current.lastArrivalMs);
  return Object.freeze({
    lastArrivalMs: arrivalMs,
    intervalTotalMs: current.intervalTotalMs + interval,
    intervalCount: current.intervalCount + 1,
    maximumIntervalMs: Math.max(current.maximumIntervalMs, interval),
  });
}

function disposeCarEffects(car: THREE.Group): void {
  const rig = car.userData.visualRig as CarVisualRig | undefined;
  if (!rig) return;
  for (const effect of [...rig.boostFlames, ...rig.boostTrails]) {
    const materials = Array.isArray(effect.material) ? effect.material : [effect.material];
    materials.forEach((material) => material.dispose());
  }
}

function disposeObjectResources(root: THREE.Object3D): void {
  root.traverse((object) => {
    const renderable = object as THREE.Mesh | THREE.LineSegments | THREE.Points;
    if (renderable.geometry instanceof THREE.BufferGeometry) {
      renderable.geometry.dispose();
    }
    if ('material' in renderable && renderable.material) {
      const materials = Array.isArray(renderable.material)
        ? renderable.material
        : [renderable.material];
      materials.forEach((material) => material.dispose());
    }
  });
}

function resetInterpolationState(): void {
  snapshotBuffer.reset();
  arrivalMetrics = emptyArrivalMetrics();
  appliedRenderFrames = 0;
}

function cleanupEntityMeshes(): void {
  for (const car of carMeshes.values()) {
    car.removeFromParent();
    disposeCarEffects(car);
  }
  carMeshes = new Map();

  if (ballMesh) {
    ballMesh.removeFromParent();
    disposeObjectResources(ballMesh);
    ballMesh = null;
  }

  localState = null;
  resetInterpolationState();
}

function resetAcceptedSnapshotStore(): AcceptedSnapshotGeneration {
  const current = acceptedSnapshotStore.getGeneration();
  const next = acceptedSnapshotStore.reset(current);
  if (next === null) {
    throw new Error('Accepted snapshot generation changed during synchronous reset.');
  }
  return next;
}

export function clearEntityMeshes(_scene: THREE.Scene): void {
  listenerGeneration += 1;
  cleanupEntityMeshes();
  resetAcceptedSnapshotStore();
}

function toEntitySnapshot(
  value: Pick<DomainSnapshot['ball'], 'position' | 'rotation' | 'linearVelocity'>,
): Readonly<EntitySnapshot> {
  return Object.freeze({
    x: value.position[0],
    y: value.position[1],
    z: value.position[2],
    qx: value.rotation[0],
    qy: value.rotation[1],
    qz: value.rotation[2],
    qw: value.rotation[3],
    vx: value.linearVelocity[0],
    vy: value.linearVelocity[1],
    vz: value.linearVelocity[2],
  });
}

function toTimelineSnapshot(snapshot: Readonly<DomainSnapshot>): ValidatedTimelineSnapshot {
  const entities: Record<string, Readonly<EntitySnapshot>> = {
    [BALL_ENTITY_ID]: toEntitySnapshot(snapshot.ball),
  };
  for (const car of snapshot.cars) {
    entities[`${PLAYER_ENTITY_PREFIX}${car.sessionId}`] = toEntitySnapshot(car);
  }
  return Object.freeze({
    sequence: snapshot.sequence,
    serverTime: snapshot.serverTime,
    simulationTime: snapshot.simulationTime,
    kickoffEpoch: snapshot.kickoffEpoch,
    entities: Object.freeze(entities),
  });
}

function toLocalState(snapshot: Readonly<DomainSnapshot>): Readonly<StateSync> {
  const players: Record<string, Readonly<StatePlayer>> = {};
  for (const car of snapshot.cars) {
    players[car.sessionId] = Object.freeze({
      ...toEntitySnapshot(car),
      boost: car.boost,
      team: car.team,
      name: car.name,
      isHost: car.isHost,
    });
  }

  const usesPhaseClock = snapshot.phase === 'countdown'
    || (snapshot.wireFormat === 'v2' && snapshot.phase === 'goal-reset');
  return Object.freeze({
    sequence: snapshot.sequence,
    serverTime: snapshot.serverTime,
    simulationTime: snapshot.simulationTime,
    players: Object.freeze(players),
    ball: toEntitySnapshot(snapshot.ball),
    blueScore: snapshot.blueScore,
    orangeScore: snapshot.orangeScore,
    timeRemaining: usesPhaseClock
      ? snapshot.phaseSecondsRemaining
      : snapshot.regulationSecondsRemaining,
    phase: snapshot.phase,
  });
}

function applyEntityTransform(mesh: THREE.Group, entity: EntitySnapshot): void {
  mesh.position.set(entity.x, entity.y, entity.z);
  mesh.quaternion.set(entity.qx, entity.qy, entity.qz, entity.qw).normalize();
  const velocity = mesh.userData.syncedVelocity instanceof THREE.Vector3
    ? mesh.userData.syncedVelocity
    : new THREE.Vector3();
  velocity.set(entity.vx, entity.vy, entity.vz);
  mesh.userData.syncedVelocity = velocity;
  mesh.userData.syncedSpeed = velocity.length();
}

function assertPreparedMesh(mesh: THREE.Group, label: string): void {
  if (!(mesh instanceof THREE.Group)) {
    throw new TypeError(`${label} factory must return a THREE.Group.`);
  }
}

function disposePreparedReconciliation(prepared: PreparedReconciliation): void {
  for (const addition of prepared.additions) {
    addition.mesh.removeFromParent();
    disposeCarEffects(addition.mesh);
  }
  if (prepared.preparedBall) {
    prepared.preparedBall.removeFromParent();
    disposeObjectResources(prepared.preparedBall);
  }
}

function prepareReconciliation(
  snapshot: Readonly<DomainSnapshot>,
  arrivalMs: number,
  carMeshFactory: (team: string) => THREE.Group,
  ballMeshFactory: () => THREE.Group,
): PreparedReconciliation {
  const additions: PreparedCarAddition[] = [];
  let preparedBall: THREE.Group | null = null;

  try {
    if (ballMesh === null) {
      preparedBall = ballMeshFactory();
      assertPreparedMesh(preparedBall, 'Ball mesh');
      applyEntityTransform(preparedBall, toEntitySnapshot(snapshot.ball));
    }

    const nextMeshes = new Map(carMeshes);
    const desiredIds = new Set<string>();
    for (const car of snapshot.cars) {
      desiredIds.add(car.sessionId);
      const currentMesh = carMeshes.get(car.sessionId);
      const previousTeam = localState?.players[car.sessionId]?.team;
      if (currentMesh !== undefined && previousTeam === car.team) continue;

      const mesh = carMeshFactory(car.team);
      assertPreparedMesh(mesh, `Car mesh for ${car.sessionId}`);
      mesh.userData.lastBoost = car.boost;
      mesh.userData.team = car.team;
      applyEntityTransform(mesh, toEntitySnapshot(car));
      additions.push({ sessionId: car.sessionId, team: car.team, mesh });
      nextMeshes.set(car.sessionId, mesh);
    }

    const removals: PreparedCarRemoval[] = [];
    for (const [sessionId, mesh] of carMeshes) {
      if (!desiredIds.has(sessionId) || nextMeshes.get(sessionId) !== mesh) {
        removals.push({ sessionId, mesh });
        if (!desiredIds.has(sessionId)) nextMeshes.delete(sessionId);
      }
    }

    return Object.freeze({
      additions: Object.freeze(additions),
      removals: Object.freeze(removals),
      nextMeshes,
      nextLocalState: toLocalState(snapshot),
      nextArrivalMetrics: nextArrivalMetrics(arrivalMetrics, arrivalMs),
      preparedBall,
    });
  } catch (error) {
    for (const addition of additions) disposeCarEffects(addition.mesh);
    if (preparedBall) disposeObjectResources(preparedBall);
    throw error;
  }
}

function isAcceptanceContextCurrent(
  generation: number,
  acceptedGeneration: AcceptedSnapshotGeneration,
  expectedAcceptedState: AcceptedSnapshotState,
): boolean {
  return generation === listenerGeneration
    && acceptedSnapshotStore.getGeneration() === acceptedGeneration
    && acceptedSnapshotStore.getState() === expectedAcceptedState;
}

function removeFromSceneForRollback(
  scene: THREE.Scene,
  object: THREE.Object3D,
  isCurrent: () => boolean,
): boolean {
  if (!isCurrent()) return false;
  try {
    scene.remove(object);
  } catch {
    // Three.js mutates before dispatching synchronous removal callbacks.
  }
  if (!isCurrent()) return false;

  if (object.parent === scene) {
    try {
      THREE.Object3D.prototype.remove.call(scene, object);
    } catch {
      // The parent postcondition below determines whether rollback succeeded.
    }
    if (!isCurrent()) return false;
  }
  return object.parent !== scene;
}

function addToSceneForRollback(
  scene: THREE.Scene,
  object: THREE.Object3D,
  isCurrent: () => boolean,
): boolean {
  if (!isCurrent()) return false;
  try {
    scene.add(object);
  } catch {
    // Three.js mutates before dispatching synchronous addition callbacks.
  }
  if (!isCurrent()) return false;

  if (object.parent !== scene) {
    try {
      THREE.Object3D.prototype.add.call(scene, object);
    } catch {
      // The parent postcondition below determines whether rollback succeeded.
    }
    if (!isCurrent()) return false;
  }
  return object.parent === scene;
}

function restoreSceneAfterFailure(
  scene: THREE.Scene,
  prepared: PreparedReconciliation,
  isCurrent: () => boolean,
): boolean {
  for (const addition of prepared.additions) {
    if (!removeFromSceneForRollback(scene, addition.mesh, isCurrent)) return false;
  }
  if (
    prepared.preparedBall
    && !removeFromSceneForRollback(scene, prepared.preparedBall, isCurrent)
  ) {
    return false;
  }
  for (const removal of prepared.removals) {
    if (
      removal.mesh.parent !== scene
      && !addToSceneForRollback(scene, removal.mesh, isCurrent)
    ) {
      return false;
    }
  }
  return isCurrent();
}

function commitPreparedAcceptance(
  scene: THREE.Scene,
  candidate: SnapshotValidationResult,
  generation: number,
  acceptedGeneration: AcceptedSnapshotGeneration,
  expectedAcceptedState: AcceptedSnapshotState,
  timeline: PreparedSnapshotAcceptance,
  prepared: PreparedReconciliation,
): boolean {
  const previousMeshes = carMeshes;
  const previousBall = ballMesh;
  const previousLocalState = localState;
  const previousArrivalMetrics = arrivalMetrics;
  const isCurrent = (): boolean => isAcceptanceContextCurrent(
    generation,
    acceptedGeneration,
    expectedAcceptedState,
  );
  let timelineCommitted = false;
  let globalsAssigned = false;

  if (!isCurrent()) {
    timeline.abort();
    disposePreparedReconciliation(prepared);
    return false;
  }

  try {
    if (!timeline.commit()) throw new Error('Interpolation timeline changed before commit.');
    timelineCommitted = true;

    if (prepared.preparedBall) {
      scene.add(prepared.preparedBall);
      if (!isCurrent()) throw new Error('Snapshot acceptance was superseded while adding the ball.');
    }
    for (const addition of prepared.additions) {
      scene.add(addition.mesh);
      if (!isCurrent()) throw new Error('Snapshot acceptance was superseded while adding a car.');
    }
    for (const removal of prepared.removals) {
      scene.remove(removal.mesh);
      if (!isCurrent()) throw new Error('Snapshot acceptance was superseded while removing a car.');
    }

    if (!isCurrent()) throw new Error('Snapshot acceptance was superseded before publication.');
    carMeshes = prepared.nextMeshes;
    ballMesh = prepared.preparedBall ?? previousBall;
    localState = prepared.nextLocalState;
    arrivalMetrics = prepared.nextArrivalMetrics;
    globalsAssigned = true;

    if (!isCurrent() || !acceptedSnapshotStore.commit(candidate, acceptedGeneration)) {
      throw new Error('Accepted snapshot state changed before publication.');
    }
  } catch {
    if (!isCurrent()) {
      // A replacement room or newer same-generation commit owns the globals,
      // store, and timeline now. Only this stale transaction's detached
      // resources may be cleaned up; restoring prior-room state would corrupt it.
      disposePreparedReconciliation(prepared);
      return false;
    }

    if (globalsAssigned) {
      carMeshes = previousMeshes;
      ballMesh = previousBall;
      localState = previousLocalState;
      arrivalMetrics = previousArrivalMetrics;
    }

    const sceneRestored = restoreSceneAfterFailure(scene, prepared, isCurrent);
    if (!isCurrent()) {
      disposePreparedReconciliation(prepared);
      return false;
    }

    const timelineRestored = timelineCommitted
      ? timeline.rollback()
      : timeline.abort();
    disposePreparedReconciliation(prepared);
    if (!sceneRestored || !timelineRestored) {
      throw new Error('Atomic snapshot rollback could not restore the current generation.');
    }
    return false;
  }

  for (const removal of prepared.removals) {
    try {
      disposeCarEffects(removal.mesh);
    } catch {
      // Presentation cleanup must not invalidate an already committed snapshot.
    }
  }
  return true;
}

function resolveRoomMode(room: Room, explicitMode: RoomMode | undefined): RoomMode {
  if (explicitMode !== undefined) return explicitMode;
  return room.name === 'custom' ? 'custom' : 'quick';
}

/**
 * Decode and prepare each state-sync payload off-scene, then commit the
 * interpolation timeline, entity ownership, local state, and accepted store as
 * one synchronous transaction.
 */
export function setupStateListener(
  room: Room,
  scene: THREE.Scene,
  options: StateListenerOptions = {},
): void {
  const generation = ++listenerGeneration;
  cleanupEntityMeshes();
  const acceptedGeneration = resetAcceptedSnapshotStore();
  const roomMode = resolveRoomMode(room, options.roomMode);
  const carMeshFactory = options.carMeshFactory ?? createCarMesh;
  const ballMeshFactory = options.ballMeshFactory ?? createBallMesh;
  const clock = options.clock ?? nowMs;

  const pendingPayloads: unknown[] = [];
  let processingPayload = false;

  const acceptPayload = (payload: unknown): void => {
    if (generation !== listenerGeneration) return;

    const expectedAcceptedState = acceptedSnapshotStore.getState();
    if (expectedAcceptedState.generation !== acceptedGeneration) return;

    const candidate = decodeSnapshot(payload, {
      roomMode,
      previousSnapshot: expectedAcceptedState.snapshot,
    });
    if (!candidate.ok) return;

    const arrivalMs = clock();
    const timeline = snapshotBuffer.prepareAccept(
      toTimelineSnapshot(candidate.snapshot),
      arrivalMs,
    );
    if (timeline === null) return;

    let prepared: PreparedReconciliation;
    try {
      prepared = prepareReconciliation(
        candidate.snapshot,
        arrivalMs,
        carMeshFactory,
        ballMeshFactory,
      );
    } catch {
      timeline.abort();
      return;
    }

    if (!isAcceptanceContextCurrent(
      generation,
      acceptedGeneration,
      expectedAcceptedState,
    )) {
      timeline.abort();
      disposePreparedReconciliation(prepared);
      return;
    }

    commitPreparedAcceptance(
      scene,
      candidate,
      generation,
      acceptedGeneration,
      expectedAcceptedState,
      timeline,
      prepared,
    );
  };

  room.onMessage('state-sync', (payload: unknown) => {
    if (generation !== listenerGeneration) return;
    pendingPayloads.push(payload);
    if (processingPayload) return;

    processingPayload = true;
    try {
      while (pendingPayloads.length > 0 && generation === listenerGeneration) {
        const nextPayload = pendingPayloads.shift();
        acceptPayload(nextPayload);
      }
    } finally {
      // A room replacement owns a separate listener and queue. Never replay
      // work captured from the superseded generation into its scene state.
      pendingPayloads.length = 0;
      processingPayload = false;
    }
  });

  room.onLeave(() => {
    if (generation !== listenerGeneration) return;
    listenerGeneration += 1;
    cleanupEntityMeshes();
    acceptedSnapshotStore.reset(acceptedGeneration);
  });

  console.log('[State] Listener setup complete (atomic buffered snapshots)');
}

/** Apply delayed authoritative presentation transforms once per render frame. */
export function updateInterpolatedEntities(renderNowMs: number = nowMs()): void {
  const frame = snapshotBuffer.sample(renderNowMs);
  if (!frame) return;

  const ball = frame.entities[BALL_ENTITY_ID];
  if (ballMesh && ball) applyEntityTransform(ballMesh, ball);

  for (const [sessionId, car] of carMeshes) {
    const player = frame.entities[`${PLAYER_ENTITY_PREFIX}${sessionId}`];
    if (player) applyEntityTransform(car, player);
  }
  appliedRenderFrames += 1;
}

export function getCarMeshes(): ReadonlyMap<string, THREE.Group> {
  return carMeshes;
}

export function getBallMesh(): THREE.Group | null {
  return ballMesh;
}

/** Get the latest accepted state snapshot for HUD and lobby UI. */
export function getLocalState(): Readonly<StateSync> | null {
  return localState;
}

/** Serializable instrumentation used by the dev console and browser checks. */
export function getInterpolationStats(): RuntimeInterpolationStats {
  const stats = snapshotBuffer.getStats();
  const averageSnapshotIntervalMs = arrivalMetrics.intervalCount > 0
    ? arrivalMetrics.intervalTotalMs / arrivalMetrics.intervalCount
    : 0;
  return {
    ...stats,
    averageSnapshotIntervalMs,
    maximumSnapshotIntervalMs: arrivalMetrics.maximumIntervalMs,
    snapshotRateHz: averageSnapshotIntervalMs > 0 ? 1000 / averageSnapshotIntervalMs : 0,
    appliedRenderFrames,
  };
}
