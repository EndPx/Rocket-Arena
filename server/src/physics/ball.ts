import RAPIER from '@dimforge/rapier3d-compat';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
  getScalarTuningValue,
  type TuningRegistrySnapshot,
} from '@rocket-arena/shared';
import { getConstant } from '../../../shared/src/constants/index.js';
import {
  createFiniteRigidBodyStateTracker,
  finiteVectorOrFallback,
  recoverAndBoundRigidBodyMotion,
  recoverFiniteRigidBodyState,
  type FiniteRigidBodyState,
  type FiniteRigidBodyStateTracker,
  type FiniteVector3,
} from './finite-state.js';

export type BallTuningSnapshot = Pick<TuningRegistrySnapshot, 'get'>;
export const BALL_LINEAR_SPEED_TOLERANCE = 0.05;

interface ManagedBallBody {
  readonly tracker: FiniteRigidBodyStateTracker;
  readonly maximumLinearSpeed: number;
  readonly maximumAngularSpeed: number;
}

const MANAGED_BALL_BODIES = new WeakMap<RAPIER.RigidBody, ManagedBallBody>();

function finiteTuningValue(
  tuning: BallTuningSnapshot,
  id: string,
  predicate: (value: number) => boolean,
): number {
  const fallback = getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, id);
  const candidate = getScalarTuningValue(tuning, id);
  return Number.isFinite(candidate) && predicate(candidate) ? candidate : fallback;
}

function positiveTuningValue(tuning: BallTuningSnapshot, id: string): number {
  return finiteTuningValue(tuning, id, (value) => value > 0);
}

function makeManagedBall(
  body: RAPIER.RigidBody,
  fallbackTranslation: FiniteVector3,
  tuning: BallTuningSnapshot,
): ManagedBallBody {
  return {
    tracker: createFiniteRigidBodyStateTracker(body, {
      translation: fallbackTranslation,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      linearVelocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
    }),
    maximumLinearSpeed: positiveTuningValue(tuning, TUNING_IDS.ball.maxLinearSpeed)
      + BALL_LINEAR_SPEED_TOLERANCE,
    maximumAngularSpeed: positiveTuningValue(tuning, TUNING_IDS.ball.maxAngularSpeed),
  };
}

function managedBall(body: RAPIER.RigidBody): ManagedBallBody {
  const existing = MANAGED_BALL_BODIES.get(body);
  if (existing) return existing;

  const fallbackTranslation = finiteVectorOrFallback(body.translation());
  const managed = makeManagedBall(
    body,
    fallbackTranslation,
    DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  );
  MANAGED_BALL_BODIES.set(body, managed);
  return managed;
}

/** Create the metric, continuously collision-detected authoritative ball. */
export function createBall(
  world: RAPIER.World,
  position?: FiniteVector3,
  tuning: BallTuningSnapshot = DEFAULT_TUNING_REGISTRY_SNAPSHOT,
): RAPIER.RigidBody {
  const radius = positiveTuningValue(tuning, TUNING_IDS.ball.radius);
  const mass = positiveTuningValue(tuning, TUNING_IDS.ball.mass);
  const restitution = finiteTuningValue(
    tuning,
    TUNING_IDS.ball.restitution,
    (value) => value >= 0 && value <= 1,
  );
  const linearDamping = finiteTuningValue(
    tuning,
    TUNING_IDS.ball.linearDamping,
    (value) => value >= 0 && value <= 0.2,
  );
  const defaultPosition = {
    x: 0,
    y: radius + getConstant('BALL.SPAWN_CLEARANCE'),
    z: 0,
  };
  const safePosition = finiteVectorOrFallback(position ?? defaultPosition, defaultPosition);

  let body: RAPIER.RigidBody | null = null;
  try {
    body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(safePosition.x, safePosition.y, safePosition.z)
        .setLinearDamping(linearDamping)
        .setAngularDamping(getConstant('BALL.ANGULAR_DAMPING'))
        .setCcdEnabled(true)
        .setSoftCcdPrediction(
          positiveTuningValue(tuning, TUNING_IDS.ball.maxLinearSpeed)
            * positiveTuningValue(tuning, TUNING_IDS.physics.fixedStepSeconds),
        )
        .setAdditionalSolverIterations(Math.round(
          getConstant('BALL.ADDITIONAL_SOLVER_ITERATIONS'),
        )),
    );

    world.createCollider(
      RAPIER.ColliderDesc.ball(radius)
        .setMass(mass)
        .setFriction(getConstant('BALL.FRICTION'))
        .setRestitution(restitution)
        .setContactSkin(getConstant('BALL.CONTACT_SKIN'))
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max),
      body,
    );

    MANAGED_BALL_BODIES.set(body, makeManagedBall(body, safePosition, tuning));
    return body;
  } catch (cause) {
    if (body !== null && body.isValid()) world.removeRigidBody(body);
    throw cause;
  }
}

/** Repair each invalid ball field before a simulation step or projection. */
export function recoverBallBeforeStep(body: RAPIER.RigidBody): FiniteRigidBodyState {
  const managed = managedBall(body);
  return recoverFiniteRigidBodyState(body, managed.tracker);
}

/** Repair and enforce the post-step 60.05 m/s and 6 rad/s default bounds. */
export function recoverBallAfterStep(body: RAPIER.RigidBody): FiniteRigidBodyState {
  const managed = managedBall(body);
  return recoverAndBoundRigidBodyMotion(
    body,
    managed.tracker,
    managed.maximumLinearSpeed,
    managed.maximumAngularSpeed,
  );
}
