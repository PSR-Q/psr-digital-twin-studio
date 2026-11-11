import type {
  BinaryIpcBufferView,
  PlcAdapterType,
  PlcConnectionState,
  PlcTagMap,
} from '../../../src/shared/schemas';

/**
 * Pluggable PLC Driver Interface (Spec §3.D)
 * Implemented by InternalSimAdapter, SiemensS7Adapter, MitsubishiMcAdapter, and OpcUaAdapter.
 */
export interface IPlcAdapter {
  readonly adapterType: PlcAdapterType;
  connect(tagMap: PlcTagMap): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionState(): PlcConnectionState;
  /**
   * Deterministic cyclic I/O exchange executed inside UtilityProcess scan loop (5ms - 20ms).
   * Reads SIM_TO_PLC values from bufferView and writes PLC_TO_SIM values into bufferView.
   */
  executeScanCycle(bufferView: BinaryIpcBufferView, tagMap: PlcTagMap): Promise<void> | void;
}
