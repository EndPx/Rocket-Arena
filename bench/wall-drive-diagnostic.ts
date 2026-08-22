/**
 * Measure what actually happens when a car drives up the arena wall.
 *
 * Wall driving is speed-gated rather than free: `resolveDriveableSlopeDegrees`
 * in `rapier-room-world.ts` widens the accepted support angle from
 * `CAR.WALL_DRIVE.GROUNDED_SLOPE_DEGREES` to `MAXIMUM_SLOPE_DEGREES` only while
 * the car is above `ENGAGE_SPEED`, and drops it again below `RELEASE_SPEED`.
 * Separately, the authoritative controller applies no force along the support
 * normal, so nothing holds a car against a vertical surface except its own
 * momentum and the contact.
 *
 * This runs the real room pipeline, not a hand-rolled world, so grounding, the
 * hysteresis, the controller, and the solver are all the live ones. It reports
 * whether the wall ever supports the car, how high it gets, and how it comes off.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import {
  ARENA_COLLISION_GEOMETRY,
  ARENA_HALF_WIDTH_METERS,
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
const ENGAGE_SPEED = getConstant('CAR.WALL_DRIVE.ENGAGE_SPEED');
const RELEASE_SPEED = getConstant('CAR.WALL_DRIVE.RELEASE_SPEED');
const GATED_SLOPE = getConstant('CAR.WALL_DRIVE.GROUNDED_SLOPE_DEGREES');
const MAX_SLOPE = getConstant('CAR.WALL_DRIVE.MAXIMUM_SLOPE_DEGREES');

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

type RapierCore = AuthoritativeRoomCore<
  RAPIER.World,
  AuthoritativeRapierCar,
  RAPIER.RigidBody
>;

interface Sample {
  readonly step: number;
  readonly x: number;
  readonly y: number;
  readonly speed: number;
  readonly grounded: boolean;
  readonly engaged: boolean;
  /** 1 on the floor, about 0 on a vertical wall. */
  readonly normalUp: number;
  /** Angle between the car's roof and the surface normal, in degrees. */
  readonly roofOffsetDegrees: number;
}

function initialCarPosition(
  _entry: Pick<RosterEntry, 'acceptedJoinOrdinal' | 'team'>,
  tuning: RoomPinnedTuningSnapshot,
): Readonly<{ x: number; y: number; z: number }> {
  return Object.freeze({
    x: 0,
    y: getScalarTuningValue(tuning, TUNING_IDS.car.collider.height) / 2 + 0.02,
    z: 0,
  });
}

let groundedNow = false;
let normalNow = { x: 0, y: 1, z: 0 };

async function createHarness(): Promise<{
  readonly core: RapierCore;
  readonly bundle: AuthoritativeRapierRoomWorldBundle;
}> {
  let bundle: AuthoritativeRapierRoomWorldBundle | null = null;
  const core = new AuthoritativeRoomCore<RAPIER.World, AuthoritativeRapierCar, RAPIER.RigidBody>({
    roomId: 'wall-drive-diagnostic',
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
  v: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

async function run(): Promise<void> {
  console.log('wall drive policy');
  console.log(`  gated above ${GATED_SLOPE} degrees from world up`);
  console.log(`  accepted slope while engaged: ${MAX_SLOPE} degrees`);
  console.log(`  engage at ${ENGAGE_SPEED} m/s, release below ${RELEASE_SPEED} m/s`);
  console.log('  support normal force applied by the controller: none\n');

  const { core, bundle } = await createHarness();
  await join(core, 'host');
  await start(core, 'host');
  // Clear the kickoff countdown so throttle is actually honoured.
  for (let index = 0; index < 240; index += 1) core.advanceSimulation(FIXED_STEP_MS);

  const car = bundle.carsBySessionId.get('host');
  if (!car) throw new Error('car missing');

  // Place the car facing the +X wall with room to build speed, then let the live
  // pipeline do everything else. Yaw +90 degrees maps local forward (0,0,1) to +X.
  const half = Math.SQRT1_2;
  car.body.setTranslation({ x: 14, y: 0.4, z: 0 }, true);
  car.body.setRotation({ x: 0, y: half, z: 0, w: half }, true);
  car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

  const samples: Sample[] = [];
  const totalSteps = 360;
  for (let step = 0; step < totalSteps; step += 1) {
    core.submitInput('host', { ...NEUTRAL_INPUT, throttle: 1, boostHeld: true });
    core.advanceSimulation(FIXED_STEP_MS);

    const p = car.body.translation();
    const v = car.body.linvel();
    const roof = rotateVector(car.body.rotation(), { x: 0, y: 1, z: 0 });
    const dotRoofNormal = roof.x * normalNow.x + roof.y * normalNow.y + roof.z * normalNow.z;
    samples.push({
      step,
      x: p.x,
      y: p.y,
      speed: Math.hypot(v.x, v.y, v.z),
      grounded: groundedNow,
      engaged: car.wallDriveEngaged,
      normalUp: normalNow.y,
      roofOffsetDegrees: Math.acos(Math.max(-1, Math.min(1, dotRoofNormal))) * 180 / Math.PI,
    });
  }

  console.log('step   x       y      speed  grounded engaged normal.y roofOffset');
  for (const s of samples) {
    if (s.step % 20 !== 0 && s.y < 0.6) continue;
    if (s.step % 10 !== 0) continue;
    console.log(
      `${String(s.step).padStart(4)} ${s.x.toFixed(2).padStart(7)}`
      + ` ${s.y.toFixed(3).padStart(6)} ${s.speed.toFixed(2).padStart(6)}`
      + ` ${String(s.grounded).padStart(8)} ${String(s.engaged).padStart(7)}`
      + ` ${s.normalUp.toFixed(3).padStart(8)} ${s.roofOffsetDegrees.toFixed(1).padStart(10)}`,
    );
  }

  const peak = samples.reduce((best, s) => (s.y > best.y ? s : best), samples[0]!);
  const onWall = samples.filter((s) => s.grounded && s.normalUp < 0.5);
  const climbed = samples.filter((s) => s.y > 0.6);

  console.log('\nsummary');
  console.log(`  wall reached: ${samples.some((s) => Math.abs(s.x) > ARENA_HALF_WIDTH_METERS - 3)}`);
  console.log(`  highest centre: y = ${peak.y.toFixed(3)} m at step ${peak.step}`
    + ` (x ${peak.x.toFixed(2)}, speed ${peak.speed.toFixed(2)}, grounded ${peak.grounded})`);
  console.log(`  steps above y = 0.6: ${climbed.length}`);
  console.log(`  steps grounded on a steep surface (normal.y < 0.5): ${onWall.length}`);
  if (onWall.length > 0) {
    const first = onWall[0]!;
    const last = onWall[onWall.length - 1]!;
    console.log(`    first at step ${first.step}, y ${first.y.toFixed(3)},`
      + ` speed ${first.speed.toFixed(2)}, roofOffset ${first.roofOffsetDegrees.toFixed(1)} deg`);
    console.log(`    last at step ${last.step}, y ${last.y.toFixed(3)},`
      + ` speed ${last.speed.toFixed(2)}, roofOffset ${last.roofOffsetDegrees.toFixed(1)} deg`);
    console.log(`    held for ${((last.step - first.step) * PHYSICS.TIMESTEP).toFixed(2)} s`);
  }
  const worstRoof = onWall.reduce(
    (worst, s) => (s.roofOffsetDegrees > worst ? s.roofOffsetDegrees : worst),
    0,
  );
  console.log(`  worst roof-to-normal offset while on a steep surface: ${worstRoof.toFixed(1)} deg`);
  console.log('    a chassis that never aligns to the wall is one that is being');
  console.log('    carried by the contact rather than driving on the surface');

  core.dispose?.();
}

// Wrapped rather than top-level, because the bench harnesses transpile to CJS.
void (async () => {
  await RAPIER.init();
  await run();
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
