import {
  BinaryIpcBufferView,
  type BinaryTelemetrySnapshot,
  type PlcTagBinding,
  type PlcTagMap,
  type SimulationRunState,
} from '../shared/schemas';

/**
 * Zero-Re-Render Binary Data Bus Client (Tier-3 IPC Receiver)
 *
 * Inside Electron (.exe), subscribes directly to raw Uint8Array IPC frames emitted by
 * the UtilityProcess PLC Worker.
 * Inside Browser Live Preview, runs an identical 10ms high-resolution fallback scan loop
 * so telemetry and FK / Encoder buffers work identically in both environments!
 */

class RuntimeBusClient {
  public readonly bufferView = new BinaryIpcBufferView();
  private readonly telemetryScratch: BinaryTelemetrySnapshot = {
    sequenceTick: 0,
    timestampMs: 0,
    scanCycleMs: 10.0,
    simRunCode: 0,
    plcStatusCode: 2,
    simSpeedMultiplier: 1.0,
  };

  private fallbackTimer: number | null = null;
  private lastFallbackPerf = 0;
  private localTick = 0;
  private localRunState: SimulationRunState = 'STOPPED';
  private localSpeed = 1.0;
  private initialized = false;

  public init(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.onPlcBinaryFrame((frame) => {
        this.bufferView.copyWorkerTelemetryAndOutputs(frame);
      });
      return;
    }

    // Browser Preview fallback deterministic 10ms timer
    if (typeof window !== 'undefined') {
      this.lastFallbackPerf = performance.now();
      this.fallbackTimer = window.setInterval(() => {
        const now = performance.now();
        const dtMs = now - this.lastFallbackPerf;
        this.lastFallbackPerf = now;
        this.localTick = (this.localTick + 1) >>> 0;

        const runCode =
          this.localRunState === 'RUNNING'
            ? 1
            : this.localRunState === 'PAUSED'
              ? 2
              : 0;

        this.bufferView.writeTelemetry(
          this.localTick,
          Date.now(),
          dtMs,
          runCode,
          2, // InternalSimAdapter CONNECTED
          this.localSpeed
        );
      }, 10);
    }
  }

  public sendControl(runState: SimulationRunState, simSpeedMultiplier: number): void {
    this.localRunState = runState;
    this.localSpeed = simSpeedMultiplier;
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.sendPlcControl({ runState, simSpeedMultiplier });
    }
  }

  public applyBindingForceToBuffer(binding: PlcTagBinding): void {
    if (binding.direction !== 'PLC_TO_SIM') return;

    if (binding.dataType === 'BOOL') {
      this.bufferView.setForceBool(
        binding.bufferSlotIndex,
        binding.manualForceEnabled,
        Boolean(binding.manualForceValue)
      );
      if (!binding.manualForceEnabled) {
        this.bufferView.writePlcToSimBool(
          binding.bufferSlotIndex,
          Boolean(binding.manualForceValue)
        );
      }
      return;
    }

    const numVal = Number(binding.manualForceValue ?? 0);
    if (binding.dataType === 'INT16') {
      this.bufferView.writeInt16(binding.bufferSlotIndex, numVal);
    } else if (binding.dataType === 'DINT32') {
      this.bufferView.writeDint32(binding.bufferSlotIndex, numVal);
    } else if (binding.dataType === 'FLOAT32') {
      this.bufferView.writeFloat32(binding.bufferSlotIndex, numVal);
    }
  }

  public syncTagMap(tagMap: PlcTagMap): void {
    for (let i = 0; i < tagMap.bindings.length; i++) {
      this.applyBindingForceToBuffer(tagMap.bindings[i]);
    }
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.configurePlcTagMap(tagMap);
    }
  }

  public readBindingLiveValue(binding: PlcTagBinding): boolean | number {
    if (binding.dataType === 'BOOL') {
      return binding.direction === 'PLC_TO_SIM'
        ? this.bufferView.readPlcToSimBool(binding.bufferSlotIndex)
        : this.bufferView.readSimToPlcBool(binding.bufferSlotIndex);
    }
    if (binding.dataType === 'INT16') {
      return this.bufferView.readInt16(binding.bufferSlotIndex);
    }
    if (binding.dataType === 'DINT32') {
      return this.bufferView.readDint32(binding.bufferSlotIndex);
    }
    return this.bufferView.readFloat32(binding.bufferSlotIndex);
  }

  /** Push SIM_TO_PLC feedback frame to Electron UtilityProcess Worker when running in desktop mode */
  public pushSimInputsToWorker(): void {
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.pushBinaryCommandFrame(this.bufferView.bytes);
    }
  }

  /** Safe to call at 60-144Hz inside R3F useFrame with zero allocations */
  public readTelemetryFast(): BinaryTelemetrySnapshot {
    return this.bufferView.readTelemetry(this.telemetryScratch);
  }

  public dispose(): void {
    if (this.fallbackTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }
}

export const runtimeBusClient = new RuntimeBusClient();
