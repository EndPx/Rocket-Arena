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

interface Sample {
  readonly frame: number;
  readonly carY: number;
  readonly rollDegrees: number;
  readonly viewPitchDegrees: number;
  readonly cameraAzimuthDegrees: number;
  readonly cameraPosition: THREE.Vector3;
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
  return {
    frame,
    carY: car.position.y,
    rollDegrees: Math.asin(THREE.MathUtils.clamp(right.y, -1, 1)) * 180 / Math.PI,
    viewPitchDegrees: Math.asin(THREE.MathUtils.clamp(view.y, -1, 1)) * 180 / Math.PI,
    cameraAzimuthDegrees: Math.atan2(offset.z, offset.x) * 180 / Math.PI,
    cameraPosition: camera.position.clone(),
  };
}

function report(label: string, samples: readonly Sample[]): void {
  console.log(`\n${label}`);
  console.log('frame  carY   roll   viewPitch  camAzimuth  camPos');
  for (const s of samples) {
    if (s.frame % 15 !== 0) continue;
    console.log(
      `${String(s.frame).padStart(5)} ${s.carY.toFixed(2).padStart(6)}`
      + ` ${s.rollDegrees.toFixed(2).padStart(7)} ${s.viewPitchDegrees.toFixed(1).padStart(10)}`
      + ` ${s.cameraAzimuthDegrees.toFixed(1).padStart(11)}`
      + `  (${s.cameraPosition.x.toFixed(2)}, ${s.cameraPosition.y.toFixed(2)},`
      + ` ${s.cameraPosition.z.toFixed(2)})`,
    );
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
    for (let frame = 0; frame < 60; frame += 1) {
      car.position.z += 0.25;
      samples.push(measure(controller, camera, car, ball, frame));
    }
    report('control: driving along the floor toward the ball', samples);
  }

  // Driving up the east wall: roof faces -X, nose faces +Y.
  {
    const controller = new CameraController();
    controller.setGameplayMode('ball');
    car.position.set(40.5, 2, 0);
    car.quaternion.copy(
      orientation(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)),
    );
    ball.position.set(0, 1.8, 0);
    const samples: Sample[] = [];
    for (let frame = 0; frame < 90; frame += 1) {
      car.position.y = 2 + frame * 0.18;
      samples.push(measure(controller, camera, car, ball, frame));
    }
    report('climbing the east wall, ball on the floor at centre', samples);
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
