import * as THREE from 'three';
import { VISUAL, type BoostPadDescriptor, type BoostPadKind } from '@rocket-arena/shared';

/**
 * Boost pad visuals.
 *
 * Presentation only, and descriptor-driven: it draws exactly the pads it is
 * handed, at the transforms and footprints they carry, and an empty list is a
 * complete valid no-op rather than a reason to invent decoration. It owns no
 * pickup, inventory, respawn, collision, or sensor behaviour; those live in the
 * authoritative room, and both sides read the same shared pad table so the drawn
 * pads cannot drift away from the ones that pay out.
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

/** Presentation weight per class, so a full refill does not read as twelve units. */
const KIND_STYLE: Readonly<Record<BoostPadKind, {
  readonly discOpacity: number;
  readonly rimOpacity: number;
  readonly innerRatio: number;
}>> = Object.freeze({
  large: { discOpacity: 0.34, rimOpacity: 0.72, innerRatio: 0.82 },
  small: { discOpacity: 0.24, rimOpacity: 0.54, innerRatio: 0.74 },
});

interface KindResources {
  readonly discGeometry: THREE.CircleGeometry;
  readonly rimGeometry: THREE.RingGeometry;
  readonly discMaterial: THREE.MeshBasicMaterial;
  readonly rimMaterial: THREE.MeshBasicMaterial;
}

export function createBoostPadVisuals(
  descriptors: readonly BoostPadDescriptor[],
): BoostPadVisuals {
  const object = new THREE.Group();
  object.name = 'boost-pads';

  // One geometry and material set per class present, not per pad, and keyed on the
  // class rather than on the first descriptor: the two classes have different
  // footprints, and sizing every pad from `descriptors[0]` would have drawn small
  // pads at large-pad size and lied about where the catch area is.
  const resourcesByKind = new Map<BoostPadKind, KindResources>();

  const resourcesFor = (descriptor: BoostPadDescriptor): KindResources => {
    const existing = resourcesByKind.get(descriptor.kind);
    if (existing !== undefined) return existing;

    const style = KIND_STYLE[descriptor.kind];
    const [halfX, , halfZ] = descriptor.halfExtents;
    const radius = Math.min(halfX, halfZ);
    const created: KindResources = {
      discGeometry: new THREE.CircleGeometry(radius * style.innerRatio, 32),
      rimGeometry: new THREE.RingGeometry(radius * style.innerRatio, radius, 32, 1),
      discMaterial: new THREE.MeshBasicMaterial({
        color: VISUAL.PALETTE.WARM_LIGHT,
        transparent: true,
        opacity: style.discOpacity,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
      }),
      rimMaterial: new THREE.MeshBasicMaterial({
        color: VISUAL.PALETTE.WARM_LIGHT,
        transparent: true,
        opacity: style.rimOpacity,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
      }),
    };
    resourcesByKind.set(descriptor.kind, created);
    return created;
  };

  for (const descriptor of descriptors) {
    const resources = resourcesFor(descriptor);
    const pad = new THREE.Group();
    pad.name = `boost-pad:${descriptor.id}`;
    // Lift clear of the turf and its markings, the same allowance the ball's
    // floor circle uses, so the pad never z-fights the floor it sits on.
    pad.position.set(
      descriptor.position[0],
      descriptor.position[1] + VISUAL.BALL_MOTION.MARKER_FLOOR_CLEARANCE,
      descriptor.position[2],
    );

    const disc = new THREE.Mesh(resources.discGeometry, resources.discMaterial);
    disc.name = 'boost-pad-disc';
    disc.rotation.x = -Math.PI / 2;
    disc.renderOrder = 2;
    const rim = new THREE.Mesh(resources.rimGeometry, resources.rimMaterial);
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
      for (const resources of resourcesByKind.values()) {
        resources.discGeometry.dispose();
        resources.rimGeometry.dispose();
        resources.discMaterial.dispose();
        resources.rimMaterial.dispose();
      }
      resourcesByKind.clear();
    },
  };
}
