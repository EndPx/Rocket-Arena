import RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS, getConstant } from '../../../shared/src/constants/index.js';
import type { InputPayload } from '../../../shared/src/types/input.js';

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Quaternion extends Vec3 {
  w: number;
}

export interface CarPhysicsState {
  /** Number of jumps used since the last confirmed landing. */
  count: number;
  /** Held state used only by backwards-compatible boolean input. */
  jumpHeld: boolean;
  /** Highest monotonic jump press id consumed or intentionally discarded. */
  lastJumpSequence: number;
  grounded: boolean;
  wasGrounded: boolean;
  airborneTime: number;
  landingTime: number;
  leftGroundSinceJump: boolean;
  boostAmount: number;
  boostRechargeDelay: number;
}

export interface CarMotion {
  forward: Vec3;
  right: Vec3;
  fullForward: Vec3;
  fullRight: Vec3;
  up: Vec3;
  forwardSpeed: number;
  lateralSpeed: number;
  horizontalSpeed: number;
  upAlignment: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function normalizeJumpSequence(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function sanitizeInput(input: InputPayload): InputPayload {
  const jumpSequence = normalizeJumpSequence(input.jumpSequence);
  return {
    throttle: clamp(finiteOrZero(input.throttle), -1, 1),
    steer: clamp(finiteOrZero(input.steer), -1, 1),
    jump: input.jump === true,
    boost: input.boost === true,
    ...(jumpSequence === undefined ? {} : { jumpSequence }),
  };
}

function rotateVector(rotation: Quaternion, vector: Vec3): Vec3 {
  const { x: qx, y: qy, z: qz, w: qw } = rotation;
  const { x, y, z } = vector;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;

  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

function horizontalUnit(vector: Vec3, fallback: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.z);
  if (length <= Number.EPSILON) return fallback;
  return { x: vector.x / length, y: 0, z: vector.z / length };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function responseAlpha(rate: number, timestep: number): number {
  return 1 - Math.exp(-Math.max(rate, 0) * timestep);
}

function forceAsImpulse(force: Vec3, timestep: number): Vec3 {
  return {
    x: force.x * timestep,
    y: force.y * timestep,
    z: force.z * timestep,
  };
}

function softCapScale(speed: number, cap: number, startRatio: number): number {
  const start = cap * clamp(startRatio, 0, 1);
  if (speed <= start) return 1;
  if (speed >= cap || cap <= start) return 0;
  return 1 - (speed - start) / (cap - start);
}

/** Construct the per-car runtime state owned by a room or deterministic harness. */
export function createCarPhysicsState(): CarPhysicsState {
  return {
    count: 0,
    jumpHeld: false,
    lastJumpSequence: 0,
    grounded: false,
    wasGrounded: false,
    airborneTime: 0,
    landingTime: 0,
    leftGroundSinceJump: false,
    boostAmount: clamp(
      getConstant('CAR.BOOST.START_AMOUNT'),
      0,
      getConstant('CAR.BOOST.MAX_AMOUNT'),
    ),
    boostRechargeDelay: 0,
  };
}

/**
 * Consume/discard the current jump edge without applying physics. Rooms use
 * this while input is disabled so lobby, countdown, and reset presses cannot
 * queue an automatic kickoff jump.
 */
export function synchronizeCarInputState(
  state: CarPhysicsState,
  input: InputPayload,
): void {
  state.jumpHeld = input.jump === true;
  const sequence = normalizeJumpSequence(input.jumpSequence);
  if (sequence !== undefined) {
    state.lastJumpSequence = Math.max(state.lastJumpSequence, sequence);
  }
}

/** Reset transient motion state while retaining consumed input-edge history. */
export function resetCarPhysicsState(
  state: CarPhysicsState,
  resetBoost: boolean = true,
): void {
  state.count = 0;
  state.grounded = false;
  state.wasGrounded = false;
  state.airborneTime = 0;
  state.landingTime = 0;
  state.leftGroundSinceJump = false;
  state.boostRechargeDelay = 0;
  if (resetBoost) {
    state.boostAmount = clamp(
      getConstant('CAR.BOOST.START_AMOUNT'),
      0,
      getConstant('CAR.BOOST.MAX_AMOUNT'),
    );
  }
}

/** Create a rounded dynamic chassis with stable, low-friction contacts. */
export function createCar(
  world: RAPIER.World,
  position: Vec3,
  rotation?: Quaternion,
): RAPIER.RigidBody {
  const width = getConstant('CAR.BODY.WIDTH');
  const height = getConstant('CAR.BODY.HEIGHT');
  const length = getConstant('CAR.BODY.LENGTH');
  const cornerRadius = getConstant('CAR.BODY.CORNER_RADIUS');

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(position.x, position.y, position.z)
    .setLinearDamping(getConstant('CAR.DAMPING.LINEAR'))
    .setAngularDamping(getConstant('CAR.DAMPING.ANGULAR'))
    .setCcdEnabled(true)
    .setSoftCcdPrediction(getConstant('CAR.BODY.SOFT_CCD_PREDICTION'))
    .setAdditionalSolverIterations(Math.round(
      getConstant('CAR.BODY.ADDITIONAL_SOLVER_ITERATIONS'),
    ));

  if (rotation) bodyDesc.setRotation(rotation);
  const body = world.createRigidBody(bodyDesc);

  world.createCollider(
    RAPIER.ColliderDesc.roundCuboid(
      width / 2 - cornerRadius,
      height / 2 - cornerRadius,
      length / 2 - cornerRadius,
      cornerRadius,
    )
      .setMass(getConstant('CAR.BODY.MASS'))
      .setFriction(getConstant('CAR.BODY.FRICTION'))
      .setRestitution(getConstant('CAR.BODY.RESTITUTION'))
      .setContactSkin(getConstant('CAR.BODY.CONTACT_SKIN'))
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max),
    body,
  );

  world.updateSceneQueries();
  return body;
}

/** Read local motion components used by the controller and test harnesses. */
export function getCarMotion(carBody: RAPIER.RigidBody): CarMotion {
  const rotation = carBody.rotation();
  const velocity = carBody.linvel();
  const fullForward = rotateVector(rotation, { x: 0, y: 0, z: 1 });
  const fullRight = rotateVector(rotation, { x: 1, y: 0, z: 0 });
  const up = rotateVector(rotation, { x: 0, y: 1, z: 0 });
  const forward = horizontalUnit(fullForward, { x: 0, y: 0, z: 1 });
  const right = { x: forward.z, y: 0, z: -forward.x };

  return {
    forward,
    right,
    fullForward,
    fullRight,
    up,
    forwardSpeed: dot(velocity, forward),
    lateralSpeed: dot(velocity, right),
    horizontalSpeed: Math.hypot(velocity.x, velocity.z),
    upAlignment: clamp(up.y, -1, 1),
  };
}

/**
 * Query several chassis points against fixed, non-sensor geometry only.
 * Dynamic cars and the ball cannot rearm a jump.
 */
export function isGrounded(world: RAPIER.World, carBody: RAPIER.RigidBody): boolean {
  if (carBody.linvel().y > getConstant('CAR.GROUND.MAX_UPWARD_SPEED')) return false;

  const widthOffset = getConstant('CAR.BODY.WIDTH') * getConstant('CAR.GROUND.RAY_SPREAD_X');
  const lengthOffset = getConstant('CAR.BODY.LENGTH') * getConstant('CAR.GROUND.RAY_SPREAD_Z');
  const rayLength = getConstant('CAR.BODY.HEIGHT') / 2
    + getConstant('CAR.GROUND.CONTACT_MARGIN');
  const position = carBody.translation();
  const rotation = carBody.rotation();
  const offsets: Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: widthOffset, y: 0, z: lengthOffset },
    { x: -widthOffset, y: 0, z: lengthOffset },
    { x: widthOffset, y: 0, z: -lengthOffset },
    { x: -widthOffset, y: 0, z: -lengthOffset },
  ];
  const filterFlags = RAPIER.QueryFilterFlags.ONLY_FIXED
    | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;

  return offsets.some((offset) => {
    const rotatedOffset = rotateVector(rotation, offset);
    const ray = new RAPIER.Ray(
      {
        x: position.x + rotatedOffset.x,
        y: position.y + rotatedOffset.y,
        z: position.z + rotatedOffset.z,
      },
      { x: 0, y: -1, z: 0 },
    );

    return world.castRay(
      ray,
      rayLength,
      true,
      filterFlags,
      undefined,
      undefined,
      carBody,
    ) !== null;
  });
}

function updateLandingState(
  state: CarPhysicsState,
  grounded: boolean,
  timestep: number,
): void {
  if (grounded) {
    state.landingTime += timestep;
    if (
      state.leftGroundSinceJump
      && state.landingTime >= getConstant('CAR.JUMP.LANDING_CONFIRM_TIME')
    ) {
      state.count = 0;
      state.leftGroundSinceJump = false;
    }
    state.airborneTime = 0;
  } else {
    state.landingTime = 0;
    state.airborneTime += timestep;
    if (
      state.count > 0
      && state.airborneTime >= getConstant('CAR.JUMP.MIN_AIRBORNE_TIME')
    ) {
      state.leftGroundSinceJump = true;
    }
  }

  state.wasGrounded = state.grounded;
  state.grounded = grounded;
}

function consumeOrRechargeBoost(
  state: CarPhysicsState,
  requested: boolean,
  timestep: number,
): number {
  const usageRate = Math.max(getConstant('CAR.BOOST.USAGE_RATE'), 0);
  const amountNeeded = usageRate * timestep;

  if (requested) {
    state.boostRechargeDelay = getConstant('CAR.BOOST.RECHARGE_DELAY');
    if (state.boostAmount <= 0) return 0;

    const fraction = amountNeeded > 0
      ? Math.min(state.boostAmount / amountNeeded, 1)
      : 1;
    state.boostAmount = Math.max(0, state.boostAmount - amountNeeded);
    return fraction;
  }

  state.boostRechargeDelay = Math.max(0, state.boostRechargeDelay - timestep);
  if (state.boostRechargeDelay <= 0) {
    state.boostAmount = Math.min(
      getConstant('CAR.BOOST.MAX_AMOUNT'),
      state.boostAmount + getConstant('CAR.BOOST.RECHARGE_RATE') * timestep,
    );
  }
  return 0;
}

function applyLateralTraction(
  carBody: RAPIER.RigidBody,
  motion: CarMotion,
  steer: number,
  timestep: number,
): void {
  const slipRatio = clamp(
    Math.abs(motion.lateralSpeed) / getConstant('CAR.STEERING.FULL_GRIP_LATERAL_SPEED'),
    0,
    1,
  );
  const baseRate = getConstant('CAR.STEERING.BASE_GRIP_RATE');
  const maxRate = getConstant('CAR.STEERING.MAX_GRIP_RATE');
  const steeringSlip = 1
    - Math.abs(steer) * getConstant('CAR.STEERING.STEERING_SLIP_FACTOR');
  const gripRate = (baseRate + (maxRate - baseRate) * slipRatio) * steeringSlip;
  const velocityCorrection = -motion.lateralSpeed * responseAlpha(gripRate, timestep);
  const impulse = velocityCorrection * carBody.mass();

  carBody.applyImpulse({
    x: motion.right.x * impulse,
    y: 0,
    z: motion.right.z * impulse,
  }, true);
}

function applyDrag(
  carBody: RAPIER.RigidBody,
  coasting: boolean,
  timestep: number,
): void {
  const velocity = carBody.linvel();
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed <= Number.EPSILON) return;

  if (coasting && speed <= getConstant('CAR.DAMPING.STOP_SPEED')) {
    carBody.setLinvel({ x: 0, y: velocity.y, z: 0 }, true);
    return;
  }

  const dragForce = getConstant('CAR.DAMPING.AERO_COEFFICIENT') * speed * speed
    + (coasting ? getConstant('CAR.DAMPING.COAST_FORCE') : 0);
  const speedReduction = Math.min(speed, dragForce / carBody.mass() * timestep);
  const impulseMagnitude = speedReduction * carBody.mass();

  carBody.applyImpulse({
    x: -velocity.x / speed * impulseMagnitude,
    y: 0,
    z: -velocity.z / speed * impulseMagnitude,
  }, true);
}

function applySoftSpeedCap(
  carBody: RAPIER.RigidBody,
  cap: number,
  includeVertical: boolean,
  timestep: number,
): void {
  const velocity = carBody.linvel();
  const speed = includeVertical
    ? Math.hypot(velocity.x, velocity.y, velocity.z)
    : Math.hypot(velocity.x, velocity.z);
  if (speed <= cap || speed <= Number.EPSILON) return;

  const correction = Math.min(
    (speed - cap) * responseAlpha(getConstant('CAR.ENGINE.CAP_RESPONSE'), timestep),
    getConstant('CAR.ENGINE.MAX_CAP_DECELERATION') * timestep,
  );
  const impulse = correction * carBody.mass();
  const verticalScale = includeVertical ? 1 : 0;

  carBody.applyImpulse({
    x: -velocity.x / speed * impulse,
    y: -velocity.y / speed * impulse * verticalScale,
    z: -velocity.z / speed * impulse,
  }, true);
}

function applyGroundAngularControl(
  carBody: RAPIER.RigidBody,
  motion: CarMotion,
  steer: number,
  timestep: number,
): void {
  const deadzone = getConstant('CAR.ENGINE.INPUT_DEADZONE');
  const current = carBody.angvel();
  const speedRatio = clamp(
    motion.horizontalSpeed / getConstant('CAR.ENGINE.MAX_SPEED'),
    0,
    1,
  );
  const lowSpeedRate = getConstant('CAR.STEERING.TURN_RATE');
  const highSpeedRate = getConstant('CAR.STEERING.TURN_RATE_AT_MAX');
  const turnRate = lowSpeedRate + (highSpeedRate - lowSpeedRate) * speedRatio;
  const authority = clamp(
    motion.horizontalSpeed / getConstant('CAR.STEERING.FULL_AUTHORITY_SPEED'),
    0,
    1,
  );
  const reverseSign = motion.forwardSpeed < -getConstant('CAR.ENGINE.BRAKE_TO_REVERSE_SPEED')
    ? -1
    : 1;
  const targetYaw = Math.abs(steer) > deadzone
    ? steer * turnRate * authority * reverseSign
    : 0;
  const yawRate = Math.abs(steer) > deadzone
    ? getConstant('CAR.STEERING.RESPONSE')
    : getConstant('CAR.STEERING.CENTERING_RESPONSE');
  const yaw = current.y + (targetYaw - current.y) * responseAlpha(yawRate, timestep);

  let correctionX = -motion.up.z;
  let correctionZ = motion.up.x;
  if (motion.upAlignment < 0) {
    const invertedAssist = getConstant('CAR.UPRIGHT.INVERTED_ASSIST');
    correctionX += motion.fullForward.x * invertedAssist;
    correctionZ += motion.fullForward.z * invertedAssist;
  }
  const uprightStrength = getConstant('CAR.UPRIGHT.STRENGTH');
  let targetX = correctionX * uprightStrength;
  let targetZ = correctionZ * uprightStrength;
  const targetMagnitude = Math.hypot(targetX, targetZ);
  const maxAngularSpeed = getConstant('CAR.UPRIGHT.MAX_ANGULAR_SPEED');
  if (targetMagnitude > maxAngularSpeed) {
    targetX = targetX / targetMagnitude * maxAngularSpeed;
    targetZ = targetZ / targetMagnitude * maxAngularSpeed;
  }
  const uprightAlpha = responseAlpha(getConstant('CAR.UPRIGHT.RESPONSE'), timestep);

  carBody.setAngvel({
    x: current.x + (targetX - current.x) * uprightAlpha,
    y: yaw,
    z: current.z + (targetZ - current.z) * uprightAlpha,
  }, true);
}

function applyAirAngularControl(
  carBody: RAPIER.RigidBody,
  motion: CarMotion,
  input: InputPayload,
  timestep: number,
): void {
  const targetPitch = input.throttle * getConstant('CAR.JUMP.AIR_PITCH_RATE');
  const targetRoll = input.steer * getConstant('CAR.JUMP.AIR_ROLL_RATE');
  const target = {
    x: motion.fullRight.x * targetPitch + motion.fullForward.x * targetRoll,
    y: motion.fullRight.y * targetPitch + motion.fullForward.y * targetRoll,
    z: motion.fullRight.z * targetPitch + motion.fullForward.z * targetRoll,
  };
  const current = carBody.angvel();
  const alpha = responseAlpha(getConstant('CAR.JUMP.AIR_CONTROL_RESPONSE'), timestep);

  carBody.setAngvel({
    x: current.x + (target.x - current.x) * alpha,
    y: current.y + (target.y - current.y) * alpha,
    z: current.z + (target.z - current.z) * alpha,
  }, true);
}

/** Apply one fixed 60 Hz authoritative arcade-car simulation step. */
export function applyCarPhysics(
  world: RAPIER.World,
  carBody: RAPIER.RigidBody,
  rawInput: InputPayload,
  state: CarPhysicsState,
): void {
  const timestep = PHYSICS.TIMESTEP;
  const input = sanitizeInput(rawInput);
  const deadzone = getConstant('CAR.ENGINE.INPUT_DEADZONE');
  const grounded = isGrounded(world, carBody);
  const sequence = input.jumpSequence;
  const jumpPressed = sequence === undefined
    ? input.jump && !state.jumpHeld
    : sequence > state.lastJumpSequence;
  if (sequence !== undefined) {
    state.lastJumpSequence = Math.max(state.lastJumpSequence, sequence);
  }
  state.jumpHeld = input.jump;
  updateLandingState(state, grounded, timestep);

  const canJump = grounded
    && jumpPressed
    && state.count < getConstant('CAR.JUMP.MAX_JUMPS');
  const boostFraction = consumeOrRechargeBoost(state, input.boost, timestep);
  const boosting = boostFraction > 0;
  let motion = getCarMotion(carBody);

  if (grounded) {
    if (input.throttle > deadzone) {
      const scale = softCapScale(
        Math.max(motion.forwardSpeed, 0),
        getConstant('CAR.ENGINE.MAX_SPEED'),
        getConstant('CAR.ENGINE.CAP_START_RATIO'),
      );
      const force = getConstant('CAR.ENGINE.FORWARD_FORCE') * input.throttle * scale;
      carBody.applyImpulse(forceAsImpulse({
        x: motion.forward.x * force,
        y: 0,
        z: motion.forward.z * force,
      }, timestep), true);
    } else if (input.throttle < -deadzone) {
      const amount = Math.abs(input.throttle);
      if (motion.forwardSpeed > getConstant('CAR.ENGINE.BRAKE_TO_REVERSE_SPEED')) {
        const force = getConstant('CAR.ENGINE.BRAKE_FORCE') * amount;
        carBody.applyImpulse(forceAsImpulse({
          x: -motion.forward.x * force,
          y: 0,
          z: -motion.forward.z * force,
        }, timestep), true);
      } else {
        const scale = softCapScale(
          Math.max(-motion.forwardSpeed, 0),
          getConstant('CAR.ENGINE.REVERSE_MAX_SPEED'),
          getConstant('CAR.ENGINE.CAP_START_RATIO'),
        );
        const force = getConstant('CAR.ENGINE.REVERSE_FORCE') * amount * scale;
        carBody.applyImpulse(forceAsImpulse({
          x: -motion.forward.x * force,
          y: 0,
          z: -motion.forward.z * force,
        }, timestep), true);
      }
    }

    if (boosting) {
      motion = getCarMotion(carBody);
      const boostScale = softCapScale(
        motion.horizontalSpeed,
        getConstant('CAR.BOOST.MAX_SPEED'),
        getConstant('CAR.BOOST.CAP_START_RATIO'),
      );
      const force = getConstant('CAR.BOOST.FORCE') * boostFraction * boostScale;
      carBody.applyImpulse(forceAsImpulse({
        x: motion.forward.x * force,
        y: 0,
        z: motion.forward.z * force,
      }, timestep), true);
    }

    motion = getCarMotion(carBody);
    applyLateralTraction(carBody, motion, input.steer, timestep);
    applyDrag(carBody, Math.abs(input.throttle) <= deadzone && !boosting, timestep);

    if (Math.abs(input.throttle) > deadzone || boosting) {
      const cap = boosting
        ? getConstant('CAR.BOOST.MAX_SPEED')
        : input.throttle < 0
          ? getConstant('CAR.ENGINE.REVERSE_MAX_SPEED')
          : getConstant('CAR.ENGINE.MAX_SPEED');
      applySoftSpeedCap(carBody, cap, false, timestep);
    }

    applyGroundAngularControl(
      carBody,
      getCarMotion(carBody),
      input.steer,
      timestep,
    );

    if (!canJump) {
      carBody.applyImpulse({
        x: 0,
        y: -getConstant('CAR.GROUND.STICK_FORCE') * timestep,
        z: 0,
      }, true);
    }
  } else {
    if (boosting) {
      const speed = Math.hypot(carBody.linvel().x, carBody.linvel().y, carBody.linvel().z);
      const boostScale = softCapScale(
        speed,
        getConstant('CAR.BOOST.MAX_SPEED'),
        getConstant('CAR.BOOST.CAP_START_RATIO'),
      );
      const force = getConstant('CAR.BOOST.FORCE')
        * getConstant('CAR.BOOST.AIR_FORCE_MULTIPLIER')
        * boostFraction
        * boostScale;
      carBody.applyImpulse(forceAsImpulse({
        x: motion.fullForward.x * force,
        y: motion.fullForward.y * force,
        z: motion.fullForward.z * force,
      }, timestep), true);
      applySoftSpeedCap(carBody, getConstant('CAR.BOOST.MAX_SPEED'), true, timestep);
    }

    applyAirAngularControl(carBody, motion, input, timestep);
  }

  if (canJump) {
    carBody.applyImpulse({ x: 0, y: getConstant('CAR.JUMP.IMPULSE'), z: 0 }, true);
    state.count += 1;
    state.grounded = false;
    state.wasGrounded = false;
    state.airborneTime = 0;
    state.landingTime = 0;
    state.leftGroundSinceJump = false;
  }
}
