import * as THREE from 'three';
import { ARENA, VISUAL } from '@rocket-arena/shared';

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const IDENTITY_QUATERNION = new THREE.Quaternion();

const PIXEL_GLYPHS: Record<string, readonly string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
};

const floorMaterial = new THREE.MeshStandardMaterial({
  color: VISUAL.PALETTE.FIELD_BASE,
  roughness: 0.78,
  metalness: 0.08,
});
const blueFieldMaterial = new THREE.MeshStandardMaterial({
  color: VISUAL.PALETTE.FIELD_BLUE,
  roughness: 0.75,
  metalness: 0.12,
  transparent: true,
  opacity: VISUAL.STADIUM.FIELD.HALF_TINT_OPACITY,
});
const orangeFieldMaterial = new THREE.MeshStandardMaterial({
  color: VISUAL.PALETTE.FIELD_ORANGE,
  roughness: 0.75,
  metalness: 0.12,
  transparent: true,
  opacity: VISUAL.STADIUM.FIELD.HALF_TINT_OPACITY,
});
const markingMaterial = new THREE.MeshBasicMaterial({
  color: VISUAL.PALETTE.FIELD_LINE,
  transparent: true,
  opacity: 0.72,
  depthWrite: false,
});
const subtleMarkingMaterial = new THREE.MeshBasicMaterial({
  color: VISUAL.PALETTE.FIELD_LINE,
  transparent: true,
  opacity: VISUAL.STADIUM.FIELD.GRID_OPACITY,
  depthWrite: false,
});
const structureMaterial = new THREE.MeshStandardMaterial({
  color: VISUAL.PALETTE.STRUCTURE_DARK,
  roughness: 0.62,
  metalness: 0.68,
});
const structureMidMaterial = new THREE.MeshStandardMaterial({
  color: VISUAL.PALETTE.STRUCTURE_MID,
  roughness: 0.58,
  metalness: 0.55,
});
const kickboardMaterial = new THREE.MeshStandardMaterial({
  color: VISUAL.PALETTE.NEUTRAL_METAL,
  roughness: 0.42,
  metalness: 0.64,
});
const containmentMaterial = new THREE.MeshPhysicalMaterial({
  color: 0x7aa1ac,
  roughness: 0.08,
  metalness: 0.1,
  transparent: true,
  opacity: VISUAL.STADIUM.PERIMETER.UPPER_GLASS_OPACITY,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const seatMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.72,
  metalness: 0.18,
  vertexColors: true,
});
const lampMaterial = new THREE.MeshStandardMaterial({
  color: VISUAL.PALETTE.WHITE_LIGHT,
  emissive: VISUAL.PALETTE.WHITE_LIGHT,
  emissiveIntensity: VISUAL.STADIUM.LIGHTS.PANEL_GLOW,
  roughness: 0.16,
  metalness: 0.28,
});

function addBox(
  parent: THREE.Object3D,
  name: string,
  size: THREE.Vector3,
  position: THREE.Vector3,
  material: THREE.Material,
  castShadow = false,
  receiveShadow = false,
): THREE.Mesh {
  const mesh = new THREE.Mesh(UNIT_BOX, material);
  mesh.name = name;
  mesh.scale.copy(size);
  mesh.position.copy(position);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  parent.add(mesh);
  return mesh;
}

function setInstance(
  mesh: THREE.InstancedMesh,
  index: number,
  position: THREE.Vector3,
  scale: THREE.Vector3,
  quaternion = IDENTITY_QUATERNION,
): void {
  const matrix = new THREE.Matrix4().compose(position, quaternion, scale);
  mesh.setMatrixAt(index, matrix);
}

function createField(root: THREE.Group): void {
  const width = ARENA.WIDTH;
  const length = ARENA.LENGTH;
  const depth = VISUAL.STADIUM.FIELD.SURFACE_DEPTH;
  const lineHeight = VISUAL.STADIUM.FIELD.MARKING_HEIGHT;

  addBox(
    root,
    'authoritative-field-surface',
    new THREE.Vector3(width, depth, length),
    new THREE.Vector3(0, -depth / 2, 0),
    floorMaterial,
    false,
    true,
  );
  addBox(
    root,
    'blue-team-half',
    new THREE.Vector3(width - 0.3, lineHeight, length / 2 - 0.15),
    new THREE.Vector3(0, lineHeight / 2, -length / 4),
    blueFieldMaterial,
  );
  addBox(
    root,
    'orange-team-half',
    new THREE.Vector3(width - 0.3, lineHeight, length / 2 - 0.15),
    new THREE.Vector3(0, lineHeight / 2, length / 4),
    orangeFieldMaterial,
  );

  addBox(
    root,
    'center-line',
    new THREE.Vector3(width - 0.8, lineHeight * 1.6, VISUAL.STADIUM.FIELD.LINE_WIDTH),
    new THREE.Vector3(0, lineHeight * 1.1, 0),
    markingMaterial,
  );

  const centerRing = new THREE.Mesh(
    new THREE.RingGeometry(
      VISUAL.STADIUM.FIELD.CENTER_RING_RADIUS - VISUAL.STADIUM.FIELD.CENTER_RING_THICKNESS,
      VISUAL.STADIUM.FIELD.CENTER_RING_RADIUS,
      64,
    ),
    markingMaterial,
  );
  centerRing.name = 'center-ring';
  centerRing.rotation.x = -Math.PI / 2;
  centerRing.position.y = lineHeight * 1.2;
  root.add(centerRing);

  const centerDisc = new THREE.Mesh(
    new THREE.CircleGeometry(0.24, 20),
    new THREE.MeshBasicMaterial({ color: VISUAL.PALETTE.BALL_CORE }),
  );
  centerDisc.name = 'kickoff-center';
  centerDisc.rotation.x = -Math.PI / 2;
  centerDisc.position.y = lineHeight * 1.4;
  root.add(centerDisc);

  for (let x = -width / 2 + VISUAL.STADIUM.FIELD.GRID_SPACING; x < width / 2; x += VISUAL.STADIUM.FIELD.GRID_SPACING) {
    addBox(
      root,
      'field-lane-marking',
      new THREE.Vector3(0.025, lineHeight, length - 1.2),
      new THREE.Vector3(x, lineHeight * 0.8, 0),
      subtleMarkingMaterial,
    );
  }

  for (const z of [-ARENA.LENGTH * 0.25, ARENA.LENGTH * 0.25]) {
    const arc = new THREE.Mesh(
      new THREE.RingGeometry(2.2, 2.3, 32, 1, 0, Math.PI),
      subtleMarkingMaterial,
    );
    arc.name = 'kickoff-arc';
    arc.rotation.x = -Math.PI / 2;
    arc.rotation.z = z < 0 ? Math.PI / 2 : -Math.PI / 2;
    arc.position.set(0, lineHeight, z);
    root.add(arc);
  }
}

function createPerimeter(root: THREE.Group): void {
  const width = ARENA.WIDTH;
  const length = ARENA.LENGTH;
  const height = ARENA.HEIGHT;
  const thickness = ARENA.WALL_THICKNESS;
  const kickboardHeight = VISUAL.STADIUM.PERIMETER.KICKBOARD_HEIGHT;
  const upperHeight = height - kickboardHeight;
  const sideSegmentWidth = (width - ARENA.GOAL.WIDTH) / 2;
  const sideSegmentX = width / 2 - sideSegmentWidth / 2;
  const endWallZ = length / 2 + thickness / 2;

  for (const side of [-1, 1]) {
    const x = side * (width / 2 + thickness / 2);
    addBox(
      root,
      'side-kickboard',
      new THREE.Vector3(thickness, kickboardHeight, length),
      new THREE.Vector3(x, kickboardHeight / 2, 0),
      kickboardMaterial,
      false,
      true,
    );
    addBox(
      root,
      'side-upper-containment',
      new THREE.Vector3(thickness * 0.18, upperHeight, length),
      new THREE.Vector3(x, kickboardHeight + upperHeight / 2, 0),
      containmentMaterial,
    );
  }

  for (const zSign of [-1, 1]) {
    for (const xSign of [-1, 1]) {
      addBox(
        root,
        'end-kickboard-segment',
        new THREE.Vector3(sideSegmentWidth, kickboardHeight, thickness),
        new THREE.Vector3(xSign * sideSegmentX, kickboardHeight / 2, zSign * endWallZ),
        kickboardMaterial,
        false,
        true,
      );
      addBox(
        root,
        'end-upper-containment',
        new THREE.Vector3(sideSegmentWidth, upperHeight, thickness * 0.18),
        new THREE.Vector3(xSign * sideSegmentX, kickboardHeight + upperHeight / 2, zSign * endWallZ),
        containmentMaterial,
      );
    }

    const topHeight = height - ARENA.GOAL.HEIGHT;
    addBox(
      root,
      'goal-overhead-containment',
      new THREE.Vector3(ARENA.GOAL.WIDTH, topHeight, thickness * 0.18),
      new THREE.Vector3(0, ARENA.GOAL.HEIGHT + topHeight / 2, zSign * endWallZ),
      containmentMaterial,
    );
  }

  const roof = new THREE.Mesh(
    new THREE.PlaneGeometry(width, length),
    containmentMaterial,
  );
  roof.name = 'transparent-ceiling-containment';
  roof.rotation.x = Math.PI / 2;
  roof.position.y = height;
  root.add(roof);

  const postPositions: THREE.Vector3[] = [];
  const spacing = VISUAL.STADIUM.PERIMETER.POST_SPACING;
  for (let z = -length / 2; z <= length / 2 + 0.01; z += spacing) {
    postPositions.push(
      new THREE.Vector3(-width / 2 - thickness / 2, height / 2, z),
      new THREE.Vector3(width / 2 + thickness / 2, height / 2, z),
    );
  }
  for (let x = -width / 2; x <= width / 2 + 0.01; x += spacing) {
    if (Math.abs(x) < ARENA.GOAL.WIDTH / 2) continue;
    postPositions.push(
      new THREE.Vector3(x, height / 2, -length / 2 - thickness / 2),
      new THREE.Vector3(x, height / 2, length / 2 + thickness / 2),
    );
  }

  const posts = new THREE.InstancedMesh(UNIT_BOX, structureMidMaterial, postPositions.length);
  posts.name = 'containment-posts';
  postPositions.forEach((position, index) => {
    setInstance(
      posts,
      index,
      position,
      new THREE.Vector3(VISUAL.STADIUM.PERIMETER.POST_WIDTH, height, VISUAL.STADIUM.PERIMETER.POST_WIDTH),
    );
  });
  posts.instanceMatrix.needsUpdate = true;
  root.add(posts);

  for (const x of [-width / 2 - thickness / 2, width / 2 + thickness / 2]) {
    addBox(
      root,
      'containment-top-rail',
      new THREE.Vector3(0.14, 0.14, length),
      new THREE.Vector3(x, height, 0),
      structureMidMaterial,
    );
  }
}

function createGoalGrid(zSign: number, color: number): THREE.LineSegments {
  const positions: number[] = [];
  const mouthZ = zSign * (ARENA.LENGTH / 2);
  const backZ = zSign * (ARENA.LENGTH / 2 + ARENA.GOAL.DEPTH);
  const halfWidth = ARENA.GOAL.WIDTH / 2;
  const height = ARENA.GOAL.HEIGHT;

  const line = (a: THREE.Vector3, b: THREE.Vector3): void => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
  };

  for (let column = 0; column <= VISUAL.STADIUM.GOAL.GRID_COLUMNS; column++) {
    const x = THREE.MathUtils.lerp(-halfWidth, halfWidth, column / VISUAL.STADIUM.GOAL.GRID_COLUMNS);
    line(new THREE.Vector3(x, 0, backZ), new THREE.Vector3(x, height, backZ));
    line(new THREE.Vector3(x, height, mouthZ), new THREE.Vector3(x, height, backZ));
  }
  for (let row = 0; row <= VISUAL.STADIUM.GOAL.GRID_ROWS; row++) {
    const y = height * row / VISUAL.STADIUM.GOAL.GRID_ROWS;
    line(new THREE.Vector3(-halfWidth, y, backZ), new THREE.Vector3(halfWidth, y, backZ));
    for (const xSign of [-1, 1]) {
      line(new THREE.Vector3(xSign * halfWidth, y, mouthZ), new THREE.Vector3(xSign * halfWidth, y, backZ));
    }
  }
  for (let depth = 0; depth <= VISUAL.STADIUM.GOAL.TUNNEL_RIBS; depth++) {
    const z = THREE.MathUtils.lerp(mouthZ, backZ, depth / VISUAL.STADIUM.GOAL.TUNNEL_RIBS);
    line(new THREE.Vector3(-halfWidth, height, z), new THREE.Vector3(halfWidth, height, z));
    line(new THREE.Vector3(-halfWidth, 0, z), new THREE.Vector3(-halfWidth, height, z));
    line(new THREE.Vector3(halfWidth, 0, z), new THREE.Vector3(halfWidth, height, z));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const grid = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: VISUAL.STADIUM.GOAL.GRID_OPACITY,
      depthWrite: false,
    }),
  );
  grid.name = zSign < 0 ? 'blue-goal-grid' : 'orange-goal-grid';
  return grid;
}

function createGoalTunnel(root: THREE.Group, zSign: number): void {
  const isBlue = zSign < 0;
  const color = isBlue ? VISUAL.PALETTE.BLUE_LIGHT : VISUAL.PALETTE.ORANGE_LIGHT;
  const goalMaterial = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: VISUAL.STADIUM.GOAL.AMBIENT_GLOW,
    roughness: 0.28,
    metalness: 0.64,
  });
  const mouthZ = zSign * ARENA.LENGTH / 2;
  const centerZ = zSign * (ARENA.LENGTH / 2 + ARENA.GOAL.DEPTH / 2);
  const frameThickness = VISUAL.STADIUM.GOAL.FRAME_THICKNESS;

  addBox(
    root,
    `${isBlue ? 'blue' : 'orange'}-goal-floor`,
    new THREE.Vector3(ARENA.GOAL.WIDTH, VISUAL.STADIUM.FIELD.SURFACE_DEPTH, ARENA.GOAL.DEPTH),
    new THREE.Vector3(0, -VISUAL.STADIUM.FIELD.SURFACE_DEPTH / 2, centerZ),
    isBlue ? blueFieldMaterial : orangeFieldMaterial,
    false,
    true,
  );
  addBox(
    root,
    `${isBlue ? 'blue' : 'orange'}-goal-crossbar`,
    new THREE.Vector3(ARENA.GOAL.WIDTH + frameThickness, frameThickness, VISUAL.STADIUM.GOAL.FRAME_DEPTH),
    new THREE.Vector3(0, ARENA.GOAL.HEIGHT, mouthZ),
    goalMaterial,
    false,
    true,
  );
  for (const xSign of [-1, 1]) {
    addBox(
      root,
      `${isBlue ? 'blue' : 'orange'}-goal-post`,
      new THREE.Vector3(frameThickness, ARENA.GOAL.HEIGHT, VISUAL.STADIUM.GOAL.FRAME_DEPTH),
      new THREE.Vector3(xSign * ARENA.GOAL.WIDTH / 2, ARENA.GOAL.HEIGHT / 2, mouthZ),
      goalMaterial,
      false,
      true,
    );
  }

  const ribCount = VISUAL.STADIUM.GOAL.TUNNEL_RIBS * 3;
  const ribs = new THREE.InstancedMesh(UNIT_BOX, structureMidMaterial, ribCount);
  ribs.name = `${isBlue ? 'blue' : 'orange'}-goal-tunnel-ribs`;
  let ribIndex = 0;
  for (let rib = 0; rib < VISUAL.STADIUM.GOAL.TUNNEL_RIBS; rib++) {
    const z = THREE.MathUtils.lerp(
      mouthZ,
      zSign * (ARENA.LENGTH / 2 + ARENA.GOAL.DEPTH),
      rib / (VISUAL.STADIUM.GOAL.TUNNEL_RIBS - 1),
    );
    setInstance(ribs, ribIndex++, new THREE.Vector3(-ARENA.GOAL.WIDTH / 2, ARENA.GOAL.HEIGHT / 2, z), new THREE.Vector3(0.11, ARENA.GOAL.HEIGHT, 0.11));
    setInstance(ribs, ribIndex++, new THREE.Vector3(ARENA.GOAL.WIDTH / 2, ARENA.GOAL.HEIGHT / 2, z), new THREE.Vector3(0.11, ARENA.GOAL.HEIGHT, 0.11));
    setInstance(ribs, ribIndex++, new THREE.Vector3(0, ARENA.GOAL.HEIGHT, z), new THREE.Vector3(ARENA.GOAL.WIDTH, 0.11, 0.11));
  }
  ribs.instanceMatrix.needsUpdate = true;
  root.add(ribs, createGoalGrid(zSign, color));
}

interface StandInstance {
  position: THREE.Vector3;
  scale: THREE.Vector3;
  color: THREE.Color;
}

function createStands(root: THREE.Group): void {
  const seats: StandInstance[] = [];
  const platforms: Array<{ position: THREE.Vector3; scale: THREE.Vector3 }> = [];
  const rowCount = VISUAL.STADIUM.STANDS.TIER_COUNT * VISUAL.STADIUM.STANDS.ROWS_PER_TIER;
  const seatScale = new THREE.Vector3(
    VISUAL.STADIUM.STANDS.SEAT_WIDTH,
    VISUAL.STADIUM.STANDS.SEAT_HEIGHT,
    VISUAL.STADIUM.STANDS.SEAT_DEPTH,
  );

  const colorForPosition = (x: number, z: number, index: number): THREE.Color => {
    const base = z < 0 ? VISUAL.PALETTE.BLUE : VISUAL.PALETTE.ORANGE;
    const color = new THREE.Color(base);
    const variation = ((Math.abs(Math.round(x * 3 + z * 5 + index * 7)) % 7) - 3) * 0.018;
    color.offsetHSL(0, -0.08 + variation, variation);
    return color;
  };

  for (const xSign of [-1, 1]) {
    for (let row = 0; row < rowCount; row++) {
      const tier = Math.floor(row / VISUAL.STADIUM.STANDS.ROWS_PER_TIER);
      const x = xSign * (
        ARENA.WIDTH / 2
        + VISUAL.STADIUM.STANDS.SIDE_OFFSET
        + row * VISUAL.STADIUM.STANDS.ROW_DEPTH
      );
      const y = 0.8 + row * VISUAL.STADIUM.STANDS.ROW_RISE + tier * 0.55;
      platforms.push({
        position: new THREE.Vector3(x, y - 0.22, 0),
        scale: new THREE.Vector3(VISUAL.STADIUM.STANDS.ROW_DEPTH, 0.22, ARENA.LENGTH + 6),
      });

      for (let seat = 0; seat < VISUAL.STADIUM.STANDS.SEATS_PER_SIDE; seat++) {
        const z = THREE.MathUtils.lerp(-ARENA.LENGTH / 2 - 1.5, ARENA.LENGTH / 2 + 1.5, seat / (VISUAL.STADIUM.STANDS.SEATS_PER_SIDE - 1));
        seats.push({
          position: new THREE.Vector3(x, y, z),
          scale: seatScale,
          color: colorForPosition(x, z, seat + row),
        });
      }
    }
  }

  for (const zSign of [-1, 1]) {
    for (let row = 0; row < rowCount; row++) {
      const tier = Math.floor(row / VISUAL.STADIUM.STANDS.ROWS_PER_TIER);
      const z = zSign * (
        ARENA.LENGTH / 2
        + ARENA.GOAL.DEPTH
        + VISUAL.STADIUM.STANDS.END_OFFSET
        + row * VISUAL.STADIUM.STANDS.ROW_DEPTH
      );
      const y = 0.8 + row * VISUAL.STADIUM.STANDS.ROW_RISE + tier * 0.55;
      platforms.push({
        position: new THREE.Vector3(0, y - 0.22, z),
        scale: new THREE.Vector3(ARENA.WIDTH + 5, 0.22, VISUAL.STADIUM.STANDS.ROW_DEPTH),
      });

      for (let seat = 0; seat < VISUAL.STADIUM.STANDS.SEATS_PER_END; seat++) {
        const x = THREE.MathUtils.lerp(-ARENA.WIDTH / 2 - 1.5, ARENA.WIDTH / 2 + 1.5, seat / (VISUAL.STADIUM.STANDS.SEATS_PER_END - 1));
        seats.push({
          position: new THREE.Vector3(x, y, z),
          scale: seatScale,
          color: colorForPosition(x, z, seat + row),
        });
      }
    }
  }

  const seatMesh = new THREE.InstancedMesh(UNIT_BOX, seatMaterial, seats.length);
  seatMesh.name = 'instanced-spectator-seats';
  seats.forEach((seat, index) => {
    setInstance(seatMesh, index, seat.position, seat.scale);
    seatMesh.setColorAt(index, seat.color);
  });
  seatMesh.instanceMatrix.needsUpdate = true;
  if (seatMesh.instanceColor) seatMesh.instanceColor.needsUpdate = true;
  root.add(seatMesh);

  const platformMesh = new THREE.InstancedMesh(UNIT_BOX, structureMaterial, platforms.length);
  platformMesh.name = 'instanced-stand-risers';
  platforms.forEach((platform, index) => {
    setInstance(platformMesh, index, platform.position, platform.scale);
  });
  platformMesh.instanceMatrix.needsUpdate = true;
  platformMesh.receiveShadow = true;
  root.add(platformMesh);
}

function createTrusses(root: THREE.Group): void {
  const archCount = VISUAL.STADIUM.STRUCTURE.ARCH_COUNT;
  const radius = ARENA.WIDTH / 2 + VISUAL.STADIUM.STRUCTURE.ARCH_RADIUS_PADDING;
  const archGeometry = new THREE.TorusGeometry(
    radius,
    VISUAL.STADIUM.STRUCTURE.ARCH_TUBE_RADIUS,
    6,
    48,
    Math.PI,
  );
  const arches = new THREE.InstancedMesh(archGeometry, structureMidMaterial, archCount);
  arches.name = 'instanced-stadium-arches';
  for (let index = 0; index < archCount; index++) {
    const z = THREE.MathUtils.lerp(-ARENA.LENGTH / 2 - 2, ARENA.LENGTH / 2 + 2, index / (archCount - 1));
    setInstance(arches, index, new THREE.Vector3(0, 0, z), new THREE.Vector3(1, 1, 1));
  }
  arches.instanceMatrix.needsUpdate = true;
  root.add(arches);

  for (const xSign of [-1, 1]) {
    addBox(
      root,
      'upper-catwalk',
      new THREE.Vector3(VISUAL.STADIUM.STRUCTURE.CATWALK_WIDTH, 0.18, ARENA.LENGTH + 8),
      new THREE.Vector3(
        xSign * (ARENA.WIDTH / 2 + VISUAL.STADIUM.STANDS.SIDE_OFFSET),
        VISUAL.STADIUM.STRUCTURE.RING_HEIGHT,
        0,
      ),
      structureMaterial,
    );
  }
}

function createFloodlightBanks(root: THREE.Group): void {
  const bankPositions: THREE.Vector3[] = [];
  for (const xSign of [-1, 1]) {
    for (let bank = 0; bank < VISUAL.STADIUM.LIGHTS.BANKS_PER_SIDE; bank++) {
      bankPositions.push(new THREE.Vector3(
        xSign * (ARENA.WIDTH / 2 + 2.1),
        VISUAL.STADIUM.LIGHTS.BANK_HEIGHT,
        THREE.MathUtils.lerp(-ARENA.LENGTH * 0.36, ARENA.LENGTH * 0.36, bank / (VISUAL.STADIUM.LIGHTS.BANKS_PER_SIDE - 1)),
      ));
    }
  }

  const backs = new THREE.InstancedMesh(UNIT_BOX, structureMaterial, bankPositions.length);
  backs.name = 'floodlight-bank-housings';
  bankPositions.forEach((position, index) => {
    setInstance(backs, index, position, new THREE.Vector3(0.18, 1.35, 3.2));
  });
  backs.instanceMatrix.needsUpdate = true;
  root.add(backs);

  const lampCount = bankPositions.length * VISUAL.STADIUM.LIGHTS.LAMPS_PER_BANK;
  const lamps = new THREE.InstancedMesh(UNIT_BOX, lampMaterial, lampCount);
  lamps.name = 'instanced-floodlight-lamps';
  let lampIndex = 0;
  for (const bankPosition of bankPositions) {
    for (let lamp = 0; lamp < VISUAL.STADIUM.LIGHTS.LAMPS_PER_BANK; lamp++) {
      const zOffset = THREE.MathUtils.lerp(-1.15, 1.15, lamp / (VISUAL.STADIUM.LIGHTS.LAMPS_PER_BANK - 1));
      setInstance(
        lamps,
        lampIndex++,
        new THREE.Vector3(bankPosition.x * 0.997, bankPosition.y, bankPosition.z + zOffset),
        new THREE.Vector3(
          VISUAL.STADIUM.LIGHTS.LAMP_SIZE * 0.45,
          VISUAL.STADIUM.LIGHTS.LAMP_SIZE,
          VISUAL.STADIUM.LIGHTS.LAMP_SIZE,
        ),
      );
    }
  }
  lamps.instanceMatrix.needsUpdate = true;
  root.add(lamps);
}

function createPixelWord(word: string, maxWidth: number, maxHeight: number, color: number): THREE.InstancedMesh {
  const glyphWidth = 5;
  const glyphHeight = 7;
  const letterGap = 1;
  const columns = word.length * (glyphWidth + letterGap) - letterGap;
  const cellSize = Math.min(maxWidth / columns, maxHeight / glyphHeight);
  const activeCells: Array<{ x: number; y: number }> = [];

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

  const cellGeometry = new THREE.BoxGeometry(cellSize * 0.68, cellSize * 0.68, 0.06);
  const material = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 1.25,
    roughness: 0.22,
    metalness: 0.38,
  });
  const text = new THREE.InstancedMesh(cellGeometry, material, activeCells.length);
  activeCells.forEach((cell, index) => {
    setInstance(text, index, new THREE.Vector3(cell.x, cell.y, 0), new THREE.Vector3(1, 1, 1));
  });
  text.instanceMatrix.needsUpdate = true;
  return text;
}

function createScoreboard(root: THREE.Group, zSign: number): void {
  const group = new THREE.Group();
  group.name = `${zSign < 0 ? 'blue' : 'orange'}-rocket-arena-scoreboard`;
  const width = VISUAL.STADIUM.SCOREBOARD.WIDTH;
  const height = VISUAL.STADIUM.SCOREBOARD.HEIGHT;
  const depth = VISUAL.STADIUM.SCOREBOARD.DEPTH;
  const color = zSign < 0 ? VISUAL.PALETTE.BLUE_LIGHT : VISUAL.PALETTE.ORANGE_LIGHT;

  addBox(
    group,
    'scoreboard-panel',
    new THREE.Vector3(width, height, depth),
    new THREE.Vector3(0, 0, 0),
    structureMaterial,
    true,
  );
  addBox(
    group,
    'scoreboard-header-rule',
    new THREE.Vector3(width * 0.9, 0.05, depth * 0.12),
    new THREE.Vector3(0, 0, depth / 2 + 0.035),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8 }),
  );

  const rocket = createPixelWord('ROCKET', width * 0.78, height * 0.34, VISUAL.PALETTE.WHITE_LIGHT);
  rocket.name = 'rocket-wordmark';
  rocket.position.set(0, height * 0.23, depth / 2 + 0.08);
  const arena = createPixelWord('ARENA', width * 0.62, height * 0.3, color);
  arena.name = 'arena-wordmark';
  arena.position.set(0, -height * 0.23, depth / 2 + 0.08);
  group.add(rocket, arena);

  group.position.set(
    0,
    VISUAL.STADIUM.SCOREBOARD.Y,
    zSign * (ARENA.LENGTH / 2 + ARENA.GOAL.DEPTH + VISUAL.STADIUM.STANDS.END_OFFSET + 1.3),
  );
  if (zSign > 0) group.rotation.y = Math.PI;
  root.add(group);
}

function createAtmosphere(root: THREE.Group): void {
  const count = VISUAL.STADIUM.ATMOSPHERE.PARTICLE_COUNT;
  const positions = new Float32Array(count * 3);
  let seed = 0x524f434b;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let index = 0; index < count; index++) {
    positions[index * 3] = (random() - 0.5) * (ARENA.WIDTH + 28);
    positions[index * 3 + 1] = THREE.MathUtils.lerp(
      VISUAL.STADIUM.ATMOSPHERE.PARTICLE_MIN_Y,
      VISUAL.STADIUM.ATMOSPHERE.PARTICLE_MAX_Y,
      random(),
    );
    positions[index * 3 + 2] = (random() - 0.5) * (ARENA.LENGTH + 32);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const particles = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: VISUAL.PALETTE.WHITE_LIGHT,
      size: 0.08,
      transparent: true,
      opacity: VISUAL.STADIUM.ATMOSPHERE.PARTICLE_OPACITY,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  particles.name = 'stadium-atmosphere';
  root.add(particles);
}

/** Create the collider-aligned, enclosed Rocket Arena orbital foundry stadium. */
export function createArena(scene: THREE.Scene): THREE.Group {
  const root = new THREE.Group();
  root.name = 'rocket-arena-stadium';

  createField(root);
  createPerimeter(root);
  createGoalTunnel(root, -1);
  createGoalTunnel(root, 1);
  createStands(root);
  createTrusses(root);
  createFloodlightBanks(root);
  createScoreboard(root, -1);
  createScoreboard(root, 1);
  createAtmosphere(root);

  scene.add(root);
  return root;
}
