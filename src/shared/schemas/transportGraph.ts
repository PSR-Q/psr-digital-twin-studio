import type { UUID, Vector3Tuple } from './common';

/**
 * Directed Spline-Guided Material Flow Graph Schema (Milestone 3 Ready)
 * Models 1D conveyor kinematics, zero-jitter part accumulation, path sensors, and virtual HSC encoders.
 */

export interface TransportPathNode {
  id: UUID;
  instanceId: UUID;
  componentPathId: UUID;
  /** Local-space waypoints transformed at runtime via instance world matrix */
  localWaypoints: Vector3Tuple[];
  interpolation: 'catmull-rom' | 'polyline';
  /** Cached arc-length in millimeters */
  arcLengthMm: number;
  nominalSpeedMmPerSec: number;
  /** Optional binary buffer slot driving belt speed or run bit */
  runBitSlot?: number;
  speedRealSlot?: number;
  stopperActiveBitSlot?: number;
  stopperOffsetMm?: number;
}

export interface TransportGraphEdge {
  id: UUID;
  fromPathNodeId: UUID;
  fromInstanceId: UUID;
  fromPortId: UUID;
  toPathNodeId: UUID;
  toInstanceId: UUID;
  toPortId: UUID;
}

export interface PathSensorBinding {
  id: UUID;
  name: string;
  instanceId: UUID;
  pathNodeId: UUID;
  /** Distance from path start in millimeters (s_sensor) */
  offsetMm: number;
  /** Optional sensing half-window / radius in millimeters */
  detectionRadiusMm?: number;
  sensorType: 'photoelectric' | 'proximity';
  outputBoolSlot: number;
}

export interface PartSourceRuntimeConfig {
  id: UUID;
  instanceId: UUID;
  targetPathNodeId: UUID;
  mode: 'interval' | 'plc-trigger';
  intervalSec: number;
  maxActiveItems?: number;
  triggerBoolSlot?: number;
  spawnedCountDintSlot?: number;
  partDimensionsMm: Vector3Tuple;
  partColorHex: string;
}

export interface PartSinkRuntimeConfig {
  id: UUID;
  instanceId: UUID;
  sourcePathNodeId: UUID;
  countedPartsDintSlot?: number;
}

/**
 * High-Speed Counter (HSC) / Virtual Encoder Emulation Config
 * Computes cumulative DINT32 pulses + FLOAT32 actual position/velocity per scan cycle
 * (never sends raw boolean pulse trains over TCP).
 */
export interface VirtualEncoderConfig {
  id: UUID;
  name: string;
  sourceKind: 'transport-path' | 'linear-axis' | 'rotary-axis';
  targetInstanceId: UUID;
  targetSubKey: string;
  pulsesPerRevolution: number;
  travelMmPerRevolution: number;
  rolloverModulo: number;
  cumulativePulsesDintSlot: number;
  actualPositionRealSlot: number;
  actualVelocityRealSlot: number;
}

export interface FlowItemState {
  id: UUID;
  pathNodeId: UUID;
  /** 1D travel parameter s in millimeters along active path */
  distanceMm: number;
  currentSpeedMmPerSec: number;
  dimensionsMm: Vector3Tuple;
  colorHex: string;
  isAccumulated: boolean;
}

export interface TransportGraph {
  nodes: Record<UUID, TransportPathNode>;
  edges: TransportGraphEdge[];
  sensors: PathSensorBinding[];
  spawners: PartSourceRuntimeConfig[];
  sinks: PartSinkRuntimeConfig[];
  encoders: VirtualEncoderConfig[];
  activeFlowItems?: FlowItemState[];
}

export function createEmptyTransportGraph(): TransportGraph {
  return {
    nodes: {},
    edges: [],
    sensors: [],
    spawners: [],
    sinks: [],
    encoders: [],
    activeFlowItems: [],
  };
}
