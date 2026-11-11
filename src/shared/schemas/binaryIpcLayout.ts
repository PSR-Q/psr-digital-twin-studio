/**
 * Zero-Overhead Binary IPC Data Bus Schema & View
 *
 * Pre-allocated 4096-byte binary frame exchanged between the UtilityProcess PLC Worker
 * and the R3F Renderer (via SharedArrayBuffer or raw Uint8Array IPC frames).
 * Read directly inside R3F `useFrame` without triggering React component re-renders.
 */

export interface BinaryIpcBufferLayout {
  readonly magicHeader: number;
  readonly totalByteLength: number;
  readonly headerOffset: number;
  readonly headerByteLength: number;
  readonly simToPlcBoolOffset: number;
  readonly simToPlcBoolCount: number;
  readonly plcToSimBoolOffset: number;
  readonly plcToSimBoolCount: number;
  readonly forceMaskBoolOffset: number;
  readonly forceValueBoolOffset: number;
  readonly int16Offset: number;
  readonly int16Count: number;
  readonly dint32Offset: number;
  readonly dint32Count: number;
  readonly float32Offset: number;
  readonly float32Count: number;
}

/**
 * Deterministic 4096-byte memory map (64-byte aligned segments):
 * [0..63]     Header & Telemetry (64 B)
 * [64..191]   1024 SIM_TO_PLC BOOL bits (128 B)
 * [192..319]  1024 PLC_TO_SIM BOOL bits (128 B)
 * [320..447]  1024 Force Mask BOOL bits (128 B)
 * [448..575]  1024 Forced BOOL Values (128 B)
 * [576..1087] 256 INT16 registers (512 B)
 * [1088..2111] 256 DINT32 registers / Virtual HSC Encoder counts (1024 B)
 * [2112..4095] 496 FLOAT32 (REAL) Servo / Analog registers (1984 B)
 */
export const DEFAULT_BINARY_IPC_LAYOUT: BinaryIpcBufferLayout = {
  magicHeader: 0x56433531, // "VC51"
  totalByteLength: 4096,
  headerOffset: 0,
  headerByteLength: 64,
  simToPlcBoolOffset: 64,
  simToPlcBoolCount: 1024,
  plcToSimBoolOffset: 192,
  plcToSimBoolCount: 1024,
  forceMaskBoolOffset: 320,
  forceValueBoolOffset: 448,
  int16Offset: 576,
  int16Count: 256,
  dint32Offset: 1088,
  dint32Count: 256,
  float32Offset: 2112,
  float32Count: 496,
} as const;

export interface BinaryTelemetrySnapshot {
  sequenceTick: number;
  timestampMs: number;
  scanCycleMs: number;
  simRunCode: number;
  plcStatusCode: number;
  simSpeedMultiplier: number;
}

export class BinaryIpcBufferView {
  public readonly buffer: ArrayBufferLike;
  public readonly bytes: Uint8Array;
  private readonly view: DataView;
  public readonly layout: BinaryIpcBufferLayout;

  public constructor(
    backing?: ArrayBufferLike,
    layout: BinaryIpcBufferLayout = DEFAULT_BINARY_IPC_LAYOUT
  ) {
    this.layout = layout;
    this.buffer = backing ?? new ArrayBuffer(layout.totalByteLength);
    this.bytes = new Uint8Array(this.buffer, 0, layout.totalByteLength);
    this.view = new DataView(this.buffer, 0, layout.totalByteLength);

    if (this.view.getUint32(0, true) !== layout.magicHeader) {
      this.view.setUint32(0, layout.magicHeader, true);
      this.view.setFloat32(24, 1.0, true);
    }
  }

  public copyFromFrame(frame: Uint8Array): void {
    const len = Math.min(frame.byteLength, this.bytes.byteLength);
    this.bytes.set(frame.subarray(0, len), 0);
  }

  /**
   * Copies Worker-owned header telemetry [0..63], PLC_TO_SIM / Force BOOLs [192..575],
   * and PLC_TO_SIM numeric setpoint registers (lower half of INT16/DINT32/FLOAT32)
   * without overwriting Renderer-owned SIM_TO_PLC feedback bits & actual value registers.
   */
  public copyWorkerTelemetryAndOutputs(frame: Uint8Array): void {
    if (frame.byteLength < 4096) return;
    this.bytes.set(frame.subarray(0, 64), 0);
    this.bytes.set(frame.subarray(192, 576), 192);
    // INT16 PLC_TO_SIM slots [0..127] -> bytes [576..831]
    this.bytes.set(frame.subarray(576, 832), 576);
    // DINT32 PLC_TO_SIM slots [0..127] -> bytes [1088..1599]
    this.bytes.set(frame.subarray(1088, 1600), 1088);
    // FLOAT32 PLC_TO_SIM slots [0..247] -> bytes [2112..3103]
    this.bytes.set(frame.subarray(2112, 3104), 2112);
  }

  /**
   * Copies Renderer-owned SIM_TO_PLC BOOL bits [64..191] and SIM_TO_PLC numeric feedback
   * registers (upper half of INT16/DINT32/FLOAT32) into the Worker buffer.
   */
  public copySimInputsFromRenderer(frame: Uint8Array): void {
    if (frame.byteLength < 4096) return;
    this.bytes.set(frame.subarray(64, 192), 64);
    // INT16 SIM_TO_PLC slots [128..255] -> bytes [832..1087]
    this.bytes.set(frame.subarray(832, 1088), 832);
    // DINT32 SIM_TO_PLC slots [128..255] -> bytes [1600..2111]
    this.bytes.set(frame.subarray(1600, 2112), 1600);
    // FLOAT32 SIM_TO_PLC slots [248..495] -> bytes [3104..4095]
    this.bytes.set(frame.subarray(3104, 4096), 3104);
  }

  public writeTelemetry(
    sequenceTick: number,
    timestampMs: number,
    scanCycleMs: number,
    simRunCode: number,
    plcStatusCode: number,
    simSpeedMultiplier: number
  ): void {
    this.view.setUint32(4, sequenceTick >>> 0, true);
    this.view.setFloat64(8, timestampMs, true);
    this.view.setFloat32(16, scanCycleMs, true);
    this.view.setUint8(20, simRunCode & 0xff);
    this.view.setUint8(21, plcStatusCode & 0xff);
    this.view.setFloat32(24, simSpeedMultiplier, true);
  }

  public readTelemetry(out?: BinaryTelemetrySnapshot): BinaryTelemetrySnapshot {
    const target = out ?? {
      sequenceTick: 0,
      timestampMs: 0,
      scanCycleMs: 0,
      simRunCode: 0,
      plcStatusCode: 0,
      simSpeedMultiplier: 1,
    };
    target.sequenceTick = this.view.getUint32(4, true);
    target.timestampMs = this.view.getFloat64(8, true);
    target.scanCycleMs = this.view.getFloat32(16, true);
    target.simRunCode = this.view.getUint8(20);
    target.plcStatusCode = this.view.getUint8(21);
    target.simSpeedMultiplier = this.view.getFloat32(24, true);
    return target;
  }

  public readSimToPlcBool(slot: number): boolean {
    return this.readBit(this.layout.simToPlcBoolOffset, slot);
  }

  public writeSimToPlcBool(slot: number, value: boolean): void {
    this.writeBit(this.layout.simToPlcBoolOffset, slot, value);
  }

  public readPlcToSimBool(slot: number): boolean {
    if (this.readBit(this.layout.forceMaskBoolOffset, slot)) {
      return this.readBit(this.layout.forceValueBoolOffset, slot);
    }
    return this.readBit(this.layout.plcToSimBoolOffset, slot);
  }

  public writePlcToSimBool(slot: number, value: boolean): void {
    this.writeBit(this.layout.plcToSimBoolOffset, slot, value);
  }

  public isForceBoolEnabled(slot: number): boolean {
    return this.readBit(this.layout.forceMaskBoolOffset, slot);
  }

  public setForceBool(slot: number, enabled: boolean, forcedValue: boolean): void {
    this.writeBit(this.layout.forceMaskBoolOffset, slot, enabled);
    this.writeBit(this.layout.forceValueBoolOffset, slot, forcedValue);
  }

  public readInt16(slot: number): number {
    if (slot < 0 || slot >= this.layout.int16Count) return 0;
    return this.view.getInt16(this.layout.int16Offset + slot * 2, true);
  }

  public writeInt16(slot: number, value: number): void {
    if (slot < 0 || slot >= this.layout.int16Count) return;
    this.view.setInt16(this.layout.int16Offset + slot * 2, value | 0, true);
  }

  public readDint32(slot: number): number {
    if (slot < 0 || slot >= this.layout.dint32Count) return 0;
    return this.view.getInt32(this.layout.dint32Offset + slot * 4, true);
  }

  public writeDint32(slot: number, value: number): void {
    if (slot < 0 || slot >= this.layout.dint32Count) return;
    this.view.setInt32(this.layout.dint32Offset + slot * 4, value | 0, true);
  }

  public readFloat32(slot: number): number {
    if (slot < 0 || slot >= this.layout.float32Count) return 0;
    return this.view.getFloat32(this.layout.float32Offset + slot * 4, true);
  }

  public writeFloat32(slot: number, value: number): void {
    if (slot < 0 || slot >= this.layout.float32Count) return;
    this.view.setFloat32(this.layout.float32Offset + slot * 4, value, true);
  }

  private readBit(sectionByteOffset: number, bitIndex: number): boolean {
    if (bitIndex < 0 || bitIndex >= 1024) return false;
    const byteIndex = sectionByteOffset + (bitIndex >> 3);
    const mask = 1 << (bitIndex & 7);
    return (this.bytes[byteIndex] & mask) !== 0;
  }

  private writeBit(sectionByteOffset: number, bitIndex: number, value: boolean): void {
    if (bitIndex < 0 || bitIndex >= 1024) return;
    const byteIndex = sectionByteOffset + (bitIndex >> 3);
    const mask = 1 << (bitIndex & 7);
    if (value) {
      this.bytes[byteIndex] |= mask;
    } else {
      this.bytes[byteIndex] &= ~mask;
    }
  }
}
