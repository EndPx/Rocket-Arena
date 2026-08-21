import * as THREE from 'three';
import { VISUAL, type BoostPadDescriptor } from '@rocket-arena/shared';

/**
 * Boost pad visuals.
 *
 * Presentation only, and descriptor-driven: it draws exactly the pads it is
 * handed, at the transforms they carry, and an empty list is a complete valid
 * no-op rather than a reason to invent decoration. It owns no pickup, inventory,
 * respawn, collision, or sensor behaviour; those live in the authoritative room,
 * and both sides read the same shared pad table so the drawn pads cannot drift
 * away from the ones that pay out.
 *
 * The pads are drawn as available. Pad availability is authoritative state that
 * the snapshot envelope does not carry yet, so rather than animate a guess these
 * mark where boost is, which is the half a player cannot work out for themselves.
 */
export interface BoostPadVisuals {
  readonly object: THREE.Group;
  readonly padCount: number;
  dispose(): void;
}

export function createBoostPadVisuals(
  descriptors: readonly BoostPadDescriptor[],
): BoostPadVisuals {
  const object = new THREE.Group();
  object.name = 'boost-pads';

  if (descriptors.length === 0) {
    return {
      object,
      padCount: 0,
      dispose: (): void => {
        object.removeFromParent();
      },
    };
  }

  // One geometry and one material set for every pad, however many there are.
  const [halfX, , halfZ] = descriptors[0]!.halfExtents;
  const radius = Math.min(halfX, halfZ);
  const discGeometry = new THREE.CircleGeometry(radius * 0.82, 32);
  const rimGeometry = new THREE.RingGeometry(radius * 0.82, radius, 32, 1);

  const discMaterial = new THREE.MeshBasicMaterial({
    color: VISUAL.PALETTE.WARM_LIGHT,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });
  const rimMaterial = new THREE.MeshBasicMaterial({
    color: VISUAL.PALETTE.WARM_LIGHT,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });

  for (const descriptor of descriptors) {
    const pad = new THREE.Group();
    pad.name = `boost-pad:${descriptor.id}`;
    // Lift clear of the turf and its markings, the same allowance the ball's
    // floor circle uses, so the pad never z-fights the floor it sits on.
    pad.position.set(
      descriptor.position[0],
      descriptor.position[1] + VISUAL.BALL_MOTION.MARKER_FLOOR_CLEARANCE,
      descriptor.position[2],
    );

    const disc = new THREE.Mesh(discGeometry, discMaterial);
    disc.name = 'boost-pad-disc';
    disc.rotation.x = -Math.PI / 2;
    disc.renderOrder = 2;
    const rim = new THREE.Mesh(rimGeometry, rimMaterial);
    rim.name = 'boost-pad-rim';
    rim.rotation.x = -Math.PI / 2;
    rim.renderOrder = 3;

    pad.add(disc, rim);
    object.add(pad);
  }

  let disposed = false;
  return {
    object,
    padCount: descriptors.length,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      object.removeFromParent();
      object.clear();
      discGeometry.dispose();
      rimGeometry.dispose();
      discMaterial.dispose();
      rimMaterial.dispose();
    },
  };
}
