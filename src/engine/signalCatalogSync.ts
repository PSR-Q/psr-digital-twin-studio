import type {
  ComponentDefinition,
  ComponentSignalDescriptor,
  PlcSignalDataType,
  PlcSignalDirection,
  PlcTagBinding,
  PlcTagMap,
  SceneNodeInstance,
  SubMeshRoleAssignment,
} from '../shared/schemas';

/**
 * Automatic Industrial I/O Signal Synthesizer & Binary Buffer Slot Allocator (Milestone 2)
 *
 * Synthesizes PLC_TO_SIM command signals and SIM_TO_PLC feedback signals (Reed Switches,
 * Servo Actual Position, Speed RPM) directly from Component Builder sub-mesh roles,
 * and maps every placed 3D machine instance into collision-free BinaryIpcBufferView slots.
 */

export function makeNodeSignalKey(nodeName: string, suffix: string): string {
  return `${nodeName}::${suffix}`;
}

export function formatReadableNodeLabel(nodeName: string): string {
  return nodeName
    .replace(/_Axis$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

export function synthesizeComponentSignals(
  nodeRoles: Record<string, SubMeshRoleAssignment>
): ComponentSignalDescriptor[] {
  const signals: ComponentSignalDescriptor[] = [];

  for (const assignment of Object.values(nodeRoles)) {
    const { nodeName } = assignment;
    const readable = formatReadableNodeLabel(nodeName);

    if (assignment.role === 'LinearAxis') {
      if (assignment.behavior?.presetType === 'ServoPositioning') {
        signals.push(
          {
            key: makeNodeSignalKey(nodeName, 'AO_TargetPosMm'),
            label: `${readable} · Target Pos`,
            direction: 'PLC_TO_SIM',
            dataType: 'FLOAT32',
            nodeName,
            unit: 'mm',
            minVal: assignment.minLimitMm,
            maxVal: assignment.maxLimitMm,
            defaultVal: assignment.initialPosMm,
          },
          {
            key: makeNodeSignalKey(nodeName, 'AI_ActualPosMm'),
            label: `${readable} · Actual Pos`,
            direction: 'SIM_TO_PLC',
            dataType: 'FLOAT32',
            nodeName,
            unit: 'mm',
            minVal: assignment.minLimitMm,
            maxVal: assignment.maxLimitMm,
            defaultVal: assignment.initialPosMm,
          },
          {
            key: makeNodeSignalKey(nodeName, 'DI_InPosition'),
            label: `${readable} · In Position`,
            direction: 'SIM_TO_PLC',
            dataType: 'BOOL',
            nodeName,
          }
        );
      } else {
        const actingMode =
          assignment.behavior?.presetType === 'PneumaticCylinder'
            ? assignment.behavior.actingMode
            : 'single-acting';
        const emitReed =
          assignment.behavior?.presetType === 'PneumaticCylinder'
            ? assignment.behavior.emitReedSwitches
            : true;

        signals.push({
          key: makeNodeSignalKey(nodeName, 'DO_Extend'),
          label: `${readable} · Solenoid Extend`,
          direction: 'PLC_TO_SIM',
          dataType: 'BOOL',
          nodeName,
        });

        if (actingMode === 'double-acting') {
          signals.push({
            key: makeNodeSignalKey(nodeName, 'DO_Retract'),
            label: `${readable} · Solenoid Retract`,
            direction: 'PLC_TO_SIM',
            dataType: 'BOOL',
            nodeName,
          });
        }

        if (emitReed) {
          signals.push(
            {
              key: makeNodeSignalKey(nodeName, 'DI_ReedRetracted'),
              label: `${readable} · Reed Retracted`,
              direction: 'SIM_TO_PLC',
              dataType: 'BOOL',
              nodeName,
            },
            {
              key: makeNodeSignalKey(nodeName, 'DI_ReedExtended'),
              label: `${readable} · Reed Extended`,
              direction: 'SIM_TO_PLC',
              dataType: 'BOOL',
              nodeName,
            }
          );
        }

        signals.push({
          key: makeNodeSignalKey(nodeName, 'AI_StrokeMm'),
          label: `${readable} · Stroke`,
          direction: 'SIM_TO_PLC',
          dataType: 'FLOAT32',
          nodeName,
          unit: 'mm',
          minVal: assignment.minLimitMm,
          maxVal: assignment.maxLimitMm,
          defaultVal: assignment.initialPosMm,
        });
      }
    } else if (assignment.role === 'RotaryAxis') {
      if (assignment.mode === 'continuous') {
        const allowReverse =
          assignment.behavior?.presetType === 'ConveyorDrive'
            ? assignment.behavior.allowReverse
            : true;
        const nominalRpm = Math.max(1, assignment.defaultRpm || 60);

        signals.push({
          key: makeNodeSignalKey(nodeName, 'DO_RunForward'),
          label: `${readable} · Run Forward`,
          direction: 'PLC_TO_SIM',
          dataType: 'BOOL',
          nodeName,
        });

        if (allowReverse) {
          signals.push({
            key: makeNodeSignalKey(nodeName, 'DO_RunReverse'),
            label: `${readable} · Run Reverse`,
            direction: 'PLC_TO_SIM',
            dataType: 'BOOL',
            nodeName,
          });
        }

        signals.push(
          {
            key: makeNodeSignalKey(nodeName, 'AO_SpeedRpm'),
            label: `${readable} · Speed Setpoint`,
            direction: 'PLC_TO_SIM',
            dataType: 'FLOAT32',
            nodeName,
            unit: 'RPM',
            minVal: 0,
            maxVal: Math.max(300, Math.round(nominalRpm * 2.5)),
            defaultVal: nominalRpm,
          },
          {
            key: makeNodeSignalKey(nodeName, 'AI_ActualRpm'),
            label: `${readable} · Actual Speed`,
            direction: 'SIM_TO_PLC',
            dataType: 'FLOAT32',
            nodeName,
            unit: 'RPM',
            defaultVal: 0,
          }
        );
      } else {
        const homeAngle =
          0 >= assignment.minDeg && 0 <= assignment.maxDeg ? 0 : assignment.minDeg;
        signals.push(
          {
            key: makeNodeSignalKey(nodeName, 'DO_IndexMax'),
            label: `${readable} · Index (${assignment.maxDeg}°)`,
            direction: 'PLC_TO_SIM',
            dataType: 'BOOL',
            nodeName,
          },
          {
            key: makeNodeSignalKey(nodeName, 'AO_TargetAngleDeg'),
            label: `${readable} · Target Angle`,
            direction: 'PLC_TO_SIM',
            dataType: 'FLOAT32',
            nodeName,
            unit: '°',
            minVal: assignment.minDeg,
            maxVal: assignment.maxDeg,
            defaultVal: homeAngle,
          },
          {
            key: makeNodeSignalKey(nodeName, 'AI_ActualAngleDeg'),
            label: `${readable} · Actual Angle`,
            direction: 'SIM_TO_PLC',
            dataType: 'FLOAT32',
            nodeName,
            unit: '°',
            minVal: assignment.minDeg,
            maxVal: assignment.maxDeg,
            defaultVal: homeAngle,
          },
          {
            key: makeNodeSignalKey(nodeName, 'DI_InPosition'),
            label: `${readable} · In Position`,
            direction: 'SIM_TO_PLC',
            dataType: 'BOOL',
            nodeName,
          }
        );
      }
    } else if (assignment.role === 'VisualEffect') {
      if (assignment.effectType === 'uv-scroll') {
        signals.push(
          {
            key: makeNodeSignalKey(nodeName, 'DO_BeltRun'),
            label: `${readable} · Belt Drive Run`,
            direction: 'PLC_TO_SIM',
            dataType: 'BOOL',
            nodeName,
          },
          {
            key: makeNodeSignalKey(nodeName, 'AO_SpeedPct'),
            label: `${readable} · Belt Speed`,
            direction: 'PLC_TO_SIM',
            dataType: 'FLOAT32',
            nodeName,
            unit: '%',
            minVal: 0,
            maxVal: 200,
            defaultVal: 100,
          }
        );
      } else if (assignment.effectType === 'emissive-lamp') {
        signals.push({
          key: makeNodeSignalKey(nodeName, 'DO_LampOn'),
          label: `${readable} · Indicator Lamp`,
          direction: 'PLC_TO_SIM',
          dataType: 'BOOL',
          nodeName,
        });
      } else if (assignment.effectType === 'tank-level') {
        signals.push({
          key: makeNodeSignalKey(nodeName, 'AO_LevelPct'),
          label: `${readable} · Tank Level`,
          direction: 'PLC_TO_SIM',
          dataType: 'FLOAT32',
          nodeName,
          unit: '%',
          minVal: 0,
          maxVal: 100,
          defaultVal: 50,
        });
      }
    }
  }

  return signals;
}

interface PartitionRange {
  min: number;
  max: number;
}

function getSlotPartition(
  direction: PlcSignalDirection,
  dataType: PlcSignalDataType
): PartitionRange {
  if (dataType === 'BOOL') {
    return { min: 0, max: 1023 };
  }
  if (dataType === 'INT16') {
    return direction === 'PLC_TO_SIM'
      ? { min: 0, max: 127 }
      : { min: 128, max: 255 };
  }
  if (dataType === 'DINT32') {
    return direction === 'PLC_TO_SIM'
      ? { min: 0, max: 127 }
      : { min: 128, max: 255 };
  }
  // FLOAT32: lower half [0..247] PLC_TO_SIM, upper half [248..495] SIM_TO_PLC
  return direction === 'PLC_TO_SIM'
    ? { min: 0, max: 247 }
    : { min: 248, max: 495 };
}

function formatDefaultPlcAddress(
  direction: PlcSignalDirection,
  dataType: PlcSignalDataType,
  slot: number
): string {
  if (dataType === 'BOOL') {
    const prefix = direction === 'PLC_TO_SIM' ? 'Q' : 'I';
    return `${prefix}${Math.floor(slot / 8)}.${slot % 8}`;
  }
  if (dataType === 'INT16') {
    const localIdx = direction === 'PLC_TO_SIM' ? slot : slot - 128;
    const prefix = direction === 'PLC_TO_SIM' ? 'QW' : 'IW';
    return `${prefix}${100 + localIdx * 2}`;
  }
  if (dataType === 'DINT32') {
    const localIdx = direction === 'PLC_TO_SIM' ? slot : slot - 128;
    const prefix = direction === 'PLC_TO_SIM' ? 'QD' : 'ID';
    return `${prefix}${200 + localIdx * 4}`;
  }
  const localIdx = direction === 'PLC_TO_SIM' ? slot : slot - 248;
  const prefix = direction === 'PLC_TO_SIM' ? 'QD' : 'ID';
  return `${prefix}${400 + localIdx * 4}`;
}

function partitionBucketKey(
  direction: PlcSignalDirection,
  dataType: PlcSignalDataType
): string {
  return dataType === 'BOOL' ? `BOOL:${direction}` : `NUM:${dataType}:${direction}`;
}

/**
 * Synchronizes `PlcTagMap.bindings` with all placed 3D scene instances and their
 * ComponentDefinition `exposedSignals`, preserving existing forces and custom PLC addresses.
 */
export function syncPlcTagMapWithScene(
  instances: SceneNodeInstance[],
  componentLibrary: ComponentDefinition[],
  prevTagMap: PlcTagMap
): PlcTagMap {
  const compMap = new Map(componentLibrary.map((c) => [c.id, c]));
  const existingByCompositeKey = new Map<string, PlcTagBinding>();
  for (const b of prevTagMap.bindings) {
    existingByCompositeKey.set(`${b.instanceId}::${b.componentSignalKey}`, b);
  }

  const usedSlotsByBucket = new Map<string, Set<number>>();
  const getUsedSet = (bucket: string): Set<number> => {
    let set = usedSlotsByBucket.get(bucket);
    if (!set) {
      set = new Set<number>();
      usedSlotsByBucket.set(bucket, set);
    }
    return set;
  };

  const nextBindings: PlcTagBinding[] = [];

  // Pass 1: Reserve valid pre-existing slots so forced signals never jump addresses
  for (const inst of instances) {
    const comp = compMap.get(inst.componentId);
    if (!comp) continue;

    for (const sig of comp.exposedSignals) {
      const prev = existingByCompositeKey.get(`${inst.id}::${sig.key}`);
      if (!prev) continue;
      if (prev.direction !== sig.direction || prev.dataType !== sig.dataType) continue;

      const range = getSlotPartition(sig.direction, sig.dataType);
      const bucket = partitionBucketKey(sig.direction, sig.dataType);
      const used = getUsedSet(bucket);

      if (
        prev.bufferSlotIndex >= range.min &&
        prev.bufferSlotIndex <= range.max &&
        !used.has(prev.bufferSlotIndex)
      ) {
        used.add(prev.bufferSlotIndex);
      }
    }
  }

  // Pass 2: Build complete deterministic binding table
  for (const inst of instances) {
    const comp = compMap.get(inst.componentId);
    if (!comp) continue;

    for (const sig of comp.exposedSignals) {
      const compositeKey = `${inst.id}::${sig.key}`;
      const prev = existingByCompositeKey.get(compositeKey);
      const range = getSlotPartition(sig.direction, sig.dataType);
      const bucket = partitionBucketKey(sig.direction, sig.dataType);
      const used = getUsedSet(bucket);

      let slot = range.min;
      if (
        prev &&
        prev.direction === sig.direction &&
        prev.dataType === sig.dataType &&
        prev.bufferSlotIndex >= range.min &&
        prev.bufferSlotIndex <= range.max &&
        used.has(prev.bufferSlotIndex)
      ) {
        slot = prev.bufferSlotIndex;
      } else {
        while (slot <= range.max && used.has(slot)) {
          slot++;
        }
        used.add(slot);
      }

      const defaultForceVal: boolean | number =
        sig.dataType === 'BOOL' ? false : (sig.defaultVal ?? 0);

      nextBindings.push({
        id: prev?.id ?? `tag-${inst.id}-${sig.key}`,
        signalName: `${inst.name} · ${sig.label}`,
        instanceId: inst.id,
        componentSignalKey: sig.key,
        direction: sig.direction,
        dataType: sig.dataType,
        plcAddress:
          prev?.plcAddress || formatDefaultPlcAddress(sig.direction, sig.dataType, slot),
        bufferSlotIndex: slot,
        scaleFactor: prev?.scaleFactor ?? 1,
        offset: prev?.offset ?? 0,
        manualForceEnabled: prev?.manualForceEnabled ?? false,
        manualForceValue:
          prev !== undefined && prev.dataType === sig.dataType
            ? prev.manualForceValue
            : defaultForceVal,
      });
    }
  }

  return {
    ...prevTagMap,
    bindings: nextBindings,
  };
}
