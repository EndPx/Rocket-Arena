import * as THREE from 'three';
import { ARENA } from '@rocket-arena/shared';

export function createArena(scene: THREE.Scene): void {
  const W = ARENA.WIDTH;
  const L = ARENA.LENGTH;
  const H = ARENA.HEIGHT;
  const T = ARENA.WALL_THICKNESS;
  const goalW = ARENA.GOAL.WIDTH;
  const goalH = ARENA.GOAL.HEIGHT;
  const goalD = ARENA.GOAL.DEPTH;

  // Floor
  const floorGeo = new THREE.BoxGeometry(W, 0.2, L);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x2d5a27, roughness: 0.8 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.position.y = -0.1;
  floor.receiveShadow = true;
  scene.add(floor);

  // Center line
  const lineGeo = new THREE.BoxGeometry(W - 2, 0.02, 0.15);
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 });
  const centerLine = new THREE.Mesh(lineGeo, lineMat);
  centerLine.position.y = 0.01;
  scene.add(centerLine);

  // Center circle
  const circleGeo = new THREE.RingGeometry(4.8, 5, 32);
  const circleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, side: THREE.DoubleSide });
  const circle = new THREE.Mesh(circleGeo, circleMat);
  circle.rotation.x = -Math.PI / 2;
  circle.position.y = 0.01;
  scene.add(circle);

  // Walls (semi-transparent)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x333344, transparent: true, opacity: 0.6, roughness: 0.5 });

  // Left wall
  const leftWall = new THREE.Mesh(new THREE.BoxGeometry(T, H, L), wallMat);
  leftWall.position.set(-W / 2 - T / 2, H / 2, 0);
  scene.add(leftWall);

  // Right wall
  const rightWall = new THREE.Mesh(new THREE.BoxGeometry(T, H, L), wallMat);
  rightWall.position.set(W / 2 + T / 2, H / 2, 0);
  scene.add(rightWall);

  // Back wall segments (blue goal side, -Z)
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

  // Front wall segments (orange goal side, +Z)
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

  // Goal areas (colored boxes to indicate goals)
  // Blue goal
  const blueGoalMat = new THREE.MeshStandardMaterial({ color: 0x3366ff, emissive: 0x1133aa, emissiveIntensity: 0.3, transparent: true, opacity: 0.4 });
  const blueGoal = new THREE.Mesh(new THREE.BoxGeometry(goalW, goalH, goalD), blueGoalMat);
  blueGoal.position.set(0, goalH / 2, -L / 2 - goalD / 2);
  scene.add(blueGoal);

  // Orange goal
  const orangeGoalMat = new THREE.MeshStandardMaterial({ color: 0xff6633, emissive: 0xaa3311, emissiveIntensity: 0.3, transparent: true, opacity: 0.4 });
  const orangeGoal = new THREE.Mesh(new THREE.BoxGeometry(goalW, goalH, goalD), orangeGoalMat);
  orangeGoal.position.set(0, goalH / 2, L / 2 + goalD / 2);
  scene.add(orangeGoal);

  // Ceiling (very transparent, just to show boundary)
  const ceilMat = new THREE.MeshBasicMaterial({ color: 0x444466, transparent: true, opacity: 0.1, side: THREE.DoubleSide });
  const ceiling = new THREE.Mesh(new THREE.BoxGeometry(W, 0.1, L), ceilMat);
  ceiling.position.y = H;
  scene.add(ceiling);
}
