import * as THREE from 'three';
import {
  VISUAL,
  type ResolvedArenaGeometry,
  type ResolvedArenaGoalRegion,
} from '@rocket-arena/shared';
import { ARENA_PRESENTATION_STYLE, DAYLIGHT_SCENE_STYLE } from './arena-style.js';
import { glslColor, glslFloat, withWorldPattern } from './world-pattern.js';

export interface ArenaPresentationResources {
  readonly geometries: Set<THREE.BufferGeometry>;
  readonly materials: Set<THREE.Material>;
  readonly textures: Set<THREE.Texture>;
  ownGeometry<T extends THREE.BufferGeometry>(geometry: T): T;
  ownMaterial<T extends THREE.Material>(material: T): T;
  ownTexture<T extends THREE.Texture>(texture: T): T;
}

export interface StadiumPresentationAnchors {
  readonly centerX: number;
  readonly centerZ: number;
  readonly halfWidth: number;
  readonly halfLength: number;
  readonly ceilingY: number;
  readonly goalBackDistance: number;
}

export interface DaylightExteriorAnimation {
  readonly atmosphere: THREE.Points;
  readonly flags: THREE.InstancedMesh;
}

const IDENTITY_QUATERNION = new THREE.Quaternion();
const INSTANCE_MATRIX = new THREE.Matrix4();
const X_AXIS = new THREE.Vector3(1, 0, 0);

function setInstance(
  mesh: THREE.InstancedMesh,
  index: number,
  position: THREE.Vector3,
  scale: THREE.Vector3,
  quaternion = IDENTITY_QUATERNION,
): void {
  INSTANCE_MATRIX.compose(position, quaternion, scale);
  mesh.setMatrixAt(index, INSTANCE_MATRIX);
}

function setBeamInstance(
  mesh: THREE.InstancedMesh,
  index: number,
  start: THREE.Vector3,
  end: THREE.Vector3,
  thickness: number,
): void {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(X_AXIS, direction.normalize());
  setInstance(
    mesh,
    index,
    new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5),
    new THREE.Vector3(length, thickness, thickness),
    quaternion,
  );
}

function addBox(
  parent: THREE.Object3D,
  unitBox: THREE.BoxGeometry,
  name: string,
  size: THREE.Vector3,
  position: THREE.Vector3,
  material: THREE.Material,
  castShadow = false,
  receiveShadow = false,
): THREE.Mesh {
  const mesh = new THREE.Mesh(unitBox, material);
  mesh.name = name;
  mesh.scale.copy(size);
  mesh.position.copy(position);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  parent.add(mesh);
  return mesh;
}

function configureRepeatTexture(texture: THREE.DataTexture, repeatX: number, repeatY: number): void {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
}

function createTurfMaterial(
  resources: ArenaPresentationResources,
  anchors: StadiumPresentationAnchors,
): THREE.MeshStandardMaterial {
  const style = ARENA_PRESENTATION_STYLE.turf;
  const colorData = new Uint8Array(style.size * style.size * 4);
  const roughnessData = new Uint8Array(style.size * style.size * 4);
  const base = style.base;
  for (let y = 0; y < style.size; y += 1) {
    for (let x = 0; x < style.size; x += 1) {
      const pixel = (y * style.size + x) * 4;
      const checker = ((Math.floor(x / 12) + Math.floor(y / 12)) & 1) === 0 ? 1 : -1;
      const mow = (Math.floor(y / 6) & 1) === 0 ? 1 : -1;
      const hash = ((x * 37 + y * 61 + x * y * 13) & 31) / 31 - 0.5;
      const lift = 1 + checker * style.checkerLift + mow * style.mowLift + hash * style.fiberLift;
      colorData[pixel] = Math.round(THREE.MathUtils.clamp(base.r * lift, 0, 1) * 255);
      colorData[pixel + 1] = Math.round(THREE.MathUtils.clamp(base.g * lift, 0, 1) * 255);
      colorData[pixel + 2] = Math.round(THREE.MathUtils.clamp(base.b * lift, 0, 1) * 255);
      colorData[pixel + 3] = 255;
      const roughness = Math.round(THREE.MathUtils.clamp(0.76 - checker * 0.045 - mow * 0.035 + hash * 0.08, 0, 1) * 255);
      roughnessData[pixel] = roughness;
      roughnessData[pixel + 1] = roughness;
      roughnessData[pixel + 2] = roughness;
      roughnessData[pixel + 3] = 255;
    }
  }

  const colorMap = resources.ownTexture(new THREE.DataTexture(
    colorData,
    style.size,
    style.size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  ));
  colorMap.name = 'procedural-turf-albedo';
  colorMap.colorSpace = THREE.SRGBColorSpace;
  configureRepeatTexture(colorMap, style.repeatX, style.repeatY);

  const roughnessMap = resources.ownTexture(new THREE.DataTexture(
    roughnessData,
    style.size,
    style.size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  ));
  roughnessMap.name = 'procedural-turf-roughness';
  configureRepeatTexture(roughnessMap, style.repeatX, style.repeatY);

  const material = resources.ownMaterial(new THREE.MeshStandardMaterial({
    name: 'procedural-pbr-turf-material',
    color: 0xffffff,
    map: colorMap,
    roughnessMap,
    roughness: 0.86,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }));
  // The texture supplies fibre and a fine checker, which is all a repeating map
  // can honestly do: anything larger tiles visibly across a 102 m pitch. Anything
  // measured against the arena itself is painted in world space on top.
  return withWorldPattern(material, turfPattern(anchors));
}

/**
 * What the turf carries beyond grass fibre.
 *
 * All of it is keyed to the arena rather than to the texture's UV repeat, which is
 * the whole reason it is here and not in the bitmap: mow bands that run the true
 * length of the pitch, a team split that falls exactly on the centre line, and an
 * apron sized to the real goal mouth. It multiplies the existing albedo rather
 * than replacing it, so the fibre detail survives underneath.
 */
function turfPattern(anchors: StadiumPresentationAnchors): string {
  const halfWidth = anchors.halfWidth;
  const halfLength = anchors.halfLength;
  // Bands run lengthwise, so they are periodic across x. The two mow periods are
  // deliberately different from each other and from the lane spacing, or the
  // three would beat together into one coarse stripe.
  const mowWidth = (halfWidth * 2) / 20;
  const crossWidth = (halfLength * 2) / 26;
  const laneSpacing = halfWidth / 3;
  const gridSpacing = VISUAL.STADIUM.FIELD.GRID_SPACING;

  return `
  {
    vec3 wp = vArenaWorld;
    float acrossField = abs(wp.x) / ${glslFloat(halfWidth)};
    float alongField = abs(wp.z) / ${glslFloat(halfLength)};

    // Mown bands, plus a much subtler cross mow so it reads as a cut lawn rather
    // than as blinds.
    float mow = mod(floor(wp.x / ${glslFloat(mowWidth)}), 2.0);
    float cross = mod(floor(wp.z / ${glslFloat(crossWidth)}), 2.0);
    // Lifted overall as well as banded: the bare texture reads almost black-green
    // under this lighting, which left everything painted on it blowing out.
    vec3 turf = diffuseColor.rgb * 1.22 * mix(0.84, 1.16, mow) * mix(0.97, 1.03, cross);

    // Team lanes down each half. Painted stripes, not light: the edges are tight
    // and the colour sits between the muted field tint and the saturated team
    // colour. A wide soft edge and the full UI colour read as a glowing beam
    // lying on the grass, which is what this looked like first time round.
    vec3 team = mix(
      wp.z < 0.0
        ? ${glslColor(VISUAL.PALETTE.FIELD_BLUE)}
        : ${glslColor(VISUAL.PALETTE.FIELD_ORANGE)},
      wp.z < 0.0
        ? ${glslColor(VISUAL.PALETTE.BLUE)}
        : ${glslColor(VISUAL.PALETTE.ORANGE)},
      0.55
    );
    float lanePhase = abs(fract(abs(wp.x) / ${glslFloat(laneSpacing)}) - 0.5) * 2.0;
    float lane = smoothstep(0.86, 0.94, lanePhase);
    // Ends before the apron and starts clear of the centre line, so the halves
    // meet cleanly and the paint does not run off the pitch.
    float laneReach = smoothstep(0.06, 0.16, alongField)
      * (1.0 - smoothstep(0.72, 0.80, alongField));
    turf = mix(turf, team, lane * laneReach * 0.62);

    // Fine technical grid, the same spacing the lane markings already use.
    float gridX = abs(fract(wp.x / ${glslFloat(gridSpacing)}) - 0.5) * 2.0;
    float gridZ = abs(fract(wp.z / ${glslFloat(gridSpacing)}) - 0.5) * 2.0;
    float grid = max(smoothstep(0.955, 1.0, gridX), smoothstep(0.955, 1.0, gridZ));
    turf = mix(turf, ${glslColor(VISUAL.PALETTE.FIELD_LINE)}, grid * 0.09);

    // A dark apron in front of each goal, narrower than the field so the corners
    // stay grass, which is how the reference arena reads from above.
    float apron = smoothstep(0.78, 0.92, alongField)
      * (1.0 - smoothstep(0.34, 0.66, acrossField));
    turf = mix(turf, ${glslColor(VISUAL.PALETTE.STRUCTURE_DARK)}, apron * 0.72);
    // One bright edge where the apron meets the grass, so it reads as a surface
    // change rather than as a shadow.
    float apronEdge = (1.0 - smoothstep(0.0, 0.012, abs(alongField - 0.79)))
      * (1.0 - smoothstep(0.34, 0.62, acrossField));
    turf = mix(turf, ${glslColor(VISUAL.PALETTE.FIELD_LINE)}, apronEdge * 0.34);

    diffuseColor.rgb = turf;
  }`;
}

function createCageOverlays(
  root: THREE.Group,
  geometry: ResolvedArenaGeometry,
  resources: ArenaPresentationResources,
): void {
  const cagePrimitiveIds = new Set(
    geometry.primitives
      .filter(({ materialRole }) => materialRole === 'field-containment' || materialRole === 'field-ceiling')
      .map(({ id }) => id),
  );
  const facetPositions: number[] = [];
  for (const primitive of geometry.primitives) {
    if (!cagePrimitiveIds.has(primitive.id)) continue;
    const surface = primitive.inwardSurface;
    const seen = new Set<string>();
    for (let index = 0; index < surface.indices.length; index += 3) {
      const triangle = [surface.indices[index]!, surface.indices[index + 1]!, surface.indices[index + 2]!] as const;
      for (const [firstIndex, secondIndex] of [[0, 1], [1, 2], [2, 0]] as const) {
        const first = triangle[firstIndex];
        const second = triangle[secondIndex];
        const key = first < second ? `${first}:${second}` : `${second}:${first}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const vertexIndex of [first, second]) {
          const position = surface.positions[vertexIndex]!;
          const normal = surface.normals[vertexIndex]!;
          facetPositions.push(
            position[0] + normal[0] * 0.018,
            position[1] + normal[1] * 0.018,
            position[2] + normal[2] * 0.018,
          );
        }
      }
    }
  }
  const facetGeometry = resources.ownGeometry(new THREE.BufferGeometry());
  facetGeometry.setAttribute('position', new THREE.Float32BufferAttribute(facetPositions, 3));
  const facetMaterial = resources.ownMaterial(new THREE.LineBasicMaterial({
    color: ARENA_PRESENTATION_STYLE.cageLine,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  }));
  const facets = new THREE.LineSegments(facetGeometry, facetMaterial);
  facets.name = 'batched-cage-faceted-overlay';
  facets.renderOrder = 4;
  root.add(facets);

  const mullionPositions: number[] = [];
  for (const seam of geometry.seams) {
    for (const edge of seam.edges) {
      if (!edge.primitiveIds.some((id) => cagePrimitiveIds.has(id))) continue;
      mullionPositions.push(...edge.endpoints[0], ...edge.endpoints[1]);
    }
  }
  const mullionGeometry = resources.ownGeometry(new THREE.BufferGeometry());
  mullionGeometry.setAttribute('position', new THREE.Float32BufferAttribute(mullionPositions, 3));
  const mullionMaterial = resources.ownMaterial(new THREE.LineBasicMaterial({
    color: ARENA_PRESENTATION_STYLE.graphite,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
  }));
  const mullions = new THREE.LineSegments(mullionGeometry, mullionMaterial);
  mullions.name = 'batched-cage-major-mullions';
  mullions.renderOrder = 5;
  root.add(mullions);
}

function createServiceDecks(
  root: THREE.Group,
  geometry: ResolvedArenaGeometry,
  resources: ArenaPresentationResources,
  unitBox: THREE.BoxGeometry,
  anchors: StadiumPresentationAnchors,
): void {
  const deckMaterial = resources.ownMaterial(new THREE.MeshStandardMaterial({
    color: ARENA_PRESENTATION_STYLE.graphiteMid,
    roughness: 0.76,
    metalness: 0.32,
  }));
  const kickboardMaterial = resources.ownMaterial(new THREE.MeshStandardMaterial({
    color: ARENA_PRESENTATION_STYLE.graphite,
    roughness: 0.54,
    metalness: 0.58,
  }));
  const deckWidth = 2.25;
  const hexPositions: number[] = [];
  const appendHexRect = (minX: number, maxX: number, minZ: number, maxZ: number): void => {
    const radius = 0.42;
    const horizontal = Math.sqrt(3) * radius;
    const vertical = 1.5 * radius;
    let row = 0;
    for (let z = minZ + radius; z <= maxZ - radius; z += vertical) {
      const rowOffset = (row & 1) * horizontal * 0.5;
      for (let x = minX + radius + rowOffset; x <= maxX - radius; x += horizontal) {
        const vertices: THREE.Vector3[] = [];
        for (let corner = 0; corner < 6; corner += 1) {
          const angle = Math.PI / 6 + corner * Math.PI / 3;
          vertices.push(new THREE.Vector3(x + Math.cos(angle) * radius, 0.064, z + Math.sin(angle) * radius));
        }
        if (vertices.some((vertex) => vertex.x < minX || vertex.x > maxX || vertex.z < minZ || vertex.z > maxZ)) continue;
        for (let corner = 0; corner < 6; corner += 1) hexPositions.push(...vertices[corner]!.toArray(), ...vertices[(corner + 1) % 6]!.toArray());
      }
      row += 1;
    }
  };

  for (const xSign of [-1, 1] as const) {
    const centerX = anchors.centerX + xSign * (anchors.halfWidth + deckWidth / 2);
    addBox(
      root,
      unitBox,
      'graphite-side-service-deck',
      new THREE.Vector3(deckWidth, 0.08, anchors.halfLength * 2 + 4),
      new THREE.Vector3(centerX, 0.015, anchors.centerZ),
      deckMaterial,
      false,
      true,
    );
    appendHexRect(
      centerX - deckWidth / 2,
      centerX + deckWidth / 2,
      anchors.centerZ - anchors.halfLength - 2,
      anchors.centerZ + anchors.halfLength + 2,
    );
    addBox(
      root,
      unitBox,
      'lower-side-kickboard-fascia',
      new THREE.Vector3(0.12, 0.78, anchors.halfLength * 2 - 2.2),
      new THREE.Vector3(anchors.centerX + xSign * (anchors.halfWidth + 0.07), 0.39, anchors.centerZ),
      kickboardMaterial,
      false,
      true,
    );
  }

  for (const goal of geometry.goals) {
    const halfOpening = goal.opening.width / 2;
    const sideSpan = Math.max(anchors.halfWidth - halfOpening, 0.1);
    for (const xSign of [-1, 1] as const) {
      const x = goal.opening.centerX + xSign * (halfOpening + sideSpan / 2);
      const z = goal.goalLineZ + goal.zDirection * deckWidth / 2;
      addBox(
        root,
        unitBox,
        'graphite-end-service-deck',
        new THREE.Vector3(sideSpan, 0.08, deckWidth),
        new THREE.Vector3(x, 0.015, z),
        deckMaterial,
        false,
        true,
      );
      appendHexRect(x - sideSpan / 2, x + sideSpan / 2, z - deckWidth / 2, z + deckWidth / 2);
      addBox(
        root,
        unitBox,
        'lower-end-kickboard-fascia',
        new THREE.Vector3(sideSpan, 0.78, 0.12),
        new THREE.Vector3(x, 0.39, goal.goalLineZ + goal.zDirection * 0.07),
        kickboardMaterial,
        false,
        true,
      );
    }
  }

  const hexGeometry = resources.ownGeometry(new THREE.BufferGeometry());
  hexGeometry.setAttribute('position', new THREE.Float32BufferAttribute(hexPositions, 3));
  const hexMaterial = resources.ownMaterial(new THREE.LineBasicMaterial({
    color: 0x71818a,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
  }));
  const hexOverlay = new THREE.LineSegments(hexGeometry, hexMaterial);
  hexOverlay.name = 'batched-service-deck-hex-lines';
  hexOverlay.renderOrder = 3;
  root.add(hexOverlay);
}

function createFieldMarkings(
  root: THREE.Group,
  resources: ArenaPresentationResources,
  unitBox: THREE.BoxGeometry,
  anchors: StadiumPresentationAnchors,
): void {
  const markingY = VISUAL.STADIUM.FIELD.MARKING_HEIGHT * 2.2;
  const lineMaterial = resources.ownMaterial(new THREE.MeshBasicMaterial({
    color: ARENA_PRESENTATION_STYLE.turfLine,
    transparent: true,
    opacity: 0.94,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  }));
  addBox(
    root,
    unitBox,
    'center-line',
    new THREE.Vector3(anchors.halfWidth * 2 - 1.2, 0.014, 0.105),
    new THREE.Vector3(anchors.centerX, markingY, anchors.centerZ),
    lineMaterial,
  ).renderOrder = 3;

  const ring = new THREE.Mesh(
    resources.ownGeometry(new THREE.RingGeometry(
      VISUAL.STADIUM.FIELD.CENTER_RING_RADIUS - VISUAL.STADIUM.FIELD.CENTER_RING_THICKNESS,
      VISUAL.STADIUM.FIELD.CENTER_RING_RADIUS,
      72,
    )),
    lineMaterial,
  );
  ring.name = 'center-ring';
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(anchors.centerX, markingY + 0.003, anchors.centerZ);
  ring.renderOrder = 3;
  root.add(ring);

  const disc = new THREE.Mesh(resources.ownGeometry(new THREE.CircleGeometry(0.25, 24)), lineMaterial);
  disc.name = 'kickoff-center';
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(anchors.centerX, markingY + 0.005, anchors.centerZ);
  disc.renderOrder = 3;
  root.add(disc);

  const laneMaterial = resources.ownMaterial(new THREE.MeshBasicMaterial({
    color: ARENA_PRESENTATION_STYLE.turfLine,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
  }));
  for (const xSign of [-1, 1] as const) {
    const laneX = anchors.centerX + xSign * anchors.halfWidth * 0.48;
    addBox(
      root,
      unitBox,
      'field-lane-marking',
      new THREE.Vector3(0.04, 0.012, anchors.halfLength * 1.45),
      new THREE.Vector3(laneX, markingY, anchors.centerZ),
      laneMaterial,
    );
  }
}

function createGoalGrid(
  goal: ResolvedArenaGoalRegion,
  color: number,
  resources: ArenaPresentationResources,
): THREE.LineSegments {
  const positions: number[] = [];
  const halfWidth = goal.opening.width / 2;
  const minX = goal.opening.centerX - halfWidth;
  const maxX = goal.opening.centerX + halfWidth;
  const bottomY = goal.opening.bottomY + 0.05;
  const topY = goal.opening.bottomY + goal.opening.height - 0.05;
  const line = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
    positions.push(ax, ay, az, bx, by, bz);
  };
  for (let column = 0; column <= 10; column += 1) {
    const x = THREE.MathUtils.lerp(minX, maxX, column / 10);
    line(x, bottomY, goal.backWallZ, x, topY, goal.backWallZ);
    line(x, topY, goal.goalLineZ, x, topY, goal.backWallZ);
  }
  for (let row = 0; row <= 6; row += 1) {
    const y = THREE.MathUtils.lerp(bottomY, topY, row / 6);
    line(minX, y, goal.backWallZ, maxX, y, goal.backWallZ);
    line(minX, y, goal.goalLineZ, minX, y, goal.backWallZ);
    line(maxX, y, goal.goalLineZ, maxX, y, goal.backWallZ);
  }
  const gridGeometry = resources.ownGeometry(new THREE.BufferGeometry());
  gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const gridMaterial = resources.ownMaterial(new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
  }));
  const grid = new THREE.LineSegments(gridGeometry, gridMaterial);
  grid.name = goal.defendingTeam === 'blue' ? 'blue-goal-grid' : 'orange-goal-grid';
  return grid;
}

function createGoalPresentation(
  root: THREE.Group,
  goal: ResolvedArenaGoalRegion,
  resources: ArenaPresentationResources,
  unitBox: THREE.BoxGeometry,
): THREE.MeshStandardMaterial {
  const isBlue = goal.defendingTeam === 'blue';
  const prefix = isBlue ? 'blue' : 'orange';
  const teamColor = isBlue ? ARENA_PRESENTATION_STYLE.blueLight : ARENA_PRESENTATION_STYLE.orangeLight;
  const darkMetal = resources.ownMaterial(new THREE.MeshStandardMaterial({
    color: ARENA_PRESENTATION_STYLE.graphite,
    roughness: 0.28,
    metalness: 0.82,
  }));
  const tunnelFloor = resources.ownMaterial(new THREE.MeshStandardMaterial({
    color: 0x172128,
    roughness: 0.68,
    metalness: 0.38,
  }));
  const lightMaterial = resources.ownMaterial(new THREE.MeshStandardMaterial({
    name: `${prefix}-goal-animated-light-material`,
    color: teamColor,
    emissive: teamColor,
    emissiveIntensity: 2.8,
    roughness: 0.16,
    metalness: 0.36,
    toneMapped: false,
  }));
  lightMaterial.userData.animatedArenaLight = true;

  const halfWidth = goal.opening.width / 2;
  const centerX = goal.opening.centerX;
  const bottomY = goal.opening.bottomY;
  const topY = bottomY + goal.opening.height;
  const depth = Math.abs(goal.backWallZ - goal.goalLineZ);
  const centerZ = (goal.goalLineZ + goal.backWallZ) / 2;
  const frameThickness = 0.2;
  const frameDepth = 0.32;
  const fieldFaceZ = goal.goalLineZ - goal.zDirection * (frameDepth / 2 + 0.012);

  addBox(
    root,
    unitBox,
    `${prefix}-goal-dark-crossbar`,
    new THREE.Vector3(goal.opening.width + frameThickness * 2, frameThickness, frameDepth),
    new THREE.Vector3(centerX, topY + frameThickness / 2, goal.goalLineZ),
    darkMetal,
    true,
  );
  for (const xSign of [-1, 1] as const) {
    addBox(
      root,
      unitBox,
      `${prefix}-goal-dark-post`,
      new THREE.Vector3(frameThickness, goal.opening.height, frameDepth),
      new THREE.Vector3(centerX + xSign * (halfWidth + frameThickness / 2), bottomY + goal.opening.height / 2, goal.goalLineZ),
      darkMetal,
      true,
    );
    addBox(
      root,
      unitBox,
      `${prefix}-goal-post-light-strip`,
      new THREE.Vector3(0.045, goal.opening.height * 0.92, 0.045),
      new THREE.Vector3(centerX + xSign * (halfWidth + 0.012), bottomY + goal.opening.height / 2, fieldFaceZ),
      lightMaterial,
    );
  }
  addBox(
    root,
    unitBox,
    `${prefix}-goal-crossbar-light-strip`,
    new THREE.Vector3(goal.opening.width, 0.045, 0.045),
    new THREE.Vector3(centerX, topY + 0.012, fieldFaceZ),
    lightMaterial,
  );

  addBox(
    root,
    unitBox,
    `${prefix}-goal-dark-tunnel-floor`,
    new THREE.Vector3(goal.opening.width * 0.96, 0.025, Math.max(depth - 0.16, 0.1)),
    new THREE.Vector3(centerX, bottomY + 0.018, centerZ),
    tunnelFloor,
    false,
    true,
  );

  const ribCount = 6;
  const ribs = new THREE.InstancedMesh(unitBox, darkMetal, ribCount * 3);
  ribs.name = `${prefix}-goal-dark-tunnel-ribs`;
  let ribIndex = 0;
  for (let rib = 0; rib < ribCount; rib += 1) {
    const z = THREE.MathUtils.lerp(goal.goalLineZ, goal.backWallZ, (rib + 1) / ribCount);
    setInstance(ribs, ribIndex++, new THREE.Vector3(centerX - halfWidth - 0.06, bottomY + goal.opening.height / 2, z), new THREE.Vector3(0.1, goal.opening.height, 0.1));
    setInstance(ribs, ribIndex++, new THREE.Vector3(centerX + halfWidth + 0.06, bottomY + goal.opening.height / 2, z), new THREE.Vector3(0.1, goal.opening.height, 0.1));
    setInstance(ribs, ribIndex++, new THREE.Vector3(centerX, topY + 0.06, z), new THREE.Vector3(goal.opening.width + 0.12, 0.1, 0.1));
  }
  ribs.instanceMatrix.needsUpdate = true;
  root.add(ribs);

  const ceilingStripCount = 4;
  const ceilingStrips = new THREE.InstancedMesh(unitBox, lightMaterial, ceilingStripCount);
  ceilingStrips.name = `${prefix}-goal-tunnel-ceiling-light-strips`;
  for (let index = 0; index < ceilingStripCount; index += 1) {
    const z = THREE.MathUtils.lerp(goal.goalLineZ, goal.backWallZ, (index + 1) / (ceilingStripCount + 1));
    setInstance(
      ceilingStrips,
      index,
      new THREE.Vector3(centerX, topY - 0.035, z),
      new THREE.Vector3(goal.opening.width * 0.55, 0.035, 0.075),
    );
  }
  ceilingStrips.instanceMatrix.needsUpdate = true;
  root.add(ceilingStrips, createGoalGrid(goal, teamColor, resources));
  return lightMaterial;
}

function createEndChannels(
  root: THREE.Group,
  geometry: ResolvedArenaGeometry,
  resources: ArenaPresentationResources,
  unitBox: THREE.BoxGeometry,
  anchors: StadiumPresentationAnchors,
): void {
  for (const goal of geometry.goals) {
    const isBlue = goal.defendingTeam === 'blue';
    const color = isBlue ? ARENA_PRESENTATION_STYLE.blue : ARENA_PRESENTATION_STYLE.orange;
    const material = resources.ownMaterial(new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.55,
      roughness: 0.24,
      metalness: 0.48,
      toneMapped: false,
    }));
    const halfOpening = goal.opening.width / 2;
    const segmentWidth = Math.max(anchors.halfWidth - halfOpening, 0.1);
    for (const xSign of [-1, 1] as const) {
      addBox(
        root,
        unitBox,
        `${isBlue ? 'blue' : 'orange'}-end-edge-channel`,
        new THREE.Vector3(segmentWidth, 0.035, 0.12),
        new THREE.Vector3(
          goal.opening.centerX + xSign * (halfOpening + segmentWidth / 2),
          0.055,
          goal.goalLineZ - goal.zDirection * 0.045,
        ),
        material,
      );
    }
  }
}

export function createDaylightGameplayPresentation(
  root: THREE.Group,
  geometry: ResolvedArenaGeometry,
  boundaryGeometries: ReadonlyMap<string, THREE.BufferGeometry>,
  resources: ArenaPresentationResources,
  unitBox: THREE.BoxGeometry,
  anchors: StadiumPresentationAnchors,
): readonly THREE.MeshStandardMaterial[] {
  const turfMaterial = createTurfMaterial(resources, anchors);
  for (const primitive of geometry.primitives) {
    if (primitive.semanticKind !== 'floor' || primitive.region !== 'field') continue;
    const floorGeometry = boundaryGeometries.get(primitive.id);
    if (!floorGeometry) continue;
    const turf = new THREE.Mesh(floorGeometry, turfMaterial);
    turf.name = `procedural-pbr-turf:${primitive.id}`;
    turf.position.y = VISUAL.STADIUM.FIELD.MARKING_HEIGHT;
    turf.receiveShadow = true;
    turf.renderOrder = 1;
    root.add(turf);
  }
  createServiceDecks(root, geometry, resources, unitBox, anchors);
  createFieldMarkings(root, resources, unitBox, anchors);
  createCageOverlays(root, geometry, resources);
  createEndChannels(root, geometry, resources, unitBox, anchors);
  return geometry.goals.map((goal) => createGoalPresentation(root, goal, resources, unitBox));
}

interface ExteriorMaterials {
  readonly graphite: THREE.MeshStandardMaterial;
  readonly graphiteMid: THREE.MeshStandardMaterial;
  readonly concrete: THREE.MeshStandardMaterial;
  readonly crowd: THREE.MeshStandardMaterial;
  readonly light: THREE.MeshStandardMaterial;
  readonly glass: THREE.MeshPhysicalMaterial;
  readonly windows: THREE.MeshStandardMaterial;
}

function createExteriorMaterials(resources: ArenaPresentationResources): ExteriorMaterials {
  return {
    graphite: resources.ownMaterial(new THREE.MeshStandardMaterial({ color: ARENA_PRESENTATION_STYLE.graphite, roughness: 0.36, metalness: 0.78 })),
    graphiteMid: resources.ownMaterial(new THREE.MeshStandardMaterial({ color: ARENA_PRESENTATION_STYLE.graphiteMid, roughness: 0.48, metalness: 0.62 })),
    concrete: resources.ownMaterial(new THREE.MeshStandardMaterial({ color: ARENA_PRESENTATION_STYLE.concrete, roughness: 0.82, metalness: 0.08 })),
    crowd: resources.ownMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.08, vertexColors: true })),
    light: resources.ownMaterial(new THREE.MeshStandardMaterial({
      color: ARENA_PRESENTATION_STYLE.floodlight,
      emissive: ARENA_PRESENTATION_STYLE.floodlight,
      emissiveIntensity: 2.1,
      roughness: 0.14,
      metalness: 0.22,
      toneMapped: false,
    })),
    glass: resources.ownMaterial(new THREE.MeshPhysicalMaterial({
      color: ARENA_PRESENTATION_STYLE.skylineGlass,
      roughness: 0.16,
      metalness: 0.46,
      transparent: true,
      opacity: 0.86,
      vertexColors: true,
    })),
    windows: resources.ownMaterial(new THREE.MeshStandardMaterial({
      color: ARENA_PRESENTATION_STYLE.windowLight,
      emissive: ARENA_PRESENTATION_STYLE.windowLight,
      emissiveIntensity: 0.42,
      roughness: 0.2,
      metalness: 0.18,
      toneMapped: false,
    })),
  };
}

function crowdColor(index: number, z: number): THREE.Color {
  const palette = [0x176fd1, 0x35a7d8, 0xf17735, 0xf1c25b, 0xdce7ea, 0x2f4758] as const;
  const color = new THREE.Color(palette[(index * 7 + Math.abs(Math.round(z * 3))) % palette.length]);
  color.offsetHSL(0, -0.04, ((index % 5) - 2) * 0.018);
  return color;
}

function createDenseBowl(
  root: THREE.Group,
  anchors: StadiumPresentationAnchors,
  unitBox: THREE.BoxGeometry,
  materials: ExteriorMaterials,
): void {
  const rowCount = VISUAL.STADIUM.STANDS.TIER_COUNT * VISUAL.STADIUM.STANDS.ROWS_PER_TIER;
  const seatCount = 2 * rowCount * VISUAL.STADIUM.STANDS.SEATS_PER_SIDE
    + 2 * rowCount * VISUAL.STADIUM.STANDS.SEATS_PER_END;
  const seats = new THREE.InstancedMesh(unitBox, materials.crowd, seatCount);
  seats.name = 'instanced-spectator-seats';
  const risers = new THREE.InstancedMesh(unitBox, materials.concrete, rowCount * 4);
  risers.name = 'instanced-stand-risers';
  const sideOffset = 1.15;
  const endOffset = 1.4;
  const rowDepth = 0.74;
  const rowRise = 0.7;
  let seatIndex = 0;
  let riserIndex = 0;

  for (const xSign of [-1, 1] as const) {
    for (let row = 0; row < rowCount; row += 1) {
      const tier = Math.floor(row / VISUAL.STADIUM.STANDS.ROWS_PER_TIER);
      const x = anchors.centerX + xSign * (anchors.halfWidth + sideOffset + row * rowDepth);
      const y = 0.95 + row * rowRise + tier * 0.72;
      setInstance(risers, riserIndex++, new THREE.Vector3(x, y - 0.32, anchors.centerZ), new THREE.Vector3(rowDepth, 0.32, anchors.halfLength * 2 + 4.4));
      for (let seat = 0; seat < VISUAL.STADIUM.STANDS.SEATS_PER_SIDE; seat += 1) {
        const z = THREE.MathUtils.lerp(anchors.centerZ - anchors.halfLength - 1.2, anchors.centerZ + anchors.halfLength + 1.2, seat / (VISUAL.STADIUM.STANDS.SEATS_PER_SIDE - 1));
        const portalGap = tier > 0 && row % VISUAL.STADIUM.STANDS.ROWS_PER_TIER < 2 && seat % 11 < 2;
        const scale = portalGap ? new THREE.Vector3(0.001, 0.001, 0.001) : new THREE.Vector3(0.48, 0.32, 0.24);
        setInstance(seats, seatIndex, new THREE.Vector3(x - xSign * 0.04, y, z), scale);
        seats.setColorAt(seatIndex, crowdColor(seatIndex, z));
        seatIndex += 1;
      }
    }
  }

  for (const zSign of [-1, 1] as const) {
    for (let row = 0; row < rowCount; row += 1) {
      const tier = Math.floor(row / VISUAL.STADIUM.STANDS.ROWS_PER_TIER);
      const z = anchors.centerZ + zSign * (anchors.goalBackDistance + endOffset + row * rowDepth);
      const y = 0.95 + row * rowRise + tier * 0.72;
      setInstance(risers, riserIndex++, new THREE.Vector3(anchors.centerX, y - 0.32, z), new THREE.Vector3(anchors.halfWidth * 2 + 3.2, 0.32, rowDepth));
      for (let seat = 0; seat < VISUAL.STADIUM.STANDS.SEATS_PER_END; seat += 1) {
        const x = THREE.MathUtils.lerp(anchors.centerX - anchors.halfWidth - 1.1, anchors.centerX + anchors.halfWidth + 1.1, seat / (VISUAL.STADIUM.STANDS.SEATS_PER_END - 1));
        const portalGap = tier > 0 && row % VISUAL.STADIUM.STANDS.ROWS_PER_TIER < 2 && seat % 8 < 2;
        const scale = portalGap ? new THREE.Vector3(0.001, 0.001, 0.001) : new THREE.Vector3(0.48, 0.32, 0.24);
        setInstance(seats, seatIndex, new THREE.Vector3(x, y, z - zSign * 0.04), scale);
        seats.setColorAt(seatIndex, crowdColor(seatIndex, z));
        seatIndex += 1;
      }
    }
  }
  seats.instanceMatrix.needsUpdate = true;
  if (seats.instanceColor) seats.instanceColor.needsUpdate = true;
  risers.instanceMatrix.needsUpdate = true;
  risers.receiveShadow = true;
  root.add(risers, seats);

  const fasciaCount = VISUAL.STADIUM.STANDS.TIER_COUNT * 4;
  const fascia = new THREE.InstancedMesh(unitBox, materials.concrete, fasciaCount);
  fascia.name = 'instanced-tier-fascia';
  let fasciaIndex = 0;
  for (let tier = 0; tier < VISUAL.STADIUM.STANDS.TIER_COUNT; tier += 1) {
    const row = (tier + 1) * VISUAL.STADIUM.STANDS.ROWS_PER_TIER - 1;
    const y = 1.18 + row * rowRise + tier * 0.72;
    const sideDistance = anchors.halfWidth + sideOffset + row * rowDepth + rowDepth / 2;
    const endDistance = anchors.goalBackDistance + endOffset + row * rowDepth + rowDepth / 2;
    for (const xSign of [-1, 1] as const) setInstance(fascia, fasciaIndex++, new THREE.Vector3(anchors.centerX + xSign * sideDistance, y, anchors.centerZ), new THREE.Vector3(0.34, 0.46, anchors.halfLength * 2 + 5));
    for (const zSign of [-1, 1] as const) setInstance(fascia, fasciaIndex++, new THREE.Vector3(anchors.centerX, y, anchors.centerZ + zSign * endDistance), new THREE.Vector3(anchors.halfWidth * 2 + 4, 0.46, 0.34));
  }
  fascia.instanceMatrix.needsUpdate = true;
  root.add(fascia);

  const portalCount = 16;
  const portals = new THREE.InstancedMesh(unitBox, materials.graphite, portalCount);
  portals.name = 'instanced-concourse-portals';
  for (let index = 0; index < portalCount; index += 1) {
    const side = index % 4;
    const lane = Math.floor(index / 4);
    const y = 4.4 + (lane % 2) * 3.25;
    if (side < 2) {
      setInstance(portals, index, new THREE.Vector3(anchors.centerX + (side === 0 ? -1 : 1) * (anchors.halfWidth + 4.5 + lane * 0.45), y, THREE.MathUtils.lerp(-anchors.halfLength * 0.72, anchors.halfLength * 0.72, lane / 3)), new THREE.Vector3(0.3, 1.65, 1.7));
    } else {
      setInstance(portals, index, new THREE.Vector3(THREE.MathUtils.lerp(-anchors.halfWidth * 0.7, anchors.halfWidth * 0.7, lane / 3), y, anchors.centerZ + (side === 2 ? -1 : 1) * (anchors.goalBackDistance + 4.7 + lane * 0.45)), new THREE.Vector3(1.7, 1.65, 0.3));
    }
  }
  portals.instanceMatrix.needsUpdate = true;
  root.add(portals);
}

function ringPoints(anchors: StadiumPresentationAnchors, geometry: ResolvedArenaGeometry, padding: number): THREE.Vector3[] {
  const retreat = Math.max(...geometry.cornerCuts.map(({ axisRetreat }) => axisRetreat), 2.5) + padding * 0.35;
  const x = anchors.halfWidth + padding;
  const z = anchors.halfLength + padding;
  return [
    new THREE.Vector3(x, 0, -z + retreat),
    new THREE.Vector3(x, 0, z - retreat),
    new THREE.Vector3(x - retreat, 0, z),
    new THREE.Vector3(-x + retreat, 0, z),
    new THREE.Vector3(-x, 0, z - retreat),
    new THREE.Vector3(-x, 0, -z + retreat),
    new THREE.Vector3(-x + retreat, 0, -z),
    new THREE.Vector3(x - retreat, 0, -z),
  ];
}

function createRoofEngineering(
  root: THREE.Group,
  geometry: ResolvedArenaGeometry,
  anchors: StadiumPresentationAnchors,
  resources: ArenaPresentationResources,
  unitBox: THREE.BoxGeometry,
  materials: ExteriorMaterials,
): void {
  const points = ringPoints(anchors, geometry, 2.2);
  const ringY = anchors.ceilingY + 0.7;
  points.forEach((point) => { point.x += anchors.centerX; point.y = ringY; point.z += anchors.centerZ; });
  const compressionRing = new THREE.InstancedMesh(unitBox, materials.graphite, points.length);
  compressionRing.name = 'instanced-compression-ring';
  for (let index = 0; index < points.length; index += 1) {
    setBeamInstance(compressionRing, index, points[index]!, points[(index + 1) % points.length]!, 0.34);
  }
  compressionRing.instanceMatrix.needsUpdate = true;
  root.add(compressionRing);

  const archGeometry = resources.ownGeometry(new THREE.TorusGeometry(
    anchors.halfWidth + 4.8,
    0.19,
    7,
    56,
    Math.PI,
  ));
  const arches = new THREE.InstancedMesh(archGeometry, materials.graphiteMid, VISUAL.STADIUM.STRUCTURE.ARCH_COUNT);
  arches.name = 'instanced-stadium-arches';
  for (let index = 0; index < VISUAL.STADIUM.STRUCTURE.ARCH_COUNT; index += 1) {
    const z = THREE.MathUtils.lerp(anchors.centerZ - anchors.halfLength - 1.4, anchors.centerZ + anchors.halfLength + 1.4, index / (VISUAL.STADIUM.STRUCTURE.ARCH_COUNT - 1));
    setInstance(arches, index, new THREE.Vector3(anchors.centerX, ringY, z), new THREE.Vector3(1, 1, 1));
  }
  arches.instanceMatrix.needsUpdate = true;
  root.add(arches);

  const drops = new THREE.InstancedMesh(unitBox, materials.graphiteMid, points.length);
  drops.name = 'instanced-roof-vertical-drops';
  points.forEach((point, index) => setInstance(drops, index, new THREE.Vector3(point.x, (ringY + 7.2) / 2, point.z), new THREE.Vector3(0.18, Math.max(ringY - 7.2, 0.5), 0.18)));
  drops.instanceMatrix.needsUpdate = true;
  root.add(drops);

  const braces = new THREE.InstancedMesh(unitBox, materials.graphiteMid, points.length * 2);
  braces.name = 'instanced-roof-cross-bracing';
  let braceIndex = 0;
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]!;
    const second = points[(index + 1) % points.length]!;
    const lowerFirst = first.clone().setY(ringY - 2.3);
    const lowerSecond = second.clone().setY(ringY - 2.3);
    setBeamInstance(braces, braceIndex++, first, lowerSecond, 0.12);
    setBeamInstance(braces, braceIndex++, lowerFirst, second, 0.12);
  }
  braces.instanceMatrix.needsUpdate = true;
  root.add(braces);

  const ribbons = new THREE.InstancedMesh(unitBox, materials.light, points.length);
  ribbons.name = 'instanced-ribbon-floodlights';
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]!.clone().setY(ringY - 0.3);
    const second = points[(index + 1) % points.length]!.clone().setY(ringY - 0.3);
    setBeamInstance(ribbons, index, first, second, 0.075);
  }
  ribbons.instanceMatrix.needsUpdate = true;
  root.add(ribbons);
}

function createFloodlightBanks(
  root: THREE.Group,
  anchors: StadiumPresentationAnchors,
  unitBox: THREE.BoxGeometry,
  materials: ExteriorMaterials,
): void {
  const positions: THREE.Vector3[] = [];
  for (const xSign of [-1, 1] as const) {
    for (let bank = 0; bank < VISUAL.STADIUM.LIGHTS.BANKS_PER_SIDE; bank += 1) {
      positions.push(new THREE.Vector3(
        anchors.centerX + xSign * (anchors.halfWidth + 1.3),
        anchors.ceilingY - 1.15,
        THREE.MathUtils.lerp(anchors.centerZ - anchors.halfLength * 0.58, anchors.centerZ + anchors.halfLength * 0.58, bank / (VISUAL.STADIUM.LIGHTS.BANKS_PER_SIDE - 1)),
      ));
    }
  }
  const housings = new THREE.InstancedMesh(unitBox, materials.graphite, positions.length);
  housings.name = 'floodlight-bank-housings';
  positions.forEach((position, index) => setInstance(housings, index, position, new THREE.Vector3(0.2, 1.0, 3.5)));
  housings.instanceMatrix.needsUpdate = true;

  const lampCount = positions.length * VISUAL.STADIUM.LIGHTS.LAMPS_PER_BANK;
  const lamps = new THREE.InstancedMesh(unitBox, materials.light, lampCount);
  lamps.name = 'instanced-floodlight-lamps';
  let lampIndex = 0;
  for (const position of positions) {
    const inward = -Math.sign(position.x - anchors.centerX);
    for (let lamp = 0; lamp < VISUAL.STADIUM.LIGHTS.LAMPS_PER_BANK; lamp += 1) {
      setInstance(lamps, lampIndex++, new THREE.Vector3(position.x + inward * 0.13, position.y, position.z + THREE.MathUtils.lerp(-1.35, 1.35, lamp / (VISUAL.STADIUM.LIGHTS.LAMPS_PER_BANK - 1))), new THREE.Vector3(0.08, 0.55, 0.34));
    }
  }
  lamps.instanceMatrix.needsUpdate = true;
  root.add(housings, lamps);
}

function createWayfindingFins(
  root: THREE.Group,
  anchors: StadiumPresentationAnchors,
  resources: ArenaPresentationResources,
): THREE.InstancedMesh {
  const count = 10;
  const geometry = resources.ownGeometry(new THREE.PlaneGeometry(1.35, 0.54));
  const material = resources.ownMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.16, side: THREE.DoubleSide, vertexColors: true }));
  const fins = new THREE.InstancedMesh(geometry, material, count);
  fins.name = 'instanced-rocket-arena-flags';
  for (let index = 0; index < count; index += 1) {
    const xSign = index < count / 2 ? -1 : 1;
    const lane = index % (count / 2);
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, xSign < 0 ? Math.PI / 2 : -Math.PI / 2, 0));
    setInstance(fins, index, new THREE.Vector3(anchors.centerX + xSign * (anchors.halfWidth + 5.1), anchors.ceilingY + 1.4 + (lane % 2) * 0.25, THREE.MathUtils.lerp(anchors.centerZ - anchors.halfLength * 0.7, anchors.centerZ + anchors.halfLength * 0.7, lane / 4)), new THREE.Vector3(1, 1, 1), quaternion);
    fins.setColorAt(index, new THREE.Color(index % 2 === 0 ? ARENA_PRESENTATION_STYLE.blue : ARENA_PRESENTATION_STYLE.orange));
  }
  fins.instanceMatrix.needsUpdate = true;
  if (fins.instanceColor) fins.instanceColor.needsUpdate = true;
  root.add(fins);
  return fins;
}

function createScoreboards(
  root: THREE.Group,
  anchors: StadiumPresentationAnchors,
  unitBox: THREE.BoxGeometry,
  materials: ExteriorMaterials,
  resources: ArenaPresentationResources,
): void {
  for (const zSign of [-1, 1] as const) {
    const group = new THREE.Group();
    group.name = `${zSign < 0 ? 'blue' : 'orange'}-rocket-arena-scoreboard`;
    const color = zSign < 0 ? ARENA_PRESENTATION_STYLE.blue : ARENA_PRESENTATION_STYLE.orange;
    const display = resources.ownMaterial(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.15, roughness: 0.24, metalness: 0.32, toneMapped: false }));
    addBox(group, unitBox, 'scoreboard-graphite-shell', new THREE.Vector3(7.8, 2.25, 0.34), new THREE.Vector3(), materials.graphite, true);
    addBox(group, unitBox, 'scoreboard-team-display', new THREE.Vector3(6.9, 1.45, 0.06), new THREE.Vector3(0, 0, 0.2), display);
    addBox(group, unitBox, 'scoreboard-light-rule', new THREE.Vector3(6.9, 0.06, 0.07), new THREE.Vector3(0, -0.88, 0.21), materials.light);
    group.position.set(anchors.centerX, Math.min(anchors.ceilingY - 1.5, 13.8), anchors.centerZ + zSign * (anchors.goalBackDistance + 5.2));
    if (zSign > 0) group.rotation.y = Math.PI;
    root.add(group);
  }
}

function createSkyline(
  root: THREE.Group,
  anchors: StadiumPresentationAnchors,
  unitBox: THREE.BoxGeometry,
  materials: ExteriorMaterials,
): void {
  const towerCount = 48;
  const towers = new THREE.InstancedMesh(unitBox, materials.glass, towerCount);
  towers.name = 'instanced-city-skyline';
  const bandCount = towerCount * 4;
  const bands = new THREE.InstancedMesh(unitBox, materials.windows, bandCount);
  bands.name = 'instanced-skyline-window-bands';
  const rooftops = new THREE.InstancedMesh(unitBox, materials.graphite, towerCount);
  rooftops.name = 'instanced-skyline-rooftops';
  let bandIndex = 0;
  for (let index = 0; index < towerCount; index += 1) {
    const side = index % 4;
    const lane = Math.floor(index / 4);
    const span = lane / Math.max(Math.floor(towerCount / 4) - 1, 1);
    const family = index % 4;
    const height = 8.5 + ((index * 11) % 9) * 1.18 + family * 0.7;
    const width = 2.1 + family * 0.48;
    const depth = 2.3 + ((family + 2) % 4) * 0.42;
    let x: number;
    let z: number;
    if (side < 2) {
      x = anchors.centerX + (side === 0 ? -1 : 1) * (anchors.halfWidth + 14 + (lane % 3) * 2.1);
      z = THREE.MathUtils.lerp(anchors.centerZ - anchors.halfLength - 10, anchors.centerZ + anchors.halfLength + 10, span);
    } else {
      x = THREE.MathUtils.lerp(anchors.centerX - anchors.halfWidth - 10, anchors.centerX + anchors.halfWidth + 10, span);
      z = anchors.centerZ + (side === 2 ? -1 : 1) * (anchors.goalBackDistance + 13 + (lane % 3) * 2.1);
    }
    setInstance(towers, index, new THREE.Vector3(x, height / 2, z), new THREE.Vector3(width, height, depth));
    towers.setColorAt(index, new THREE.Color(family % 2 === 0 ? 0x397fa4 : 0x245e82).offsetHSL((index % 3) * 0.008, 0, ((index % 5) - 2) * 0.022));
    const roofHeight = family === 0 ? 0.7 : family === 1 ? 1.35 : 0.42;
    setInstance(rooftops, index, new THREE.Vector3(x, height + roofHeight / 2, z), new THREE.Vector3(family === 1 ? 0.2 : width * 0.58, roofHeight, family === 1 ? 0.2 : depth * 0.58));
    for (let band = 0; band < 4; band += 1) {
      const bandY = THREE.MathUtils.lerp(height * 0.24, height * 0.84, band / 3);
      if (side < 2) {
        const faceX = x - Math.sign(x - anchors.centerX) * (width / 2 + 0.025);
        setInstance(bands, bandIndex++, new THREE.Vector3(faceX, bandY, z), new THREE.Vector3(0.045, 0.13, depth * 0.78));
      } else {
        const faceZ = z - Math.sign(z - anchors.centerZ) * (depth / 2 + 0.025);
        setInstance(bands, bandIndex++, new THREE.Vector3(x, bandY, faceZ), new THREE.Vector3(width * 0.78, 0.13, 0.045));
      }
    }
  }
  towers.instanceMatrix.needsUpdate = true;
  if (towers.instanceColor) towers.instanceColor.needsUpdate = true;
  bands.instanceMatrix.needsUpdate = true;
  rooftops.instanceMatrix.needsUpdate = true;
  root.add(towers, bands, rooftops);
}

function createDaylightSky(root: THREE.Group, resources: ArenaPresentationResources): void {
  const geometry = resources.ownGeometry(new THREE.SphereGeometry(170, 32, 18));
  const material = resources.ownMaterial(new THREE.ShaderMaterial({
    name: 'procedural-daylight-gradient-sky-material',
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      zenithColor: { value: new THREE.Color(DAYLIGHT_SCENE_STYLE.skyZenith) },
      horizonColor: { value: new THREE.Color(DAYLIGHT_SCENE_STYLE.horizon) },
    },
    vertexShader: `
      varying float vHeight;
      void main() {
        vHeight = normalize(position).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 zenithColor;
      uniform vec3 horizonColor;
      varying float vHeight;
      void main() {
        float gradient = smoothstep(-0.12, 0.82, vHeight);
        gl_FragColor = vec4(mix(horizonColor, zenithColor, gradient), 1.0);
      }
    `,
  }));
  const sky = new THREE.Mesh(geometry, material);
  sky.name = 'procedural-daylight-gradient-sky';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  root.add(sky);
}

function createAtmosphere(
  root: THREE.Group,
  anchors: StadiumPresentationAnchors,
  resources: ArenaPresentationResources,
): THREE.Points {
  const count = 96;
  const positions = new Float32Array(count * 3);
  let seed = 0x524f434b;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = anchors.centerX + (random() - 0.5) * (anchors.halfWidth * 2 + 28);
    positions[index * 3 + 1] = 7 + random() * Math.max(anchors.ceilingY - 4, 4);
    positions[index * 3 + 2] = anchors.centerZ + (random() - 0.5) * (anchors.goalBackDistance * 2 + 26);
  }
  const geometry = resources.ownGeometry(new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = resources.ownMaterial(new THREE.PointsMaterial({ color: 0xffffff, size: 0.055, transparent: true, opacity: 0.18, depthWrite: false, sizeAttenuation: true }));
  const atmosphere = new THREE.Points(geometry, material);
  atmosphere.name = 'stadium-atmosphere';
  root.add(atmosphere);
  return atmosphere;
}

export function createDaylightExteriorPresentation(
  root: THREE.Group,
  geometry: ResolvedArenaGeometry,
  resources: ArenaPresentationResources,
  unitBox: THREE.BoxGeometry,
  anchors: StadiumPresentationAnchors,
): DaylightExteriorAnimation {
  const materials = createExteriorMaterials(resources);
  createDaylightSky(root, resources);
  createSkyline(root, anchors, unitBox, materials);
  createDenseBowl(root, anchors, unitBox, materials);
  createRoofEngineering(root, geometry, anchors, resources, unitBox, materials);
  createFloodlightBanks(root, anchors, unitBox, materials);
  createScoreboards(root, anchors, unitBox, materials, resources);
  const flags = createWayfindingFins(root, anchors, resources);
  const atmosphere = createAtmosphere(root, anchors, resources);
  root.userData = Object.freeze({ presentationOnly: true });
  return Object.freeze({ atmosphere, flags });
}
