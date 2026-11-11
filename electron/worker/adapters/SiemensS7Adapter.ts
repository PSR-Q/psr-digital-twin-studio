import * as net from 'node:net';
import {
  parseS7Address,
  type ParsedS7Address,
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
 * Siemens S7-1200 / S7-1500 / S7-PLCSIM Advanced Adapter (Spec §3.D.2)
 *
 * Implements RFC 1006 (TPKT) + ISO 8073 (COTP) + S7Comm (0x32) Setup, Multi-Item Read (0x04),
 * and Multi-Item Write (0x05) directly over Node.js TCP sockets (zero native C++ addon build failures),
 * plus an optional architecture hook for S7-PLCSIM Advanced Shared Memory / Named-Pipe bridges.
 */

interface ResolvedS7Tag {
  binding: PlcTagBinding;
  addr: ParsedS7Address;
}

const CONNECT_TIMEOUT_MS = 1800;
const REQUEST_TIMEOUT_MS = 1200;
const RECONNECT_BACKOFF_MS = 2500;

export class SiemensS7Adapter implements IPlcAdapter {
  public readonly adapterType = 'SiemensS7Adapter' as const;

  private socket: net.Socket | null = null;
  private shmPipeSocket: net.Socket | null = null;
  private state: PlcConnectionState = 'DISCONNECTED';

  private pduRef = 1;
  private negotiatedPduLen = 240;
  private rxAccumulator: Buffer = Buffer.alloc(0);
  private pendingResolve: ((pkt: Buffer) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  private lastConnectAttemptMs = 0;
  private connectInProgress = false;
  private endpointSummary = '192.168.0.1:102 (R0/S1)';
  private sharedMemoryHookStatus = 'Disabled (ISO-on-TCP :102)';
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
      sharedMemoryHookStatus: this.sharedMemoryHookStatus,
    };
  }

  public async connect(tagMap: PlcTagMap): Promise<void> {
    if (this.connectInProgress) return;
    this.connectInProgress = true;
    await this.teardownSockets();

    const cfg = tagMap.s7Config;
    const host = (cfg.host || '192.168.0.1').trim();
    const port = cfg.port || 102;
    const rack = Math.max(0, Math.min(7, cfg.rack ?? 0));
    const slot = Math.max(0, Math.min(31, cfg.slot ?? 1));
    this.endpointSummary = `${host}:${port} (Rack ${rack} / Slot ${slot})`;

    // Optional Architecture Hook: S7-PLCSIM Advanced Native C++/FFI Shared Memory / Named-Pipe Bridge
    if (cfg.enablePlcsimAdvSharedMemoryHook) {
      const instName = (cfg.plcsimAdvInstanceName || 'VC_PLC_01').trim();
      const hooked = await this.probePlcsimAdvSharedMemoryHook(instName);
      if (hooked) {
        this.sharedMemoryHookStatus = `Active SHM Bridge (${instName})`;
      } else {
        this.sharedMemoryHookStatus = `Hook Armed (${instName}) · Fallback ISO-on-TCP`;
      }
    } else {
      this.sharedMemoryHookStatus = 'Disabled (ISO-on-TCP Mode)';
    }

    this.state = 'CONNECTING';
    this.lastConnectAttemptMs = Date.now();

    try {
      const sock = await this.openTcpSocket(host, port);
      this.socket = sock;

      // 1. ISO 8073 COTP Connection Request (CR -> CC)
      const cotpCr = this.buildCotpConnectRequest(rack, slot);
      const cotpCc = await this.sendTpktAndWait(cotpCr);
      if (cotpCc.length < 6 || (cotpCc[5] & 0xf0) !== 0xd0) {
        throw new Error(
          `Invalid COTP Connection Confirm (got 0x${(cotpCc[5] ?? 0).toString(16)})`
        );
      }

      // 2. S7Comm Setup Communication (Function 0xF0)
      const s7SetupReq = this.buildS7SetupCommPacket();
      const s7SetupRes = await this.sendTpktAndWait(s7SetupReq);
      if (s7SetupRes.length < 25 || s7SetupRes[7] !== 0x32) {
        throw new Error('Invalid S7Comm Setup Communication response');
      }
      const negotiated = s7SetupRes.readUInt16BE(s7SetupRes.length - 2);
      this.negotiatedPduLen = Math.max(240, Math.min(960, negotiated || 240));

      this.state = 'CONNECTED';
      this.lastError = '';
    } catch (err) {
      this.errorCount = (this.errorCount + 1) >>> 0;
      this.lastError =
        err instanceof Error ? err.message : 'S7 ISO-on-TCP connection failed';
      this.state = 'FAULT';
      await this.teardownSockets();
    } finally {
      this.connectInProgress = false;
    }
  }

  public async disconnect(): Promise<void> {
    await this.teardownSockets();
    this.state = 'DISCONNECTED';
  }

  public async executeScanCycle(
    bufferView: BinaryIpcBufferView,
    tagMap: PlcTagMap
  ): Promise<void> {
    // Keep manual forces responsive at all times
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

    const readTags: ResolvedS7Tag[] = [];
    const writeTags: ResolvedS7Tag[] = [];

    for (let i = 0; i < tagMap.bindings.length; i++) {
      const b = tagMap.bindings[i];
      const parsed = parseS7Address(b.plcAddress, b.dataType);
      if (!parsed) continue;
      if (b.direction === 'PLC_TO_SIM') {
        readTags.push({ binding: b, addr: parsed });
      } else {
        writeTags.push({ binding: b, addr: parsed });
      }
    }

    try {
      // 1. Write SIM_TO_PLC feedback sensors, HSC DINT32 pulses & Servo REAL positions to S7 PLC
      if (writeTags.length > 0) {
        const writeChunks = this.chunkWriteItems(writeTags);
        for (let c = 0; c < writeChunks.length; c++) {
          const pkt = this.buildS7WritePacket(writeChunks[c], bufferView);
          const resp = await this.sendTpktAndWait(pkt);
          this.validateS7AckHeader(resp, 'WriteVar');
          this.cyclicWriteCount = (this.cyclicWriteCount + 1) >>> 0;
        }
      }

      // 2. Read PLC_TO_SIM outputs & analog/servo setpoints from S7 PLC
      if (readTags.length > 0) {
        const readChunks = this.chunkReadItems(readTags);
        for (let c = 0; c < readChunks.length; c++) {
          const chunk = readChunks[c];
          const pkt = this.buildS7ReadPacket(chunk);
          const resp = await this.sendTpktAndWait(pkt);
          this.decodeS7ReadResponse(resp, chunk, bufferView);
          this.cyclicReadCount = (this.cyclicReadCount + 1) >>> 0;
        }
      }
    } catch (err) {
      this.errorCount = (this.errorCount + 1) >>> 0;
      this.lastError =
        err instanceof Error ? err.message : 'S7 cyclic I/O error';
      this.state = 'FAULT';
      await this.teardownSockets();
    }
  }

  private async probePlcsimAdvSharedMemoryHook(
    instanceName: string
  ): Promise<boolean> {
    const customPipe =
      process.env.VC_PLCSIM_ADV_SHM_PIPE ||
      (process.platform === 'win32'
        ? `\\\\.\\pipe\\VC_PLCSIM_ADV_${instanceName}`
        : '');
    if (!customPipe) return false;

    return new Promise<boolean>((resolve) => {
      const pipe = net.createConnection(customPipe);
      const timer = setTimeout(() => {
        pipe.destroy();
        resolve(false);
      }, 220);

      pipe.once('connect', () => {
        clearTimeout(timer);
        this.shmPipeSocket = pipe;
        pipe.on('error', () => {
          this.shmPipeSocket = null;
        });
        resolve(true);
      });

      pipe.once('error', () => {
        clearTimeout(timer);
        pipe.destroy();
        resolve(false);
      });
    });
  }

  private openTcpSocket(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      sock.setNoDelay(true);

      const onConnectError = (err: Error) => {
        clearTimeout(timer);
        sock.destroy();
        reject(err);
      };

      const timer = setTimeout(() => {
        sock.removeListener('error', onConnectError);
        sock.destroy();
        reject(new Error(`Timeout connecting to S7 ${host}:${port}`));
      }, CONNECT_TIMEOUT_MS);

      sock.once('error', onConnectError);
      sock.connect(port, host, () => {
        clearTimeout(timer);
        sock.removeListener('error', onConnectError);
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

      while (this.rxAccumulator.length >= 4) {
        if (this.rxAccumulator[0] !== 0x03) {
          this.failPending(new Error('Invalid TPKT header byte on S7 stream'));
          return;
        }
        const tpktLen = this.rxAccumulator.readUInt16BE(2);
        if (tpktLen < 4 || tpktLen > 16384) {
          this.failPending(new Error(`Invalid TPKT packet length ${tpktLen}`));
          return;
        }
        if (this.rxAccumulator.length < tpktLen) {
          break;
        }

        const fullPacket = this.rxAccumulator.subarray(0, tpktLen);
        this.rxAccumulator = this.rxAccumulator.subarray(tpktLen);

        if (this.pendingResolve) {
          const resolve = this.pendingResolve;
          this.clearPendingHandlers();
          resolve(fullPacket);
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
      this.failPending(new Error('S7 TCP socket closed'));
    });
  }

  private sendTpktAndWait(packet: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('S7 socket is not connected'));
        return;
      }
      if (this.pendingResolve) {
        reject(new Error('Concurrent S7 request in flight'));
        return;
      }

      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.pendingTimer = setTimeout(() => {
        this.failPending(new Error('S7 PDU response timeout'));
      }, REQUEST_TIMEOUT_MS);

      this.socket.write(packet, (err) => {
        if (err) {
          this.failPending(err);
        }
      });
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

  private async teardownSockets(): Promise<void> {
    this.failPending(new Error('S7 adapter disconnecting'));
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    if (this.shmPipeSocket) {
      this.shmPipeSocket.removeAllListeners();
      this.shmPipeSocket.destroy();
      this.shmPipeSocket = null;
    }
    this.rxAccumulator = Buffer.alloc(0);
  }

  private nextPduReference(): number {
    this.pduRef = (this.pduRef + 1) & 0xffff;
    if (this.pduRef === 0) this.pduRef = 1;
    return this.pduRef;
  }

  private buildCotpConnectRequest(rack: number, slot: number): Buffer {
    const dstTsapLow = ((rack & 0x07) << 5) | (slot & 0x1f);
    return Buffer.from([
      0x03,
      0x00,
      0x00,
      0x16, // TPKT (22 bytes)
      0x11, // COTP length = 17
      0xe0, // CR (Connection Request)
      0x00,
      0x00, // Dst Ref
      0x00,
      0x01, // Src Ref
      0x00, // Class 0
      0xc0,
      0x01,
      0x0a, // TPDU size 1024 B
      0xc1,
      0x02,
      0x01,
      0x00, // Src TSAP 0x0100
      0xc2,
      0x02,
      0x01,
      dstTsapLow, // Dst TSAP (0x01 = PG connection, rack/slot)
    ]);
  }

  private buildS7SetupCommPacket(): Buffer {
    const buf = Buffer.alloc(25);
    // TPKT
    buf[0] = 0x03;
    buf[1] = 0x00;
    buf.writeUInt16BE(25, 2);
    // COTP DT Data
    buf[4] = 0x02;
    buf[5] = 0xf0;
    buf[6] = 0x80;
    // S7 Header (Job 0x01)
    buf[7] = 0x32;
    buf[8] = 0x01;
    buf.writeUInt16BE(0, 9);
    buf.writeUInt16BE(this.nextPduReference(), 11);
    buf.writeUInt16BE(8, 13); // Param len = 8
    buf.writeUInt16BE(0, 15); // Data len = 0
    // Setup Comm Param
    buf[17] = 0xf0;
    buf[18] = 0x00;
    buf.writeUInt16BE(1, 19); // Max AmQ calling
    buf.writeUInt16BE(1, 21); // Max AmQ called
    buf.writeUInt16BE(480, 23); // Requested PDU len = 480
    return buf;
  }

  private writeS7AnyItemSpec(
    target: Buffer,
    offset: number,
    addr: ParsedS7Address
  ): void {
    target[offset] = 0x12; // Variable specification
    target[offset + 1] = 0x0a; // Remaining length = 10
    target[offset + 2] = 0x10; // Syntax ID = S7ANY
    target[offset + 3] = addr.isBit ? 0x01 : 0x02; // 0x01 = BIT, 0x02 = BYTE
    target.writeUInt16BE(addr.isBit ? 1 : addr.byteLength, offset + 4);
    target.writeUInt16BE(addr.areaCode === 0x84 ? addr.dbNumber : 0, offset + 6);
    target[offset + 8] = addr.areaCode;

    const bitAddress = addr.byteOffset * 8 + (addr.isBit ? addr.bitOffset : 0);
    target[offset + 9] = (bitAddress >>> 16) & 0xff;
    target[offset + 10] = (bitAddress >>> 8) & 0xff;
    target[offset + 11] = bitAddress & 0xff;
  }

  private chunkReadItems(items: ResolvedS7Tag[]): ResolvedS7Tag[][] {
    const chunks: ResolvedS7Tag[][] = [];
    const maxBudget = Math.max(180, this.negotiatedPduLen - 28);
    let cur: ResolvedS7Tag[] = [];
    let reqBytes = 2;
    let resBytes = 2;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const itemReq = 12;
      const itemRes = 4 + it.addr.byteLength + (it.addr.byteLength % 2);
      if (
        cur.length > 0 &&
        (cur.length >= 18 ||
          reqBytes + itemReq > maxBudget ||
          resBytes + itemRes > maxBudget)
      ) {
        chunks.push(cur);
        cur = [];
        reqBytes = 2;
        resBytes = 2;
      }
      cur.push(it);
      reqBytes += itemReq;
      resBytes += itemRes;
    }
    if (cur.length > 0) chunks.push(cur);
    return chunks;
  }

  private chunkWriteItems(items: ResolvedS7Tag[]): ResolvedS7Tag[][] {
    const chunks: ResolvedS7Tag[][] = [];
    const maxBudget = Math.max(180, this.negotiatedPduLen - 28);
    let cur: ResolvedS7Tag[] = [];
    let usedBytes = 2;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const itemCost = 12 + 4 + it.addr.byteLength + (it.addr.byteLength % 2);
      if (cur.length > 0 && (cur.length >= 14 || usedBytes + itemCost > maxBudget)) {
        chunks.push(cur);
        cur = [];
        usedBytes = 2;
      }
      cur.push(it);
      usedBytes += itemCost;
    }
    if (cur.length > 0) chunks.push(cur);
    return chunks;
  }

  private buildS7ReadPacket(items: ResolvedS7Tag[]): Buffer {
    const paramLen = 2 + items.length * 12;
    const totalLen = 4 + 3 + 10 + paramLen;
    const buf = Buffer.alloc(totalLen);

    buf[0] = 0x03;
    buf[1] = 0x00;
    buf.writeUInt16BE(totalLen, 2);

    buf[4] = 0x02;
    buf[5] = 0xf0;
    buf[6] = 0x80;

    buf[7] = 0x32;
    buf[8] = 0x01; // Job
    buf.writeUInt16BE(0, 9);
    buf.writeUInt16BE(this.nextPduReference(), 11);
    buf.writeUInt16BE(paramLen, 13);
    buf.writeUInt16BE(0, 15);

    buf[17] = 0x04; // Function: Read Var
    buf[18] = items.length & 0xff;

    let offset = 19;
    for (let i = 0; i < items.length; i++) {
      this.writeS7AnyItemSpec(buf, offset, items[i].addr);
      offset += 12;
    }

    return buf;
  }

  private buildS7WritePacket(
    items: ResolvedS7Tag[],
    bufferView: BinaryIpcBufferView
  ): Buffer {
    const paramLen = 2 + items.length * 12;
    let dataLen = 0;
    for (let i = 0; i < items.length; i++) {
      const len = items[i].addr.isBit ? 1 : items[i].addr.byteLength;
      dataLen += 4 + len;
      if (i < items.length - 1 && len % 2 === 1) {
        dataLen += 1;
      }
    }

    const totalLen = 4 + 3 + 10 + paramLen + dataLen;
    const buf = Buffer.alloc(totalLen);

    buf[0] = 0x03;
    buf[1] = 0x00;
    buf.writeUInt16BE(totalLen, 2);

    buf[4] = 0x02;
    buf[5] = 0xf0;
    buf[6] = 0x80;

    buf[7] = 0x32;
    buf[8] = 0x01; // Job
    buf.writeUInt16BE(0, 9);
    buf.writeUInt16BE(this.nextPduReference(), 11);
    buf.writeUInt16BE(paramLen, 13);
    buf.writeUInt16BE(dataLen, 15);

    buf[17] = 0x05; // Function: Write Var
    buf[18] = items.length & 0xff;

    let pOff = 19;
    for (let i = 0; i < items.length; i++) {
      this.writeS7AnyItemSpec(buf, pOff, items[i].addr);
      pOff += 12;
    }

    let dOff = 17 + paramLen;
    for (let i = 0; i < items.length; i++) {
      const { binding, addr } = items[i];
      const rawVal = readSimToPlcWireValue(bufferView, binding);

      if (addr.isBit) {
        buf[dOff] = 0x00;
        buf[dOff + 1] = 0x03; // Transport size: BIT
        buf.writeUInt16BE(1, dOff + 2);
        buf[dOff + 4] = rawVal ? 0x01 : 0x00;
        dOff += 5;
        if (i < items.length - 1) {
          buf[dOff] = 0x00; // Even byte alignment pad
          dOff += 1;
        }
      } else {
        const byteLen = addr.byteLength;
        buf[dOff] = 0x00;
        buf[dOff + 1] = 0x04; // Transport size: BYTE/WORD/DWORD (length in bits!)
        buf.writeUInt16BE(byteLen * 8, dOff + 2);

        if (binding.dataType === 'INT16') {
          buf.writeInt16BE(Number(rawVal) | 0, dOff + 4);
        } else if (binding.dataType === 'DINT32') {
          buf.writeInt32BE(Number(rawVal) | 0, dOff + 4);
        } else {
          buf.writeFloatBE(Number(rawVal), dOff + 4);
        }
        dOff += 4 + byteLen;
      }
    }

    return buf;
  }

  private validateS7AckHeader(pkt: Buffer, contextLabel: string): void {
    if (pkt.length < 19 || pkt[7] !== 0x32) {
      throw new Error(`Malformed S7 ${contextLabel} PDU`);
    }
    const rosctr = pkt[8];
    if (rosctr !== 0x03) {
      throw new Error(`Unexpected S7 ROSCTR 0x${rosctr.toString(16)} in ${contextLabel}`);
    }
    const errClass = pkt[17];
    const errCode = pkt[18];
    if (errClass !== 0 || errCode !== 0) {
      throw new Error(
        `S7 PLC rejected ${contextLabel} (errClass=0x${errClass.toString(
          16
        )}, errCode=0x${errCode.toString(16)})`
      );
    }
  }

  private decodeS7ReadResponse(
    pkt: Buffer,
    items: ResolvedS7Tag[],
    bufferView: BinaryIpcBufferView
  ): void {
    this.validateS7AckHeader(pkt, 'ReadVar');
    const paramLen = pkt.readUInt16BE(13);
    let cursor = 19 + paramLen;

    for (let i = 0; i < items.length; i++) {
      if (cursor + 4 > pkt.length) break;
      const returnCode = pkt[cursor];
      const transportSize = pkt[cursor + 1];
      const rawLength = pkt.readUInt16BE(cursor + 2);
      cursor += 4;

      const byteLen =
        transportSize === 0x04
          ? rawLength >>> 3
          : transportSize === 0x03
            ? Math.ceil(rawLength / 8)
            : rawLength;

      if (returnCode === 0xff && cursor + byteLen <= pkt.length) {
        const { binding, addr } = items[i];
        if (addr.isBit) {
          writePlcToSimFromWire(bufferView, binding, (pkt[cursor] & 0x01) !== 0);
        } else if (binding.dataType === 'INT16' && byteLen >= 2) {
          writePlcToSimFromWire(bufferView, binding, pkt.readInt16BE(cursor));
        } else if (binding.dataType === 'DINT32' && byteLen >= 4) {
          writePlcToSimFromWire(bufferView, binding, pkt.readInt32BE(cursor));
        } else if (binding.dataType === 'FLOAT32' && byteLen >= 4) {
          writePlcToSimFromWire(bufferView, binding, pkt.readFloatBE(cursor));
        }
      }

      cursor += byteLen;
      if (i < items.length - 1 && byteLen % 2 === 1) {
        cursor += 1;
      }
    }
  }
}
