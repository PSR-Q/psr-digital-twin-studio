import type {
  BinaryIpcBufferView,
  PlcConnectionState,
  PlcTagMap,
} from '../../../src/shared/schemas';
import { applyBindingsLocalScan } from './adapterValueCodec';
import type { IPlcAdapter, PlcAdapterStats } from './IPlcAdapter';

/**
 * Built-in Offline Memory Table Adapter.
 * Honours manual Force bits (`PLC_TO_SIM` & `SIM_TO_PLC`) and keeps deterministic scan loop
 * running with zero external PLC dependencies.
 */
export class InternalSimAdapter implements IPlcAdapter {
  public readonly adapterType = 'InternalSimAdapter' as const;
  private state: PlcConnectionState = 'CONNECTED';
  private scanCycles = 0;

  public async connect(_tagMap: PlcTagMap): Promise<void> {
    this.state = 'CONNECTED';
  }

  public async disconnect(): Promise<void> {
    this.state = 'DISCONNECTED';
  }

  public getConnectionState(): PlcConnectionState {
    return this.state;
  }

  public getStats(): PlcAdapterStats {
    return {
      endpointSummary: 'Built-in Memory Bus (Zero-Latency)',
      cyclicReadCount: this.scanCycles,
      cyclicWriteCount: this.scanCycles,
      errorCount: 0,
      lastError: '',
      sharedMemoryHookStatus: 'N/A (Internal Sim)',
    };
  }

  public executeScanCycle(
    bufferView: BinaryIpcBufferView,
    tagMap: PlcTagMap
  ): void {
    if (this.state !== 'CONNECTED') return;
    this.scanCycles = (this.scanCycles + 1) >>> 0;
    applyBindingsLocalScan(bufferView, tagMap, true);
  }
}
