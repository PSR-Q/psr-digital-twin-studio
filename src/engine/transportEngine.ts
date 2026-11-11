import * as THREE from 'three';
import {
  type BinaryIpcBufferView,
  type ComponentDefinition,
  type FlowItemState,
  type LinearAxisRole,
  type PlcTagBinding,
  type RotaryAxisRole,
  type SceneNodeInstance,
  type SimulationRunState,
  type SubMeshRoleAssignment,
  type TransportGraph,
  type TransportPathNode,
  type UUID,
  type VacuumGripperRole,
  type Vector3Tuple,
  type WorkpieceShapeType,
} from '../shared/schemas';
import {
  getLiveGripperCompPose,
  setLiveAutoAxisTargetMm,
  setLiveAutoCylinderExtend,
  setLiveAutoVacuumOn,
  setLiveAxisDynamicMaxMm,
} from './kinematicsEngine';
import { makeNodeSignalKey } from './signalCatalogSync';
import { eulerDegToQuaternion } from './snapEngine';

/**
 * Deterministic 1D Spline Material Flow, Smooth Accumulation, Sub-Frame Sensor,
 * Vacuum Gripper Pick & Transfer, and Virtual HSC Encoder Engine (Milestones 3 & 4 — Zero React Re-renders)
 *
 * Runs at 60–144Hz inside R3F `useFrame` (or deterministic headless test loops),
 * reading and writing directly to `BinaryIpcBufferView`.
 */

export interface RuntimeFlowItem extends FlowItemState {
  prevDistanceMm: number;
  serialNumber: number;
}

export interface BeltDropHitResult {
  pathNodeId: UUID;
  instanceId: UUID;
  distanceMm: number;
  worldPoint: Vector3Tuple;
  worldQuaternion: [number, number, number, number];
  rayDistanceMeters: number;
}

export interface DraggedWorkpieceDescriptor {
  shape: WorkpieceShapeType;
  dimensionsMm: Vector3Tuple;
  colorHex: string;
  label: string;
  customComponentId?: UUID;
}

export interface WorldPathSampleTable {
  nodeId: UUID;
  instanceId: UUID;
  arcLengthMm: number;
  sampleCount: number;
  distancesMm: Float64Array;
  positions: Float32Array;
  tangents: Float32Array;
  worldStart: THREE.Vector3;
  worldEnd: THREE.Vector3;
  startTangent: THREE.Vector3;
  endTangent: THREE.Vector3;
  deckAngleDeg: number;
}

export interface LiveEncoderTelemetry {
  encoderId: UUID;
  pulsesDint: number;
  servoPositionReal: number;
  velocityReal: number;
}

interface AxisFeedbackLookup {
  posRealSlot: number;
  reedExtBoolSlot: number;
  doExtBoolSlot: number;
  minLimitMm: number;
  isPneumaticStopper: boolean;
}

interface BeltDriveLookup {
  runBitSlot: number;
  actualRpmSlot: number;
  cmdRpmSlot: number;
  nominalRpm: number;
  fallbackRampedRpm: number;
}

type AutoPickPhase =
  | 'WAIT_PART'
  | 'LOWER_PICK'
  | 'GRAB_DWELL'
  | 'LIFT_PICK'
  | 'TRAVERSE_PLACE'
  | 'LOWER_PLACE'
  | 'RELEASE_DWELL'
  | 'LIFT_PLACE'
  | 'RETURN_HOME';

interface GripperRuntimeController {
  key: string;
  instanceId: UUID;
  nodeName: string;
  role: VacuumGripperRole;
  chainRoles: Array<{
    role: LinearAxisRole | RotaryAxisRole;
    actualSlot: number;
  }>;
  doAutoCycleSlot: number;
  doVacuumOnSlot: number;
  aoPlacePosMmSlot: number;
  diPartPresentSlot: number;
  diPartGrippedSlot: number;
  verticalAxisNodeName: string | null;
  verticalAxisRole: LinearAxisRole | null;
  verticalDoExtendSlot: number;
  verticalDoRetractSlot: number;
  verticalStrokeSlot: number;
  verticalReedExtSlot: number;
  verticalReedRetSlot: number;
  traverseAxisNodeName: string | null;
  traverseAxisRole: LinearAxisRole | null;
  traverseAoTargetSlot: number;
  traverseActualPosSlot: number;
  traverseInPosSlot: number;
  autoPhase: AutoPickPhase;
  phaseTimerSec: number;
  autoVacuumCmd: boolean;
  wasAutoCycleActive: boolean;
  grippedItemId: UUID | null;
  gripRelQuat: THREE.Quaternion;
  headlessTraversePosMm: number;
  headlessTraverseVelMmS: number;
  headlessVerticalPosMm: number;
}

const LUT_SAMPLES = 64;
const ACCUMULATION_GAP_MM = 24;
const STOPPER_CLEARANCE_MM = 8;
const ACCEL_MM_S2 = 1250;
const DECEL_MM_S2 = 1550;
const LOOKAHEAD_WINDOW_MM = 560;
const DEG2RAD = Math.PI / 180;

const PALETTE_COLORS = ['#0ea5e9', '#f59e0b', '#10b981', '#6366f1', '#ec4899'];

// Pre-allocated math temporaries for zero GC allocations per frame
const _upVec = new THREE.Vector3(0, 1, 0);
const _xVec = new THREE.Vector3();
const _yVec = new THREE.Vector3();
const _zVec = new THREE.Vector3();
const _basisMat = new THREE.Matrix4();
const _deckQuat = new THREE.Quaternion();
const _tmpVecA = new THREE.Vector3();
const _tmpVecB = new THREE.Vector3();
const _gripPadWorldPos = new THREE.Vector3();
const _gripHomeWorldPos = new THREE.Vector3();
const _gripCompQuat = new THREE.Quaternion();
const _gripPadWorldQuat = new THREE.Quaternion();
const _gripItemPos = new THREE.Vector3();
const _gripItemQuat = new THREE.Quaternion();
const _gripComposedQuat = new THREE.Quaternion();
const _gripAxisVec = new THREE.Vector3();
const _gripRotQuat = new THREE.Quaternion();

function stepHeadlessServo1D(
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
  const isBraking =
    currentVel * dir < 0 || Math.abs(desiredVel) < Math.abs(currentVel);
  const maxDeltaV = (isBraking ? safeDecel : safeAccel) * dt;
  let nextVel =
    Math.abs(velDiff) <= maxDeltaV
      ? desiredVel
      : currentVel + Math.sign(velDiff) * maxDeltaV;
  let nextPos = currentPos + nextVel * dt;
  if ((targetPos - currentPos) * (targetPos - nextPos) < 0) {
    nextPos = targetPos;
    nextVel = 0;
  }
  return { pos: nextPos, vel: nextVel };
}

function applySignedModulo(val: number, modulo: number): number {
  const safeMod = Math.max(100, Math.floor(Math.abs(modulo) || 1_000_000));
  if (safeMod >= 2_147_483_640) {
    return val | 0;
  }
  const rem = Math.trunc(val) % safeMod;
  return rem | 0;
}

function buildWorldPathSampleTable(
  node: TransportPathNode,
  instance: SceneNodeInstance,
  deckAngleDeg: number
): WorldPathSampleTable {
  const instPos = new THREE.Vector3(...instance.transform.position);
  const instQuat = eulerDegToQuaternion(instance.transform.rotationDeg);
  const instScale = new THREE.Vector3(...instance.transform.scale);
  _deckQuat.setFromAxisAngle(_upVec, deckAngleDeg * DEG2RAD);

  const worldControlPts = node.localWaypoints.map((wp) => {
    const v = new THREE.Vector3(wp[0], wp[1], wp[2]);
    if (Math.abs(deckAngleDeg) > 1e-4) {
      v.applyQuaternion(_deckQuat);
    }
    return v.multiply(instScale).applyQuaternion(instQuat).add(instPos);
  });

  const sampleCount = LUT_SAMPLES;
  const distancesMm = new Float64Array(sampleCount);
  const positions = new Float32Array(sampleCount * 3);
  const tangents = new Float32Array(sampleCount * 3);

  if (worldControlPts.length < 2) {
    const fallback = worldControlPts[0] ?? instPos;
    for (let i = 0; i < sampleCount; i++) {
      positions[i * 3] = fallback.x;
      positions[i * 3 + 1] = fallback.y;
      positions[i * 3 + 2] = fallback.z;
      tangents[i * 3] = 1;
    }
    return {
      nodeId: node.id,
      instanceId: node.instanceId,
      arcLengthMm: 10,
      sampleCount,
      distancesMm,
      positions,
      tangents,
      worldStart: fallback.clone(),
      worldEnd: fallback.clone(),
      startTangent: new THREE.Vector3(1, 0, 0),
      endTangent: new THREE.Vector3(1, 0, 0),
      deckAngleDeg,
    };
  }

  if (node.interpolation === 'catmull-rom' && worldControlPts.length >= 3) {
    const curve = new THREE.CatmullRomCurve3(
      worldControlPts,
      false,
      'centripetal',
      0.5
    );
    let cumMm = 0;
    let prevPt = curve.getPoint(0);

    for (let i = 0; i < sampleCount; i++) {
      const u = i / (sampleCount - 1);
      const pt = curve.getPoint(u);
      const tan = curve.getTangent(u).normalize();
      if (i > 0) {
        cumMm += pt.distanceTo(prevPt) * 1000;
      }
      prevPt = pt;

      distancesMm[i] = cumMm;
      positions[i * 3] = pt.x;
      positions[i * 3 + 1] = pt.y;
      positions[i * 3 + 2] = pt.z;
      tangents[i * 3] = tan.x;
      tangents[i * 3 + 1] = tan.y;
      tangents[i * 3 + 2] = tan.z;
    }
  } else {
    // Exact piecewise-linear polyline sampler
    const segCumM: number[] = [0];
    for (let s = 1; s < worldControlPts.length; s++) {
      segCumM.push(
        segCumM[s - 1] + worldControlPts[s - 1].distanceTo(worldControlPts[s])
      );
    }
    const totalM = Math.max(0.01, segCumM[segCumM.length - 1]);

    let segIdx = 0;
    for (let i = 0; i < sampleCount; i++) {
      const targetM = (i / (sampleCount - 1)) * totalM;
      while (
        segIdx < worldControlPts.length - 2 &&
        targetM > segCumM[segIdx + 1]
      ) {
        segIdx++;
      }
      const segStartM = segCumM[segIdx];
      const segLenM = Math.max(1e-6, segCumM[segIdx + 1] - segStartM);
      const alpha = Math.min(1, Math.max(0, (targetM - segStartM) / segLenM));

      const pA = worldControlPts[segIdx];
      const pB = worldControlPts[segIdx + 1];
      _tmpVecA.lerpVectors(pA, pB, alpha);
      _tmpVecB.subVectors(pB, pA);
      if (_tmpVecB.lengthSq() < 1e-10) _tmpVecB.set(1, 0, 0);
      else _tmpVecB.normalize();

      distancesMm[i] = targetM * 1000;
      positions[i * 3] = _tmpVecA.x;
      positions[i * 3 + 1] = _tmpVecA.y;
      positions[i * 3 + 2] = _tmpVecA.z;
      tangents[i * 3] = _tmpVecB.x;
      tangents[i * 3 + 1] = _tmpVecB.y;
      tangents[i * 3 + 2] = _tmpVecB.z;
    }
  }

  const totalArcMm = Math.max(10, distancesMm[sampleCount - 1]);
  const last = (sampleCount - 1) * 3;

  return {
    nodeId: node.id,
    instanceId: node.instanceId,
    arcLengthMm: totalArcMm,
    sampleCount,
    distancesMm,
    positions,
    tangents,
    worldStart: new THREE.Vector3(positions[0], positions[1], positions[2]),
    worldEnd: new THREE.Vector3(positions[last], positions[last + 1], positions[last + 2]),
    startTangent: new THREE.Vector3(tangents[0], tangents[1], tangents[2]),
    endTangent: new THREE.Vector3(
      tangents[last],
      tangents[last + 1],
      tangents[last + 2]
    ),
    deckAngleDeg,
  };
}

export function sampleWorldPathPose(
  lut: WorldPathSampleTable,
  distanceMm: number,
  outPos: THREE.Vector3,
  outQuat?: THREE.Quaternion,
  outTangent?: THREE.Vector3
): void {
  const clamped = Math.min(lut.arcLengthMm, Math.max(0, distanceMm));
  const dists = lut.distancesMm;
  const n = lut.sampleCount;

  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (dists[mid] <= clamped) lo = mid;
    else hi = mid;
  }

  const span = Math.max(1e-6, dists[hi] - dists[lo]);
  const t = Math.min(1, Math.max(0, (clamped - dists[lo]) / span));

  const i0 = lo * 3;
  const i1 = hi * 3;

  outPos.set(
    lut.positions[i0] + (lut.positions[i1] - lut.positions[i0]) * t,
    lut.positions[i0 + 1] + (lut.positions[i1 + 1] - lut.positions[i0 + 1]) * t,
    lut.positions[i0 + 2] + (lut.positions[i1 + 2] - lut.positions[i0 + 2]) * t
  );

  _xVec.set(
    lut.tangents[i0] + (lut.tangents[i1] - lut.tangents[i0]) * t,
    lut.tangents[i0 + 1] + (lut.tangents[i1 + 1] - lut.tangents[i0 + 1]) * t,
    lut.tangents[i0 + 2] + (lut.tangents[i1 + 2] - lut.tangents[i0 + 2]) * t
  );
  if (_xVec.lengthSq() < 1e-8) _xVec.set(1, 0, 0);
  else _xVec.normalize();

  if (outTangent) {
    outTangent.copy(_xVec);
  }

  if (outQuat) {
    _yVec.copy(_upVec);
    if (Math.abs(_xVec.dot(_yVec)) > 0.98) {
      _yVec.set(0, 0, 1);
    }
    _zVec.crossVectors(_xVec, _yVec).normalize();
    _yVec.crossVectors(_zVec, _xVec).normalize();
    _basisMat.makeBasis(_xVec, _yVec, _zVec);
    outQuat.setFromRotationMatrix(_basisMat);
  }
}

function projectPointToPathDistanceMm(
  lut: WorldPathSampleTable,
  worldPoint: THREE.Vector3
): { distanceMm: number; lateralDistMeters: number; verticalDistMeters: number } {
  let bestIdx = 0;
  let bestSq = Infinity;

  for (let i = 0; i < lut.sampleCount; i++) {
    const dx = worldPoint.x - lut.positions[i * 3];
    const dz = worldPoint.z - lut.positions[i * 3 + 2];
    const dSq = dx * dx + dz * dz;
    if (dSq < bestSq) {
      bestSq = dSq;
      bestIdx = i;
    }
  }

  const py = lut.positions[bestIdx * 3 + 1];
  return {
    distanceMm: lut.distancesMm[bestIdx],
    lateralDistMeters: Math.sqrt(bestSq),
    verticalDistMeters: Math.abs(worldPoint.y - py),
  };
}

function closestDistanceRayToSegment(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  p0x: number,
  p0y: number,
  p0z: number,
  p1x: number,
  p1y: number,
  p1z: number
): { segU: number; rayT: number; distSq: number } {
  const vx = p1x - p0x;
  const vy = p1y - p0y;
  const vz = p1z - p0z;
  const wx = ox - p0x;
  const wy = oy - p0y;
  const wz = oz - p0z;

  const a = dx * dx + dy * dy + dz * dz;
  const b = dx * vx + dy * vy + dz * vz;
  const c = vx * vx + vy * vy + vz * vz;
  const d = dx * wx + dy * wy + dz * wz;
  const e = vx * wx + vy * wy + vz * wz;

  let segU = 0;
  let rayT = 0;

  if (c <= 1e-10) {
    segU = 0;
    rayT = a > 1e-10 ? Math.max(0, -d / a) : 0;
  } else {
    const det = a * c - b * b;
    if (det > 1e-9) {
      segU = Math.min(1, Math.max(0, (a * e - b * d) / det));
    } else {
      segU = 0;
    }
    rayT = a > 1e-10 ? (b * segU - d) / a : 0;
    if (rayT < 0) {
      rayT = 0;
      segU = Math.min(1, Math.max(0, e / c));
    }
  }

  const rx = ox + rayT * dx;
  const ry = oy + rayT * dy;
  const rz = oz + rayT * dz;
  const sx = p0x + segU * vx;
  const sy = p0y + segU * vy;
  const sz = p0z + segU * vz;

  const ex = rx - sx;
  const ey = ry - sy;
  const ez = rz - sz;
  return {
    segU,
    rayT,
    distSq: ex * ex + ey * ey + ez * ez,
  };
}

const _hitSamplePos = new THREE.Vector3();
const _hitSampleQuat = new THREE.Quaternion();

export class TransportRuntimeEngine {
  private items: RuntimeFlowItem[] = [];
  private serialCounter = 1;

  private samplerCache = new Map<
    UUID,
    { signature: string; table: WorldPathSampleTable }
  >();
  private spawnerTimers = new Map<UUID, number>();
  private spawnerPrevTrigger = new Map<UUID, boolean>();
  private spawnerCounts = new Map<UUID, number>();
  private sinkCounts = new Map<UUID, number>();

  private sensorStates = new Map<UUID, boolean>();
  private beltTravelAccumMm = new Map<UUID, number>();
  private axisPrevPos = new Map<string, number>();
  private axisSmoothVel = new Map<string, number>();
  private beltDriveMap = new Map<UUID, BeltDriveLookup>();
  private axisLookupMap = new Map<string, AxisFeedbackLookup>();
  private turntableAngleSlotByInst = new Map<UUID, number>();
  private gripperControllers = new Map<string, GripperRuntimeController>();

  private activeDraggedWorkpiece: DraggedWorkpieceDescriptor | null = null;
  private dragPreviewHit: BeltDropHitResult | null = null;

  private cachedConfigSignature = '';
  private wasStopped = true;

  public getFlowItems(): readonly RuntimeFlowItem[] {
    return this.items;
  }

  public getWorldSampler(nodeId: UUID): WorldPathSampleTable | undefined {
    return this.samplerCache.get(nodeId)?.table;
  }

  public isSensorTriggered(sensorId: UUID): boolean {
    return this.sensorStates.get(sensorId) ?? false;
  }

  public getSpawnerCount(spawnerId: UUID): number {
    return this.spawnerCounts.get(spawnerId) ?? 0;
  }

  public getSinkCount(sinkId: UUID): number {
    return this.sinkCounts.get(sinkId) ?? 0;
  }

  public setActiveDraggedWorkpiece(desc: DraggedWorkpieceDescriptor | null): void {
    this.activeDraggedWorkpiece = desc;
    if (!desc) {
      this.dragPreviewHit = null;
    }
  }

  public getActiveDraggedWorkpiece(): DraggedWorkpieceDescriptor | null {
    return this.activeDraggedWorkpiece;
  }

  public setDragPreviewHit(hit: BeltDropHitResult | null): void {
    this.dragPreviewHit = hit;
  }

  public getDragPreviewHit(): BeltDropHitResult | null {
    return this.dragPreviewHit;
  }

  public clearAllFlowItems(bufferView?: BinaryIpcBufferView, graph?: TransportGraph): void {
    this.items = [];
    this.spawnerTimers.clear();
    this.spawnerPrevTrigger.clear();
    this.spawnerCounts.clear();
    this.sinkCounts.clear();
    this.beltTravelAccumMm.clear();
    this.axisPrevPos.clear();
    this.axisSmoothVel.clear();

    for (const ctrl of this.gripperControllers.values()) {
      ctrl.grippedItemId = null;
      ctrl.autoPhase = 'WAIT_PART';
      ctrl.phaseTimerSec = 0;
      ctrl.autoVacuumCmd = false;
      ctrl.wasAutoCycleActive = false;
      ctrl.headlessTraversePosMm = ctrl.traverseAxisRole?.initialPosMm ?? 0;
      ctrl.headlessTraverseVelMmS = 0;
      ctrl.headlessVerticalPosMm = ctrl.verticalAxisRole?.initialPosMm ?? 0;

      if (ctrl.verticalAxisNodeName) {
        setLiveAxisDynamicMaxMm(ctrl.instanceId, ctrl.verticalAxisNodeName, null);
        setLiveAutoCylinderExtend(ctrl.instanceId, ctrl.verticalAxisNodeName, null);
      }
      if (ctrl.traverseAxisNodeName) {
        setLiveAutoAxisTargetMm(ctrl.instanceId, ctrl.traverseAxisNodeName, null);
      }
      setLiveAutoVacuumOn(ctrl.instanceId, ctrl.nodeName, null);

      if (bufferView) {
        if (ctrl.diPartPresentSlot >= 0) {
          bufferView.writeSimToPlcBool(ctrl.diPartPresentSlot, false);
        }
        if (ctrl.diPartGrippedSlot >= 0) {
          bufferView.writeSimToPlcBool(ctrl.diPartGrippedSlot, false);
        }
      }
    }

    if (bufferView && graph) {
      for (const s of graph.sensors) {
        this.sensorStates.set(s.id, false);
        if (s.outputBoolSlot >= 0) {
          bufferView.writeSimToPlcBool(s.outputBoolSlot, false);
        }
      }
      for (const sp of graph.spawners) {
        if (sp.spawnedCountDintSlot !== undefined && sp.spawnedCountDintSlot >= 0) {
          bufferView.writeDint32(sp.spawnedCountDintSlot, 0);
        }
      }
      for (const sk of graph.sinks) {
        if (sk.countedPartsDintSlot !== undefined && sk.countedPartsDintSlot >= 0) {
          bufferView.writeDint32(sk.countedPartsDintSlot, 0);
        }
      }
      for (const enc of graph.encoders) {
        if (enc.sourceKind === 'transport-path') {
          if (enc.cumulativePulsesDintSlot >= 0) {
            bufferView.writeDint32(enc.cumulativePulsesDintSlot, 0);
          }
          if (enc.actualPositionRealSlot >= 0) {
            bufferView.writeFloat32(enc.actualPositionRealSlot, 0);
          }
          if (enc.actualVelocityRealSlot >= 0) {
            bufferView.writeFloat32(enc.actualVelocityRealSlot, 0);
          }
        }
      }
    }
  }

  /**
   * Manually spawns a single workpiece at the specified spawner (or primary path of an instance)
   * if the entry zone is clear.
   */
  public spawnSinglePartNow(
    graph: TransportGraph,
    spawnerIdOrInstanceId: UUID
  ): RuntimeFlowItem | null {
    const spawner =
      graph.spawners.find(
        (s) => s.id === spawnerIdOrInstanceId || s.instanceId === spawnerIdOrInstanceId
      ) ?? null;

    let targetPathNodeId = spawner?.targetPathNodeId ?? '';
    if (!targetPathNodeId) {
      const fallbackNode = Object.values(graph.nodes).find(
        (n) => n.instanceId === spawnerIdOrInstanceId
      );
      if (!fallbackNode) return null;
      targetPathNodeId = fallbackNode.id;
    }

    const node = graph.nodes[targetPathNodeId];
    if (!node) return null;

    const dims: Vector3Tuple = spawner?.partDimensionsMm ?? [280, 220, 160];
    const halfLen = dims[0] * 0.5;
    const spawnPosMm = Math.min(node.arcLengthMm * 0.4, halfLen + 20);

    // Check entry clearance so manual clicks never overlap an existing box
    for (const existing of this.items) {
      if (existing.grippedByKey || existing.worldPoseOverride) continue;
      if (existing.pathNodeId !== targetPathNodeId) continue;
      const minAllowed = spawnPosMm + halfLen + existing.dimensionsMm[0] * 0.5 + ACCUMULATION_GAP_MM;
      if (existing.distanceMm < minAllowed) {
        return null;
      }
    }

    const serial = this.serialCounter++;
    const colorHex =
      spawner?.partColorHex || PALETTE_COLORS[(serial - 1) % PALETTE_COLORS.length];

    const created: RuntimeFlowItem = {
      id: `item-${serial}`,
      pathNodeId: targetPathNodeId,
      distanceMm: spawnPosMm,
      prevDistanceMm: spawnPosMm,
      currentSpeedMmPerSec: 0,
      shape: spawner?.partShape ?? 'carton',
      customComponentId: spawner?.customComponentId,
      dimensionsMm: [...dims] as Vector3Tuple,
      colorHex,
      isAccumulated: false,
      serialNumber: serial,
    };
    this.items.push(created);

    if (spawner) {
      const nextCount = (this.spawnerCounts.get(spawner.id) ?? 0) + 1;
      this.spawnerCounts.set(spawner.id, nextCount);
    }

    return created;
  }

  private syncWorldSamplers(
    graph: TransportGraph,
    instances: SceneNodeInstance[],
    bufferView: BinaryIpcBufferView
  ): Map<UUID, SceneNodeInstance> {
    const instMap = new Map(instances.map((i) => [i.id, i]));
    const activeNodeIds = new Set<UUID>();

    for (const node of Object.values(graph.nodes)) {
      const inst = instMap.get(node.instanceId);
      if (!inst || !inst.visible) continue;
      activeNodeIds.add(node.id);

      const deckSlot = this.turntableAngleSlotByInst.get(inst.id);
      const rawDeckAngle =
        deckSlot !== undefined && deckSlot >= 0
          ? bufferView.readFloat32(deckSlot)
          : 0;
      const quantizedDeckAngle = Math.round(rawDeckAngle * 20) / 20;

      const sig = `${inst.transform.position.join(',')}|${inst.transform.rotationDeg.join(
        ','
      )}|${inst.transform.scale.join(',')}|${node.interpolation}|${quantizedDeckAngle}|${node.localWaypoints
        .map((w) => w.join(','))
        .join(';')}`;

      const cached = this.samplerCache.get(node.id);
      if (!cached || cached.signature !== sig) {
        const table = buildWorldPathSampleTable(node, inst, quantizedDeckAngle);
        this.samplerCache.set(node.id, { signature: sig, table });
      }
    }

    for (const key of this.samplerCache.keys()) {
      if (!activeNodeIds.has(key)) this.samplerCache.delete(key);
    }
    if (this.items.some((it) => !activeNodeIds.has(it.pathNodeId))) {
      this.items = this.items.filter((it) => activeNodeIds.has(it.pathNodeId));
    }

    return instMap;
  }

  /**
   * Zero-parallax 3D camera-ray to elevated conveyor spline closest-point solver.
   * Snaps accurately to any straight, curved, inclined, or rotated conveyor belt at any elevation!
   */
  public findClosestBeltPointFromRay(params: {
    rayOrigin: Vector3Tuple;
    rayDirection: Vector3Tuple;
    graph: TransportGraph;
    instances: SceneNodeInstance[];
    componentLibrary: ComponentDefinition[];
    bindings: PlcTagBinding[];
    bufferView: BinaryIpcBufferView;
    maxCaptureRadiusMeters?: number;
  }): BeltDropHitResult | null {
    const {
      rayOrigin,
      rayDirection,
      graph,
      instances,
      componentLibrary,
      bindings,
      bufferView,
      maxCaptureRadiusMeters = 0.78,
    } = params;

    this.ensureLookupsSynced(instances, componentLibrary, bindings);
    this.syncWorldSamplers(graph, instances, bufferView);

    const [ox, oy, oz] = rayOrigin;
    const dLen = Math.hypot(rayDirection[0], rayDirection[1], rayDirection[2]);
    if (dLen < 1e-8) return null;
    const dx = rayDirection[0] / dLen;
    const dy = rayDirection[1] / dLen;
    const dz = rayDirection[2] / dLen;

    const maxSq = maxCaptureRadiusMeters * maxCaptureRadiusMeters;
    let bestHit: {
      lut: WorldPathSampleTable;
      distanceMm: number;
      distSq: number;
      rayT: number;
    } | null = null;

    for (const { table: lut } of this.samplerCache.values()) {
      if (lut.sampleCount < 2) continue;
      for (let i = 0; i < lut.sampleCount - 1; i++) {
        const i0 = i * 3;
        const i1 = (i + 1) * 3;
        const res = closestDistanceRayToSegment(
          ox,
          oy,
          oz,
          dx,
          dy,
          dz,
          lut.positions[i0],
          lut.positions[i0 + 1],
          lut.positions[i0 + 2],
          lut.positions[i1],
          lut.positions[i1 + 1],
          lut.positions[i1 + 2]
        );
        if (res.distSq <= maxSq) {
          if (
            !bestHit ||
            res.distSq < bestHit.distSq - 1e-6 ||
            (Math.abs(res.distSq - bestHit.distSq) <= 1e-6 && res.rayT < bestHit.rayT)
          ) {
            const segDistMm =
              lut.distancesMm[i] +
              res.segU * (lut.distancesMm[i + 1] - lut.distancesMm[i]);
            bestHit = {
              lut,
              distanceMm: segDistMm,
              distSq: res.distSq,
              rayT: res.rayT,
            };
          }
        }
      }
    }

    if (!bestHit) return null;

    sampleWorldPathPose(
      bestHit.lut,
      bestHit.distanceMm,
      _hitSamplePos,
      _hitSampleQuat
    );

    return {
      pathNodeId: bestHit.lut.nodeId,
      instanceId: bestHit.lut.instanceId,
      distanceMm: Number(bestHit.distanceMm.toFixed(1)),
      worldPoint: [_hitSamplePos.x, _hitSamplePos.y, _hitSamplePos.z],
      worldQuaternion: [
        _hitSampleQuat.x,
        _hitSampleQuat.y,
        _hitSampleQuat.z,
        _hitSampleQuat.w,
      ],
      rayDistanceMeters: Math.sqrt(bestHit.distSq),
    };
  }

  /**
   * Places a test workpiece directly at any millimeter offset along a conveyor spline.
   * Works in STOPPED, PAUSED, and RUNNING states, automatically nudging into a clean queue
   * if dropped on top of an existing item, and immediately evaluating PE/PX sensors!
   */
  public placeWorkpieceOnPath(params: {
    graph: TransportGraph;
    instances: SceneNodeInstance[];
    componentLibrary: ComponentDefinition[];
    bindings: PlcTagBinding[];
    bufferView: BinaryIpcBufferView;
    pathNodeId: UUID;
    distanceMm: number;
    shape: WorkpieceShapeType;
    dimensionsMm: Vector3Tuple;
    colorHex: string;
    customComponentId?: UUID;
  }): RuntimeFlowItem | null {
    const {
      graph,
      instances,
      componentLibrary,
      bindings,
      bufferView,
      pathNodeId,
      distanceMm,
      shape,
      dimensionsMm,
      colorHex,
      customComponentId,
    } = params;

    const node = graph.nodes[pathNodeId];
    if (!node) return null;

    this.ensureLookupsSynced(instances, componentLibrary, bindings);
    this.syncWorldSamplers(graph, instances, bufferView);

    const lut = this.samplerCache.get(pathNodeId)?.table;
    const arcLenMm = lut?.arcLengthMm ?? node.arcLengthMm;
    const halfLen = dimensionsMm[0] * 0.5;
    const minPosMm = Math.min(arcLenMm * 0.5, halfLen + 12);
    const maxPosMm = Math.max(minPosMm, arcLenMm - halfLen - 16);
    const baseTargetMm = Math.min(maxPosMm, Math.max(minPosMm, distanceMm));

    const isClearAt = (candMm: number): boolean => {
      for (const existing of this.items) {
        if (existing.grippedByKey || existing.worldPoseOverride) continue;
        if (existing.pathNodeId !== pathNodeId) continue;
        const reqSpacing =
          halfLen + existing.dimensionsMm[0] * 0.5 + ACCUMULATION_GAP_MM * 0.85;
        if (Math.abs(existing.distanceMm - candMm) < reqSpacing) {
          return false;
        }
      }
      return true;
    };

    let resolvedMm: number | null = null;
    if (isClearAt(baseTargetMm)) {
      resolvedMm = baseTargetMm;
    } else {
      // Search upstream & downstream in 45mm increments so rapid drops stack cleanly!
      for (let stepMm = 45; stepMm <= arcLenMm; stepMm += 45) {
        const upstream = baseTargetMm - stepMm;
        if (upstream >= minPosMm && isClearAt(upstream)) {
          resolvedMm = upstream;
          break;
        }
        const downstream = baseTargetMm + stepMm;
        if (downstream <= maxPosMm && isClearAt(downstream)) {
          resolvedMm = downstream;
          break;
        }
      }
    }

    if (resolvedMm === null) return null;

    const serial = this.serialCounter++;
    const created: RuntimeFlowItem = {
      id: `item-${serial}`,
      pathNodeId,
      distanceMm: Number(resolvedMm.toFixed(1)),
      prevDistanceMm: Number(resolvedMm.toFixed(1)),
      currentSpeedMmPerSec: 0,
      shape,
      customComponentId,
      dimensionsMm: [...dimensionsMm] as Vector3Tuple,
      colorHex,
      isAccumulated: false,
      serialNumber: serial,
    };

    this.items.push(created);
    this.evaluatePathSensors(graph, bufferView);
    return created;
  }

  private evaluatePathSensors(
    graph: TransportGraph,
    bufferView: BinaryIpcBufferView
  ): void {
    for (const sensor of graph.sensors) {
      const halfWindowMm =
        sensor.detectionRadiusMm ??
        (sensor.sensorType === 'photoelectric' ? 18 : 42);
      const sMin = sensor.offsetMm - halfWindowMm;
      const sMax = sensor.offsetMm + halfWindowMm;

      let triggered = false;
      for (let i = 0; i < this.items.length; i++) {
        const it = this.items[i];
        if (it.grippedByKey || it.worldPoseOverride) continue;
        if (it.pathNodeId !== sensor.pathNodeId) continue;
        const halfBox = it.dimensionsMm[0] * 0.5;
        const sweptRear = Math.min(it.prevDistanceMm, it.distanceMm) - halfBox;
        const sweptFront = Math.max(it.prevDistanceMm, it.distanceMm) + halfBox;
        if (sweptFront >= sMin && sweptRear <= sMax) {
          triggered = true;
          break;
        }
      }

      this.sensorStates.set(sensor.id, triggered);
      if (sensor.outputBoolSlot >= 0) {
        bufferView.writeSimToPlcBool(sensor.outputBoolSlot, triggered);
      }
    }
  }

  private ensureLookupsSynced(
    instances: SceneNodeInstance[],
    componentLibrary: ComponentDefinition[],
    bindings: PlcTagBinding[]
  ): void {
    const sig = `${instances.length}:${componentLibrary.length}:${bindings.length}:${bindings
      .map((b) => `${b.instanceId}.${b.componentSignalKey}=${b.bufferSlotIndex}`)
      .join('|')}`;
    if (sig === this.cachedConfigSignature) return;
    this.cachedConfigSignature = sig;

    this.beltDriveMap.clear();
    this.axisLookupMap.clear();
    this.turntableAngleSlotByInst.clear();
    const prevGrippers = new Map(this.gripperControllers);
    this.gripperControllers.clear();

    const compMap = new Map(componentLibrary.map((c) => [c.id, c]));
    const slotMap = new Map<string, number>();
    for (const b of bindings) {
      slotMap.set(`${b.instanceId}::${b.componentSignalKey}`, b.bufferSlotIndex);
    }
    const slotOf = (instId: UUID, nodeName: string, suffix: string): number =>
      slotMap.get(`${instId}::${makeNodeSignalKey(nodeName, suffix)}`) ?? -1;

    for (const inst of instances) {
      const comp = compMap.get(inst.componentId);
      if (!comp) continue;

      const allCompRoles = Object.values(comp.nodeRoles);
      const hasVacuumGripperOnComp = allCompRoles.some(
        (r) => r.role === 'VacuumGripper'
      );

      for (const role of allCompRoles) {
        if (role.role === 'VisualEffect' && role.effectType === 'uv-scroll') {
          const runBitSlot = slotOf(inst.id, role.nodeName, 'DO_BeltRun');
          const actualRpmSlot = slotOf(inst.id, role.nodeName, 'AI_ActualBeltRpm');
          const cmdRpmSlot = slotOf(inst.id, role.nodeName, 'AO_BeltSpeedRpm');

          this.beltDriveMap.set(inst.id, {
            runBitSlot,
            actualRpmSlot,
            cmdRpmSlot,
            nominalRpm: Math.max(1, role.nominalRpm ?? 60),
            fallbackRampedRpm: 0,
          });
        } else if (role.role === 'LinearAxis') {
          const isServo = role.behavior?.presetType === 'ServoPositioning';
          const posRealSlot = slotOf(
            inst.id,
            role.nodeName,
            isServo ? 'AI_ActualPosMm' : 'AI_StrokeMm'
          );
          const reedExtBoolSlot = slotOf(inst.id, role.nodeName, 'DI_ReedExtended');
          const doExtBoolSlot = slotOf(inst.id, role.nodeName, 'DO_Extend');

          this.axisLookupMap.set(`${inst.id}::${role.nodeName}`, {
            posRealSlot,
            reedExtBoolSlot,
            doExtBoolSlot,
            minLimitMm: Math.min(role.minLimitMm, role.maxLimitMm),
            isPneumaticStopper: !isServo && !hasVacuumGripperOnComp,
          });
        } else if (role.role === 'RotaryAxis') {
          const angleSlot = slotOf(
            inst.id,
            role.nodeName,
            role.mode === 'continuous' ? 'AI_ActualRpm' : 'AI_ActualAngleDeg'
          );
          this.axisLookupMap.set(`${inst.id}::${role.nodeName}`, {
            posRealSlot: angleSlot,
            reedExtBoolSlot: -1,
            doExtBoolSlot: -1,
            minLimitMm: 0,
            isPneumaticStopper: false,
          });

          if (
            role.mode === 'bounded' &&
            Math.abs(role.axis[1]) > 0.8 &&
            angleSlot >= 0
          ) {
            this.turntableAngleSlotByInst.set(inst.id, angleSlot);
          }
        } else if (role.role === 'VacuumGripper') {
          const chainOrdered: Array<{
            role: LinearAxisRole | RotaryAxisRole;
            actualSlot: number;
          }> = [];
          const visitedAnc = new Set<string>();
          let cursorName: string | undefined = role.parentNodeName;
          while (cursorName && !visitedAnc.has(cursorName)) {
            visitedAnc.add(cursorName);
            const anc: SubMeshRoleAssignment | undefined = comp.nodeRoles[cursorName];
            if (!anc) break;
            if (anc.role === 'LinearAxis') {
              const isServo = anc.behavior?.presetType === 'ServoPositioning';
              chainOrdered.unshift({
                role: anc,
                actualSlot: slotOf(
                  inst.id,
                  anc.nodeName,
                  isServo ? 'AI_ActualPosMm' : 'AI_StrokeMm'
                ),
              });
              cursorName = anc.parentNodeName;
            } else if (anc.role === 'RotaryAxis') {
              chainOrdered.unshift({
                role: anc,
                actualSlot: slotOf(
                  inst.id,
                  anc.nodeName,
                  anc.mode === 'continuous' ? 'AI_ActualRpm' : 'AI_ActualAngleDeg'
                ),
              });
              cursorName = anc.parentNodeName;
            } else {
              break;
            }
          }

          let verticalRole: LinearAxisRole | null = null;
          let traverseRole: LinearAxisRole | null = null;

          for (const entry of chainOrdered) {
            if (entry.role.role === 'LinearAxis') {
              if (Math.abs(entry.role.axis[1]) > 0.65 && !verticalRole) {
                verticalRole = entry.role;
              } else if (Math.abs(entry.role.axis[1]) <= 0.65 && !traverseRole) {
                traverseRole = entry.role;
              }
            }
          }
          if (!verticalRole || !traverseRole) {
            for (const cand of allCompRoles) {
              if (cand.role !== 'LinearAxis') continue;
              if (Math.abs(cand.axis[1]) > 0.65 && !verticalRole) {
                verticalRole = cand;
              } else if (Math.abs(cand.axis[1]) <= 0.65 && !traverseRole) {
                traverseRole = cand;
              }
            }
          }

          const gKey = `${inst.id}::${role.nodeName}`;
          const prevCtrl = prevGrippers.get(gKey);
          const vNode = verticalRole?.nodeName ?? null;
          const tNode = traverseRole?.nodeName ?? null;
          const vIsServo = verticalRole?.behavior?.presetType === 'ServoPositioning';

          this.gripperControllers.set(gKey, {
            key: gKey,
            instanceId: inst.id,
            nodeName: role.nodeName,
            role,
            chainRoles: chainOrdered,
            doAutoCycleSlot: slotOf(inst.id, role.nodeName, 'DO_AutoCycle'),
            doVacuumOnSlot: slotOf(inst.id, role.nodeName, 'DO_VacuumOn'),
            aoPlacePosMmSlot: slotOf(inst.id, role.nodeName, 'AO_PlacePosMm'),
            diPartPresentSlot: slotOf(inst.id, role.nodeName, 'DI_PartPresent'),
            diPartGrippedSlot: slotOf(inst.id, role.nodeName, 'DI_PartGripped'),
            verticalAxisNodeName: vNode,
            verticalAxisRole: verticalRole,
            verticalDoExtendSlot: vNode ? slotOf(inst.id, vNode, 'DO_Extend') : -1,
            verticalDoRetractSlot: vNode ? slotOf(inst.id, vNode, 'DO_Retract') : -1,
            verticalStrokeSlot: vNode
              ? slotOf(inst.id, vNode, vIsServo ? 'AI_ActualPosMm' : 'AI_StrokeMm')
              : -1,
            verticalReedExtSlot: vNode ? slotOf(inst.id, vNode, 'DI_ReedExtended') : -1,
            verticalReedRetSlot: vNode
              ? slotOf(inst.id, vNode, 'DI_ReedRetracted')
              : -1,
            traverseAxisNodeName: tNode,
            traverseAxisRole: traverseRole,
            traverseAoTargetSlot: tNode
              ? slotOf(inst.id, tNode, 'AO_TargetPosMm')
              : -1,
            traverseActualPosSlot: tNode
              ? slotOf(
                  inst.id,
                  tNode,
                  traverseRole?.behavior?.presetType === 'ServoPositioning'
                    ? 'AI_ActualPosMm'
                    : 'AI_StrokeMm'
                )
              : -1,
            traverseInPosSlot: tNode ? slotOf(inst.id, tNode, 'DI_InPosition') : -1,
            autoPhase: prevCtrl?.autoPhase ?? 'WAIT_PART',
            phaseTimerSec: prevCtrl?.phaseTimerSec ?? 0,
            autoVacuumCmd: prevCtrl?.autoVacuumCmd ?? false,
            wasAutoCycleActive: prevCtrl?.wasAutoCycleActive ?? false,
            grippedItemId: prevCtrl?.grippedItemId ?? null,
            gripRelQuat: prevCtrl?.gripRelQuat ?? new THREE.Quaternion(),
            headlessTraversePosMm:
              prevCtrl?.headlessTraversePosMm ?? (traverseRole?.initialPosMm ?? 0),
            headlessTraverseVelMmS: prevCtrl?.headlessTraverseVelMmS ?? 0,
            headlessVerticalPosMm:
              prevCtrl?.headlessVerticalPosMm ?? (verticalRole?.initialPosMm ?? 0),
          });
        }
      }
    }
  }

  public step(params: {
    graph: TransportGraph;
    instances: SceneNodeInstance[];
    componentLibrary: ComponentDefinition[];
    bindings: PlcTagBinding[];
    bufferView: BinaryIpcBufferView;
    runState: SimulationRunState;
    simSpeedMultiplier: number;
    rawDeltaSec: number;
  }): void {
    const {
      graph,
      instances,
      componentLibrary,
      bindings,
      bufferView,
      runState,
      simSpeedMultiplier,
      rawDeltaSec,
    } = params;

    this.ensureLookupsSynced(instances, componentLibrary, bindings);
    const instMap = this.syncWorldSamplers(graph, instances, bufferView);

    // Reset runtime flow ONLY on the transition into STOPPED so manually dropped test workpieces
    // placed while STOPPED remain staged on the belt and immediately trigger PE/PX sensors!
    if (runState === 'STOPPED') {
      if (!this.wasStopped) {
        this.clearAllFlowItems(bufferView, graph);
        for (const drive of this.beltDriveMap.values()) {
          drive.fallbackRampedRpm = 0;
        }
        this.wasStopped = true;
      }
      this.evaluatePathSensors(graph, bufferView);
      this.stepAxisEncoders(graph, bufferView, 0);
      return;
    }

    this.wasStopped = false;
    const dt =
      runState === 'RUNNING'
        ? Math.min(Math.max(rawDeltaSec, 0), 0.05) * Math.max(0.05, simSpeedMultiplier)
        : 0;

    if (dt <= 0) {
      this.evaluatePathSensors(graph, bufferView);
      this.stepAxisEncoders(graph, bufferView, 0);
      return;
    }

    // 2. Compute belt linear speeds (mm/s) per TransportPathNode
    const travelPerRevByInst = new Map<UUID, number>();
    for (const enc of graph.encoders) {
      if (enc.sourceKind === 'transport-path') {
        travelPerRevByInst.set(
          enc.targetInstanceId,
          Math.max(10, enc.travelMmPerRevolution || 471.24)
        );
      }
    }

    const beltSpeedByNode = new Map<UUID, number>();
    for (const node of Object.values(graph.nodes)) {
      const drive = this.beltDriveMap.get(node.instanceId);
      if (drive) {
        const beltRun =
          drive.runBitSlot >= 0 ? bufferView.readPlcToSimBool(drive.runBitSlot) : true;
        const cmdRpm =
          drive.cmdRpmSlot >= 0
            ? Math.max(0, bufferView.readFloat32(drive.cmdRpmSlot))
            : drive.nominalRpm;
        const targetRpm = beltRun ? cmdRpm : 0;

        // Smooth ramp fallback so headless and 3D viewport share identical RPM physics
        const diff = targetRpm - drive.fallbackRampedRpm;
        const maxStep = 260 * dt;
        drive.fallbackRampedRpm =
          Math.abs(diff) <= maxStep
            ? targetRpm
            : drive.fallbackRampedRpm + Math.sign(diff) * maxStep;

        const reportedRpm =
          drive.actualRpmSlot >= 0 ? bufferView.readFloat32(drive.actualRpmSlot) : 0;
        const effectiveRpm =
          Math.abs(reportedRpm) > 0.05 ? reportedRpm : drive.fallbackRampedRpm;

        const mmPerRev = travelPerRevByInst.get(node.instanceId) ?? 471.24;
        beltSpeedByNode.set(node.id, Math.max(0, (effectiveRpm / 60) * mmPerRev));
      } else {
        // Passive transfer frame / turntable deck
        const deckSlot = this.turntableAngleSlotByInst.get(node.instanceId);
        if (deckSlot !== undefined) {
          // Pause belt rollers while turntable is actively rotating between ports
          const currDeg = bufferView.readFloat32(deckSlot);
          const prevKey = `tt-prev-${node.instanceId}`;
          const prevDeg = this.axisPrevPos.get(prevKey) ?? currDeg;
          const rotSpeedDegPerSec = Math.abs(currDeg - prevDeg) / Math.max(1e-4, dt);
          this.axisPrevPos.set(prevKey, currDeg);
          beltSpeedByNode.set(
            node.id,
            rotSpeedDegPerSec > 2.5 ? 0 : node.nominalSpeedMmPerSec
          );
        } else {
          beltSpeedByNode.set(node.id, node.nominalSpeedMmPerSec);
        }
      }
    }

    // 3. Resolve live aligned downstream edge per path node (handles rotating 90° Turntables!)
    const activeNextNodeMap = new Map<UUID, UUID>();
    const allNodes = Object.values(graph.nodes);

    for (const edge of graph.edges) {
      const lutFrom = this.samplerCache.get(edge.fromPathNodeId)?.table;
      const lutTo = this.samplerCache.get(edge.toPathNodeId)?.table;
      if (!lutFrom || !lutTo) continue;

      const worldGapM = lutFrom.worldEnd.distanceTo(lutTo.worldStart);
      const tanAlign = lutFrom.endTangent.dot(lutTo.startTangent);
      if (worldGapM <= 0.16 && tanAlign >= 0.2) {
        activeNextNodeMap.set(edge.fromPathNodeId, edge.toPathNodeId);
      }
    }

    // Dynamic turntable exit matching when rotated to ±90° North/South branch conveyors
    for (const nodeA of allNodes) {
      if (activeNextNodeMap.has(nodeA.id)) continue;
      if (!this.turntableAngleSlotByInst.has(nodeA.instanceId)) continue;
      const lutA = this.samplerCache.get(nodeA.id)?.table;
      if (!lutA) continue;

      for (const nodeB of allNodes) {
        if (nodeB.instanceId === nodeA.instanceId) continue;
        const lutB = this.samplerCache.get(nodeB.id)?.table;
        if (!lutB) continue;
        if (
          lutA.worldEnd.distanceTo(lutB.worldStart) <= 0.16 &&
          lutA.endTangent.dot(lutB.startTangent) >= 0.25
        ) {
          activeNextNodeMap.set(nodeA.id, nodeB.id);
          break;
        }
      }
    }

    // 4. Detect active Stopper Barriers (both inline Stopper gates & over-belt placed cylinders)
    const stopperOffsetsByNode = new Map<UUID, number[]>();
    const pushBarrier = (nodeId: UUID, offsetMm: number) => {
      let arr = stopperOffsetsByNode.get(nodeId);
      if (!arr) {
        arr = [];
        stopperOffsetsByNode.set(nodeId, arr);
      }
      arr.push(offsetMm);
    };

    for (const [axisKey, lookup] of this.axisLookupMap.entries()) {
      if (!lookup.isPneumaticStopper) continue;
      const [instId] = axisKey.split('::');
      const strokeMm =
        lookup.posRealSlot >= 0
          ? bufferView.readFloat32(lookup.posRealSlot)
          : lookup.minLimitMm;
      const reedExt =
        lookup.reedExtBoolSlot >= 0
          ? bufferView.readSimToPlcBool(lookup.reedExtBoolSlot)
          : false;
      const doExt =
        lookup.doExtBoolSlot >= 0
          ? bufferView.readPlcToSimBool(lookup.doExtBoolSlot)
          : false;

      const engaged =
        reedExt ||
        strokeMm > lookup.minLimitMm + 18 ||
        (doExt && strokeMm > lookup.minLimitMm + 6);
      if (!engaged) continue;

      const ownNodes = allNodes.filter((n) => n.instanceId === instId);
      if (ownNodes.length > 0) {
        for (const ownNode of ownNodes) {
          const lut = this.samplerCache.get(ownNode.id)?.table;
          const lenMm = lut?.arcLengthMm ?? ownNode.arcLengthMm;
          pushBarrier(ownNode.id, lenMm * 0.5);
        }
      } else {
        // Spatial over-belt stopper projection
        const stopperInst = instMap.get(instId);
        if (!stopperInst || !stopperInst.visible) continue;
        _tmpVecA.set(...stopperInst.transform.position);
        for (const candidateNode of allNodes) {
          const lut = this.samplerCache.get(candidateNode.id)?.table;
          if (!lut) continue;
          const proj = projectPointToPathDistanceMm(lut, _tmpVecA);
          if (proj.lateralDistMeters <= 0.28 && proj.verticalDistMeters <= 0.95) {
            pushBarrier(candidateNode.id, proj.distanceMm);
          }
        }
      }
    }

    // 4b. Step 3D Vacuum Grippers, Auto Pick & Place Sequencers & Pick-Zone Centering Stops
    if (this.gripperControllers.size > 0) {
      this.stepVacuumGrippers(
        instMap,
        allNodes,
        pushBarrier,
        bufferView,
        dt
      );
    }

    // 5. Step Part Spawners (`PartSource` — ON/OFF gated interval auto-feed + PLC rising-edge trigger)
    for (const spawner of graph.spawners) {
      const maxAllowed = spawner.maxActiveItems ?? 45;
      const autoFeedEnabled =
        spawner.enableBoolSlot !== undefined && spawner.enableBoolSlot >= 0
          ? bufferView.readPlcToSimBool(spawner.enableBoolSlot)
          : spawner.enabled !== false;

      const triggerHigh =
        spawner.triggerBoolSlot !== undefined && spawner.triggerBoolSlot >= 0
          ? bufferView.readPlcToSimBool(spawner.triggerBoolSlot)
          : false;
      const prevTrig = this.spawnerPrevTrigger.get(spawner.id) ?? false;
      this.spawnerPrevTrigger.set(spawner.id, triggerHigh);
      const risingEdge = triggerHigh && !prevTrig;

      let shouldAttemptSpawn = risingEdge;
      let timerDue = false;
      if (!autoFeedEnabled) {
        // Hold timer reset while Auto Feed is OFF so re-enabling feeds cleanly without burst backlog
        this.spawnerTimers.delete(spawner.id);
      } else if (spawner.mode === 'interval' && this.items.length < maxAllowed) {
        const prevTimer = this.spawnerTimers.get(spawner.id);
        // Spawn first box quickly (0.35s after Play / Enable) so user sees immediate motion!
        const elapsed = (prevTimer ?? Math.max(0, spawner.intervalSec - 0.35)) + dt;
        const period = Math.max(0.4, spawner.intervalSec || 2.2);
        if (elapsed >= period) {
          shouldAttemptSpawn = true;
          timerDue = true;
          this.spawnerTimers.set(spawner.id, period);
        } else {
          this.spawnerTimers.set(spawner.id, elapsed);
        }
      }

      if (shouldAttemptSpawn && this.items.length < maxAllowed) {
        const spawned = this.spawnSinglePartNow(graph, spawner.id);
        if (spawned && timerDue) {
          this.spawnerTimers.set(spawner.id, 0);
        }
      }

      if (spawner.spawnedCountDintSlot !== undefined && spawner.spawnedCountDintSlot >= 0) {
        bufferView.writeDint32(
          spawner.spawnedCountDintSlot,
          this.spawnerCounts.get(spawner.id) ?? 0
        );
      }
    }

    // 6. Group items per path node (sorted front-to-back) & order nodes downstream-to-upstream
    const sinkByNodeId = new Map<UUID, (typeof graph.sinks)[number]>();
    for (const sk of graph.sinks) {
      sinkByNodeId.set(sk.sourcePathNodeId, sk);
    }

    const itemsByNode = new Map<UUID, RuntimeFlowItem[]>();
    const detachedItems: RuntimeFlowItem[] = [];
    for (const item of this.items) {
      if (item.grippedByKey || item.worldPoseOverride) {
        detachedItems.push(item);
        continue;
      }
      item.prevDistanceMm = item.distanceMm;
      let list = itemsByNode.get(item.pathNodeId);
      if (!list) {
        list = [];
        itemsByNode.set(item.pathNodeId, list);
      }
      list.push(item);
    }
    for (const list of itemsByNode.values()) {
      list.sort((a, b) => b.distanceMm - a.distanceMm);
    }

    // Compute downstream-first node evaluation order
    const orderedNodeIds: UUID[] = [];
    const visitedNodes = new Set<UUID>();
    const visitDownstreamFirst = (nodeId: UUID) => {
      if (visitedNodes.has(nodeId)) return;
      visitedNodes.add(nodeId);
      const nextId = activeNextNodeMap.get(nodeId);
      if (nextId) visitDownstreamFirst(nextId);
      orderedNodeIds.push(nodeId);
    };
    for (const node of allNodes) {
      visitDownstreamFirst(node.id);
    }

    // 7. Overdamped Zero-Jitter 1D Accumulation & Spline Handoff Solver
    const survivingItems: RuntimeFlowItem[] = [];

    for (const nodeId of orderedNodeIds) {
      const node = graph.nodes[nodeId];
      if (!node) continue;
      const list = itemsByNode.get(nodeId);
      if (!list || list.length === 0) continue;

      const lut = this.samplerCache.get(nodeId)?.table;
      const nodeLenMm = lut?.arcLengthMm ?? node.arcLengthMm;
      const vBelt = beltSpeedByNode.get(nodeId) ?? node.nominalSpeedMmPerSec;
      const nextNodeId = activeNextNodeMap.get(nodeId);
      const sink = sinkByNodeId.get(nodeId);
      const nodeBarriers = stopperOffsetsByNode.get(nodeId);

      for (let idx = 0; idx < list.length; idx++) {
        const item = list[idx];
        const halfLen = item.dimensionsMm[0] * 0.5;
        const frontBumperMm = item.distanceMm + halfLen;

        let minClearanceMm = Infinity;

        // (a) Check item immediately ahead on the same path node
        if (idx > 0) {
          const leader = list[idx - 1];
          const leaderRearMm = leader.distanceMm - leader.dimensionsMm[0] * 0.5;
          const gap = leaderRearMm - frontBumperMm - ACCUMULATION_GAP_MM;
          if (gap < minClearanceMm) minClearanceMm = gap;
        }

        // (b) Check active Pneumatic Stopper barriers on this path node
        if (nodeBarriers) {
          for (let b = 0; b < nodeBarriers.length; b++) {
            const stopMm = nodeBarriers[b];
            // Only block items whose front bumper has not yet cleared the blade
            if (frontBumperMm <= stopMm + 12) {
              const gap = stopMm - frontBumperMm - STOPPER_CLEARANCE_MM;
              if (gap < minClearanceMm) minClearanceMm = gap;
            }
          }
        }

        // (c) Lookahead across connected downstream path nodes (up to LOOKAHEAD_WINDOW_MM)
        if (idx === 0) {
          if (nextNodeId) {
            let distOffsetMm = nodeLenMm - item.distanceMm;
            let cursorNodeId: UUID | undefined = nextNodeId;
            let hops = 0;

            while (cursorNodeId && distOffsetMm <= LOOKAHEAD_WINDOW_MM && hops < 4) {
              hops++;
              const downNode = graph.nodes[cursorNodeId];
              if (!downNode) break;
              const downLut = this.samplerCache.get(cursorNodeId)?.table;
              const downLenMm = downLut?.arcLengthMm ?? downNode.arcLengthMm;

              // Check downstream stopper barriers
              const downBarriers = stopperOffsetsByNode.get(cursorNodeId);
              if (downBarriers) {
                for (const bMm of downBarriers) {
                  const gap = distOffsetMm + bMm - halfLen - STOPPER_CLEARANCE_MM;
                  if (gap < minClearanceMm) minClearanceMm = gap;
                }
              }

              // Check rear-most item on downstream conveyor
              const downItems = itemsByNode.get(cursorNodeId);
              if (downItems && downItems.length > 0) {
                const tailItem = downItems[downItems.length - 1];
                const tailRearMm =
                  tailItem.distanceMm - tailItem.dimensionsMm[0] * 0.5;
                const gap =
                  distOffsetMm + tailRearMm - halfLen - ACCUMULATION_GAP_MM;
                if (gap < minClearanceMm) minClearanceMm = gap;
                break;
              }

              // Check if downstream node itself ends at a dead-end without a sink
              const nextHop = activeNextNodeMap.get(cursorNodeId);
              const downHasSink = sinkByNodeId.has(cursorNodeId);
              if (!nextHop && !downHasSink) {
                const gap = distOffsetMm + downLenMm - halfLen - 18;
                if (gap < minClearanceMm) minClearanceMm = gap;
                break;
              }

              distOffsetMm += downLenMm;
              cursorNodeId = nextHop;
            }
          } else if (!sink) {
            // Unconnected belt end (or turntable gate interlock): stop cleanly at end guard
            const endGuardGap = nodeLenMm - frontBumperMm - 18;
            if (endGuardGap < minClearanceMm) minClearanceMm = endGuardGap;
          }
        }

        // Overdamped kinematic velocity profile — zero overshoot, zero jitter!
        const safeClearMm = Math.max(0, minClearanceMm);
        if (safeClearMm <= 0.15) {
          item.currentSpeedMmPerSec = 0;
          item.isAccumulated = true;
        } else {
          const brakingSpeed = Math.min(
            Math.sqrt(2 * DECEL_MM_S2 * safeClearMm),
            11.5 * safeClearMm
          );
          const desiredSpeed = Math.min(vBelt, brakingSpeed);
          const dv = desiredSpeed - item.currentSpeedMmPerSec;
          const maxDv = (dv < 0 ? DECEL_MM_S2 : ACCEL_MM_S2) * dt;

          item.currentSpeedMmPerSec =
            Math.abs(dv) <= maxDv
              ? desiredSpeed
              : item.currentSpeedMmPerSec + Math.sign(dv) * maxDv;

          const stepMm = Math.min(item.currentSpeedMmPerSec * dt, safeClearMm);
          item.distanceMm += stepMm;
          item.isAccumulated =
            safeClearMm < 35 && item.currentSpeedMmPerSec < Math.max(25, vBelt * 0.25);
        }

        // Handoff or Sink Despawn at path end
        if (item.distanceMm >= nodeLenMm) {
          if (sink && !nextNodeId) {
            const nextSinkCount = (this.sinkCounts.get(sink.id) ?? 0) + 1;
            this.sinkCounts.set(sink.id, nextSinkCount);
            continue;
          }
          if (nextNodeId && graph.nodes[nextNodeId]) {
            const residualMm = Math.max(0, item.distanceMm - nodeLenMm);
            item.pathNodeId = nextNodeId;
            item.distanceMm = residualMm;
            item.prevDistanceMm = 0;

            let nextList = itemsByNode.get(nextNodeId);
            if (!nextList) {
              nextList = [];
              itemsByNode.set(nextNodeId, nextList);
            }
            nextList.push(item);
          } else if (sink) {
            const nextSinkCount = (this.sinkCounts.get(sink.id) ?? 0) + 1;
            this.sinkCounts.set(sink.id, nextSinkCount);
            continue;
          } else {
            item.distanceMm = Math.max(0, nodeLenMm - halfLen - 18);
            item.currentSpeedMmPerSec = 0;
            item.isAccumulated = true;
          }
        }

        survivingItems.push(item);
      }
    }

    for (let d = 0; d < detachedItems.length; d++) {
      survivingItems.push(detachedItems[d]);
    }

    this.items = survivingItems;

    // Write Sink DINT32 counters
    for (const sk of graph.sinks) {
      if (sk.countedPartsDintSlot !== undefined && sk.countedPartsDintSlot >= 0) {
        bufferView.writeDint32(sk.countedPartsDintSlot, this.sinkCounts.get(sk.id) ?? 0);
      }
    }

    // 8. Sub-Frame Swept Deterministic Path Sensors (Photoelectric & Proximity)
    this.evaluatePathSensors(graph, bufferView);

    // 9. Virtual HSC Encoders (`DINT32` Pulses + `FLOAT32` Servo Position & Velocity)
    for (const enc of graph.encoders) {
      if (enc.sourceKind === 'transport-path') {
        const pathNodeId = `${enc.targetInstanceId}::${enc.targetSubKey}`;
        const vBeltMmS = beltSpeedByNode.get(pathNodeId) ?? 0;
        const prevTravelMm = this.beltTravelAccumMm.get(enc.id) ?? 0;
        const nextTravelMm = prevTravelMm + vBeltMmS * dt;
        this.beltTravelAccumMm.set(enc.id, nextTravelMm);

        const mmPerRev = Math.max(0.01, enc.travelMmPerRevolution || 471.24);
        const ppr = Math.max(1, enc.pulsesPerRevolution || 1024);
        const rawPulses = (nextTravelMm / mmPerRev) * ppr;
        const pulsesDint = applySignedModulo(rawPulses, enc.rolloverModulo);

        const rolloverSpanMm =
          enc.rolloverModulo > 0 && enc.rolloverModulo < 2_147_483_640
            ? (enc.rolloverModulo / ppr) * mmPerRev
            : 0;
        const servoPosMm =
          rolloverSpanMm > 0 ? nextTravelMm % rolloverSpanMm : nextTravelMm;

        if (enc.cumulativePulsesDintSlot >= 0) {
          bufferView.writeDint32(enc.cumulativePulsesDintSlot, pulsesDint);
        }
        if (enc.actualPositionRealSlot >= 0) {
          bufferView.writeFloat32(enc.actualPositionRealSlot, servoPosMm);
        }
        if (enc.actualVelocityRealSlot >= 0) {
          bufferView.writeFloat32(enc.actualVelocityRealSlot, vBeltMmS);
        }
      }
    }

    this.stepAxisEncoders(graph, bufferView, dt);
  }

  private stepAxisEncoders(
    graph: TransportGraph,
    bufferView: BinaryIpcBufferView,
    dt: number
  ): void {
    for (const enc of graph.encoders) {
      if (enc.sourceKind === 'transport-path') continue;
      const lookup = this.axisLookupMap.get(
        `${enc.targetInstanceId}::${enc.targetSubKey}`
      );
      const actualPos =
        lookup && lookup.posRealSlot >= 0
          ? bufferView.readFloat32(lookup.posRealSlot)
          : 0;

      const prevPos = this.axisPrevPos.get(enc.id) ?? actualPos;
      this.axisPrevPos.set(enc.id, actualPos);

      let smoothVel = 0;
      if (dt > 1e-5) {
        const instVel = (actualPos - prevPos) / dt;
        const prevVel = this.axisSmoothVel.get(enc.id) ?? 0;
        smoothVel = Math.abs(instVel) < 0.05 ? 0 : prevVel * 0.45 + instVel * 0.55;
        this.axisSmoothVel.set(enc.id, smoothVel);
      } else {
        this.axisSmoothVel.set(enc.id, 0);
      }

      const unitsPerRev = Math.max(
        0.001,
        enc.travelMmPerRevolution || (enc.sourceKind === 'rotary-axis' ? 360 : 10)
      );
      const ppr = Math.max(1, enc.pulsesPerRevolution || 4096);
      const rawPulses = Math.round((actualPos / unitsPerRev) * ppr);
      const pulsesDint = applySignedModulo(rawPulses, enc.rolloverModulo);

      if (enc.cumulativePulsesDintSlot >= 0) {
        bufferView.writeDint32(enc.cumulativePulsesDintSlot, pulsesDint);
      }
      if (enc.actualPositionRealSlot >= 0) {
        bufferView.writeFloat32(enc.actualPositionRealSlot, actualPos);
      }
      if (enc.actualVelocityRealSlot >= 0) {
        bufferView.writeFloat32(enc.actualVelocityRealSlot, smoothVel);
      }
    }
  }

  private computeAnalyticalGripperWorldPose(
    ctrl: GripperRuntimeController,
    inst: SceneNodeInstance,
    bufferView: BinaryIpcBufferView,
    useHeadlessFallbackPos: boolean,
    outPadWorldPos: THREE.Vector3,
    outPadWorldQuat: THREE.Quaternion
  ): number {
    const restBottomY = ctrl.role.localBottomOffsetM ?? 1.095;
    outPadWorldPos.set(0, restBottomY, 0);
    _gripCompQuat.identity();

    for (let i = ctrl.chainRoles.length - 1; i >= 0; i--) {
      // Apply local-to-root or root-to-local: translations commute, rotations wrap inner child
      const entry = ctrl.chainRoles[i];
      const r = entry.role;
      if (r.role === 'LinearAxis') {
        let posMm = r.initialPosMm;
        if (useHeadlessFallbackPos) {
          if (r.nodeName === ctrl.traverseAxisNodeName) {
            posMm = ctrl.headlessTraversePosMm;
          } else if (r.nodeName === ctrl.verticalAxisNodeName) {
            posMm = ctrl.headlessVerticalPosMm;
          } else if (entry.actualSlot >= 0) {
            posMm = bufferView.readFloat32(entry.actualSlot);
          }
        } else if (entry.actualSlot >= 0) {
          posMm = bufferView.readFloat32(entry.actualSlot);
        }

        _gripAxisVec.set(r.axis[0], r.axis[1], r.axis[2]);
        if (_gripAxisVec.lengthSq() > 1e-8) {
          _gripAxisVec.normalize().multiplyScalar(posMm * 0.001);
          outPadWorldPos.add(_gripAxisVec);
        }
      } else if (r.role === 'RotaryAxis' && r.mode === 'bounded') {
        const deg =
          entry.actualSlot >= 0 ? bufferView.readFloat32(entry.actualSlot) : 0;
        _gripAxisVec.set(r.axis[0], r.axis[1], r.axis[2]);
        if (_gripAxisVec.lengthSq() > 1e-8) {
          _gripAxisVec.normalize();
          _gripRotQuat.setFromAxisAngle(_gripAxisVec, deg * DEG2RAD);
          outPadWorldPos.applyQuaternion(_gripRotQuat);
          _gripCompQuat.premultiply(_gripRotQuat);
        }
      }
    }

    const instQuat = eulerDegToQuaternion(inst.transform.rotationDeg);
    const [sx, sy, sz] = inst.transform.scale;
    const [px, py, pz] = inst.transform.position;

    outPadWorldPos.set(
      outPadWorldPos.x * sx,
      outPadWorldPos.y * sy,
      outPadWorldPos.z * sz
    );
    outPadWorldPos.applyQuaternion(instQuat);
    outPadWorldPos.set(
      outPadWorldPos.x + px,
      outPadWorldPos.y + py,
      outPadWorldPos.z + pz
    );

    outPadWorldQuat.copy(instQuat).multiply(_gripCompQuat);
    return py + restBottomY * sy;
  }

  private stepVacuumGrippers(
    instMap: Map<UUID, SceneNodeInstance>,
    allNodes: TransportPathNode[],
    pushBarrier: (nodeId: UUID, offsetMm: number) => void,
    bufferView: BinaryIpcBufferView,
    dt: number
  ): void {
    for (const ctrl of this.gripperControllers.values()) {
      const inst = instMap.get(ctrl.instanceId);
      if (!inst || !inst.visible) continue;

      const livePose = getLiveGripperCompPose(ctrl.instanceId, ctrl.nodeName);
      const isHeadless = livePose === undefined;
      const instQuat = eulerDegToQuaternion(inst.transform.rotationDeg);
      const [sx, sy, sz] = inst.transform.scale;
      const [px, py, pz] = inst.transform.position;

      const restBottomCompY =
        livePose?.restBottomYComp ?? ctrl.role.localBottomOffsetM ?? 1.095;
      const worldRestPadY = py + restBottomCompY * sy;

      // 1. Project Home Pick Station onto conveyor splines so AutoCycle centers incoming workpieces cleanly
      const autoCycleOn =
        ctrl.doAutoCycleSlot >= 0 && bufferView.readPlcToSimBool(ctrl.doAutoCycleSlot);

      if (autoCycleOn) {
        _gripHomeWorldPos.set(0, restBottomCompY * sy, 0);
        if (ctrl.traverseAxisRole) {
          const homeMm = ctrl.traverseAxisRole.initialPosMm;
          _gripAxisVec.set(...ctrl.traverseAxisRole.axis);
          if (_gripAxisVec.lengthSq() > 1e-8) {
            _gripAxisVec.normalize().multiplyScalar(homeMm * 0.001);
            _gripHomeWorldPos.x += _gripAxisVec.x * sx;
            _gripHomeWorldPos.y += _gripAxisVec.y * sy;
            _gripHomeWorldPos.z += _gripAxisVec.z * sz;
          }
        }
        _gripHomeWorldPos.applyQuaternion(instQuat);
        _gripHomeWorldPos.set(
          _gripHomeWorldPos.x + px,
          _gripHomeWorldPos.y + py,
          _gripHomeWorldPos.z + pz
        );

        let bestPickNode: TransportPathNode | null = null;
        let bestPickDistMm = 0;
        let bestPickLat = Infinity;
        for (const candNode of allNodes) {
          const lut = this.samplerCache.get(candNode.id)?.table;
          if (!lut) continue;
          const proj = projectPointToPathDistanceMm(lut, _gripHomeWorldPos);
          if (proj.lateralDistMeters <= 0.34 && proj.lateralDistMeters < bestPickLat) {
            bestPickLat = proj.lateralDistMeters;
            bestPickNode = candNode;
            bestPickDistMm = proj.distanceMm;
          }
        }

        if (bestPickNode) {
          // Center the leading non-gripped workpiece right under the suction cups at bestPickDistMm
          let leadItem: RuntimeFlowItem | null = null;
          for (let i = 0; i < this.items.length; i++) {
            const it = this.items[i];
            if (it.grippedByKey || it.worldPoseOverride) continue;
            if (it.pathNodeId !== bestPickNode.id) continue;
            if (it.distanceMm <= bestPickDistMm + 36) {
              if (!leadItem || it.distanceMm > leadItem.distanceMm) {
                leadItem = it;
              }
            }
          }
          const refHalfLen = leadItem ? leadItem.dimensionsMm[0] * 0.5 : 140;
          pushBarrier(
            bestPickNode.id,
            bestPickDistMm + refHalfLen + STOPPER_CLEARANCE_MM
          );
        }
      }

      // 2. Compute current world suction pad bottom pose
      if (livePose) {
        _gripPadWorldPos.set(
          livePose.padBottomComp[0] * sx,
          livePose.padBottomComp[1] * sy,
          livePose.padBottomComp[2] * sz
        );
        _gripPadWorldPos.applyQuaternion(instQuat);
        _gripPadWorldPos.set(
          _gripPadWorldPos.x + px,
          _gripPadWorldPos.y + py,
          _gripPadWorldPos.z + pz
        );
        _gripCompQuat.set(
          livePose.quatComp[0],
          livePose.quatComp[1],
          livePose.quatComp[2],
          livePose.quatComp[3]
        );
        _gripPadWorldQuat.copy(instQuat).multiply(_gripCompQuat);
      } else {
        this.computeAnalyticalGripperWorldPose(
          ctrl,
          inst,
          bufferView,
          true,
          _gripPadWorldPos,
          _gripPadWorldQuat
        );
      }

      // 3. Resolve currently gripped item (if any) & closest free workpiece underneath pad
      let grippedItem: RuntimeFlowItem | null = null;
      if (ctrl.grippedItemId) {
        grippedItem =
          this.items.find((it) => it.id === ctrl.grippedItemId) ?? null;
        if (!grippedItem) {
          ctrl.grippedItemId = null;
        }
      }

      const grabRadiusM = Math.max(0.04, ctrl.role.grabRadiusMm * 0.001);
      const grabTolM = Math.max(0.012, ctrl.role.grabHeightToleranceMm * 0.001);

      let candidatePickItem: RuntimeFlowItem | null = null;
      let candidateHorizDistM = Infinity;
      let candidateTopY = 0;

      for (let i = 0; i < this.items.length; i++) {
        const it = this.items[i];
        if (it.grippedByKey) continue;

        const hgtM = Math.max(0.03, it.dimensionsMm[2] * 0.001);
        let ix = 0;
        let iz = 0;
        let topY = 0;

        if (it.worldPoseOverride) {
          ix = it.worldPoseOverride.position[0];
          topY = it.worldPoseOverride.position[1] + hgtM * 0.5;
          iz = it.worldPoseOverride.position[2];
        } else {
          const lut = this.samplerCache.get(it.pathNodeId)?.table;
          if (!lut) continue;
          sampleWorldPathPose(lut, it.distanceMm, _gripItemPos, _gripItemQuat);
          ix = _gripItemPos.x;
          topY = _gripItemPos.y + hgtM + 0.004;
          iz = _gripItemPos.z;
        }

        const dx = _gripPadWorldPos.x - ix;
        const dz = _gripPadWorldPos.z - iz;
        const hDist = Math.sqrt(dx * dx + dz * dz);
        if (hDist <= grabRadiusM && hDist < candidateHorizDistM) {
          candidateHorizDistM = hDist;
          candidatePickItem = it;
          candidateTopY = topY;
        }
      }

      // Check conveyor spline directly under current pad [x, z]
      let underBeltNode: TransportPathNode | null = null;
      let underBeltDistMm = 0;
      let underBeltSurfaceY: number | null = null;
      let bestUnderBeltLat = Infinity;
      for (const candNode of allNodes) {
        const lut = this.samplerCache.get(candNode.id)?.table;
        if (!lut) continue;
        const proj = projectPointToPathDistanceMm(lut, _gripPadWorldPos);
        if (proj.lateralDistMeters <= 0.34 && proj.lateralDistMeters < bestUnderBeltLat) {
          bestUnderBeltLat = proj.lateralDistMeters;
          underBeltNode = candNode;
          underBeltDistMm = proj.distanceMm;
          sampleWorldPathPose(lut, proj.distanceMm, _tmpVecA);
          underBeltSurfaceY = _tmpVecA.y + 0.004;
        }
      }

      // 4. Publish compliant downward stroke clamp so suction cups kiss box top / belt cleanly without clipping
      let dynMaxStrokeMm: number | null = null;
      if (
        ctrl.verticalAxisRole &&
        ctrl.verticalAxisNodeName &&
        ctrl.verticalAxisRole.axis[1] < -0.5
      ) {
        const vMax = Math.max(
          ctrl.verticalAxisRole.minLimitMm,
          ctrl.verticalAxisRole.maxLimitMm
        );
        if (grippedItem) {
          const gHgtM = Math.max(0.03, grippedItem.dimensionsMm[2] * 0.001);
          const stopSurfaceY = underBeltSurfaceY ?? 0.004;
          dynMaxStrokeMm = Math.min(
            vMax,
            Math.max(0, (worldRestPadY - (stopSurfaceY + gHgtM)) * 1000)
          );
        } else if (candidatePickItem) {
          dynMaxStrokeMm = Math.min(
            vMax,
            Math.max(0, (worldRestPadY - candidateTopY) * 1000)
          );
        } else if (underBeltSurfaceY !== null) {
          dynMaxStrokeMm = Math.min(
            vMax,
            Math.max(0, (worldRestPadY - (underBeltSurfaceY + 0.018)) * 1000)
          );
        }
        setLiveAxisDynamicMaxMm(
          ctrl.instanceId,
          ctrl.verticalAxisNodeName,
          dynMaxStrokeMm
        );
      }

      // 5. Step Built-in Smart `DO_AutoCycle` Pick & Transfer Sequencer
      const homeTraverseMm = ctrl.traverseAxisRole?.initialPosMm ?? 0;
      const defaultPlaceMm = ctrl.role.placeTargetPosMm ?? 800;
      let placeTargetMm = defaultPlaceMm;
      if (ctrl.aoPlacePosMmSlot >= 0) {
        const rawPlace = bufferView.readFloat32(ctrl.aoPlacePosMmSlot);
        if (Math.abs(rawPlace) > 0.01) {
          placeTargetMm = rawPlace;
        }
      }

      let currTraverseMm = isHeadless
        ? ctrl.headlessTraversePosMm
        : ctrl.traverseActualPosSlot >= 0
          ? bufferView.readFloat32(ctrl.traverseActualPosSlot)
          : homeTraverseMm;
      let currVerticalMm = isHeadless
        ? ctrl.headlessVerticalPosMm
        : ctrl.verticalStrokeSlot >= 0
          ? bufferView.readFloat32(ctrl.verticalStrokeSlot)
          : 0;

      const vMinMm = ctrl.verticalAxisRole
        ? Math.min(ctrl.verticalAxisRole.minLimitMm, ctrl.verticalAxisRole.maxLimitMm)
        : 0;
      const vRawMaxMm = ctrl.verticalAxisRole
        ? Math.max(ctrl.verticalAxisRole.minLimitMm, ctrl.verticalAxisRole.maxLimitMm)
        : 250;
      const effectiveVMaxMm =
        dynMaxStrokeMm !== null
          ? Math.min(vRawMaxMm, Math.max(vMinMm, dynMaxStrokeMm))
          : vRawMaxMm;

      const isVerticalRetracted = Math.abs(currVerticalMm - vMinMm) <= 3.5;
      const isVerticalExtended = Math.abs(currVerticalMm - effectiveVMaxMm) <= 4.0;

      let autoTargetTraverseCmd: number | null = null;
      let autoExtendVerticalCmd: boolean | null = null;

      if (autoCycleOn) {
        ctrl.wasAutoCycleActive = true;
        ctrl.phaseTimerSec += dt;

        switch (ctrl.autoPhase) {
          case 'WAIT_PART': {
            autoTargetTraverseCmd = homeTraverseMm;
            autoExtendVerticalCmd = false;
            ctrl.autoVacuumCmd = false;

            const atHome = Math.abs(currTraverseMm - homeTraverseMm) <= 3.5;
            const partCenteredAndReady =
              candidatePickItem !== null &&
              candidateHorizDistM <= Math.min(0.085, grabRadiusM * 0.6) &&
              candidatePickItem.currentSpeedMmPerSec <= 40;

            if (atHome && isVerticalRetracted && partCenteredAndReady) {
              ctrl.autoPhase = 'LOWER_PICK';
              ctrl.phaseTimerSec = 0;
            }
            break;
          }
          case 'LOWER_PICK': {
            autoTargetTraverseCmd = homeTraverseMm;
            autoExtendVerticalCmd = true;
            ctrl.autoVacuumCmd = true;

            if (grippedItem !== null || (isVerticalExtended && candidatePickItem !== null)) {
              ctrl.autoPhase = 'GRAB_DWELL';
              ctrl.phaseTimerSec = 0;
            } else if (ctrl.phaseTimerSec > 1.5) {
              ctrl.autoPhase = 'WAIT_PART';
              ctrl.phaseTimerSec = 0;
            }
            break;
          }
          case 'GRAB_DWELL': {
            autoTargetTraverseCmd = homeTraverseMm;
            autoExtendVerticalCmd = true;
            ctrl.autoVacuumCmd = true;

            if (ctrl.phaseTimerSec >= 0.08) {
              ctrl.autoPhase = grippedItem ? 'LIFT_PICK' : 'WAIT_PART';
              ctrl.phaseTimerSec = 0;
            }
            break;
          }
          case 'LIFT_PICK': {
            autoTargetTraverseCmd = homeTraverseMm;
            autoExtendVerticalCmd = false;
            ctrl.autoVacuumCmd = true;

            if (!grippedItem) {
              ctrl.autoPhase = 'WAIT_PART';
              ctrl.phaseTimerSec = 0;
            } else if (isVerticalRetracted) {
              ctrl.autoPhase = 'TRAVERSE_PLACE';
              ctrl.phaseTimerSec = 0;
            }
            break;
          }
          case 'TRAVERSE_PLACE': {
            autoTargetTraverseCmd = placeTargetMm;
            autoExtendVerticalCmd = false;
            ctrl.autoVacuumCmd = true;

            if (!grippedItem) {
              ctrl.autoPhase = 'RETURN_HOME';
              ctrl.phaseTimerSec = 0;
            } else if (Math.abs(currTraverseMm - placeTargetMm) <= 3.0) {
              ctrl.autoPhase = 'LOWER_PLACE';
              ctrl.phaseTimerSec = 0;
            }
            break;
          }
          case 'LOWER_PLACE': {
            autoTargetTraverseCmd = placeTargetMm;
            autoExtendVerticalCmd = true;
            ctrl.autoVacuumCmd = true;

            // Check that Place Lane drop spot isn't currently occupied by another box
            let dropZoneClear = true;
            if (underBeltNode && grippedItem) {
              const gHalf = grippedItem.dimensionsMm[0] * 0.5;
              for (let i = 0; i < this.items.length; i++) {
                const other = this.items[i];
                if (other.id === grippedItem.id) continue;
                if (other.grippedByKey || other.worldPoseOverride) continue;
                if (other.pathNodeId !== underBeltNode.id) continue;
                const minGap =
                  gHalf + other.dimensionsMm[0] * 0.5 + ACCUMULATION_GAP_MM * 0.6;
                if (Math.abs(other.distanceMm - underBeltDistMm) < minGap) {
                  dropZoneClear = false;
                  break;
                }
              }
            }

            if (dropZoneClear && (isVerticalExtended || ctrl.phaseTimerSec >= 1.2)) {
              ctrl.autoPhase = 'RELEASE_DWELL';
              ctrl.phaseTimerSec = 0;
            }
            break;
          }
          case 'RELEASE_DWELL': {
            autoTargetTraverseCmd = placeTargetMm;
            autoExtendVerticalCmd = true;
            ctrl.autoVacuumCmd = false;

            if (ctrl.phaseTimerSec >= 0.08) {
              ctrl.autoPhase = 'LIFT_PLACE';
              ctrl.phaseTimerSec = 0;
            }
            break;
          }
          case 'LIFT_PLACE': {
            autoTargetTraverseCmd = placeTargetMm;
            autoExtendVerticalCmd = false;
            ctrl.autoVacuumCmd = false;

            if (isVerticalRetracted) {
              ctrl.autoPhase = 'RETURN_HOME';
              ctrl.phaseTimerSec = 0;
            }
            break;
          }
          case 'RETURN_HOME': {
            autoTargetTraverseCmd = homeTraverseMm;
            autoExtendVerticalCmd = false;
            ctrl.autoVacuumCmd = false;

            if (Math.abs(currTraverseMm - homeTraverseMm) <= 3.5) {
              ctrl.autoPhase = 'WAIT_PART';
              ctrl.phaseTimerSec = 0;
            }
            break;
          }
        }

        if (ctrl.traverseAxisNodeName) {
          setLiveAutoAxisTargetMm(
            ctrl.instanceId,
            ctrl.traverseAxisNodeName,
            autoTargetTraverseCmd
          );
        }
        if (ctrl.verticalAxisNodeName) {
          setLiveAutoCylinderExtend(
            ctrl.instanceId,
            ctrl.verticalAxisNodeName,
            autoExtendVerticalCmd
          );
        }
        setLiveAutoVacuumOn(ctrl.instanceId, ctrl.nodeName, ctrl.autoVacuumCmd);
      } else if (ctrl.wasAutoCycleActive) {
        ctrl.wasAutoCycleActive = false;
        ctrl.autoPhase = 'WAIT_PART';
        ctrl.phaseTimerSec = 0;
        ctrl.autoVacuumCmd = false;
        if (ctrl.traverseAxisNodeName) {
          setLiveAutoAxisTargetMm(ctrl.instanceId, ctrl.traverseAxisNodeName, null);
        }
        if (ctrl.verticalAxisNodeName) {
          setLiveAutoCylinderExtend(ctrl.instanceId, ctrl.verticalAxisNodeName, null);
        }
        setLiveAutoVacuumOn(ctrl.instanceId, ctrl.nodeName, null);
      }

      // 6. Headless Mode Actuator Stepping (when running outside R3F Canvas)
      if (isHeadless) {
        if (ctrl.traverseAxisRole) {
          const tRole = ctrl.traverseAxisRole;
          const tMin = Math.min(tRole.minLimitMm, tRole.maxLimitMm);
          const tMax = Math.max(tRole.minLimitMm, tRole.maxLimitMm);
          const rawTgt =
            autoTargetTraverseCmd !== null
              ? autoTargetTraverseCmd
              : ctrl.traverseAoTargetSlot >= 0
                ? bufferView.readFloat32(ctrl.traverseAoTargetSlot)
                : tRole.initialPosMm;
          const clampedTgt = Math.min(tMax, Math.max(tMin, rawTgt));
          const maxV =
            tRole.behavior?.presetType === 'ServoPositioning'
              ? tRole.behavior.maxVelocityUnitsPerSec
              : 500;
          const acc =
            tRole.behavior?.presetType === 'ServoPositioning'
              ? tRole.behavior.accelerationUnitsPerSec2
              : 1500;
          const dec =
            tRole.behavior?.presetType === 'ServoPositioning'
              ? tRole.behavior.decelerationUnitsPerSec2
              : 1800;

          const stepped = stepHeadlessServo1D(
            ctrl.headlessTraversePosMm,
            ctrl.headlessTraverseVelMmS,
            clampedTgt,
            maxV,
            acc,
            dec,
            dt
          );
          ctrl.headlessTraversePosMm = stepped.pos;
          ctrl.headlessTraverseVelMmS = stepped.vel;
          currTraverseMm = stepped.pos;

          if (ctrl.traverseActualPosSlot >= 0) {
            bufferView.writeFloat32(ctrl.traverseActualPosSlot, stepped.pos);
          }
          if (ctrl.traverseInPosSlot >= 0) {
            bufferView.writeSimToPlcBool(
              ctrl.traverseInPosSlot,
              Math.abs(stepped.pos - clampedTgt) <= 0.6 && Math.abs(stepped.vel) <= 2.5
            );
          }
        }

        if (ctrl.verticalAxisRole) {
          const vRole = ctrl.verticalAxisRole;
          const extSpd =
            vRole.behavior?.presetType === 'PneumaticCylinder'
              ? vRole.behavior.extendSpeedMmPerSec
              : 260;
          const retSpd =
            vRole.behavior?.presetType === 'PneumaticCylinder'
              ? vRole.behavior.retractSpeedMmPerSec
              : 300;
          const cmdExt =
            autoExtendVerticalCmd !== null
              ? autoExtendVerticalCmd
              : ctrl.verticalDoExtendSlot >= 0
                ? bufferView.readPlcToSimBool(ctrl.verticalDoExtendSlot)
                : false;

          if (cmdExt) {
            ctrl.headlessVerticalPosMm = Math.min(
              effectiveVMaxMm,
              ctrl.headlessVerticalPosMm + extSpd * dt
            );
          } else {
            ctrl.headlessVerticalPosMm = Math.max(
              vMinMm,
              ctrl.headlessVerticalPosMm - retSpd * dt
            );
          }
          if (ctrl.headlessVerticalPosMm > effectiveVMaxMm) {
            ctrl.headlessVerticalPosMm = effectiveVMaxMm;
          }
          currVerticalMm = ctrl.headlessVerticalPosMm;

          if (ctrl.verticalStrokeSlot >= 0) {
            bufferView.writeFloat32(ctrl.verticalStrokeSlot, currVerticalMm);
          }
          if (ctrl.verticalReedRetSlot >= 0) {
            bufferView.writeSimToPlcBool(
              ctrl.verticalReedRetSlot,
              Math.abs(currVerticalMm - vMinMm) <= 2.0
            );
          }
          if (ctrl.verticalReedExtSlot >= 0) {
            bufferView.writeSimToPlcBool(
              ctrl.verticalReedExtSlot,
              Math.abs(currVerticalMm - effectiveVMaxMm) <= 2.0 &&
                effectiveVMaxMm > vMinMm + 0.5
            );
          }
        }

        this.computeAnalyticalGripperWorldPose(
          ctrl,
          inst,
          bufferView,
          true,
          _gripPadWorldPos,
          _gripPadWorldQuat
        );
      }

      // 7. Suction Grab, 6-DOF Carry & Deterministic Conveyor Transfer Handoff
      const effectiveVacOn = autoCycleOn
        ? ctrl.autoVacuumCmd
        : ctrl.doVacuumOnSlot >= 0 && bufferView.readPlcToSimBool(ctrl.doVacuumOnSlot);

      const withinSuctionReach =
        candidatePickItem !== null &&
        Math.abs(_gripPadWorldPos.y - candidateTopY) <= grabTolM;

      const partPresent = grippedItem !== null || withinSuctionReach;
      if (ctrl.diPartPresentSlot >= 0) {
        bufferView.writeSimToPlcBool(ctrl.diPartPresentSlot, partPresent);
      }

      // (a) Grab transition
      if (!grippedItem && effectiveVacOn && withinSuctionReach && candidatePickItem) {
        grippedItem = candidatePickItem;
        grippedItem.grippedByKey = ctrl.key;
        ctrl.grippedItemId = grippedItem.id;

        if (grippedItem.worldPoseOverride) {
          _gripItemQuat.set(...grippedItem.worldPoseOverride.quaternion);
        } else {
          const lut = this.samplerCache.get(grippedItem.pathNodeId)?.table;
          if (lut) {
            sampleWorldPathPose(lut, grippedItem.distanceMm, _gripItemPos, _gripItemQuat);
          } else {
            _gripItemQuat.identity();
          }
        }
        ctrl.gripRelQuat
          .copy(_gripPadWorldQuat)
          .invert()
          .multiply(_gripItemQuat);
      }

      // (b) Carry update vs Release & Conveyor Transfer Handoff
      if (grippedItem && effectiveVacOn) {
        const gHgtM = Math.max(0.03, grippedItem.dimensionsMm[2] * 0.001);
        _gripComposedQuat.copy(_gripPadWorldQuat).multiply(ctrl.gripRelQuat);

        grippedItem.currentSpeedMmPerSec = 0;
        grippedItem.isAccumulated = false;
        grippedItem.worldPoseOverride = {
          position: [
            _gripPadWorldPos.x,
            _gripPadWorldPos.y - gHgtM * 0.5,
            _gripPadWorldPos.z,
          ],
          quaternion: [
            _gripComposedQuat.x,
            _gripComposedQuat.y,
            _gripComposedQuat.z,
            _gripComposedQuat.w,
          ],
        };

        if (ctrl.diPartGrippedSlot >= 0) {
          bufferView.writeSimToPlcBool(ctrl.diPartGrippedSlot, true);
        }
      } else if (grippedItem && !effectiveVacOn) {
        // Release suction -> hand off onto underlying conveyor spline OR rest cleanly on floor!
        const gHgtM = Math.max(0.03, grippedItem.dimensionsMm[2] * 0.001);
        const gHalfLen = grippedItem.dimensionsMm[0] * 0.5;
        const dropBottomY = _gripPadWorldPos.y - gHgtM;

        grippedItem.grippedByKey = undefined;
        ctrl.grippedItemId = null;

        let targetBeltNode: TransportPathNode | null = null;
        let targetBeltDistMm = 0;
        let bestLat = Infinity;

        for (const candNode of allNodes) {
          const lut = this.samplerCache.get(candNode.id)?.table;
          if (!lut) continue;
          const proj = projectPointToPathDistanceMm(lut, _gripPadWorldPos);
          sampleWorldPathPose(lut, proj.distanceMm, _tmpVecA);
          const vDiff = Math.abs(dropBottomY - _tmpVecA.y);
          if (
            proj.lateralDistMeters <= 0.34 &&
            vDiff <= 0.48 &&
            proj.lateralDistMeters < bestLat
          ) {
            bestLat = proj.lateralDistMeters;
            targetBeltNode = candNode;
            targetBeltDistMm = proj.distanceMm;
          }
        }

        if (targetBeltNode) {
          const lut = this.samplerCache.get(targetBeltNode.id)?.table;
          const arcLenMm = lut?.arcLengthMm ?? targetBeltNode.arcLengthMm;
          const clampedMm = Math.min(
            Math.max(gHalfLen + 8, targetBeltDistMm),
            Math.max(gHalfLen + 8, arcLenMm - gHalfLen - 8)
          );
          grippedItem.pathNodeId = targetBeltNode.id;
          grippedItem.distanceMm = Number(clampedMm.toFixed(1));
          grippedItem.prevDistanceMm = grippedItem.distanceMm;
          grippedItem.currentSpeedMmPerSec = 0;
          grippedItem.isAccumulated = false;
          grippedItem.worldPoseOverride = undefined;
        } else {
          _gripComposedQuat.copy(_gripPadWorldQuat).multiply(ctrl.gripRelQuat);
          grippedItem.currentSpeedMmPerSec = 0;
          grippedItem.isAccumulated = false;
          grippedItem.worldPoseOverride = {
            position: [
              _gripPadWorldPos.x,
              gHgtM * 0.5 + 0.004,
              _gripPadWorldPos.z,
            ],
            quaternion: [
              _gripComposedQuat.x,
              _gripComposedQuat.y,
              _gripComposedQuat.z,
              _gripComposedQuat.w,
            ],
          };
        }

        if (ctrl.diPartGrippedSlot >= 0) {
          bufferView.writeSimToPlcBool(ctrl.diPartGrippedSlot, false);
        }
      } else {
        if (ctrl.diPartGrippedSlot >= 0) {
          bufferView.writeSimToPlcBool(ctrl.diPartGrippedSlot, false);
        }
      }
    }
  }
}

export const transportRuntime = new TransportRuntimeEngine();
