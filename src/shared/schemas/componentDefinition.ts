import type { BoundingBoxData, UUID, Vector3Tuple } from './common';

/**
 * Asset Pipeline & Custom Component Builder Schema (.vcomp.json)
 * Defines reusable 3D machine components imported from glTF (.glb/.gltf) or OpenUSD (.usd/.usda/.usdc/.usdz) files.
 */

export type ComponentCategory =
  | 'Conveyors'
  | 'Actuators'
  | 'ProcessEquipment'
  | 'SensorsAndStops'
  | 'CustomGlb';

export type ModelFormat = 'glb' | 'gltf' | 'usd' | 'usda' | 'usdc' | 'usdz';

export interface ModelSourceSpec {
  kind: 'builtin' | 'embedded-glb' | 'embedded-usd' | 'local-file';
  /** Built-in asset path (e.g. ./sample-models/belt-conveyor-2m.glb) or file URI */
  uri: string;
  fileName: string;
  /** Optional explicit 3D asset format ('glb' | 'gltf' | 'usd' | 'usda' | 'usdc' | 'usdz') */
  format?: ModelFormat;
  /** Optional portable Base64-encoded 3D payload (.glb/.gltf/.usd/.usda/.usdc/.usdz) for zero-dependency JSON Scene sharing */
  embeddedBase64?: string;
  byteLength?: number;
}

export type SubMeshRoleType =
  | 'StaticMesh'
  | 'LinearAxis'
  | 'RotaryAxis'
  | 'VisualEffect'
  | 'SnapPort';

export interface PneumaticCylinderPreset {
  presetType: 'PneumaticCylinder';
  actingMode: 'single-acting' | 'double-acting';
  extendSpeedMmPerSec: number;
  retractSpeedMmPerSec: number;
  emitReedSwitches: boolean;
}

export interface ConveyorDrivePreset {
  presetType: 'ConveyorDrive';
  nominalSpeedMmPerSec: number;
  nominalRpm: number;
  allowReverse: boolean;
  useAnalogSpeedPercent: boolean;
  syncUvScrolling: boolean;
}

export interface ServoPositioningPreset {
  presetType: 'ServoPositioning';
  maxVelocityUnitsPerSec: number;
  accelerationUnitsPerSec2: number;
  decelerationUnitsPerSec2: number;
  homeOffset: number;
}

export interface ProcessTankValvePreset {
  presetType: 'ProcessTankValve';
  maxCapacityLiters: number;
  valveTransitionMs: number;
}

export type IndustrialBehaviorPreset =
  | PneumaticCylinderPreset
  | ConveyorDrivePreset
  | ServoPositioningPreset
  | ProcessTankValvePreset;

export interface StaticMeshRole {
  role: 'StaticMesh';
  nodeName: string;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

export interface LinearAxisRole {
  role: 'LinearAxis';
  nodeName: string;
  /** Local normalized direction vector [x, y, z] */
  axis: Vector3Tuple;
  /** Minimum travel in millimeters */
  minLimitMm: number;
  /** Maximum travel in millimeters */
  maxLimitMm: number;
  initialPosMm: number;
  behavior?: PneumaticCylinderPreset | ServoPositioningPreset;
}

export interface RotaryAxisRole {
  role: 'RotaryAxis';
  nodeName: string;
  /** Local normalized rotation axis [x, y, z] */
  axis: Vector3Tuple;
  mode: 'bounded' | 'continuous';
  minDeg: number;
  maxDeg: number;
  defaultRpm: number;
  behavior?: ConveyorDrivePreset | ServoPositioningPreset;
}

export interface VisualEffectRole {
  role: 'VisualEffect';
  nodeName: string;
  effectType: 'uv-scroll' | 'emissive-lamp' | 'particle-spray' | 'tank-level';
  uvScrollAxis?: 'u' | 'v';
  uvScrollScale?: number;
  emissiveOnHex?: string;
  emissiveOffHex?: string;
  behavior?: ProcessTankValvePreset;
}

export type SubMeshRoleAssignment =
  | StaticMeshRole
  | LinearAxisRole
  | RotaryAxisRole
  | VisualEffectRole;

export type SnapPortRole = 'InputPort' | 'OutputPort' | 'Bidirectional';

export type SnapPortProtocol =
  | 'material-flow'
  | 'process-pipe'
  | 'mechanical-mount'
  | 'universal';

export interface SnapPortDefinition {
  id: UUID;
  name: string;
  role: SnapPortRole;
  protocol: SnapPortProtocol;
  /** Position in component local space (meters) */
  localPosition: Vector3Tuple;
  /** Outward mating normal vector in component local space (unit vector pointing away from port face) */
  localNormal: Vector3Tuple;
  /** Local up alignment vector (typically [0, 1, 0]) */
  localUp: Vector3Tuple;
}

export interface ComponentPathTemplate {
  id: UUID;
  name: string;
  inPortId?: UUID;
  outPortId?: UUID;
  /** Ordered local-space waypoints (meters) along transport centerline */
  waypoints: Vector3Tuple[];
  interpolation: 'catmull-rom' | 'polyline';
  defaultSpeedMmPerSec: number;
}

export interface ComponentSensorTemplate {
  id: UUID;
  name: string;
  pathId: UUID;
  /** Normalized offset [0..1] along the referenced ComponentPathTemplate */
  pathOffsetNormalized: number;
  sensorType: 'photoelectric' | 'proximity' | 'reed-switch';
  detectionRadiusMm: number;
}

export interface ComponentFlowEndpointConfig {
  endpointType: 'PartSource' | 'PartSink';
  spawnIntervalSec?: number;
  plcTriggeredSpawn?: boolean;
  partLengthMm?: number;
  partWidthMm?: number;
  partHeightMm?: number;
}

export interface ComponentSignalDescriptor {
  key: string;
  label: string;
  direction: 'PLC_TO_SIM' | 'SIM_TO_PLC';
  dataType: 'BOOL' | 'INT16' | 'DINT32' | 'FLOAT32';
  unit?: string;
  description?: string;
}

export interface ComponentDefinition {
  id: UUID;
  schemaVersion: string;
  name: string;
  category: ComponentCategory;
  description: string;
  modelSource: ModelSourceSpec;
  boundingBox: BoundingBoxData;
  /** Maps sub-mesh node names inside the .glb hierarchy to FK / visual roles */
  nodeRoles: Record<string, SubMeshRoleAssignment>;
  /** Magnetic connector points for 3D port-to-port snapping */
  snapPorts: SnapPortDefinition[];
  /** Spline / polyline material transport templates (Milestone 3) */
  transportPaths: ComponentPathTemplate[];
  /** Path-mounted sensors (Milestone 3) */
  sensors: ComponentSensorTemplate[];
  /** Optional part feeder or sink endpoint behavior (Milestone 3) */
  flowEndpoint?: ComponentFlowEndpointConfig;
  /** Exposed PLC signals automatically available in the Tag Binding Matrix */
  exposedSignals: ComponentSignalDescriptor[];
}
