import * as THREE from 'three';
import { ARENA } from '@rocket-arena/shared';

/**
 * Create a neon Rocket-League-style arena with dark surfaces and glowing trim.
 */
export function createArena(scene: THREE.Scene): void {
  const W = ARENA.WIDTH;
  const L = ARENA.LENGTH;
  const H = ARENA.HEIGHT;
  const T = ARENA.WALL_THICKNESS;
  const goalW = ARENA.GOAL.WIDTH;
  const goalH = ARENA.GOAL.HEIGHT;
  const goalD = ARENA.GOAL.DEPTH;

  // ── Floor ──────────────────────────────────────────────────────
  const floorGeo = new THREE.BoxGeometry(W, 0.2, L);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x1a1a24, roughness: 0.6, metalness: 0.2 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.position.y = -0.1;
  floor.receiveShadow = true;
  scene.add(floor);

  // ── Floor grid lines (neon effect) ─────────────────────────────
  const gridLineMat = new THREE.MeshBasicMaterial({ color: 0x3344aa, transparent: true, opacity: 0.25 });

  // Longitudinal lines (along Z)
  for (let x = -W / 2 + 5; x <= W / 2 - 5; x += 5) {
    const lineGeo = new THREE.BoxGeometry(0.06, 0.02, L - 2);
    const line = new THREE.Mesh(lineGeo, gridLineMat);
    line.position.set(x, 0.02, 0);
    scene.add(line);
  }

  // Lateral lines (along X)
  for (let z = -L / 2 + 5; z <= L / 2 - 5; z += 5) {
    const lineGeo = new THREE.BoxGeometry(W - 2, 0.02, 0.06);
    const line = new THREE.Mesh(lineGeo, gridLineMat);
    line.position.set(0, 0.02, z);
    scene.add(line);
  }

  // ── Center line (bright neon white) ────────────────────────────
  const centerLineGeo = new THREE.BoxGeometry(W - 1, 0.03, 0.2);
  const centerLineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
  const centerLine = new THREE.Mesh(centerLineGeo, centerLineMat);
  centerLine.position.y = 0.02;
  scene.add(centerLine);

  // ── Center circle (neon ring) ──────────────────────────────────
  const circleGeo = new THREE.RingGeometry(4.7, 5.1, 48);
  const circleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
  const circle = new THREE.Mesh(circleGeo, circleMat);
  circle.rotation.x = -Math.PI / 2;
  circle.position.y = 0.02;
  scene.add(circle);

  // ── Walls (dark solid with neon trim) ──────────────────────────
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x12121e, roughness: 0.7, metalness: 0.3 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x6644ff, emissive: 0x4422cc, emissiveIntensity: 0.6, roughness: 0.2 });

  // Left wall
  const leftWall = new THREE.Mesh(new THREE.BoxGeometry(T, H, L), wallMat);
  leftWall.position.set(-W / 2 - T / 2, H / 2, 0);
  scene.add(leftWall);
  // Left wall top trim
  const leftTrim = new THREE.Mesh(new THREE.BoxGeometry(T + 0.1, 0.15, L), trimMat);
  leftTrim.position.set(-W / 2 - T / 2, H, 0);
  scene.add(leftTrim);
  // Left wall bottom trim
  const leftTrimBot = new THREE.Mesh(new THREE.BoxGeometry(T + 0.1, 0.15, L), trimMat);
  leftTrimBot.position.set(-W / 2 - T / 2, 0.08, 0);
  scene.add(leftTrimBot);

  // Right wall
  const rightWall = new THREE.Mesh(new THREE.BoxGeometry(T, H, L), wallMat);
  rightWall.position.set(W / 2 + T / 2, H / 2, 0);
  scene.add(rightWall);
  // Right wall top trim
  const rightTrim = new THREE.Mesh(new THREE.BoxGeometry(T + 0.1, 0.15, L), trimMat);
  rightTrim.position.set(W / 2 + T / 2, H, 0);
  scene.add(rightTrim);
  // Right wall bottom trim
  const rightTrimBot = new THREE.Mesh(new THREE.BoxGeometry(T + 0.1, 0.15, L), trimMat);
  rightTrimBot.position.set(W / 2 + T / 2, 0.08, 0);
  scene.add(rightTrimBot);

  // ── Back wall segments (blue goal side, -Z) ────────────────────
  const sideW = (W - goalW) / 2;
  if (sideW > 0) {
    const backLeft = new THREE.Mesh(new THREE.BoxGeometry(sideW, H, T), wallMat);
    backLeft.position.set(-(W / 2 - sideW / 2), H / 2, -L / 2 - T / 2);
    scene.add(backLeft);

    const backRight = new THREE.Mesh(new THREE.BoxGeometry(sideW, H, T), wallMat);
    backRight.position.set(W / 2 - sideW / 2, H / 2, -L / 2 - T / 2);
    scene.add(backRight);
  }
  // Top segment above blue goal
  const topH = H - goalH;
  if (topH > 0) {
    const backTop = new THREE.Mesh(new THREE.BoxGeometry(goalW, topH, T), wallMat);
    backTop.position.set(0, goalH + topH / 2, -L / 2 - T / 2);
    scene.add(backTop);
  }

  // ── Front wall segments (orange goal side, +Z) ────────────────
  if (sideW > 0) {
    const frontLeft = new THREE.Mesh(new THREE.BoxGeometry(sideW, H, T), wallMat);
    frontLeft.position.set(-(W / 2 - sideW / 2), H / 2, L / 2 + T / 2);
    scene.add(frontLeft);

    const frontRight = new THREE.Mesh(new THREE.BoxGeometry(sideW, H, T), wallMat);
    frontRight.position.set(W / 2 - sideW / 2, H / 2, L / 2 + T / 2);
    scene.add(frontRight);
  }
  if (topH > 0) {
    const frontTop = new THREE.Mesh(new THREE.BoxGeometry(goalW, topH, T), wallMat);
    frontTop.position.set(0, goalH + topH / 2, L / 2 + T / 2);
    scene.add(frontTop);
  }

  // ── Back/Front wall neon trim (horizontal strip at top) ────────
  const backTrimGeo = new THREE.BoxGeometry(W, 0.15, T + 0.1);
  const backTrim = new THREE.Mesh(backTrimGeo, trimMat);
  backTrim.position.set(0, H, -L / 2 - T / 2);
  scene.add(backTrim);
  const frontTrim = new THREE.Mesh(backTrimGeo, trimMat);
  frontTrim.position.set(0, H, L / 2 + T / 2);
  scene.add(frontTrim);

  // ── Blue Goal (glowing portal) ─────────────────────────────────
  const blueGoalMat = new THREE.MeshStandardMaterial({
    color: 0x1133cc,
    emissive: 0x2244ff,
    emissiveIntensity: 0.7,
    transparent: true,
    opacity: 0.5,
  });
  const blueGoal = new THREE.Mesh(new THREE.BoxGeometry(goalW, goalH, goalD), blueGoalMat);
  blueGoal.position.set(0, goalH / 2, -L / 2 - goalD / 2);
  scene.add(blueGoal);

  // Blue goal frame (neon outline)
  const blueFrameMat = new THREE.MeshStandardMaterial({ color: 0x4488ff, emissive: 0x4488ff, emissiveIntensity: 1.0, roughness: 0.1 });
  // Top bar
  const bFrameTop = new THREE.Mesh(new THREE.BoxGeometry(goalW + 0.3, 0.2, 0.2), blueFrameMat);
  bFrameTop.position.set(0, goalH, -L / 2);
  scene.add(bFrameTop);
  // Left post
  const bFrameL = new THREE.Mesh(new THREE.BoxGeometry(0.2, goalH, 0.2), blueFrameMat);
  bFrameL.position.set(-goalW / 2, goalH / 2, -L / 2);
  scene.add(bFrameL);
  // Right post
  const bFrameR = new THREE.Mesh(new THREE.BoxGeometry(0.2, goalH, 0.2), blueFrameMat);
  bFrameR.position.set(goalW / 2, goalH / 2, -L / 2);
  scene.add(bFrameR);

  // ── Orange Goal (glowing portal) ───────────────────────────────
  const orangeGoalMat = new THREE.MeshStandardMaterial({
    color: 0xcc5511,
    emissive: 0xff6622,
    emissiveIntensity: 0.7,
    transparent: true,
    opacity: 0.5,
  });
  const orangeGoal = new THREE.Mesh(new THREE.BoxGeometry(goalW, goalH, goalD), orangeGoalMat);
  orangeGoal.position.set(0, goalH / 2, L / 2 + goalD / 2);
  scene.add(orangeGoal);

  // Orange goal frame (neon outline)
  const orangeFrameMat = new THREE.MeshStandardMaterial({ color: 0xff8844, emissive: 0xff8844, emissiveIntensity: 1.0, roughness: 0.1 });
  // Top bar
  const oFrameTop = new THREE.Mesh(new THREE.BoxGeometry(goalW + 0.3, 0.2, 0.2), orangeFrameMat);
  oFrameTop.position.set(0, goalH, L / 2);
  scene.add(oFrameTop);
  // Left post
  const oFrameL = new THREE.Mesh(new THREE.BoxGeometry(0.2, goalH, 0.2), orangeFrameMat);
  oFrameL.position.set(-goalW / 2, goalH / 2, L / 2);
  scene.add(oFrameL);
  // Right post
  const oFrameR = new THREE.Mesh(new THREE.BoxGeometry(0.2, goalH, 0.2), orangeFrameMat);
  oFrameR.position.set(goalW / 2, goalH / 2, L / 2);
  scene.add(oFrameR);

  // ── Floor edge trim (neon border around entire floor) ──────────
  const edgeTrimMat = new THREE.MeshStandardMaterial({ color: 0x6644ff, emissive: 0x4422cc, emissiveIntensity: 0.5, roughness: 0.2 });
  // Front edge
  const edgeFront = new THREE.Mesh(new THREE.BoxGeometry(W, 0.1, 0.15), edgeTrimMat);
  edgeFront.position.set(0, 0.05, L / 2);
  scene.add(edgeFront);
  // Back edge
  const edgeBack = new THREE.Mesh(new THREE.BoxGeometry(W, 0.1, 0.15), edgeTrimMat);
  edgeBack.position.set(0, 0.05, -L / 2);
  scene.add(edgeBack);
  // Left edge
  const edgeLeft = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.1, L), edgeTrimMat);
  edgeLeft.position.set(-W / 2, 0.05, 0);
  scene.add(edgeLeft);
  // Right edge
  const edgeRight = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.1, L), edgeTrimMat);
  edgeRight.position.set(W / 2, 0.05, 0);
  scene.add(edgeRight);
}
