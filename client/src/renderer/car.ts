import * as THREE from 'three';
import {
  CAR,
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  getScalarTuningValue,
  TUNING_IDS,
  VISUAL,
} from '@rocket-arena/shared';

const DEFAULT_CAR_COLLIDER_HEIGHT = getScalarTuningValue(
  DEFAULT_TUNING_REGISTRY_SNAPSHOT,
  TUNING_IDS.car.collider.height,
);
const CAR_VISUAL_WHEEL_RADIUS = CAR.BODY.HEIGHT * VISUAL.CAR.WHEEL.RADIUS_HEIGHT_RATIO;
const CAR_VISUAL_WHEEL_CENTER_Y = -CAR.BODY.HEIGHT * 0.17;
const CAR_PRESENTATION_Y_OFFSET = (
  -DEFAULT_CAR_COLLIDER_HEIGHT / 2
  - (CAR_VISUAL_WHEEL_CENTER_Y - CAR_VISUAL_WHEEL_RADIUS)
);

export interface ShellSection {
  z: number;
  width: number;
  bottom: number;
  top: number;
}

export interface CarVisualRig {
  wheelSpins: THREE.Group[];
  frontWheelSteers: THREE.Group[];
  exhausts: THREE.Group[];
  boostFlames: THREE.Mesh[];
  boostTrails: THREE.Mesh[];
  wheelRadius: number;
}

/**
 * Build a hard-surface shell from paired lower/upper cross-sections.
 * The non-indexed result preserves crisp, intentionally faceted panels.
 */
export function createSectionedShellGeometry(sections: readonly ShellSection[]): THREE.BufferGeometry {
  if (sections.length < 2) {
    throw new RangeError('A sectioned shell requires at least two cross-sections');
  }

  const positions: number[] = [];
  const indices: number[] = [];

  for (const section of sections) {
    const halfWidth = section.width / 2;
    positions.push(
      -halfWidth, section.bottom, section.z,
      halfWidth, section.bottom, section.z,
      -halfWidth, section.top, section.z,
      halfWidth, section.top, section.z,
    );
  }

  for (let sectionIndex = 0; sectionIndex < sections.length - 1; sectionIndex++) {
    const rear = sectionIndex * 4;
    const front = rear + 4;

    indices.push(
      rear, rear + 1, front,
      rear + 1, front + 1, front,
      rear + 2, front + 2, rear + 3,
      rear + 3, front + 2, front + 3,
      rear, front, rear + 2,
      rear + 2, front, front + 2,
      rear + 1, rear + 3, front + 1,
      rear + 3, front + 3, front + 1,
    );
  }

  const rear = 0;
  const front = (sections.length - 1) * 4;
  indices.push(
    rear, rear + 2, rear + 1,
    rear + 1, rear + 2, rear + 3,
    front, front + 1, front + 2,
    front + 1, front + 3, front + 2,
  );

  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  indexed.setIndex(indices);
  const geometry = indexed.toNonIndexed();
  indexed.dispose();
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

interface CarGeometrySet {
  shell: THREE.BufferGeometry;
  canopy: THREE.BufferGeometry;
  hoodBlade: THREE.BufferGeometry;
  spoilerWing: THREE.BufferGeometry;
  splitter: THREE.BufferGeometry;
  diffuser: THREE.BufferGeometry;
  shoulderPlate: THREE.BufferGeometry;
  skirt: THREE.BufferGeometry;
  wheelTire: THREE.TorusGeometry;
  wheelRim: THREE.CylinderGeometry;
  wheelHub: THREE.CylinderGeometry;
  wheelDisc: THREE.CylinderGeometry;
  fenderArch: THREE.TorusGeometry;
  light: THREE.BoxGeometry;
  tailLight: THREE.BoxGeometry;
  spoilerSupport: THREE.BoxGeometry;
  diffuserFin: THREE.BoxGeometry;
  exhaustNozzle: THREE.CylinderGeometry;
  exhaustRing: THREE.TorusGeometry;
  flame: THREE.ConeGeometry;
  trail: THREE.ConeGeometry;
}

let cachedGeometry: CarGeometrySet | null = null;
const teamMaterials = new Map<string, { body: THREE.MeshStandardMaterial; accent: THREE.MeshStandardMaterial }>();

const neutralMaterial = new THREE.MeshStandardMaterial({
  color: VISUAL.PALETTE.NEUTRAL_METAL,
  roughness: 0.42,
  metalness: 0.72,
});
const darkMaterial = new THREE.MeshStandardMaterial({
  color: VISUAL.PALETTE.STRUCTURE_DARK,
  roughness: 0.62,
  metalness: 0.48,
});
const tireMaterial = new THREE.MeshStandardMaterial({
  color: VISUAL.PALETTE.RUBBER,
  roughness: 0.92,
  metalness: 0.04,
});
const rimMaterial = new THREE.MeshStandardMaterial({
  color: VISUAL.PALETTE.STRUCTURE_LIGHT,
  roughness: 0.24,
  metalness: 0.9,
});
const brakeMaterial = new THREE.MeshStandardMaterial({
  color: 0x51251f,
  roughness: 0.48,
  metalness: 0.66,
});
const glassMaterial = new THREE.MeshPhysicalMaterial({
  color: VISUAL.PALETTE.GLASS,
  roughness: VISUAL.CAR.MATERIAL.GLASS_ROUGHNESS,
  metalness: VISUAL.CAR.MATERIAL.GLASS_METALNESS,
  transparent: true,
  opacity: VISUAL.CAR.MATERIAL.GLASS_OPACITY,
  clearcoat: 0.72,
  clearcoatRoughness: 0.18,
});
const headlightMaterial = new THREE.MeshStandardMaterial({
  color: VISUAL.PALETTE.WHITE_LIGHT,
  emissive: VISUAL.PALETTE.WHITE_LIGHT,
  emissiveIntensity: VISUAL.CAR.LIGHTS.HEADLIGHT_GLOW,
  roughness: 0.2,
});
const tailLightMaterial = new THREE.MeshStandardMaterial({
  color: 0xff352f,
  emissive: 0xff1f18,
  emissiveIntensity: VISUAL.CAR.LIGHTS.TAILLIGHT_GLOW,
  roughness: 0.28,
});

function getTeamMaterials(team: string): { body: THREE.MeshStandardMaterial; accent: THREE.MeshStandardMaterial } {
  const key = team === 'blue' ? 'blue' : 'orange';
  const cached = teamMaterials.get(key);
  if (cached) return cached;

  const bodyColor = key === 'blue' ? VISUAL.PALETTE.BLUE : VISUAL.PALETTE.ORANGE;
  const accentColor = key === 'blue' ? VISUAL.PALETTE.BLUE_LIGHT : VISUAL.PALETTE.ORANGE_LIGHT;
  const materials = {
    body: new THREE.MeshStandardMaterial({
      color: bodyColor,
      roughness: VISUAL.CAR.MATERIAL.BODY_ROUGHNESS,
      metalness: VISUAL.CAR.MATERIAL.BODY_METALNESS,
    }),
    accent: new THREE.MeshStandardMaterial({
      color: accentColor,
      emissive: accentColor,
      emissiveIntensity: 0.16,
      roughness: VISUAL.CAR.MATERIAL.PANEL_ROUGHNESS,
      metalness: 0.7,
    }),
  };
  teamMaterials.set(key, materials);
  return materials;
}

function getGeometry(): CarGeometrySet {
  if (cachedGeometry) return cachedGeometry;

  const width = CAR.BODY.WIDTH;
  const height = CAR.BODY.HEIGHT;
  const length = CAR.BODY.LENGTH;
  const shell = VISUAL.CAR.SHELL;
  const canopy = VISUAL.CAR.CANOPY;
  const wheel = VISUAL.CAR.WHEEL;
  const aero = VISUAL.CAR.AERO;
  const wheelRadius = height * wheel.RADIUS_HEIGHT_RATIO;
  const wheelWidth = width * wheel.WIDTH_BODY_RATIO;
  const canopyLength = length * canopy.LENGTH_RATIO;
  const canopyBottom = height * canopy.BASE_Y_RATIO;
  const canopyTop = height * canopy.HEIGHT_RATIO;

  cachedGeometry = {
    shell: createSectionedShellGeometry([
      { z: length * shell.REAR_Z_RATIO, width: width * shell.REAR_WIDTH_RATIO, bottom: height * shell.BELLY_Y_RATIO, top: height * shell.REAR_DECK_Y_RATIO },
      { z: length * shell.SHOULDER_Z_RATIO, width: width * shell.SHOULDER_WIDTH_RATIO, bottom: height * shell.BELLY_Y_RATIO, top: height * shell.SHOULDER_Y_RATIO },
      { z: length * shell.MID_Z_RATIO, width: width * shell.MID_WIDTH_RATIO, bottom: height * shell.BELLY_Y_RATIO, top: height * shell.MID_DECK_Y_RATIO },
      { z: length * shell.NOSE_Z_RATIO, width: width * shell.NOSE_WIDTH_RATIO, bottom: height * shell.BELLY_Y_RATIO * 0.72, top: height * shell.NOSE_Y_RATIO },
    ]),
    canopy: createSectionedShellGeometry([
      { z: -canopyLength / 2, width: width * canopy.WIDTH_RATIO * canopy.REAR_WIDTH_RATIO, bottom: canopyBottom, top: canopyTop * canopy.REAR_HEIGHT_RATIO },
      { z: canopyLength * 0.06, width: width * canopy.WIDTH_RATIO, bottom: canopyBottom, top: canopyTop },
      { z: canopyLength / 2, width: width * canopy.WIDTH_RATIO * canopy.FRONT_WIDTH_RATIO, bottom: canopyBottom, top: canopyTop * canopy.FRONT_HEIGHT_RATIO },
    ]),
    hoodBlade: createSectionedShellGeometry([
      { z: -length * 0.14, width: width * 0.26, bottom: 0, top: height * 0.035 },
      { z: length * 0.14, width: width * 0.16, bottom: 0, top: height * 0.015 },
    ]),
    spoilerWing: createSectionedShellGeometry([
      { z: -length * aero.SPOILER_CHORD_RATIO / 2, width: width * aero.SPOILER_WIDTH_RATIO, bottom: -height * 0.025, top: height * 0.025 },
      { z: length * aero.SPOILER_CHORD_RATIO / 2, width: width * aero.SPOILER_WIDTH_RATIO * 0.94, bottom: -height * 0.012, top: height * 0.016 },
    ]),
    splitter: createSectionedShellGeometry([
      { z: -length * aero.SPLITTER_LENGTH_RATIO / 2, width: width * aero.SPLITTER_WIDTH_RATIO * 0.9, bottom: -height * 0.025, top: height * 0.02 },
      { z: length * aero.SPLITTER_LENGTH_RATIO / 2, width: width * aero.SPLITTER_WIDTH_RATIO, bottom: -height * 0.025, top: 0 },
    ]),
    diffuser: createSectionedShellGeometry([
      { z: -length * 0.08, width: width * aero.DIFFUSER_WIDTH_RATIO, bottom: -height * 0.04, top: height * 0.02 },
      { z: length * 0.03, width: width * aero.DIFFUSER_WIDTH_RATIO * 0.82, bottom: -height * 0.01, top: height * 0.045 },
    ]),
    shoulderPlate: new THREE.BoxGeometry(width * 0.075, height * 0.11, length * 0.44),
    skirt: new THREE.BoxGeometry(width * 0.055, height * aero.SKIRT_HEIGHT_RATIO, length * 0.52),
    wheelTire: new THREE.TorusGeometry(
      wheelRadius * 0.72,
      wheelRadius * 0.28,
      wheel.TIRE_RADIAL_SEGMENTS,
      wheel.TIRE_TUBULAR_SEGMENTS,
    ),
    wheelRim: new THREE.CylinderGeometry(
      wheelRadius * wheel.RIM_RADIUS_RATIO,
      wheelRadius * wheel.RIM_RADIUS_RATIO,
      wheelWidth * 0.64,
      wheel.RIM_SEGMENTS,
    ),
    wheelHub: new THREE.CylinderGeometry(
      wheelRadius * wheel.HUB_RADIUS_RATIO,
      wheelRadius * wheel.HUB_RADIUS_RATIO,
      wheelWidth * 0.76,
      wheel.RIM_SEGMENTS,
    ),
    wheelDisc: new THREE.CylinderGeometry(
      wheelRadius * 0.48,
      wheelRadius * 0.48,
      wheelWidth * 0.38,
      wheel.RIM_SEGMENTS,
    ),
    fenderArch: new THREE.TorusGeometry(
      wheelRadius * wheel.FENDER_RADIUS_RATIO,
      wheelRadius * wheel.FENDER_TUBE_RATIO,
      5,
      18,
      Math.PI,
    ),
    light: new THREE.BoxGeometry(
      width * VISUAL.CAR.LIGHTS.HEADLIGHT_WIDTH_RATIO,
      height * VISUAL.CAR.LIGHTS.HEADLIGHT_HEIGHT_RATIO,
      length * 0.018,
    ),
    tailLight: new THREE.BoxGeometry(
      width * VISUAL.CAR.LIGHTS.HEADLIGHT_WIDTH_RATIO * 0.82,
      height * VISUAL.CAR.LIGHTS.HEADLIGHT_HEIGHT_RATIO,
      length * 0.018,
    ),
    spoilerSupport: new THREE.BoxGeometry(width * 0.045, height * 0.26, length * 0.035),
    diffuserFin: new THREE.BoxGeometry(width * 0.025, height * 0.14, length * 0.16),
    exhaustNozzle: new THREE.CylinderGeometry(
      height * VISUAL.CAR.EXHAUST.NOZZLE_RADIUS_HEIGHT_RATIO,
      height * VISUAL.CAR.EXHAUST.NOZZLE_RADIUS_HEIGHT_RATIO * 1.16,
      length * VISUAL.CAR.EXHAUST.NOZZLE_LENGTH_RATIO,
      12,
      1,
      true,
    ),
    exhaustRing: new THREE.TorusGeometry(
      height * VISUAL.CAR.EXHAUST.NOZZLE_RADIUS_HEIGHT_RATIO * 1.12,
      height * 0.012,
      5,
      12,
    ),
    flame: new THREE.ConeGeometry(
      height * VISUAL.CAR.EXHAUST.NOZZLE_RADIUS_HEIGHT_RATIO * 0.78,
      length * VISUAL.CAR.EXHAUST.FLAME_LENGTH_RATIO,
      10,
      1,
      true,
    ),
    trail: new THREE.ConeGeometry(
      height * VISUAL.CAR.EXHAUST.NOZZLE_RADIUS_HEIGHT_RATIO * 1.22,
      length * VISUAL.CAR.EXHAUST.TRAIL_LENGTH_RATIO,
      10,
      1,
      true,
    ),
  };

  return cachedGeometry;
}

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  name: string,
  castShadow = true,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = castShadow;
  parent.add(mesh);
  return mesh;
}

/**
 * Create Rocket Arena's original low-profile industrial rocket car.
 * Forward is +Z and the silhouette remains tied to the Rapier chassis extents.
 */
export function createCarMesh(team: string): THREE.Group {
  const group = new THREE.Group();
  group.name = `rocket-arena-car-${team}`;

  const geometry = getGeometry();
  const materials = getTeamMaterials(team);
  const width = CAR.BODY.WIDTH;
  const height = CAR.BODY.HEIGHT;
  const length = CAR.BODY.LENGTH;
  const wheelRadius = height * VISUAL.CAR.WHEEL.RADIUS_HEIGHT_RATIO;
  const wheelWidth = width * VISUAL.CAR.WHEEL.WIDTH_BODY_RATIO;

  addMesh(group, geometry.shell, materials.body, 'faceted-main-shell');

  const canopy = addMesh(group, geometry.canopy, glassMaterial, 'armored-canopy');
  canopy.position.z = length * VISUAL.CAR.CANOPY.Z_OFFSET_RATIO;
  canopy.renderOrder = 1;

  const hoodBlade = addMesh(group, geometry.hoodBlade, neutralMaterial, 'hood-spine');
  hoodBlade.position.set(0, height * 0.205, length * 0.27);

  for (const side of [-1, 1]) {
    const shoulder = addMesh(group, geometry.shoulderPlate, materials.accent, `shoulder-${side < 0 ? 'left' : 'right'}`);
    shoulder.position.set(side * width * 0.455, height * 0.035, length * 0.04);
    shoulder.rotation.x = -0.035;

    const skirt = addMesh(group, geometry.skirt, neutralMaterial, `side-skirt-${side < 0 ? 'left' : 'right'}`);
    skirt.position.set(side * width * 0.48, -height * 0.255, 0);
  }

  const splitter = addMesh(group, geometry.splitter, neutralMaterial, 'front-splitter');
  splitter.position.set(0, -height * 0.25, length * 0.455);

  const diffuser = addMesh(group, geometry.diffuser, darkMaterial, 'rear-diffuser');
  diffuser.position.set(0, -height * 0.245, -length * 0.445);

  const spoilerY = height * 0.5 * VISUAL.CAR.AERO.SPOILER_HEIGHT_RATIO;
  const spoiler = addMesh(group, geometry.spoilerWing, materials.accent, 'rear-spoiler');
  spoiler.position.set(0, spoilerY, -length * 0.42);
  spoiler.rotation.x = -0.08;

  for (const side of [-1, 1]) {
    const support = addMesh(group, geometry.spoilerSupport, neutralMaterial, `spoiler-support-${side < 0 ? 'left' : 'right'}`);
    support.position.set(side * width * 0.27, spoilerY - height * 0.13, -length * 0.42);
    support.rotation.x = -0.18;
  }

  const diffuserFinCount: number = VISUAL.CAR.AERO.DIFFUSER_FIN_COUNT;
  for (let index = 0; index < diffuserFinCount; index++) {
    const t = diffuserFinCount <= 1 ? 0.5 : index / (diffuserFinCount - 1);
    const fin = addMesh(group, geometry.diffuserFin, neutralMaterial, `diffuser-fin-${index}`);
    fin.position.set(
      THREE.MathUtils.lerp(-width * 0.27, width * 0.27, t),
      -height * 0.27,
      -length * 0.47,
    );
    fin.rotation.x = -0.28;
  }

  const wheelSpins: THREE.Group[] = [];
  const frontWheelSteers: THREE.Group[] = [];
  const wheelAxleX = width * VISUAL.CAR.WHEEL.X_OFFSET_WIDTH_RATIO;
  const wheelY = -height * 0.17;
  const axlePositions = [
    { z: length * VISUAL.CAR.WHEEL.FRONT_Z_LENGTH_RATIO, front: true },
    { z: length * VISUAL.CAR.WHEEL.REAR_Z_LENGTH_RATIO, front: false },
  ];

  for (const axle of axlePositions) {
    for (const side of [-1, 1]) {
      const steeringPivot = new THREE.Group();
      steeringPivot.name = `${axle.front ? 'front' : 'rear'}-${side < 0 ? 'left' : 'right'}-wheel-steer`;
      steeringPivot.position.set(side * wheelAxleX, wheelY, axle.z);

      const spinPivot = new THREE.Group();
      spinPivot.name = `${axle.front ? 'front' : 'rear'}-${side < 0 ? 'left' : 'right'}-wheel-spin`;
      spinPivot.userData.radius = wheelRadius;
      spinPivot.userData.side = side;

      const tire = addMesh(spinPivot, geometry.wheelTire, tireMaterial, 'tire');
      tire.rotation.y = Math.PI / 2;

      const brakeDisc = addMesh(spinPivot, geometry.wheelDisc, brakeMaterial, 'brake-disc');
      brakeDisc.rotation.z = Math.PI / 2;

      const rim = addMesh(spinPivot, geometry.wheelRim, rimMaterial, 'ten-spoke-rim');
      rim.rotation.z = Math.PI / 2;

      const hub = addMesh(spinPivot, geometry.wheelHub, materials.accent, 'wheel-hub');
      hub.rotation.z = Math.PI / 2;

      steeringPivot.add(spinPivot);
      group.add(steeringPivot);
      wheelSpins.push(spinPivot);
      if (axle.front) frontWheelSteers.push(steeringPivot);

      const fender = addMesh(group, geometry.fenderArch, darkMaterial, `${axle.front ? 'front' : 'rear'}-fender`);
      fender.position.set(side * width * 0.493, wheelY, axle.z);
      fender.rotation.y = Math.PI / 2;
      fender.scale.x = side;
    }
  }

  for (const side of [-1, 1]) {
    const headlight = addMesh(group, geometry.light, headlightMaterial, `headlight-${side < 0 ? 'left' : 'right'}`, false);
    headlight.position.set(side * width * 0.245, -height * 0.055, length * 0.502);
    headlight.rotation.y = side * -0.12;

    const tailLight = addMesh(group, geometry.tailLight, tailLightMaterial, `tail-lamp-${side < 0 ? 'left' : 'right'}`, false);
    tailLight.position.set(side * width * 0.31, height * 0.01, -length * 0.502);
  }

  const exhausts: THREE.Group[] = [];
  const boostFlames: THREE.Mesh[] = [];
  const boostTrails: THREE.Mesh[] = [];
  const flameColor = team === 'blue' ? VISUAL.PALETTE.BLUE_LIGHT : VISUAL.PALETTE.ORANGE_LIGHT;

  for (const side of [-1, 1]) {
    const exhaust = new THREE.Group();
    exhaust.name = `boost-exhaust-${side < 0 ? 'left' : 'right'}`;
    exhaust.position.set(
      side * width * VISUAL.CAR.EXHAUST.X_OFFSET_WIDTH_RATIO,
      height * VISUAL.CAR.EXHAUST.Y_OFFSET_HEIGHT_RATIO,
      -length * 0.49,
    );

    const nozzle = addMesh(exhaust, geometry.exhaustNozzle, neutralMaterial, 'exhaust-nozzle');
    nozzle.rotation.x = Math.PI / 2;

    const ring = addMesh(exhaust, geometry.exhaustRing, materials.accent, 'exhaust-ring', false);
    ring.position.z = -length * VISUAL.CAR.EXHAUST.NOZZLE_LENGTH_RATIO * 0.5;

    const flameMaterial = new THREE.MeshBasicMaterial({
      color: flameColor,
      transparent: true,
      opacity: 0.82,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const flame = addMesh(exhaust, geometry.flame, flameMaterial, 'boost-flame', false);
    flame.rotation.x = -Math.PI / 2;
    flame.position.z = -length * VISUAL.CAR.EXHAUST.FLAME_LENGTH_RATIO * 0.48;
    flame.visible = false;

    const trailMaterial = new THREE.MeshBasicMaterial({
      color: flameColor,
      transparent: true,
      opacity: VISUAL.MOTION.TRAIL_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const trail = addMesh(exhaust, geometry.trail, trailMaterial, 'boost-trail', false);
    trail.rotation.x = -Math.PI / 2;
    trail.position.z = -length * VISUAL.CAR.EXHAUST.TRAIL_LENGTH_RATIO * 0.5;
    trail.visible = false;

    group.add(exhaust);
    exhausts.push(exhaust);
    boostFlames.push(flame);
    boostTrails.push(trail);
  }

  const presentationRoot = new THREE.Group();
  presentationRoot.name = 'car-presentation-root';
  presentationRoot.position.y = CAR_PRESENTATION_Y_OFFSET;
  presentationRoot.add(...group.children);
  group.add(presentationRoot);

  const rig: CarVisualRig = {
    wheelSpins,
    frontWheelSteers,
    exhausts,
    boostFlames,
    boostTrails,
    wheelRadius,
  };
  group.userData.visualRig = rig;
  group.userData.wheels = wheelSpins;
  group.userData.exhausts = exhausts;
  group.userData.boostFlames = boostFlames;
  group.userData.boostTrails = boostTrails;
  group.userData.lastVisualPosition = new THREE.Vector3();
  group.userData.lastBoost = CAR.BOOST.START_AMOUNT;

  return group;
}
