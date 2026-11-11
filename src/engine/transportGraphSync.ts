import * as THREE from 'three';
import type {
  ComponentDefinition,
  ComponentPathTemplate,
  PartSinkRuntimeConfig,
  PartSourceRuntimeConfig,
  PathSensorBinding,
  PlcTagMap,
  SceneNodeInstance,
  SnapConnectionRecord,
  TransformData,
  TransportGraph,
  TransportGraphEdge,
  TransportPathNode,
  UUID,
  Vector3Tuple,
  VirtualEncoderConfig,
} from '../shared/schemas';
import {
  formatReadableNodeLabel,
  makeEncoderPosKey,
  makeEncoderPulsesKey,
  makeEncoderVelKey,
  makeNodeSignalKey,
  makeSensorSignalKey,
  makeSinkCountKey,
  makeSpawnerCountKey,
  makeSpawnerTriggerKey,
  syncPlcTagMapWithScene,
} from './signalCatalogSync';
import { eulerDegToQuaternion } from './snapEngine';

/**
 * Deterministic Directed Spline Transport Graph & HSC Encoder Slot Compiler (Milestone 3)
 *
 * Compiles ComponentPathTemplates + SnapConnectionRecords into a directed TransportGraph,
 * auto-attaches Virtual HSC Encoders to conveyors & servo axes, and binds every runtime
 * sensor, spawner, sink, and encoder directly to collision-free BinaryIpcBufferView slots.
 */

export function makeTransportPathNodeId(instanceId: UUID, componentPathId: UUID): UUID {
  return `${instanceId}::${componentPathId}`;
}

export function computeLocalSplineArcLengthMm(
  waypoints: Vector3Tuple[],
  scale: Vector3Tuple,
  interpolation: 'catmull-rom' | 'polyline'
): number {
  if (waypoints.length < 2) return 0;

  const pts = waypoints.map(
    (wp) => new THREE.Vector3(wp[0] * scale[0], wp[1] * scale[1], wp[2] * scale[2])
  );

  if (interpolation === 'catmull-rom' && pts.length >= 3) {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    return Math.max(10, Number((curve.getLength() * 1000).toFixed(2)));
  }

  let totalMeters = 0;
  for (let i = 1; i < pts.length; i++) {
    totalMeters += pts[i - 1].distanceTo(pts[i]);
  }
  return Math.max(10, Number((totalMeters * 1000).toFixed(2)));
}

interface WorldEndpointPose {
  startPos: THREE.Vector3;
  startTan: THREE.Vector3;
  endPos: THREE.Vector3;
  endTan: THREE.Vector3;
}

function computeWorldEndpoints(
  waypoints: Vector3Tuple[],
  transform: TransformData
): WorldEndpointPose | null {
  if (waypoints.length < 2) return null;

  const pos = new THREE.Vector3(...transform.position);
  const quat = eulerDegToQuaternion(transform.rotationDeg);
  const scale = new THREE.Vector3(...transform.scale);

  const toWorld = (wp: Vector3Tuple): THREE.Vector3 =>
    new THREE.Vector3(wp[0], wp[1], wp[2]).multiply(scale).applyQuaternion(quat).add(pos);

  const w0 = toWorld(waypoints[0]);
  const w1 = toWorld(waypoints[1]);
  const wnPrev = toWorld(waypoints[waypoints.length - 2]);
  const wn = toWorld(waypoints[waypoints.length - 1]);

  const startTan = w1.clone().sub(w0);
  if (startTan.lengthSq() < 1e-8) startTan.set(1, 0, 0);
  else startTan.normalize();

  const endTan = wn.clone().sub(wnPrev);
  if (endTan.lengthSq() < 1e-8) endTan.set(1, 0, 0);
  else endTan.normalize();

  return {
    startPos: w0,
    startTan,
    endPos: wn,
    endTan,
  };
}

function findMatchingPathForPort(
  paths: ComponentPathTemplate[],
  portId: UUID,
  direction: 'in' | 'out'
): ComponentPathTemplate | undefined {
  const exact = paths.find((p) =>
    direction === 'out' ? p.outPortId === portId : p.inPortId === portId
  );
  if (exact) return exact;
  return paths.length === 1 ? paths[0] : undefined;
}

function hasBeltDriveRole(comp: ComponentDefinition): boolean {
  for (const r of Object.values(comp.nodeRoles)) {
    if (r.role === 'VisualEffect' && r.effectType === 'uv-scroll') return true;
    if (r.role === 'RotaryAxis' && r.behavior?.presetType === 'ConveyorDrive') return true;
  }
  return comp.category === 'Conveyors' && comp.nodeRoles.Turntable_Index_Deck_Axis === undefined;
}

export interface SyncTransportAndTagsResult {
  transportGraph: TransportGraph;
  plcTagMap: PlcTagMap;
}

export function syncSceneTransportAndSignals(params: {
  instances: SceneNodeInstance[];
  componentLibrary: ComponentDefinition[];
  snapConnections: SnapConnectionRecord[];
  prevTransportGraph: TransportGraph;
  prevTagMap: PlcTagMap;
}): SyncTransportAndTagsResult {
  const {
    instances,
    componentLibrary,
    snapConnections,
    prevTransportGraph,
    prevTagMap,
  } = params;

  const compMap = new Map<UUID, ComponentDefinition>(
    componentLibrary.map((c) => [c.id, c])
  );
  const instMap = new Map<UUID, SceneNodeInstance>(instances.map((i) => [i.id, i]));

  // 1. Build TransportPathNodes for every placed instance with valid waypoints
  const nodes: Record<UUID, TransportPathNode> = {};
  const nodeEndpoints = new Map<UUID, WorldEndpointPose>();

  for (const inst of instances) {
    if (!inst.visible) continue;
    const comp = compMap.get(inst.componentId);
    if (!comp || comp.transportPaths.length === 0) continue;

    for (const tpl of comp.transportPaths) {
      if (tpl.waypoints.length < 2) continue;
      const nodeId = makeTransportPathNodeId(inst.id, tpl.id);
      const arcLengthMm = computeLocalSplineArcLengthMm(
        tpl.waypoints,
        inst.transform.scale,
        tpl.interpolation
      );

      nodes[nodeId] = {
        id: nodeId,
        instanceId: inst.id,
        componentPathId: tpl.id,
        localWaypoints: tpl.waypoints.map((wp) => [...wp] as Vector3Tuple),
        interpolation: tpl.interpolation,
        arcLengthMm,
        nominalSpeedMmPerSec: tpl.defaultSpeedMmPerSec || 450,
      };

      const ep = computeWorldEndpoints(tpl.waypoints, inst.transform);
      if (ep) {
        nodeEndpoints.set(nodeId, ep);
      }
    }
  }

  // 2. Build Directed TransportGraphEdges (SnapPort links + spatial endpoint proximity fallback)
  const edges: TransportGraphEdge[] = [];
  const edgePairKeys = new Set<string>();

  for (const conn of snapConnections) {
    const srcInst = instMap.get(conn.sourceInstanceId);
    const dstInst = instMap.get(conn.targetInstanceId);
    if (!srcInst || !dstInst || !srcInst.visible || !dstInst.visible) continue;

    const srcComp = compMap.get(srcInst.componentId);
    const dstComp = compMap.get(dstInst.componentId);
    if (!srcComp || !dstComp) continue;

    const srcTpl = findMatchingPathForPort(
      srcComp.transportPaths,
      conn.sourcePortId,
      'out'
    );
    const dstTpl = findMatchingPathForPort(
      dstComp.transportPaths,
      conn.targetPortId,
      'in'
    );
    if (!srcTpl || !dstTpl) continue;

    const fromNodeId = makeTransportPathNodeId(srcInst.id, srcTpl.id);
    const toNodeId = makeTransportPathNodeId(dstInst.id, dstTpl.id);
    if (!nodes[fromNodeId] || !nodes[toNodeId]) continue;

    const pairKey = `${fromNodeId}->${toNodeId}`;
    if (edgePairKeys.has(pairKey)) continue;
    edgePairKeys.add(pairKey);

    edges.push({
      id: `edge-${fromNodeId}->${toNodeId}`,
      fromPathNodeId: fromNodeId,
      fromInstanceId: srcInst.id,
      fromPortId: conn.sourcePortId,
      toPathNodeId: toNodeId,
      toInstanceId: dstInst.id,
      toPortId: conn.targetPortId,
    });
  }

  // Spatial endpoint proximity fallback (<= 140mm & aligned tangents) for custom-drawn spline paths
  const nodeList = Object.values(nodes);
  for (let i = 0; i < nodeList.length; i++) {
    const nodeA = nodeList[i];
    const hasOutgoing = edges.some((e) => e.fromPathNodeId === nodeA.id);
    if (hasOutgoing) continue;

    const epA = nodeEndpoints.get(nodeA.id);
    if (!epA) continue;

    let bestCandidate: TransportPathNode | null = null;
    let bestDist = 0.14; // 140mm capture tolerance

    for (let j = 0; j < nodeList.length; j++) {
      if (i === j) continue;
      const nodeB = nodeList[j];
      if (nodeB.instanceId === nodeA.instanceId) continue;

      const epB = nodeEndpoints.get(nodeB.id);
      if (!epB) continue;

      const dist = epA.endPos.distanceTo(epB.startPos);
      if (dist <= bestDist && epA.endTan.dot(epB.startTan) >= 0.25) {
        bestDist = dist;
        bestCandidate = nodeB;
      }
    }

    if (bestCandidate) {
      const pairKey = `${nodeA.id}->${bestCandidate.id}`;
      if (!edgePairKeys.has(pairKey)) {
        edgePairKeys.add(pairKey);
        edges.push({
          id: `edge-prox-${nodeA.id}->${bestCandidate.id}`,
          fromPathNodeId: nodeA.id,
          fromInstanceId: nodeA.instanceId,
          fromPortId: 'spatial-out',
          toPathNodeId: bestCandidate.id,
          toInstanceId: bestCandidate.instanceId,
          toPortId: 'spatial-in',
        });
      }
    }
  }

  // 3. Filter & normalize active Sensors, Spawners, Sinks, and Virtual HSC Encoders
  const sensors: PathSensorBinding[] = [];
  for (const s of prevTransportGraph.sensors) {
    if (!instMap.has(s.instanceId)) continue;
    const targetNode = nodes[s.pathNodeId];
    if (!targetNode) continue;
    sensors.push({
      ...s,
      offsetMm: Math.min(targetNode.arcLengthMm, Math.max(0, s.offsetMm)),
    });
  }

  const spawners: PartSourceRuntimeConfig[] = [];
  for (const sp of prevTransportGraph.spawners) {
    if (!instMap.has(sp.instanceId) || !nodes[sp.targetPathNodeId]) continue;
    spawners.push({ ...sp });
  }

  const sinks: PartSinkRuntimeConfig[] = [];
  for (const sk of prevTransportGraph.sinks) {
    if (!instMap.has(sk.instanceId) || !nodes[sk.sourcePathNodeId]) continue;
    sinks.push({ ...sk });
  }

  const encoders: VirtualEncoderConfig[] = [];
  const existingEncComposite = new Set<string>();
  for (const enc of prevTransportGraph.encoders) {
    const inst = instMap.get(enc.targetInstanceId);
    if (!inst) continue;
    const comp = compMap.get(inst.componentId);
    if (!comp) continue;

    if (enc.sourceKind === 'transport-path') {
      const pathNodeId = makeTransportPathNodeId(inst.id, enc.targetSubKey);
      if (!nodes[pathNodeId]) continue;
    } else {
      const role = comp.nodeRoles[enc.targetSubKey];
      if (!role || (role.role !== 'LinearAxis' && role.role !== 'RotaryAxis')) continue;
    }

    existingEncComposite.add(`${enc.targetInstanceId}::${enc.sourceKind}::${enc.targetSubKey}`);
    encoders.push({ ...enc });
  }

  // Auto-attach default Virtual HSC Encoders to conveyors and Servo/Rotary axes unless opted out
  for (const inst of instances) {
    if (inst.parameters.__disableAutoEncoder === true) continue;
    const comp = compMap.get(inst.componentId);
    if (!comp) continue;

    if (comp.transportPaths.length > 0 && hasBeltDriveRole(comp)) {
      const primaryPath = comp.transportPaths[0];
      const pathNodeId = makeTransportPathNodeId(inst.id, primaryPath.id);
      const compKey = `${inst.id}::transport-path::${primaryPath.id}`;
      if (nodes[pathNodeId] && !existingEncComposite.has(compKey)) {
        existingEncComposite.add(compKey);
        encoders.push({
          id: `enc-${inst.id}-${primaryPath.id}`,
          name: 'Belt HSC',
          sourceKind: 'transport-path',
          targetInstanceId: inst.id,
          targetSubKey: primaryPath.id,
          pulsesPerRevolution: 1024,
          travelMmPerRevolution: 471.24, // pi * 150mm drive drum
          rolloverModulo: 1_000_000,
          cumulativePulsesDintSlot: -1,
          actualPositionRealSlot: -1,
          actualVelocityRealSlot: -1,
        });
      }
    }

    for (const role of Object.values(comp.nodeRoles)) {
      if (role.role === 'LinearAxis' && role.behavior?.presetType === 'ServoPositioning') {
        const compKey = `${inst.id}::linear-axis::${role.nodeName}`;
        if (!existingEncComposite.has(compKey)) {
          existingEncComposite.add(compKey);
          const readable = formatReadableNodeLabel(role.nodeName);
          encoders.push({
            id: `enc-${inst.id}-${role.nodeName}`,
            name: `${readable} Servo`,
            sourceKind: 'linear-axis',
            targetInstanceId: inst.id,
            targetSubKey: role.nodeName,
            pulsesPerRevolution: 4096,
            travelMmPerRevolution: 10.0, // 10mm pitch precision ball-screw
            rolloverModulo: 2_147_483_647,
            cumulativePulsesDintSlot: -1,
            actualPositionRealSlot: -1,
            actualVelocityRealSlot: -1,
          });
        }
      } else if (
        role.role === 'RotaryAxis' &&
        (role.mode === 'bounded' || role.behavior?.presetType === 'ServoPositioning')
      ) {
        const compKey = `${inst.id}::rotary-axis::${role.nodeName}`;
        if (!existingEncComposite.has(compKey)) {
          existingEncComposite.add(compKey);
          const readable = formatReadableNodeLabel(role.nodeName);
          encoders.push({
            id: `enc-${inst.id}-${role.nodeName}`,
            name: `${readable} Indexer`,
            sourceKind: 'rotary-axis',
            targetInstanceId: inst.id,
            targetSubKey: role.nodeName,
            pulsesPerRevolution: 4096,
            travelMmPerRevolution: 360.0, // 360 deg per full revolution
            rolloverModulo: 2_147_483_647,
            cumulativePulsesDintSlot: -1,
            actualPositionRealSlot: -1,
            actualVelocityRealSlot: -1,
          });
        }
      }
    }
  }

  const draftGraph: TransportGraph = {
    nodes,
    edges,
    sensors,
    spawners,
    sinks,
    encoders,
    activeFlowItems: prevTransportGraph.activeFlowItems ?? [],
  };

  // 4. Allocate collision-free BinaryIpcBufferView slots for all Component + TransportGraph tags
  const syncedTagMap = syncPlcTagMapWithScene(
    instances,
    componentLibrary,
    prevTagMap,
    draftGraph
  );

  // Build O(1) lookup from `${instanceId}::${componentSignalKey}` -> bufferSlotIndex
  const slotByComposite = new Map<string, number>();
  for (const b of syncedTagMap.bindings) {
    slotByComposite.set(`${b.instanceId}::${b.componentSignalKey}`, b.bufferSlotIndex);
  }

  // 5. Stamp resolved BinaryIpcBufferView slot indices directly onto TransportGraph runtime records
  for (const node of Object.values(nodes)) {
    const comp = compMap.get(instMap.get(node.instanceId)?.componentId ?? '');
    if (!comp) continue;

    for (const role of Object.values(comp.nodeRoles)) {
      if (role.role === 'VisualEffect' && role.effectType === 'uv-scroll') {
        const runSlot = slotByComposite.get(
          `${node.instanceId}::${makeNodeSignalKey(role.nodeName, 'DO_BeltRun')}`
        );
        const actualRpmSlot = slotByComposite.get(
          `${node.instanceId}::${makeNodeSignalKey(role.nodeName, 'AI_ActualBeltRpm')}`
        );
        const cmdRpmSlot = slotByComposite.get(
          `${node.instanceId}::${makeNodeSignalKey(role.nodeName, 'AO_BeltSpeedRpm')}`
        );
        if (runSlot !== undefined) node.runBitSlot = runSlot;
        if (actualRpmSlot !== undefined) node.speedRealSlot = actualRpmSlot;
        else if (cmdRpmSlot !== undefined) node.speedRealSlot = cmdRpmSlot;
      } else if (
        role.role === 'LinearAxis' &&
        role.behavior?.presetType !== 'ServoPositioning'
      ) {
        const reedExtSlot = slotByComposite.get(
          `${node.instanceId}::${makeNodeSignalKey(role.nodeName, 'DI_ReedExtended')}`
        );
        const doExtSlot = slotByComposite.get(
          `${node.instanceId}::${makeNodeSignalKey(role.nodeName, 'DO_Extend')}`
        );
        node.stopperActiveBitSlot = reedExtSlot ?? doExtSlot;
        node.stopperOffsetMm = Number((node.arcLengthMm * 0.5).toFixed(1));
      }
    }
  }

  const boundSensors: PathSensorBinding[] = sensors.map((s) => ({
    ...s,
    outputBoolSlot:
      slotByComposite.get(`${s.instanceId}::${makeSensorSignalKey(s.id)}`) ?? -1,
  }));

  const boundSpawners: PartSourceRuntimeConfig[] = spawners.map((sp) => ({
    ...sp,
    triggerBoolSlot:
      slotByComposite.get(`${sp.instanceId}::${makeSpawnerTriggerKey(sp.id)}`) ?? -1,
    spawnedCountDintSlot:
      slotByComposite.get(`${sp.instanceId}::${makeSpawnerCountKey(sp.id)}`) ?? -1,
  }));

  const boundSinks: PartSinkRuntimeConfig[] = sinks.map((sk) => ({
    ...sk,
    countedPartsDintSlot:
      slotByComposite.get(`${sk.instanceId}::${makeSinkCountKey(sk.id)}`) ?? -1,
  }));

  const boundEncoders: VirtualEncoderConfig[] = encoders.map((enc) => ({
    ...enc,
    cumulativePulsesDintSlot:
      slotByComposite.get(
        `${enc.targetInstanceId}::${makeEncoderPulsesKey(enc.id)}`
      ) ?? -1,
    actualPositionRealSlot:
      slotByComposite.get(`${enc.targetInstanceId}::${makeEncoderPosKey(enc.id)}`) ?? -1,
    actualVelocityRealSlot:
      slotByComposite.get(`${enc.targetInstanceId}::${makeEncoderVelKey(enc.id)}`) ?? -1,
  }));

  return {
    transportGraph: {
      nodes,
      edges,
      sensors: boundSensors,
      spawners: boundSpawners,
      sinks: boundSinks,
      encoders: boundEncoders,
      activeFlowItems: draftGraph.activeFlowItems,
    },
    plcTagMap: syncedTagMap,
  };
}
