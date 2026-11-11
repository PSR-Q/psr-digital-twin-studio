import * as crypto from 'node:crypto';
import * as net from 'node:net';
import {
  parseOpcUaNodeId,
  type ParsedOpcUaNodeId,
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
 * Omron Sysmac Studio / CODESYS / TwinCAT / Universal OPC UA Binary TCP Adapter (Spec §3.D.4)
 *
 * Implements IEC 62541-6 (`opc.tcp://`) Part 6 Binary Wire Protocol directly on Node.js TCP sockets:
 *   1. HEL -> ACK transport buffer negotiation
 *   2. OPN OpenSecureChannel (i=446 -> i=449)
 *   3. MSG CreateSession (i=461 -> i=464) & ActivateSession (i=467 -> i=470, AnonymousIdentityToken i=321)
 *   4. Cyclic batched ReadRequest (i=631) & WriteRequest (i=673) for Boolean, Int16, Int32 (HSC DINT), and Float (Servo REAL)
 *   5. CLO graceful channel teardown
 *
 * Zero external native C++ or 250MB XML dependencies — packages cleanly inside the standalone Windows `.exe`.
 */

const SECURITY_POLICY_NONE_URI =
  'http://opcfoundation.org/UA/SecurityPolicy#None';
const SECURITY_POLICY_B256SHA256_URI =
  'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256';

const CONNECT_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 1500;
const RECONNECT_BACKOFF_MS = 2500;

interface ResolvedOpcTag {
  binding: PlcTagBinding;
  nodeId: ParsedOpcUaNodeId;
}

class OpcBinaryWriter {
  private chunks: Buffer[] = [];

  public writeUInt8(v: number): void {
    const b = Buffer.allocUnsafe(1);
    b[0] = v & 0xff;
    this.chunks.push(b);
  }

  public writeInt16LE(v: number): void {
    const b = Buffer.allocUnsafe(2);
    b.writeInt16LE(v, 0);
    this.chunks.push(b);
  }

  public writeUInt16LE(v: number): void {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16LE(v & 0xffff, 0);
    this.chunks.push(b);
  }

  public writeInt32LE(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32LE(v | 0, 0);
    this.chunks.push(b);
  }

  public writeUInt32LE(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.chunks.push(b);
  }

  public writeFloatLE(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeFloatLE(v, 0);
    this.chunks.push(b);
  }

  public writeDoubleLE(v: number): void {
    const b = Buffer.allocUnsafe(8);
    b.writeDoubleLE(v, 0);
    this.chunks.push(b);
  }

  public writeDateTimeNow(): void {
    const b = Buffer.allocUnsafe(8);
    const ticks = BigInt(Date.now() + 11644473600000) * 10000n;
    b.writeBigInt64LE(ticks, 0);
    this.chunks.push(b);
  }

  public writeRaw(buf: Buffer): void {
    this.chunks.push(buf);
  }

  public writeString(str: string | null): void {
    if (str === null) {
      this.writeInt32LE(-1);
      return;
    }
    const bytes = Buffer.from(str, 'utf8');
    this.writeInt32LE(bytes.length);
    if (bytes.length > 0) this.chunks.push(bytes);
  }

  public writeByteString(buf: Buffer | null): void {
    if (buf === null) {
      this.writeInt32LE(-1);
      return;
    }
    this.writeInt32LE(buf.length);
    if (buf.length > 0) this.chunks.push(buf);
  }

  public writeFourByteExpandedNodeId(ns: number, numericId: number): void {
    if (ns === 0 && numericId <= 255) {
      this.chunks.push(Buffer.from([0x00, numericId & 0xff]));
    } else {
      const b = Buffer.allocUnsafe(4);
      b[0] = 0x01;
      b[1] = ns & 0xff;
      b.writeUInt16LE(numericId & 0xffff, 2);
      this.chunks.push(b);
    }
  }

  public writeParsedNodeId(node: ParsedOpcUaNodeId): void {
    if (node.identifierType === 'numeric') {
      const idNum = Number(node.identifier) >>> 0;
      if (node.namespaceIndex === 0 && idNum <= 255) {
        this.chunks.push(Buffer.from([0x00, idNum]));
      } else if (node.namespaceIndex <= 255 && idNum <= 65535) {
        const b = Buffer.allocUnsafe(4);
        b[0] = 0x01;
        b[1] = node.namespaceIndex & 0xff;
        b.writeUInt16LE(idNum, 2);
        this.chunks.push(b);
      } else {
        const b = Buffer.allocUnsafe(7);
        b[0] = 0x02;
        b.writeUInt16LE(node.namespaceIndex & 0xffff, 1);
        b.writeUInt32LE(idNum, 3);
        this.chunks.push(b);
      }
      return;
    }

    const head = Buffer.allocUnsafe(3);
    head[0] = 0x03; // String NodeId
    head.writeUInt16LE(node.namespaceIndex & 0xffff, 1);
    this.chunks.push(head);
    this.writeString(String(node.identifier));
  }

  public writeRequestHeader(
    authTokenRaw: Buffer,
    requestHandle: number,
    timeoutMs = 2000
  ): void {
    this.writeRaw(authTokenRaw);
    this.writeDateTimeNow();
    this.writeUInt32LE(requestHandle);
    this.writeUInt32LE(0); // ReturnDiagnostics = 0
    this.writeString(null); // AuditEntryId
    this.writeUInt32LE(timeoutMs);
    // AdditionalHeader: Null ExtensionObject (TwoByte NodeId 0, Encoding 0x00)
    this.chunks.push(Buffer.from([0x00, 0x00, 0x00]));
  }

  public toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class OpcBinaryReader {
  private offset = 0;
  private readonly buf: Buffer;

  public constructor(buf: Buffer, initialOffset = 0) {
    this.buf = buf;
    this.offset = initialOffset;
  }

  public get position(): number {
    return this.offset;
  }

  public remaining(): number {
    return Math.max(0, this.buf.length - this.offset);
  }

  public readUInt8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  public readInt8(): number {
    const v = this.buf.readInt8(this.offset);
    this.offset += 1;
    return v;
  }

  public readInt16LE(): number {
    const v = this.buf.readInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  public readUInt16LE(): number {
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  public readInt32LE(): number {
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  public readUInt32LE(): number {
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  public readFloatLE(): number {
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }

  public readDoubleLE(): number {
    const v = this.buf.readDoubleLE(this.offset);
    this.offset += 8;
    return v;
  }

  public skip(byteCount: number): void {
    this.offset = Math.min(this.buf.length, this.offset + byteCount);
  }

  public skipByteStringOrString(): void {
    const len = this.readInt32LE();
    if (len > 0) this.skip(len);
  }

  public readString(): string | null {
    const len = this.readInt32LE();
    if (len < 0) return null;
    const s = this.buf.toString('utf8', this.offset, this.offset + len);
    this.offset += len;
    return s;
  }

  public readNodeIdRawBytes(): Buffer {
    const start = this.offset;
    const encoding = this.readUInt8();
    const baseType = encoding & 0x3f;

    if (baseType === 0x00) {
      this.skip(1);
    } else if (baseType === 0x01) {
      this.skip(3);
    } else if (baseType === 0x02) {
      this.skip(6);
    } else if (baseType === 0x03 || baseType === 0x05) {
      this.skip(2);
      this.skipByteStringOrString();
    } else if (baseType === 0x04) {
      this.skip(18);
    }

    if (encoding & 0x80) {
      this.skipByteStringOrString(); // NamespaceUri
    }
    if (encoding & 0x40) {
      this.skip(4); // ServerIndex
    }

    return Buffer.from(this.buf.subarray(start, this.offset));
  }

  public readExpandedNodeIdNumeric(): number {
    const encoding = this.readUInt8();
    const baseType = encoding & 0x3f;
    let id = 0;

    if (baseType === 0x00) {
      id = this.readUInt8();
    } else if (baseType === 0x01) {
      this.skip(1); // ns
      id = this.readUInt16LE();
    } else if (baseType === 0x02) {
      this.skip(2); // ns
      id = this.readUInt32LE();
    } else {
      this.offset -= 1;
      this.readNodeIdRawBytes();
    }

    if (encoding & 0x80) this.skipByteStringOrString();
    if (encoding & 0x40) this.skip(4);
    return id;
  }

  public skipDiagnosticInfo(): void {
    const mask = this.readUInt8();
    if (mask === 0) return;
    if (mask & 0x01) this.skip(4);
    if (mask & 0x02) this.skip(4);
    if (mask & 0x04) this.skip(4);
    if (mask & 0x08) this.skip(4);
    if (mask & 0x10) this.skipByteStringOrString();
    if (mask & 0x20) this.skip(4);
    if (mask & 0x40) this.skipDiagnosticInfo();
  }

  public readAndValidateResponseHeader(contextLabel: string): void {
    this.skip(8); // Timestamp
    this.skip(4); // RequestHandle
    const serviceResult = this.readUInt32LE();
    this.skipDiagnosticInfo();

    const strCount = this.readInt32LE();
    for (let i = 0; i < strCount; i++) {
      this.skipByteStringOrString();
    }

    // AdditionalHeader ExtensionObject
    this.readNodeIdRawBytes();
    const extMask = this.readUInt8();
    if (extMask === 0x01 || extMask === 0x02) {
      this.skipByteStringOrString();
    }

    if ((serviceResult & 0x80000000) !== 0) {
      throw new Error(
        `OPC UA ${contextLabel} failed with StatusCode 0x${serviceResult.toString(
          16
        )}`
      );
    }
  }

  public readDataValueScalar(): { good: boolean; value: boolean | number } {
    const mask = this.readUInt8();
    let value: boolean | number = 0;
    let good = false;

    if (mask & 0x01) {
      const varMask = this.readUInt8();
      const typeId = varMask & 0x3f;
      const isArray = (varMask & 0x80) !== 0;

      if (isArray) {
        const arrLen = Math.max(0, this.readInt32LE());
        for (let k = 0; k < arrLen; k++) {
          const elem = this.readScalarVariantByType(typeId);
          if (k === 0) value = elem;
        }
        if (varMask & 0x40) {
          const dims = Math.max(0, this.readInt32LE());
          this.skip(dims * 4);
        }
      } else {
        value = this.readScalarVariantByType(typeId);
      }
      good = true;
    }

    if (mask & 0x02) {
      const statusCode = this.readUInt32LE();
      if ((statusCode & 0x80000000) !== 0) {
        good = false;
      }
    }

    if (mask & 0x04) this.skip(8); // SourceTimestamp
    if (mask & 0x10) this.skip(2); // SourcePicoseconds
    if (mask & 0x08) this.skip(8); // ServerTimestamp
    if (mask & 0x20) this.skip(2); // ServerPicoseconds

    return { good, value };
  }

  private readScalarVariantByType(typeId: number): boolean | number {
    switch (typeId) {
      case 1:
        return this.readUInt8() !== 0;
      case 2:
        return this.readInt8();
      case 3:
        return this.readUInt8();
      case 4:
        return this.readInt16LE();
      case 5:
        return this.readUInt16LE();
      case 6:
        return this.readInt32LE();
      case 7:
        return this.readUInt32LE();
      case 10:
        return this.readFloatLE();
      case 11:
        return this.readDoubleLE();
      default:
        return 0;
    }
  }
}

function parseOpcEndpointHostPort(endpointUrl: string): {
  host: string;
  port: number;
  normalizedUrl: string;
} {
  const trimmed = (endpointUrl || 'opc.tcp://127.0.0.1:4840').trim();
  const match = /^opc\.tcp:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(trimmed);
  if (!match) {
    return {
      host: '127.0.0.1',
      port: 4840,
      normalizedUrl: 'opc.tcp://127.0.0.1:4840',
    };
  }
  const host = match[1];
  const port = match[2] ? Number(match[2]) : 4840;
  return { host, port, normalizedUrl: trimmed };
}

export class OpcUaAdapter implements IPlcAdapter {
  public readonly adapterType = 'OpcUaAdapter' as const;

  private socket: net.Socket | null = null;
  private state: PlcConnectionState = 'DISCONNECTED';

  private secureChannelId = 0;
  private tokenId = 0;
  private sequenceNumber = 1;
  private requestId = 1;
  private authTokenBytes: Buffer = Buffer.from([0x00, 0x00]);

  private rxAccumulator: Buffer = Buffer.alloc(0);
  private pendingResolve: ((chunk: Buffer) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  private lastConnectAttemptMs = 0;
  private connectInProgress = false;
  private endpointSummary = 'opc.tcp://127.0.0.1:4840 (NS=2)';
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
      sharedMemoryHookStatus: 'N/A (opc.tcp Binary)',
    };
  }

  public async connect(tagMap: PlcTagMap): Promise<void> {
    if (this.connectInProgress) return;
    this.connectInProgress = true;
    await this.teardownSocket(false);

    const cfg = tagMap.opcUaConfig;
    const { host, port, normalizedUrl } = parseOpcEndpointHostPort(
      cfg.endpointUrl
    );
    this.endpointSummary = `${normalizedUrl} (NS=${cfg.namespaceIndex ?? 2})`;

    if (cfg.securityMode !== 'None') {
      this.state = 'FAULT';
      this.lastError =
        'Unsigned commissioning mode requires SecurityMode=None (or switch PLC Simulator endpoint to None).';
      this.connectInProgress = false;
      return;
    }

    this.state = 'CONNECTING';
    this.lastConnectAttemptMs = Date.now();
    this.sequenceNumber = 1;
    this.requestId = 1;
    this.authTokenBytes = Buffer.from([0x00, 0x00]);

    try {
      const sock = await this.openTcpSocket(host, port);
      this.socket = sock;

      // 1. HEL -> ACK
      const helMsg = this.buildHelloMessage(normalizedUrl);
      const ackMsg = await this.sendFrameAndWait(helMsg);
      if (ackMsg.toString('ascii', 0, 3) !== 'ACK') {
        throw new Error('Expected OPC UA ACK chunk');
      }

      // 2. OPN (OpenSecureChannelRequest i=446 -> OpenSecureChannelResponse i=449)
      const opnReq = this.buildOpenSecureChannelMessage(cfg.securityPolicy);
      const opnRes = await this.sendFrameAndWait(opnReq);
      this.parseOpenSecureChannelResponse(opnRes);

      // 3. MSG CreateSessionRequest (i=461 -> i=464)
      const createSessReq = this.buildCreateSessionMessage(normalizedUrl);
      const createSessRes = await this.sendFrameAndWait(createSessReq);
      this.parseCreateSessionResponse(createSessRes);

      // 4. MSG ActivateSessionRequest (i=467 -> i=470)
      const actSessReq = this.buildActivateSessionMessage();
      const actSessRes = await this.sendFrameAndWait(actSessReq);
      this.parseActivateSessionResponse(actSessRes);

      this.state = 'CONNECTED';
      this.lastError = '';
    } catch (err) {
      this.errorCount = (this.errorCount + 1) >>> 0;
      this.lastError =
        err instanceof Error ? err.message : 'OPC UA connection failed';
      this.state = 'FAULT';
      await this.teardownSocket(false);
    } finally {
      this.connectInProgress = false;
    }
  }

  public async disconnect(): Promise<void> {
    await this.teardownSocket(true);
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

    const nsIdx = tagMap.opcUaConfig.namespaceIndex ?? 2;
    const readTags: ResolvedOpcTag[] = [];
    const writeTags: ResolvedOpcTag[] = [];

    for (let i = 0; i < tagMap.bindings.length; i++) {
      const b = tagMap.bindings[i];
      const parsed = parseOpcUaNodeId(b.plcAddress, nsIdx);
      if (!parsed) continue;
      if (b.direction === 'PLC_TO_SIM') {
        readTags.push({ binding: b, nodeId: parsed });
      } else {
        writeTags.push({ binding: b, nodeId: parsed });
      }
    }

    try {
      // 1. Batched OPC UA WriteRequest (i=673) for SIM_TO_PLC HSC DINT32, Servo REAL & BOOL Sensors
      if (writeTags.length > 0) {
        const writeMsg = this.buildWriteRequestMessage(writeTags, bufferView);
        const writeRes = await this.sendFrameAndWait(writeMsg);
        this.parseWriteResponse(writeRes);
        this.cyclicWriteCount = (this.cyclicWriteCount + 1) >>> 0;
      }

      // 2. Batched OPC UA ReadRequest (i=631) for PLC_TO_SIM Commands & Setpoints
      if (readTags.length > 0) {
        const readMsg = this.buildReadRequestMessage(readTags);
        const readRes = await this.sendFrameAndWait(readMsg);
        this.parseReadResponse(readRes, readTags, bufferView);
        this.cyclicReadCount = (this.cyclicReadCount + 1) >>> 0;
      }
    } catch (err) {
      this.errorCount = (this.errorCount + 1) >>> 0;
      this.lastError =
        err instanceof Error ? err.message : 'OPC UA cyclic Read/Write error';
      this.state = 'FAULT';
      await this.teardownSocket(false);
    }
  }

  private nextSeq(): number {
    const s = this.sequenceNumber;
    this.sequenceNumber = (this.sequenceNumber + 1) >>> 0;
    if (this.sequenceNumber === 0) this.sequenceNumber = 1;
    return s;
  }

  private nextReqId(): number {
    const r = this.requestId;
    this.requestId = (this.requestId + 1) >>> 0;
    if (this.requestId === 0) this.requestId = 1;
    return r;
  }

  private buildHelloMessage(endpointUrl: string): Buffer {
    const w = new OpcBinaryWriter();
    w.writeUInt32LE(0); // ProtocolVersion = 0
    w.writeUInt32LE(65536); // ReceiveBufferSize
    w.writeUInt32LE(65536); // SendBufferSize
    w.writeUInt32LE(0); // MaxMessageSize
    w.writeUInt32LE(0); // MaxChunkCount
    w.writeString(endpointUrl);

    const body = w.toBuffer();
    const head = Buffer.allocUnsafe(8);
    head.write('HELF', 0, 4, 'ascii');
    head.writeUInt32LE(8 + body.length, 4);
    return Buffer.concat([head, body]);
  }

  private buildOpenSecureChannelMessage(
    policy: 'None' | 'Basic256Sha256'
  ): Buffer {
    const policyUri =
      policy === 'Basic256Sha256'
        ? SECURITY_POLICY_B256SHA256_URI
        : SECURITY_POLICY_NONE_URI;

    const asym = new OpcBinaryWriter();
    asym.writeUInt32LE(0); // SecureChannelId = 0
    asym.writeString(policyUri);
    asym.writeByteString(null); // SenderCertificate
    asym.writeByteString(null); // ReceiverCertificateThumbprint

    const seq = new OpcBinaryWriter();
    seq.writeUInt32LE(this.nextSeq());
    const reqId = this.nextReqId();
    seq.writeUInt32LE(reqId);

    const body = new OpcBinaryWriter();
    body.writeFourByteExpandedNodeId(0, 446); // OpenSecureChannelRequest
    body.writeRequestHeader(Buffer.from([0x00, 0x00]), reqId);
    body.writeUInt32LE(0); // ClientProtocolVersion
    body.writeUInt32LE(0); // SecurityTokenRequestType = Issue (0)
    body.writeUInt32LE(1); // MessageSecurityMode = None (1)
    body.writeByteString(null); // ClientNonce
    body.writeUInt32LE(3_600_000); // RequestedLifetime = 1h

    const payload = Buffer.concat([
      asym.toBuffer(),
      seq.toBuffer(),
      body.toBuffer(),
    ]);
    const head = Buffer.allocUnsafe(8);
    head.write('OPNF', 0, 4, 'ascii');
    head.writeUInt32LE(8 + payload.length, 4);
    return Buffer.concat([head, payload]);
  }

  private parseOpenSecureChannelResponse(chunk: Buffer): void {
    if (chunk.toString('ascii', 0, 3) !== 'OPN') {
      throw new Error('Expected OPC UA OPN response');
    }
    const r = new OpcBinaryReader(chunk, 8);
    this.secureChannelId = r.readUInt32LE();
    r.skipByteStringOrString(); // SecurityPolicyUri
    r.skipByteStringOrString(); // SenderCert
    r.skipByteStringOrString(); // ReceiverThumbprint
    r.skip(8); // SequenceNumber + RequestId

    const typeId = r.readExpandedNodeIdNumeric();
    if (typeId !== 449) {
      throw new Error(`Unexpected OPN response TypeId i=${typeId}`);
    }
    r.readAndValidateResponseHeader('OpenSecureChannel');
    r.skip(4); // ServerProtocolVersion
    const respChannelId = r.readUInt32LE();
    if (respChannelId !== 0) this.secureChannelId = respChannelId;
    this.tokenId = r.readUInt32LE();
  }

  private wrapSymmetricMessage(serviceBody: Buffer, msgType: 'MSG' | 'CLO' = 'MSG'): Buffer {
    const sym = Buffer.allocUnsafe(24);
    sym.write(`${msgType}F`, 0, 4, 'ascii');
    sym.writeUInt32LE(24 + serviceBody.length, 4);
    sym.writeUInt32LE(this.secureChannelId, 8);
    sym.writeUInt32LE(this.tokenId, 12);
    sym.writeUInt32LE(this.nextSeq(), 16);
    sym.writeUInt32LE(this.nextReqId(), 20);
    return Buffer.concat([sym, serviceBody]);
  }

  private buildCreateSessionMessage(endpointUrl: string): Buffer {
    const w = new OpcBinaryWriter();
    w.writeFourByteExpandedNodeId(0, 461); // CreateSessionRequest
    w.writeRequestHeader(this.authTokenBytes, this.requestId);

    // ClientDescription (ApplicationDescription)
    w.writeString('urn:psr:vc-digital-twin-studio');
    w.writeString('urn:psr:vc-digital-twin');
    w.writeUInt8(0x02); // LocalizedText: Text present
    w.writeString('VC Digital Twin Studio');
    w.writeUInt32LE(1); // ApplicationType = Client (1)
    w.writeString(null); // GatewayServerUri
    w.writeString(null); // DiscoveryProfileUri
    w.writeInt32LE(-1); // DiscoveryUrls

    w.writeString(null); // ServerUri
    w.writeString(endpointUrl);
    w.writeString('VC_DigitalTwin_CyclicSync');
    w.writeByteString(crypto.randomBytes(32)); // ClientNonce
    w.writeByteString(null); // ClientCertificate
    w.writeDoubleLE(60_000.0); // RequestedSessionTimeout
    w.writeUInt32LE(0); // MaxResponseMessageSize

    return this.wrapSymmetricMessage(w.toBuffer());
  }

  private parseCreateSessionResponse(chunk: Buffer): void {
    const r = new OpcBinaryReader(chunk, 24);
    const typeId = r.readExpandedNodeIdNumeric();
    if (typeId !== 464) {
      throw new Error(`Unexpected CreateSession response TypeId i=${typeId}`);
    }
    r.readAndValidateResponseHeader('CreateSession');
    r.readNodeIdRawBytes(); // SessionId
    this.authTokenBytes = r.readNodeIdRawBytes(); // AuthenticationToken!
  }

  private buildActivateSessionMessage(): Buffer {
    const w = new OpcBinaryWriter();
    w.writeFourByteExpandedNodeId(0, 467); // ActivateSessionRequest
    w.writeRequestHeader(this.authTokenBytes, this.requestId);

    // ClientSignature
    w.writeString(null);
    w.writeByteString(null);
    // ClientSoftwareCertificates
    w.writeInt32LE(-1);
    // LocaleIds
    w.writeInt32LE(1);
    w.writeString('en-US');

    // UserIdentityToken: ExtensionObject -> AnonymousIdentityToken Binary Encoding (i=321)
    const anonBody = new OpcBinaryWriter();
    anonBody.writeString('anonymous');
    w.writeFourByteExpandedNodeId(0, 321);
    w.writeUInt8(0x01); // ByteString body
    w.writeByteString(anonBody.toBuffer());

    // UserTokenSignature
    w.writeString(null);
    w.writeByteString(null);

    return this.wrapSymmetricMessage(w.toBuffer());
  }

  private parseActivateSessionResponse(chunk: Buffer): void {
    const r = new OpcBinaryReader(chunk, 24);
    const typeId = r.readExpandedNodeIdNumeric();
    if (typeId !== 470) {
      throw new Error(`Unexpected ActivateSession response TypeId i=${typeId}`);
    }
    r.readAndValidateResponseHeader('ActivateSession');
  }

  private buildReadRequestMessage(tags: ResolvedOpcTag[]): Buffer {
    const w = new OpcBinaryWriter();
    w.writeFourByteExpandedNodeId(0, 631); // ReadRequest
    w.writeRequestHeader(this.authTokenBytes, this.requestId);
    w.writeDoubleLE(0.0); // MaxAge = 0
    w.writeUInt32LE(2); // TimestampsToReturn = Neither (2)
    w.writeInt32LE(tags.length);

    for (let i = 0; i < tags.length; i++) {
      w.writeParsedNodeId(tags[i].nodeId);
      w.writeUInt32LE(13); // AttributeId = Value (13)
      w.writeString(null); // IndexRange = null
      // DataEncoding = QualifiedName(0, null)
      w.writeUInt16LE(0);
      w.writeString(null);
    }

    return this.wrapSymmetricMessage(w.toBuffer());
  }

  private parseReadResponse(
    chunk: Buffer,
    tags: ResolvedOpcTag[],
    bufferView: BinaryIpcBufferView
  ): void {
    const r = new OpcBinaryReader(chunk, 24);
    const typeId = r.readExpandedNodeIdNumeric();
    if (typeId !== 634) {
      throw new Error(`Unexpected ReadResponse TypeId i=${typeId}`);
    }
    r.readAndValidateResponseHeader('Read');

    const count = r.readInt32LE();
    const limit = Math.min(count, tags.length);
    for (let i = 0; i < limit; i++) {
      const dv = r.readDataValueScalar();
      if (dv.good) {
        writePlcToSimFromWire(bufferView, tags[i].binding, dv.value);
      }
    }
  }

  private buildWriteRequestMessage(
    tags: ResolvedOpcTag[],
    bufferView: BinaryIpcBufferView
  ): Buffer {
    const w = new OpcBinaryWriter();
    w.writeFourByteExpandedNodeId(0, 673); // WriteRequest
    w.writeRequestHeader(this.authTokenBytes, this.requestId);
    w.writeInt32LE(tags.length);

    for (let i = 0; i < tags.length; i++) {
      const { binding, nodeId } = tags[i];
      const rawVal = readSimToPlcWireValue(bufferView, binding);

      w.writeParsedNodeId(nodeId);
      w.writeUInt32LE(13); // AttributeId = Value (13)
      w.writeString(null); // IndexRange = null
      w.writeUInt8(0x01); // DataValue EncodingMask = Value present (0x01)

      if (binding.dataType === 'BOOL') {
        w.writeUInt8(1); // Variant Boolean (1)
        w.writeUInt8(rawVal ? 1 : 0);
      } else if (binding.dataType === 'INT16') {
        w.writeUInt8(4); // Variant Int16 (4)
        w.writeInt16LE(Number(rawVal) | 0);
      } else if (binding.dataType === 'DINT32') {
        w.writeUInt8(6); // Variant Int32 (6) — 32-bit HSC Encoder Pulses!
        w.writeInt32LE(Number(rawVal) | 0);
      } else {
        w.writeUInt8(10); // Variant Float (10) — Servo Position / Velocity REAL!
        w.writeFloatLE(Number(rawVal));
      }
    }

    return this.wrapSymmetricMessage(w.toBuffer());
  }

  private parseWriteResponse(chunk: Buffer): void {
    const r = new OpcBinaryReader(chunk, 24);
    const typeId = r.readExpandedNodeIdNumeric();
    if (typeId !== 676) {
      throw new Error(`Unexpected WriteResponse TypeId i=${typeId}`);
    }
    r.readAndValidateResponseHeader('Write');
  }

  private sendFrameAndWait(packet: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('OPC UA socket is not connected'));
        return;
      }
      if (this.pendingResolve) {
        reject(new Error('Concurrent OPC UA request in flight'));
        return;
      }

      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.pendingTimer = setTimeout(() => {
        this.failPending(new Error('OPC UA Binary TCP response timeout'));
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
        reject(new Error(`Timeout connecting to OPC UA ${host}:${port}`));
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

      while (this.rxAccumulator.length >= 8) {
        const msgType = this.rxAccumulator.toString('ascii', 0, 3);
        const msgSize = this.rxAccumulator.readUInt32LE(4);

        if (msgSize < 8 || msgSize > 1_048_576) {
          this.failPending(new Error(`Invalid OPC UA message size ${msgSize}`));
          return;
        }
        if (this.rxAccumulator.length < msgSize) {
          break;
        }

        const fullMsg = this.rxAccumulator.subarray(0, msgSize);
        this.rxAccumulator = this.rxAccumulator.subarray(msgSize);

        if (msgType === 'ERR') {
          const errCode = fullMsg.length >= 12 ? fullMsg.readUInt32LE(8) : 0;
          const r = new OpcBinaryReader(fullMsg, 12);
          const reason = r.remaining() >= 4 ? r.readString() : null;
          this.failPending(
            new Error(
              `OPC UA Server ERR 0x${errCode.toString(16)}${
                reason ? `: ${reason}` : ''
              }`
            )
          );
          continue;
        }

        if (this.pendingResolve) {
          const resolve = this.pendingResolve;
          this.clearPendingHandlers();
          resolve(fullMsg);
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
      this.failPending(new Error('OPC UA TCP socket closed'));
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

  private async teardownSocket(sendCloseChannel: boolean): Promise<void> {
    this.failPending(new Error('OPC UA adapter disconnecting'));
    if (this.socket) {
      if (sendCloseChannel && !this.socket.destroyed && this.secureChannelId !== 0) {
        try {
          const w = new OpcBinaryWriter();
          w.writeFourByteExpandedNodeId(0, 452); // CloseSecureChannelRequest
          w.writeRequestHeader(Buffer.from([0x00, 0x00]), this.requestId);
          const clo = this.wrapSymmetricMessage(w.toBuffer(), 'CLO');
          this.socket.write(clo);
        } catch {
          // Best-effort close frame
        }
      }
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.secureChannelId = 0;
    this.tokenId = 0;
    this.rxAccumulator = Buffer.alloc(0);
  }
}
