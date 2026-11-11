import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { runtimeBusClient } from '../../engine/runtimeBusClient';
import { eulerDegToQuaternion } from '../../engine/snapEngine';
import {
  sampleWorldPathPose,
  transportRuntime,
  type WorldPathSampleTable,
} from '../../engine/transportEngine';
import type {
  ComponentDefinition,
  SceneNodeInstance,
  TransportPathNode,
  UUID,
  Vector3Tuple,
} from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';

const MAX_POOLED_FLOW_ITEMS = 96;
const UP_VEC = new THREE.Vector3(0, 1, 0);
const Z_VEC = new THREE.Vector3(0, 0, 1);

const _samplePos = new THREE.Vector3();
const _sampleQuat = new THREE.Quaternion();
const _sampleTan = new THREE.Vector3();

interface SplineVisualDescriptor {
  node: TransportPathNode;
  tubeGeometry: THREE.TubeGeometry;
  worldWaypoints: Vector3Tuple[];
  chevrons: Array<{
    position: [number, number, number];
    quaternion: [number, number, number, number];
  }>;
  worldStart: [number, number, number];
  worldEnd: [number, number, number];
}

function buildSplineVisual(
  node: TransportPathNode,
  instance: SceneNodeInstance,
  isSelectedFlow: boolean
): SplineVisualDescriptor | null {
  if (node.localWaypoints.length < 2) return null;

  const instPos = new THREE.Vector3(...instance.transform.position);
  const instQuat = eulerDegToQuaternion(instance.transform.rotationDeg);
  const instScale = new THREE.Vector3(...instance.transform.scale);

  const worldPts = node.localWaypoints.map((wp) => {
    const v = new THREE.Vector3(wp[0], wp[1], wp[2])
      .multiply(instScale)
      .applyQuaternion(instQuat)
      .add(instPos);
    // Lift 14mm above belt surface to eliminate coplanar Z-fighting
    v.y += 0.014;
    return v;
  });

  let curve: THREE.Curve<THREE.Vector3>;
  if (node.interpolation === 'catmull-rom' && worldPts.length >= 3) {
    curve = new THREE.CatmullRomCurve3(worldPts, false, 'centripetal', 0.5);
  } else {
    const curvePath = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 1; i < worldPts.length; i++) {
      curvePath.add(new THREE.LineCurve3(worldPts[i - 1], worldPts[i]));
    }
    curve = curvePath;
  }

  const totalLenM = Math.max(0.05, curve.getLength());
  const tubularSegments = Math.max(16, Math.min(80, Math.round(totalLenM * 24)));
  const radius = isSelectedFlow ? 0.011 : 0.0075;
  const tubeGeometry = new THREE.TubeGeometry(curve, tubularSegments, radius, 8, false);

  const chevronCount = Math.max(1, Math.min(10, Math.floor(totalLenM / 0.52)));
  const chevrons: SplineVisualDescriptor['chevrons'] = [];
  for (let c = 0; c < chevronCount; c++) {
    const u = (c + 0.5) / chevronCount;
    const pt = curve.getPointAt(u);
    const tan = curve.getTangentAt(u).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(UP_VEC, tan);
    chevrons.push({
      position: [pt.x, pt.y + 0.004, pt.z],
      quaternion: [q.x, q.y, q.z, q.w],
    });
  }

  const first = worldPts[0];
  const last = worldPts[worldPts.length - 1];

  return {
    node,
    tubeGeometry,
    worldWaypoints: worldPts.map((p) => [p.x, p.y, p.z]),
    chevrons,
    worldStart: [first.x, first.y, first.z],
    worldEnd: [last.x, last.y, last.z],
  };
}

function buildStaticSamplerFallback(
  node: TransportPathNode,
  instance: SceneNodeInstance
): WorldPathSampleTable | null {
  if (node.localWaypoints.length < 2) return null;
  const instPos = new THREE.Vector3(...instance.transform.position);
  const instQuat = eulerDegToQuaternion(instance.transform.rotationDeg);
  const instScale = new THREE.Vector3(...instance.transform.scale);

  const pts = node.localWaypoints.map((wp) =>
    new THREE.Vector3(wp[0], wp[1], wp[2])
      .multiply(instScale)
      .applyQuaternion(instQuat)
      .add(instPos)
  );

  const sampleCount = 32;
  const distancesMm = new Float64Array(sampleCount);
  const positions = new Float32Array(sampleCount * 3);
  const tangents = new Float32Array(sampleCount * 3);

  let curve: THREE.Curve<THREE.Vector3>;
  if (node.interpolation === 'catmull-rom' && pts.length >= 3) {
    curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
  } else {
    const cp = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 1; i < pts.length; i++) {
      cp.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
    }
    curve = cp;
  }

  let cumMm = 0;
  let prev = curve.getPoint(0);
  for (let i = 0; i < sampleCount; i++) {
    const u = i / (sampleCount - 1);
    const p = curve.getPoint(u);
    const t = curve.getTangent(u).normalize();
    if (i > 0) cumMm += p.distanceTo(prev) * 1000;
    prev = p;
    distancesMm[i] = cumMm;
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
    tangents[i * 3] = t.x;
    tangents[i * 3 + 1] = t.y;
    tangents[i * 3 + 2] = t.z;
  }

  return {
    nodeId: node.id,
    instanceId: node.instanceId,
    arcLengthMm: Math.max(10, cumMm),
    sampleCount,
    distancesMm,
    positions,
    tangents,
    worldStart: pts[0],
    worldEnd: pts[pts.length - 1],
    startTangent: new THREE.Vector3(tangents[0], tangents[1], tangents[2]),
    endTangent: new THREE.Vector3(
      tangents[(sampleCount - 1) * 3],
      tangents[(sampleCount - 1) * 3 + 1],
      tangents[(sampleCount - 1) * 3 + 2]
    ),
    deckAngleDeg: 0,
  };
}

export const TransportFlowOverlay = memo(function TransportFlowOverlay() {
  const showTransportPaths = useEditorStore(
    (s) => s.scene.environment.showTransportPaths !== false
  );
  const instances = useEditorStore((s) => s.scene.instances);
  const library = useEditorStore((s) => s.scene.componentLibrary);
  const transportGraph = useEditorStore((s) => s.scene.transportGraph);
  const selectedInstanceId = useEditorStore((s) => s.selectedInstanceId);
  const inspectorTab = useEditorStore((s) => s.inspectorTab);
  const isDrawingSplinePath = useEditorStore((s) => s.isDrawingSplinePath);
  const appendSplineWaypointWorld = useEditorStore((s) => s.appendSplineWaypointWorld);

  // Pool of 96 3D Carton/Tote Workpieces updated imperatively in useFrame (0 React re-renders!)
  const itemGroupRefs = useRef<Array<THREE.Group | null>>([]);
  const itemBodyMatRefs = useRef<Array<THREE.MeshStandardMaterial | null>>([]);
  const itemBandMatRefs = useRef<Array<THREE.MeshStandardMaterial | null>>([]);
  const lastColorHexBySlot = useRef<string[]>([]);

  // Live Sensor Laser Beam & LED material refs for zero-React-render high-speed flash
  const sensorBeamMatRefs = useRef<Map<UUID, THREE.MeshBasicMaterial>>(new Map());
  const sensorLedMatRefs = useRef<Map<UUID, THREE.MeshStandardMaterial>>(new Map());

  const [drawHoverPos, setDrawHoverPos] = useState<[number, number, number] | null>(
    null
  );

  // Shared static geometries for pooled workpieces & overlays
  const sharedGeoms = useMemo(() => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const label = new THREE.BoxGeometry(0.46, 0.015, 0.52);
    const band = new THREE.BoxGeometry(1.015, 0.14, 1.015);
    const cone = new THREE.ConeGeometry(0.024, 0.068, 12);
    const wpSphere = new THREE.SphereGeometry(0.028, 14, 14);
    const edgeTorus = new THREE.TorusGeometry(0.052, 0.008, 10, 24);
    edgeTorus.rotateY(Math.PI / 2);
    return { box, label, band, cone, wpSphere, edgeTorus };
  }, []);

  useEffect(() => {
    return () => {
      sharedGeoms.box.dispose();
      sharedGeoms.label.dispose();
      sharedGeoms.band.dispose();
      sharedGeoms.cone.dispose();
      sharedGeoms.wpSphere.dispose();
      sharedGeoms.edgeTorus.dispose();
    };
  }, [sharedGeoms]);

  const instMap = useMemo(
    () => new Map<UUID, SceneNodeInstance>(instances.map((i) => [i.id, i])),
    [instances]
  );

  const compMap = useMemo(
    () => new Map<UUID, ComponentDefinition>(library.map((c) => [c.id, c])),
    [library]
  );

  // Build 3D Spline Path TubeGeometries whenever path nodes or transforms change
  const splineVisuals = useMemo(() => {
    const visuals: SplineVisualDescriptor[] = [];
    for (const node of Object.values(transportGraph.nodes)) {
      const inst = instMap.get(node.instanceId);
      if (!inst || !inst.visible) continue;
      const isSelectedFlow =
        inst.id === selectedInstanceId &&
        (inspectorTab === 'flow' || isDrawingSplinePath);
      const vis = buildSplineVisual(node, inst, isSelectedFlow);
      if (vis) visuals.push(vis);
    }
    return visuals;
  }, [
    instMap,
    inspectorTab,
    isDrawingSplinePath,
    selectedInstanceId,
    transportGraph.nodes,
  ]);

  useEffect(() => {
    return () => {
      for (const v of splineVisuals) {
        v.tubeGeometry.dispose();
      }
    };
  }, [splineVisuals]);

  // Compute static world poses for 3D Sensors, Spawners, and Sinks
  const staticSamplerByNode = useMemo(() => {
    const map = new Map<UUID, WorldPathSampleTable>();
    for (const node of Object.values(transportGraph.nodes)) {
      const inst = instMap.get(node.instanceId);
      if (!inst || !inst.visible) continue;
      const lut = buildStaticSamplerFallback(node, inst);
      if (lut) map.set(node.id, lut);
    }
    return map;
  }, [instMap, transportGraph.nodes]);

  const sensorVisuals = useMemo(() => {
    return transportGraph.sensors
      .map((s) => {
        const lut = staticSamplerByNode.get(s.pathNodeId);
        if (!lut) return null;
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        sampleWorldPathPose(lut, s.offsetMm, p, q);
        return {
          sensor: s,
          position: [p.x, p.y, p.z] as [number, number, number],
          quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number],
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [staticSamplerByNode, transportGraph.sensors]);

  const spawnerPortals = useMemo(() => {
    return transportGraph.spawners
      .map((sp) => {
        const lut = staticSamplerByNode.get(sp.targetPathNodeId);
        if (!lut) return null;
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        sampleWorldPathPose(lut, Math.min(120, lut.arcLengthMm * 0.15), p, q);
        return {
          id: sp.id,
          position: [p.x, p.y + 0.12, p.z] as [number, number, number],
          quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number],
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [staticSamplerByNode, transportGraph.spawners]);

  const sinkPortals = useMemo(() => {
    return transportGraph.sinks
      .map((sk) => {
        const lut = staticSamplerByNode.get(sk.sourcePathNodeId);
        if (!lut) return null;
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        sampleWorldPathPose(
          lut,
          Math.max(0, lut.arcLengthMm - Math.min(120, lut.arcLengthMm * 0.15)),
          p,
          q
        );
        return {
          id: sk.id,
          position: [p.x, p.y + 0.12, p.z] as [number, number, number],
          quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number],
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [staticSamplerByNode, transportGraph.sinks]);

  const edgeJunctions = useMemo(() => {
    const visualMap = new Map(splineVisuals.map((v) => [v.node.id, v]));
    return transportGraph.edges
      .map((edge) => {
        const fromVis = visualMap.get(edge.fromPathNodeId);
        const toVis = visualMap.get(edge.toPathNodeId);
        if (!fromVis || !toVis) return null;
        return {
          id: edge.id,
          midpoint: [
            (fromVis.worldEnd[0] + toVis.worldStart[0]) * 0.5,
            (fromVis.worldEnd[1] + toVis.worldStart[1]) * 0.5,
            (fromVis.worldEnd[2] + toVis.worldStart[2]) * 0.5,
          ] as [number, number, number],
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [splineVisuals, transportGraph.edges]);

  // Selected machine belt workplane for 3D Spline Waypoint Drawing
  const drawWorkplane = useMemo(() => {
    if (!isDrawingSplinePath || !selectedInstanceId) return null;
    const inst = instMap.get(selectedInstanceId);
    if (!inst) return null;
    const comp = compMap.get(inst.componentId);
    if (!comp) return null;

    const beltTopLocalY = Math.max(0.1, comp.boundingBox.max[1]);
    const worldY = inst.transform.position[1] + beltTopLocalY * inst.transform.scale[1];
    const spanX = Math.max(2.5, comp.boundingBox.size[0] * inst.transform.scale[0] + 1.2);
    const spanZ = Math.max(1.8, comp.boundingBox.size[2] * inst.transform.scale[2] + 1.2);

    return {
      instanceId: inst.id,
      center: [inst.transform.position[0], worldY, inst.transform.position[2]] as [
        number,
        number,
        number,
      ],
      size: [spanX, spanZ] as [number, number],
    };
  }, [compMap, instMap, isDrawingSplinePath, selectedInstanceId]);

  // 60-144Hz Deterministic Material Flow, Sensor & HSC Encoder Loop (Zero React Re-renders)
  useFrame((_, delta) => {
    const store = useEditorStore.getState();
    transportRuntime.step({
      graph: store.scene.transportGraph,
      instances: store.scene.instances,
      componentLibrary: store.scene.componentLibrary,
      bindings: store.scene.plcTagMap.bindings,
      bufferView: runtimeBusClient.bufferView,
      runState: store.runState,
      simSpeedMultiplier: store.scene.environment.simSpeedMultiplier,
      rawDeltaSec: delta,
    });

    // Update pooled 3D FlowItems
    const activeItems = transportRuntime.getFlowItems();
    const visibleCount = Math.min(MAX_POOLED_FLOW_ITEMS, activeItems.length);

    for (let i = 0; i < MAX_POOLED_FLOW_ITEMS; i++) {
      const grp = itemGroupRefs.current[i];
      if (!grp) continue;

      if (i >= visibleCount) {
        if (grp.visible) grp.visible = false;
        continue;
      }

      const item = activeItems[i];
      const lut = transportRuntime.getWorldSampler(item.pathNodeId);
      if (!lut) {
        grp.visible = false;
        continue;
      }

      sampleWorldPathPose(lut, item.distanceMm, _samplePos, _sampleQuat, _sampleTan);

      const lenM = Math.max(0.06, item.dimensionsMm[0] * 0.001);
      const widM = Math.max(0.06, item.dimensionsMm[1] * 0.001);
      const hgtM = Math.max(0.04, item.dimensionsMm[2] * 0.001);

      grp.visible = true;
      grp.position.set(_samplePos.x, _samplePos.y + hgtM * 0.5 + 0.004, _samplePos.z);
      grp.quaternion.copy(_sampleQuat);
      grp.scale.set(lenM, hgtM, widM);

      const bodyMat = itemBodyMatRefs.current[i];
      if (bodyMat && lastColorHexBySlot.current[i] !== item.colorHex) {
        bodyMat.color.set(item.colorHex);
        lastColorHexBySlot.current[i] = item.colorHex;
      }

      const bandMat = itemBandMatRefs.current[i];
      if (bandMat) {
        if (item.isAccumulated) {
          bandMat.color.setHex(0xf59e0b);
          bandMat.emissive.setHex(0xd97706);
          bandMat.emissiveIntensity = 0.75;
        } else {
          bandMat.color.setHex(0x1e293b);
          bandMat.emissive.setHex(0x0ea5e9);
          bandMat.emissiveIntensity = 0.22;
        }
      }
    }

    // Update live 3D Photoelectric Laser Beams & Proximity LEDs
    const sensors = store.scene.transportGraph.sensors;
    for (let s = 0; s < sensors.length; s++) {
      const sens = sensors[s];
      const trig = transportRuntime.isSensorTriggered(sens.id);

      const beamMat = sensorBeamMatRefs.current.get(sens.id);
      if (beamMat) {
        beamMat.color.setHex(trig ? 0xf43f5e : 0x22d3ee);
        beamMat.opacity = trig ? 0.94 : 0.44;
      }

      const ledMat = sensorLedMatRefs.current.get(sens.id);
      if (ledMat) {
        ledMat.color.setHex(trig ? 0xfbbf24 : 0x10b981);
        ledMat.emissive.setHex(trig ? 0xf59e0b : 0x059669);
        ledMat.emissiveIntensity = trig ? 1.8 : 0.45;
      }
    }
  });

  const handleWorkplaneClick = (e: ThreeEvent<MouseEvent>) => {
    if (!drawWorkplane) return;
    e.stopPropagation();
    if (e.delta > 5) return;
    appendSplineWaypointWorld(drawWorkplane.instanceId, [
      e.point.x,
      e.point.y,
      e.point.z,
    ]);
  };

  const poolIndices = useMemo(
    () => Array.from({ length: MAX_POOLED_FLOW_ITEMS }, (_, idx) => idx),
    []
  );

  return (
    <group name="TransportFlowOverlayGroup">
      {/* 1. Pooled 3D Dynamic Workpieces (Cartons / Industrial Totes) */}
      {poolIndices.map((slotIdx) => (
        <group
          key={slotIdx}
          ref={(el) => {
            itemGroupRefs.current[slotIdx] = el;
          }}
          visible={false}
          raycast={() => null}
        >
          <mesh geometry={sharedGeoms.box} castShadow receiveShadow raycast={() => null}>
            <meshStandardMaterial
              ref={(mat) => {
                itemBodyMatRefs.current[slotIdx] = mat;
              }}
              color="#0ea5e9"
              roughness={0.42}
              metalness={0.12}
            />
          </mesh>

          {/* Perimeter status stripe (glows amber when smoothly accumulated in a queue) */}
          <mesh geometry={sharedGeoms.band} raycast={() => null}>
            <meshStandardMaterial
              ref={(mat) => {
                itemBandMatRefs.current[slotIdx] = mat;
              }}
              color="#1e293b"
              emissive="#0ea5e9"
              emissiveIntensity={0.22}
              roughness={0.35}
            />
          </mesh>

          {/* Top shipping manifest / barcode label */}
          <mesh
            geometry={sharedGeoms.label}
            position={[0.08, 0.505, 0]}
            raycast={() => null}
          >
            <meshStandardMaterial color="#f8fafc" roughness={0.65} />
          </mesh>
        </group>
      ))}

      {/* 2. Spline Transport Centerlines, Flow Chevrons, Portals & 3D Sensors */}
      {showTransportPaths && (
        <>
          {splineVisuals.map((vis) => {
            const isFocused =
              vis.node.instanceId === selectedInstanceId &&
              (inspectorTab === 'flow' || isDrawingSplinePath);
            const lineColor = isFocused ? '#fbbf24' : '#06b6d4';

            return (
              <group key={vis.node.id}>
                <mesh geometry={vis.tubeGeometry} raycast={() => null}>
                  <meshBasicMaterial
                    color={lineColor}
                    transparent
                    opacity={isFocused ? 0.95 : 0.72}
                    toneMapped={false}
                  />
                </mesh>

                {vis.chevrons.map((ch, cIdx) => (
                  <mesh
                    key={cIdx}
                    geometry={sharedGeoms.cone}
                    position={ch.position}
                    quaternion={ch.quaternion}
                    raycast={() => null}
                  >
                    <meshBasicMaterial
                      color={isFocused ? '#fde047' : '#38bdf8'}
                      toneMapped={false}
                    />
                  </mesh>
                ))}

                {/* Waypoint control spheres when editing Flow / Path */}
                {isFocused &&
                  vis.worldWaypoints.map((wp, wpIdx) => {
                    const isFirst = wpIdx === 0;
                    const isLast = wpIdx === vis.worldWaypoints.length - 1;
                    const wpColor = isFirst
                      ? '#10b981'
                      : isLast
                        ? '#f59e0b'
                        : '#38bdf8';
                    return (
                      <mesh
                        key={wpIdx}
                        geometry={sharedGeoms.wpSphere}
                        position={wp}
                        raycast={() => null}
                      >
                        <meshBasicMaterial color={wpColor} toneMapped={false} />
                      </mesh>
                    );
                  })}
              </group>
            );
          })}

          {/* Connected Cross-Conveyor Routing Handoff Rings */}
          {edgeJunctions.map((ej) => (
            <mesh
              key={ej.id}
              geometry={sharedGeoms.edgeTorus}
              position={ej.midpoint}
              raycast={() => null}
            >
              <meshBasicMaterial
                color="#10b981"
                transparent
                opacity={0.85}
                toneMapped={false}
              />
            </mesh>
          ))}

          {/* PartSource (Feeder) Portals */}
          {spawnerPortals.map((sp) => (
            <group
              key={sp.id}
              position={sp.position}
              quaternion={sp.quaternion}
              raycast={() => null}
            >
              <mesh geometry={sharedGeoms.edgeTorus} scale={[1.9, 1.9, 1.9]} raycast={() => null}>
                <meshBasicMaterial
                  color="#10b981"
                  transparent
                  opacity={0.75}
                  toneMapped={false}
                />
              </mesh>
            </group>
          ))}

          {/* PartSink (Despawner) Portals */}
          {sinkPortals.map((sk) => (
            <group
              key={sk.id}
              position={sk.position}
              quaternion={sk.quaternion}
              raycast={() => null}
            >
              <mesh geometry={sharedGeoms.edgeTorus} scale={[1.9, 1.9, 1.9]} raycast={() => null}>
                <meshBasicMaterial
                  color="#a855f7"
                  transparent
                  opacity={0.78}
                  toneMapped={false}
                />
              </mesh>
            </group>
          ))}

          {/* 3D Photoelectric Laser & Proximity Path Sensors */}
          {sensorVisuals.map(({ sensor, position, quaternion }) => {
            if (sensor.sensorType === 'photoelectric') {
              const beamQuat = new THREE.Quaternion().setFromUnitVectors(UP_VEC, Z_VEC);
              return (
                <group
                  key={sensor.id}
                  position={position}
                  quaternion={quaternion}
                  raycast={() => null}
                >
                  {/* Emitter housing (-Z side) */}
                  <mesh position={[0, 0.085, -0.34]} raycast={() => null}>
                    <boxGeometry args={[0.042, 0.12, 0.042]} />
                    <meshStandardMaterial color="#1e293b" metalness={0.5} roughness={0.35} />
                  </mesh>
                  {/* Top status LED */}
                  <mesh position={[0, 0.155, -0.34]} raycast={() => null}>
                    <sphereGeometry args={[0.018, 12, 12]} />
                    <meshStandardMaterial
                      ref={(mat) => {
                        if (mat) sensorLedMatRefs.current.set(sensor.id, mat);
                        else sensorLedMatRefs.current.delete(sensor.id);
                      }}
                      color="#10b981"
                      emissive="#059669"
                      emissiveIntensity={0.45}
                    />
                  </mesh>
                  {/* Opposite Retro-Reflector (+Z side) */}
                  <mesh position={[0, 0.085, 0.34]} raycast={() => null}>
                    <boxGeometry args={[0.036, 0.09, 0.024]} />
                    <meshStandardMaterial color="#cbd5e1" metalness={0.7} roughness={0.2} />
                  </mesh>
                  {/* Live Through-Beam Laser */}
                  <mesh
                    position={[0, 0.085, 0]}
                    quaternion={[beamQuat.x, beamQuat.y, beamQuat.z, beamQuat.w]}
                    raycast={() => null}
                  >
                    <cylinderGeometry args={[0.0045, 0.0045, 0.66, 8]} />
                    <meshBasicMaterial
                      ref={(mat) => {
                        if (mat) sensorBeamMatRefs.current.set(sensor.id, mat);
                        else sensorBeamMatRefs.current.delete(sensor.id);
                      }}
                      color="#22d3ee"
                      transparent
                      opacity={0.44}
                      toneMapped={false}
                    />
                  </mesh>
                </group>
              );
            }

            // Inductive Proximity Sensor
            return (
              <group
                key={sensor.id}
                position={position}
                quaternion={quaternion}
                raycast={() => null}
              >
                <mesh position={[0, 0.008, 0]} raycast={() => null}>
                  <cylinderGeometry args={[0.036, 0.04, 0.018, 16]} />
                  <meshStandardMaterial
                    ref={(mat) => {
                      if (mat) sensorLedMatRefs.current.set(sensor.id, mat);
                      else sensorLedMatRefs.current.delete(sensor.id);
                    }}
                    color="#10b981"
                    emissive="#059669"
                    emissiveIntensity={0.45}
                  />
                </mesh>
              </group>
            );
          })}
        </>
      )}

      {/* 3. Interactive Belt-Elevation Spline Drawing Workplane */}
      {drawWorkplane && (
        <>
          <mesh
            position={drawWorkplane.center}
            rotation={[-Math.PI / 2, 0, 0]}
            onClick={handleWorkplaneClick}
            onPointerMove={(e) => {
              e.stopPropagation();
              setDrawHoverPos([e.point.x, e.point.y + 0.014, e.point.z]);
            }}
            onPointerOut={() => setDrawHoverPos(null)}
          >
            <planeGeometry args={drawWorkplane.size} />
            <meshBasicMaterial
              color="#06b6d4"
              transparent
              opacity={0.09}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>

          {drawHoverPos && (
            <mesh position={drawHoverPos} raycast={() => null}>
              <sphereGeometry args={[0.032, 14, 14]} />
              <meshBasicMaterial color="#22d3ee" toneMapped={false} />
            </mesh>
          )}
        </>
      )}
    </group>
  );
});
