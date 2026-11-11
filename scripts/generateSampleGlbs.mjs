import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'sample-models');

/**
 * Generates clean, spec-compliant glTF 2.0 Binary (.glb) industrial machine models
 * with named sub-mesh hierarchies ready for Milestone 1 Snapping & Milestone 2 FK Component Builder.
 */

function createBoxGeometry(sx, sy, sz, offset = [0, 0, 0]) {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const [ox, oy, oz] = offset;

  // 6 faces * 4 vertices = 24 vertices (CCW outward winding in right-handed glTF 2.0)
  const faces = [
    // +X
    { n: [1, 0, 0], v: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    // -X
    { n: [-1, 0, 0], v: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
    // +Y
    { n: [0, 1, 0], v: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    // -Y
    { n: [0, -1, 0], v: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
    // +Z
    { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    // -Z
    { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
  ];

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  faces.forEach((face, fIdx) => {
    const base = fIdx * 4;
    for (const [vx, vy, vz] of face.v) {
      positions.push(vx + ox, vy + oy, vz + oz);
      normals.push(face.n[0], face.n[1], face.n[2]);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

function createCylinderYGeometry(radius, height, segments = 24, offset = [0, 0, 0]) {
  const [ox, oy, oz] = offset;
  const hy = height / 2;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  // Side ring vertices
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const theta = u * Math.PI * 2;
    const cx = Math.cos(theta);
    const cz = Math.sin(theta);

    positions.push(cx * radius + ox, -hy + oy, cz * radius + oz);
    normals.push(cx, 0, cz);
    uvs.push(u, 0);

    positions.push(cx * radius + ox, hy + oy, cz * radius + oz);
    normals.push(cx, 0, cz);
    uvs.push(u, 1);
  }

  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, c, b, d, c);
  }

  // Top cap
  const topCenterIdx = positions.length / 3;
  positions.push(ox, hy + oy, oz);
  normals.push(0, 1, 0);
  uvs.push(0.5, 0.5);
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    positions.push(Math.cos(theta) * radius + ox, hy + oy, Math.sin(theta) * radius + oz);
    normals.push(0, 1, 0);
    uvs.push(0.5 + Math.cos(theta) * 0.5, 0.5 + Math.sin(theta) * 0.5);
  }
  for (let i = 0; i < segments; i++) {
    indices.push(topCenterIdx, topCenterIdx + 1 + i + 1, topCenterIdx + 1 + i);
  }

  // Bottom cap
  const botCenterIdx = positions.length / 3;
  positions.push(ox, -hy + oy, oz);
  normals.push(0, -1, 0);
  uvs.push(0.5, 0.5);
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    positions.push(Math.cos(theta) * radius + ox, -hy + oy, Math.sin(theta) * radius + oz);
    normals.push(0, -1, 0);
    uvs.push(0.5 + Math.cos(theta) * 0.5, 0.5 + Math.sin(theta) * 0.5);
  }
  for (let i = 0; i < segments; i++) {
    indices.push(botCenterIdx, botCenterIdx + 1 + i, botCenterIdx + 1 + i + 1);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

function mergeGeometries(geoms) {
  let totalVerts = 0;
  let totalIdx = 0;
  for (const g of geoms) {
    totalVerts += g.positions.length / 3;
    totalIdx += g.indices.length;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint16Array(totalIdx);

  let vOffset = 0;
  let iOffset = 0;
  for (const g of geoms) {
    positions.set(g.positions, vOffset * 3);
    normals.set(g.normals, vOffset * 3);
    uvs.set(g.uvs, vOffset * 2);
    for (let i = 0; i < g.indices.length; i++) {
      indices[iOffset + i] = g.indices[i] + vOffset;
    }
    vOffset += g.positions.length / 3;
    iOffset += g.indices.length;
  }

  return { positions, normals, uvs, indices };
}

function computeMinMax(posArray) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < posArray.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = posArray[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

function packGlb({ rootName, parts }) {
  const materials = [];
  const meshes = [];
  const nodes = [];
  const bufferViews = [];
  const accessors = [];
  const binChunks = [];
  let byteOffset = 0;

  function appendAligned(typedArr) {
    const raw = Buffer.from(typedArr.buffer, typedArr.byteOffset, typedArr.byteLength);
    const pad = (4 - (raw.length % 4)) % 4;
    const padded = pad > 0 ? Buffer.concat([raw, Buffer.alloc(pad)]) : raw;
    const start = byteOffset;
    binChunks.push(padded);
    byteOffset += padded.length;
    return { byteOffset: start, byteLength: raw.length };
  }

  const childIndices = [];

  parts.forEach((part, idx) => {
    materials.push({
      name: `${part.name}_Mat`,
      pbrMetallicRoughness: {
        baseColorFactor: part.color,
        metallicFactor: part.metallic ?? 0.45,
        roughnessFactor: part.roughness ?? 0.45,
      },
    });

    const { positions, normals, uvs, indices } = part.geometry;
    const posSlice = appendAligned(positions);
    const normSlice = appendAligned(normals);
    const uvSlice = appendAligned(uvs);
    const idxSlice = appendAligned(indices);

    const bvBase = bufferViews.length;
    bufferViews.push(
      { buffer: 0, byteOffset: posSlice.byteOffset, byteLength: posSlice.byteLength, target: 34962 },
      { buffer: 0, byteOffset: normSlice.byteOffset, byteLength: normSlice.byteLength, target: 34962 },
      { buffer: 0, byteOffset: uvSlice.byteOffset, byteLength: uvSlice.byteLength, target: 34962 },
      { buffer: 0, byteOffset: idxSlice.byteOffset, byteLength: idxSlice.byteLength, target: 34963 }
    );

    const { min, max } = computeMinMax(positions);
    const accBase = accessors.length;
    accessors.push(
      {
        bufferView: bvBase,
        componentType: 5126,
        count: positions.length / 3,
        type: 'VEC3',
        min,
        max,
      },
      {
        bufferView: bvBase + 1,
        componentType: 5126,
        count: normals.length / 3,
        type: 'VEC3',
      },
      {
        bufferView: bvBase + 2,
        componentType: 5126,
        count: uvs.length / 2,
        type: 'VEC2',
      },
      {
        bufferView: bvBase + 3,
        componentType: 5123,
        count: indices.length,
        type: 'SCALAR',
      }
    );

    meshes.push({
      name: `${part.name}_Mesh`,
      primitives: [
        {
          attributes: {
            POSITION: accBase,
            NORMAL: accBase + 1,
            TEXCOORD_0: accBase + 2,
          },
          indices: accBase + 3,
          material: idx,
        },
      ],
    });

    const nodeIdx = nodes.length;
    nodes.push({
      name: part.name,
      mesh: idx,
      translation: part.translation ?? [0, 0, 0],
    });
    childIndices.push(nodeIdx);
  });

  const rootIdx = nodes.length;
  nodes.push({
    name: rootName,
    children: childIndices,
  });

  const binBuffer = Buffer.concat(binChunks);

  const gltfJson = {
    asset: { version: '2.0', generator: 'VC-Digital-Twin-Studio-AssetGen' },
    scene: 0,
    scenes: [{ name: rootName, nodes: [rootIdx] }],
    nodes,
    meshes,
    materials,
    bufferViews,
    accessors,
    buffers: [{ byteLength: binBuffer.length }],
  };

  const jsonRaw = Buffer.from(JSON.stringify(gltfJson), 'utf-8');
  const jsonPad = (4 - (jsonRaw.length % 4)) % 4;
  const jsonBuffer =
    jsonPad > 0
      ? Buffer.concat([jsonRaw, Buffer.alloc(jsonPad, 0x20)])
      : jsonRaw;

  const totalLength = 12 + 8 + jsonBuffer.length + 8 + binBuffer.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(jsonBuffer.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(binBuffer.length, 0);
  binChunkHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'

  return Buffer.concat([
    header,
    jsonChunkHeader,
    jsonBuffer,
    binChunkHeader,
    binBuffer,
  ]);
}

function buildConveyorGlb(lengthM, rootName) {
  const widthM = 0.62;
  const beltHeightM = 0.78;
  const legX = lengthM / 2 - 0.18;
  const legZ = widthM / 2 - 0.05;

  const frameGeom = mergeGeometries([
    // Side rails
    createBoxGeometry(lengthM, 0.12, 0.05, [0, beltHeightM - 0.05, widthM / 2 - 0.025]),
    createBoxGeometry(lengthM, 0.12, 0.05, [0, beltHeightM - 0.05, -widthM / 2 + 0.025]),
    // 4 heavy-duty support legs + footplates
    createBoxGeometry(0.07, beltHeightM - 0.08, 0.07, [-legX, (beltHeightM - 0.08) / 2, legZ]),
    createBoxGeometry(0.07, beltHeightM - 0.08, 0.07, [-legX, (beltHeightM - 0.08) / 2, -legZ]),
    createBoxGeometry(0.07, beltHeightM - 0.08, 0.07, [legX, (beltHeightM - 0.08) / 2, legZ]),
    createBoxGeometry(0.07, beltHeightM - 0.08, 0.07, [legX, (beltHeightM - 0.08) / 2, -legZ]),
    createBoxGeometry(0.06, 0.05, widthM - 0.08, [-legX, 0.22, 0]),
    createBoxGeometry(0.06, 0.05, widthM - 0.08, [legX, 0.22, 0]),
  ]);

  const beltGeom = createBoxGeometry(lengthM - 0.04, 0.035, widthM - 0.11, [0, 0, 0]);
  const driveMotorGeom = mergeGeometries([
    createBoxGeometry(0.22, 0.2, 0.24, [0, 0, 0]),
    createCylinderYGeometry(0.07, 0.18, 18, [0, 0.12, 0]),
  ]);

  return packGlb({
    rootName,
    parts: [
      {
        name: 'Frame_Chassis',
        geometry: frameGeom,
        color: [0.22, 0.26, 0.31, 1.0],
        metallic: 0.65,
        roughness: 0.38,
      },
      {
        name: 'Belt_Surface',
        geometry: beltGeom,
        translation: [0, beltHeightM, 0],
        color: [0.11, 0.14, 0.17, 1.0],
        metallic: 0.12,
        roughness: 0.78,
      },
      {
        name: 'Drive_Motor_Unit',
        geometry: driveMotorGeom,
        translation: [lengthM / 2 - 0.26, beltHeightM - 0.2, widthM / 2 + 0.12],
        color: [0.14, 0.44, 0.62, 1.0],
        metallic: 0.55,
        roughness: 0.35,
      },
    ],
  });
}

function buildPneumaticStopperGlb() {
  const beltHeightM = 0.78;
  const housingGeom = mergeGeometries([
    // Mounting bridge straddling conveyor or bolting beside belt
    createBoxGeometry(0.28, 0.74, 0.14, [0, 0.37, 0]),
    createBoxGeometry(0.22, 0.18, 0.68, [0, beltHeightM - 0.12, 0]),
  ]);

  // LinearAxis target sub-mesh (moves +Y to block workpieces on conveyor)
  const pistonBladeGeom = mergeGeometries([
    createCylinderYGeometry(0.028, 0.24, 18, [0, -0.06, 0]),
    createBoxGeometry(0.035, 0.14, 0.44, [0, 0.08, 0]),
  ]);

  const sensorBeaconGeom = createCylinderYGeometry(0.032, 0.12, 16, [0, 0, 0]);

  return packGlb({
    rootName: 'Pneumatic_Blade_Stopper',
    parts: [
      {
        name: 'Cylinder_Mount_Frame',
        geometry: housingGeom,
        color: [0.25, 0.29, 0.34, 1.0],
        metallic: 0.6,
        roughness: 0.36,
      },
      {
        name: 'Piston_Stopper_Blade_Axis',
        geometry: pistonBladeGeom,
        translation: [0, beltHeightM - 0.02, 0],
        color: [0.92, 0.58, 0.12, 1.0],
        metallic: 0.5,
        roughness: 0.3,
      },
      {
        name: 'Reed_Switch_Status_Lamp',
        geometry: sensorBeaconGeom,
        translation: [0, beltHeightM + 0.18, 0.3],
        color: [0.12, 0.78, 0.48, 1.0],
        metallic: 0.2,
        roughness: 0.25,
      },
    ],
  });
}

function buildMixingTankGlb() {
  const legsGeom = mergeGeometries([
    createCylinderYGeometry(0.05, 0.55, 16, [0.46, 0.275, 0.46]),
    createCylinderYGeometry(0.05, 0.55, 16, [-0.46, 0.275, 0.46]),
    createCylinderYGeometry(0.05, 0.55, 16, [0.46, 0.275, -0.46]),
    createCylinderYGeometry(0.05, 0.55, 16, [-0.46, 0.275, -0.46]),
    // Inlet & Outlet nozzles matching 0.78m process line height
    createBoxGeometry(0.24, 0.1, 0.1, [-0.68, 0.78, 0]),
    createBoxGeometry(0.24, 0.1, 0.1, [0.68, 0.78, 0]),
  ]);

  const vesselGeom = createCylinderYGeometry(0.62, 1.25, 32, [0, 1.05, 0]);

  // RotaryAxis target sub-mesh (spins continuously around [0, 1, 0])
  const agitatorGeom = mergeGeometries([
    createCylinderYGeometry(0.045, 1.45, 18, [0, 0, 0]),
    createBoxGeometry(0.76, 0.08, 0.04, [0, -0.45, 0]),
    createBoxGeometry(0.04, 0.08, 0.76, [0, -0.45, 0]),
    createCylinderYGeometry(0.14, 0.28, 20, [0, 0.78, 0]),
  ]);

  return packGlb({
    rootName: 'Mixing_Tank_Agitator',
    parts: [
      {
        name: 'Tank_Support_Skid',
        geometry: legsGeom,
        color: [0.2, 0.24, 0.29, 1.0],
        metallic: 0.65,
        roughness: 0.4,
      },
      {
        name: 'Stainless_Tank_Vessel',
        geometry: vesselGeom,
        color: [0.64, 0.7, 0.76, 1.0],
        metallic: 0.82,
        roughness: 0.24,
      },
      {
        name: 'Agitator_Impeller_Axis',
        geometry: agitatorGeom,
        translation: [0, 1.22, 0],
        color: [0.14, 0.62, 0.78, 1.0],
        metallic: 0.6,
        roughness: 0.28,
      },
    ],
  });
}

function buildRotaryTurntableGlb() {
  const beltHeightM = 0.78;
  const baseGeom = mergeGeometries([
    createBoxGeometry(0.92, 0.12, 0.92, [0, 0.06, 0]),
    createCylinderYGeometry(0.38, beltHeightM - 0.16, 28, [0, (beltHeightM - 0.16) / 2 + 0.08, 0]),
  ]);

  const platterGeom = mergeGeometries([
    createCylinderYGeometry(0.48, 0.07, 32, [0, -0.02, 0]),
    createBoxGeometry(0.92, 0.035, 0.52, [0, 0.02, 0]),
    createBoxGeometry(0.92, 0.07, 0.04, [0, 0.05, 0.28]),
    createBoxGeometry(0.92, 0.07, 0.04, [0, 0.05, -0.28]),
  ]);

  return packGlb({
    rootName: 'Rotary_Turntable_Module',
    parts: [
      {
        name: 'Turntable_Pedestal_Base',
        geometry: baseGeom,
        color: [0.21, 0.25, 0.3, 1.0],
        metallic: 0.62,
        roughness: 0.38,
      },
      {
        name: 'Turntable_Index_Deck_Axis',
        geometry: platterGeom,
        translation: [0, beltHeightM - 0.02, 0],
        color: [0.16, 0.52, 0.68, 1.0],
        metallic: 0.52,
        roughness: 0.34,
      },
    ],
  });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const files = [
    ['belt-conveyor-2m.glb', buildConveyorGlb(2.0, 'Belt_Conveyor_2m')],
    ['belt-conveyor-1m.glb', buildConveyorGlb(1.0, 'Belt_Conveyor_1m')],
    ['pneumatic-stopper.glb', buildPneumaticStopperGlb()],
    ['mixing-tank-agitator.glb', buildMixingTankGlb()],
    ['rotary-turntable.glb', buildRotaryTurntableGlb()],
  ];

  for (const [filename, buf] of files) {
    const outPath = path.join(OUT_DIR, filename);
    await fs.writeFile(outPath, buf);
    console.log(`Generated ${filename} (${buf.byteLength} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
