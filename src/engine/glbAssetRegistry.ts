import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  SCHEMA_VERSION,
  type BoundingBoxData,
  type ComponentDefinition,
  type SnapPortDefinition,
  type SubMeshRoleAssignment,
} from '../shared/schemas';

/**
 * Runtime .glb/.gltf Binary Asset Cache & Portable Base64 Serializer
 * Works identically inside packaged Windows .exe (file:// ASAR) and Web Preview.
 */

export interface ParsedGlbAsset {
  sceneTemplate: THREE.Group;
  boundingBox: BoundingBoxData;
  subMeshNames: string[];
  groundOffsetY: number;
}

const loader = new GLTFLoader();
const parsedCache = new Map<string, Promise<ParsedGlbAsset>>();

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

function inspectGltfScene(gltf: GLTF): ParsedGlbAsset {
  const root = gltf.scene || new THREE.Group();
  root.updateMatrixWorld(true);

  const subMeshNames: string[] = [];
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (mesh.name && !subMeshNames.includes(mesh.name)) {
        subMeshNames.push(mesh.name);
      } else if (mesh.parent?.name && !subMeshNames.includes(mesh.parent.name)) {
        subMeshNames.push(mesh.parent.name);
      }
    }
  });

  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) {
    box.min.set(-0.25, 0, -0.25);
    box.max.set(0.25, 0.5, 0.25);
  }
  const size = new THREE.Vector3();
  box.getSize(size);

  // If an imported CAD .glb has its bottom below/above Y=0 slightly or centered at origin,
  // record groundOffsetY so we can rest imported models cleanly on the factory floor if desired.
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
      const gltf = await loader.parseAsync(buffer, '');
      return inspectGltfScene(gltf);
    }

    const gltf = await loader.loadAsync(component.modelSource.uri);
    return inspectGltfScene(gltf);
  })();

  parsedCache.set(cacheKey, task);
  return task;
}

/**
 * Builds a complete, snap-ready ComponentDefinition from any imported .glb/.gltf binary buffer.
 * Automatically synthesizes calibrated InputPort (-X) and OutputPort (+X) from the model's bounding box
 * so user-dropped .glb files snap together immediately with zero code!
 */
export async function buildComponentDefinitionFromGlbBuffer(
  fileName: string,
  buffer: ArrayBuffer,
  filePath?: string
): Promise<ComponentDefinition> {
  const base64Data = arrayBufferToBase64(buffer);
  const gltf = await loader.parseAsync(buffer.slice(0), '');
  const inspected = inspectGltfScene(gltf);

  const cleanName = fileName
    .replace(/\.(glb|gltf)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  const id = `custom-glb-${ crypto.randomUUID().slice(0, 8) }`;
  const [minX, minY, minZ] = inspected.boundingBox.min;
  const [maxX, maxY, maxZ] = inspected.boundingBox.max;
  const centerZ = Number(((minZ + maxZ) * 0.5).toFixed(3));
  // Place default mating ports at 78% height (or 0.78m if tall enough) for natural line docking
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

  const definition: ComponentDefinition = {
    id,
    schemaVersion: SCHEMA_VERSION,
    name: cleanName || 'Imported GLB Machine',
    category: 'CustomGlb',
    description: `Imported from ${fileName} (${inspected.subMeshNames.length} sub-mesh nodes)`,
    modelSource: {
      kind: 'embedded-glb',
      uri: filePath ?? `embedded://${fileName}`,
      fileName,
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
