import * as THREE from 'three';
import { CAR } from '@rocket-arena/shared';

/**
 * Create a procedural car mesh (box body + 4 cylinder wheels).
 * Team colored: blue = 0x3366ff, orange = 0xff6633
 */
export function createCarMesh(team: string): THREE.Group {
  const group = new THREE.Group();
  const color = team === 'blue' ? 0x3366ff : 0xff6633;

  // Body
  const bodyGeo = new THREE.BoxGeometry(CAR.BODY.WIDTH, CAR.BODY.HEIGHT, CAR.BODY.LENGTH);
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  group.add(body);

  // Windshield (darker area on top-front)
  const windshieldGeo = new THREE.BoxGeometry(CAR.BODY.WIDTH * 0.8, CAR.BODY.HEIGHT * 0.4, CAR.BODY.LENGTH * 0.35);
  const windshieldMat = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.1, metalness: 0.8 });
  const windshield = new THREE.Mesh(windshieldGeo, windshieldMat);
  windshield.position.set(0, CAR.BODY.HEIGHT * 0.4, -CAR.BODY.LENGTH * 0.1);
  group.add(windshield);

  // Wheels (4 cylinders)
  const wheelRadius = CAR.BODY.HEIGHT * 0.5;
  const wheelWidth = 0.3;
  const wheelGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 12);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });

  const wheelPositions = [
    { x: -CAR.BODY.WIDTH / 2 - wheelWidth / 2, y: -CAR.BODY.HEIGHT * 0.2, z: CAR.BODY.LENGTH * 0.3 },  // front-left
    { x: CAR.BODY.WIDTH / 2 + wheelWidth / 2, y: -CAR.BODY.HEIGHT * 0.2, z: CAR.BODY.LENGTH * 0.3 },   // front-right
    { x: -CAR.BODY.WIDTH / 2 - wheelWidth / 2, y: -CAR.BODY.HEIGHT * 0.2, z: -CAR.BODY.LENGTH * 0.3 }, // rear-left
    { x: CAR.BODY.WIDTH / 2 + wheelWidth / 2, y: -CAR.BODY.HEIGHT * 0.2, z: -CAR.BODY.LENGTH * 0.3 },  // rear-right
  ];

  for (const pos of wheelPositions) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(pos.x, pos.y, pos.z);
    wheel.castShadow = true;
    group.add(wheel);
  }

  return group;
}
