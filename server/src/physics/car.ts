import RAPIER from '@dimforge/rapier3d-compat';
import { getConstant } from '../../../shared/src/constants/index.js';
import type { InputPayload } from '../../../shared/src/types/input.js';

/**
 * Create a car rigid body (box collider).
 * No CCD needed — cars are wide enough not to tunnel.
 */
export function createCar(
  world: RAPIER.World,
  position: { x: number; y: number; z: number },
  rotation?: { x: number; y: number; z: number; w: number }
): RAPIER.RigidBody {
  const width = getConstant('CAR.BODY.WIDTH');
  const height = getConstant('CAR.BODY.HEIGHT');
  const length = getConstant('CAR.BODY.LENGTH');
  const mass = getConstant('CAR.BODY.MASS');
  const linearDamping = getConstant('CAR.DAMPING.LINEAR');
  const angularDamping = getConstant('CAR.DAMPING.ANGULAR');

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(position.x, position.y, position.z)
    .setLinearDamping(linearDamping)
    .setAngularDamping(angularDamping);

  if (rotation) {
    bodyDesc.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
  }

  const body = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.cuboid(width / 2, height / 2, length / 2)
    .setMass(mass)
    .setRestitution(0.2);

  world.createCollider(colliderDesc, body);

  return body;
}

/**
 * Check if car is grounded via a downward raycast.
 * Cast from car center downward, length = half car height + small margin.
 */
export function isGrounded(world: RAPIER.World, carBody: RAPIER.RigidBody): boolean {
  const pos = carBody.translation();
  const halfHeight = getConstant('CAR.BODY.HEIGHT') / 2;
  const rayLength = halfHeight + 0.3; // small margin

  const ray = new RAPIER.Ray(
    { x: pos.x, y: pos.y, z: pos.z },
    { x: 0, y: -1, z: 0 }
  );

  const hit = world.castRay(ray, rayLength, true, undefined, undefined, undefined, carBody);
  return hit !== null;
}

/**
 * Get the car's local forward direction (local +Z in world space).
 */
function getForwardDir(carBody: RAPIER.RigidBody): { x: number; y: number; z: number } {
  const rot = carBody.rotation();
  // Rotate local +Z (0,0,1) by quaternion
  const qx = rot.x, qy = rot.y, qz = rot.z, qw = rot.w;
  // q * v * q^-1 for v = (0, 0, 1)
  const ix = qw * 0 + qy * 1 - qz * 0;
  const iy = qw * 0 + qz * 0 - qx * 1;
  const iz = qw * 1 + qx * 0 - qy * 0;
  const iw = -qx * 0 - qy * 0 - qz * 1;

  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

/**
 * Get the car's local right direction (local +X in world space).
 */
function getRightDir(carBody: RAPIER.RigidBody): { x: number; y: number; z: number } {
  const rot = carBody.rotation();
  const qx = rot.x, qy = rot.y, qz = rot.z, qw = rot.w;
  // Rotate local +X (1, 0, 0) by quaternion
  const ix = qw * 1 + qy * 0 - qz * 0;
  const iy = qw * 0 + qz * 1 - qx * 0;
  const iz = qw * 0 + qx * 0 - qy * 1;
  const iw = -qx * 1 - qy * 0 - qz * 0;

  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

/**
 * Apply car physics for one tick.
 * This is the core driving model with lateral grip (traction).
 */
export function applyCarPhysics(
  world: RAPIER.World,
  carBody: RAPIER.RigidBody,
  input: InputPayload,
  jumpUsed: { count: number }
): void {
  const grounded = isGrounded(world, carBody);
  const mass = getConstant('CAR.BODY.MASS');
  const vel = carBody.linvel();
  const forward = getForwardDir(carBody);
  const right = getRightDir(carBody);

  // --- GROUNDED PHYSICS ---
  if (grounded) {
    // Reset jump counter on ground contact
    jumpUsed.count = 0;

    // 1. Forward/Brake/Reverse force
    const forwardForce = getConstant('CAR.ENGINE.FORWARD_FORCE');
    const brakeForce = getConstant('CAR.ENGINE.BRAKE_FORCE');
    const reverseForce = getConstant('CAR.ENGINE.REVERSE_FORCE');

    if (input.throttle > 0) {
      // Check if below max speed
      const speed = vel.x * forward.x + vel.y * forward.y + vel.z * forward.z;
      const maxSpeed = getConstant('CAR.ENGINE.MAX_SPEED');
      if (speed < maxSpeed) {
        const force = forwardForce * input.throttle;
        carBody.applyImpulse(
          { x: forward.x * force * (1 / 60), y: forward.y * force * (1 / 60), z: forward.z * force * (1 / 60) },
          true
        );
      }
    } else if (input.throttle < 0) {
      // Check forward speed to decide brake vs reverse
      const speed = vel.x * forward.x + vel.y * forward.y + vel.z * forward.z;
      if (speed > 0.5) {
        // Braking
        const force = brakeForce * Math.abs(input.throttle);
        carBody.applyImpulse(
          { x: -forward.x * force * (1 / 60), y: -forward.y * force * (1 / 60), z: -forward.z * force * (1 / 60) },
          true
        );
      } else {
        // Reversing
        const force = reverseForce * Math.abs(input.throttle);
        carBody.applyImpulse(
          { x: -forward.x * force * (1 / 60), y: -forward.y * force * (1 / 60), z: -forward.z * force * (1 / 60) },
          true
        );
      }
    }

    // 2. Boost
    if (input.boost) {
      const boostForce = getConstant('CAR.BOOST.FORCE');
      carBody.applyImpulse(
        { x: forward.x * boostForce * (1 / 60), y: forward.y * boostForce * (1 / 60), z: forward.z * boostForce * (1 / 60) },
        true
      );
    }

    // 3. Steering — torque around Y axis, scaled by speed
    if (Math.abs(input.steer) > 0.01) {
      const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
      const maxSpeed = getConstant('CAR.ENGINE.MAX_SPEED');
      const speedRatio = Math.min(speed / maxSpeed, 1);
      const turnRateLow = getConstant('CAR.STEERING.TURN_RATE');
      const turnRateHigh = getConstant('CAR.STEERING.TURN_RATE_AT_MAX');
      const turnRate = turnRateLow + (turnRateHigh - turnRateLow) * speedRatio;

      carBody.applyTorqueImpulse(
        { x: 0, y: turnRate * input.steer * mass * (1 / 60), z: 0 },
        true
      );
    }

    // 4. LATERAL GRIP — THE KEY TO CAR FEEL
    // Project velocity onto lateral (right) axis and apply counter-force
    const lateralSpeed = vel.x * right.x + vel.y * right.y + vel.z * right.z;
    const grip = getConstant('CAR.STEERING.LATERAL_GRIP');
    const counterForce = -lateralSpeed * grip * mass * (1 / 60);
    carBody.applyImpulse(
      { x: right.x * counterForce, y: right.y * counterForce, z: right.z * counterForce },
      true
    );

    // 5. Jump
    if (input.jump && jumpUsed.count < getConstant('CAR.JUMP.MAX_JUMPS')) {
      const impulse = getConstant('CAR.JUMP.IMPULSE');
      carBody.applyImpulse({ x: 0, y: impulse, z: 0 }, true);
      jumpUsed.count++;
    }
  } else {
    // --- AIRBORNE PHYSICS ---
    // Air control: roll and pitch only
    const airRoll = getConstant('CAR.JUMP.AIR_ROLL_RATE');
    const airPitch = getConstant('CAR.JUMP.AIR_PITCH_RATE');

    if (Math.abs(input.steer) > 0.01) {
      // Roll around forward axis
      carBody.applyTorqueImpulse(
        { x: forward.x * airRoll * input.steer * mass * (1 / 60), y: 0, z: forward.z * airRoll * input.steer * mass * (1 / 60) },
        true
      );
    }
    if (Math.abs(input.throttle) > 0.01) {
      // Pitch around right axis
      carBody.applyTorqueImpulse(
        { x: right.x * airPitch * input.throttle * mass * (1 / 60), y: 0, z: right.z * airPitch * input.throttle * mass * (1 / 60) },
        true
      );
    }

    // Reduced boost in air (still works)
    if (input.boost) {
      const boostForce = getConstant('CAR.BOOST.FORCE');
      carBody.applyImpulse(
        { x: forward.x * boostForce * (1 / 60), y: forward.y * boostForce * (1 / 60), z: forward.z * boostForce * (1 / 60) },
        true
      );
    }
  }
}
