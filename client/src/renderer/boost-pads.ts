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
 * The two classes are drawn as different objects on purpose, because they are
 * worth very different things. A small pad is a plate set into the turf and
 * nothing more. A large pad adds a floating orb above that plate, which is what
 * makes a full refill visible from across the arena and worth driving to.
 *
 * The pads are drawn as available. Pad availability is authoritative state that
 * the snapshot envelope does not carry yet, so rather than animate a guess these
 * mark where boost is, which is the half a player cannot work out for themselves.
 */
export interface BoostPadVisuals {
  readonly object: THREE.Group;
  readonly padCount: number;
  /** Advance the floating orbs. Safe to call with any finite elapsed time. */
  update(elapsedSeconds: number): void;
  dispose(): void;
}

/** Orb hover geometry, expressed against the pad footprint that carries it. */
const ORB = Object.freeze({
  RADIUS_RATIO: 0.6,
  HALO_RATIO: 1.55,
  HOVER_HEIGHT: 1.7,
  BOB_AMPLITUDE: 0.16,
  BOB_RATE: 1.6,
  SPIN_RATE: 0.5,
});

/** Presentation weight per class, so a full refill does not read as twelve units. */
const KIND_STYLE: Readonly<Record<BoostPadKind, {
  readonly plateOpacity: number;
  readonly rimOpacity: number;
  readonly innerRatio: number;
  readonly hasOrb: boolean;
}>> = Object.freeze({
  large: { plateOpacity: 0.42, rimOpacity: 0.85, innerRatio: 0.72, hasOrb: true },
  small: { plateOpacity: 0.3, rimOpacity: 0.6, innerRatio: 0.66, hasOrb: false },
});

interface KindResources {
  readonly plateGeometry: THREE.CircleGeometry;
  readonly rimGeometry: THREE.RingGeometry;
  readonly plateMaterial: THREE.MeshBasicMaterial;
  readonly rimMaterial: THREE.MeshBasicMaterial;
  readonly coreGeometry: THREE.SphereGeometry | null;
  readonly haloGeometry: THREE.SphereGeometry | null;
  readonly coreMaterial: THREE.MeshBasicMaterial | null;
  readonly haloMaterial: THREE.MeshBasicMaterial | null;
}

interface Orb {
  readonly object: THREE.Object3D;
  readonly baseY: number;
  readonly phase: number;
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
  const orbs: Orb[] = [];

  const resourcesFor = (descriptor: BoostPadDescriptor): KindResources => {
    const existing = resourcesByKind.get(descriptor.kind);
    if (existing !== undefined) return existing;

    const style = KIND_STYLE[descriptor.kind];
    const [halfX, , halfZ] = descriptor.halfExtents;
    const radius = Math.min(halfX, halfZ);
    const orbRadius = radius * ORB.RADIUS_RATIO;
    const created: KindResources = {
      plateGeometry: new THREE.CircleGeometry(radius * style.innerRatio, 32),
      rimGeometry: new THREE.RingGeometry(radius * style.innerRatio, radius, 32, 1),
      plateMaterial: new THREE.MeshBasicMaterial({
        color: VISUAL.PALETTE.WARM_LIGHT,
        transparent: true,
        opacity: style.plateOpacity,
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
      // Only the class that hovers an orb pays for orb resources.
      coreGeometry: style.hasOrb ? new THREE.SphereGeometry(orbRadius, 20, 14) : null,
      haloGeometry: style.hasOrb
        ? new THREE.SphereGeometry(orbRadius * ORB.HALO_RATIO, 20, 14)
        : null,
      coreMaterial: style.hasOrb
        ? new THREE.MeshBasicMaterial({
          color: VISUAL.PALETTE.WARM_LIGHT,
          transparent: true,
          opacity: 0.95,
          fog: false,
        })
        : null,
      // Additive and back-faced, so the halo reads as light around the core
      // rather than as a second solid shell in front of it.
      haloMaterial: style.hasOrb
        ? new THREE.MeshBasicMaterial({
          color: VISUAL.PALETTE.ORANGE_LIGHT,
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.BackSide,
          fog: false,
        })
        : null,
    };
    resourcesByKind.set(descriptor.kind, created);
    return created;
  };

  descriptors.forEach((descriptor, index) => {
    const resources = resourcesFor(descriptor);
    const pad = new THREE.Group();
    pad.name = `boost-pad:${descriptor.id}`;
    // Lift clear of the turf and its markings, the same allowance the ball's
    // floor circle uses, so the plate never z-fights the floor it sits on.
    pad.position.set(
      descriptor.position[0],
      descriptor.position[1] + VISUAL.BALL_MOTION.MARKER_FLOOR_CLEARANCE,
      descriptor.position[2],
    );

    const plate = new THREE.Mesh(resources.plateGeometry, resources.plateMaterial);
    plate.name = 'boost-pad-plate';
    plate.rotation.x = -Math.PI / 2;
    plate.renderOrder = 2;
    const rim = new THREE.Mesh(resources.rimGeometry, resources.rimMaterial);
    rim.name = 'boost-pad-rim';
    rim.rotation.x = -Math.PI / 2;
    rim.renderOrder = 3;
    pad.add(plate, rim);

    if (
      resources.coreGeometry !== null
      && resources.haloGeometry !== null
      && resources.coreMaterial !== null
      && resources.haloMaterial !== null
    ) {
      const orb = new THREE.Group();
      orb.name = 'boost-pad-orb';
      orb.position.y = ORB.HOVER_HEIGHT;

      const core = new THREE.Mesh(resources.coreGeometry, resources.coreMaterial);
      core.name = 'boost-pad-orb-core';
      const halo = new THREE.Mesh(resources.haloGeometry, resources.haloMaterial);
      halo.name = 'boost-pad-orb-halo';
      halo.renderOrder = 4;
      orb.add(core, halo);
      pad.add(orb);

      // A per-pad phase from the index, so the orbs breathe independently while
      // staying deterministic rather than depending on creation timing.
      orbs.push({ object: orb, baseY: ORB.HOVER_HEIGHT, phase: index * 0.7 });
    }

    object.add(pad);
  });

  let disposed = false;
  return {
    object,
    padCount: descriptors.length,
    update: (elapsedSeconds: number): void => {
      if (disposed || !Number.isFinite(elapsedSeconds)) return;
      for (const orb of orbs) {
        orb.object.position.y = orb.baseY
          + Math.sin(elapsedSeconds * ORB.BOB_RATE + orb.phase) * ORB.BOB_AMPLITUDE;
        orb.object.rotation.y = elapsedSeconds * ORB.SPIN_RATE + orb.phase;
      }
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      object.removeFromParent();
      object.clear();
      orbs.length = 0;
      for (const resources of resourcesByKind.values()) {
        resources.plateGeometry.dispose();
        resources.rimGeometry.dispose();
        resources.plateMaterial.dispose();
        resources.rimMaterial.dispose();
        resources.coreGeometry?.dispose();
        resources.haloGeometry?.dispose();
        resources.coreMaterial?.dispose();
        resources.haloMaterial?.dispose();
      }
      resourcesByKind.clear();
    },
  };
}
