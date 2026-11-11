import * as THREE from 'three';
import {
  type BinaryIpcBufferView,
  type ComponentDefinition,
  type FlowItemState,
  type PlcTagBinding,
  type SceneNodeInstance,
  type SimulationRunState,
  type TransportGraph,
  type TransportPathNode,
  type UUID,
  type Vector3Tuple,
  type WorkpieceShapeType,
} from '../shared/schemas';
import { makeNodeSignalKey } from './signalCatalogSync';
import { eulerDegToQuaternion } from './snapEngine';

/**
 * Deterministic 1D Spline Material Flow, Smooth Accumulation, Sub-Frame Sensor,
 * and Virtual HSC Encoder Engine (Milestone 3 — Zero React State Re-renders)
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

    const compMap = new Map(componentLibrary.map((c) => [c.id, c]));
    const slotMap = new Map<string, number>();
    for (const b of bindings) {
      slotMap.set(`${b.instanceId}::${b.componentSignalKey}`, b.bufferSlotIndex);
    }

    for (const inst of instances) {
      const comp = compMap.get(inst.componentId);
      if (!comp) continue;

      for (const role of Object.values(comp.nodeRoles)) {
        if (role.role === 'VisualEffect' && role.effectType === 'uv-scroll') {
          const runBitSlot =
            slotMap.get(`${inst.id}::${makeNodeSignalKey(role.nodeName, 'DO_BeltRun')}`) ??
            -1;
          const actualRpmSlot =
            slotMap.get(
              `${inst.id}::${makeNodeSignalKey(role.nodeName, 'AI_ActualBeltRpm')}`
            ) ?? -1;
          const cmdRpmSlot =
            slotMap.get(
              `${inst.id}::${makeNodeSignalKey(role.nodeName, 'AO_BeltSpeedRpm')}`
            ) ?? -1;

          this.beltDriveMap.set(inst.id, {
            runBitSlot,
            actualRpmSlot,
            cmdRpmSlot,
            nominalRpm: Math.max(1, role.nominalRpm ?? 60),
            fallbackRampedRpm: 0,
          });
        } else if (role.role === 'LinearAxis') {
          const isServo = role.behavior?.presetType === 'ServoPositioning';
          const posRealSlot =
            slotMap.get(
              `${inst.id}::${makeNodeSignalKey(
                role.nodeName,
                isServo ? 'AI_ActualPosMm' : 'AI_StrokeMm'
              )}`
            ) ?? -1;
          const reedExtBoolSlot =
            slotMap.get(
              `${inst.id}::${makeNodeSignalKey(role.nodeName, 'DI_ReedExtended')}`
            ) ?? -1;
          const doExtBoolSlot =
            slotMap.get(
              `${inst.id}::${makeNodeSignalKey(role.nodeName, 'DO_Extend')}`
            ) ?? -1;

          this.axisLookupMap.set(`${inst.id}::${role.nodeName}`, {
            posRealSlot,
            reedExtBoolSlot,
            doExtBoolSlot,
            minLimitMm: Math.min(role.minLimitMm, role.maxLimitMm),
            isPneumaticStopper: !isServo,
          });
        } else if (role.role === 'RotaryAxis') {
          const angleSlot =
            slotMap.get(
              `${inst.id}::${makeNodeSignalKey(
                role.nodeName,
                role.mode === 'continuous' ? 'AI_ActualRpm' : 'AI_ActualAngleDeg'
              )}`
            ) ?? -1;
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

    // 5. Step Part Spawners (`PartSource` — interval auto-feed + PLC rising-edge trigger)
    for (const spawner of graph.spawners) {
      const maxAllowed = spawner.maxActiveItems ?? 45;
      const triggerHigh =
        spawner.triggerBoolSlot !== undefined && spawner.triggerBoolSlot >= 0
          ? bufferView.readPlcToSimBool(spawner.triggerBoolSlot)
          : false;
      const prevTrig = this.spawnerPrevTrigger.get(spawner.id) ?? false;
      this.spawnerPrevTrigger.set(spawner.id, triggerHigh);
      const risingEdge = triggerHigh && !prevTrig;

      let shouldAttemptSpawn = risingEdge;
      if (spawner.mode === 'interval' && this.items.length < maxAllowed) {
        const prevTimer = this.spawnerTimers.get(spawner.id);
        // Spawn first box quickly (0.35s after Play) so user sees immediate motion!
        const elapsed = (prevTimer ?? Math.max(0, spawner.intervalSec - 0.35)) + dt;
        const period = Math.max(0.4, spawner.intervalSec || 2.2);
        if (elapsed >= period) {
          shouldAttemptSpawn = true;
          this.spawnerTimers.set(spawner.id, 0);
        } else {
          this.spawnerTimers.set(spawner.id, elapsed);
        }
      }

      if (shouldAttemptSpawn && this.items.length < maxAllowed) {
        this.spawnSinglePartNow(graph, spawner.id);
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
    for (const item of this.items) {
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
}

export const transportRuntime = new TransportRuntimeEngine();
