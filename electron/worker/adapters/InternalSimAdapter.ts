import type {
  BinaryIpcBufferView,
  PlcConnectionState,
  PlcTagMap,
} from '../../../src/shared/schemas';
import type { IPlcAdapter } from './IPlcAdapter';

/**
 * Built-in Offline Memory Table Adapter (Active by default in Milestones 1-3).
 * Honours manual Force bits and keeps deterministic scan loop running with zero external PLC dependencies.
 */
export class InternalSimAdapter implements IPlcAdapter {
  public readonly adapterType = 'InternalSimAdapter' as const;
  private state: PlcConnectionState = 'CONNECTED';

  public async connect(_tagMap: PlcTagMap): Promise<void> {
    this.state = 'CONNECTED';
  }

  public async disconnect(): Promise<void> {
    this.state = 'DISCONNECTED';
  }

  public getConnectionState(): PlcConnectionState {
    return this.state;
  }

  public executeScanCycle(bufferView: BinaryIpcBufferView, tagMap: PlcTagMap): void {
    for (let i = 0; i < tagMap.bindings.length; i++) {
      const binding = tagMap.bindings[i];
      if (!binding.manualForceEnabled) continue;

      if (binding.dataType === 'BOOL') {
        bufferView.setForceBool(
          binding.bufferSlotIndex,
          true,
          Boolean(binding.manualForceValue)
        );
      } else if (binding.dataType === 'INT16') {
        bufferView.writeInt16(binding.bufferSlotIndex, Number(binding.manualForceValue));
      } else if (binding.dataType === 'DINT32') {
        bufferView.writeDint32(binding.bufferSlotIndex, Number(binding.manualForceValue));
      } else if (binding.dataType === 'FLOAT32') {
        bufferView.writeFloat32(binding.bufferSlotIndex, Number(binding.manualForceValue));
      }
    }
  }
}
