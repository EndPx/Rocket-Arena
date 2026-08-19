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
  finiteQuaternionOrFallback,
  finiteVectorOrFallback,
  recoverAndBoundRigidBodyMotion,
  recoverFiniteRigidBodyState,
  type FiniteQuaternion,
  type FiniteRigidBodyState,
  type FiniteRigidBodyStateTracker,
  type FiniteVector3,
} from './finite-state.js';

export type PhysicsTuningSnapshot = Pick<TuningRegistrySnapshot, 'get'>;
export type CarBodyPosition = FiniteVector3;
export type CarBodyRotation = FiniteQuaternion;

export const CAR_LINEAR_SPEED_TOLERANCE = 0.05;

interface ManagedCarBody {
  readonly tracker: FiniteRigidBodyStateTracker;
  readonly maximumLinearSpeed: number;
  readonly maximumAngularSpeed: number;
}

const MANAGED_CAR_BODIES = new WeakMap<RAPIER.RigidBody, ManagedCarBody>();

function finiteTuningValue(
  tuning: PhysicsTuningSnapshot,
  id: string,
  predicate: (value: number) => boolean,
): number {
  const fallback = getScalarTuningValue(DEFAULT_TUNING_REGISTRY_SNAPSHOT, id);
  const candidate = getScalarTuningValue(tuning, id);
  return Number.isFinite(candidate) && predicate(candidate) ? candidate : fallback;
}

function positiveTuningValue(tuning: PhysicsTuningSnapshot, id: string): number {
  return finiteTuningValue(tuning, id, (value) => value > 0);
}

function makeManagedCarBody(
  body: RAPIER.RigidBody,
  fallbackTranslation: FiniteVector3,
  fallbackRotation: FiniteQuaternion,
  tuning: PhysicsTuningSnapshot,
): ManagedCarBody {
  return {
    tracker: createFiniteRigidBodyStateTracker(body, {
      translation: fallbackTranslation,
      rotation: fallbackRotation,
      linearVelocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
    }),
    maximumLinearSpeed: positiveTuningValue(tuning, TUNING_IDS.car.maxLinearSpeed)
      + CAR_LINEAR_SPEED_TOLERANCE,
    maximumAngularSpeed: positiveTuningValue(tuning, TUNING_IDS.car.maxAngularSpeed),
  };
}

function managedCarBody(body: RAPIER.RigidBody): ManagedCarBody {
  const existing = MANAGED_CAR_BODIES.get(body);
  if (existing) return existing;

  const fallbackTranslation = finiteVectorOrFallback(body.translation());
  const fallbackRotation = finiteQuaternionOrFallback(body.rotation());
  const managed = makeManagedCarBody(
    body,
    fallbackTranslation,
    fallbackRotation,
    DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  );
  MANAGED_CAR_BODIES.set(body, managed);
  return managed;
}

/** Create the registry-scaled plain-box authoritative car body. */
export function createCarBody(
  world: RAPIER.World,
  position: CarBodyPosition,
  rotation?: CarBodyRotation,
  tuning: PhysicsTuningSnapshot = DEFAULT_TUNING_REGISTRY_SNAPSHOT,
): RAPIER.RigidBody {
  const length = positiveTuningValue(tuning, TUNING_IDS.car.collider.length);
  const width = positiveTuningValue(tuning, TUNING_IDS.car.collider.width);
  const height = positiveTuningValue(tuning, TUNING_IDS.car.collider.height);
  const mass = positiveTuningValue(tuning, TUNING_IDS.car.mass);
  const safePosition = finiteVectorOrFallback(position, { x: 0, y: height / 2, z: 0 });
  const safeRotation = finiteQuaternionOrFallback(
    rotation ?? { x: 0, y: 0, z: 0, w: 1 },
  );

  let body: RAPIER.RigidBody | null = null;
  try {
    body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(safePosition.x, safePosition.y, safePosition.z)
        .setRotation(safeRotation)
        .setLinearDamping(getConstant('CAR.DAMPING.LINEAR'))
        .setAngularDamping(getConstant('CAR.DAMPING.ANGULAR'))
        .setCcdEnabled(true)
        .setSoftCcdPrediction(getConstant('CAR.BODY.SOFT_CCD_PREDICTION'))
        .setAdditionalSolverIterations(Math.round(
          getConstant('CAR.BODY.ADDITIONAL_SOLVER_ITERATIONS'),
        )),
    );

    world.createCollider(
      RAPIER.ColliderDesc.cuboid(width / 2, height / 2, length / 2)
        .setMass(mass)
        .setFriction(getConstant('CAR.BODY.FRICTION'))
        .setRestitution(getConstant('CAR.BODY.RESTITUTION'))
        .setContactSkin(getConstant('CAR.BODY.CONTACT_SKIN'))
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max),
      body,
    );

    MANAGED_CAR_BODIES.set(
      body,
      makeManagedCarBody(body, safePosition, safeRotation, tuning),
    );
    world.updateSceneQueries();
    return body;
  } catch (cause) {
    if (body !== null && body.isValid()) world.removeRigidBody(body);
    throw cause;
  }
}

/** Repair each invalid transform or motion vector before controller work. */
export function recoverCarBodyBeforeStep(body: RAPIER.RigidBody): FiniteRigidBodyState {
  const managed = managedCarBody(body);
  return recoverFiniteRigidBodyState(body, managed.tracker);
}

/** Repair and enforce the post-step 23.05 m/s and 5.5 rad/s default bounds. */
export function recoverCarBodyAfterStep(body: RAPIER.RigidBody): FiniteRigidBodyState {
  const managed = managedCarBody(body);
  return recoverAndBoundRigidBodyMotion(
    body,
    managed.tracker,
    managed.maximumLinearSpeed,
    managed.maximumAngularSpeed,
  );
}
