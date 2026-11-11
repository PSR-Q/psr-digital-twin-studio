import type {
  BinaryIpcBufferView,
  PlcTagBinding,
  PlcTagMap,
} from '../../../src/shared/schemas';

/**
 * Shared Scaling, Offset & Manual Force Override Codec for all UtilityProcess PLC Adapters.
 *
 * Scaling convention:
 *   Engineering Value (in 3D Sim) = Raw PLC Register * scaleFactor + offset
 *   Raw PLC Register (on wire)    = (Engineering Value - offset) / scaleFactor
 */

export function safeScale(scaleFactor: number): number {
  return Number.isFinite(scaleFactor) && Math.abs(scaleFactor) > 1e-9
    ? scaleFactor
    : 1;
}

export function safeOffset(offset: number): number {
  return Number.isFinite(offset) ? offset : 0;
}

/**
 * Reads a `SIM_TO_PLC` tag from `bufferView` (or applies `manualForceValue` if forced)
 * and converts engineering units into the raw PLC wire value.
 */
export function readSimToPlcWireValue(
  bufferView: BinaryIpcBufferView,
  binding: PlcTagBinding
): boolean | number {
  if (binding.dataType === 'BOOL') {
    if (binding.manualForceEnabled) {
      const forced = Boolean(binding.manualForceValue);
      bufferView.writeSimToPlcBool(binding.bufferSlotIndex, forced);
      return forced;
    }
    return bufferView.readSimToPlcBool(binding.bufferSlotIndex);
  }

  let engVal: number;
  if (binding.manualForceEnabled) {
    engVal = Number(binding.manualForceValue ?? 0);
    if (binding.dataType === 'INT16') {
      bufferView.writeInt16(binding.bufferSlotIndex, Math.round(engVal));
    } else if (binding.dataType === 'DINT32') {
      bufferView.writeDint32(binding.bufferSlotIndex, Math.round(engVal));
    } else {
      bufferView.writeFloat32(binding.bufferSlotIndex, engVal);
    }
  } else if (binding.dataType === 'INT16') {
    engVal = bufferView.readInt16(binding.bufferSlotIndex);
  } else if (binding.dataType === 'DINT32') {
    engVal = bufferView.readDint32(binding.bufferSlotIndex);
  } else {
    engVal = bufferView.readFloat32(binding.bufferSlotIndex);
  }

  const raw =
    (engVal - safeOffset(binding.offset)) / safeScale(binding.scaleFactor);
  if (binding.dataType === 'INT16') {
    return Math.max(-32768, Math.min(32767, Math.round(raw)));
  }
  if (binding.dataType === 'DINT32') {
    return Math.round(raw) | 0;
  }
  return raw;
}

/**
 * Writes a raw `PLC_TO_SIM` wire value into `bufferView`, applying `scaleFactor` + `offset`
 * while strictly honoring `manualForceEnabled` overrides from the UI Force Console / Matrix.
 */
export function writePlcToSimFromWire(
  bufferView: BinaryIpcBufferView,
  binding: PlcTagBinding,
  rawPlcValue: boolean | number
): void {
  if (binding.dataType === 'BOOL') {
    bufferView.setForceBool(
      binding.bufferSlotIndex,
      binding.manualForceEnabled,
      Boolean(binding.manualForceValue)
    );
    bufferView.writePlcToSimBool(binding.bufferSlotIndex, Boolean(rawPlcValue));
    return;
  }

  const engVal = binding.manualForceEnabled
    ? Number(binding.manualForceValue ?? 0)
    : Number(rawPlcValue) * safeScale(binding.scaleFactor) +
      safeOffset(binding.offset);

  if (binding.dataType === 'INT16') {
    bufferView.writeInt16(binding.bufferSlotIndex, Math.round(engVal));
  } else if (binding.dataType === 'DINT32') {
    bufferView.writeDint32(binding.bufferSlotIndex, Math.round(engVal) | 0);
  } else {
    bufferView.writeFloat32(binding.bufferSlotIndex, engVal);
  }
}

/**
 * Applies manual forces (and default values when unforced in InternalSim / disconnected states)
 * so manual commissioning overrides work even while a network PLC is offline.
 */
export function applyBindingsLocalScan(
  bufferView: BinaryIpcBufferView,
  tagMap: PlcTagMap,
  writeUnforcedDefaults: boolean
): void {
  for (let i = 0; i < tagMap.bindings.length; i++) {
    const binding = tagMap.bindings[i];

    if (binding.direction === 'SIM_TO_PLC') {
      if (binding.manualForceEnabled) {
        readSimToPlcWireValue(bufferView, binding);
      }
      continue;
    }

    if (binding.dataType === 'BOOL') {
      bufferView.setForceBool(
        binding.bufferSlotIndex,
        binding.manualForceEnabled,
        Boolean(binding.manualForceValue)
      );
      if (writeUnforcedDefaults && !binding.manualForceEnabled) {
        bufferView.writePlcToSimBool(
          binding.bufferSlotIndex,
          Boolean(binding.manualForceValue)
        );
      }
    } else if (binding.manualForceEnabled || writeUnforcedDefaults) {
      const numericVal = Number(binding.manualForceValue ?? 0);
      if (binding.dataType === 'INT16') {
        bufferView.writeInt16(binding.bufferSlotIndex, numericVal);
      } else if (binding.dataType === 'DINT32') {
        bufferView.writeDint32(binding.bufferSlotIndex, numericVal);
      } else if (binding.dataType === 'FLOAT32') {
        bufferView.writeFloat32(binding.bufferSlotIndex, numericVal);
      }
    }
  }
}
