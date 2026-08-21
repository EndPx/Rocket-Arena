import * as THREE from 'three';
import {
  VISUAL,
  type ArenaBoundaryMaterialRole,
  type ArenaVector3Tuple,
  type ResolvedArenaBoundaryPrimitive,
  type ResolvedArenaGeometry,
  type ResolvedArenaGoalRegion,
} from '@rocket-arena/shared';
import {
  createDaylightExteriorPresentation,
  createDaylightGameplayPresentation,
  type ArenaPresentationResources,
} from './arena-presentation.js';

export interface ArenaPadDescriptor {
  readonly id: string;
  readonly kind: 'large' | 'small';
  readonly position: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number, number];
}

export interface ArenaBoundaryMeshMetadata {
  readonly primitiveId: string;
  readonly surfaceId: string;
  readonly seamIds: readonly string[];
  readonly semanticKind: ResolvedArenaBoundaryPrimitive['semanticKind'];
  readonly region: ResolvedArenaBoundaryPrimitive['region'];
  readonly materialRole: ArenaBoundaryMaterialRole;
  readonly geometryIdentity: Readonly<{
    readonly sourceVersion: number;
    readonly primitiveSchemaVersion: number;
    readonly fingerprint: string;
  }>;
}

export interface ArenaOwnership {
  readonly geometry: ResolvedArenaGeometry;
  readonly authoritativeBoundaries: THREE.Group;
  readonly gameplayOverlays: THREE.Group;
  readonly exteriorPresentation: THREE.Group;
  readonly padDescriptors: readonly ArenaPadDescriptor[];
  readonly disposed: boolean;
  getObjectByName(name: string): THREE.Object3D | undefined;
  update(deltaSeconds: number, elapsedSeconds: number): void;
  dispose(): void;
}

interface ResourceOwnership extends ArenaPresentationResources {}

interface StadiumAnchors {
  readonly centerX: number;
  readonly centerZ: number;
  readonly halfWidth: number;
  readonly halfLength: number;
  readonly ceilingY: number;
  readonly goalBackDistance: number;
}

interface StandInstance {
  readonly position: THREE.Vector3;
  readonly scale: THREE.Vector3;
  readonly color: THREE.Color;
}

const PIXEL_GLYPHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
});

const IDENTITY_QUATERNION = new THREE.Quaternion();
const INSTANCE_MATRIX = new THREE.Matrix4();

function createResourceOwnership(): ResourceOwnership {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  return {
    geometries,
    materials,
    textures,
    ownGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
      geometries.add(geometry);
      return geometry;
    },
    ownMaterial<T extends THREE.Material>(material: T): T {
      materials.add(material);
      return material;
    },
    ownTexture<T extends THREE.Texture>(texture: T): T {
      textures.add(texture);
      return texture;
    },
  };
}

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

function geometryFromInwardSurface(
  primitive: ResolvedArenaBoundaryPrimitive,
  resources: ResourceOwnership,
): THREE.BufferGeometry {
  const surface = primitive.inwardSurface;
  const positions = new Float32Array(surface.positions.length * 3);
  const normals = new Float32Array(surface.normals.length * 3);
  const uvs = new Float32Array(surface.uvs.length * 2);

  for (let index = 0; index < surface.positions.length; index += 1) {
    const position = surface.positions[index]!;
    const normal = surface.normals[index]!;
    const uv = surface.uvs[index]!;
    positions[index * 3] = position[0];
    positions[index * 3 + 1] = position[1];
    positions[index * 3 + 2] = position[2];
    normals[index * 3] = normal[0];
    normals[index * 3 + 1] = normal[1];
    normals[index * 3 + 2] = normal[2];
    uvs[index * 2] = uv[0];
    uvs[index * 2 + 1] = uv[1];
  }

  const IndexArray = surface.positions.length > 65_535 ? Uint32Array : Uint16Array;
  const geometry = resources.ownGeometry(new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(new IndexArray(surface.indices), 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Emit a GLSL float literal, so a baked constant always parses as source. */
function glslFloat(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(5);
}

/**
 * Emit a palette entry as a GLSL constructor.
 *
 * `THREE.Color` already converts a hex literal out of sRGB into the renderer's
 * working space, which is the same space `diffuseColor` is in, so these channels
 * can be written straight into the fragment without a second conversion.
 */
function glslColor(hex: number): string {
  const color = new THREE.Color(hex);
  return `vec3(${glslFloat(color.r)}, ${glslFloat(color.g)}, ${glslFloat(color.b)})`;
}

/**
 * Inject a world-space pattern into a lit standard material.
 *
 * Replacing the material with a `ShaderMaterial` would have been less code, but
 * it would also have dropped the surface out of the stadium lighting and left it
 * reading as a flat sheet. Patching the standard shader keeps the lighting and
 * only replaces the albedo.
 *
 * Arena dimensions are baked into the source as literals rather than passed as
 * uniforms: they are fixed for the life of the material, and a literal cannot be
 * left stale by a missed update.
 */
function withWorldPattern<T extends THREE.MeshStandardMaterial>(
  material: T,
  patternSource: string,
): T {
  material.onBeforeCompile = (shader): void => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vArenaWorld;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vArenaWorld = (modelMatrix * vec4(position, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vArenaWorld;')
      .replace('#include <color_fragment>', `#include <color_fragment>\n${patternSource}`);
  };
  // Two materials with identical source may still be patched differently, so the
  // key has to change with the source rather than with the material type.
  material.customProgramCacheKey = (): string => patternSource;
  return material;
}

/**
 * The containment wall.
 *
 * It was a 20%-opacity pane with `depthWrite` disabled, which meant it never
 * occluded anything at all: the crowd, the skyline, and the sky read straight
 * through it, and a car driving up the wall had no visible surface underneath it
 * to judge position or height against. That is the defect this fixes.
 *
 * Opaque now, and patterned so both of the things a driver needs are legible
 * while on it: height, through evenly spaced rows plus a bright kick plate at the
 * bottom and a cool cap at the top, and position along the wall, through vertical
 * panel seams. Team identity strengthens toward each goal end and washes out at
 * midfield, the way the reference arena reads from above.
 */
function createContainmentMaterial(
  resources: ResourceOwnership,
  anchors: StadiumAnchors,
  rampRise: number,
  wallTopY: number,
): THREE.MeshStandardMaterial {
  const seamSpacing = Math.max((anchors.halfLength * 2) / 24, 1);
  const pattern = `
  {
    vec3 wp = vArenaWorld;
    float h = clamp(
      (wp.y - ${glslFloat(rampRise)}) / max(${glslFloat(wallTopY - rampRise)}, 0.001),
      0.0,
      1.0
    );

    // Whichever axis runs along this stretch of wall, so seams stay vertical and
    // evenly spaced on the sides, the ends, and the corner cuts alike.
    float along = abs(wp.x) * ${glslFloat(anchors.halfLength)}
      >= abs(wp.z) * ${glslFloat(anchors.halfWidth)} ? wp.z : wp.x;

    float seamPhase = fract(along / ${glslFloat(seamSpacing)});
    float seam = 1.0 - smoothstep(0.0, 0.045, min(seamPhase, 1.0 - seamPhase));

    float rowPhase = fract(h * 3.0);
    float row = 1.0 - smoothstep(0.0, 0.05, min(rowPhase, 1.0 - rowPhase));

    float teamWeight = smoothstep(0.18, 0.95, abs(wp.z) / ${glslFloat(anchors.halfLength)});
    // Two strengths of the same identity. The deep tint stains the panels without
    // lifting them off the dark base an arena wall needs; the bright one carries
    // the stripe, because a dark tint mixed into a dark panel reads as no tint.
    vec3 teamDeep = wp.z < 0.0
      ? ${glslColor(VISUAL.PALETTE.FIELD_BLUE)}
      : ${glslColor(VISUAL.PALETTE.FIELD_ORANGE)};
    vec3 teamBright = wp.z < 0.0
      ? ${glslColor(VISUAL.PALETTE.BLUE)}
      : ${glslColor(VISUAL.PALETTE.ORANGE)};

    vec3 panel = mix(
      ${glslColor(VISUAL.PALETTE.STRUCTURE_DARK)},
      ${glslColor(VISUAL.PALETTE.STRUCTURE_MID)},
      0.34 + 0.40 * h
    );
    panel = mix(panel, teamDeep, teamWeight * 0.55);
    panel = mix(panel, panel * 0.42, seam * 0.85);
    panel = mix(panel, panel * 0.70, row * 0.40);

    // One continuous team stripe at a fixed height around the whole arena. This
    // is the strongest identity cue on the wall and the easiest thing to read
    // while sideways on it, so it brightens toward the end it belongs to but is
    // never absent at midfield.
    float stripe = 1.0 - smoothstep(0.0, 0.06, abs(h - 0.30));
    panel = mix(panel, teamBright, stripe * 0.58 * (0.38 + 0.62 * teamWeight));

    float kick = 1.0 - smoothstep(0.0, 0.055, h);
    float cap = smoothstep(0.88, 1.0, h);
    panel = mix(
      panel,
      mix(${glslColor(VISUAL.PALETTE.FIELD_LINE)}, teamBright, teamWeight * 0.55),
      kick * 0.74
    );
    panel = mix(panel, ${glslColor(VISUAL.PALETTE.STRUCTURE_LIGHT)}, cap * 0.34);

    diffuseColor.rgb = panel * mix(0.92, 1.14, h);
  }`;

  return resources.ownMaterial(withWorldPattern(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.42,
      metalness: 0.22,
      side: THREE.FrontSide,
    }),
    pattern,
  ));
}

/**
 * The floor-to-wall ramp band.
 *
 * A driver has to know where the floor stops being flat, because that is where a
 * car starts climbing whether or not it meant to. The band carries the team tint
 * of the half it is in and a bright line along its top edge, so the start of the
 * curve is something you can see rather than something you discover.
 */
function createLowerTransitionMaterial(
  resources: ResourceOwnership,
  anchors: StadiumAnchors,
  rampRise: number,
): THREE.MeshStandardMaterial {
  const pattern = `
  {
    vec3 wp = vArenaWorld;
    float t = clamp(wp.y / max(${glslFloat(rampRise)}, 0.001), 0.0, 1.0);
    float teamWeight = smoothstep(0.18, 0.95, abs(wp.z) / ${glslFloat(anchors.halfLength)});
    vec3 team = wp.z < 0.0
      ? ${glslColor(VISUAL.PALETTE.FIELD_BLUE)}
      : ${glslColor(VISUAL.PALETTE.FIELD_ORANGE)};

    vec3 c = mix(
      ${glslColor(VISUAL.PALETTE.STRUCTURE_DARK)},
      ${glslColor(VISUAL.PALETTE.STRUCTURE_MID)},
      0.25 + 0.40 * t
    );
    c = mix(c, team, teamWeight * 0.45 + 0.12);
    c = mix(c, ${glslColor(VISUAL.PALETTE.FIELD_LINE)}, smoothstep(0.86, 1.0, t) * 0.50);
    diffuseColor.rgb = c;
  }`;

  return resources.ownMaterial(withWorldPattern(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.58,
      metalness: 0.30,
      side: THREE.FrontSide,
    }),
    pattern,
  ));
}

function createBoundaryMaterials(
  resources: ResourceOwnership,
  resolvedGeometry: ResolvedArenaGeometry,
  anchors: StadiumAnchors,
): Readonly<Record<ArenaBoundaryMaterialRole, THREE.Material>> {
  // Both risers come from the resolved geometry rather than from a local copy of
  // the numbers, so the paint cannot describe a curve the collider does not have.
  const rampRise = resolvedGeometry.profiles.floorWall.rise;
  const wallTopY = anchors.ceilingY - resolvedGeometry.profiles.wallCeiling.rise;

  return Object.freeze({
    'field-floor': resources.ownMaterial(new THREE.MeshStandardMaterial({
      color: 0x155c35,
      roughness: 0.88,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    })),
    'field-lower-transition': createLowerTransitionMaterial(resources, anchors, rampRise),
    'field-containment': createContainmentMaterial(resources, anchors, rampRise, wallTopY),
    'field-ceiling': resources.ownMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xc8edf5,
      roughness: 0.06,
      metalness: 0.03,
      transmission: 0.16,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
      side: THREE.FrontSide,
    })),
    // The two goal interiors were near-black and within a few points of each
    // other, so which end you were looking into was not something the colour told
    // you. They stay dark, because a lit recess hides the ball, but they now carry
    // enough of their own team to be told apart at a glance.
    'blue-goal': resources.ownMaterial(new THREE.MeshStandardMaterial({
      color: 0x14304a,
      roughness: 0.56,
      metalness: 0.48,
      side: THREE.FrontSide,
    })),
    'orange-goal': resources.ownMaterial(new THREE.MeshStandardMaterial({
      color: 0x4a2a15,
      roughness: 0.56,
      metalness: 0.48,
      side: THREE.FrontSide,
    })),
  });
}

function immutableBoundaryMetadata(
  primitive: ResolvedArenaBoundaryPrimitive,
  geometry: ResolvedArenaGeometry,
): ArenaBoundaryMeshMetadata {
  return Object.freeze({
    primitiveId: primitive.id,
    surfaceId: primitive.surfaceId,
    seamIds: Object.freeze([...primitive.inwardSurface.seamIds]),
    semanticKind: primitive.semanticKind,
    region: primitive.region,
    materialRole: primitive.materialRole,
    geometryIdentity: Object.freeze({
      sourceVersion: geometry.identity.sourceVersion,
      primitiveSchemaVersion: geometry.identity.primitiveSchemaVersion,
      fingerprint: geometry.identity.fingerprint,
    }),
  });
}

function createAuthoritativeBoundaries(
  root: THREE.Group,
  resolvedGeometry: ResolvedArenaGeometry,
  resources: ResourceOwnership,
  materials: Readonly<Record<ArenaBoundaryMaterialRole, THREE.Material>>,
): ReadonlyMap<string, THREE.BufferGeometry> {
  const geometriesByPrimitive = new Map<string, THREE.BufferGeometry>();
  for (const primitive of resolvedGeometry.primitives) {
    const geometry = geometryFromInwardSurface(primitive, resources);
    const mesh = new THREE.Mesh(geometry, materials[primitive.materialRole]);
    mesh.name = `arena-boundary:${primitive.id}`;
    // The ceiling is the only boundary still drawn as glass, so it is the only one
    // that has to be held back for transparency sorting. The wall is opaque now
    // and sorts with everything else.
    const isGlass = primitive.materialRole === 'field-ceiling';
    mesh.receiveShadow = !isGlass;
    mesh.renderOrder = isGlass ? 2 : 0;
    mesh.userData = Object.freeze({
      arenaBoundary: immutableBoundaryMetadata(primitive, resolvedGeometry),
    });
    root.add(mesh);
    geometriesByPrimitive.set(primitive.id, geometry);
  }
  return geometriesByPrimitive;
}

function createTurfMaterial(
  resources: ResourceOwnership,
  anchors: StadiumAnchors,
): THREE.ShaderMaterial {
  const bandWidth = Math.max((anchors.halfLength * 2) / 16, 0.5);
  return resources.ownMaterial(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: {
      bandWidth: { value: bandWidth },
      blueTint: { value: new THREE.Color(VISUAL.PALETTE.FIELD_BLUE) },
      orangeTint: { value: new THREE.Color(VISUAL.PALETTE.FIELD_ORANGE) },
      neutralTint: { value: new THREE.Color(VISUAL.PALETTE.FIELD_BASE) },
      opacity: { value: VISUAL.STADIUM.FIELD.HALF_TINT_OPACITY },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform float bandWidth;
      uniform vec3 blueTint;
      uniform vec3 orangeTint;
      uniform vec3 neutralTint;
      uniform float opacity;
      varying vec3 vWorldPosition;
      void main() {
        float stripe = mod(floor(abs(vWorldPosition.z) / bandWidth), 2.0);
        vec3 teamTint = vWorldPosition.z < 0.0 ? blueTint : orangeTint;
        vec3 striped = mix(teamTint * 0.78, teamTint * 1.08, stripe);
        gl_FragColor = vec4(mix(neutralTint, striped, 0.82), opacity);
      }
    `,
  }));
}

function createGameplayOverlays(
  root: THREE.Group,
  resolvedGeometry: ResolvedArenaGeometry,
  boundaryGeometries: ReadonlyMap<string, THREE.BufferGeometry>,
  resources: ResourceOwnership,
  unitBox: THREE.BoxGeometry,
  anchors: StadiumAnchors,
): readonly THREE.MeshStandardMaterial[] {
  const markingHeight = VISUAL.STADIUM.FIELD.MARKING_HEIGHT;
  const turfMaterial = createTurfMaterial(resources, anchors);
  const markingMaterial = resources.ownMaterial(new THREE.MeshBasicMaterial({
    color: VISUAL.PALETTE.FIELD_LINE,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  }));
  const subtleMarkingMaterial = resources.ownMaterial(new THREE.MeshBasicMaterial({
    color: VISUAL.PALETTE.FIELD_LINE,
    transparent: true,
    opacity: VISUAL.STADIUM.FIELD.GRID_OPACITY,
    depthWrite: false,
  }));

  for (const primitive of resolvedGeometry.primitives) {
    if (primitive.semanticKind !== 'floor' || primitive.region !== 'field') continue;
    const geometry = boundaryGeometries.get(primitive.id);
    if (!geometry) continue;
    const turf = new THREE.Mesh(geometry, turfMaterial);
    turf.name = `procedural-turf:${primitive.id}`;
    turf.position.y = markingHeight;
    turf.renderOrder = 1;
    root.add(turf);
  }

  const floorPrimitive = resolvedGeometry.primitives.find(({ id }) => id === 'field.floor.center')
    ?? resolvedGeometry.primitives.find(({ semanticKind, region }) => semanticKind === 'floor' && region === 'field');
  if (!floorPrimitive) throw new TypeError('Resolved arena geometry requires a field floor primitive.');
  const floorXs = floorPrimitive.inwardSurface.positions.map((position) => position[0]);
  const midfieldWidth = Math.max(...floorXs) - Math.min(...floorXs);

  addBox(
    root,
    unitBox,
    'center-line',
    new THREE.Vector3(midfieldWidth, markingHeight, VISUAL.STADIUM.FIELD.LINE_WIDTH),
    new THREE.Vector3(anchors.centerX, markingHeight * 2.1, anchors.centerZ),
    markingMaterial,
  );

  const centerRing = new THREE.Mesh(
    resources.ownGeometry(new THREE.RingGeometry(
      VISUAL.STADIUM.FIELD.CENTER_RING_RADIUS - VISUAL.STADIUM.FIELD.CENTER_RING_THICKNESS,
      VISUAL.STADIUM.FIELD.CENTER_RING_RADIUS,
      64,
    )),
    markingMaterial,
  );
  centerRing.name = 'center-ring';
  centerRing.rotation.x = -Math.PI / 2;
  centerRing.position.set(anchors.centerX, markingHeight * 2.2, anchors.centerZ);
  root.add(centerRing);

  const centerDisc = new THREE.Mesh(
    resources.ownGeometry(new THREE.CircleGeometry(0.24, 20)),
    markingMaterial,
  );
  centerDisc.name = 'kickoff-center';
  centerDisc.rotation.x = -Math.PI / 2;
  centerDisc.position.set(anchors.centerX, markingHeight * 2.4, anchors.centerZ);
  root.add(centerDisc);

  const laneLimit = anchors.halfWidth - resolvedGeometry.profiles.floorWall.run;
  for (
    let x = anchors.centerX - laneLimit + VISUAL.STADIUM.FIELD.GRID_SPACING;
    x < anchors.centerX + laneLimit;
    x += VISUAL.STADIUM.FIELD.GRID_SPACING
  ) {
    addBox(
      root,
      unitBox,
      'field-lane-marking',
      new THREE.Vector3(0.025, markingHeight, anchors.halfLength * 2 - 2 * resolvedGeometry.profiles.floorWall.run),
      new THREE.Vector3(x, markingHeight * 1.8, anchors.centerZ),
      subtleMarkingMaterial,
    );
  }

  for (const zSign of [-1, 1] as const) {
    const arc = new THREE.Mesh(
      resources.ownGeometry(new THREE.RingGeometry(2.2, 2.3, 32, 1, 0, Math.PI)),
      subtleMarkingMaterial,
    );
    arc.name = 'kickoff-arc';
    arc.rotation.x = -Math.PI / 2;
    arc.rotation.z = zSign < 0 ? Math.PI / 2 : -Math.PI / 2;
    arc.position.set(anchors.centerX, markingHeight * 2, anchors.centerZ + zSign * anchors.halfLength * 0.5);
    root.add(arc);
  }

  const animatedGoalMaterials: THREE.MeshStandardMaterial[] = [];
  for (const goal of resolvedGeometry.goals) {
    animatedGoalMaterials.push(createGoalPresentation(
      root,
      goal,
      resources,
      unitBox,
      markingMaterial,
    ));
  }
  return animatedGoalMaterials;
}

function createGoalGrid(
  goal: ResolvedArenaGoalRegion,
  color: number,
  resources: ResourceOwnership,
): THREE.LineSegments {
  const positions: number[] = [];
  const halfWidth = goal.opening.width / 2;
  const minX = goal.opening.centerX - halfWidth;
  const maxX = goal.opening.centerX + halfWidth;
  const bottomY = goal.opening.bottomY;
  const topY = bottomY + goal.opening.height;
  const mouthZ = goal.goalLineZ;
  const backZ = goal.backWallZ;
  const line = (first: ArenaVector3Tuple, second: ArenaVector3Tuple): void => {
    positions.push(...first, ...second);
  };

  for (let column = 0; column <= VISUAL.STADIUM.GOAL.GRID_COLUMNS; column += 1) {
    const x = THREE.MathUtils.lerp(minX, maxX, column / VISUAL.STADIUM.GOAL.GRID_COLUMNS);
    line([x, bottomY, backZ], [x, topY, backZ]);
    line([x, topY, mouthZ], [x, topY, backZ]);
  }
  for (let row = 0; row <= VISUAL.STADIUM.GOAL.GRID_ROWS; row += 1) {
    const y = THREE.MathUtils.lerp(bottomY, topY, row / VISUAL.STADIUM.GOAL.GRID_ROWS);
    line([minX, y, backZ], [maxX, y, backZ]);
    line([minX, y, mouthZ], [minX, y, backZ]);
    line([maxX, y, mouthZ], [maxX, y, backZ]);
  }

  const geometry = resources.ownGeometry(new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const material = resources.ownMaterial(new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: VISUAL.STADIUM.GOAL.GRID_OPACITY,
    depthWrite: false,
  }));
  const grid = new THREE.LineSegments(geometry, material);
  grid.name = goal.defendingTeam === 'blue' ? 'blue-goal-grid' : 'orange-goal-grid';
  return grid;
}

function createGoalPresentation(
  root: THREE.Group,
  goal: ResolvedArenaGoalRegion,
  resources: ResourceOwnership,
  unitBox: THREE.BoxGeometry,
  markingMaterial: THREE.Material,
): THREE.MeshStandardMaterial {
  const isBlue = goal.defendingTeam === 'blue';
  const prefix = isBlue ? 'blue' : 'orange';
  const color = isBlue ? VISUAL.PALETTE.BLUE_LIGHT : VISUAL.PALETTE.ORANGE_LIGHT;
  const glowMaterial = resources.ownMaterial(new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: VISUAL.STADIUM.GOAL.AMBIENT_GLOW,
    roughness: 0.25,
    metalness: 0.62,
  }));
  const frameThickness = VISUAL.STADIUM.GOAL.FRAME_THICKNESS;
  const halfWidth = goal.opening.width / 2;
  const centerX = goal.opening.centerX;
  const bottomY = goal.opening.bottomY;
  const topY = bottomY + goal.opening.height;
  const depth = Math.abs(goal.backWallZ - goal.goalLineZ);
  const centerZ = (goal.goalLineZ + goal.backWallZ) / 2;

  // The frame sits immediately outside the exact opening, so no decorative solid closes the mouth.
  addBox(
    root,
    unitBox,
    `${prefix}-goal-crossbar`,
    new THREE.Vector3(goal.opening.width + frameThickness * 2, frameThickness, VISUAL.STADIUM.GOAL.FRAME_DEPTH),
    new THREE.Vector3(centerX, topY + frameThickness / 2, goal.goalLineZ),
    glowMaterial,
  );
  for (const xSign of [-1, 1] as const) {
    addBox(
      root,
      unitBox,
      `${prefix}-goal-post`,
      new THREE.Vector3(frameThickness, goal.opening.height, VISUAL.STADIUM.GOAL.FRAME_DEPTH),
      new THREE.Vector3(centerX + xSign * (halfWidth + frameThickness / 2), bottomY + goal.opening.height / 2, goal.goalLineZ),
      glowMaterial,
    );
  }

  const mouthLine = addBox(
    root,
    unitBox,
    `${prefix}-goal-mouth-line`,
    new THREE.Vector3(goal.opening.width, VISUAL.STADIUM.FIELD.MARKING_HEIGHT, VISUAL.STADIUM.FIELD.LINE_WIDTH),
    new THREE.Vector3(centerX, VISUAL.STADIUM.FIELD.MARKING_HEIGHT * 2, goal.goalLineZ),
    markingMaterial,
  );
  mouthLine.renderOrder = 1;

  const ribCount = VISUAL.STADIUM.GOAL.TUNNEL_RIBS;
  const ribs = new THREE.InstancedMesh(unitBox, glowMaterial, ribCount * 3);
  ribs.name = `${prefix}-goal-tunnel-ribs`;
  let ribIndex = 0;
  for (let rib = 0; rib < ribCount; rib += 1) {
    const amount = (rib + 1) / ribCount;
    const z = THREE.MathUtils.lerp(goal.goalLineZ, goal.backWallZ, amount);
    setInstance(
      ribs,
      ribIndex++,
      new THREE.Vector3(centerX - halfWidth - frameThickness / 2, bottomY + goal.opening.height / 2, z),
      new THREE.Vector3(frameThickness, goal.opening.height, frameThickness),
    );
    setInstance(
      ribs,
      ribIndex++,
      new THREE.Vector3(centerX + halfWidth + frameThickness / 2, bottomY + goal.opening.height / 2, z),
      new THREE.Vector3(frameThickness, goal.opening.height, frameThickness),
    );
    setInstance(
      ribs,
      ribIndex++,
      new THREE.Vector3(centerX, topY + frameThickness / 2, z),
      new THREE.Vector3(goal.opening.width + frameThickness * 2, frameThickness, frameThickness),
    );
  }
  ribs.instanceMatrix.needsUpdate = true;
  root.add(ribs, createGoalGrid(goal, color, resources));

  const panelCount = Math.max(2, Math.floor(depth / 2));
  const lightPanels = new THREE.InstancedMesh(unitBox, glowMaterial, panelCount);
  lightPanels.name = `${prefix}-goal-tunnel-lights`;
  for (let index = 0; index < panelCount; index += 1) {
    const amount = (index + 1) / (panelCount + 1);
    setInstance(
      lightPanels,
      index,
      new THREE.Vector3(centerX, topY - 0.035, THREE.MathUtils.lerp(goal.goalLineZ, goal.backWallZ, amount)),
      new THREE.Vector3(goal.opening.width * 0.28, 0.035, 0.12),
    );
  }
  lightPanels.instanceMatrix.needsUpdate = true;
  root.add(lightPanels);

  // A low-profile glow strip follows the exact goal depth without replacing the authoritative floor.
  addBox(
    root,
    unitBox,
    `${prefix}-goal-depth-accent`,
    new THREE.Vector3(goal.opening.width * 0.82, 0.018, Math.max(depth - 0.3, 0.1)),
    new THREE.Vector3(centerX, bottomY + 0.018, centerZ),
    glowMaterial,
  );
  return glowMaterial;
}

function createStadiumAnchors(resolvedGeometry: ResolvedArenaGeometry): StadiumAnchors {
  const min = resolvedGeometry.bounds.min;
  const max = resolvedGeometry.bounds.max;
  return Object.freeze({
    centerX: (min[0] + max[0]) / 2,
    centerZ: (min[2] + max[2]) / 2,
    halfWidth: (max[0] - min[0]) / 2,
    halfLength: (max[2] - min[2]) / 2,
    ceilingY: max[1],
    goalBackDistance: Math.max(
      Math.abs(resolvedGeometry.enclosureBounds.min[2]),
      Math.abs(resolvedGeometry.enclosureBounds.max[2]),
    ),
  });
}

function createExteriorMaterials(resources: ResourceOwnership): Readonly<{
  structure: THREE.MeshStandardMaterial;
  structureMid: THREE.MeshStandardMaterial;
  seats: THREE.MeshStandardMaterial;
  lamps: THREE.MeshStandardMaterial;
  flags: THREE.MeshStandardMaterial;
  skyline: THREE.MeshStandardMaterial;
  windows: THREE.MeshStandardMaterial;
}> {
  return Object.freeze({
    structure: resources.ownMaterial(new THREE.MeshStandardMaterial({
      color: VISUAL.PALETTE.STRUCTURE_DARK,
      roughness: 0.62,
      metalness: 0.68,
    })),
    structureMid: resources.ownMaterial(new THREE.MeshStandardMaterial({
      color: VISUAL.PALETTE.STRUCTURE_MID,
      roughness: 0.58,
      metalness: 0.55,
    })),
    seats: resources.ownMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.72,
      metalness: 0.18,
      vertexColors: true,
    })),
    lamps: resources.ownMaterial(new THREE.MeshStandardMaterial({
      color: VISUAL.PALETTE.WHITE_LIGHT,
      emissive: VISUAL.PALETTE.WHITE_LIGHT,
      emissiveIntensity: VISUAL.STADIUM.LIGHTS.PANEL_GLOW,
      roughness: 0.16,
      metalness: 0.28,
    })),
    flags: resources.ownMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.5,
      metalness: 0.2,
      side: THREE.DoubleSide,
      vertexColors: true,
    })),
    skyline: resources.ownMaterial(new THREE.MeshStandardMaterial({
      color: 0x101a25,
      roughness: 0.78,
      metalness: 0.34,
      vertexColors: true,
    })),
    windows: resources.ownMaterial(new THREE.MeshStandardMaterial({
      color: VISUAL.PALETTE.WARM_LIGHT,
      emissive: VISUAL.PALETTE.WARM_LIGHT,
      emissiveIntensity: 0.7,
      roughness: 0.2,
      metalness: 0.2,
    })),
  });
}

function createStands(
  root: THREE.Group,
  anchors: StadiumAnchors,
  unitBox: THREE.BoxGeometry,
  materials: ReturnType<typeof createExteriorMaterials>,
): void {
  const seats: StandInstance[] = [];
  const platforms: Array<{ readonly position: THREE.Vector3; readonly scale: THREE.Vector3 }> = [];
  const rowCount = VISUAL.STADIUM.STANDS.TIER_COUNT * VISUAL.STADIUM.STANDS.ROWS_PER_TIER;
  const seatScale = new THREE.Vector3(
    VISUAL.STADIUM.STANDS.SEAT_WIDTH,
    VISUAL.STADIUM.STANDS.SEAT_HEIGHT,
    VISUAL.STADIUM.STANDS.SEAT_DEPTH,
  );
  const colorForPosition = (x: number, z: number, index: number): THREE.Color => {
    const color = new THREE.Color(z < anchors.centerZ ? VISUAL.PALETTE.BLUE : VISUAL.PALETTE.ORANGE);
    const variation = ((Math.abs(Math.round(x * 3 + z * 5 + index * 7)) % 7) - 3) * 0.018;
    color.offsetHSL(0, -0.08 + variation, variation);
    return color;
  };

  for (const xSign of [-1, 1] as const) {
    for (let row = 0; row < rowCount; row += 1) {
      const tier = Math.floor(row / VISUAL.STADIUM.STANDS.ROWS_PER_TIER);
      const x = anchors.centerX + xSign * (
        anchors.halfWidth + VISUAL.STADIUM.STANDS.SIDE_OFFSET + row * VISUAL.STADIUM.STANDS.ROW_DEPTH
      );
      const y = 0.8 + row * VISUAL.STADIUM.STANDS.ROW_RISE + tier * 0.55;
      platforms.push({
        position: new THREE.Vector3(x, y - 0.22, anchors.centerZ),
        scale: new THREE.Vector3(VISUAL.STADIUM.STANDS.ROW_DEPTH, 0.22, anchors.halfLength * 2 + 6),
      });
      for (let seat = 0; seat < VISUAL.STADIUM.STANDS.SEATS_PER_SIDE; seat += 1) {
        const z = THREE.MathUtils.lerp(
          anchors.centerZ - anchors.halfLength - 1.5,
          anchors.centerZ + anchors.halfLength + 1.5,
          seat / (VISUAL.STADIUM.STANDS.SEATS_PER_SIDE - 1),
        );
        seats.push({ position: new THREE.Vector3(x, y, z), scale: seatScale, color: colorForPosition(x, z, seat + row) });
      }
    }
  }

  for (const zSign of [-1, 1] as const) {
    for (let row = 0; row < rowCount; row += 1) {
      const tier = Math.floor(row / VISUAL.STADIUM.STANDS.ROWS_PER_TIER);
      const z = anchors.centerZ + zSign * (
        anchors.goalBackDistance + VISUAL.STADIUM.STANDS.END_OFFSET + row * VISUAL.STADIUM.STANDS.ROW_DEPTH
      );
      const y = 0.8 + row * VISUAL.STADIUM.STANDS.ROW_RISE + tier * 0.55;
      platforms.push({
        position: new THREE.Vector3(anchors.centerX, y - 0.22, z),
        scale: new THREE.Vector3(anchors.halfWidth * 2 + 5, 0.22, VISUAL.STADIUM.STANDS.ROW_DEPTH),
      });
      for (let seat = 0; seat < VISUAL.STADIUM.STANDS.SEATS_PER_END; seat += 1) {
        const x = THREE.MathUtils.lerp(
          anchors.centerX - anchors.halfWidth - 1.5,
          anchors.centerX + anchors.halfWidth + 1.5,
          seat / (VISUAL.STADIUM.STANDS.SEATS_PER_END - 1),
        );
        seats.push({ position: new THREE.Vector3(x, y, z), scale: seatScale, color: colorForPosition(x, z, seat + row) });
      }
    }
  }

  const seatMesh = new THREE.InstancedMesh(unitBox, materials.seats, seats.length);
  seatMesh.name = 'instanced-spectator-seats';
  seats.forEach((seat, index) => {
    setInstance(seatMesh, index, seat.position, seat.scale);
    seatMesh.setColorAt(index, seat.color);
  });
  seatMesh.instanceMatrix.needsUpdate = true;
  if (seatMesh.instanceColor) seatMesh.instanceColor.needsUpdate = true;
  root.add(seatMesh);

  const platformMesh = new THREE.InstancedMesh(unitBox, materials.structure, platforms.length);
  platformMesh.name = 'instanced-stand-risers';
  platforms.forEach((platform, index) => setInstance(platformMesh, index, platform.position, platform.scale));
  platformMesh.instanceMatrix.needsUpdate = true;
  platformMesh.receiveShadow = true;
  root.add(platformMesh);
}

function createTrusses(
  root: THREE.Group,
  anchors: StadiumAnchors,
  resources: ResourceOwnership,
  unitBox: THREE.BoxGeometry,
  materials: ReturnType<typeof createExteriorMaterials>,
): void {
  const archGeometry = resources.ownGeometry(new THREE.TorusGeometry(
    anchors.halfWidth + VISUAL.STADIUM.STRUCTURE.ARCH_RADIUS_PADDING,
    VISUAL.STADIUM.STRUCTURE.ARCH_TUBE_RADIUS,
    6,
    48,
    Math.PI,
  ));
  const arches = new THREE.InstancedMesh(archGeometry, materials.structureMid, VISUAL.STADIUM.STRUCTURE.ARCH_COUNT);
  arches.name = 'instanced-stadium-arches';
  const archY = anchors.ceilingY + VISUAL.STADIUM.STRUCTURE.ARCH_TUBE_RADIUS * 2;
  for (let index = 0; index < VISUAL.STADIUM.STRUCTURE.ARCH_COUNT; index += 1) {
    const z = THREE.MathUtils.lerp(
      anchors.centerZ - anchors.halfLength - 2,
      anchors.centerZ + anchors.halfLength + 2,
      index / (VISUAL.STADIUM.STRUCTURE.ARCH_COUNT - 1),
    );
    setInstance(arches, index, new THREE.Vector3(anchors.centerX, archY, z), new THREE.Vector3(1, 1, 1));
  }
  arches.instanceMatrix.needsUpdate = true;
  root.add(arches);

  for (const xSign of [-1, 1] as const) {
    addBox(
      root,
      unitBox,
      'upper-catwalk',
      new THREE.Vector3(VISUAL.STADIUM.STRUCTURE.CATWALK_WIDTH, 0.18, anchors.halfLength * 2 + 8),
      new THREE.Vector3(
        anchors.centerX + xSign * (anchors.halfWidth + VISUAL.STADIUM.STANDS.SIDE_OFFSET),
        Math.min(VISUAL.STADIUM.STRUCTURE.RING_HEIGHT, anchors.ceilingY - 0.5),
        anchors.centerZ,
      ),
      materials.structure,
    );
  }
}

function createFloodlightBanks(
  root: THREE.Group,
  anchors: StadiumAnchors,
  unitBox: THREE.BoxGeometry,
  materials: ReturnType<typeof createExteriorMaterials>,
): void {
  const bankPositions: THREE.Vector3[] = [];
  for (const xSign of [-1, 1] as const) {
    for (let bank = 0; bank < VISUAL.STADIUM.LIGHTS.BANKS_PER_SIDE; bank += 1) {
      bankPositions.push(new THREE.Vector3(
        anchors.centerX + xSign * (anchors.halfWidth + 2.1),
        Math.min(VISUAL.STADIUM.LIGHTS.BANK_HEIGHT, anchors.ceilingY - 0.8),
        THREE.MathUtils.lerp(
          anchors.centerZ - anchors.halfLength * 0.36,
          anchors.centerZ + anchors.halfLength * 0.36,
          bank / (VISUAL.STADIUM.LIGHTS.BANKS_PER_SIDE - 1),
        ),
      ));
    }
  }
  const housings = new THREE.InstancedMesh(unitBox, materials.structure, bankPositions.length);
  housings.name = 'floodlight-bank-housings';
  bankPositions.forEach((position, index) => setInstance(housings, index, position, new THREE.Vector3(0.18, 1.35, 3.2)));
  housings.instanceMatrix.needsUpdate = true;
  root.add(housings);

  const lamps = new THREE.InstancedMesh(
    unitBox,
    materials.lamps,
    bankPositions.length * VISUAL.STADIUM.LIGHTS.LAMPS_PER_BANK,
  );
  lamps.name = 'instanced-floodlight-lamps';
  let lampIndex = 0;
  for (const bankPosition of bankPositions) {
    const xDirection = Math.sign(bankPosition.x - anchors.centerX) || 1;
    for (let lamp = 0; lamp < VISUAL.STADIUM.LIGHTS.LAMPS_PER_BANK; lamp += 1) {
      const zOffset = THREE.MathUtils.lerp(-1.15, 1.15, lamp / (VISUAL.STADIUM.LIGHTS.LAMPS_PER_BANK - 1));
      setInstance(
        lamps,
        lampIndex++,
        new THREE.Vector3(bankPosition.x - xDirection * 0.16, bankPosition.y, bankPosition.z + zOffset),
        new THREE.Vector3(VISUAL.STADIUM.LIGHTS.LAMP_SIZE * 0.45, VISUAL.STADIUM.LIGHTS.LAMP_SIZE, VISUAL.STADIUM.LIGHTS.LAMP_SIZE),
      );
    }
  }
  lamps.instanceMatrix.needsUpdate = true;
  root.add(lamps);
}

function createFlags(
  root: THREE.Group,
  anchors: StadiumAnchors,
  resources: ResourceOwnership,
  materials: ReturnType<typeof createExteriorMaterials>,
): THREE.InstancedMesh {
  const flagCount = 10;
  const geometry = resources.ownGeometry(new THREE.PlaneGeometry(1.8, 0.86, 4, 2));
  const flags = new THREE.InstancedMesh(geometry, materials.flags, flagCount);
  flags.name = 'instanced-rocket-arena-flags';
  for (let index = 0; index < flagCount; index += 1) {
    const xSign = index < flagCount / 2 ? -1 : 1;
    const sideIndex = index % (flagCount / 2);
    const position = new THREE.Vector3(
      anchors.centerX + xSign * (anchors.halfWidth + VISUAL.STADIUM.STANDS.SIDE_OFFSET + 1.2),
      10.4 + (sideIndex % 2) * 0.35,
      THREE.MathUtils.lerp(
        anchors.centerZ - anchors.halfLength * 0.72,
        anchors.centerZ + anchors.halfLength * 0.72,
        sideIndex / (flagCount / 2 - 1),
      ),
    );
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, xSign < 0 ? Math.PI / 2 : -Math.PI / 2, 0));
    setInstance(flags, index, position, new THREE.Vector3(1, 1, 1), rotation);
    flags.setColorAt(index, new THREE.Color(index % 2 === 0 ? VISUAL.PALETTE.BLUE : VISUAL.PALETTE.ORANGE));
  }
  flags.instanceMatrix.needsUpdate = true;
  if (flags.instanceColor) flags.instanceColor.needsUpdate = true;
  root.add(flags);
  return flags;
}

function createPixelWord(
  word: string,
  maxWidth: number,
  maxHeight: number,
  color: number,
  resources: ResourceOwnership,
): THREE.InstancedMesh {
  const glyphWidth = 5;
  const glyphHeight = 7;
  const letterGap = 1;
  const columns = word.length * (glyphWidth + letterGap) - letterGap;
  const cellSize = Math.min(maxWidth / columns, maxHeight / glyphHeight);
  const activeCells: Array<{ readonly x: number; readonly y: number }> = [];
  [...word].forEach((character, characterIndex) => {
    const glyph = PIXEL_GLYPHS[character];
    if (!glyph) return;
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((value, columnIndex) => {
        if (value === '1') {
          activeCells.push({
            x: (characterIndex * (glyphWidth + letterGap) + columnIndex - (columns - 1) / 2) * cellSize,
            y: ((glyphHeight - 1) / 2 - rowIndex) * cellSize,
          });
        }
      });
    });
  });
  const geometry = resources.ownGeometry(new THREE.BoxGeometry(cellSize * 0.68, cellSize * 0.68, 0.06));
  const material = resources.ownMaterial(new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 1.25,
    roughness: 0.22,
    metalness: 0.38,
  }));
  const text = new THREE.InstancedMesh(geometry, material, activeCells.length);
  activeCells.forEach((cell, index) => setInstance(text, index, new THREE.Vector3(cell.x, cell.y, 0), new THREE.Vector3(1, 1, 1)));
  text.instanceMatrix.needsUpdate = true;
  return text;
}

function createScoreboard(
  root: THREE.Group,
  anchors: StadiumAnchors,
  zSign: -1 | 1,
  resources: ResourceOwnership,
  unitBox: THREE.BoxGeometry,
  materials: ReturnType<typeof createExteriorMaterials>,
): void {
  const group = new THREE.Group();
  group.name = `${zSign < 0 ? 'blue' : 'orange'}-rocket-arena-scoreboard`;
  const width = VISUAL.STADIUM.SCOREBOARD.WIDTH;
  const height = VISUAL.STADIUM.SCOREBOARD.HEIGHT;
  const depth = VISUAL.STADIUM.SCOREBOARD.DEPTH;
  const color = zSign < 0 ? VISUAL.PALETTE.BLUE_LIGHT : VISUAL.PALETTE.ORANGE_LIGHT;
  addBox(group, unitBox, 'scoreboard-panel', new THREE.Vector3(width, height, depth), new THREE.Vector3(), materials.structure, true);
  addBox(
    group,
    unitBox,
    'scoreboard-header-rule',
    new THREE.Vector3(width * 0.9, 0.05, depth * 0.12),
    new THREE.Vector3(0, 0, depth / 2 + 0.035),
    resources.ownMaterial(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8 })),
  );
  const rocket = createPixelWord('ROCKET', width * 0.78, height * 0.34, VISUAL.PALETTE.WHITE_LIGHT, resources);
  rocket.name = 'rocket-wordmark';
  rocket.position.set(0, height * 0.23, depth / 2 + 0.08);
  const arena = createPixelWord('ARENA', width * 0.62, height * 0.3, color, resources);
  arena.name = 'arena-wordmark';
  arena.position.set(0, -height * 0.23, depth / 2 + 0.08);
  group.add(rocket, arena);
  group.position.set(
    anchors.centerX,
    Math.min(VISUAL.STADIUM.SCOREBOARD.Y, anchors.ceilingY - 1),
    anchors.centerZ + zSign * (anchors.goalBackDistance + VISUAL.STADIUM.STANDS.END_OFFSET + 1.3),
  );
  if (zSign > 0) group.rotation.y = Math.PI;
  root.add(group);
}

function createSkyline(
  root: THREE.Group,
  anchors: StadiumAnchors,
  unitBox: THREE.BoxGeometry,
  materials: ReturnType<typeof createExteriorMaterials>,
): void {
  const towerCount = 32;
  const towers = new THREE.InstancedMesh(unitBox, materials.skyline, towerCount);
  towers.name = 'instanced-city-skyline';
  const windows = new THREE.InstancedMesh(unitBox, materials.windows, towerCount);
  windows.name = 'instanced-skyline-windows';
  for (let index = 0; index < towerCount; index += 1) {
    const quadrant = index % 4;
    const lane = Math.floor(index / 4);
    const height = 4.5 + ((index * 13) % 9) * 0.72;
    const span = lane / Math.max(Math.floor(towerCount / 4) - 1, 1);
    let x = anchors.centerX;
    let z = anchors.centerZ;
    if (quadrant < 2) {
      x = anchors.centerX + (quadrant === 0 ? -1 : 1) * (anchors.halfWidth + 17 + (lane % 3) * 1.8);
      z = THREE.MathUtils.lerp(anchors.centerZ - anchors.halfLength - 8, anchors.centerZ + anchors.halfLength + 8, span);
    } else {
      x = THREE.MathUtils.lerp(anchors.centerX - anchors.halfWidth - 8, anchors.centerX + anchors.halfWidth + 8, span);
      z = anchors.centerZ + (quadrant === 2 ? -1 : 1) * (anchors.goalBackDistance + 15 + (lane % 3) * 1.8);
    }
    const width = 1.8 + (index % 5) * 0.32;
    const depth = 1.8 + ((index + 2) % 4) * 0.36;
    setInstance(towers, index, new THREE.Vector3(x, height / 2, z), new THREE.Vector3(width, height, depth));
    towers.setColorAt(index, new THREE.Color(index % 2 === 0 ? 0x132335 : 0x1b202c));
    const inwardX = x === anchors.centerX ? x : x - Math.sign(x - anchors.centerX) * (width / 2 + 0.025);
    const inwardZ = z === anchors.centerZ ? z : z - Math.sign(z - anchors.centerZ) * (depth / 2 + 0.025);
    setInstance(windows, index, new THREE.Vector3(inwardX, height * 0.58, inwardZ), new THREE.Vector3(0.08, height * 0.42, 0.08));
  }
  towers.instanceMatrix.needsUpdate = true;
  if (towers.instanceColor) towers.instanceColor.needsUpdate = true;
  windows.instanceMatrix.needsUpdate = true;
  root.add(towers, windows);
}

function createAtmosphere(
  root: THREE.Group,
  anchors: StadiumAnchors,
  resources: ResourceOwnership,
): THREE.Points {
  const count = VISUAL.STADIUM.ATMOSPHERE.PARTICLE_COUNT;
  const positions = new Float32Array(count * 3);
  let seed = 0x524f434b;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let index = 0; index < count; index += 1) {
    const side = index % 5;
    let x = anchors.centerX + (random() - 0.5) * (anchors.halfWidth * 2 + 34);
    let y = THREE.MathUtils.lerp(4, anchors.ceilingY + 12, random());
    let z = anchors.centerZ + (random() - 0.5) * (anchors.goalBackDistance * 2 + 34);
    if (side === 0) x = anchors.centerX - anchors.halfWidth - 2 - random() * 12;
    else if (side === 1) x = anchors.centerX + anchors.halfWidth + 2 + random() * 12;
    else if (side === 2) z = anchors.centerZ - anchors.goalBackDistance - 2 - random() * 12;
    else if (side === 3) z = anchors.centerZ + anchors.goalBackDistance + 2 + random() * 12;
    else y = anchors.ceilingY + 1 + random() * 11;
    positions[index * 3] = x;
    positions[index * 3 + 1] = y;
    positions[index * 3 + 2] = z;
  }
  const geometry = resources.ownGeometry(new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const material = resources.ownMaterial(new THREE.PointsMaterial({
    color: VISUAL.PALETTE.WHITE_LIGHT,
    size: 0.08,
    transparent: true,
    opacity: VISUAL.STADIUM.ATMOSPHERE.PARTICLE_OPACITY,
    depthWrite: false,
    sizeAttenuation: true,
  }));
  const particles = new THREE.Points(geometry, material);
  particles.name = 'stadium-atmosphere';
  root.add(particles);
  return particles;
}

function createExteriorPresentation(
  root: THREE.Group,
  resolvedGeometry: ResolvedArenaGeometry,
  resources: ResourceOwnership,
  unitBox: THREE.BoxGeometry,
  anchors: StadiumAnchors,
): Readonly<{ readonly atmosphere: THREE.Points; readonly flags: THREE.InstancedMesh }> {
  const materials = createExteriorMaterials(resources);
  createStands(root, anchors, unitBox, materials);
  createTrusses(root, anchors, resources, unitBox, materials);
  createFloodlightBanks(root, anchors, unitBox, materials);
  const flags = createFlags(root, anchors, resources, materials);
  createScoreboard(root, anchors, -1, resources, unitBox, materials);
  createScoreboard(root, anchors, 1, resources, unitBox, materials);
  createSkyline(root, anchors, unitBox, materials);
  const atmosphere = createAtmosphere(root, anchors, resources);

  // Exterior presentation is anchored from the resolved shell but never receives authoritative metadata.
  if (resolvedGeometry.primitives.length === 0) {
    throw new TypeError('Resolved arena geometry requires authoritative primitives.');
  }
  root.userData = Object.freeze({ presentationOnly: true });
  return Object.freeze({ atmosphere, flags });
}

/**
 * Create the resolved-geometry-driven Rocket Arena stadium.
 *
 * Exactly three scene roots are owned by the returned handle. Authoritative
 * vertices are copied directly from ResolvedArenaGeometry.inwardSurface and are
 * never reconstructed from presentation constants.
 */
export function createArena(
  scene: THREE.Scene,
  resolvedGeometry: ResolvedArenaGeometry,
  padDescriptors: readonly ArenaPadDescriptor[] = [],
): ArenaOwnership {
  const resources = createResourceOwnership();
  const unitBox = resources.ownGeometry(new THREE.BoxGeometry(1, 1, 1));
  const authoritativeBoundaries = new THREE.Group();
  authoritativeBoundaries.name = 'arena-authoritative-boundaries';
  const gameplayOverlays = new THREE.Group();
  gameplayOverlays.name = 'arena-gameplay-overlays';
  const exteriorPresentation = new THREE.Group();
  exteriorPresentation.name = 'arena-exterior-presentation';

  // Anchors are resolved first because the wall and ramp paint are sized from the
  // arena's own dimensions. `createStadiumAnchors` reads only the resolved
  // geometry, so moving it ahead of the materials changes nothing else.
  const anchors = createStadiumAnchors(resolvedGeometry);
  const materials = createBoundaryMaterials(resources, resolvedGeometry, anchors);
  const boundaryGeometries = createAuthoritativeBoundaries(
    authoritativeBoundaries,
    resolvedGeometry,
    resources,
    materials,
  );
  const animatedGoalMaterials = createDaylightGameplayPresentation(
    gameplayOverlays,
    resolvedGeometry,
    boundaryGeometries,
    resources,
    unitBox,
    anchors,
  );
  // Pad rendering is deliberately outside Task 6.2. Empty and non-empty immutable
  // descriptor lists create no placeholder or implied collectable geometry here.
  const retainedPadDescriptors = Object.freeze([...padDescriptors]);
  const exteriorAnimation = createDaylightExteriorPresentation(
    exteriorPresentation,
    resolvedGeometry,
    resources,
    unitBox,
    anchors,
  );

  scene.add(authoritativeBoundaries, gameplayOverlays, exteriorPresentation);
  let isDisposed = false;

  const ownership: ArenaOwnership = {
    geometry: resolvedGeometry,
    authoritativeBoundaries,
    gameplayOverlays,
    exteriorPresentation,
    padDescriptors: retainedPadDescriptors,
    get disposed(): boolean {
      return isDisposed;
    },
    getObjectByName(name: string): THREE.Object3D | undefined {
      return authoritativeBoundaries.getObjectByName(name)
        ?? gameplayOverlays.getObjectByName(name)
        ?? exteriorPresentation.getObjectByName(name);
    },
    update(deltaSeconds: number, elapsedSeconds: number): void {
      if (isDisposed) return;
      const finiteElapsed = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
      const finiteDelta = Number.isFinite(deltaSeconds) ? THREE.MathUtils.clamp(deltaSeconds, 0, 0.1) : 0;
      exteriorAnimation.atmosphere.rotation.y = Math.sin(finiteElapsed * 0.025) * 0.012;
      exteriorAnimation.flags.rotation.z = Math.sin(finiteElapsed * 0.7) * 0.006;
      const pulse = THREE.MathUtils.clamp(
        2.72 + Math.sin(finiteElapsed * 2.05) * 0.22 + finiteDelta * 0.08,
        2.45,
        3.05,
      );
      for (const material of animatedGoalMaterials) material.emissiveIntensity = pulse;
    },
    dispose(): void {
      if (isDisposed) return;
      isDisposed = true;
      authoritativeBoundaries.removeFromParent();
      gameplayOverlays.removeFromParent();
      exteriorPresentation.removeFromParent();
      authoritativeBoundaries.clear();
      gameplayOverlays.clear();
      exteriorPresentation.clear();
      for (const geometry of resources.geometries) geometry.dispose();
      for (const material of resources.materials) material.dispose();
      for (const texture of resources.textures) texture.dispose();
      resources.geometries.clear();
      resources.materials.clear();
      resources.textures.clear();
    },
  };
  return ownership;
}
