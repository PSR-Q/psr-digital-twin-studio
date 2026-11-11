import type { UUID } from './common';

/**
 * High-Precision PLC Virtual Interface & I/O Tag Binding Schema (Milestone 4 Ready)
 * Supports InternalSim, Siemens S7-PLCSIM Advanced, Mitsubishi GX Simulator3 (3E MC), and Omron/Universal OPC UA.
 */

export type PlcAdapterType =
  | 'InternalSimAdapter'
  | 'SiemensS7Adapter'
  | 'MitsubishiMcAdapter'
  | 'OpcUaAdapter';

export type PlcSignalDataType = 'BOOL' | 'INT16' | 'DINT32' | 'FLOAT32';

export type PlcSignalDirection = 'PLC_TO_SIM' | 'SIM_TO_PLC';

export interface SiemensS7DriverConfig {
  host: string;
  port: number;
  rack: number;
  slot: number;
  /** Optional hook for native S7-PLCSIM Advanced C++/FFI Shared Memory API */
  enablePlcsimAdvSharedMemoryHook: boolean;
  plcsimAdvInstanceName: string;
}

export interface MitsubishiMcDriverConfig {
  host: string;
  port: number;
  frameType: '3E-Binary';
  networkNo: number;
  pcNo: number;
  unitIoNo: number;
  unitStationNo: number;
}

export interface OpcUaDriverConfig {
  endpointUrl: string;
  securityMode: 'None' | 'Sign' | 'SignAndEncrypt';
  securityPolicy: 'None' | 'Basic256Sha256';
  namespaceIndex: number;
}

export interface PlcTagBinding {
  id: UUID;
  signalName: string;
  instanceId: UUID;
  componentSignalKey: string;
  direction: PlcSignalDirection;
  dataType: PlcSignalDataType;
  /** Vendor address e.g. 'Q0.0', 'I0.1', 'DB1,DINT4', 'D100', 'ns=2;s=Conveyor1.EncoderCount' */
  plcAddress: string;
  /** Pre-allocated slot index inside BinaryIpcBufferLayout */
  bufferSlotIndex: number;
  scaleFactor: number;
  offset: number;
  manualForceEnabled: boolean;
  manualForceValue: boolean | number;
}

export interface PlcTagMap {
  activeAdapter: PlcAdapterType;
  /** Deterministic cyclic scan period in milliseconds (5ms - 20ms) */
  scanCycleMs: number;
  s7Config: SiemensS7DriverConfig;
  mcConfig: MitsubishiMcDriverConfig;
  opcUaConfig: OpcUaDriverConfig;
  bindings: PlcTagBinding[];
}

export function createDefaultPlcTagMap(): PlcTagMap {
  return {
    activeAdapter: 'InternalSimAdapter',
    scanCycleMs: 10,
    s7Config: {
      host: '192.168.0.1',
      port: 102,
      rack: 0,
      slot: 1,
      enablePlcsimAdvSharedMemoryHook: false,
      plcsimAdvInstanceName: 'VC_PLC_01',
    },
    mcConfig: {
      host: '127.0.0.1',
      port: 5002,
      frameType: '3E-Binary',
      networkNo: 0,
      pcNo: 255,
      unitIoNo: 1023,
      unitStationNo: 0,
    },
    opcUaConfig: {
      endpointUrl: 'opc.tcp://127.0.0.1:4840',
      securityMode: 'None',
      securityPolicy: 'None',
      namespaceIndex: 2,
    },
    bindings: [],
  };
}
