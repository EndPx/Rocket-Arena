import { Vector4, type Matrix4 } from 'three';

const CLIP_EPSILON = 1e-9;
const SCREEN_CENTER_SAFE_ZONE_START = 0.4;
const SCREEN_CENTER_SAFE_ZONE_END = 0.6;

export interface BallIndicatorWorldPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** CSS-pixel viewport dimensions and the indicator-center inset from each edge. */
export interface BallIndicatorViewport {
  readonly width: number;
  readonly height: number;
  readonly insetX: number;
  readonly insetY: number;
}

export interface BallIndicatorProjectionInput {
  readonly worldPosition: BallIndicatorWorldPosition;
  readonly viewMatrix: Matrix4;
  readonly projectionMatrix: Matrix4;
  readonly viewport: BallIndicatorViewport;
}

export interface HiddenBallIndicatorProjection {
  readonly visible: false;
  readonly reason: 'in-viewport' | 'invalid-input' | 'invalid-viewport';
}

export interface VisibleBallIndicatorProjection {
  readonly visible: true;
  /** Indicator-center position in CSS pixels from the viewport's top-left corner. */
  readonly position: Readonly<{ x: number; y: number }>;
  /** Unit screen-space direction where +X is right and +Y is down. */
  readonly direction: Readonly<{ x: number; y: number }>;
  /** Clockwise CSS-space angle in radians, with zero pointing right. */
  readonly angleRadians: number;
  readonly behindCamera: boolean;
}

export type BallIndicatorProjection =
  | HiddenBallIndicatorProjection
  | VisibleBallIndicatorProjection;

interface ResolvedViewport extends BallIndicatorViewport {
  readonly centerX: number;
  readonly centerY: number;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

interface ScreenDirection {
  readonly x: number;
  readonly y: number;
}

const DEFAULT_SCREEN_DIRECTION: ScreenDirection = Object.freeze({ x: 1, y: 0 });

function hidden(reason: HiddenBallIndicatorProjection['reason']): HiddenBallIndicatorProjection {
  return { visible: false, reason };
}

function hasFiniteMatrix(matrix: Matrix4): boolean {
  const elements = matrix?.elements;
  if (!elements || elements.length !== 16) return false;

  for (let index = 0; index < elements.length; index++) {
    if (!Number.isFinite(elements[index])) return false;
  }
  return true;
}

function hasFiniteWorldPosition(position: BallIndicatorWorldPosition): boolean {
  return Number.isFinite(position?.x)
    && Number.isFinite(position.y)
    && Number.isFinite(position.z);
}

function resolveViewport(viewport: BallIndicatorViewport): ResolvedViewport | null {
  const { width, height, insetX, insetY } = viewport;
  if (![width, height, insetX, insetY].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0 || insetX < 0 || insetY < 0) return null;

  const centerX = width / 2;
  const centerY = height / 2;
  const left = insetX;
  const right = width - insetX;
  const top = insetY;
  const bottom = height - insetY;
  const radiusX = centerX - insetX;
  const radiusY = centerY - insetY;

  if (![centerX, centerY, left, right, top, bottom, radiusX, radiusY].every(Number.isFinite)) {
    return null;
  }
  if (radiusX <= 0 || radiusY <= 0 || left >= right || top >= bottom) return null;

  // Every edge of the inset rectangle must remain beyond the central 20% safe zone.
  if (
    left >= width * SCREEN_CENTER_SAFE_ZONE_START
    || right <= width * SCREEN_CENTER_SAFE_ZONE_END
    || top >= height * SCREEN_CENTER_SAFE_ZONE_START
    || bottom <= height * SCREEN_CENTER_SAFE_ZONE_END
  ) {
    return null;
  }

  return {
    width,
    height,
    insetX,
    insetY,
    centerX,
    centerY,
    radiusX,
    radiusY,
    left,
    right,
    top,
    bottom,
  };
}

function normalizeScreenDirection(
  horizontal: number,
  vertical: number,
  viewport: ResolvedViewport,
): ScreenDirection | null {
  if (!Number.isFinite(horizontal) || !Number.isFinite(vertical)) return null;

  const largestComponent = Math.max(Math.abs(horizontal), Math.abs(vertical));
  if (largestComponent === 0) return null;

  // Scale only after bounding the components, preventing overflow for huge finite inputs.
  const scaledX = (horizontal / largestComponent) * viewport.centerX;
  const scaledY = (vertical / largestComponent) * viewport.centerY;
  const length = Math.hypot(scaledX, scaledY);
  if (!Number.isFinite(length) || length === 0) return null;

  return { x: scaledX / length, y: scaledY / length };
}

function placeOnInsetEdge(
  viewport: ResolvedViewport,
  direction: ScreenDirection,
  behindCamera: boolean,
): VisibleBallIndicatorProjection {
  const horizontalScale = direction.x === 0
    ? Number.POSITIVE_INFINITY
    : viewport.radiusX / Math.abs(direction.x);
  const verticalScale = direction.y === 0
    ? Number.POSITIVE_INFINITY
    : viewport.radiusY / Math.abs(direction.y);
  const edgeScale = Math.min(horizontalScale, verticalScale);

  // A normalized direction always has a finite edge scale, but retain a deterministic fallback.
  const finiteDirection = Number.isFinite(edgeScale) ? direction : DEFAULT_SCREEN_DIRECTION;
  const finiteScale = Number.isFinite(edgeScale) ? edgeScale : viewport.radiusX;
  const x = Math.min(
    viewport.right,
    Math.max(viewport.left, viewport.centerX + finiteDirection.x * finiteScale),
  );
  const y = Math.min(
    viewport.bottom,
    Math.max(viewport.top, viewport.centerY + finiteDirection.y * finiteScale),
  );

  return {
    visible: true,
    position: { x, y },
    direction: finiteDirection,
    angleRadians: Math.atan2(finiteDirection.y, finiteDirection.x),
    behindCamera,
  };
}

/**
 * Project a world-space ball position to an inset viewport edge without reading the DOM.
 *
 * The function never mutates its point, matrices, or viewport. Three.js cameras look down
 * camera-space -Z. For a behind-camera point, using clip X/Y as if W were positive is the
 * reflected-NDC direction (`clip / abs(w)`), preventing the usual left/right inversion.
 * A point with no resolvable screen direction (including directly behind) deterministically
 * falls back to the right edge.
 */
export function projectBallIndicator(
  input: BallIndicatorProjectionInput,
): BallIndicatorProjection {
  const viewport = resolveViewport(input.viewport);
  if (!viewport) return hidden('invalid-viewport');
  if (
    !hasFiniteWorldPosition(input.worldPosition)
    || !hasFiniteMatrix(input.viewMatrix)
    || !hasFiniteMatrix(input.projectionMatrix)
  ) {
    return hidden('invalid-input');
  }

  const cameraSpace = new Vector4(
    input.worldPosition.x,
    input.worldPosition.y,
    input.worldPosition.z,
    1,
  ).applyMatrix4(input.viewMatrix);

  const cameraSpaceFinite = [
    cameraSpace.x,
    cameraSpace.y,
    cameraSpace.z,
    cameraSpace.w,
  ].every(Number.isFinite);
  if (!cameraSpaceFinite) {
    return placeOnInsetEdge(viewport, DEFAULT_SCREEN_DIRECTION, false);
  }

  const behindCamera = cameraSpace.z >= 0;
  const clipSpace = cameraSpace.clone().applyMatrix4(input.projectionMatrix);
  const clipSpaceFinite = [clipSpace.x, clipSpace.y, clipSpace.z, clipSpace.w]
    .every(Number.isFinite);

  if (clipSpaceFinite && !behindCamera && Math.abs(clipSpace.w) > CLIP_EPSILON) {
    const ndcX = clipSpace.x / clipSpace.w;
    const ndcY = clipSpace.y / clipSpace.w;
    const ndcZ = clipSpace.z / clipSpace.w;
    const insideClipVolume = [ndcX, ndcY, ndcZ].every(Number.isFinite)
      && Math.abs(ndcX) <= 1 + CLIP_EPSILON
      && Math.abs(ndcY) <= 1 + CLIP_EPSILON
      && Math.abs(ndcZ) <= 1 + CLIP_EPSILON;

    if (insideClipVolume) return hidden('in-viewport');
  }

  const projectedDirection = normalizeScreenDirection(
    clipSpace.x,
    -clipSpace.y,
    viewport,
  );
  const cameraDirection = normalizeScreenDirection(
    cameraSpace.x,
    -cameraSpace.y,
    viewport,
  );
  const direction = projectedDirection ?? cameraDirection ?? DEFAULT_SCREEN_DIRECTION;

  return placeOnInsetEdge(viewport, direction, behindCamera);
}
