import RAPIER from '@dimforge/rapier3d-compat';
import { getConstant } from '../../../shared/src/constants/index.js';

/** Create the tuned, continuously collision-detected game ball. */
export function createBall(
  world: RAPIER.World,
  position?: { x: number; y: number; z: number },
): RAPIER.RigidBody {
  const radius = getConstant('BALL.RADIUS');
  const pos = position ?? {
    x: 0,
    y: radius + getConstant('BALL.SPAWN_CLEARANCE'),
    z: 0,
  };

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setLinearDamping(getConstant('BALL.LINEAR_DAMPING'))
      .setAngularDamping(getConstant('BALL.ANGULAR_DAMPING'))
      .setCcdEnabled(true)
      .setSoftCcdPrediction(getConstant('BALL.SOFT_CCD_PREDICTION'))
      .setAdditionalSolverIterations(Math.round(
        getConstant('BALL.ADDITIONAL_SOLVER_ITERATIONS'),
      )),
  );

  world.createCollider(
    RAPIER.ColliderDesc.ball(radius)
      .setMass(getConstant('BALL.MASS'))
      .setFriction(getConstant('BALL.FRICTION'))
      .setRestitution(getConstant('BALL.RESTITUTION'))
      .setContactSkin(getConstant('BALL.CONTACT_SKIN'))
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max),
    body,
  );

  return body;
}
