import {
  BinaryIpcBufferView,
  createDefaultPlcDiagnostics,
  type BinaryTelemetrySnapshot,
  type PlcConnectionAction,
  type PlcTagBinding,
  type PlcTagMap,
  type PlcWorkerDiagnostics,
  type SimulationRunState,
} from '../shared/schemas';

/**
 * Zero-Re-Render Binary Data Bus Client (Tier-3 IPC Receiver — Milestone 4)
 *
 * Inside Electron (.exe), subscribes directly to raw Uint8Array IPC frames and 4Hz
 * live driver diagnostics emitted by the isolated UtilityProcess PLC Worker
 * (InternalSim, Siemens S7-PLCSIM Advanced, Mitsubishi 3E MC, Omron/CODESYS OPC UA).
 *
 * Inside Browser Live Preview, runs an identical 5–20ms high-resolution fallback scan loop
 * so 3D Forward Kinematics, Spline Sensors, HSC Encoders, and Manual Forces work seamlessly!
 */

function clampScanPeriodMs(ms: number): number {
  if (!Number.isFinite(ms)) return 10;
  return Math.max(5, Math.min(20, Math.round(ms)));
}

function summarizeEndpoint(tagMap: PlcTagMap): string {
  switch (tagMap.activeAdapter) {
    case 'SiemensS7Adapter': {
      const s7 = tagMap.s7Config;
      return `S7 ISO-on-TCP ${s7.host}:${s7.port} (Rack ${s7.rack} / Slot ${s7.slot})`;
    }
    case 'MitsubishiMcAdapter': {
      const mc = tagMap.mcConfig;
      return `MELSEC 3E Binary ${mc.host}:${mc.port} (Net ${mc.networkNo} / PC 0x${mc.pcNo.toString(16).toUpperCase()})`;
    }
    case 'OpcUaAdapter':
      return tagMap.opcUaConfig.endpointUrl;
    default:
      return 'In-Memory Deterministic Table';
  }
}

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

  private diagnostics: PlcWorkerDiagnostics = createDefaultPlcDiagnostics();
  private latestTagMap: PlcTagMap | null = null;
  private forcedSimToPlcBindings: PlcTagBinding[] = [];

  private fallbackTimer: number | null = null;
  private fallbackIntervalMs = 10;
  private lastFallbackPerf = 0;
  private localTick = 0;
  private localRunState: SimulationRunState = 'STOPPED';
  private localSpeed = 1.0;
  private localSimConnected = true;
  private initialized = false;

  private unsubFrame: (() => void) | null = null;
  private unsubStatus: (() => void) | null = null;

  public init(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (typeof window !== 'undefined' && window.electronAPI) {
      this.unsubFrame = window.electronAPI.onPlcBinaryFrame((frame) => {
        this.bufferView.copyWorkerTelemetryAndOutputs(frame);
      });
      this.unsubStatus = window.electronAPI.onPlcWorkerStatus((status) => {
        this.diagnostics = status;
      });
      return;
    }

    if (typeof window !== 'undefined') {
      this.restartBrowserFallbackTimer(this.fallbackIntervalMs);
    }
  }

  private restartBrowserFallbackTimer(periodMs: number): void {
    if (typeof window === 'undefined' || window.electronAPI) return;
    const clamped = clampScanPeriodMs(periodMs);
    this.fallbackIntervalMs = clamped;

    if (this.fallbackTimer !== null) {
      window.clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }

    this.lastFallbackPerf = performance.now();
    this.fallbackTimer = window.setInterval(() => {
      const now = performance.now();
      const dtMs = now - this.lastFallbackPerf;
      this.lastFallbackPerf = now;
      this.localTick = (this.localTick + 1) >>> 0;

      // Enforce any manual SIM_TO_PLC force overrides on the local bus
      this.applyForcedSimToPlcOverrides();

      const runCode =
        this.localRunState === 'RUNNING'
          ? 1
          : this.localRunState === 'PAUSED'
            ? 2
            : 0;

      const isInternal =
        !this.latestTagMap ||
        this.latestTagMap.activeAdapter === 'InternalSimAdapter';
      const statusCode =
        isInternal && this.localSimConnected ? 2 : 0;

      this.bufferView.writeTelemetry(
        this.localTick,
        Date.now(),
        dtMs,
        runCode,
        statusCode,
        this.localSpeed
      );

      this.diagnostics = {
        ...this.diagnostics,
        actualScanCycleMs: Number(dtMs.toFixed(2)),
        cyclicReadCount:
          statusCode === 2
            ? this.diagnostics.cyclicReadCount + 1
            : this.diagnostics.cyclicReadCount,
        cyclicWriteCount:
          statusCode === 2
            ? this.diagnostics.cyclicWriteCount + 1
            : this.diagnostics.cyclicWriteCount,
      };
    }, clamped);
  }

  private refreshBrowserDiagnostics(tagMap: PlcTagMap): void {
    if (typeof window !== 'undefined' && window.electronAPI) return;

    const targetMs = clampScanPeriodMs(tagMap.scanCycleMs);
    if (targetMs !== this.fallbackIntervalMs && this.initialized) {
      this.restartBrowserFallbackTimer(targetMs);
    }

    const isInternal = tagMap.activeAdapter === 'InternalSimAdapter';
    const shmHookStatus =
      tagMap.activeAdapter === 'SiemensS7Adapter' &&
      tagMap.s7Config.enablePlcsimAdvSharedMemoryHook
        ? `Hook Configured (${tagMap.s7Config.plcsimAdvInstanceName}) — Requires Windows .exe`
        : 'Disabled (ISO-on-TCP Mode)';

    this.diagnostics = {
      activeAdapter: tagMap.activeAdapter,
      connectionState:
        isInternal && this.localSimConnected ? 'CONNECTED' : 'DISCONNECTED',
      endpointSummary: summarizeEndpoint(tagMap),
      targetScanCycleMs: targetMs,
      actualScanCycleMs: this.diagnostics.actualScanCycleMs || targetMs,
      cyclicReadCount: isInternal ? this.diagnostics.cyclicReadCount : 0,
      cyclicWriteCount: isInternal ? this.diagnostics.cyclicWriteCount : 0,
      errorCount: 0,
      lastError: isInternal
        ? ''
        : 'Browser Sandbox blocks raw TCP sockets (ports 102 / 5002 / 4840). Launch the standalone Windows .exe to connect live to PLCSIM Advanced, GX Simulator3, or OPC UA — local 3D simulation & Manual Force I/O remain active.',
      sharedMemoryHookStatus: shmHookStatus,
      isBrowserFallback: !isInternal,
    };
  }

  private applyForcedSimToPlcOverrides(): void {
    for (let i = 0; i < this.forcedSimToPlcBindings.length; i++) {
      const b = this.forcedSimToPlcBindings[i];
      if (b.dataType === 'BOOL') {
        this.bufferView.writeSimToPlcBool(
          b.bufferSlotIndex,
          Boolean(b.manualForceValue)
        );
      } else if (b.dataType === 'INT16') {
        this.bufferView.writeInt16(
          b.bufferSlotIndex,
          Number(b.manualForceValue ?? 0)
        );
      } else if (b.dataType === 'DINT32') {
        this.bufferView.writeDint32(
          b.bufferSlotIndex,
          Number(b.manualForceValue ?? 0)
        );
      } else {
        this.bufferView.writeFloat32(
          b.bufferSlotIndex,
          Number(b.manualForceValue ?? 0)
        );
      }
    }
  }

  public sendControl(
    runState: SimulationRunState,
    simSpeedMultiplier: number
  ): void {
    this.localRunState = runState;
    this.localSpeed = simSpeedMultiplier;
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.sendPlcControl({ runState, simSpeedMultiplier });
    }
  }

  public sendConnectionAction(action: PlcConnectionAction): void {
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.sendPlcConnectionAction(action);
      return;
    }

    // Browser Preview connection toggle support
    if (action === 'disconnect') {
      this.localSimConnected = false;
    } else {
      this.localSimConnected = true;
    }
    if (this.latestTagMap) {
      this.refreshBrowserDiagnostics(this.latestTagMap);
    }
  }

  public applyBindingForceToBuffer(binding: PlcTagBinding): void {
    if (binding.direction === 'PLC_TO_SIM') {
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
      return;
    }

    // SIM_TO_PLC force override
    if (binding.manualForceEnabled) {
      if (binding.dataType === 'BOOL') {
        this.bufferView.writeSimToPlcBool(
          binding.bufferSlotIndex,
          Boolean(binding.manualForceValue)
        );
      } else if (binding.dataType === 'INT16') {
        this.bufferView.writeInt16(
          binding.bufferSlotIndex,
          Number(binding.manualForceValue ?? 0)
        );
      } else if (binding.dataType === 'DINT32') {
        this.bufferView.writeDint32(
          binding.bufferSlotIndex,
          Number(binding.manualForceValue ?? 0)
        );
      } else if (binding.dataType === 'FLOAT32') {
        this.bufferView.writeFloat32(
          binding.bufferSlotIndex,
          Number(binding.manualForceValue ?? 0)
        );
      }
    }
  }

  public syncTagMap(tagMap: PlcTagMap): void {
    this.latestTagMap = tagMap;
    this.forcedSimToPlcBindings = tagMap.bindings.filter(
      (b) => b.direction === 'SIM_TO_PLC' && b.manualForceEnabled
    );

    for (let i = 0; i < tagMap.bindings.length; i++) {
      this.applyBindingForceToBuffer(tagMap.bindings[i]);
    }

    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.configurePlcTagMap(tagMap);
    } else {
      this.refreshBrowserDiagnostics(tagMap);
    }
  }

  public readBindingLiveValue(binding: PlcTagBinding): boolean | number {
    if (binding.manualForceEnabled) {
      return binding.dataType === 'BOOL'
        ? Boolean(binding.manualForceValue)
        : Number(binding.manualForceValue ?? 0);
    }
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
    this.applyForcedSimToPlcOverrides();
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.pushBinaryCommandFrame(this.bufferView.bytes);
    }
  }

  /** Safe to call at 60-144Hz inside R3F useFrame with zero allocations */
  public readTelemetryFast(): BinaryTelemetrySnapshot {
    return this.bufferView.readTelemetry(this.telemetryScratch);
  }

  /** Returns live 4Hz PLC Driver & Scan Loop diagnostics */
  public getDiagnostics(): PlcWorkerDiagnostics {
    return this.diagnostics;
  }

  public dispose(): void {
    if (this.unsubFrame) {
      this.unsubFrame();
      this.unsubFrame = null;
    }
    if (this.unsubStatus) {
      this.unsubStatus();
      this.unsubStatus = null;
    }
    if (this.fallbackTimer !== null && typeof window !== 'undefined') {
      window.clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }
}

export const runtimeBusClient = new RuntimeBusClient();
