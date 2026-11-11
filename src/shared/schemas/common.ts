/**
 * Core geometric and telemetry primitives shared across
 * Renderer (R3F), Electron Main, and UtilityProcess PLC Worker.
 */

export type UUID = string;

/** [x, y, z] in meters (right-handed Y-up coordinate system) */
export type Vector3Tuple = [number, number, number];

/** [rx, ry, rz] Euler angles in degrees (XYZ order for CAD-friendly Inspector UI) */
export type EulerDegTuple = [number, number, number];

/** [x, y, z, w] unit quaternion for singularity-free runtime math */
export type QuaternionTuple = [number, number, number, number];

export interface TransformData {
  position: Vector3Tuple;
  rotationDeg: EulerDegTuple;
  scale: Vector3Tuple;
}

export interface BoundingBoxData {
  min: Vector3Tuple;
  max: Vector3Tuple;
  size: Vector3Tuple;
}

export type SimulationRunState = 'STOPPED' | 'RUNNING' | 'PAUSED';

export type PlcConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'FAULT';

export const SCHEMA_VERSION = '1.0.0' as const;
