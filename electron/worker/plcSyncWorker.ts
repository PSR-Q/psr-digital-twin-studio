import {
  BinaryIpcBufferView,
  createDefaultPlcTagMap,
  type PlcAdapterType,
  type PlcConnectionAction,
  type PlcTagMap,
  type PlcWorkerDiagnostics,
  type SimulationRunState,
} from '../../src/shared/schemas';
import { InternalSimAdapter } from './adapters/InternalSimAdapter';
import type { IPlcAdapter } from './adapters/IPlcAdapter';
import { MitsubishiMcAdapter } from './adapters/MitsubishiMcAdapter';
import { OpcUaAdapter } from './adapters/OpcUaAdapter';
import { SiemensS7Adapter } from './adapters/SiemensS7Adapter';

/**
 * Tier-2 Dedicated PLC & Cyclic Sync Worker (Electron UtilityProcess — Milestone 4)
 *
 * Runs deterministic 5ms - 20ms cyclic scan loops isolated from Renderer UI / 3D frames,
 * dynamically switching across InternalSimAdapter, SiemensS7Adapter, MitsubishiMcAdapter,
 * and OpcUaAdapter while exchanging zero-overhead 4096-byte binary IPC frames.
 */

interface WorkerInboundMessage {
  type: 'control' | 'configure-tags' | 'cmd-frame' | 'connection-action';
  runState?: SimulationRunState;
  simSpeedMultiplier?: number;
  tagMap?: PlcTagMap;
  frame?: Uint8Array;
  action?: PlcConnectionAction;
}

const bufferView = new BinaryIpcBufferView();
let tagMap: PlcTagMap = createDefaultPlcTagMap();
let activeAdapter: IPlcAdapter = new InternalSimAdapter();

let runState: SimulationRunState = 'STOPPED';
let simSpeedMultiplier = 1.0;
let sequenceTick = 0;
let lastHrTimeNs = process.hrtime.bigint();
let smoothedScanMs = 10.0;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let isCycleInFlight = false;
let lastStatusEmitMs = 0;
let lastEndpointSignature = computeDriverConfigSignature(tagMap);

export function createPlcAdapterByType(adapterType: PlcAdapterType): IPlcAdapter {
  switch (adapterType) {
    case 'SiemensS7Adapter':
      return new SiemensS7Adapter();
    case 'MitsubishiMcAdapter':
      return new MitsubishiMcAdapter();
    case 'OpcUaAdapter':
      return new OpcUaAdapter();
    case 'InternalSimAdapter':
    default:
      return new InternalSimAdapter();
  }
}

function computeDriverConfigSignature(tm: PlcTagMap): string {
  if (tm.activeAdapter === 'SiemensS7Adapter') {
    const c = tm.s7Config;
    return `S7:${c.host}:${c.port}:${c.rack}:${c.slot}:${c.enablePlcsimAdvSharedMemoryHook}:${c.plcsimAdvInstanceName}`;
  }
  if (tm.activeAdapter === 'MitsubishiMcAdapter') {
    const c = tm.mcConfig;
    return `MC:${c.host}:${c.port}:${c.networkNo}:${c.pcNo}:${c.unitIoNo}:${c.unitStationNo}`;
  }
  if (tm.activeAdapter === 'OpcUaAdapter') {
    const c = tm.opcUaConfig;
    return `OPC:${c.endpointUrl}:${c.securityMode}:${c.securityPolicy}:${c.namespaceIndex}`;
  }
  return 'INTERNAL';
}

function mapRunStateCode(state: SimulationRunState): number {
  if (state === 'RUNNING') return 1;
  if (state === 'PAUSED') return 2;
  return 0;
}

function mapPlcStateCode(): number {
  const s = activeAdapter.getConnectionState();
  if (s === 'CONNECTED') return 2;
  if (s === 'CONNECTING') return 1;
  if (s === 'FAULT') return 3;
  return 0;
}

function emitWorkerDiagnosticsIfDue(force = false): void {
  const now = Date.now();
  if (!force && now - lastStatusEmitMs < 240) return;
  lastStatusEmitMs = now;

  if (!process.parentPort) return;
  const stats = activeAdapter.getStats();
  const payload: PlcWorkerDiagnostics = {
    activeAdapter: activeAdapter.adapterType,
    connectionState: activeAdapter.getConnectionState(),
    endpointSummary: stats.endpointSummary,
    targetScanCycleMs: tagMap.scanCycleMs,
    actualScanCycleMs: Number(smoothedScanMs.toFixed(2)),
    cyclicReadCount: stats.cyclicReadCount,
    cyclicWriteCount: stats.cyclicWriteCount,
    errorCount: stats.errorCount,
    lastError: stats.lastError,
    sharedMemoryHookStatus: stats.sharedMemoryHookStatus,
    isBrowserFallback: false,
  };

  process.parentPort.postMessage({
    type: 'plc-worker-status',
    status: payload,
  });
}

async function switchOrReconnectAdapter(
  nextTagMap: PlcTagMap,
  forceReconnect = false
): Promise<void> {
  const nextSig = computeDriverConfigSignature(nextTagMap);
  const adapterChanged = nextTagMap.activeAdapter !== activeAdapter.adapterType;
  const endpointChanged = nextSig !== lastEndpointSignature;
  lastEndpointSignature = nextSig;

  if (adapterChanged) {
    await activeAdapter.disconnect();
    activeAdapter = createPlcAdapterByType(nextTagMap.activeAdapter);
    emitWorkerDiagnosticsIfDue(true);
    await activeAdapter.connect(nextTagMap);
    emitWorkerDiagnosticsIfDue(true);
    return;
  }

  if (forceReconnect || endpointChanged) {
    await activeAdapter.disconnect();
    emitWorkerDiagnosticsIfDue(true);
    await activeAdapter.connect(nextTagMap);
    emitWorkerDiagnosticsIfDue(true);
  }
}

async function runDeterministicCycle(): Promise<void> {
  if (isCycleInFlight) return;
  isCycleInFlight = true;

  try {
    const nowNs = process.hrtime.bigint();
    const elapsedMs = Number(nowNs - lastHrTimeNs) / 1_000_000;
    lastHrTimeNs = nowNs;
    smoothedScanMs = smoothedScanMs * 0.75 + Math.min(200, elapsedMs) * 0.25;
    sequenceTick = (sequenceTick + 1) >>> 0;

    await activeAdapter.executeScanCycle(bufferView, tagMap);

    bufferView.writeTelemetry(
      sequenceTick,
      Date.now(),
      smoothedScanMs,
      mapRunStateCode(runState),
      mapPlcStateCode(),
      simSpeedMultiplier
    );

    if (process.parentPort) {
      process.parentPort.postMessage({
        type: 'plc-binary-frame',
        frame: bufferView.bytes,
      });
    }

    emitWorkerDiagnosticsIfDue(false);
  } finally {
    isCycleInFlight = false;
  }
}

function restartLoop(periodMs: number): void {
  if (scanTimer) clearInterval(scanTimer);
  const clampedPeriod = Math.min(20, Math.max(5, Math.round(periodMs)));
  smoothedScanMs = clampedPeriod;
  lastHrTimeNs = process.hrtime.bigint();

  scanTimer = setInterval(() => {
    void runDeterministicCycle();
  }, clampedPeriod);
}

// Only start UtilityProcess background loop when spawned by Electron Main (`process.parentPort` present)
if (process.parentPort) {
  void activeAdapter.connect(tagMap).then(() => {
    restartLoop(tagMap.scanCycleMs);
    emitWorkerDiagnosticsIfDue(true);
  });

  process.parentPort.on('message', (event) => {
    const msg = event.data as WorkerInboundMessage | undefined;
    if (!msg) return;

    if (msg.type === 'control') {
      if (msg.runState) runState = msg.runState;
      if (typeof msg.simSpeedMultiplier === 'number') {
        simSpeedMultiplier = msg.simSpeedMultiplier;
      }
    } else if (msg.type === 'configure-tags' && msg.tagMap) {
      const prevCycle = tagMap.scanCycleMs;
      tagMap = msg.tagMap;
      if (tagMap.scanCycleMs !== prevCycle) {
        restartLoop(tagMap.scanCycleMs);
      }
      void switchOrReconnectAdapter(tagMap, false);
    } else if (msg.type === 'connection-action' && msg.action) {
      if (msg.action === 'disconnect') {
        void activeAdapter.disconnect().then(() => emitWorkerDiagnosticsIfDue(true));
      } else {
        void switchOrReconnectAdapter(tagMap, true);
      }
    } else if (msg.type === 'cmd-frame' && msg.frame) {
      bufferView.copySimInputsFromRenderer(msg.frame);
    }
  });
}
