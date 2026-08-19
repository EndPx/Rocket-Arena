import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  projectBallIndicator,
  type BallIndicatorProjection,
  type BallIndicatorViewport,
  type VisibleBallIndicatorProjection,
} from '../src/hud/ball-indicator.js';

const EPSILON = 1e-8;
const VIEWPORT: BallIndicatorViewport = Object.freeze({
  width: 800,
  height: 600,
  insetX: 32,
  insetY: 28,
});

function createCamera(viewport: BallIndicatorViewport): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(
    90,
    viewport.width / viewport.height,
    0.1,
    100,
  );
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function project(
  worldPosition: THREE.Vector3,
  viewport: BallIndicatorViewport = VIEWPORT,
  camera: THREE.PerspectiveCamera = createCamera(viewport),
): BallIndicatorProjection {
  return projectBallIndicator({
    worldPosition,
    viewMatrix: camera.matrixWorldInverse,
    projectionMatrix: camera.projectionMatrix,
    viewport,
  });
}

function requireVisible(result: BallIndicatorProjection): VisibleBallIndicatorProjection {
  if (!result.visible) {
    assert.fail(`expected a visible indicator, received ${result.reason}`);
  }
  return result;
}

function approximately(actual: number, expected: number, epsilon = EPSILON): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function assertVisibleIntegrity(
  result: VisibleBallIndicatorProjection,
  viewport: BallIndicatorViewport,
): void {
  assert.ok(Number.isFinite(result.position.x));
  assert.ok(Number.isFinite(result.position.y));
  assert.ok(Number.isFinite(result.direction.x));
  assert.ok(Number.isFinite(result.direction.y));
  assert.ok(Number.isFinite(result.angleRadians));
  assert.ok(result.position.x >= viewport.insetX - EPSILON);
  assert.ok(result.position.x <= viewport.width - viewport.insetX + EPSILON);
  assert.ok(result.position.y >= viewport.insetY - EPSILON);
  assert.ok(result.position.y <= viewport.height - viewport.insetY + EPSILON);
  approximately(Math.hypot(result.direction.x, result.direction.y), 1);
  approximately(Math.cos(result.angleRadians), result.direction.x);
  approximately(Math.sin(result.angleRadians), result.direction.y);

  const touchesInsetEdge = Math.abs(result.position.x - viewport.insetX) <= EPSILON
    || Math.abs(result.position.x - (viewport.width - viewport.insetX)) <= EPSILON
    || Math.abs(result.position.y - viewport.insetY) <= EPSILON
    || Math.abs(result.position.y - (viewport.height - viewport.insetY)) <= EPSILON;
  assert.ok(touchesInsetEdge, 'indicator must intersect an inset viewport edge');
}

test('hides an in-viewport ball without mutating point, matrices, or viewport', () => {
  const camera = createCamera(VIEWPORT);
  const worldPosition = new THREE.Vector3(0.25, -0.1, -5);
  const viewport = Object.freeze({ ...VIEWPORT });
  const worldBefore = worldPosition.toArray();
  const viewBefore = camera.matrixWorldInverse.elements.slice();
  const projectionBefore = camera.projectionMatrix.elements.slice();
  const viewportBefore = { ...viewport };

  const result = projectBallIndicator({
    worldPosition,
    viewMatrix: camera.matrixWorldInverse,
    projectionMatrix: camera.projectionMatrix,
    viewport,
  });

  assert.deepEqual(result, { visible: false, reason: 'in-viewport' });
  assert.deepEqual(worldPosition.toArray(), worldBefore);
  assert.deepEqual(camera.matrixWorldInverse.elements, viewBefore);
  assert.deepEqual(camera.projectionMatrix.elements, projectionBefore);
  assert.deepEqual(viewport, viewportBefore);
});

test('honors translated and rotated view matrices for front and behind targets', () => {
  const camera = createCamera(VIEWPORT);
  camera.position.set(12, 5, -7);
  camera.lookAt(-3, 1, 4);
  camera.updateMatrixWorld(true);

  const centeredWorld = camera.localToWorld(new THREE.Vector3(0, 0, -5));
  assert.deepEqual(project(centeredWorld, VIEWPORT, camera), {
    visible: false,
    reason: 'in-viewport',
  });

  const cameraRightWorld = camera.localToWorld(new THREE.Vector3(10, 0, -1));
  const rightResult = requireVisible(project(cameraRightWorld, VIEWPORT, camera));
  assertVisibleIntegrity(rightResult, VIEWPORT);
  assert.equal(rightResult.behindCamera, false);
  assert.ok(rightResult.direction.x > 0);
  approximately(rightResult.direction.y, 0);

  const behindTopLeftWorld = camera.localToWorld(new THREE.Vector3(-4, 3, 5));
  const behindResult = requireVisible(project(behindTopLeftWorld, VIEWPORT, camera));
  assertVisibleIntegrity(behindResult, VIEWPORT);
  assert.equal(behindResult.behindCamera, true);
  assert.ok(behindResult.direction.x < 0);
  assert.ok(behindResult.direction.y < 0);
});

const edgeCases = [
  {
    name: 'left',
    point: new THREE.Vector3(-10, 0, -1),
    expectedX: VIEWPORT.insetX,
    expectedY: VIEWPORT.height / 2,
    directionX: -1,
    directionY: 0,
  },
  {
    name: 'right',
    point: new THREE.Vector3(10, 0, -1),
    expectedX: VIEWPORT.width - VIEWPORT.insetX,
    expectedY: VIEWPORT.height / 2,
    directionX: 1,
    directionY: 0,
  },
  {
    name: 'top',
    point: new THREE.Vector3(0, 10, -1),
    expectedX: VIEWPORT.width / 2,
    expectedY: VIEWPORT.insetY,
    directionX: 0,
    directionY: -1,
  },
  {
    name: 'bottom',
    point: new THREE.Vector3(0, -10, -1),
    expectedX: VIEWPORT.width / 2,
    expectedY: VIEWPORT.height - VIEWPORT.insetY,
    directionX: 0,
    directionY: 1,
  },
] as const;

for (const edgeCase of edgeCases) {
  test(`places an off-screen ball on the ${edgeCase.name} inset edge`, () => {
    const result = requireVisible(project(edgeCase.point));

    assertVisibleIntegrity(result, VIEWPORT);
    approximately(result.position.x, edgeCase.expectedX);
    approximately(result.position.y, edgeCase.expectedY);
    approximately(result.direction.x, edgeCase.directionX);
    approximately(result.direction.y, edgeCase.directionY);
    assert.equal(result.behindCamera, false);
  });
}

const cornerCases = [
  { name: 'top-left', worldX: -1, worldY: 1, expectedX: 32, expectedY: 28 },
  { name: 'top-right', worldX: 1, worldY: 1, expectedX: 768, expectedY: 28 },
  { name: 'bottom-left', worldX: -1, worldY: -1, expectedX: 32, expectedY: 572 },
  { name: 'bottom-right', worldX: 1, worldY: -1, expectedX: 768, expectedY: 572 },
] as const;

for (const cornerCase of cornerCases) {
  test(`preserves projected direction at the ${cornerCase.name} corner`, () => {
    const radiusX = VIEWPORT.width / 2 - VIEWPORT.insetX;
    const radiusY = VIEWPORT.height / 2 - VIEWPORT.insetY;
    const point = new THREE.Vector3(
      cornerCase.worldX * radiusX,
      cornerCase.worldY * radiusY,
      -1,
    );
    const result = requireVisible(project(point));

    assertVisibleIntegrity(result, VIEWPORT);
    approximately(result.position.x, cornerCase.expectedX);
    approximately(result.position.y, cornerCase.expectedY);
    assert.equal(Math.sign(result.direction.x), cornerCase.worldX);
    assert.equal(Math.sign(result.direction.y), -cornerCase.worldY);
  });
}

const behindQuadrants = [
  { name: 'top-left', worldX: -4, worldY: 3, directionX: -1, directionY: -1 },
  { name: 'top-right', worldX: 4, worldY: 3, directionX: 1, directionY: -1 },
  { name: 'bottom-left', worldX: -4, worldY: -3, directionX: -1, directionY: 1 },
  { name: 'bottom-right', worldX: 4, worldY: -3, directionX: 1, directionY: 1 },
] as const;

for (const quadrant of behindQuadrants) {
  test(`reflects a behind-camera ${quadrant.name} ball without reversing its quadrant`, () => {
    const result = requireVisible(project(new THREE.Vector3(
      quadrant.worldX,
      quadrant.worldY,
      5,
    )));

    assertVisibleIntegrity(result, VIEWPORT);
    assert.equal(result.behindCamera, true);
    assert.equal(Math.sign(result.direction.x), quadrant.directionX);
    assert.equal(Math.sign(result.direction.y), quadrant.directionY);
  });
}

test('uses a deterministic finite right-edge fallback for a ball directly behind', () => {
  const first = requireVisible(project(new THREE.Vector3(0, 0, 5)));
  const second = requireVisible(project(new THREE.Vector3(0, 0, 50)));

  assert.deepEqual(first, second);
  assertVisibleIntegrity(first, VIEWPORT);
  assert.deepEqual(first.position, { x: VIEWPORT.width - VIEWPORT.insetX, y: 300 });
  assert.deepEqual(first.direction, { x: 1, y: 0 });
  assert.equal(first.angleRadians, 0);
  assert.equal(first.behindCamera, true);
});

test('keeps extreme finite world inputs contained with finite direction metadata', () => {
  const points = [
    new THREE.Vector3(Number.MAX_VALUE, 0, -1),
    new THREE.Vector3(0, Number.MAX_VALUE, -1),
    new THREE.Vector3(Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE),
    new THREE.Vector3(Number.MIN_VALUE, 0, 0),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1e-300, -1e-300, 1e-300),
  ];

  for (const point of points) {
    assertVisibleIntegrity(requireVisible(project(point)), VIEWPORT);
  }
});

test('uses current viewport size and camera aspect after portrait-to-wide resize', () => {
  const portrait: BallIndicatorViewport = {
    width: 600,
    height: 900,
    insetX: 32,
    insetY: 28,
  };
  const wide: BallIndicatorViewport = {
    width: 1600,
    height: 600,
    insetX: 32,
    insetY: 28,
  };
  const camera = createCamera(portrait);
  const point = new THREE.Vector3(20, 20, -1);
  const portraitResult = requireVisible(project(point, portrait, camera));

  camera.aspect = wide.width / wide.height;
  camera.updateProjectionMatrix();
  const wideResult = requireVisible(project(point, wide, camera));

  assertVisibleIntegrity(portraitResult, portrait);
  assertVisibleIntegrity(wideResult, wide);
  approximately(portraitResult.position.x, portrait.width - portrait.insetX);
  assert.ok(portraitResult.position.y > portrait.insetY);
  approximately(wideResult.position.y, wide.insetY);
  assert.ok(wideResult.position.x < wide.width - wide.insetX);
  approximately(portraitResult.angleRadians, wideResult.angleRadians);
});

test('fails closed for invalid, collapsed, or center-safe-zone viewport geometry', () => {
  const invalidViewports: BallIndicatorViewport[] = [
    { ...VIEWPORT, width: 0 },
    { ...VIEWPORT, width: -1 },
    { ...VIEWPORT, width: Number.NaN },
    { ...VIEWPORT, height: Number.POSITIVE_INFINITY },
    { ...VIEWPORT, insetX: -1 },
    { ...VIEWPORT, insetY: Number.NaN },
    { ...VIEWPORT, insetX: VIEWPORT.width / 2 },
    { ...VIEWPORT, insetY: VIEWPORT.height / 2 },
    { ...VIEWPORT, insetX: VIEWPORT.width * 0.4 },
    { ...VIEWPORT, insetY: VIEWPORT.height * 0.4 },
  ];
  const camera = createCamera(VIEWPORT);

  for (const viewport of invalidViewports) {
    const result = projectBallIndicator({
      worldPosition: new THREE.Vector3(10, 0, -1),
      viewMatrix: camera.matrixWorldInverse,
      projectionMatrix: camera.projectionMatrix,
      viewport,
    });
    assert.deepEqual(result, { visible: false, reason: 'invalid-viewport' });
  }
});

test('keeps every projected edge direction outside the central 20% safe zone', () => {
  const viewport: BallIndicatorViewport = {
    width: 1280,
    height: 720,
    insetX: 40,
    insetY: 40,
  };
  const camera = createCamera(viewport);
  const safeLeft = viewport.width * 0.4;
  const safeRight = viewport.width * 0.6;
  const safeTop = viewport.height * 0.4;
  const safeBottom = viewport.height * 0.6;

  for (let index = 0; index < 32; index++) {
    const angle = (index / 32) * Math.PI * 2;
    const result = requireVisible(project(
      new THREE.Vector3(Math.cos(angle) * 100, -Math.sin(angle) * 100, -1),
      viewport,
      camera,
    ));
    assertVisibleIntegrity(result, viewport);

    const insideSafeX = result.position.x >= safeLeft && result.position.x <= safeRight;
    const insideSafeY = result.position.y >= safeTop && result.position.y <= safeBottom;
    assert.equal(
      insideSafeX && insideSafeY,
      false,
      `indicator entered the center safe zone at angle ${angle}`,
    );
  }
});

test('fails closed for non-finite point or matrix inputs', () => {
  const camera = createCamera(VIEWPORT);
  const invalidProjection = camera.projectionMatrix.clone();
  invalidProjection.elements[0] = Number.NaN;

  assert.deepEqual(projectBallIndicator({
    worldPosition: { x: Number.NaN, y: 0, z: -1 },
    viewMatrix: camera.matrixWorldInverse,
    projectionMatrix: camera.projectionMatrix,
    viewport: VIEWPORT,
  }), { visible: false, reason: 'invalid-input' });

  assert.deepEqual(projectBallIndicator({
    worldPosition: { x: 10, y: 0, z: -1 },
    viewMatrix: camera.matrixWorldInverse,
    projectionMatrix: invalidProjection,
    viewport: VIEWPORT,
  }), { visible: false, reason: 'invalid-input' });
});
