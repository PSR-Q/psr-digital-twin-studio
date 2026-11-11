import * as THREE from 'three';
import { unzipSync, zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';
import {
  SCHEMA_VERSION,
  type BoundingBoxData,
  type ComponentDefinition,
  type ModelFormat,
  type SnapPortDefinition,
  type SubMeshRoleAssignment,
} from '../shared/schemas';

/**
 * Unified Industrial 3D Asset Pipeline (glTF 2.0 + OpenUSD)
 * - glTF 2.0: .glb, .gltf (with Meshopt, Draco WASM, and KTX2/Basis WASM decoders)
 * - OpenUSD:  .usd, .usda (ASCII), .usdc (Binary Crate PXR-USDC), .usdz (AOUSD Package)
 * Works identically inside packaged Windows .exe (file:// ASAR) and Cloud Web Preview.
 */

export const SUPPORTED_3D_MODEL_EXTENSIONS = [
  '.glb',
  '.gltf',
  '.usd',
  '.usda',
  '.usdc',
  '.usdz',
] as const;

export interface ParsedGlbAsset {
  sceneTemplate: THREE.Group;
  boundingBox: BoundingBoxData;
  subMeshNames: string[];
  groundOffsetY: number;
}

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('./draco/');

const ktx2Loader = new KTX2Loader();
ktx2Loader.setTranscoderPath('./basis/');

const gltfLoader = new GLTFLoader();
gltfLoader.setMeshoptDecoder(MeshoptDecoder);
gltfLoader.setDRACOLoader(dracoLoader);
gltfLoader.setKTX2Loader(ktx2Loader);

const usdLoader = new USDLoader();

let ktx2Configured = false;
export function configureGlbRendererSupport(renderer: THREE.WebGLRenderer): void {
  if (ktx2Configured) return;
  ktx2Configured = true;
  ktx2Loader.detectSupport(renderer);
}

const parsedCache = new Map<string, Promise<ParsedGlbAsset>>();

export function isSupported3dModelFile(fileName: string): boolean {
  const lower = fileName.trim().toLowerCase();
  return SUPPORTED_3D_MODEL_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isUsdFormat(format: ModelFormat): boolean {
  return (
    format === 'usd' ||
    format === 'usda' ||
    format === 'usdc' ||
    format === 'usdz'
  );
}

/**
 * Detects exact 3D format from filename extension and optional binary magic bytes
 * (`glTF`, `PXR-USDC`, `PK\x03\x04`, or `#usda`).
 */
export function detectModelFormat(
  fileName: string,
  buffer?: ArrayBuffer
): ModelFormat {
  if (buffer && buffer.byteLength >= 8) {
    const magic = new Uint8Array(buffer, 0, 8);
    // 'glTF' binary header (0x67 0x6C 0x54 0x46)
    if (
      magic[0] === 0x67 &&
      magic[1] === 0x6c &&
      magic[2] === 0x54 &&
      magic[3] === 0x46
    ) {
      return 'glb';
    }
    // 'PXR-USDC' Crate header
    if (
      magic[0] === 0x50 &&
      magic[1] === 0x58 &&
      magic[2] === 0x52 &&
      magic[3] === 0x2d &&
      magic[4] === 0x55 &&
      magic[5] === 0x53 &&
      magic[6] === 0x44 &&
      magic[7] === 0x43
    ) {
      return 'usdc';
    }
    // ZIP / USDZ header ('PK')
    if (magic[0] === 0x50 && magic[1] === 0x4b) {
      return 'usdz';
    }
    // '#usda' ASCII header (allowing optional UTF-8 BOM)
    const headStr = new TextDecoder()
      .decode(new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength)))
      .trimStart();
    if (headStr.startsWith('#usda')) {
      return 'usda';
    }
  }

  const lower = fileName.trim().toLowerCase();
  if (lower.endsWith('.usdz')) return 'usdz';
  if (lower.endsWith('.usdc')) return 'usdc';
  if (lower.endsWith('.usda')) return 'usda';
  if (lower.endsWith('.usd')) return 'usd';
  if (lower.endsWith('.gltf')) return 'gltf';
  return 'glb';
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode(...slice));
  }
  return btoa(chunks.join(''));
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Normalizes non-strict .usdz archives that place a folder entry (e.g. `robot/`)
 * before the root `.usd`/`.usda`/`.usdc` layer so Three.js USDLoader accepts them.
 */
function normalizeUsdzArchiveBuffer(buffer: ArrayBuffer): ArrayBuffer {
  const unzipped = unzipSync(new Uint8Array(buffer));
  const entries = Object.entries(unzipped).filter(
    ([name, data]) => !name.endsWith('/') && data.byteLength > 0
  );

  const rootIdx = entries.findIndex(([name]) =>
    /\.(usd|usda|usdc)$/i.test(name)
  );
  if (rootIdx <= 0) {
    if (rootIdx === 0) {
      const ordered: Record<string, Uint8Array> = {};
      for (const [k, v] of entries) ordered[k] = v;
      const zipped = zipSync(ordered, { level: 0 });
      return zipped.buffer.slice(
        zipped.byteOffset,
        zipped.byteOffset + zipped.byteLength
      ) as ArrayBuffer;
    }
    return buffer;
  }

  const [rootEntry] = entries.splice(rootIdx, 1);
  const reordered: Record<string, Uint8Array> = {
    [rootEntry[0]]: rootEntry[1],
  };
  for (const [k, v] of entries) {
    reordered[k] = v;
  }
  const repacked = zipSync(reordered, { level: 0 });
  return repacked.buffer.slice(
    repacked.byteOffset,
    repacked.byteOffset + repacked.byteLength
  ) as ArrayBuffer;
}

function runUsdParsePromise(buffer: ArrayBuffer): Promise<THREE.Group> {
  return new Promise<THREE.Group>((resolve, reject) => {
    try {
      usdLoader.parse(
        buffer,
        '',
        (group) => resolve(group),
        (err) => reject(err)
      );
    } catch (err) {
      reject(err);
    }
  });
}

async function parseUsdBufferAsync(buffer: ArrayBuffer): Promise<THREE.Group> {
  let usdStageGroup: THREE.Group;
  try {
    usdStageGroup = await runUsdParsePromise(buffer.slice(0));
  } catch (firstErr) {
    const bytes = new Uint8Array(buffer);
    const isZip = bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (isZip) {
      const normalized = normalizeUsdzArchiveBuffer(buffer);
      usdStageGroup = await runUsdParsePromise(normalized);
    } else {
      throw firstErr;
    }
  }

  // Wrap USD stage group inside a clean Y-up 1:1 wrapper so any Z-up rotation (-90 deg X)
  // or metersPerUnit scale applied by USDComposer stays encapsulated cleanly.
  const wrapper = new THREE.Group();
  wrapper.name = 'OpenUSD_StageRoot';
  wrapper.add(usdStageGroup);
  return wrapper;
}

function inspectSceneGraph(rawRoot: THREE.Group): ParsedGlbAsset {
  const root = rawRoot || new THREE.Group();
  root.updateMatrixWorld(true);

  // Strip embedded stage lights (common in Omniverse / Blender OpenUSD exports)
  // so imported machines never wash out the 3D Viewport's calibrated studio lighting.
  const embeddedLights: THREE.Object3D[] = [];
  root.traverse((obj) => {
    if ((obj as THREE.Light).isLight) {
      embeddedLights.push(obj);
    }
  });
  for (const light of embeddedLights) {
    light.parent?.remove(light);
  }

  const subMeshNames: string[] = [];
  let unnamedIndex = 1;
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (mesh.geometry && !mesh.geometry.attributes.normal) {
        mesh.geometry.computeVertexNormals();
      }
      if (!mesh.name) {
        mesh.name = mesh.parent?.name || `SubMesh_${unnamedIndex++}`;
      }
      if (!subMeshNames.includes(mesh.name)) {
        subMeshNames.push(mesh.name);
      }
    }
  });

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) {
    box.min.set(-0.25, 0, -0.25);
    box.max.set(0.25, 0.5, 0.25);
  }
  const size = new THREE.Vector3();
  box.getSize(size);

  // If an imported CAD .glb or OpenUSD asset has its bottom below Y=0 (e.g. centered at origin),
  // lift it cleanly onto the Y=0 factory floor.
  const groundOffsetY = box.min.y < -0.001 ? -box.min.y : 0;
  if (groundOffsetY > 0) {
    root.position.y += groundOffsetY;
    root.updateMatrixWorld(true);
    box.setFromObject(root);
    box.getSize(size);
  }

  return {
    sceneTemplate: root,
    boundingBox: {
      min: [
        Number(box.min.x.toFixed(4)),
        Number(box.min.y.toFixed(4)),
        Number(box.min.z.toFixed(4)),
      ],
      max: [
        Number(box.max.x.toFixed(4)),
        Number(box.max.y.toFixed(4)),
        Number(box.max.z.toFixed(4)),
      ],
      size: [
        Number(size.x.toFixed(4)),
        Number(size.y.toFixed(4)),
        Number(size.z.toFixed(4)),
      ],
    },
    subMeshNames,
    groundOffsetY,
  };
}

export function loadComponentGlbAsset(
  component: ComponentDefinition
): Promise<ParsedGlbAsset> {
  const cacheKey = `${component.id}:${component.modelSource.uri}:${component.modelSource.byteLength ?? 0}`;
  const existing = parsedCache.get(cacheKey);
  if (existing) return existing;

  const task = (async (): Promise<ParsedGlbAsset> => {
    if (component.modelSource.embeddedBase64) {
      const buffer = base64ToArrayBuffer(component.modelSource.embeddedBase64);
      const format =
        component.modelSource.format ??
        detectModelFormat(component.modelSource.fileName, buffer);

      if (isUsdFormat(format)) {
        const usdRoot = await parseUsdBufferAsync(buffer);
        return inspectSceneGraph(usdRoot);
      }

      const gltf = await gltfLoader.parseAsync(buffer, '');
      return inspectSceneGraph(gltf.scene);
    }

    const format =
      component.modelSource.format ??
      detectModelFormat(
        component.modelSource.fileName || component.modelSource.uri
      );

    if (isUsdFormat(format)) {
      const fileLoader = new THREE.FileLoader();
      fileLoader.setResponseType('arraybuffer');
      const buffer = (await fileLoader.loadAsync(
        component.modelSource.uri
      )) as ArrayBuffer;
      const usdRoot = await parseUsdBufferAsync(buffer);
      return inspectSceneGraph(usdRoot);
    }

    const gltf = await gltfLoader.loadAsync(component.modelSource.uri);
    return inspectSceneGraph(gltf.scene);
  })();

  parsedCache.set(cacheKey, task);
  return task;
}

/**
 * Builds a complete, snap-ready ComponentDefinition from any imported
 * glTF (.glb/.gltf) or OpenUSD (.usd/.usda/.usdc/.usdz) buffer.
 * Automatically synthesizes calibrated InputPort (-X) and OutputPort (+X) from the model's bounding box
 * so user-dropped 3D files snap together immediately with zero code.
 */
export async function buildComponentDefinitionFromGlbBuffer(
  fileName: string,
  buffer: ArrayBuffer,
  filePath?: string
): Promise<ComponentDefinition> {
  const format = detectModelFormat(fileName, buffer);
  const usdAsset = isUsdFormat(format);
  const base64Data = arrayBufferToBase64(buffer);

  let inspected: ParsedGlbAsset;
  if (usdAsset) {
    const usdRoot = await parseUsdBufferAsync(buffer);
    inspected = inspectSceneGraph(usdRoot);
  } else {
    const gltf = await gltfLoader.parseAsync(buffer.slice(0), '');
    inspected = inspectSceneGraph(gltf.scene);
  }

  const cleanName = fileName
    .replace(/\.(glb|gltf|usd|usda|usdc|usdz)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  const id = `custom-${usdAsset ? 'usd' : 'glb'}-${crypto.randomUUID().slice(0, 8)}`;
  const [minX, minY, minZ] = inspected.boundingBox.min;
  const [maxX, maxY, maxZ] = inspected.boundingBox.max;
  const centerZ = Number(((minZ + maxZ) * 0.5).toFixed(3));
  // Place default mating ports at 0.78m line elevation if tall enough, otherwise 65% height
  const portHeight = Number(
    (maxY >= 0.72 && maxY <= 1.05 ? 0.78 : minY + (maxY - minY) * 0.65).toFixed(3)
  );

  const defaultPorts: SnapPortDefinition[] = [
    {
      id: 'port-in-auto',
      name: 'InPort (-X)',
      role: 'InputPort',
      protocol: 'material-flow',
      localPosition: [minX, portHeight, centerZ],
      localNormal: [-1, 0, 0],
      localUp: [0, 1, 0],
    },
    {
      id: 'port-out-auto',
      name: 'OutPort (+X)',
      role: 'OutputPort',
      protocol: 'material-flow',
      localPosition: [maxX, portHeight, centerZ],
      localNormal: [1, 0, 0],
      localUp: [0, 1, 0],
    },
  ];

  const nodeRoles: Record<string, SubMeshRoleAssignment> = {};
  for (const subName of inspected.subMeshNames) {
    nodeRoles[subName] = {
      role: 'StaticMesh',
      nodeName: subName,
    };
  }

  const formatLabel = usdAsset ? `OpenUSD (${format.toUpperCase()})` : format.toUpperCase();

  const definition: ComponentDefinition = {
    id,
    schemaVersion: SCHEMA_VERSION,
    name: cleanName || (usdAsset ? 'Imported OpenUSD Machine' : 'Imported GLB Machine'),
    category: 'CustomGlb',
    description: `Imported ${formatLabel} from ${fileName} (${inspected.subMeshNames.length} sub-mesh nodes)`,
    modelSource: {
      kind: usdAsset ? 'embedded-usd' : 'embedded-glb',
      uri: filePath ?? `embedded://${fileName}`,
      fileName,
      format,
      embeddedBase64: base64Data,
      byteLength: buffer.byteLength,
    },
    boundingBox: inspected.boundingBox,
    nodeRoles,
    snapPorts: defaultPorts,
    transportPaths: [],
    sensors: [],
    exposedSignals: [],
  };

  // Pre-warm cache
  parsedCache.set(
    `${definition.id}:${definition.modelSource.uri}:${buffer.byteLength}`,
    Promise.resolve(inspected)
  );

  return definition;
}
