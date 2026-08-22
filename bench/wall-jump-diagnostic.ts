/**
 * Measure whether a car can jump while it is driving on the arena wall.
 *
 * Jumping is gated on support, not on being near the floor: `car-controller.ts`
 * only raises `first-jump` when `observation.grounded === true`, and it pushes
 * along the chassis roof axis. On a wall that axis points away from the wall,
 * so a working wall jump should shove the car off the surface rather than up.
 *
 * That makes the jump a direct probe of wall support. While the wall was gated
 * out of grounding, `grounded` never became true up there and the input was
 * silently dropped, which is the symptom this measures.
 *
 * This drives the real room pipeline, waits until the live grounding decision
 * reports support on a steep surface well above the floor-to-wall ramp, then
 * fires one jump edge and reports what the solver actually did with it.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_COLLISION_GEOMETRY,
  INPUT_PROTOCOL_VERSION,
  PHYSICS,
  ROOM_POLICIES,
  TUNING_IDS,
  getScalarTuningValue,
  type InputCommandV2,
  type RoomPinnedTuningSnapshot,
  type RosterEntry,
} from '@rocket-arena/shared';
import { getConstant } from '@rocket-arena/shared/constants';
import { AuthoritativeRoomCore } from '../server/src/rooms/authoritative-room-core.js';
import {
  initializeAuthoritativeRapierWorld,
  type AuthoritativeRapierCar,
  type AuthoritativeRapierRoomWorldBundle,
} from '../server/src/rooms/rapier-room-world.js';

const FIXED_STEP_MS = PHYSICS.TIMESTEP * 1_000;

/** Above the floor-to-wall ramp, so support here can only be the wall itself. */
const WALL_CONTACT_MIN_HEIGHT = 6;
const STEEP_NORMAL_MAX_UP = 0.5;
const APPROACH_STEP_BUDGET = 400;
const POST_JUMP_STEPS = 90;

const NEUTRAL_INPUT: Readonly<InputCommandV2> = Object.freeze({
  protocolVersion: INPUT_PROTOCOL_VERSION,
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jumpHeld: false,
  jumpSequence: 0,
  boostHeld: false,
  powerslideHeld: false,
  cameraToggleSequence: 0,
});

type Vector3 = { x: number; y: number; z: number };

type RapierCore = AuthoritativeRoomCore<
  RAPIER.World,
  AuthoritativeRapierCar,
  RAPIER.RigidBody
>;

let groundedNow = false;
let normalNow: Vector3 = { x: 0, y: 1, z: 0 };
let roomTuningSnapshot: RoomPinnedTuningSnapshot | null = null;

function initialCarPosition(
  _entry: Pick<RosterEntry, 'acceptedJoinOrdinal' | 'team'>,
  tuning: RoomPinnedTuningSnapshot,
): Readonly<Vector3> {
  roomTuningSnapshot = tuning;
  return Object.freeze({
    x: 0,
    y: getScalarTuningValue(tuning, TUNING_IDS.car.collider.height) / 2 + 0.02,
    z: 0,
  });
}

async function createHarness(): Promise<{
  readonly core: RapierCore;
  readonly bundle: AuthoritativeRapierRoomWorldBundle;
}> {
  let bundle: AuthoritativeRapierRoomWorldBundle | null = null;
  const core = new AuthoritativeRoomCore<RAPIER.World, AuthoritativeRapierCar, RAPIER.RigidBody>({
    roomId: 'wall-jump-diagnostic',
    mode: 'custom',
    policy: ROOM_POLICIES.custom,
    initializeWorld: async (context) => {
      const base = await initializeAuthoritativeRapierWorld(context, {
        resolvedGeometry: ARENA_COLLISION_GEOMETRY,
        initialCarPosition,
      });
      // Observe the live grounding decision without altering it.
      bundle = {
        ...base,
        groundCar: (groundingContext) => {
          const result = base.groundCar(groundingContext);
          groundedNow = result.grounded;
          if (result.basis) normalNow = { ...result.basis.normal };
          return result;
        },
      };
      return bundle;
    },
    logger: { info: () => {}, error: () => {} },
  });
  await core.initialize();
  if (bundle === null) throw new Error('bundle was not captured');
  return { core, bundle };
}

async function join(core: RapierCore, sessionId: string): Promise<void> {
  const pending = core.queueMutation({ kind: 'join', sessionId, name: sessionId });
  core.advanceSimulation(FIXED_STEP_MS);
  const result = await pending;
  if (!result.ok) throw new Error(`join failed: ${result.message}`);
}

async function start(core: RapierCore, sessionId: string): Promise<void> {
  const pending = core.queueMutation({ kind: 'start', sessionId });
  core.advanceSimulation(FIXED_STEP_MS);
  const result = await pending;
  if (!result.ok) throw new Error(`start failed: ${result.message}`);
}

function rotateVector(
  q: { x: number; y: number; z: number; w: number },
  v: Vector3,
): Vector3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

function dot(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function degreesBetween(left: Vector3, right: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(left, right)))) * 180 / Math.PI;
}

async function run(): Promise<void> {
  const { core, bundle } = await createHarness();
  await join(core, 'host');
  await start(core, 'host');
  // Clear the kickoff countdown so throttle is actually honoured.
  for (let index = 0; index < 240; index += 1) core.advanceSimulation(FIXED_STEP_MS);

  const car = bundle.carsBySessionId.get('host');
  if (!car) throw new Error('car missing');
  if (roomTuningSnapshot === null) throw new Error('room tuning was not captured');
  const expectedJumpDelta = getScalarTuningValue(
    roomTuningSnapshot,
    TUNING_IDS.car.jump.firstVelocityChange,
  );

  console.log('wall jump probe');
  console.log(`  engage at ${getConstant('CAR.WALL_DRIVE.ENGAGE_SPEED')} m/s,`
    + ` release below ${getConstant('CAR.WALL_DRIVE.RELEASE_SPEED')} m/s`);
  console.log(`  first jump velocity change: ${expectedJumpDelta.toFixed(2)} m/s along the roof axis`);
  console.log(`  wall contact accepted above y = ${WALL_CONTACT_MIN_HEIGHT} m`
    + ` with normal.y < ${STEEP_NORMAL_MAX_UP}\n`);

  // Face the +X wall with room to build speed. Yaw +90 degrees maps local
  // forward (0,0,1) to +X. Everything after this is the live pipeline.
  const half = Math.SQRT1_2;
  car.body.setTranslation({ x: 14, y: 0.4, z: 0 }, true);
  car.body.setRotation({ x: 0, y: half, z: 0, w: half }, true);
  car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

  let approachSteps = 0;
  let wallContact: {
    readonly step: number;
    readonly position: Vector3;
    readonly normal: Vector3;
    readonly normalVelocity: number;
    readonly roofOffsetDegrees: number;
  } | null = null;

  while (approachSteps < APPROACH_STEP_BUDGET) {
    core.submitInput('host', { ...NEUTRAL_INPUT, throttle: 1, boostHeld: true });
    core.advanceSimulation(FIXED_STEP_MS);
    approachSteps += 1;

    const position = car.body.translation();
    if (
      groundedNow
      && normalNow.y < STEEP_NORMAL_MAX_UP
      && position.y > WALL_CONTACT_MIN_HEIGHT
    ) {
      const velocity = car.body.linvel();
      const roof = rotateVector(car.body.rotation(), { x: 0, y: 1, z: 0 });
      wallContact = {
        step: approachSteps,
        position: { x: position.x, y: position.y, z: position.z },
        normal: { ...normalNow },
        normalVelocity: dot(velocity, normalNow),
        roofOffsetDegrees: degreesBetween(roof, normalNow),
      };
      break;
    }
  }

  if (wallContact === null) {
    console.log('no wall support was ever reported above'
      + ` y = ${WALL_CONTACT_MIN_HEIGHT} m within ${APPROACH_STEP_BUDGET} steps.`);
    console.log('a jump cannot fire here, because the controller requires support.');
    core.dispose?.();
    process.exitCode = 1;
    return;
  }

  console.log('driving on the wall');
  console.log(`  reached at step ${wallContact.step},`
    + ` y = ${wallContact.position.y.toFixed(3)} m,`
    + ` x = ${wallContact.position.x.toFixed(2)} m`);
  console.log(`  surface normal: (${wallContact.normal.x.toFixed(3)},`
    + ` ${wallContact.normal.y.toFixed(3)}, ${wallContact.normal.z.toFixed(3)})`);
  console.log(`  chassis roof is ${wallContact.roofOffsetDegrees.toFixed(1)} deg off that normal`);
  console.log(`  velocity along the normal before the jump:`
    + ` ${wallContact.normalVelocity.toFixed(3)} m/s\n`);

  // One jump edge. Throttle and boost stay on because that is how a player
  // arrives here, and neither pushes along the surface normal.
  const jumpInput = Object.freeze({
    ...NEUTRAL_INPUT,
    throttle: 1,
    boostHeld: true,
    jumpHeld: true,
    jumpSequence: 1,
  });

  core.submitInput('host', jumpInput);
  core.advanceSimulation(FIXED_STEP_MS);

  const afterJumpVelocity = car.body.linvel();
  const normalVelocityAfter = dot(afterJumpVelocity, wallContact.normal);
  const acceptedAtStep = car.jumpAirState.firstJumpAcceptedAtStep;

  console.log('immediately after the jump edge');
  console.log(`  firstJumpAcceptedAtStep: ${acceptedAtStep === null ? 'null' : acceptedAtStep}`);
  console.log(`  velocity along the normal: ${normalVelocityAfter.toFixed(3)} m/s`);
  console.log(`  change: ${(normalVelocityAfter - wallContact.normalVelocity).toFixed(3)} m/s`
    + ` against an expected ${expectedJumpDelta.toFixed(2)} m/s\n`);

  let peakSeparation = 0;
  let stillHeld = false;
  console.log('step  separation  normalVel  grounded');
  for (let index = 0; index < POST_JUMP_STEPS; index += 1) {
    core.submitInput('host', { ...jumpInput, jumpHeld: false });
    core.advanceSimulation(FIXED_STEP_MS);

    const position = car.body.translation();
    const separation = dot(
      {
        x: position.x - wallContact.position.x,
        y: position.y - wallContact.position.y,
        z: position.z - wallContact.position.z,
      },
      wallContact.normal,
    );
    if (separation > peakSeparation) peakSeparation = separation;
    if (groundedNow) stillHeld = true;

    if (index % 10 === 0) {
      const velocity = car.body.linvel();
      console.log(
        `${String(index).padStart(4)} ${separation.toFixed(3).padStart(11)}`
        + ` ${dot(velocity, wallContact.normal).toFixed(3).padStart(10)}`
        + ` ${String(groundedNow).padStart(9)}`,
      );
    }
  }

  const delta = normalVelocityAfter - wallContact.normalVelocity;
  const accepted = acceptedAtStep !== null;
  const pushedOff = delta >= expectedJumpDelta * 0.5;

  console.log('\nsummary');
  console.log(`  wall support reported: true (y = ${wallContact.position.y.toFixed(2)} m)`);
  console.log(`  jump accepted by the controller: ${accepted}`);
  console.log(`  pushed away from the wall: ${pushedOff}`);
  console.log(`  peak separation from the contact point along the normal:`
    + ` ${peakSeparation.toFixed(3)} m`);
  console.log(`  regained support at some point afterwards: ${stillHeld}`);
  console.log(`\n  verdict: ${accepted && pushedOff
    ? 'a car can jump off the wall'
    : 'the jump did not take effect on the wall'}`);

  core.dispose?.();
  if (!accepted || !pushedOff) process.exitCode = 1;
}

// Wrapped rather than top-level, because the bench harnesses transpile to CJS.
void (async () => {
  await RAPIER.init();
  await run();
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
