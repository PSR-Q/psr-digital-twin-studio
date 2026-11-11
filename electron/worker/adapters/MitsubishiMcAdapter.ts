import * as net from 'node:net';
import {
  parseMcAddress,
  type ParsedMcAddress,
} from '../../../src/engine/plcAddressSyntax';
import type {
  BinaryIpcBufferView,
  PlcConnectionState,
  PlcTagBinding,
  PlcTagMap,
} from '../../../src/shared/schemas';
import {
  applyBindingsLocalScan,
  readSimToPlcWireValue,
  writePlcToSimFromWire,
} from './adapterValueCodec';
import type { IPlcAdapter, PlcAdapterStats } from './IPlcAdapter';

/**
 * Mitsubishi MELSEC iQ-R / Q / L / FX5U & GX Simulator3 Adapter (Spec §3.D.3)
 *
 * Implements QnA-Compatible 3E Binary MC Protocol (Subheader 0x50 0x00 -> 0xD0 0x00):
 *  - Contiguous Word Batch Read (0x0401 / 0x0000) for D / W / R registers (INT16, DINT32, FLOAT32)
 *  - Contiguous Bit Batch Read (0x0401 / 0x0001) for Y / X / M / B / L devices
 *  - Random Word/DWord Write (0x1402 / 0x0000) for SIM_TO_PLC HSC DINT32 & Servo REAL registers
 *  - Random Bit Write (0x1402 / 0x0001) for SIM_TO_PLC Photoelectric/Proximity/Reed bits
 */

interface ResolvedMcTag {
  binding: PlcTagBinding;
  addr: ParsedMcAddress;
}

interface ContiguousSpan {
  deviceCode: number;
  isBitDevice: boolean;
  startHead: number;
  pointCount: number;
  tags: ResolvedMcTag[];
}

const CONNECT_TIMEOUT_MS = 1800;
const REQUEST_TIMEOUT_MS = 1200;
const RECONNECT_BACKOFF_MS = 2500;

export class MitsubishiMcAdapter implements IPlcAdapter {
  public readonly adapterType = 'MitsubishiMcAdapter' as const;

  private socket: net.Socket | null = null;
  private state: PlcConnectionState = 'DISCONNECTED';

  private rxAccumulator: Buffer = Buffer.alloc(0);
  private pendingResolve: ((payload: Buffer) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  private lastConnectAttemptMs = 0;
  private connectInProgress = false;
  private endpointSummary = '127.0.0.1:5002 (3E-Binary)';
  private cyclicReadCount = 0;
  private cyclicWriteCount = 0;
  private errorCount = 0;
  private lastError = '';

  public getConnectionState(): PlcConnectionState {
    return this.state;
  }

  public getStats(): PlcAdapterStats {
    return {
      endpointSummary: this.endpointSummary,
      cyclicReadCount: this.cyclicReadCount,
      cyclicWriteCount: this.cyclicWriteCount,
      errorCount: this.errorCount,
      lastError: this.lastError,
      sharedMemoryHookStatus: 'N/A (3E Binary TCP)',
    };
  }

  public async connect(tagMap: PlcTagMap): Promise<void> {
    if (this.connectInProgress) return;
    this.connectInProgress = true;
    await this.teardownSocket();

    const cfg = tagMap.mcConfig;
    const host = (cfg.host || '127.0.0.1').trim();
    const port = cfg.port || 5002;
    this.endpointSummary = `${host}:${port} (3E-Binary Net ${cfg.networkNo}/PC ${cfg.pcNo})`;

    this.state = 'CONNECTING';
    this.lastConnectAttemptMs = Date.now();

    try {
      const sock = await this.openTcpSocket(host, port);
      this.socket = sock;
      this.state = 'CONNECTED';
      this.lastError = '';
    } catch (err) {
      this.errorCount = (this.errorCount + 1) >>> 0;
      this.lastError =
        err instanceof Error
          ? err.message
          : 'Mitsubishi 3E Binary TCP connection failed';
      this.state = 'FAULT';
      await this.teardownSocket();
    } finally {
      this.connectInProgress = false;
    }
  }

  public async disconnect(): Promise<void> {
    await this.teardownSocket();
    this.state = 'DISCONNECTED';
  }

  public async executeScanCycle(
    bufferView: BinaryIpcBufferView,
    tagMap: PlcTagMap
  ): Promise<void> {
    applyBindingsLocalScan(bufferView, tagMap, false);

    if (this.state !== 'CONNECTED' || !this.socket) {
      if (
        this.state !== 'DISCONNECTED' &&
        !this.connectInProgress &&
        Date.now() - this.lastConnectAttemptMs >= RECONNECT_BACKOFF_MS
      ) {
        void this.connect(tagMap);
      }
      return;
    }

    const readTags: ResolvedMcTag[] = [];
    const writeBitTags: ResolvedMcTag[] = [];
    const writeWordTags: ResolvedMcTag[] = [];
    const writeDwordTags: ResolvedMcTag[] = [];

    for (let i = 0; i < tagMap.bindings.length; i++) {
      const b = tagMap.bindings[i];
      const parsed = parseMcAddress(b.plcAddress, b.dataType);
      if (!parsed) continue;

      if (b.direction === 'PLC_TO_SIM') {
        readTags.push({ binding: b, addr: parsed });
      } else if (parsed.isBitDevice) {
        writeBitTags.push({ binding: b, addr: parsed });
      } else if (parsed.wordCount === 1) {
        writeWordTags.push({ binding: b, addr: parsed });
      } else {
        writeDwordTags.push({ binding: b, addr: parsed });
      }
    }

    try {
      // 1. Write SIM_TO_PLC Bit Sensors via 3E Random Bit Write (0x1402 / 0x0001)
      if (writeBitTags.length > 0) {
        for (let offset = 0; offset < writeBitTags.length; offset += 80) {
          const slice = writeBitTags.slice(offset, offset + 80);
          const body = this.buildRandomBitWriteBody(slice, bufferView);
          await this.send3EFrameAndWait(tagMap, body);
          this.cyclicWriteCount = (this.cyclicWriteCount + 1) >>> 0;
        }
      }

      // 2. Write SIM_TO_PLC Word / DWord Registers (HSC DINT32 & Servo REAL) via 3E Random Word Write (0x1402 / 0x0000)
      if (writeWordTags.length > 0 || writeDwordTags.length > 0) {
        const body = this.buildRandomWordWriteBody(
          writeWordTags.slice(0, 80),
          writeDwordTags.slice(0, 80),
          bufferView
        );
        await this.send3EFrameAndWait(tagMap, body);
        this.cyclicWriteCount = (this.cyclicWriteCount + 1) >>> 0;
      }

      // 3. Read PLC_TO_SIM Coalesced Spans via 3E Batch Read (0x0401)
      if (readTags.length > 0) {
        const spans = this.coalesceReadSpans(readTags);
        for (let s = 0; s < spans.length; s++) {
          const span = spans[s];
          const body = this.buildBatchReadBody(span);
          const dataPayload = await this.send3EFrameAndWait(tagMap, body);
          this.decodeBatchReadPayload(span, dataPayload, bufferView);
          this.cyclicReadCount = (this.cyclicReadCount + 1) >>> 0;
        }
      }
    } catch (err) {
      this.errorCount = (this.errorCount + 1) >>> 0;
      this.lastError =
        err instanceof Error ? err.message : 'MC 3E cyclic I/O error';
      this.state = 'FAULT';
      await this.teardownSocket();
    }
  }

  private coalesceReadSpans(tags: ResolvedMcTag[]): ContiguousSpan[] {
    const byDevice = new Map<number, ResolvedMcTag[]>();
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      let arr = byDevice.get(t.addr.deviceCode);
      if (!arr) {
        arr = [];
        byDevice.set(t.addr.deviceCode, arr);
      }
      arr.push(t);
    }

    const spans: ContiguousSpan[] = [];
    for (const [deviceCode, list] of byDevice.entries()) {
      list.sort((a, b) => a.addr.headDeviceNumber - b.addr.headDeviceNumber);
      const isBit = list[0].addr.isBitDevice;
      const maxGap = isBit ? 64 : 32;
      const maxSpanPoints = isBit ? 512 : 480;

      let curStart = list[0].addr.headDeviceNumber;
      let curEnd =
        list[0].addr.headDeviceNumber + (isBit ? 1 : list[0].addr.wordCount);
      let curTags: ResolvedMcTag[] = [list[0]];

      for (let i = 1; i < list.length; i++) {
        const item = list[i];
        const itemStart = item.addr.headDeviceNumber;
        const itemEnd = itemStart + (isBit ? 1 : item.addr.wordCount);

        if (
          itemStart - curEnd <= maxGap &&
          itemEnd - curStart <= maxSpanPoints
        ) {
          curEnd = Math.max(curEnd, itemEnd);
          curTags.push(item);
        } else {
          spans.push({
            deviceCode,
            isBitDevice: isBit,
            startHead: curStart,
            pointCount: Math.max(1, curEnd - curStart),
            tags: curTags,
          });
          curStart = itemStart;
          curEnd = itemEnd;
          curTags = [item];
        }
      }

      spans.push({
        deviceCode,
        isBitDevice: isBit,
        startHead: curStart,
        pointCount: Math.max(1, curEnd - curStart),
        tags: curTags,
      });
    }

    return spans;
  }

  private buildBatchReadBody(span: ContiguousSpan): Buffer {
    const buf = Buffer.alloc(10);
    buf.writeUInt16LE(0x0401, 0); // Batch Read command
    buf.writeUInt16LE(span.isBitDevice ? 0x0001 : 0x0000, 2); // Subcommand: bit vs word
    buf[4] = span.startHead & 0xff;
    buf[5] = (span.startHead >>> 8) & 0xff;
    buf[6] = (span.startHead >>> 16) & 0xff;
    buf[7] = span.deviceCode & 0xff;
    buf.writeUInt16LE(span.pointCount, 8);
    return buf;
  }

  private buildRandomBitWriteBody(
    bitTags: ResolvedMcTag[],
    bufferView: BinaryIpcBufferView
  ): Buffer {
    const buf = Buffer.alloc(4 + 1 + bitTags.length * 5);
    buf.writeUInt16LE(0x1402, 0); // Random Write command
    buf.writeUInt16LE(0x0001, 2); // Subcommand: Bit units
    buf[4] = bitTags.length & 0xff;

    let off = 5;
    for (let i = 0; i < bitTags.length; i++) {
      const { binding, addr } = bitTags[i];
      const val = Boolean(readSimToPlcWireValue(bufferView, binding));
      buf[off] = addr.headDeviceNumber & 0xff;
      buf[off + 1] = (addr.headDeviceNumber >>> 8) & 0xff;
      buf[off + 2] = (addr.headDeviceNumber >>> 16) & 0xff;
      buf[off + 3] = addr.deviceCode & 0xff;
      buf[off + 4] = val ? 0x01 : 0x00;
      off += 5;
    }
    return buf;
  }

  private buildRandomWordWriteBody(
    wordTags: ResolvedMcTag[],
    dwordTags: ResolvedMcTag[],
    bufferView: BinaryIpcBufferView
  ): Buffer {
    const buf = Buffer.alloc(
      4 + 2 + wordTags.length * 6 + dwordTags.length * 8
    );
    buf.writeUInt16LE(0x1402, 0); // Random Write command
    buf.writeUInt16LE(0x0000, 2); // Subcommand: Word/DWord units
    buf[4] = wordTags.length & 0xff;
    buf[5] = dwordTags.length & 0xff;

    let off = 6;
    for (let i = 0; i < wordTags.length; i++) {
      const { binding, addr } = wordTags[i];
      const raw = Number(readSimToPlcWireValue(bufferView, binding)) | 0;
      buf[off] = addr.headDeviceNumber & 0xff;
      buf[off + 1] = (addr.headDeviceNumber >>> 8) & 0xff;
      buf[off + 2] = (addr.headDeviceNumber >>> 16) & 0xff;
      buf[off + 3] = addr.deviceCode & 0xff;
      buf.writeInt16LE(raw, off + 4);
      off += 6;
    }

    for (let i = 0; i < dwordTags.length; i++) {
      const { binding, addr } = dwordTags[i];
      const raw = Number(readSimToPlcWireValue(bufferView, binding));
      buf[off] = addr.headDeviceNumber & 0xff;
      buf[off + 1] = (addr.headDeviceNumber >>> 8) & 0xff;
      buf[off + 2] = (addr.headDeviceNumber >>> 16) & 0xff;
      buf[off + 3] = addr.deviceCode & 0xff;
      if (binding.dataType === 'DINT32') {
        buf.writeInt32LE(raw | 0, off + 4);
      } else {
        buf.writeFloatLE(raw, off + 4);
      }
      off += 8;
    }

    return buf;
  }

  private decodeBatchReadPayload(
    span: ContiguousSpan,
    data: Buffer,
    bufferView: BinaryIpcBufferView
  ): void {
    if (span.isBitDevice) {
      // 3E Binary bit read packs 2 bit points per byte: high nibble = even index, low nibble = odd index
      for (let i = 0; i < span.tags.length; i++) {
        const { binding, addr } = span.tags[i];
        const relIdx = addr.headDeviceNumber - span.startHead;
        const byteIdx = relIdx >>> 1;
        if (byteIdx >= data.length) continue;
        const nibble =
          (relIdx & 1) === 0
            ? (data[byteIdx] >>> 4) & 0x0f
            : data[byteIdx] & 0x0f;
        writePlcToSimFromWire(bufferView, binding, nibble !== 0);
      }
      return;
    }

    for (let i = 0; i < span.tags.length; i++) {
      const { binding, addr } = span.tags[i];
      const byteOff = (addr.headDeviceNumber - span.startHead) * 2;
      if (binding.dataType === 'INT16' && byteOff + 2 <= data.length) {
        writePlcToSimFromWire(bufferView, binding, data.readInt16LE(byteOff));
      } else if (binding.dataType === 'DINT32' && byteOff + 4 <= data.length) {
        writePlcToSimFromWire(bufferView, binding, data.readInt32LE(byteOff));
      } else if (binding.dataType === 'FLOAT32' && byteOff + 4 <= data.length) {
        writePlcToSimFromWire(bufferView, binding, data.readFloatLE(byteOff));
      }
    }
  }

  private send3EFrameAndWait(
    tagMap: PlcTagMap,
    commandBody: Buffer
  ): Promise<Buffer> {
    const cfg = tagMap.mcConfig;
    const reqDataLen = 2 + commandBody.length;
    const header = Buffer.alloc(11);
    header[0] = 0x50; // 3E Binary Request Subheader
    header[1] = 0x00;
    header[2] = (cfg.networkNo ?? 0) & 0xff;
    header[3] = (cfg.pcNo ?? 0xff) & 0xff;
    header.writeUInt16LE((cfg.unitIoNo ?? 0x03ff) & 0xffff, 4);
    header[6] = (cfg.unitStationNo ?? 0) & 0xff;
    header.writeUInt16LE(reqDataLen, 7);
    header.writeUInt16LE(0x0010, 9); // Monitoring timer = 4s

    const packet = Buffer.concat([header, commandBody]);

    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('MC 3E socket is not connected'));
        return;
      }
      if (this.pendingResolve) {
        reject(new Error('Concurrent MC 3E request in flight'));
        return;
      }

      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.pendingTimer = setTimeout(() => {
        this.failPending(new Error('MC 3E Binary response timeout'));
      }, REQUEST_TIMEOUT_MS);

      this.socket.write(packet, (err) => {
        if (err) this.failPending(err);
      });
    });
  }

  private openTcpSocket(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      sock.setNoDelay(true);

      const onErr = (err: Error) => {
        clearTimeout(timer);
        sock.destroy();
        reject(err);
      };

      const timer = setTimeout(() => {
        sock.removeListener('error', onErr);
        sock.destroy();
        reject(
          new Error(`Timeout connecting to GX Simulator3 / MC ${host}:${port}`)
        );
      }, CONNECT_TIMEOUT_MS);

      sock.once('error', onErr);
      sock.connect(port, host, () => {
        clearTimeout(timer);
        sock.removeListener('error', onErr);
        this.attachSocketListeners(sock);
        resolve(sock);
      });
    });
  }

  private attachSocketListeners(sock: net.Socket): void {
    this.rxAccumulator = Buffer.alloc(0);

    sock.on('data', (chunk: Buffer) => {
      this.rxAccumulator =
        this.rxAccumulator.length === 0
          ? chunk
          : Buffer.concat([this.rxAccumulator, chunk]);

      while (this.rxAccumulator.length >= 11) {
        if (
          this.rxAccumulator[0] !== 0xd0 ||
          this.rxAccumulator[1] !== 0x00
        ) {
          this.failPending(
            new Error(
              `Invalid MC 3E response subheader 0x${this.rxAccumulator[0].toString(
                16
              )}`
            )
          );
          return;
        }

        const respDataLen = this.rxAccumulator.readUInt16LE(7);
        const totalFrameLen = 9 + respDataLen;
        if (respDataLen < 2 || totalFrameLen > 65535) {
          this.failPending(new Error('Invalid MC 3E response length'));
          return;
        }
        if (this.rxAccumulator.length < totalFrameLen) {
          break;
        }

        const frame = this.rxAccumulator.subarray(0, totalFrameLen);
        this.rxAccumulator = this.rxAccumulator.subarray(totalFrameLen);

        const endCode = frame.readUInt16LE(9);
        if (endCode !== 0x0000) {
          this.failPending(
            new Error(`MELSEC PLC returned 3E error code 0x${endCode.toString(16)}`)
          );
          continue;
        }

        const dataPayload = frame.subarray(11);
        if (this.pendingResolve) {
          const resolve = this.pendingResolve;
          this.clearPendingHandlers();
          resolve(dataPayload);
        }
      }
    });

    sock.on('error', (err) => {
      this.lastError = err.message;
      this.failPending(err);
    });

    sock.on('close', () => {
      if (this.state === 'CONNECTED') {
        this.state = 'FAULT';
      }
      this.failPending(new Error('MC 3E TCP socket closed'));
    });
  }

  private clearPendingHandlers(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.pendingResolve = null;
    this.pendingReject = null;
  }

  private failPending(err: Error): void {
    const reject = this.pendingReject;
    this.clearPendingHandlers();
    if (reject) reject(err);
  }

  private async teardownSocket(): Promise<void> {
    this.failPending(new Error('MC adapter disconnecting'));
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.rxAccumulator = Buffer.alloc(0);
  }
}
