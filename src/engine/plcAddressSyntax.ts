import type {
  PlcAdapterType,
  PlcSignalDataType,
  PlcTagBinding,
} from '../shared/schemas';

/**
 * Industrial PLC Address Parsers, Syntax Validators, Auto-Mapping Presets & CSV Codec (Milestone 4)
 *
 * Shared identically between:
 *  - UtilityProcess Wire-Protocol Adapters (Siemens S7, Mitsubishi 3E MC, OPC UA Binary)
 *  - Renderer I/O Tag Binding Matrix UI
 */

// ============================================================================
// 1. SIEMENS S7-1200 / S7-1500 / S7-PLCSIM ADVANCED ADDRESS PARSER
// ============================================================================
export interface ParsedS7Address {
  /** S7Comm Area Code: 0x81=I(PE), 0x82=Q(PA), 0x83=M(MK), 0x84=DB */
  areaCode: 0x81 | 0x82 | 0x83 | 0x84;
  dbNumber: number;
  byteOffset: number;
  bitOffset: number;
  isBit: boolean;
  byteLength: 1 | 2 | 4;
}

const S7_DB_COMMA_RE =
  /^DB(\d+)\s*[,.]\s*(?:DB)?(X|B|BYTE|W|INT|D|DINT|REAL)(\d+)(?:\.([0-7]))?$/i;
const S7_PROCESS_IMG_RE =
  /^([IQEMA])(X|B|W|D)?(\d+)(?:\.([0-7]))?$/i;

export function parseS7Address(
  rawAddress: string,
  expectedType: PlcSignalDataType
): ParsedS7Address | null {
  const trimmed = rawAddress.trim();
  if (!trimmed) return null;

  // Format A: DB1,X0.0 | DB1.DBX0.0 | DB1,INT2 | DB1.DBW2 | DB1,DINT4 | DB1,REAL8 | DB1.DBD8
  const dbMatch = S7_DB_COMMA_RE.exec(trimmed);
  if (dbMatch) {
    const dbNumber = Number(dbMatch[1]);
    if (!Number.isInteger(dbNumber) || dbNumber < 1 || dbNumber > 65535) {
      return null;
    }
    const kind = dbMatch[2].toUpperCase();
    const byteOffset = Number(dbMatch[3]);
    const bitStr = dbMatch[4];

    if (kind === 'X') {
      if (expectedType !== 'BOOL' || bitStr === undefined) return null;
      return {
        areaCode: 0x84,
        dbNumber,
        byteOffset,
        bitOffset: Number(bitStr),
        isBit: true,
        byteLength: 1,
      };
    }

    if (bitStr !== undefined || expectedType === 'BOOL') return null;

    if (kind === 'W' || kind === 'INT') {
      if (expectedType !== 'INT16') return null;
      return {
        areaCode: 0x84,
        dbNumber,
        byteOffset,
        bitOffset: 0,
        isBit: false,
        byteLength: 2,
      };
    }

    if (kind === 'D' || kind === 'DINT' || kind === 'REAL') {
      if (kind === 'DINT' && expectedType !== 'DINT32') return null;
      if (kind === 'REAL' && expectedType !== 'FLOAT32') return null;
      if (expectedType !== 'DINT32' && expectedType !== 'FLOAT32') return null;
      return {
        areaCode: 0x84,
        dbNumber,
        byteOffset,
        bitOffset: 0,
        isBit: false,
        byteLength: 4,
      };
    }

    return null;
  }

  // Format B: Process Image / Bit Memory: I0.0, Q0.1, M2.3, IW100, QW102, ID200, QD400, MD20
  const piMatch = S7_PROCESS_IMG_RE.exec(trimmed);
  if (piMatch) {
    const areaChar = piMatch[1].toUpperCase();
    const areaCode: ParsedS7Address['areaCode'] =
      areaChar === 'I' || areaChar === 'E'
        ? 0x81
        : areaChar === 'Q' || areaChar === 'A'
          ? 0x82
          : 0x83;
    const widthChar = (piMatch[2] ?? '').toUpperCase();
    const byteOffset = Number(piMatch[3]);
    const bitStr = piMatch[4];

    if (expectedType === 'BOOL') {
      if ((widthChar !== '' && widthChar !== 'X') || bitStr === undefined) {
        return null;
      }
      return {
        areaCode,
        dbNumber: 0,
        byteOffset,
        bitOffset: Number(bitStr),
        isBit: true,
        byteLength: 1,
      };
    }

    if (bitStr !== undefined) return null;

    if (expectedType === 'INT16') {
      if (widthChar !== 'W') return null;
      return {
        areaCode,
        dbNumber: 0,
        byteOffset,
        bitOffset: 0,
        isBit: false,
        byteLength: 2,
      };
    }

    if (expectedType === 'DINT32' || expectedType === 'FLOAT32') {
      if (widthChar !== 'D') return null;
      return {
        areaCode,
        dbNumber: 0,
        byteOffset,
        bitOffset: 0,
        isBit: false,
        byteLength: 4,
      };
    }
  }

  return null;
}

// ============================================================================
// 2. MITSUBISHI MELSEC 3E BINARY MC PROTOCOL ADDRESS PARSER (GX Simulator3)
// ============================================================================
export interface ParsedMcAddress {
  deviceSymbol: 'X' | 'Y' | 'M' | 'L' | 'B' | 'D' | 'W' | 'R';
  /** MELSEC 3E Binary Device Code */
  deviceCode: number;
  headDeviceNumber: number;
  isBitDevice: boolean;
  /** Number of 16-bit words (1 for INT16, 2 for DINT32 / FLOAT32) */
  wordCount: 1 | 2;
}

const MC_DEVICE_META: Record<
  ParsedMcAddress['deviceSymbol'],
  { code: number; radix: 10 | 16; isBit: boolean }
> = {
  X: { code: 0x9c, radix: 16, isBit: true },
  Y: { code: 0x9d, radix: 16, isBit: true },
  M: { code: 0x90, radix: 10, isBit: true },
  L: { code: 0x92, radix: 10, isBit: true },
  B: { code: 0xa0, radix: 16, isBit: true },
  D: { code: 0xa8, radix: 10, isBit: false },
  W: { code: 0xb4, radix: 16, isBit: false },
  R: { code: 0xaf, radix: 10, isBit: false },
};

const MC_ADDR_RE = /^([XYMLBDWR])([0-9A-F]+)$/i;

export function parseMcAddress(
  rawAddress: string,
  expectedType: PlcSignalDataType
): ParsedMcAddress | null {
  const trimmed = rawAddress.trim();
  const match = MC_ADDR_RE.exec(trimmed);
  if (!match) return null;

  const sym = match[1].toUpperCase() as ParsedMcAddress['deviceSymbol'];
  const numPart = match[2].toUpperCase();
  const meta = MC_DEVICE_META[sym];
  if (!meta) return null;

  if (meta.radix === 10 && !/^\d+$/.test(numPart)) {
    return null;
  }

  const headDeviceNumber = Number.parseInt(numPart, meta.radix);
  if (
    !Number.isInteger(headDeviceNumber) ||
    headDeviceNumber < 0 ||
    headDeviceNumber > 0xffffff
  ) {
    return null;
  }

  if (expectedType === 'BOOL') {
    if (!meta.isBit) return null;
    return {
      deviceSymbol: sym,
      deviceCode: meta.code,
      headDeviceNumber,
      isBitDevice: true,
      wordCount: 1,
    };
  }

  if (meta.isBit) return null;

  return {
    deviceSymbol: sym,
    deviceCode: meta.code,
    headDeviceNumber,
    isBitDevice: false,
    wordCount: expectedType === 'INT16' ? 1 : 2,
  };
}

// ============================================================================
// 3. OMRON SYSMAC / CODESYS / UNIVERSAL OPC UA NODEID PARSER
// ============================================================================
export interface ParsedOpcUaNodeId {
  namespaceIndex: number;
  identifierType: 'string' | 'numeric';
  identifier: string | number;
  canonical: string;
}

const OPC_EXPLICIT_RE = /^ns=(\d+)\s*;\s*([si])=(.+)$/i;

export function parseOpcUaNodeId(
  rawAddress: string,
  defaultNamespaceIndex = 2
): ParsedOpcUaNodeId | null {
  const trimmed = rawAddress.trim();
  if (!trimmed) return null;

  const m = OPC_EXPLICIT_RE.exec(trimmed);
  if (m) {
    const ns = Number(m[1]);
    if (!Number.isInteger(ns) || ns < 0 || ns > 65535) return null;
    const idKind = m[2].toLowerCase();
    const rawId = m[3].trim();
    if (!rawId) return null;

    if (idKind === 'i') {
      if (!/^\d+$/.test(rawId)) return null;
      const numId = Number(rawId);
      return {
        namespaceIndex: ns,
        identifierType: 'numeric',
        identifier: numId,
        canonical: `ns=${ns};i=${numId}`,
      };
    }

    return {
      namespaceIndex: ns,
      identifierType: 'string',
      identifier: rawId,
      canonical: `ns=${ns};s=${rawId}`,
    };
  }

  // Allow bare IEC-61131-3 symbolic tag names (e.g. "Infeed_Conveyor_01.BeltRun") if they don't look like raw S7/MC addresses with spaces
  if (/^[A-Za-z_][A-Za-z0-9_.:[\]-]*$/.test(trimmed)) {
    return {
      namespaceIndex: defaultNamespaceIndex,
      identifierType: 'string',
      identifier: trimmed,
      canonical: `ns=${defaultNamespaceIndex};s=${trimmed}`,
    };
  }

  return null;
}

// ============================================================================
// 4. UNIFIED SYNTAX VALIDATOR FOR UI TAG MATRIX
// ============================================================================
export function validatePlcAddress(
  adapter: PlcAdapterType,
  address: string,
  dataType: PlcSignalDataType,
  opcNamespaceIndex = 2
): { valid: boolean; hint: string } {
  if (!address || !address.trim()) {
    return { valid: false, hint: 'PLC address cannot be empty.' };
  }

  if (adapter === 'InternalSimAdapter') {
    return {
      valid: true,
      hint: 'InternalSim uses pre-allocated BinaryIpcBufferView slot directly (any symbolic label allowed).',
    };
  }

  if (adapter === 'SiemensS7Adapter') {
    const parsed = parseS7Address(address, dataType);
    if (parsed) {
      return {
        valid: true,
        hint: `Valid Siemens S7 ${dataType} (${
          parsed.areaCode === 0x84 ? `DB${parsed.dbNumber}` : 'Process Image'
        }, byte ${parsed.byteOffset})`,
      };
    }
    const example =
      dataType === 'BOOL'
        ? 'Q0.0, I0.1, M0.0, or DB1,X0.0'
        : dataType === 'INT16'
          ? 'QW100, IW100, or DB1,INT2'
          : dataType === 'DINT32'
            ? 'QD200, ID200, or DB1,DINT4'
            : 'QD400, ID400, or DB1,REAL8';
    return {
      valid: false,
      hint: `Invalid S7 ${dataType} address. Expected e.g. ${example}`,
    };
  }

  if (adapter === 'MitsubishiMcAdapter') {
    const parsed = parseMcAddress(address, dataType);
    if (parsed) {
      return {
        valid: true,
        hint: `Valid MELSEC 3E ${dataType} (${parsed.deviceSymbol}${
          parsed.deviceSymbol === 'X' ||
          parsed.deviceSymbol === 'Y' ||
          parsed.deviceSymbol === 'B' ||
          parsed.deviceSymbol === 'W'
            ? parsed.headDeviceNumber.toString(16).toUpperCase()
            : parsed.headDeviceNumber
        }, ${parsed.isBitDevice ? '1-bit' : `${parsed.wordCount} word(s)`})`,
      };
    }
    const example =
      dataType === 'BOOL'
        ? 'Y0, Y1A, X0, or M100'
        : dataType === 'INT16'
          ? 'D100 or W0'
          : 'D200 (occupies 2 words D200..D201)';
    return {
      valid: false,
      hint: `Invalid Mitsubishi MC ${dataType} address. Expected e.g. ${example}`,
    };
  }

  // OpcUaAdapter
  const parsedOpc = parseOpcUaNodeId(address, opcNamespaceIndex);
  if (parsedOpc) {
    return {
      valid: true,
      hint: `Valid OPC UA NodeId (${parsedOpc.canonical})`,
    };
  }
  return {
    valid: false,
    hint: `Invalid OPC UA NodeId. Expected e.g. ns=${opcNamespaceIndex};s=Conveyor1.Run or ns=${opcNamespaceIndex};i=1001`,
  };
}

// ============================================================================
// 5. 1-CLICK VENDOR AUTO-ADDRESSING PRESETS
// ============================================================================
export type VendorAddressPreset =
  | 's7-process-image'
  | 's7-db1'
  | 'mitsubishi-xy-d'
  | 'opcua-symbolic';

function sanitizeOpcIdentifier(raw: string): string {
  return raw
    .replace(/·/g, '.')
    .replace(/[^A-Za-z0-9_.]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .replace(/\._/g, '.')
    .replace(/_\./g, '.');
}

export function generateVendorAddressesForBindings(
  bindings: PlcTagBinding[],
  preset: VendorAddressPreset,
  opcNamespaceIndex = 2
): PlcTagBinding[] {
  if (preset === 's7-process-image') {
    let qBit = 0;
    let iBit = 0;
    let qwByte = 100;
    let iwByte = 100;
    let qdDintByte = 200;
    let idDintByte = 200;
    let qdRealByte = 400;
    let idRealByte = 400;

    return bindings.map((b) => {
      let addr = b.plcAddress;
      if (b.dataType === 'BOOL') {
        if (b.direction === 'PLC_TO_SIM') {
          addr = `Q${Math.floor(qBit / 8)}.${qBit % 8}`;
          qBit++;
        } else {
          addr = `I${Math.floor(iBit / 8)}.${iBit % 8}`;
          iBit++;
        }
      } else if (b.dataType === 'INT16') {
        if (b.direction === 'PLC_TO_SIM') {
          addr = `QW${qwByte}`;
          qwByte += 2;
        } else {
          addr = `IW${iwByte}`;
          iwByte += 2;
        }
      } else if (b.dataType === 'DINT32') {
        if (b.direction === 'PLC_TO_SIM') {
          addr = `QD${qdDintByte}`;
          qdDintByte += 4;
        } else {
          addr = `ID${idDintByte}`;
          idDintByte += 4;
        }
      } else {
        if (b.direction === 'PLC_TO_SIM') {
          addr = `QD${qdRealByte}`;
          qdRealByte += 4;
        } else {
          addr = `ID${idRealByte}`;
          idRealByte += 4;
        }
      }
      return { ...b, plcAddress: addr };
    });
  }

  if (preset === 's7-db1') {
    let outBit = 0;
    let inBit = 64; // DB1.DBX8.0 onwards for SIM_TO_PLC BOOLs
    let byteCursor = 16;

    return bindings.map((b) => {
      let addr: string;
      if (b.dataType === 'BOOL') {
        const bitIdx = b.direction === 'PLC_TO_SIM' ? outBit++ : inBit++;
        addr = `DB1,X${Math.floor(bitIdx / 8)}.${bitIdx % 8}`;
      } else if (b.dataType === 'INT16') {
        addr = `DB1,INT${byteCursor}`;
        byteCursor += 2;
      } else if (b.dataType === 'DINT32') {
        if (byteCursor % 4 !== 0) byteCursor += 2;
        addr = `DB1,DINT${byteCursor}`;
        byteCursor += 4;
      } else {
        if (byteCursor % 4 !== 0) byteCursor += 2;
        addr = `DB1,REAL${byteCursor}`;
        byteCursor += 4;
      }
      return { ...b, plcAddress: addr };
    });
  }

  if (preset === 'mitsubishi-xy-d') {
    let yIdx = 0;
    let xIdx = 0;
    let dCmdWord = 100;
    let dFbkWord = 400;

    return bindings.map((b) => {
      let addr: string;
      if (b.dataType === 'BOOL') {
        if (b.direction === 'PLC_TO_SIM') {
          addr = `Y${yIdx.toString(16).toUpperCase()}`;
          yIdx++;
        } else {
          addr = `X${xIdx.toString(16).toUpperCase()}`;
          xIdx++;
        }
      } else if (b.dataType === 'INT16') {
        if (b.direction === 'PLC_TO_SIM') {
          addr = `D${dCmdWord}`;
          dCmdWord += 1;
        } else {
          addr = `D${dFbkWord}`;
          dFbkWord += 1;
        }
      } else {
        // DINT32 & FLOAT32 each occupy 2 contiguous 16-bit D-registers (even-aligned)
        if (b.direction === 'PLC_TO_SIM') {
          if (dCmdWord % 2 !== 0) dCmdWord++;
          addr = `D${dCmdWord}`;
          dCmdWord += 2;
        } else {
          if (dFbkWord % 2 !== 0) dFbkWord++;
          addr = `D${dFbkWord}`;
          dFbkWord += 2;
        }
      }
      return { ...b, plcAddress: addr };
    });
  }

  // opcua-symbolic (Omron Sysmac / CODESYS / TwinCAT / S7-1500 OPC UA)
  return bindings.map((b) => {
    const sym = sanitizeOpcIdentifier(b.signalName);
    return {
      ...b,
      plcAddress: `ns=${opcNamespaceIndex};s=${sym}`,
    };
  });
}

// ============================================================================
// 6. CSV TAG TABLE EXPORT / IMPORT CODEC
// ============================================================================
function escapeCsvCell(val: string | number): string {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

export function exportTagBindingsToCsv(bindings: PlcTagBinding[]): string {
  const header =
    'BindingId,InstanceId,SignalName,Direction,DataType,PlcAddress,ScaleFactor,Offset';
  const rows = bindings.map((b) =>
    [
      escapeCsvCell(b.id),
      escapeCsvCell(b.instanceId),
      escapeCsvCell(b.signalName),
      escapeCsvCell(b.direction),
      escapeCsvCell(b.dataType),
      escapeCsvCell(b.plcAddress),
      escapeCsvCell(b.scaleFactor),
      escapeCsvCell(b.offset),
    ].join(',')
  );
  return [header, ...rows].join('\n');
}

export interface CsvBindingPatch {
  plcAddress: string;
  scaleFactor?: number;
  offset?: number;
}

export function parseTagBindingsCsvPatch(
  csvText: string
): Map<string, CsvBindingPatch> {
  const patches = new Map<string, CsvBindingPatch>();
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return patches;

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idIdx = headers.indexOf('bindingid');
  const sigNameIdx = headers.indexOf('signalname');
  const addrIdx = headers.indexOf('plcaddress');
  const scaleIdx = headers.indexOf('scalefactor');
  const offsetIdx = headers.indexOf('offset');

  if (addrIdx < 0) return patches;

  for (let r = 1; r < lines.length; r++) {
    const cols = splitCsvLine(lines[r]);
    const addr = cols[addrIdx]?.trim();
    if (!addr) continue;

    const patch: CsvBindingPatch = { plcAddress: addr };
    if (scaleIdx >= 0 && cols[scaleIdx] !== undefined && cols[scaleIdx] !== '') {
      const sc = Number(cols[scaleIdx]);
      if (Number.isFinite(sc) && sc !== 0) patch.scaleFactor = sc;
    }
    if (
      offsetIdx >= 0 &&
      cols[offsetIdx] !== undefined &&
      cols[offsetIdx] !== ''
    ) {
      const off = Number(cols[offsetIdx]);
      if (Number.isFinite(off)) patch.offset = off;
    }

    if (idIdx >= 0 && cols[idIdx]) {
      patches.set(cols[idIdx], patch);
    }
    if (sigNameIdx >= 0 && cols[sigNameIdx]) {
      patches.set(`NAME::${cols[sigNameIdx]}`, patch);
    }
  }

  return patches;
}
