import * as THREE from 'three';
import type {
  BinaryIpcBufferView,
  ComponentDefinition,
  LinearAxisRole,
  PlcTagBinding,
  RotaryAxisRole,
  SimulationRunState,
  SubMeshRoleAssignment,
  UUID,
  Vector3Tuple,
  VisualEffectRole,
} from '../shared/schemas';
import { makeNodeSignalKey } from './signalCatalogSync';

/**
 * Zero-Overhead Forward Kinematics (FK) & Industrial Actuator Engine (Milestone 2)
 *
 * Executes at 60–144Hz directly inside R3F `useFrame` with:
 * - Zero React state updates and zero per-frame heap allocations
 * - Component-Space matrix math supporting glTF (.glb/.gltf) AND Z-up / scaled OpenUSD (.usd/.usda/.usdc/.usdz)
 * - Pneumatic single/double-acting cylinders + automatic virtual Reed Switch limits
 * - Trapezoidal velocity/braking Servo positioning + InPosition feedback
 * - Continuous RPM rotary drives (with inertia ramp) & bounded indexing rotary tables
 * - Procedural chevron UV-scroll conveyor belts, emissive status lamps, and tank levels
 * - Kinematic `parentNodeName` chaining across flat CAD sub-meshes
 */

export interface JogPreviewState {
  instanceId: UUID;
  nodeName: string;
  value: number;
}

export interface SubMeshBoundsSnapshot {
  min: Vector3Tuple;
  max: Vector3Tuple;
  size: Vector3Tuple;
  center: Vector3Tuple;
}

interface RestTransformRecord {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

interface NodeGraphRecord {
  name: string;
  obj: THREE.Object3D;
  parentRecord: NodeGraphRecord | null;
  restCompMatrix: THREE.Matrix4;
  invRestCompMatrix: THREE.Matrix4;
  restParentCompMatrix: THREE.Matrix4;
  currentCompMatrix: THREE.Matrix4;
  deltaTotalComp: THREE.Matrix4;
  hasMotion: boolean;
  restBoundsComp: SubMeshBoundsSnapshot;
}

interface LinearAxisRuntime {
  kind: 'LinearAxis';
  nodeRecord: NodeGraphRecord;
  role: LinearAxisRole;
  unitAxisComp: THREE.Vector3;
  posMm: number;
  velMmPerSec: number;
  // Pre-bound BinaryIpcBufferView slot indices (-1 = unbound)
  doExtendSlot: number;
  doRetractSlot: number;
  diReedRetractedSlot: number;
  diReedExtendedSlot: number;
  aiStrokeMmSlot: number;
  aoTargetPosMmSlot: number;
  aiActualPosMmSlot: number;
  diInPositionSlot: number;
  isReedExtended: boolean;
}

interface RotaryAxisRuntime {
  kind: 'RotaryAxis';
  nodeRecord: NodeGraphRecord;
  role: RotaryAxisRole;
  unitAxisComp: THREE.Vector3;
  pivotComp: THREE.Vector3;
  angleDeg: number;
  velDegPerSec: number;
  actualRpm: number;
  doRunForwardSlot: number;
  doRunReverseSlot: number;
  aoSpeedRpmSlot: number;
  aiActualRpmSlot: number;
  doIndexMaxSlot: number;
  aoTargetAngleDegSlot: number;
  aiActualAngleDegSlot: number;
  diInPositionSlot: number;
}

interface VisualEffectRuntime {
  kind: 'VisualEffect';
  nodeRecord: NodeGraphRecord;
  role: VisualEffectRole;
  materials: THREE.MeshStandardMaterial[];
  scrollTextures: THREE.Texture[];
  emissiveOnColor: THREE.Color;
  emissiveOffColor: THREE.Color;
  autoLinkReedLamp: boolean;
  currentLevelPct: number;
  actualBeltRpm: number;
  doBeltRunSlot: number;
  aoBeltSpeedRpmSlot: number;
  aiActualBeltRpmSlot: number;
  doLampOnSlot: number;
  aoLevelPctSlot: number;
}

type ActiveRoleRuntime = LinearAxisRuntime | RotaryAxisRuntime | VisualEffectRuntime;

export interface KinematicsInstanceRig {
  instanceId: UUID;
  componentId: UUID;
  rootObject: THREE.Group;
  nodeRecords: Map<string, NodeGraphRecord>;
  orderedNodeRecords: NodeGraphRecord[];
  activeRuntimes: ActiveRoleRuntime[];
}

const DEG2RAD = Math.PI / 180;
const REST_USERDATA_KEY = '__vcRestTransform';

// Module-level pre-allocated math scratch objects for zero GC pressure in useFrame
const _matIdentity = new THREE.Matrix4();
const _vecDisp = new THREE.Vector3();
const _quatRot = new THREE.Quaternion();
const _matDeltaSelf = new THREE.Matrix4();
const _matPivotPos = new THREE.Matrix4();
const _matPivotNeg = new THREE.Matrix4();
const _matRot = new THREE.Matrix4();
const _matScale = new THREE.Matrix4();
const _matInvParent = new THREE.Matrix4();
const _matNextLocal = new THREE.Matrix4();
const _cornerScratch = new THREE.Vector3();

let cachedProceduralBeltCanvas: HTMLCanvasElement | null = null;

function getProceduralBeltCanvas(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  if (cachedProceduralBeltCanvas) return cachedProceduralBeltCanvas;

  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // Base industrial dark elastomer belt tone
    ctx.fillStyle = '#1b222c';
    ctx.fillRect(0, 0, 128, 128);

    // Subtle longitudinal edge wear tracks
    ctx.fillStyle = '#151b24';
    ctx.fillRect(0, 0, 128, 10);
    ctx.fillRect(0, 118, 128, 10);

    // High-contrast industrial cleat / chevron ribs so belt motion is unmistakable
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';

    for (const xBase of [24, 88]) {
      ctx.beginPath();
      ctx.moveTo(xBase - 14, 16);
      ctx.lineTo(xBase + 12, 64);
      ctx.lineTo(xBase - 14, 112);
      ctx.stroke();
    }

    // Subtle vulcanized seam line
    ctx.strokeStyle = '#283445';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(64, 8);
    ctx.lineTo(64, 120);
    ctx.stroke();
  }

  cachedProceduralBeltCanvas = canvas;
  return canvas;
}

function createBeltInstanceTexture(repeatX: number): THREE.CanvasTexture | null {
  const canvas = getProceduralBeltCanvas();
  if (!canvas) return null;
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(Math.max(1.5, repeatX), 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Ensures materials are cloned per instance and rest transforms are snapshotted once
 * before any FK deformation runs on `rootObject`.
 */
export function ensureInstanceRestStateAndUniqueMaterials(rootObject: THREE.Group): void {
  rootObject.traverse((obj) => {
    if (!obj.userData[REST_USERDATA_KEY]) {
      const rec: RestTransformRecord = {
        position: obj.position.clone(),
        quaternion: obj.quaternion.clone(),
        scale: obj.scale.clone(),
      };
      obj.userData[REST_USERDATA_KEY] = rec;
    } else {
      const rec = obj.userData[REST_USERDATA_KEY] as RestTransformRecord;
      obj.position.copy(rec.position);
      obj.quaternion.copy(rec.quaternion);
      obj.scale.copy(rec.scale);
    }

    if ((obj as THREE.Mesh).isMesh && !obj.userData.__vcMaterialsCloned) {
      const mesh = obj as THREE.Mesh;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((m) => m.clone());
      } else if (mesh.material) {
        mesh.material = mesh.material.clone();
      }
      obj.userData.__vcMaterialsCloned = true;
    }
  });
}

function normalizeAxisTuple(axis: Vector3Tuple): THREE.Vector3 {
  const v = new THREE.Vector3(axis[0], axis[1], axis[2]);
  if (v.lengthSq() < 1e-8) {
    return new THREE.Vector3(0, 1, 0);
  }
  return v.normalize();
}

function computeSubtreeBoundsInCompSpace(
  targetObj: THREE.Object3D,
  compMatrixMap: Map<THREE.Object3D, THREE.Matrix4>
): SubMeshBoundsSnapshot {
  const box = new THREE.Box3();

  targetObj.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const geom = mesh.geometry;
    if (!geom) return;
    if (!geom.boundingBox) {
      geom.computeBoundingBox();
    }
    const gBox = geom.boundingBox;
    if (!gBox || gBox.isEmpty()) return;

    const compMat = compMatrixMap.get(mesh);
    if (!compMat) return;

    for (let ix = 0; ix < 2; ix++) {
      for (let iy = 0; iy < 2; iy++) {
        for (let iz = 0; iz < 2; iz++) {
          _cornerScratch.set(
            ix === 0 ? gBox.min.x : gBox.max.x,
            iy === 0 ? gBox.min.y : gBox.max.y,
            iz === 0 ? gBox.min.z : gBox.max.z
          );
          _cornerScratch.applyMatrix4(compMat);
          box.expandByPoint(_cornerScratch);
        }
      }
    }
  });

  if (box.isEmpty()) {
    const fallbackMat = compMatrixMap.get(targetObj);
    _cornerScratch.set(0, 0, 0);
    if (fallbackMat) _cornerScratch.applyMatrix4(fallbackMat);
    box.min.copy(_cornerScratch).addScalar(-0.08);
    box.max.copy(_cornerScratch).addScalar(0.08);
  }

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  return {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
    size: [size.x, size.y, size.z],
    center: [center.x, center.y, center.z],
  };
}

function collectStandardMaterials(targetObj: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const result: THREE.MeshStandardMaterial[] = [];
  targetObj.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (m && 'emissive' in m) {
        result.push(m as THREE.MeshStandardMaterial);
      }
    }
  });
  return result;
}

/**
 * Builds a complete Component-Space kinematics rig for a cloned 3D instance.
 */
export function buildKinematicsRig(
  instanceId: UUID,
  rootObject: THREE.Group,
  component: ComponentDefinition,
  instanceBindings: PlcTagBinding[]
): KinematicsInstanceRig {
  ensureInstanceRestStateAndUniqueMaterials(rootObject);

  // Compute exact Component-Space matrices top-down (independent of world transform)
  const compMatrixMap = new Map<THREE.Object3D, THREE.Matrix4>();
  const traverseTopDown = (obj: THREE.Object3D, parentComp: THREE.Matrix4 | null) => {
    obj.updateMatrix();
    const compMat = parentComp
      ? new THREE.Matrix4().multiplyMatrices(parentComp, obj.matrix)
      : obj.matrix.clone();
    compMatrixMap.set(obj, compMat);
    for (const child of obj.children) {
      traverseTopDown(child, compMat);
    }
  };
  traverseTopDown(rootObject, null);

  // Register named nodes (preferring Mesh nodes when Group & Mesh share a name, or outermost Xform if needed)
  const objToRecord = new Map<THREE.Object3D, NodeGraphRecord>();
  const nodeRecords = new Map<string, NodeGraphRecord>();
  const orderedNodeRecords: NodeGraphRecord[] = [];

  const registerRecordsTopDown = (obj: THREE.Object3D) => {
    const compMat = compMatrixMap.get(obj) ?? new THREE.Matrix4();
    const parentObj = obj.parent;
    const parentCompMat =
      parentObj && compMatrixMap.has(parentObj)
        ? compMatrixMap.get(parentObj)!
        : new THREE.Matrix4();

    // Find nearest registered ancestor record
    let ancObj = obj.parent;
    let parentRecord: NodeGraphRecord | null = null;
    while (ancObj) {
      const found = objToRecord.get(ancObj);
      if (found) {
        parentRecord = found;
        break;
      }
      ancObj = ancObj.parent;
    }

    if (obj !== rootObject && obj.name) {
      const record: NodeGraphRecord = {
        name: obj.name,
        obj,
        parentRecord,
        restCompMatrix: compMat.clone(),
        invRestCompMatrix: compMat.clone().invert(),
        restParentCompMatrix: parentCompMat.clone(),
        currentCompMatrix: compMat.clone(),
        deltaTotalComp: new THREE.Matrix4(),
        hasMotion: false,
        restBoundsComp: computeSubtreeBoundsInCompSpace(obj, compMatrixMap),
      };
      objToRecord.set(obj, record);
      orderedNodeRecords.push(record);
      if (!nodeRecords.has(obj.name) || (obj as THREE.Mesh).isMesh) {
        nodeRecords.set(obj.name, record);
      }
    }

    for (const child of obj.children) {
      registerRecordsTopDown(child);
    }
  };
  registerRecordsTopDown(rootObject);

  // Build fast slot lookup by componentSignalKey
  const slotByKey = new Map<string, number>();
  for (const b of instanceBindings) {
    slotByKey.set(b.componentSignalKey, b.bufferSlotIndex);
  }
  const slotOf = (nodeName: string, suffix: string): number =>
    slotByKey.get(makeNodeSignalKey(nodeName, suffix)) ?? -1;

  // Topologically sort role assignments so `parentNodeName` parents run before children
  const rawAssignments = Object.values(component.nodeRoles).filter(
    (r) => r.role !== 'StaticMesh'
  );
  const sortedAssignments: SubMeshRoleAssignment[] = [];
  const visited = new Set<string>();
  const byName = new Map(rawAssignments.map((a) => [a.nodeName, a]));

  const visitRole = (a: SubMeshRoleAssignment) => {
    if (visited.has(a.nodeName)) return;
    visited.add(a.nodeName);
    if (
      (a.role === 'LinearAxis' || a.role === 'RotaryAxis') &&
      a.parentNodeName &&
      byName.has(a.parentNodeName)
    ) {
      visitRole(byName.get(a.parentNodeName)!);
    }
    sortedAssignments.push(a);
  };
  for (const a of rawAssignments) {
    visitRole(a);
  }

  const activeRuntimes: ActiveRoleRuntime[] = [];

  for (const assignment of sortedAssignments) {
    const nodeRecord = nodeRecords.get(assignment.nodeName);
    if (!nodeRecord) continue;

    if (assignment.role === 'LinearAxis') {
      activeRuntimes.push({
        kind: 'LinearAxis',
        nodeRecord,
        role: assignment,
        unitAxisComp: normalizeAxisTuple(assignment.axis),
        posMm: assignment.initialPosMm,
        velMmPerSec: 0,
        doExtendSlot: slotOf(assignment.nodeName, 'DO_Extend'),
        doRetractSlot: slotOf(assignment.nodeName, 'DO_Retract'),
        diReedRetractedSlot: slotOf(assignment.nodeName, 'DI_ReedRetracted'),
        diReedExtendedSlot: slotOf(assignment.nodeName, 'DI_ReedExtended'),
        aiStrokeMmSlot: slotOf(assignment.nodeName, 'AI_StrokeMm'),
        aoTargetPosMmSlot: slotOf(assignment.nodeName, 'AO_TargetPosMm'),
        aiActualPosMmSlot: slotOf(assignment.nodeName, 'AI_ActualPosMm'),
        diInPositionSlot: slotOf(assignment.nodeName, 'DI_InPosition'),
        isReedExtended: false,
      });
    } else if (assignment.role === 'RotaryAxis') {
      const [cx, cy, cz] = nodeRecord.restBoundsComp.center;
      const [ox, oy, oz] = assignment.pivotOffset ?? [0, 0, 0];
      const homeDeg =
        assignment.mode === 'bounded'
          ? 0 >= assignment.minDeg && 0 <= assignment.maxDeg
            ? 0
            : assignment.minDeg
          : 0;

      activeRuntimes.push({
        kind: 'RotaryAxis',
        nodeRecord,
        role: assignment,
        unitAxisComp: normalizeAxisTuple(assignment.axis),
        pivotComp: new THREE.Vector3(cx + ox, cy + oy, cz + oz),
        angleDeg: homeDeg,
        velDegPerSec: 0,
        actualRpm: 0,
        doRunForwardSlot: slotOf(assignment.nodeName, 'DO_RunForward'),
        doRunReverseSlot: slotOf(assignment.nodeName, 'DO_RunReverse'),
        aoSpeedRpmSlot: slotOf(assignment.nodeName, 'AO_SpeedRpm'),
        aiActualRpmSlot: slotOf(assignment.nodeName, 'AI_ActualRpm'),
        doIndexMaxSlot: slotOf(assignment.nodeName, 'DO_IndexMax'),
        aoTargetAngleDegSlot: slotOf(assignment.nodeName, 'AO_TargetAngleDeg'),
        aiActualAngleDegSlot: slotOf(assignment.nodeName, 'AI_ActualAngleDeg'),
        diInPositionSlot: slotOf(assignment.nodeName, 'DI_InPosition'),
      });
    } else if (assignment.role === 'VisualEffect') {
      const materials = collectStandardMaterials(nodeRecord.obj);
      const scrollTextures: THREE.Texture[] = [];

      if (assignment.effectType === 'uv-scroll') {
        const beltLengthM = Math.max(
          nodeRecord.restBoundsComp.size[0],
          nodeRecord.restBoundsComp.size[2],
          0.5
        );
        for (const mat of materials) {
          if (!mat.map) {
            const generatedTex = createBeltInstanceTexture(beltLengthM * 2.8);
            if (generatedTex) {
              mat.map = generatedTex;
              // Slightly lighten base color so chevron texture contrast reads crisply
              mat.color.setRGB(
                Math.max(0.55, mat.color.r),
                Math.max(0.58, mat.color.g),
                Math.max(0.64, mat.color.b)
              );
              mat.needsUpdate = true;
            }
          } else {
            mat.map = mat.map.clone();
            mat.map.wrapS = THREE.RepeatWrapping;
            mat.map.wrapT = THREE.RepeatWrapping;
            mat.map.needsUpdate = true;
          }
          if (mat.map) {
            scrollTextures.push(mat.map);
          }
        }
      }

      const rpmCmdSlot = slotOf(assignment.nodeName, 'AO_BeltSpeedRpm');
      activeRuntimes.push({
        kind: 'VisualEffect',
        nodeRecord,
        role: assignment,
        materials,
        scrollTextures,
        emissiveOnColor: new THREE.Color(assignment.emissiveOnHex || '#10b981'),
        emissiveOffColor: new THREE.Color(assignment.emissiveOffHex || '#1e293b'),
        autoLinkReedLamp: /reed/i.test(assignment.nodeName),
        currentLevelPct: 50,
        actualBeltRpm: 0,
        doBeltRunSlot: slotOf(assignment.nodeName, 'DO_BeltRun'),
        aoBeltSpeedRpmSlot:
          rpmCmdSlot >= 0 ? rpmCmdSlot : slotOf(assignment.nodeName, 'AO_SpeedPct'),
        aiActualBeltRpmSlot: slotOf(assignment.nodeName, 'AI_ActualBeltRpm'),
        doLampOnSlot: slotOf(assignment.nodeName, 'DO_LampOn'),
        aoLevelPctSlot: slotOf(assignment.nodeName, 'AO_LevelPct'),
      });
    }
  }

  return {
    instanceId,
    componentId: component.id,
    rootObject,
    nodeRecords,
    orderedNodeRecords,
    activeRuntimes,
  };
}

function stepTrapezoidalServo(
  currentPos: number,
  currentVel: number,
  targetPos: number,
  maxVel: number,
  accel: number,
  decel: number,
  dt: number
): { pos: number; vel: number } {
  const error = targetPos - currentPos;
  const dist = Math.abs(error);

  if (dist < 0.04 && Math.abs(currentVel) < 1.5) {
    return { pos: targetPos, vel: 0 };
  }

  const dir = error >= 0 ? 1 : -1;
  const safeDecel = Math.max(10, decel);
  const safeAccel = Math.max(10, accel);
  const safeMaxVel = Math.max(5, maxVel);

  const brakingSpeed = Math.sqrt(2 * safeDecel * dist);
  const desiredVel = dir * Math.min(safeMaxVel, brakingSpeed);

  const velDiff = desiredVel - currentVel;
  const isBrakingOrReversing =
    currentVel * dir < 0 || Math.abs(desiredVel) < Math.abs(currentVel);
  const rate = isBrakingOrReversing ? safeDecel : safeAccel;
  const maxDeltaV = rate * dt;

  let nextVel =
    Math.abs(velDiff) <= maxDeltaV
      ? desiredVel
      : currentVel + Math.sign(velDiff) * maxDeltaV;

  let nextPos = currentPos + nextVel * dt;
  // Prevent discrete timestep overshoot past target
  if ((targetPos - currentPos) * (targetPos - nextPos) < 0) {
    nextPos = targetPos;
    nextVel = 0;
  }

  return { pos: nextPos, vel: nextVel };
}

/**
 * Steps all FK joints, visual effects, and SIM_TO_PLC sensor feedback for one 3D machine instance.
 */
export function stepKinematicsRig(
  rig: KinematicsInstanceRig,
  bufferView: BinaryIpcBufferView,
  runState: SimulationRunState,
  simSpeedMultiplier: number,
  rawDeltaSec: number,
  jogPreview: JogPreviewState | null
): void {
  if (rig.activeRuntimes.length === 0) return;

  const dt =
    runState === 'RUNNING'
      ? Math.min(Math.max(rawDeltaSec, 0), 0.05) * Math.max(0.05, simSpeedMultiplier)
      : 0;

  // Reset per-frame motion flags
  for (let i = 0; i < rig.orderedNodeRecords.length; i++) {
    const rec = rig.orderedNodeRecords[i];
    rec.deltaTotalComp.identity();
    rec.currentCompMatrix.copy(rec.restCompMatrix);
    rec.hasMotion = false;
  }

  let anyReedExtendedOnMachine = false;

  for (let i = 0; i < rig.activeRuntimes.length; i++) {
    const rt = rig.activeRuntimes[i];
    const rec = rt.nodeRecord;
    const isJoggingThisNode =
      jogPreview !== null &&
      jogPreview.instanceId === rig.instanceId &&
      jogPreview.nodeName === rec.name;

    if (rt.kind === 'LinearAxis') {
      const { role } = rt;
      const minMm = Math.min(role.minLimitMm, role.maxLimitMm);
      const maxMm = Math.max(role.minLimitMm, role.maxLimitMm);

      if (isJoggingThisNode) {
        rt.posMm = Math.min(maxMm, Math.max(minMm, jogPreview.value));
        rt.velMmPerSec = 0;
      } else if (runState === 'STOPPED') {
        rt.posMm = Math.min(maxMm, Math.max(minMm, role.initialPosMm));
        rt.velMmPerSec = 0;
      } else if (dt > 0) {
        if (role.behavior?.presetType === 'ServoPositioning') {
          const rawTarget =
            rt.aoTargetPosMmSlot >= 0
              ? bufferView.readFloat32(rt.aoTargetPosMmSlot)
              : role.initialPosMm;
          const clampedTarget = Math.min(maxMm, Math.max(minMm, rawTarget));
          const stepped = stepTrapezoidalServo(
            rt.posMm,
            rt.velMmPerSec,
            clampedTarget,
            role.behavior.maxVelocityUnitsPerSec,
            role.behavior.accelerationUnitsPerSec2,
            role.behavior.decelerationUnitsPerSec2,
            dt
          );
          rt.posMm = Math.min(maxMm, Math.max(minMm, stepped.pos));
          rt.velMmPerSec = stepped.vel;
        } else {
          // PneumaticCylinder (single-acting or double-acting)
          const actingMode =
            role.behavior?.presetType === 'PneumaticCylinder'
              ? role.behavior.actingMode
              : 'single-acting';
          const extSpeed =
            role.behavior?.presetType === 'PneumaticCylinder'
              ? Math.max(5, role.behavior.extendSpeedMmPerSec)
              : 220;
          const retSpeed =
            role.behavior?.presetType === 'PneumaticCylinder'
              ? Math.max(5, role.behavior.retractSpeedMmPerSec)
              : 250;

          const cmdExtend =
            rt.doExtendSlot >= 0 ? bufferView.readPlcToSimBool(rt.doExtendSlot) : false;
          const cmdRetract =
            rt.doRetractSlot >= 0 ? bufferView.readPlcToSimBool(rt.doRetractSlot) : false;

          if (actingMode === 'single-acting') {
            if (cmdExtend) {
              rt.posMm = Math.min(maxMm, rt.posMm + extSpeed * dt);
            } else {
              rt.posMm = Math.max(minMm, rt.posMm - retSpeed * dt);
            }
          } else {
            if (cmdExtend && !cmdRetract) {
              rt.posMm = Math.min(maxMm, rt.posMm + extSpeed * dt);
            } else if (cmdRetract && !cmdExtend) {
              rt.posMm = Math.max(minMm, rt.posMm - retSpeed * dt);
            }
          }
        }
      }

      // Emit deterministic SIM_TO_PLC Reed Switch & Servo feedback
      const strokeSpan = Math.max(1, maxMm - minMm);
      const reedTol = Math.min(2.0, strokeSpan * 0.03 + 0.25);
      const atMin = Math.abs(rt.posMm - minMm) <= reedTol;
      const atMax = Math.abs(rt.posMm - maxMm) <= reedTol;
      rt.isReedExtended = atMax && maxMm > minMm + 0.5;
      if (rt.isReedExtended) anyReedExtendedOnMachine = true;

      if (rt.diReedRetractedSlot >= 0) {
        bufferView.writeSimToPlcBool(rt.diReedRetractedSlot, atMin);
      }
      if (rt.diReedExtendedSlot >= 0) {
        bufferView.writeSimToPlcBool(rt.diReedExtendedSlot, atMax);
      }
      if (rt.aiStrokeMmSlot >= 0) {
        bufferView.writeFloat32(rt.aiStrokeMmSlot, rt.posMm);
      }
      if (rt.aiActualPosMmSlot >= 0) {
        bufferView.writeFloat32(rt.aiActualPosMmSlot, rt.posMm);
      }
      if (rt.diInPositionSlot >= 0 && rt.aoTargetPosMmSlot >= 0) {
        const tgt = Math.min(
          maxMm,
          Math.max(minMm, bufferView.readFloat32(rt.aoTargetPosMmSlot))
        );
        bufferView.writeSimToPlcBool(
          rt.diInPositionSlot,
          Math.abs(rt.posMm - tgt) <= 0.6 && Math.abs(rt.velMmPerSec) <= 2.5
        );
      }

      // Compute Component-Space translation matrix
      const dispMeters = rt.posMm * 0.001;
      _vecDisp.copy(rt.unitAxisComp).multiplyScalar(dispMeters);
      _matDeltaSelf.makeTranslation(_vecDisp.x, _vecDisp.y, _vecDisp.z);

      const parentChainRec = role.parentNodeName
        ? rig.nodeRecords.get(role.parentNodeName) ?? null
        : rec.parentRecord;
      if (parentChainRec && parentChainRec.hasMotion) {
        rec.deltaTotalComp.multiplyMatrices(parentChainRec.deltaTotalComp, _matDeltaSelf);
      } else {
        rec.deltaTotalComp.copy(_matDeltaSelf);
      }
      rec.hasMotion = true;
    } else if (rt.kind === 'RotaryAxis') {
      const { role } = rt;

      if (role.mode === 'continuous') {
        if (isJoggingThisNode) {
          rt.angleDeg = ((jogPreview.value % 360) + 360) % 360;
          rt.actualRpm = 0;
        } else if (runState === 'STOPPED') {
          rt.angleDeg = 0;
          rt.actualRpm = 0;
        } else if (dt > 0) {
          const runFwd =
            rt.doRunForwardSlot >= 0
              ? bufferView.readPlcToSimBool(rt.doRunForwardSlot)
              : false;
          const runRev =
            rt.doRunReverseSlot >= 0
              ? bufferView.readPlcToSimBool(rt.doRunReverseSlot)
              : false;
          const speedSetpoint =
            rt.aoSpeedRpmSlot >= 0
              ? Math.max(0, bufferView.readFloat32(rt.aoSpeedRpmSlot))
              : Math.max(1, role.defaultRpm || 60);

          const targetRpm =
            runFwd && !runRev ? speedSetpoint : runRev && !runFwd ? -speedSetpoint : 0;

          // Smooth motor inertia ramp (260 RPM/s)
          const rpmDiff = targetRpm - rt.actualRpm;
          const maxStepRpm = 260 * dt;
          rt.actualRpm =
            Math.abs(rpmDiff) <= maxStepRpm
              ? targetRpm
              : rt.actualRpm + Math.sign(rpmDiff) * maxStepRpm;

          const degPerSec = (rt.actualRpm / 60) * 360;
          rt.angleDeg = (rt.angleDeg + degPerSec * dt) % 360;
        }

        if (rt.aiActualRpmSlot >= 0) {
          bufferView.writeFloat32(rt.aiActualRpmSlot, rt.actualRpm);
        }
      } else {
        // Bounded indexing / servo rotary axis
        const minDeg = Math.min(role.minDeg, role.maxDeg);
        const maxDeg = Math.max(role.minDeg, role.maxDeg);
        const homeDeg = 0 >= minDeg && 0 <= maxDeg ? 0 : minDeg;

        let targetDeg = homeDeg;
        if (rt.doIndexMaxSlot >= 0 && bufferView.readPlcToSimBool(rt.doIndexMaxSlot)) {
          targetDeg = maxDeg;
        } else if (rt.aoTargetAngleDegSlot >= 0) {
          targetDeg = Math.min(
            maxDeg,
            Math.max(minDeg, bufferView.readFloat32(rt.aoTargetAngleDegSlot))
          );
        }

        if (isJoggingThisNode) {
          rt.angleDeg = Math.min(maxDeg, Math.max(minDeg, jogPreview.value));
          rt.velDegPerSec = 0;
        } else if (runState === 'STOPPED') {
          rt.angleDeg = homeDeg;
          rt.velDegPerSec = 0;
        } else if (dt > 0) {
          const nominalDegPerSec = (Math.max(1, role.defaultRpm || 15) / 60) * 360;
          const maxVel =
            role.behavior?.presetType === 'ServoPositioning'
              ? role.behavior.maxVelocityUnitsPerSec
              : nominalDegPerSec;
          const accel =
            role.behavior?.presetType === 'ServoPositioning'
              ? role.behavior.accelerationUnitsPerSec2
              : nominalDegPerSec * 3.5;
          const decel =
            role.behavior?.presetType === 'ServoPositioning'
              ? role.behavior.decelerationUnitsPerSec2
              : nominalDegPerSec * 4.0;

          const stepped = stepTrapezoidalServo(
            rt.angleDeg,
            rt.velDegPerSec,
            targetDeg,
            maxVel,
            accel,
            decel,
            dt
          );
          rt.angleDeg = Math.min(maxDeg, Math.max(minDeg, stepped.pos));
          rt.velDegPerSec = stepped.vel;
        }

        if (rt.aiActualAngleDegSlot >= 0) {
          bufferView.writeFloat32(rt.aiActualAngleDegSlot, rt.angleDeg);
        }
        if (rt.diInPositionSlot >= 0) {
          bufferView.writeSimToPlcBool(
            rt.diInPositionSlot,
            Math.abs(rt.angleDeg - targetDeg) <= 0.5 && Math.abs(rt.velDegPerSec) <= 2.0
          );
        }
      }

      // Compute Component-Space rotation around sub-mesh pivot center
      _quatRot.setFromAxisAngle(rt.unitAxisComp, rt.angleDeg * DEG2RAD);
      _matRot.makeRotationFromQuaternion(_quatRot);
      _matPivotPos.makeTranslation(rt.pivotComp.x, rt.pivotComp.y, rt.pivotComp.z);
      _matPivotNeg.makeTranslation(-rt.pivotComp.x, -rt.pivotComp.y, -rt.pivotComp.z);
      _matDeltaSelf.multiplyMatrices(_matPivotPos, _matRot).multiply(_matPivotNeg);

      const parentChainRec = role.parentNodeName
        ? rig.nodeRecords.get(role.parentNodeName) ?? null
        : rec.parentRecord;
      if (parentChainRec && parentChainRec.hasMotion) {
        rec.deltaTotalComp.multiplyMatrices(parentChainRec.deltaTotalComp, _matDeltaSelf);
      } else {
        rec.deltaTotalComp.copy(_matDeltaSelf);
      }
      rec.hasMotion = true;
    } else if (rt.kind === 'VisualEffect') {
      const { role } = rt;

      if (role.effectType === 'uv-scroll') {
        if (runState === 'STOPPED') {
          rt.actualBeltRpm = 0;
        } else if (dt > 0) {
          const beltRun =
            rt.doBeltRunSlot >= 0 && bufferView.readPlcToSimBool(rt.doBeltRunSlot);
          const nominalRpm = Math.max(1, role.nominalRpm ?? 60);
          const setpointRpm =
            rt.aoBeltSpeedRpmSlot >= 0
              ? Math.max(0, bufferView.readFloat32(rt.aoBeltSpeedRpmSlot))
              : nominalRpm;
          const targetRpm = beltRun ? setpointRpm : 0;

          // Smooth conveyor motor inertia ramp (260 RPM/s)
          const rpmDiff = targetRpm - rt.actualBeltRpm;
          const maxStepRpm = 260 * dt;
          rt.actualBeltRpm =
            Math.abs(rpmDiff) <= maxStepRpm
              ? targetRpm
              : rt.actualBeltRpm + Math.sign(rpmDiff) * maxStepRpm;

          if (Math.abs(rt.actualBeltRpm) > 0.01) {
            // 60 RPM drive drum (~150mm dia -> ~0.47 m/s belt speed -> ~1.32 chevron tiles/s)
            const scrollDelta =
              (rt.actualBeltRpm / 60) * (role.uvScrollScale ?? 1.0) * 1.32 * dt;
            for (let t = 0; t < rt.scrollTextures.length; t++) {
              const tex = rt.scrollTextures[t];
              if (role.uvScrollAxis === 'v') {
                tex.offset.y = (tex.offset.y - scrollDelta) % 1;
              } else {
                tex.offset.x = (tex.offset.x - scrollDelta) % 1;
              }
            }
          }
        }

        if (rt.aiActualBeltRpmSlot >= 0) {
          bufferView.writeFloat32(rt.aiActualBeltRpmSlot, rt.actualBeltRpm);
        }
      } else if (role.effectType === 'emissive-lamp') {
        const manualForced =
          rt.doLampOnSlot >= 0 && bufferView.isForceBoolEnabled(rt.doLampOnSlot);
        const cmdOn =
          rt.doLampOnSlot >= 0 ? bufferView.readPlcToSimBool(rt.doLampOnSlot) : false;
        const lampActive = manualForced
          ? cmdOn
          : cmdOn || (rt.autoLinkReedLamp && anyReedExtendedOnMachine);

        for (let m = 0; m < rt.materials.length; m++) {
          const mat = rt.materials[m];
          mat.emissive.copy(lampActive ? rt.emissiveOnColor : rt.emissiveOffColor);
          mat.emissiveIntensity = lampActive ? 1.4 : 0.12;
        }
      } else if (role.effectType === 'tank-level') {
        const targetPct = isJoggingThisNode
          ? jogPreview.value
          : rt.aoLevelPctSlot >= 0
            ? bufferView.readFloat32(rt.aoLevelPctSlot)
            : 50;
        const clampedPct = Math.min(100, Math.max(2, targetPct));
        rt.currentLevelPct =
          runState === 'STOPPED' && !isJoggingThisNode ? 50 : clampedPct;

        const sy = Math.max(0.02, rt.currentLevelPct / 100);
        const yMin = rec.restBoundsComp.min[1];
        _matPivotPos.makeTranslation(0, yMin, 0);
        _matScale.makeScale(1, sy, 1);
        _matPivotNeg.makeTranslation(0, -yMin, 0);
        rec.deltaTotalComp.multiplyMatrices(_matPivotPos, _matScale).multiply(_matPivotNeg);
        rec.hasMotion = true;
      }
    }
  }

  // Propagate motion top-down and decompose back into Three.js Object3D local transforms
  for (let i = 0; i < rig.orderedNodeRecords.length; i++) {
    const rec = rig.orderedNodeRecords[i];

    // Static child nodes inherit their scene-graph parent's motion automatically in Three.js,
    // while still forwarding deltaTotalComp in case a deeper sub-mesh has its own role.
    if (!rec.hasMotion) {
      if (rec.parentRecord && !rec.parentRecord.deltaTotalComp.equals(_matIdentity)) {
        rec.deltaTotalComp.copy(rec.parentRecord.deltaTotalComp);
        rec.currentCompMatrix.multiplyMatrices(rec.deltaTotalComp, rec.restCompMatrix);
      }
      continue;
    }

    rec.currentCompMatrix.multiplyMatrices(rec.deltaTotalComp, rec.restCompMatrix);

    if (rec.parentRecord && !rec.parentRecord.deltaTotalComp.equals(_matIdentity)) {
      _matInvParent
        .multiplyMatrices(rec.parentRecord.deltaTotalComp, rec.restParentCompMatrix)
        .invert();
    } else {
      _matInvParent.copy(rec.restParentCompMatrix).invert();
    }

    _matNextLocal.multiplyMatrices(_matInvParent, rec.currentCompMatrix);
    _matNextLocal.decompose(rec.obj.position, rec.obj.quaternion, rec.obj.scale);
  }
}
