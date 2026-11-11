import {
  BinaryIpcBufferView,
  type BinaryTelemetrySnapshot,
  type PlcTagMap,
  type SimulationRunState,
} from '../shared/schemas';

/**
 * Zero-Re-Render Binary Data Bus Client (Tier-3 IPC Receiver)
 *
 * Inside Electron (.exe), subscribes directly to raw Uint8Array IPC frames emitted by
 * the UtilityProcess PLC Worker.
 * Inside Browser Live Preview, runs an identical 10ms high-resolution fallback scan loop
 * so telemetry and future FK / Encoder buffers work identically in both environments!
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
        this.bufferView.copyFromFrame(frame);
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

  public syncTagMap(tagMap: PlcTagMap): void {
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.configurePlcTagMap(tagMap);
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
