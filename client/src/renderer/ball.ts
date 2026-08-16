import * as THREE from 'three';
import { BALL, VISUAL } from '@rocket-arena/shared';

const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;
const UP = new THREE.Vector3(0, 1, 0);

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

/**
 * Create Rocket Arena's original mechanical match ball.
 * Its outermost treatment remains spherical and tied to BALL.RADIUS.
 */
export function createBallMesh(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'rocket-arena-mechanical-ball';

  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(BALL.RADIUS * VISUAL.BALL.CORE_RADIUS_RATIO, 1),
    new THREE.MeshStandardMaterial({
      color: VISUAL.PALETTE.BALL_CORE,
      emissive: VISUAL.PALETTE.BALL_CORE,
      emissiveIntensity: VISUAL.BALL.CORE_GLOW,
      roughness: 0.24,
      metalness: 0.32,
    }),
  );
  core.name = 'contained-energy-core';
  group.add(core);

  const shellGeometry = createPanelShellGeometry();
  const shell = new THREE.Mesh(
    shellGeometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: VISUAL.BALL.ROUGHNESS,
      metalness: VISUAL.BALL.METALNESS,
      flatShading: true,
      transparent: true,
      opacity: 0.965,
    }),
  );
  shell.name = 'faceted-panel-shell';
  shell.castShadow = true;
  shell.receiveShadow = true;
  group.add(shell);

  const seamGeometry = new THREE.EdgesGeometry(shellGeometry, 1);
  const seams = new THREE.LineSegments(
    seamGeometry,
    new THREE.LineBasicMaterial({
      color: 0x121b22,
      transparent: true,
      opacity: VISUAL.BALL.SEAM_OPACITY,
      depthWrite: false,
    }),
  );
  seams.name = 'dark-panel-seams';
  seams.scale.setScalar(VISUAL.BALL.SEAM_SCALE / VISUAL.BALL.SHELL_SCALE);
  seams.renderOrder = 2;
  group.add(seams);

  const nodeRadius = BALL.RADIUS * VISUAL.BALL.NODE_RADIUS_RATIO;
  const nodeHeight = BALL.RADIUS * VISUAL.BALL.NODE_HEIGHT_RATIO;
  const directions = getNodeDirections();
  const socketGeometry = new THREE.CylinderGeometry(nodeRadius * 1.42, nodeRadius * 1.55, nodeHeight * 0.78, 8);
  const nodeGeometry = new THREE.CylinderGeometry(nodeRadius, nodeRadius * 0.84, nodeHeight, 8);
  const sockets = new THREE.InstancedMesh(
    socketGeometry,
    new THREE.MeshStandardMaterial({
      color: VISUAL.PALETTE.STRUCTURE_DARK,
      roughness: 0.5,
      metalness: 0.72,
    }),
    directions.length,
  );
  const nodes = new THREE.InstancedMesh(
    nodeGeometry,
    new THREE.MeshStandardMaterial({
      color: VISUAL.PALETTE.BALL_CORE,
      emissive: VISUAL.PALETTE.BALL_CORE,
      emissiveIntensity: VISUAL.BALL.NODE_GLOW,
      roughness: 0.22,
      metalness: 0.5,
    }),
    directions.length,
  );
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

  group.userData.panelShell = shell;
  group.userData.seams = seams;
  group.userData.emissiveNodes = nodes;
  group.userData.core = core;
  return group;
}
