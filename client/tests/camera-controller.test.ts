import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS,
} from '@rocket-arena/shared';
import { InputController } from '../src/input/input-controller.js';
import {
  CameraController,
  DEFAULT_CAMERA_CONFIGURATION,
  type CameraConfiguration,
} from '../src/renderer/camera-controller.js';

const EPSILON = 1e-8;

interface CameraFixture {
  readonly camera: THREE.PerspectiveCamera;
  readonly car: THREE.Group;
  readonly ball: THREE.Group;
}

function createFixture(): CameraFixture {
  const camera = new THREE.PerspectiveCamera(57, 16 / 9, 0.1, 500);
  const car = new THREE.Group();
  car.position.set(2, 1, -3);
  car.quaternion.identity();
  const ball = new THREE.Group();
  ball.position.set(14, 4, 18);
  return { camera, car, ball };
}

function update(
  controller: CameraController,
  fixture: CameraFixture,
  overrides: Partial<{
    activePlay: boolean;
    cameraToggleSequence: number;
    presentedKickoffEpoch: number | null;
    elapsedSeconds: number;
    deltaSeconds: number;
  }> = {},
): void {
  controller.update({
    camera: fixture.camera,
    localCar: fixture.car,
    ball: fixture.ball,
    activePlay: overrides.activePlay ?? true,
    cameraToggleSequence: overrides.cameraToggleSequence ?? 0,
    presentedKickoffEpoch: overrides.presentedKickoffEpoch ?? 0,
    elapsedSeconds: overrides.elapsedSeconds ?? 0,
    deltaSeconds: overrides.deltaSeconds ?? 1 / 60,
  });
}

function assertVectorClose(
  actual: THREE.Vector3,
  expected: THREE.Vector3,
  epsilon = EPSILON,
): void {
  assert.ok(
    actual.distanceTo(expected) <= epsilon,
    `expected ${actual.toArray()} to be within ${epsilon} of ${expected.toArray()}`,
  );
}

function assertLooksAt(camera: THREE.PerspectiveCamera, target: THREE.Vector3): void {
  const actual = camera.getWorldDirection(new THREE.Vector3()).normalize();
  const expected = target.clone().sub(camera.position).normalize();
  assert.ok(actual.dot(expected) >= 1 - EPSILON);
}

function cloneConfiguration(
  configuration: CameraConfiguration,
): {
  ball: Record<keyof CameraConfiguration['ball'], number>;
  car: Record<keyof CameraConfiguration['car'], number>;
} {
  return {
    ball: { ...configuration.ball },
    car: { ...configuration.car },
  };
}

test('first Active Play frame forces Ball Camera from interpolated car and ball samples', () => {
  const controller = new CameraController();
  const fixture = createFixture();
  controller.beginGameplaySession(0);

  // A pre-play C edge is baselined rather than overriding the mandatory first Ball frame.
  update(controller, fixture, {
    activePlay: false,
    cameraToggleSequence: 1,
    presentedKickoffEpoch: 7,
  });
  assert.equal(controller.mode, 'ball');
  assert.equal(controller.consumedCameraToggleSequence, 0);

  update(controller, fixture, {
    activePlay: true,
    cameraToggleSequence: 1,
    presentedKickoffEpoch: 7,
  });

  const config = controller.configuration.ball;
  const expectedOrigin = fixture.car.position.clone()
    .add(new THREE.Vector3(0, 0, -config.distance));
  expectedOrigin.y += config.height;
  assert.equal(controller.mode, 'ball');
  assert.equal(controller.cameraModeTransitionCount, 0);
  assert.equal(controller.consumedCameraToggleSequence, 1);
  assertVectorClose(fixture.camera.position, expectedOrigin);
  assertLooksAt(fixture.camera, fixture.ball.position);
  assert.equal(fixture.camera.fov, config.fieldOfViewDegrees);
});

test('monotonic C-key edges toggle once while held, repeated, or released states do not', () => {
  const controller = new CameraController();
  const inputs = new InputController();
  const fixture = createFixture();
  controller.beginGameplaySession(0);
  update(controller, fixture, { cameraToggleSequence: inputs.getPayload().cameraToggleSequence });

  inputs.handleKeyDown('KeyC', false);
  update(controller, fixture, { cameraToggleSequence: inputs.getPayload().cameraToggleSequence });
  assert.equal(controller.mode, 'car');
  assert.equal(controller.cameraModeTransitionCount, 1);

  inputs.handleKeyDown('KeyC', true);
  update(controller, fixture, { cameraToggleSequence: inputs.getPayload().cameraToggleSequence });
  inputs.handleKeyDown('KeyC', false);
  update(controller, fixture, { cameraToggleSequence: inputs.getPayload().cameraToggleSequence });
  inputs.handleKeyUp('KeyC');
  update(controller, fixture, { cameraToggleSequence: inputs.getPayload().cameraToggleSequence });
  assert.equal(controller.mode, 'car');
  assert.equal(controller.cameraModeTransitionCount, 1);

  inputs.handleKeyDown('KeyC', false);
  update(controller, fixture, { cameraToggleSequence: inputs.getPayload().cameraToggleSequence });
  assert.equal(controller.mode, 'ball');
  assert.equal(controller.cameraModeTransitionCount, 2);
  assert.equal(controller.consumedCameraToggleSequence, 2);

  // Regressed and malformed sequences are never consumed.
  update(controller, fixture, { cameraToggleSequence: 1 });
  update(controller, fixture, { cameraToggleSequence: Number.NaN });
  assert.equal(controller.mode, 'ball');
  assert.equal(controller.cameraModeTransitionCount, 2);
});

test('Car Camera spring recovers and clamps finite position, rotation, and FOV output', () => {
  const controller = new CameraController();
  const fixture = createFixture();
  controller.beginGameplaySession(0);
  update(controller, fixture);
  update(controller, fixture, { cameraToggleSequence: 1 });
  assert.equal(controller.mode, 'car');

  fixture.camera.position.set(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);
  fixture.camera.quaternion.set(Number.NaN, 0, 0, 1);
  fixture.camera.fov = Number.NaN;
  fixture.car.quaternion.set(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
  update(controller, fixture, {
    cameraToggleSequence: 1,
    deltaSeconds: Number.POSITIVE_INFINITY,
  });

  assert.ok(fixture.camera.position.toArray().every(Number.isFinite));
  assert.ok(fixture.camera.quaternion.toArray().every(Number.isFinite));
  assert.ok(Math.abs(fixture.camera.quaternion.length() - 1) <= EPSILON);
  assert.ok(Number.isFinite(fixture.camera.fov));

  const horizontalOffset = Math.hypot(
    fixture.camera.position.x - fixture.car.position.x,
    fixture.camera.position.z - fixture.car.position.z,
  );
  const distanceRange = DEFAULT_TUNING_REGISTRY_SNAPSHOT
    .get(TUNING_IDS.camera.spring.distance);
  const heightRange = DEFAULT_TUNING_REGISTRY_SNAPSHOT
    .get(TUNING_IDS.camera.spring.height);
  assert.equal(distanceRange?.kind, 'scalar');
  assert.equal(heightRange?.kind, 'scalar');
  if (distanceRange?.kind !== 'scalar' || heightRange?.kind !== 'scalar') return;
  assert.ok(horizontalOffset <= distanceRange.validatedRange.max + EPSILON);
  assert.ok(fixture.camera.position.y >= fixture.car.position.y - EPSILON);
  assert.ok(
    fixture.camera.position.y
      <= fixture.car.position.y + heightRange.validatedRange.max + EPSILON,
  );
  assert.ok(
    fixture.camera.fov
      >= DEFAULT_TUNING_REGISTRY_SNAPSHOT
        .get(TUNING_IDS.camera.spring.fieldOfViewDegrees)!.validatedRange.min,
  );
  assert.ok(
    fixture.camera.fov
      <= DEFAULT_TUNING_REGISTRY_SNAPSHOT
        .get(TUNING_IDS.camera.spring.fieldOfViewDegrees)!.validatedRange.max,
  );
});

test('camera configuration updates are complete, range-checked, and all-or-nothing', () => {
  const missingSnapshot = {
    get: (id: string) => id === TUNING_IDS.camera.ball.distance
      ? undefined
      : DEFAULT_TUNING_REGISTRY_SNAPSHOT.get(id),
  };
  const controller = new CameraController(missingSnapshot);
  assert.deepEqual(controller.configuration, DEFAULT_CAMERA_CONFIGURATION);
  controller.setGameplayMode('car');

  const valid = cloneConfiguration(controller.configuration);
  valid.ball.distance = 13;
  valid.car.stiffness = 8;
  assert.equal(controller.applyConfiguration(valid), true);
  assert.equal(controller.configuration.ball.distance, 13);
  assert.equal(controller.configuration.car.stiffness, 8);
  assert.ok(Object.isFrozen(controller.configuration));
  assert.ok(Object.isFrozen(controller.configuration.ball));
  const accepted = controller.configuration;

  const nonFinite = cloneConfiguration(accepted);
  nonFinite.car.damping = Number.NaN;
  assert.equal(controller.applyConfiguration(nonFinite), false);
  assert.strictEqual(controller.configuration, accepted);
  assert.equal(controller.mode, 'car');

  const outOfRange = cloneConfiguration(accepted);
  outOfRange.ball.distance = 25.01;
  assert.equal(controller.applyConfiguration(outOfRange), false);
  assert.strictEqual(controller.configuration, accepted);
  assert.equal(controller.mode, 'car');

  assert.equal(controller.applyConfiguration({ ball: accepted.ball }), false);
  assert.strictEqual(controller.configuration, accepted);
  assert.equal(controller.mode, 'car');

  let statefulFovReads = 0;
  const stateful = cloneConfiguration(accepted);
  Object.defineProperty(stateful.ball, 'fieldOfViewDegrees', {
    configurable: true,
    enumerable: true,
    get: () => {
      statefulFovReads += 1;
      return statefulFovReads === 1
        ? accepted.ball.fieldOfViewDegrees
        : Number.NaN;
    },
  });
  assert.equal(controller.applyConfiguration(stateful), false);
  assert.equal(statefulFovReads, 0);
  assert.strictEqual(controller.configuration, accepted);
  assert.equal(controller.mode, 'car');

  const fixture = createFixture();
  controller.beginGameplaySession(0);
  update(controller, fixture);
  assert.ok(Number.isFinite(fixture.camera.fov));
  assert.ok(fixture.camera.projectionMatrix.elements.every(Number.isFinite));
});

test('presented kickoff epoch rebases post-teleport targets without changing mode', () => {
  const controller = new CameraController();
  const fixture = createFixture();
  controller.beginGameplaySession(0);
  update(controller, fixture, { presentedKickoffEpoch: 3 });
  update(controller, fixture, {
    cameraToggleSequence: 1,
    presentedKickoffEpoch: 3,
  });
  assert.equal(controller.mode, 'car');

  fixture.car.position.add(new THREE.Vector3(3, 1, -2));
  fixture.ball.position.add(new THREE.Vector3(-4, 2, 5));
  const config = controller.configuration.car;
  const expectedPostTeleportOrigin = fixture.car.position.clone()
    .add(new THREE.Vector3(0, config.height, -config.distance));
  const expectedPostTeleportLook = fixture.car.position.clone()
    .add(new THREE.Vector3(0, 0, config.lookAhead));

  update(controller, fixture, {
    cameraToggleSequence: 1,
    presentedKickoffEpoch: 4,
  });

  assert.equal(controller.mode, 'car');
  assert.equal(controller.consumedCameraToggleSequence, 1);
  assert.equal(controller.lastPresentedKickoffEpoch, 4);
  assertVectorClose(fixture.camera.position, expectedPostTeleportOrigin);
  assertLooksAt(fixture.camera, expectedPostTeleportLook);
});

// Validates: Requirements 15.1-15.11 (air-roll heading stability)

test('a full air roll never swings the chase heading or the horizon', () => {
  for (const mode of ['car', 'ball'] as const) {
    const fixture = createFixture();
    const controller = new CameraController();
    controller.beginGameplaySession(0);
    // The first Active Play frame forces Ball Camera, so one toggle selects Car.
    const toggleSequence = mode === 'car' ? 1 : 0;

    // The very first frame baselines the toggle sequence, so only later frames
    // can carry the edge that selects Car Camera. Settle afterwards so the
    // spring history is established before rolling.
    update(controller, fixture, { cameraToggleSequence: 0, elapsedSeconds: 0 });
    for (let frame = 1; frame < 60; frame++) {
      update(controller, fixture, {
        cameraToggleSequence: toggleSequence,
        elapsedSeconds: frame / 60,
      });
    }
    assert.equal(controller.mode, mode);

    const headings: THREE.Vector3[] = [];
    const rollAxis = new THREE.Vector3(0, 0, 1);
    const steps = 180;
    for (let step = 0; step <= steps; step++) {
      // One complete roll about the chassis forward axis.
      const angle = (step / steps) * Math.PI * 2;
      fixture.car.quaternion.setFromAxisAngle(rollAxis, angle);
      update(controller, fixture, {
        cameraToggleSequence: toggleSequence,
        elapsedSeconds: 1 + step / 60,
      });

      assert.ok(
        fixture.camera.position.toArray().every(Number.isFinite),
        `${mode} camera position must stay finite through a roll`,
      );
      assert.deepEqual(
        fixture.camera.up.toArray(),
        [0, 1, 0],
        `${mode} camera must keep a world-up horizon through a roll`,
      );

      const heading = fixture.camera.getWorldDirection(new THREE.Vector3());
      heading.y = 0;
      if (heading.lengthSq() > 1e-8) headings.push(heading.normalize());
    }

    assert.ok(headings.length > steps / 2, `${mode} roll must produce headings`);
    let worstSwing = 0;
    for (let index = 1; index < headings.length; index++) {
      const previous = headings[index - 1]!;
      const current = headings[index]!;
      const swing = Math.acos(
        Math.min(1, Math.max(-1, previous.dot(current))),
      ) * 180 / Math.PI;
      worstSwing = Math.max(worstSwing, swing);
    }
    assert.ok(
      worstSwing <= 5,
      `${mode} chase heading swung ${worstSwing.toFixed(2)} degrees in one frame during a roll`,
    );
  }
});

test('a front flip hands the heading over without reversing the chase side', () => {
  const fixture = createFixture();
  const controller = new CameraController();
  controller.beginGameplaySession(0);
  update(controller, fixture, { cameraToggleSequence: 0, elapsedSeconds: 0 });
  for (let frame = 1; frame < 60; frame++) {
    update(controller, fixture, { cameraToggleSequence: 1, elapsedSeconds: frame / 60 });
  }
  assert.equal(controller.mode, 'car');

  const pitchAxis = new THREE.Vector3(1, 0, 0);
  const headings: THREE.Vector3[] = [];
  const steps = 180;
  for (let step = 0; step <= steps; step++) {
    const angle = (step / steps) * Math.PI * 2;
    fixture.car.quaternion.setFromAxisAngle(pitchAxis, angle);
    update(controller, fixture, { cameraToggleSequence: 1, elapsedSeconds: 1 + step / 60 });
    assert.ok(fixture.camera.position.toArray().every(Number.isFinite));
    assert.deepEqual(fixture.camera.up.toArray(), [0, 1, 0]);
    const heading = fixture.camera.getWorldDirection(new THREE.Vector3());
    heading.y = 0;
    if (heading.lengthSq() > 1e-8) headings.push(heading.normalize());
  }

  let worstSwing = 0;
  for (let index = 1; index < headings.length; index++) {
    const swing = Math.acos(
      Math.min(1, Math.max(-1, headings[index - 1]!.dot(headings[index]!))),
    ) * 180 / Math.PI;
    worstSwing = Math.max(worstSwing, swing);
  }
  assert.ok(
    worstSwing <= 12,
    `chase heading swung ${worstSwing.toFixed(2)} degrees in one frame during a flip`,
  );
  const first = headings[0]!;
  const last = headings[headings.length - 1]!;
  assert.ok(
    first.dot(last) > 0.9,
    'a completed flip must return to the same chase side',
  );
});
