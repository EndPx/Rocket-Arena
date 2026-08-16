import * as THREE from 'three';
import type { Room } from 'colyseus.js';
import { createCarMesh } from '../renderer/car.js';
import { createBallMesh } from '../renderer/ball.js';
import {
  SnapshotBuffer,
  type AuthoritativeSnapshot,
  type EntitySnapshot,
  type InterpolationStats,
} from './interpolation-buffer.js';

const BALL_ENTITY_ID = 'ball';
const PLAYER_ENTITY_PREFIX = 'player:';
const carMeshes: Map<string, THREE.Group> = new Map();
const snapshotBuffer = new SnapshotBuffer();
let ballMesh: THREE.Group | null = null;
let localState: StateSync | null = null;
let listenerGeneration = 0;
let lastSnapshotArrivalMs: number | null = null;
let snapshotIntervalTotalMs = 0;
let snapshotIntervalCount = 0;
let maximumSnapshotIntervalMs = 0;
let appliedRenderFrames = 0;

export interface StateEntity {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface StatePlayer extends StateEntity {
  boost: number;
  team: string;
  name: string;
  isHost: boolean;
}

export interface StateSync {
  sequence: number;
  serverTime: number;
  simulationTime: number;
  players: Record<string, StatePlayer>;
  ball: StateEntity;
  blueScore: number;
  orangeScore: number;
  timeRemaining: number;
  phase: string;
}

export interface RuntimeInterpolationStats extends InterpolationStats {
  averageSnapshotIntervalMs: number;
  maximumSnapshotIntervalMs: number;
  snapshotRateHz: number;
  appliedRenderFrames: number;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function removeCar(scene: THREE.Scene, sessionId: string, car: THREE.Group): void {
  scene.remove(car);
  carMeshes.delete(sessionId);
}

function resetInterpolationState(): void {
  snapshotBuffer.reset();
  lastSnapshotArrivalMs = null;
  snapshotIntervalTotalMs = 0;
  snapshotIntervalCount = 0;
  maximumSnapshotIntervalMs = 0;
  appliedRenderFrames = 0;
}

export function clearEntityMeshes(scene: THREE.Scene): void {
  for (const [sessionId, car] of carMeshes) {
    removeCar(scene, sessionId, car);
  }
  if (ballMesh) {
    scene.remove(ballMesh);
    ballMesh = null;
  }
  localState = null;
  resetInterpolationState();
}

function toEntitySnapshot(state: StateEntity): EntitySnapshot {
  return {
    x: state.x,
    y: state.y,
    z: state.z,
    qx: state.qx,
    qy: state.qy,
    qz: state.qz,
    qw: state.qw,
    vx: state.vx,
    vy: state.vy,
    vz: state.vz,
  };
}

function toAuthoritativeSnapshot(data: StateSync): AuthoritativeSnapshot {
  const entities: Record<string, EntitySnapshot> = {
    [BALL_ENTITY_ID]: toEntitySnapshot(data.ball),
  };
  for (const [sessionId, player] of Object.entries(data.players)) {
    entities[`${PLAYER_ENTITY_PREFIX}${sessionId}`] = toEntitySnapshot(player);
  }
  return {
    sequence: data.sequence,
    serverTime: data.serverTime,
    simulationTime: data.simulationTime,
    entities,
  };
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

function recordSnapshotArrival(arrivalMs: number): void {
  if (lastSnapshotArrivalMs !== null) {
    const interval = Math.max(0, arrivalMs - lastSnapshotArrivalMs);
    snapshotIntervalTotalMs += interval;
    snapshotIntervalCount += 1;
    maximumSnapshotIntervalMs = Math.max(maximumSnapshotIntervalMs, interval);
  }
  lastSnapshotArrivalMs = arrivalMs;
}

/**
 * Queue manual state-sync snapshots while retaining the existing lobby/HUD and
 * entity lifecycle. Existing meshes are never snapped in this callback.
 */
export function setupStateListener(room: Room, scene: THREE.Scene): void {
  const generation = ++listenerGeneration;
  clearEntityMeshes(scene);

  ballMesh = createBallMesh();
  scene.add(ballMesh);

  room.onMessage('state-sync', (data: StateSync) => {
    if (generation !== listenerGeneration) return;
    const arrivalMs = nowMs();
    if (!snapshotBuffer.push(toAuthoritativeSnapshot(data), arrivalMs)) return;

    recordSnapshotArrival(arrivalMs);
    localState = data;
    const firstSnapshot = snapshotBuffer.getStats().acceptedSnapshots === 1;

    if (firstSnapshot && ballMesh) {
      applyEntityTransform(ballMesh, toEntitySnapshot(data.ball));
    }

    const currentIds = new Set(Object.keys(data.players));
    for (const [sessionId, player] of Object.entries(data.players)) {
      if (!carMeshes.has(sessionId)) {
        const carMesh = createCarMesh(player.team);
        applyEntityTransform(carMesh, toEntitySnapshot(player));
        scene.add(carMesh);
        carMeshes.set(sessionId, carMesh);
        console.log(`[State] Car added: ${sessionId} (${player.team})`);
      }
    }

    for (const [sessionId, mesh] of carMeshes) {
      if (!currentIds.has(sessionId)) {
        removeCar(scene, sessionId, mesh);
        console.log(`[State] Car removed: ${sessionId}`);
      }
    }
  });

  room.onLeave(() => {
    if (generation === listenerGeneration) {
      clearEntityMeshes(scene);
    }
  });

  console.log('[State] Listener setup complete (buffered authoritative snapshots)');
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
export function getLocalState(): StateSync | null {
  return localState;
}

/** Serializable instrumentation used by the dev console and browser checks. */
export function getInterpolationStats(): RuntimeInterpolationStats {
  const stats = snapshotBuffer.getStats();
  const averageSnapshotIntervalMs = snapshotIntervalCount > 0
    ? snapshotIntervalTotalMs / snapshotIntervalCount
    : 0;
  return {
    ...stats,
    averageSnapshotIntervalMs,
    maximumSnapshotIntervalMs,
    snapshotRateHz: averageSnapshotIntervalMs > 0 ? 1000 / averageSnapshotIntervalMs : 0,
    appliedRenderFrames,
  };
}
