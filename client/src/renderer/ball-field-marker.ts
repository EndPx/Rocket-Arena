import * as THREE from 'three';
import {
  ARENA_CORNER_CUT_LENGTH_METERS,
  ARENA_FLOOR_WALL_RAMP_RUN_METERS,
  ARENA_HALF_LENGTH_METERS,
  ARENA_HALF_WIDTH_METERS,
  BALL,
  VISUAL,
} from '@rocket-arena/shared';

/**
 * The floor circle that reports where the ball is.
 *
 * This is a field overlay, not part of the ball. It used to be a child of the
 * ball rig, which meant it inherited the ball's transform, its visibility, its
 * frustum culling, and its bounding-box budget: the ring geometry had to stay
 * inside the ball radius so a freshly built rig kept its silhouette allowance,
 * so the circle could only be widened by a runtime scale hack and still read as
 * a thin sliver at range. Owned by the scene instead, it is authored at the size
 * it should actually be and its only input is the ball's position.
 *
 * The projection is straight down onto the floor plane. Nothing about the ball's
 * rotation, spin, or altitude can move it off that spot, so the circle appears
 * the moment there is a ball, including while the ball is high in the air.
 */
export interface BallFieldMarker {
  readonly object: THREE.Group;
  /** Latest altitude blend, 0 resting and 1 at the fade ceiling. For tests. */
  readonly altitudeBlend: number;
  /**
   * Project one ball position onto the floor. Passing null, or a non-finite or
   * below-floor position, hides the circle.
   */
  update(ballPosition: THREE.Vector3 | null): void;
  dispose(): void;
}

/** The floor plane the circle is painted on; the arena floor is the origin. */
const ARENA_FLOOR_Y = 0;

/**
 * The flat part of the floor, derived from the authoritative arena numbers.
 *
 * The arena outline is inset by the floor-wall ramp run, because inside that band
 * the surface has already curved up towards the wall. A circle pinned to the
 * floor plane there is swallowed by the ramp mesh: measured with the ball resting
 * on the slope at `z = 49.2`, past the `48.64` flat edge, the whole circle
 * disappeared rather than half of it.
 *
 * `DIAGONAL_LIMIT` is the same inset applied to the four corner chamfers. Each
 * chamfer runs between `(halfWidth, halfLength - cut)` and
 * `(halfWidth - cut, halfLength)`, so it lies on `|x| + |z| = halfWidth +
 * halfLength - cut`, and offsetting a 45 degree line inward by the run moves that
 * sum by `run * sqrt(2)`.
 */
const FLAT_FLOOR_HALF_WIDTH = ARENA_HALF_WIDTH_METERS - ARENA_FLOOR_WALL_RAMP_RUN_METERS;
const FLAT_FLOOR_HALF_LENGTH = ARENA_HALF_LENGTH_METERS - ARENA_FLOOR_WALL_RAMP_RUN_METERS;
const FLAT_FLOOR_DIAGONAL_LIMIT = ARENA_HALF_WIDTH_METERS
  + ARENA_HALF_LENGTH_METERS
  - ARENA_CORNER_CUT_LENGTH_METERS
  - ARENA_FLOOR_WALL_RAMP_RUN_METERS * Math.SQRT2;

/**
 * Pull one floor point back onto the flat floor.
 *
 * This is a no-op wherever the ball spends nearly all of its time, and it only
 * bites when the ball is over the perimeter ramp, where it slides the circle to
 * the nearest flat ground instead of letting it vanish. The correction is at most
 * the ramp run, and in the measured wall case it was 0.56 m across a 102 m field.
 * Keeping the cue alive is worth more than that much positional purity, and the
 * alternative of following the ramp surface would tilt and intersect a flat ring
 * against a curved one.
 */
function clampToFlatFloor(point: THREE.Vector2): THREE.Vector2 {
  point.set(
    THREE.MathUtils.clamp(point.x, -FLAT_FLOOR_HALF_WIDTH, FLAT_FLOOR_HALF_WIDTH),
    THREE.MathUtils.clamp(point.y, -FLAT_FLOOR_HALF_LENGTH, FLAT_FLOOR_HALF_LENGTH),
  );

  const overshoot = Math.abs(point.x) + Math.abs(point.y) - FLAT_FLOOR_DIAGONAL_LIMIT;
  if (overshoot <= 0) return point;

  // Split the correction between both axes so the circle retreats straight along
  // the chamfer normal rather than sliding sideways along it.
  const share = overshoot / 2;
  const x = Math.max(0, Math.abs(point.x) - share);
  const z = Math.max(0, Math.abs(point.y) - share);
  return point.set(Math.sign(point.x) * x, Math.sign(point.y) * z);
}

const scratchFloorPoint = new THREE.Vector2();

export function createBallFieldMarker(): BallFieldMarker {
  const tuning = VISUAL.BALL_MOTION;
  const radius = BALL.RADIUS;

  const frameGeometry = new THREE.RingGeometry(
    radius * tuning.MARKER_INNER_RADIUS_RATIO,
    radius * tuning.MARKER_MID_RADIUS_RATIO,
    48,
    1,
  );
  const bandGeometry = new THREE.RingGeometry(
    radius * tuning.MARKER_MID_RADIUS_RATIO,
    radius * tuning.MARKER_OUTER_RADIUS_RATIO,
    48,
    1,
  );
  const coreGeometry = new THREE.CircleGeometry(radius * tuning.MARKER_CORE_RADIUS_RATIO, 24);

  // Fog is off because this is a readability aid: the ball is most often chased
  // from the far end of a 102 m field, exactly where fog would wash it out.
  const shared = {
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  } as const;
  // Two tones, radially adjacent so neither tints the other. A light-only circle
  // vanished against the pale concrete surround while reading fine on turf.
  const frameMaterial = new THREE.MeshBasicMaterial({ color: VISUAL.PALETTE.RUBBER, ...shared });
  const bandMaterial = new THREE.MeshBasicMaterial({ color: VISUAL.PALETTE.WHITE_LIGHT, ...shared });

  const object = new THREE.Group();
  object.name = 'ball-field-marker';
  object.visible = false;

  const frame = new THREE.Mesh(frameGeometry, frameMaterial);
  frame.name = 'ball-field-marker-frame';
  frame.rotation.x = -Math.PI / 2;
  frame.renderOrder = 4;
  const band = new THREE.Mesh(bandGeometry, bandMaterial);
  band.name = 'ball-field-marker-band';
  band.rotation.x = -Math.PI / 2;
  band.renderOrder = 5;
  const core = new THREE.Mesh(coreGeometry, bandMaterial);
  core.name = 'ball-field-marker-core';
  core.rotation.x = -Math.PI / 2;
  core.renderOrder = 5;
  object.add(frame, band, core);

  let altitudeBlend = 0;
  let disposed = false;

  const hide = (): void => {
    object.visible = false;
    altitudeBlend = 0;
  };

  return {
    object,
    get altitudeBlend(): number {
      return altitudeBlend;
    },

    update(ballPosition: THREE.Vector3 | null): void {
      if (disposed || ballPosition === null) {
        hide();
        return;
      }
      const { x, y, z } = ballPosition;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        hide();
        return;
      }

      const height = y - ARENA_FLOOR_Y;
      // Below the floor there is nothing left to project onto.
      if (height < -radius) {
        hide();
        return;
      }

      const altitude = Math.max(0, height - radius);
      altitudeBlend = THREE.MathUtils.clamp(
        altitude / Math.max(tuning.MARKER_FULL_FADE_HEIGHT, 1e-3),
        0,
        1,
      );

      const floorPoint = clampToFlatFloor(scratchFloorPoint.set(x, z));
      object.position.set(
        floorPoint.x,
        ARENA_FLOOR_Y + tuning.MARKER_FLOOR_CLEARANCE,
        floorPoint.y,
      );
      object.scale.setScalar(THREE.MathUtils.lerp(
        tuning.MARKER_GROUNDED_SCALE,
        tuning.MARKER_LIFTED_SCALE,
        altitudeBlend,
      ));

      const opacity = THREE.MathUtils.lerp(
        tuning.MARKER_GROUNDED_OPACITY,
        tuning.MARKER_LIFTED_OPACITY,
        altitudeBlend,
      );
      frameMaterial.opacity = opacity;
      bandMaterial.opacity = opacity;
      object.visible = opacity > 0.01;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      object.removeFromParent();
      object.clear();
      for (const geometry of [frameGeometry, bandGeometry, coreGeometry]) geometry.dispose();
      for (const material of [frameMaterial, bandMaterial]) material.dispose();
      hide();
    },
  };
}
