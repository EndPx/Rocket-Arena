import RAPIER from '@dimforge/rapier3d-compat';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
} from '@rocket-arena/shared';
import { getConstant } from '@rocket-arena/shared/constants';
import type { KickoffAssignment } from './kickoff-slots.js';

export interface KickoffCarBody<TState = unknown> {
  readonly body: RAPIER.RigidBody;
  /** Capture controller/inventory state before the transactional placement. */
  readonly captureState: () => TState;
  /** Reset controller/inventory state while preserving transport edge floors as needed. */
  readonly resetState: () => void;
  /** Restore exactly the state returned by captureState after rollback. */
  readonly restoreState: (snapshot: TState) => void;
}

export interface PreparedKickoffReset {
  /** Apply all validated transforms and zero all body motion. */
  apply(): void;
  /** Restore the exact pre-placement body and jump state; safe before apply. */
  rollback(): void;
}

interface RigidBodySnapshot {
  readonly position: Readonly<{ x: number; y: number; z: number }>;
  readonly rotation: Readonly<{ x: number; y: number; z: number; w: number }>;
  readonly linearVelocity: Readonly<{ x: number; y: number; z: number }>;
  readonly angularVelocity: Readonly<{ x: number; y: number; z: number }>;
}

interface CarResetSnapshot<TState> {
  readonly body: RigidBodySnapshot;
  readonly controllerState: TState;
}

function copyVector(value: { x: number; y: number; z: number }): Readonly<{ x: number; y: number; z: number }> {
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

function captureBody(body: RAPIER.RigidBody): RigidBodySnapshot {
  const rotation = body.rotation();
  return Object.freeze({
    position: copyVector(body.translation()),
    rotation: Object.freeze({
      x: rotation.x,
      y: rotation.y,
      z: rotation.z,
      w: rotation.w,
    }),
    linearVelocity: copyVector(body.linvel()),
    angularVelocity: copyVector(body.angvel()),
  });
}

function restoreBody(body: RAPIER.RigidBody, snapshot: RigidBodySnapshot): void {
  body.setTranslation(snapshot.position, true);
  body.setRotation(snapshot.rotation, true);
  body.setLinvel(snapshot.linearVelocity, true);
  body.setAngvel(snapshot.angularVelocity, true);
}

function validateAssignment(
  sessionId: string,
  assignment: Readonly<KickoffAssignment> | undefined,
): asserts assignment is Readonly<KickoffAssignment> {
  if (assignment === undefined
      || assignment.sessionId !== sessionId
      || (assignment.team !== 'blue' && assignment.team !== 'orange')
      || !Array.isArray(assignment.position)
      || assignment.position.length !== 3
      || !assignment.position.every(Number.isFinite)
      || !Array.isArray(assignment.rotation)
      || assignment.rotation.length !== 4
      || !assignment.rotation.every(Number.isFinite)
      || assignment.rotation.every((component) => component === 0)) {
    throw new TypeError(`Kickoff assignment for ${sessionId} is missing or invalid.`);
  }
}

class PreparedKickoffResetImpl<TState> implements PreparedKickoffReset {
  private state: 'prepared' | 'applied' | 'rolled-back' = 'prepared';

  constructor(
    private readonly ballBody: RAPIER.RigidBody,
    private readonly ballSnapshot: RigidBodySnapshot,
    private readonly ballPosition: Readonly<{ x: number; y: number; z: number }>,
    private readonly cars: readonly Readonly<{
      sessionId: string;
      entry: KickoffCarBody<TState>;
      assignment: Readonly<KickoffAssignment>;
      snapshot: CarResetSnapshot<TState>;
    }>[],
  ) {}

  apply(): void {
    if (this.state !== 'prepared') {
      throw new Error('A prepared kickoff reset can be applied only once.');
    }

    try {
      this.ballBody.setTranslation(this.ballPosition, true);
      this.ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);

      for (const { entry, assignment } of this.cars) {
        entry.body.setTranslation({
          x: assignment.position[0],
          y: assignment.position[1],
          z: assignment.position[2],
        }, true);
        entry.body.setRotation({
          x: assignment.rotation[0],
          y: assignment.rotation[1],
          z: assignment.rotation[2],
          w: assignment.rotation[3],
        }, true);
        entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        entry.resetState();
      }
      this.state = 'applied';
    } catch (cause) {
      try {
        this.restoreSnapshots();
        this.state = 'rolled-back';
      } catch (rollbackCause) {
        throw new AggregateError(
          [cause, rollbackCause],
          'Kickoff reset failed and could not restore its body snapshots.',
        );
      }
      throw cause;
    }
  }

  rollback(): void {
    if (this.state === 'rolled-back') return;
    if (this.state === 'applied') this.restoreSnapshots();
    this.state = 'rolled-back';
  }

  private restoreSnapshots(): void {
    restoreBody(this.ballBody, this.ballSnapshot);
    for (const { entry, snapshot } of this.cars) {
      restoreBody(entry.body, snapshot.body);
      entry.restoreState(snapshot.controllerState);
    }
  }
}

/**
 * Validate exact identity coverage and capture every rollback snapshot without
 * moving a body. Callers may then coordinate this transaction with assignment
 * cache/state commits.
 */
export function prepareResetToKickoff<TState>(
  ballBody: RAPIER.RigidBody,
  carBodies: ReadonlyMap<string, KickoffCarBody<TState>>,
  assignments: ReadonlyMap<string, Readonly<KickoffAssignment>>,
  ballRadius: number = getScalarTuningValue(
    DEFAULT_TUNING_REGISTRY_SNAPSHOT,
    TUNING_IDS.ball.radius,
  ),
): PreparedKickoffReset {
  const defaultBallRadius = getScalarTuningValue(
    DEFAULT_TUNING_REGISTRY_SNAPSHOT,
    TUNING_IDS.ball.radius,
  );
  const finiteBallRadius = Number.isFinite(ballRadius) && ballRadius > 0
    ? ballRadius
    : defaultBallRadius;
  if (carBodies.size === 0 || assignments.size !== carBodies.size) {
    throw new TypeError('Kickoff reset requires one assignment for every current car.');
  }

  const orderedCars = [...carBodies.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  for (const sessionId of assignments.keys()) {
    if (!carBodies.has(sessionId)) {
      throw new TypeError(`Kickoff assignment ${sessionId} has no current car.`);
    }
  }

  const cars = orderedCars.map(([sessionId, entry]) => {
    const assignment = assignments.get(sessionId);
    validateAssignment(sessionId, assignment);
    return Object.freeze({
      sessionId,
      entry,
      assignment,
      snapshot: Object.freeze({
        body: captureBody(entry.body),
        controllerState: entry.captureState(),
      }),
    });
  });
  return new PreparedKickoffResetImpl(
    ballBody,
    captureBody(ballBody),
    Object.freeze({
      x: 0,
      y: finiteBallRadius + getConstant('BALL.SPAWN_CLEARANCE'),
      z: 0,
    }),
    Object.freeze(cars),
  );
}

/** Reset a fully assigned kickoff immediately through the atomic compatibility path. */
export function resetToKickoff<TState>(
  ballBody: RAPIER.RigidBody,
  carBodies: ReadonlyMap<string, KickoffCarBody<TState>>,
  assignments: ReadonlyMap<string, Readonly<KickoffAssignment>>,
  ballRadius?: number,
): void {
  prepareResetToKickoff(ballBody, carBodies, assignments, ballRadius).apply();
}
