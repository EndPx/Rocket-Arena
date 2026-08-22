/**
 * Measure what Ball Camera does while the car is driving on a wall.
 *
 * Two things in `camera-controller.ts` are only reachable now that walls carry a
 * car, and both are suspected here.
 *
 * The chase heading comes from whichever chassis axis projects furthest onto the
 * ground plane. Driving up a wall points the nose at the sky, so forward stops
 * projecting and the heading falls back to one derived from the chassis right
 * axis, which is defined only up to a half turn.
 *
 * Ball Camera then orients with `camera.lookAt` against a fixed world up. When
 * the car is high on a wall and the ball is on the floor far below, the view
 * direction approaches vertical, which is exactly where `lookAt` degenerates and
 * the roll about the view axis stops being well conditioned.
 *
 * Roll is reported as the tilt of the rendered horizon: the y component of the
 * camera's own right axis. Zero is a level horizon, and the screenshot that
 * prompted this showed a clearly tilted one.
 */
import * as THREE from 'three';
import { CameraController } from '../client/src/renderer/camera-controller.js';

const FRAME_SECONDS = 1 / 60;
/** Ball camera runs a 65 degree field of view, so this is the on-screen limit. */
const BALL_CAMERA_HALF_FOV_DEGREES = 65 / 2;

interface Sample {
  readonly frame: number;
  readonly carY: number;
  readonly rollDegrees: number;
  readonly viewPitchDegrees: number;
  readonly cameraAzimuthDegrees: number;
  readonly cameraPosition: THREE.Vector3;
  /**
   * How well the camera sits behind the direction of travel. One means directly
   * behind, zero means off at a right angle to it, which is what a wall climb
   * used to produce.
   */
  readonly behindAlignment: number;
  /**
   * Angle between the view axis and the direction to the car. Anything past half
   * the field of view means the car is not on screen at all, and anything past 90
   * means it is behind the camera.
   */
  readonly carAngleFromViewDegrees: number;
}

function degreesBetween(left: THREE.Vector3, right: THREE.Vector3): number {
  return Math.acos(THREE.MathUtils.clamp(left.dot(right), -1, 1)) * 180 / Math.PI;
}

/** Orientation whose roof is `up` and whose nose is `forward`. */
function orientation(up: THREE.Vector3, forward: THREE.Vector3): THREE.Quaternion {
  const u = up.clone().normalize();
  const f = forward.clone().normalize();
  const right = new THREE.Vector3().crossVectors(u, f).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, u, f),
  );
}

function measure(
  controller: CameraController,
  camera: THREE.PerspectiveCamera,
  car: THREE.Object3D,
  ball: THREE.Object3D,
  frame: number,
  travel: THREE.Vector3 = new THREE.Vector3(),
): Sample {
  controller.update({
    camera,
    localCar: car,
    ball,
    elapsedSeconds: frame * FRAME_SECONDS,
    deltaSeconds: FRAME_SECONDS,
    activePlay: true,
    cameraToggleSequence: 0,
    presentedKickoffEpoch: 0,
  });

  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const view = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const offset = camera.position.clone().sub(car.position);
  const behindAlignment = offset.lengthSq() > 1e-8 && travel.lengthSq() > 1e-8
    ? offset.clone().normalize().dot(travel.clone().normalize().negate())
    : 0;
  return {
    frame,
    carY: car.position.y,
    rollDegrees: Math.asin(THREE.MathUtils.clamp(right.y, -1, 1)) * 180 / Math.PI,
    viewPitchDegrees: Math.asin(THREE.MathUtils.clamp(view.y, -1, 1)) * 180 / Math.PI,
    cameraAzimuthDegrees: Math.atan2(offset.z, offset.x) * 180 / Math.PI,
    cameraPosition: camera.position.clone(),
    behindAlignment,
    carAngleFromViewDegrees: offset.lengthSq() > 1e-8
      ? degreesBetween(view, offset.clone().normalize().negate())
      : 0,
  };
}

function report(label: string, samples: readonly Sample[]): void {
  console.log(`\n${label}`);
  console.log('frame  carY   roll   viewPitch  behind  carOffAxis  camPos');
  for (const s of samples) {
    if (s.frame % 15 !== 0) continue;
    console.log(
      `${String(s.frame).padStart(5)} ${s.carY.toFixed(2).padStart(6)}`
      + ` ${s.rollDegrees.toFixed(2).padStart(7)} ${s.viewPitchDegrees.toFixed(1).padStart(10)}`
      + ` ${s.behindAlignment.toFixed(3).padStart(7)}`
      + ` ${s.carAngleFromViewDegrees.toFixed(1).padStart(11)}`
      + `  (${s.cameraPosition.x.toFixed(2)}, ${s.cameraPosition.y.toFixed(2)},`
      + ` ${s.cameraPosition.z.toFixed(2)})`,
    );
  }
  const offScreen = samples.filter((s) => s.carAngleFromViewDegrees > BALL_CAMERA_HALF_FOV_DEGREES);
  console.log(`  frames with the car outside the ${(BALL_CAMERA_HALF_FOV_DEGREES * 2).toFixed(0)}`
    + ` degree field of view: ${offScreen.length} of ${samples.length}`);
  const settled = samples.slice(Math.floor(samples.length / 2));
  const worstBehind = settled.reduce(
    (worst, s) => Math.min(worst, s.behindAlignment),
    Number.POSITIVE_INFINITY,
  );
  if (Number.isFinite(worstBehind)) {
    console.log(`  worst behind-travel alignment over the second half: ${worstBehind.toFixed(3)}`);
  }
  const worstRoll = samples.reduce(
    (worst, s) => (Math.abs(s.rollDegrees) > Math.abs(worst) ? s.rollDegrees : worst),
    0,
  );
  let azimuthSwing = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!.cameraAzimuthDegrees;
    const current = samples[index]!.cameraAzimuthDegrees;
    let step = Math.abs(current - previous);
    if (step > 180) step = 360 - step;
    azimuthSwing = Math.max(azimuthSwing, step);
  }
  console.log(`  worst horizon tilt: ${worstRoll.toFixed(2)} deg`);
  console.log(`  largest one-frame camera azimuth jump: ${azimuthSwing.toFixed(2)} deg`);
}

function run(): void {
  const camera = new THREE.PerspectiveCamera(57, 16 / 9, 0.1, 500);
  const car = new THREE.Object3D();
  const ball = new THREE.Object3D();

  // Control: flat ground, ball ahead. The horizon must be level here.
  {
    const controller = new CameraController();
    controller.setGameplayMode('ball');
    car.position.set(0, 0.4, -20);
    car.quaternion.identity();
    ball.position.set(0, 1.8, 10);
    const samples: Sample[] = [];
    const travel = new THREE.Vector3(0, 0, 0.25);
    for (let frame = 0; frame < 60; frame += 1) {
      car.position.z += travel.z;
      samples.push(measure(controller, camera, car, ball, frame, travel));
    }
    report('control: driving along the floor toward the ball', samples);
  }

  // The same flat floor, but driving away from the ball. Ball Camera is supposed
  // to frame the car with the ball beyond it whichever way the car points.
  {
    const controller = new CameraController();
    controller.setGameplayMode('ball');
    car.position.set(0, 0.4, -10);
    car.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    ball.position.set(0, 1.8, 0);
    const samples: Sample[] = [];
    const travel = new THREE.Vector3(0, 0, -0.25);
    for (let frame = 0; frame < 60; frame += 1) {
      car.position.z += travel.z;
      samples.push(measure(controller, camera, car, ball, frame, travel));
    }
    report('driving along the floor AWAY from the ball', samples);
  }

  // Driving up the east wall in Car Camera: roof faces -X, nose faces +Y. This is
  // the mode the surface-relative chase applies to, because it looks along the
  // car rather than at the ball.
  {
    const controller = new CameraController();
    controller.setGameplayMode('car');
    car.position.set(40.5, 2, 0);
    car.quaternion.copy(
      orientation(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)),
    );
    ball.position.set(0, 1.8, 0);
    const samples: Sample[] = [];
    const travel = new THREE.Vector3(0, 0.18, 0);
    for (let frame = 0; frame < 90; frame += 1) {
      car.position.y = 2 + frame * travel.y;
      samples.push(measure(controller, camera, car, ball, frame, travel));
    }
    report('Car Camera climbing the east wall', samples);
  }

  // The same climb in Ball Camera, which deliberately keeps the world-up framing.
  {
    const controller = new CameraController();
    controller.setGameplayMode('ball');
    car.position.set(40.5, 2, 0);
    car.quaternion.copy(
      orientation(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)),
    );
    ball.position.set(0, 1.8, 0);
    const samples: Sample[] = [];
    const travel = new THREE.Vector3(0, 0.18, 0);
    for (let frame = 0; frame < 90; frame += 1) {
      car.position.y = 2 + frame * travel.y;
      samples.push(measure(controller, camera, car, ball, frame, travel));
    }
    report('Ball Camera climbing the east wall, unchanged world-up framing', samples);
  }

  // Parked on the wall at a fixed height, so nothing but the camera moves.
  {
    const controller = new CameraController();
    controller.setGameplayMode('ball');
    car.position.set(40.5, 15, 0);
    car.quaternion.copy(
      orientation(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)),
    );
    ball.position.set(0, 1.8, 0);
    const samples: Sample[] = [];
    for (let frame = 0; frame < 60; frame += 1) {
      samples.push(measure(controller, camera, car, ball, frame));
    }
    report('parked high on the east wall, nothing moving but the camera', samples);
  }

  // The camera settles about 12 m in from the wall. Sweep the ball along that
  // line to find where looking at it drives the view direction vertical, which
  // is where lookAt against a fixed world up stops being well conditioned.
  {
    console.log('\nball swept underneath the camera, car parked at (40.5, 15, 0)');
    console.log(' ballX   viewPitch     roll');
    car.position.set(40.5, 15, 0);
    car.quaternion.copy(
      orientation(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)),
    );
    let worst = 0;
    let worstBallX = 0;
    for (let ballX = 40; ballX >= 0; ballX -= 2) {
      const controller = new CameraController();
      controller.setGameplayMode('ball');
      ball.position.set(ballX, 1.8, 0);
      let last: Sample | null = null;
      for (let frame = 0; frame < 30; frame += 1) {
        last = measure(controller, camera, car, ball, frame);
      }
      if (last === null) continue;
      if (Math.abs(last.rollDegrees) > Math.abs(worst)) {
        worst = last.rollDegrees;
        worstBallX = ballX;
      }
      console.log(
        `${ballX.toFixed(1).padStart(6)} ${last.viewPitchDegrees.toFixed(1).padStart(11)}`
        + ` ${last.rollDegrees.toFixed(2).padStart(8)}`,
      );
    }
    console.log(`  worst horizon tilt ${worst.toFixed(2)} deg at ball x ${worstBallX}`);
  }
}

run();
