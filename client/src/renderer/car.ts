import * as THREE from 'three';
import { CAR } from '@rocket-arena/shared';

/**
 * Create a sleek Rocket-League-style procedural car mesh.
 * Low wedge body, cabin, spoiler, proper wheels with hubs, headlights and tail lights.
 */
export function createCarMesh(team: string): THREE.Group {
  const group = new THREE.Group();
  const color = team === 'blue' ? 0x2255cc : 0xcc5522;
  const accentColor = team === 'blue' ? 0x4488ff : 0xff8844;

  const W = CAR.BODY.WIDTH;
  const H = CAR.BODY.HEIGHT;
  const L = CAR.BODY.LENGTH;

  // Main body — slightly tapered (wider at rear, narrower at front)
  const bodyGeo = new THREE.BoxGeometry(W, H * 0.6, L);
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.4 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0;
  body.castShadow = true;
  group.add(body);

  // Nose (front wedge — smaller box angled down)
  const noseGeo = new THREE.BoxGeometry(W * 0.9, H * 0.35, L * 0.25);
  const noseMat = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.4, metalness: 0.3 });
  const nose = new THREE.Mesh(noseGeo, noseMat);
  nose.position.set(0, -H * 0.1, L * 0.4);
  group.add(nose);

  // Cabin (low profile box on top)
  const cabinGeo = new THREE.BoxGeometry(W * 0.7, H * 0.3, L * 0.4);
  const cabinMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.1, metalness: 0.8 });
  const cabin = new THREE.Mesh(cabinGeo, cabinMat);
  cabin.position.set(0, H * 0.4, -L * 0.05);
  group.add(cabin);

  // Rear spoiler
  const spoilerGeo = new THREE.BoxGeometry(W * 0.8, H * 0.08, L * 0.05);
  const spoilerMat = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.3 });
  const spoiler = new THREE.Mesh(spoilerGeo, spoilerMat);
  spoiler.position.set(0, H * 0.55, -L * 0.42);
  group.add(spoiler);

  // Spoiler mounts (two small pillars)
  const mountGeo = new THREE.BoxGeometry(0.05, H * 0.2, 0.05);
  const mountMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
  const mountL = new THREE.Mesh(mountGeo, mountMat);
  mountL.position.set(-W * 0.3, H * 0.45, -L * 0.42);
  group.add(mountL);
  const mountR = new THREE.Mesh(mountGeo, mountMat);
  mountR.position.set(W * 0.3, H * 0.45, -L * 0.42);
  group.add(mountR);

  // Wheels (4 cylinders, dark rubber with metallic hub)
  const wheelRadius = H * 0.4;
  const wheelWidth = 0.25;
  const wheelGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 16);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });

  const wheelPositions = [
    { x: -W / 2 - wheelWidth / 2, y: -H * 0.15, z: L * 0.32 },
    { x: W / 2 + wheelWidth / 2, y: -H * 0.15, z: L * 0.32 },
    { x: -W / 2 - wheelWidth / 2, y: -H * 0.15, z: -L * 0.32 },
    { x: W / 2 + wheelWidth / 2, y: -H * 0.15, z: -L * 0.32 },
  ];

  for (const pos of wheelPositions) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(pos.x, pos.y, pos.z);
    wheel.castShadow = true;
    group.add(wheel);

    // Hub cap (small bright disc)
    const hubGeo = new THREE.CylinderGeometry(wheelRadius * 0.4, wheelRadius * 0.4, wheelWidth + 0.02, 8);
    const hubMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.8 });
    const hub = new THREE.Mesh(hubGeo, hubMat);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(pos.x, pos.y, pos.z);
    group.add(hub);
  }

  // Headlights (two small emissive boxes at front)
  const lightGeo = new THREE.BoxGeometry(W * 0.15, H * 0.1, 0.05);
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xffffcc, emissive: 0xffffcc, emissiveIntensity: 0.8 });
  const lightL = new THREE.Mesh(lightGeo, lightMat);
  lightL.position.set(-W * 0.3, 0, L * 0.51);
  group.add(lightL);
  const lightR = new THREE.Mesh(lightGeo, lightMat);
  lightR.position.set(W * 0.3, 0, L * 0.51);
  group.add(lightR);

  // Tail lights (red emissive at rear)
  const tailGeo = new THREE.BoxGeometry(W * 0.12, H * 0.08, 0.05);
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff0000, emissiveIntensity: 0.6 });
  const tailL = new THREE.Mesh(tailGeo, tailMat);
  tailL.position.set(-W * 0.3, 0.05, -L * 0.51);
  group.add(tailL);
  const tailR = new THREE.Mesh(tailGeo, tailMat);
  tailR.position.set(W * 0.3, 0.05, -L * 0.51);
  group.add(tailR);

  return group;
}
