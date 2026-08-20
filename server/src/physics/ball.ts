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
  readonly fixedStepSeconds: number;
  readonly softCcdTravelRatio: number;
  readonly maximumSoftCcdPrediction: number;
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
  const maximumLinearSpeed = positiveTuningValue(tuning, TUNING_IDS.ball.maxLinearSpeed);
  const fixedStepSeconds = positiveTuningValue(tuning, TUNING_IDS.physics.fixedStepSeconds);
  const softCcdTravelRatio = getConstant('BALL.SOFT_CCD_TRAVEL_RATIO');
  return {
    tracker: createFiniteRigidBodyStateTracker(body, {
      translation: fallbackTranslation,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      linearVelocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
    }),
    maximumLinearSpeed: maximumLinearSpeed + BALL_LINEAR_SPEED_TOLERANCE,
    maximumAngularSpeed: positiveTuningValue(tuning, TUNING_IDS.ball.maxAngularSpeed),
    fixedStepSeconds,
    softCcdTravelRatio,
    maximumSoftCcdPrediction: maximumLinearSpeed * fixedStepSeconds * softCcdTravelRatio,
  };
}

/**
 * Scale the soft-CCD prediction to the distance this ball covers in the coming
 * fixed step. Keeping the prediction strictly below that travel preserves the
 * genuine impact the restitution coefficient acts on, while keeping it a large
 * enough fraction of the travel prevents a visible transient sink at speed.
 */
function applyAdaptiveSoftCcdPrediction(
  body: RAPIER.RigidBody,
  managed: ManagedBallBody,
  linearVelocity: FiniteVector3,
): void {
  const speed = Math.hypot(linearVelocity.x, linearVelocity.y, linearVelocity.z);
  const travel = speed * managed.fixedStepSeconds;
  const prediction = Math.min(
    travel * managed.softCcdTravelRatio,
    managed.maximumSoftCcdPrediction,
  );
  body.setSoftCcdPrediction(Number.isFinite(prediction) && prediction > 0 ? prediction : 0);
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
        // The resting prediction is zero; every step then scales it to the
        // ball's own speed through applyAdaptiveSoftCcdPrediction.
        .setSoftCcdPrediction(getConstant('BALL.SOFT_CCD_PREDICTION'))
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
  const recovered = recoverFiniteRigidBodyState(body, managed.tracker);
  applyAdaptiveSoftCcdPrediction(body, managed, recovered.linearVelocity);
  return recovered;
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
