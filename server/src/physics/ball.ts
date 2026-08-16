import RAPIER from '@dimforge/rapier3d-compat';
import { getConstant } from '../../../shared/src/constants/index.js';

/**
 * Create the ball rigid body with sphere collider.
 * CCD enabled to prevent tunneling at high speeds.
 */
export function createBall(world: RAPIER.World, position?: { x: number; y: number; z: number }): RAPIER.RigidBody {
  const radius = getConstant('BALL.RADIUS');
  const mass = getConstant('BALL.MASS');
  const restitution = getConstant('BALL.RESTITUTION');
  const linearDamping = getConstant('BALL.LINEAR_DAMPING');
  const angularDamping = getConstant('BALL.ANGULAR_DAMPING');

  const pos = position || { x: 0, y: radius + 0.1, z: 0 };

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(pos.x, pos.y, pos.z)
    .setLinearDamping(linearDamping)
    .setAngularDamping(angularDamping)
    .setCcdEnabled(true);

  const body = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.ball(radius)
    .setMass(mass)
    .setRestitution(restitution)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max);

  world.createCollider(colliderDesc, body);

  return body;
}
