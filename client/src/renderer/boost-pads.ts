import * as THREE from 'three';
import {
  VISUAL,
  type BoostPadCooldownSnapshot,
  type BoostPadDescriptor,
  type BoostPadKind,
} from '@rocket-arena/shared';

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
 * Availability is animated from authoritative state rather than guessed. A client
 * cannot know that another player took a pad, so the room reports which pads are
 * spent and how long each has left, and this only draws what it is told.
 */
export interface BoostPadVisuals {
  readonly object: THREE.Group;
  readonly padCount: number;
  /**
   * Advance the pads.
   *
   * `cooldowns` is the authoritative list of spent pads from the accepted
   * snapshot, keyed by index into the same table these visuals were built from.
   * An omitted list means nothing is spent, so a caller with no snapshot yet
   * draws every pad available rather than guessing.
   */
  update(
    elapsedSeconds: number,
    cooldowns?: readonly BoostPadCooldownSnapshot[],
  ): void;
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

/**
 * How a recharging pad reads: a clock wipe.
 *
 * The spent plate goes dark and a bright wedge sweeps around it, filling from
 * twelve o'clock until the pad is back. It reads as a timer rather than as damage,
 * which is the point: a player wants to know how long, not merely that it is gone.
 *
 * The plate keeps its full size throughout. An earlier version scaled it down and
 * grew it back, which lost the pad's footprint exactly when a player was trying to
 * judge whether it was worth waiting for.
 */
const RECHARGE = Object.freeze({
  /** Fraction of the cooldown after which the orb starts returning. */
  ORB_RETURN_AT: 0.82,
  SWEEP_OPACITY: 0.7,
});

const SWEEP_VERTEX_SHADER = `
varying vec2 vSweepUv;
void main() {
  vSweepUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Angular wipe over a unit-centred disc.
 *
 * `CircleGeometry` puts its centre at uv `0.5, 0.5`, so the fragment's angle about
 * that point is the wipe coordinate. `atan(x, y)` rather than `atan(y, x)` starts
 * the sweep at twelve o'clock and runs it clockwise, which is the direction a clock
 * face trains people to read.
 */
const SWEEP_FRAGMENT_SHADER = `
uniform vec3 uColor;
uniform float uProgress;
uniform float uOpacity;
varying vec2 vSweepUv;

void main() {
  vec2 centred = vSweepUv - 0.5;
  if (dot(centred, centred) > 0.25) discard;

  float turn = atan(centred.x, centred.y) / 6.2831853;
  if (turn < 0.0) turn += 1.0;
  if (turn > uProgress) discard;

  // The leading edge is brighter, so the wedge reads as sweeping rather than as a
  // static slice that happens to be a different size each frame.
  float lead = smoothstep(uProgress - 0.06, uProgress, turn);
  gl_FragColor = vec4(uColor * (1.0 + lead * 0.9), uOpacity);
}
`;

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
  readonly spentPlateMaterial: THREE.MeshBasicMaterial;
  readonly spentRimMaterial: THREE.MeshBasicMaterial;
  readonly coreGeometry: THREE.SphereGeometry | null;
  readonly haloGeometry: THREE.SphereGeometry | null;
  readonly coreMaterial: THREE.MeshBasicMaterial | null;
  readonly haloMaterial: THREE.MeshBasicMaterial | null;
}

interface Pad {
  /** Index into the shared table, which is how the room names it too. */
  readonly index: number;
  readonly respawnSeconds: number;
  readonly plate: THREE.Mesh;
  readonly rim: THREE.Mesh;
  readonly sweep: THREE.Mesh;
  /**
   * Owned per pad, unlike every other material here, because each pad is at its
   * own point in its own cooldown and a uniform is per material. One trivial
   * unlit material per pad is a smaller price than sharing a wipe that would
   * show every pad the same progress.
   */
  readonly sweepMaterial: THREE.ShaderMaterial;
  readonly orb: THREE.Object3D | null;
  readonly resources: KindResources;
  readonly phase: number;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
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
  const pads: Pad[] = [];

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
      // A spent pad goes cool and faint rather than warm and bright. Swapping
      // between two shared materials keeps every pad of a class sharing one pair,
      // which cloning a material per pad to fade it would have thrown away.
      spentPlateMaterial: new THREE.MeshBasicMaterial({
        color: VISUAL.PALETTE.GLASS,
        transparent: true,
        opacity: style.plateOpacity * 0.5,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
      }),
      spentRimMaterial: new THREE.MeshBasicMaterial({
        color: VISUAL.PALETTE.GLASS,
        transparent: true,
        opacity: style.rimOpacity * 0.45,
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

    const sweepMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(VISUAL.PALETTE.WHITE_LIGHT) },
        uProgress: { value: 0 },
        uOpacity: { value: RECHARGE.SWEEP_OPACITY },
      },
      vertexShader: SWEEP_VERTEX_SHADER,
      fragmentShader: SWEEP_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    // Reuses the plate's geometry, so the wipe is exactly the size of the disc it
    // is filling and cannot drift out of register with it.
    const sweep = new THREE.Mesh(resources.plateGeometry, sweepMaterial);
    sweep.name = 'boost-pad-sweep';
    sweep.rotation.x = -Math.PI / 2;
    sweep.renderOrder = 4;
    sweep.visible = false;

    pad.add(plate, rim, sweep);

    let orb: THREE.Object3D | null = null;
    if (
      resources.coreGeometry !== null
      && resources.haloGeometry !== null
      && resources.coreMaterial !== null
      && resources.haloMaterial !== null
    ) {
      const group = new THREE.Group();
      group.name = 'boost-pad-orb';
      group.position.y = ORB.HOVER_HEIGHT;

      const core = new THREE.Mesh(resources.coreGeometry, resources.coreMaterial);
      core.name = 'boost-pad-orb-core';
      const halo = new THREE.Mesh(resources.haloGeometry, resources.haloMaterial);
      halo.name = 'boost-pad-orb-halo';
      halo.renderOrder = 4;
      group.add(core, halo);
      pad.add(group);
      orb = group;
    }

    pads.push({
      index,
      respawnSeconds: descriptor.respawnSeconds,
      plate,
      rim,
      sweep,
      sweepMaterial,
      orb,
      resources,
      // A per-pad phase from the index, so the orbs breathe independently while
      // staying deterministic rather than depending on creation timing.
      phase: index * 0.7,
    });
    object.add(pad);
  });

  const remaining = new Map<number, number>();
  let lastElapsedSeconds = 0;
  let disposed = false;

  return {
    object,
    padCount: descriptors.length,
    update: (
      elapsedSeconds: number,
      cooldowns?: readonly BoostPadCooldownSnapshot[],
    ): void => {
      if (disposed) return;
      // A hostile clock holds the previous pose rather than producing a NaN
      // transform, and must not stop the availability update from applying.
      if (Number.isFinite(elapsedSeconds)) lastElapsedSeconds = elapsedSeconds;
      const time = lastElapsedSeconds;

      remaining.clear();
      if (cooldowns !== undefined) {
        for (const entry of cooldowns) {
          if (
            Number.isSafeInteger(entry.index)
            && Number.isFinite(entry.secondsRemaining)
            && entry.secondsRemaining > 0
          ) {
            remaining.set(entry.index, entry.secondsRemaining);
          }
        }
      }

      for (const pad of pads) {
        const secondsLeft = remaining.get(pad.index);

        if (secondsLeft === undefined) {
          pad.plate.material = pad.resources.plateMaterial;
          pad.rim.material = pad.resources.rimMaterial;
          pad.sweep.visible = false;
          if (pad.orb !== null) {
            pad.orb.visible = true;
            pad.orb.scale.set(1, 1, 1);
            pad.orb.position.y = ORB.HOVER_HEIGHT
              + Math.sin(time * ORB.BOB_RATE + pad.phase) * ORB.BOB_AMPLITUDE;
            pad.orb.rotation.y = time * ORB.SPIN_RATE + pad.phase;
          }
          continue;
        }

        // Progress is read from the authoritative remaining time, so a client
        // that joins part-way through a cooldown is immediately correct instead
        // of restarting the sweep.
        const progress = pad.respawnSeconds > 0
          ? clamp01(1 - secondsLeft / pad.respawnSeconds)
          : 1;

        // The plate goes dark at full size and the wipe carries the progress.
        pad.plate.material = pad.resources.spentPlateMaterial;
        pad.rim.material = pad.resources.spentRimMaterial;
        pad.sweep.visible = true;
        pad.sweepMaterial.uniforms.uProgress!.value = progress;

        if (pad.orb !== null) {
          // The orb is the payout, so it stays away until the pad is nearly back.
          const returning = clamp01(
            (progress - RECHARGE.ORB_RETURN_AT) / (1 - RECHARGE.ORB_RETURN_AT),
          );
          pad.orb.visible = returning > 0;
          pad.orb.scale.set(returning, returning, returning);
          pad.orb.position.y = ORB.HOVER_HEIGHT;
        }
      }
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      object.removeFromParent();
      object.clear();
      // Per-pad materials are owned here, so they are released here. The shared
      // per-class resources below are released once each.
      for (const pad of pads) pad.sweepMaterial.dispose();
      pads.length = 0;
      remaining.clear();
      for (const resources of resourcesByKind.values()) {
        resources.plateGeometry.dispose();
        resources.rimGeometry.dispose();
        resources.plateMaterial.dispose();
        resources.rimMaterial.dispose();
        resources.spentPlateMaterial.dispose();
        resources.spentRimMaterial.dispose();
        resources.coreGeometry?.dispose();
        resources.haloGeometry?.dispose();
        resources.coreMaterial?.dispose();
        resources.haloMaterial?.dispose();
      }
      resourcesByKind.clear();
    },
  };
}
