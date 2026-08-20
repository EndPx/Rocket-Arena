import * as THREE from 'three';
import { BALL, VISUAL } from '@rocket-arena/shared';

const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;
const UP = new THREE.Vector3(0, 1, 0);

/** Kept inside the silhouette allowance so the ball still reads as a sphere. */
const GLOW_RADIUS_RATIO = 1.028;
const TRAIL_LENGTH_RATIO = 2.6;
const TRAIL_REST_SCALE = 1e-4;

function createPanelShellGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(
    BALL.RADIUS * VISUAL.BALL.SHELL_SCALE,
    VISUAL.BALL.SHELL_DETAIL,
  );
  const position = geometry.getAttribute('position');
  const colors: number[] = [];
  const palette = [
    new THREE.Color(VISUAL.PALETTE.BALL_SHELL),
    new THREE.Color(0xaab3ba),
    new THREE.Color(0x88949d),
    new THREE.Color(VISUAL.PALETTE.BALL_PANEL_DARK),
  ];
  const centroid = new THREE.Vector3();

  for (let vertex = 0; vertex < position.count; vertex += 3) {
    centroid.set(0, 0, 0);
    for (let offset = 0; offset < 3; offset++) {
      centroid.x += position.getX(vertex + offset);
      centroid.y += position.getY(vertex + offset);
      centroid.z += position.getZ(vertex + offset);
    }
    centroid.multiplyScalar(1 / 3).normalize();
    const signature = Math.abs(
      Math.round(centroid.x * 31)
      + Math.round(centroid.y * 47)
      + Math.round(centroid.z * 59),
    );
    const color = palette[signature % Math.min(palette.length, VISUAL.BALL.PANEL_COLOR_VARIANTS)];
    for (let offset = 0; offset < 3; offset++) {
      colors.push(color.r, color.g, color.b);
    }
  }

  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function getNodeDirections(): THREE.Vector3[] {
  const raw = [
    [-1, GOLDEN_RATIO, 0], [1, GOLDEN_RATIO, 0], [-1, -GOLDEN_RATIO, 0], [1, -GOLDEN_RATIO, 0],
    [0, -1, GOLDEN_RATIO], [0, 1, GOLDEN_RATIO], [0, -1, -GOLDEN_RATIO], [0, 1, -GOLDEN_RATIO],
    [GOLDEN_RATIO, 0, -1], [GOLDEN_RATIO, 0, 1], [-GOLDEN_RATIO, 0, -1], [-GOLDEN_RATIO, 0, 1],
  ];
  return raw
    .slice(0, VISUAL.BALL.NODE_COUNT)
    .map(([x, y, z]) => new THREE.Vector3(x, y, z).normalize());
}

interface BallGeometrySet {
  shell: THREE.BufferGeometry;
  seams: THREE.BufferGeometry;
  core: THREE.IcosahedronGeometry;
  socket: THREE.CylinderGeometry;
  node: THREE.CylinderGeometry;
  glow: THREE.SphereGeometry;
  trail: THREE.ConeGeometry;
}

interface BallSharedMaterials {
  readonly shell: THREE.MeshStandardMaterial;
  readonly seams: THREE.LineBasicMaterial;
  readonly socket: THREE.MeshStandardMaterial;
}

interface BallSharedResources {
  readonly geometry: BallGeometrySet;
  readonly materials: BallSharedMaterials;
  readonly nodeDirections: readonly THREE.Vector3[];
}

/**
 * Immutable ball geometry and materials are built once and shared. A rig holds
 * one reference, so reconnecting or replacing the ball reuses the same buffers
 * and only the last disposal frees them.
 */
let sharedResources: BallSharedResources | null = null;
let sharedResourceReferences = 0;

function createGeometrySet(): BallGeometrySet {
  const shell = createPanelShellGeometry();
  const nodeRadius = BALL.RADIUS * VISUAL.BALL.NODE_RADIUS_RATIO;
  const nodeHeight = BALL.RADIUS * VISUAL.BALL.NODE_HEIGHT_RATIO;
  return {
    shell,
    seams: new THREE.EdgesGeometry(shell, 1),
    core: new THREE.IcosahedronGeometry(BALL.RADIUS * VISUAL.BALL.CORE_RADIUS_RATIO, 1),
    socket: new THREE.CylinderGeometry(
      nodeRadius * 1.42,
      nodeRadius * 1.55,
      nodeHeight * 0.78,
      8,
    ),
    node: new THREE.CylinderGeometry(nodeRadius, nodeRadius * 0.84, nodeHeight, 8),
    glow: new THREE.SphereGeometry(BALL.RADIUS * GLOW_RADIUS_RATIO, 24, 16),
    trail: new THREE.ConeGeometry(BALL.RADIUS * 0.82, BALL.RADIUS * TRAIL_LENGTH_RATIO, 14, 1, true),
  };
}

function createSharedMaterials(): BallSharedMaterials {
  return {
    shell: new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: VISUAL.BALL.ROUGHNESS,
      metalness: VISUAL.BALL.METALNESS,
      flatShading: true,
      transparent: true,
      opacity: 0.965,
    }),
    seams: new THREE.LineBasicMaterial({
      color: 0x121b22,
      transparent: true,
      opacity: VISUAL.BALL.SEAM_OPACITY,
      depthWrite: false,
    }),
    socket: new THREE.MeshStandardMaterial({
      color: VISUAL.PALETTE.STRUCTURE_DARK,
      roughness: 0.5,
      metalness: 0.72,
    }),
  };
}

function acquireSharedBallResources(): BallSharedResources {
  if (sharedResources === null) {
    sharedResources = {
      geometry: createGeometrySet(),
      materials: createSharedMaterials(),
      nodeDirections: Object.freeze(getNodeDirections()),
    };
  }
  sharedResourceReferences += 1;
  return sharedResources;
}

function releaseSharedBallResources(): void {
  if (sharedResourceReferences === 0) return;
  sharedResourceReferences -= 1;
  if (sharedResourceReferences > 0 || sharedResources === null) return;

  for (const geometry of Object.values(sharedResources.geometry)) geometry.dispose();
  for (const material of Object.values(sharedResources.materials)) material.dispose();
  sharedResources = null;
}

/** Live reference count, used by presentation-budget assertions. */
export function getSharedBallResourceReferenceCount(): number {
  return sharedResourceReferences;
}

/**
 * Bounded temporal presentation state owned by one ball rig. It is smoothed
 * from accepted values only and rebased on kickoff teleports.
 */
export interface BallRigMotionState {
  gyroAngle: number;
  pulsePhase: number;
  speed: number;
  trailBlend: number;
  proximityBlend: number;
}

export interface BallVisualRig {
  /** The root this rig owns; the reconciler parents this into the scene. */
  readonly object: THREE.Group;
  readonly radius: number;
  /** Half the unscaled trail cone length, used to seat it behind the ball. */
  readonly trailHalfLength: number;
  readonly shell: THREE.Mesh;
  readonly seams: THREE.LineSegments;
  readonly sockets: THREE.InstancedMesh;
  readonly nodes: THREE.InstancedMesh;
  readonly core: THREE.Mesh;
  /** Inner gyro that carries presentation spin without fighting authority. */
  readonly gyro: THREE.Group;
  readonly glow: THREE.Mesh;
  readonly trail: THREE.Mesh;
  readonly motion: BallRigMotionState;
  readonly isDisposed: boolean;
  resetTemporalState(): void;
  /** Detach, free per-rig effect materials, and release one shared reference. */
  dispose(): void;
}

/**
 * Create Rocket Arena's original mechanical match ball as an explicitly owned
 * presentation rig. The visible treatment stays spherical and anchored to the
 * shared BALL.RADIUS; nothing here infers goals, contacts, or score.
 */
export function createBallVisualRig(): BallVisualRig {
  const group = new THREE.Group();
  group.name = 'rocket-arena-mechanical-ball';

  const shared = acquireSharedBallResources();
  const geometry = shared.geometry;

  // Emissive and effect materials are animated per rig, so they are owned here
  // instead of being shared.
  const coreMaterial = new THREE.MeshStandardMaterial({
    color: VISUAL.PALETTE.BALL_CORE,
    emissive: VISUAL.PALETTE.BALL_CORE,
    emissiveIntensity: VISUAL.BALL.CORE_GLOW,
    roughness: 0.24,
    metalness: 0.32,
  });
  const nodeMaterial = new THREE.MeshStandardMaterial({
    color: VISUAL.PALETTE.BALL_CORE,
    emissive: VISUAL.PALETTE.BALL_CORE,
    emissiveIntensity: VISUAL.BALL.NODE_GLOW,
    roughness: 0.22,
    metalness: 0.5,
  });
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: VISUAL.PALETTE.BALL_CORE,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const trailMaterial = new THREE.MeshBasicMaterial({
    color: VISUAL.PALETTE.BALL_CORE,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const shell = new THREE.Mesh(geometry.shell, shared.materials.shell);
  shell.name = 'faceted-panel-shell';
  shell.castShadow = true;
  shell.receiveShadow = true;
  group.add(shell);

  const seams = new THREE.LineSegments(geometry.seams, shared.materials.seams);
  seams.name = 'dark-panel-seams';
  seams.scale.setScalar(VISUAL.BALL.SEAM_SCALE / VISUAL.BALL.SHELL_SCALE);
  seams.renderOrder = 2;
  group.add(seams);

  const directions = shared.nodeDirections;
  const sockets = new THREE.InstancedMesh(
    geometry.socket,
    shared.materials.socket,
    directions.length,
  );
  const nodes = new THREE.InstancedMesh(geometry.node, nodeMaterial, directions.length);
  sockets.name = 'panel-node-sockets';
  nodes.name = 'emissive-panel-nodes';

  const socketMatrix = new THREE.Matrix4();
  const nodeMatrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const socketPosition = new THREE.Vector3();
  const nodePosition = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);

  directions.forEach((direction, index) => {
    quaternion.setFromUnitVectors(UP, direction);
    socketPosition.copy(direction).multiplyScalar(BALL.RADIUS * 0.986);
    nodePosition.copy(direction).multiplyScalar(BALL.RADIUS * VISUAL.BALL.NODE_SURFACE_RATIO);
    socketMatrix.compose(socketPosition, quaternion, scale);
    nodeMatrix.compose(nodePosition, quaternion, scale);
    sockets.setMatrixAt(index, socketMatrix);
    nodes.setMatrixAt(index, nodeMatrix);
  });
  sockets.instanceMatrix.needsUpdate = true;
  nodes.instanceMatrix.needsUpdate = true;
  sockets.castShadow = true;
  nodes.castShadow = false;
  group.add(sockets, nodes);

  const core = new THREE.Mesh(geometry.core, coreMaterial);
  core.name = 'contained-energy-core';
  const gyro = new THREE.Group();
  gyro.name = 'ball-gyro-spin';
  gyro.add(core);
  group.add(gyro);

  const glow = new THREE.Mesh(geometry.glow, glowMaterial);
  glow.name = 'ball-proximity-glow';
  glow.renderOrder = 3;
  glow.visible = false;
  group.add(glow);

  const trail = new THREE.Mesh(geometry.trail, trailMaterial);
  trail.name = 'ball-motion-trail';
  trail.renderOrder = 3;
  trail.visible = false;
  trail.scale.setScalar(TRAIL_REST_SCALE);
  group.add(trail);

  const motion: BallRigMotionState = {
    gyroAngle: 0,
    pulsePhase: 0,
    speed: 0,
    trailBlend: 0,
    proximityBlend: 0,
  };
  let disposed = false;

  const rig: BallVisualRig = {
    object: group,
    radius: BALL.RADIUS,
    trailHalfLength: BALL.RADIUS * TRAIL_LENGTH_RATIO / 2,
    shell,
    seams,
    sockets,
    nodes,
    core,
    gyro,
    glow,
    trail,
    motion,
    get isDisposed(): boolean {
      return disposed;
    },
    resetTemporalState(): void {
      motion.gyroAngle = 0;
      motion.pulsePhase = 0;
      motion.speed = 0;
      motion.trailBlend = 0;
      motion.proximityBlend = 0;
      gyro.rotation.set(0, 0, 0);
      glow.visible = false;
      glowMaterial.opacity = 0;
      trail.visible = false;
      trail.scale.setScalar(TRAIL_REST_SCALE);
      trail.position.set(0, 0, 0);
      trail.quaternion.identity();
      trailMaterial.opacity = 0;
      coreMaterial.emissiveIntensity = VISUAL.BALL.CORE_GLOW;
      nodeMaterial.emissiveIntensity = VISUAL.BALL.NODE_GLOW;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      for (const material of [coreMaterial, nodeMaterial, glowMaterial, trailMaterial]) {
        material.dispose();
      }
      releaseSharedBallResources();
    },
  };

  group.userData.visualRig = rig;
  group.userData.panelShell = shell;
  group.userData.seams = seams;
  group.userData.emissiveNodes = nodes;
  group.userData.core = core;

  return rig;
}

/** Read the rig that owns one ball root, when the root is rig-backed. */
export function getBallVisualRig(ball: THREE.Object3D): BallVisualRig | null {
  const rig = ball.userData.visualRig as BallVisualRig | undefined;
  return rig !== undefined && typeof rig.dispose === 'function' ? rig : null;
}

/**
 * Production ball factory used by the snapshot reconciler. The returned root
 * carries its owning rig so disposal releases per-rig and shared resources.
 */
export function createBallMesh(): THREE.Group {
  return createBallVisualRig().object;
}
