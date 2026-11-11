import {
  BinaryIpcBufferView,
  createDefaultPlcTagMap,
  type PlcTagMap,
  type SimulationRunState,
} from '../../src/shared/schemas';
import { InternalSimAdapter } from './adapters/InternalSimAdapter';
import type { IPlcAdapter } from './adapters/IPlcAdapter';

/**
 * Tier-2 Dedicated PLC & Cyclic Sync Worker (Electron UtilityProcess)
 * Runs deterministic 5ms - 20ms scan loops isolated from Renderer UI / 3D frames.
 */

interface WorkerInboundMessage {
  type: 'control' | 'configure-tags' | 'cmd-frame';
  runState?: SimulationRunState;
  simSpeedMultiplier?: number;
  tagMap?: PlcTagMap;
  frame?: Uint8Array;
}

const bufferView = new BinaryIpcBufferView();
let tagMap: PlcTagMap = createDefaultPlcTagMap();
const activeAdapter: IPlcAdapter = new InternalSimAdapter();

let runState: SimulationRunState = 'STOPPED';
let simSpeedMultiplier = 1.0;
let sequenceTick = 0;
let lastHrTimeNs = process.hrtime.bigint();
let scanTimer: ReturnType<typeof setInterval> | null = null;

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

async function runDeterministicCycle(): Promise<void> {
  const nowNs = process.hrtime.bigint();
  const elapsedMs = Number(nowNs - lastHrTimeNs) / 1_000_000;
  lastHrTimeNs = nowNs;
  sequenceTick = (sequenceTick + 1) >>> 0;

  await activeAdapter.executeScanCycle(bufferView, tagMap);

  bufferView.writeTelemetry(
    sequenceTick,
    Date.now(),
    elapsedMs,
    mapRunStateCode(runState),
    mapPlcStateCode(),
    simSpeedMultiplier
  );

  // Post raw Uint8Array binary frame across UtilityProcess parentPort
  if (process.parentPort) {
    process.parentPort.postMessage({
      type: 'plc-binary-frame',
      frame: bufferView.bytes,
    });
  }
}

function restartLoop(periodMs: number): void {
  if (scanTimer) clearInterval(scanTimer);
  const clampedPeriod = Math.min(20, Math.max(5, Math.round(periodMs)));
  lastHrTimeNs = process.hrtime.bigint();
  // Broadcast telemetry at 20Hz when idle or full cyclic scan rate when running
  scanTimer = setInterval(() => {
    void runDeterministicCycle();
  }, clampedPeriod);
}

void activeAdapter.connect(tagMap).then(() => {
  restartLoop(tagMap.scanCycleMs);
});

if (process.parentPort) {
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
    } else if (msg.type === 'cmd-frame' && msg.frame) {
      bufferView.copyFromFrame(msg.frame);
    }
  });
}
