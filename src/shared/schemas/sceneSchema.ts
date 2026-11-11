import { SCHEMA_VERSION, type TransformData, type UUID } from './common';
import type { ComponentDefinition } from './componentDefinition';
import { createDefaultPlcTagMap, type PlcTagMap } from './plcTagMap';
import { createEmptyTransportGraph, type TransportGraph } from './transportGraph';

/**
 * Complete Factory Digital Twin Layout Scene Schema (.vcscene.json / .json)
 */

export interface SceneMetadata {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  units: 'meters';
  editorVersion: string;
}

export interface SceneEnvironmentConfig {
  showGrid: boolean;
  showSnapPorts: boolean;
  /** Show 3D Spline Paths, Sensor Laser Beams, and Flow Portals */
  showTransportPaths?: boolean;
  snapEnabled: boolean;
  /** Magnetic port capture radius in meters */
  snapRadiusMeters: number;
  /** Automatically align mating normals opposite each other when snapping */
  autoAlignPortRotation: boolean;
  simSpeedMultiplier: number;
}

export interface SceneNodeInstance {
  id: UUID;
  name: string;
  componentId: UUID;
  transform: TransformData;
  visible: boolean;
  locked: boolean;
  /** Instance-specific parameter overrides (belt speed, stroke speed, spawner rate, etc.) */
  parameters: Record<string, number | boolean | string>;
}

export interface SnapConnectionRecord {
  id: UUID;
  sourceInstanceId: UUID;
  sourcePortId: UUID;
  targetInstanceId: UUID;
  targetPortId: UUID;
  snappedAt: string;
}

export interface SceneSchema {
  schemaVersion: string;
  metadata: SceneMetadata;
  environment: SceneEnvironmentConfig;
  /** Embedded component library definitions so saved .json layouts are self-contained */
  componentLibrary: ComponentDefinition[];
  /** Placed 3D machine instances in the factory layout */
  instances: SceneNodeInstance[];
  /** Active magnetic port-to-port connections between instances */
  snapConnections: SnapConnectionRecord[];
  /** Directed spline material flow graph (Milestone 3) */
  transportGraph: TransportGraph;
  /** PLC driver configuration & tag binding table (Milestone 4) */
  plcTagMap: PlcTagMap;
}

export function createEmptySceneSchema(
  builtinCatalog: ComponentDefinition[] = []
): SceneSchema {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    metadata: {
      name: 'Untitled Factory Layout',
      description: 'Standalone 3D Virtual Commissioning Layout',
      createdAt: now,
      updatedAt: now,
      units: 'meters',
      editorVersion: '1.0.0-m4',
    },
    environment: {
      showGrid: true,
      showSnapPorts: true,
      showTransportPaths: true,
      snapEnabled: true,
      snapRadiusMeters: 0.45,
      autoAlignPortRotation: true,
      simSpeedMultiplier: 1.0,
    },
    componentLibrary: builtinCatalog,
    instances: [],
    snapConnections: [],
    transportGraph: createEmptyTransportGraph(),
    plcTagMap: createDefaultPlcTagMap(),
  };
}

export function isValidSceneSchema(candidate: unknown): candidate is SceneSchema {
  if (!candidate || typeof candidate !== 'object') return false;
  const obj = candidate as Record<string, unknown>;
  return (
    typeof obj.schemaVersion === 'string' &&
    typeof obj.metadata === 'object' &&
    obj.metadata !== null &&
    typeof obj.environment === 'object' &&
    obj.environment !== null &&
    Array.isArray(obj.componentLibrary) &&
    Array.isArray(obj.instances) &&
    Array.isArray(obj.snapConnections)
  );
}
