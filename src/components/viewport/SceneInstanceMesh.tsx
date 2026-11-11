import { TransformControls } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { clone as cloneSceneWithSkeletons } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadComponentGlbAsset } from '../../engine/glbAssetRegistry';
import {
  buildKinematicsRig,
  stepKinematicsRig,
  type KinematicsInstanceRig,
} from '../../engine/kinematicsEngine';
import { runtimeBusClient } from '../../engine/runtimeBusClient';
import {
  eulerDegToQuaternion,
  quaternionToEulerDeg,
  solveMagneticSnap,
} from '../../engine/snapEngine';
import type {
  ComponentDefinition,
  SceneNodeInstance,
  TransformData,
  Vector3Tuple,
} from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';

interface SceneInstanceMeshProps {
  instance: SceneNodeInstance;
  component: ComponentDefinition;
}

const DEG2RAD = Math.PI / 180;
const UP_VEC = new THREE.Vector3(0, 1, 0);

function normalizeVec(v: Vector3Tuple): THREE.Vector3 {
  const vec = new THREE.Vector3(v[0], v[1], v[2]);
  return vec.lengthSq() < 1e-8 ? new THREE.Vector3(0, 1, 0) : vec.normalize();
}

export function SceneInstanceMesh({ instance, component }: SceneInstanceMeshProps) {
  const [clonedModel, setClonedModel] = useState<THREE.Group | null>(null);
  const [proxyObj, setProxyObj] = useState<THREE.Group | null>(null);
  const [rigVersion, setRigVersion] = useState(0);
  const isDraggingRef = useRef(false);
  const rigRef = useRef<KinematicsInstanceRig | null>(null);
  const subMeshHighlightGroupRef = useRef<THREE.Group | null>(null);

  const selectedInstanceId = useEditorStore((s) => s.selectedInstanceId);
  const selectedSubMeshName = useEditorStore((s) =>
    s.selectedInstanceId === instance.id ? s.selectedSubMeshName : null
  );
  const gizmoMode = useEditorStore((s) => s.gizmoMode);
  const selectInstance = useEditorStore((s) => s.selectInstance);
  const selectSubMesh = useEditorStore((s) => s.selectSubMesh);
  const setInspectorTab = useEditorStore((s) => s.setInspectorTab);
  const updateInstanceTransform = useEditorStore((s) => s.updateInstanceTransform);
  const setGizmoDragging = useEditorStore((s) => s.setGizmoDragging);
  const setActiveSnapPreview = useEditorStore((s) => s.setActiveSnapPreview);
  const setStatusMessage = useEditorStore((s) => s.setStatusMessage);

  // Primitive string selector so Force value changes NEVER trigger React re-renders in 3D!
  const bindingSlotSignature = useEditorStore((s) =>
    s.scene.plcTagMap.bindings
      .filter((b) => b.instanceId === instance.id)
      .map((b) => `${b.componentSignalKey}@${b.bufferSlotIndex}`)
      .join('|')
  );

  const isSelected = selectedInstanceId === instance.id;

  // Load binary .glb / OpenUSD (.usd/.usda/.usdc/.usdz) and clone scene graph (including SkinnedMesh rigs)
  useEffect(() => {
    let cancelled = false;
    loadComponentGlbAsset(component)
      .then((asset) => {
        if (cancelled) return;
        const cloned = cloneSceneWithSkeletons(asset.sceneTemplate) as THREE.Group;
        setClonedModel(cloned);
      })
      .catch((err) => {
        console.error(`[Viewport] Failed to load 3D model for ${component.name}:`, err);
      });

    return () => {
      cancelled = true;
    };
    // Only reload binary asset if underlying URI or embedded byte payload changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    component.id,
    component.modelSource.uri,
    component.modelSource.byteLength,
  ]);

  // Build / rebuild Component-Space Forward Kinematics rig when model, roles, or slot indices change
  useEffect(() => {
    if (!clonedModel) {
      rigRef.current = null;
      return;
    }
    const store = useEditorStore.getState();
    const instanceBindings = store.scene.plcTagMap.bindings.filter(
      (b) => b.instanceId === instance.id
    );
    rigRef.current = buildKinematicsRig(
      instance.id,
      clonedModel,
      component,
      instanceBindings
    );
    setRigVersion((v) => v + 1);
  }, [
    clonedModel,
    component,
    component.nodeRoles,
    instance.id,
    bindingSlotSignature,
  ]);

  // Step 60–144Hz Forward Kinematics & Industrial Actuators with ZERO React state updates
  useFrame((_, delta) => {
    const rig = rigRef.current;
    if (!rig) return;

    const store = useEditorStore.getState();
    stepKinematicsRig(
      rig,
      runtimeBusClient.bufferView,
      store.runState,
      store.scene.environment.simSpeedMultiplier,
      delta,
      store.jogPreview
    );

    if (
      subMeshHighlightGroupRef.current &&
      store.selectedInstanceId === instance.id &&
      store.selectedSubMeshName
    ) {
      const rec = rig.nodeRecords.get(store.selectedSubMeshName);
      if (rec) {
        subMeshHighlightGroupRef.current.matrix.copy(rec.deltaTotalComp);
        subMeshHighlightGroupRef.current.matrixWorldNeedsUpdate = true;
      }
    }
  });

  // Keep decoupled Gizmo proxy synchronized with committed instance transform whenever not dragging
  useEffect(() => {
    if (!proxyObj || isDraggingRef.current) return;
    proxyObj.position.set(...instance.transform.position);
    proxyObj.quaternion.copy(eulerDegToQuaternion(instance.transform.rotationDeg));
    proxyObj.scale.set(...instance.transform.scale);
    proxyObj.updateMatrixWorld();
  }, [proxyObj, instance.transform]);

  // Clean 12-edge CAD selection box (lifted above Y=0 floor to prevent grid line Z-fighting)
  const selectionBox = useMemo(() => {
    const [sx, , sz] = component.boundingBox.size;
    const [minX, minY, minZ] = component.boundingBox.min;
    const [maxX, maxY, maxZ] = component.boundingBox.max;
    const paddedMinY = minY >= -0.005 ? Math.max(0.004, minY) : minY - 0.02;
    const paddedMaxY = maxY + 0.02;
    const boxHeight = Math.max(0.02, paddedMaxY - paddedMinY);

    const boxGeom = new THREE.BoxGeometry(sx + 0.04, boxHeight, sz + 0.04);
    const edgesGeometry = new THREE.EdgesGeometry(boxGeom);
    boxGeom.dispose();

    return {
      edgesGeometry,
      center: [
        (minX + maxX) * 0.5,
        (paddedMinY + paddedMaxY) * 0.5,
        (minZ + maxZ) * 0.5,
      ] as [number, number, number],
    };
  }, [component.boundingBox]);

  useEffect(() => {
    return () => {
      selectionBox.edgesGeometry.dispose();
    };
  }, [selectionBox]);

  // 12-edge Amber Sub-Mesh Highlight + 3D Kinematic Axis Vector / Rotary Ring Preview
  const subMeshOverlay = useMemo(() => {
    if (!isSelected || !selectedSubMeshName || !rigRef.current) return null;
    const rec = rigRef.current.nodeRecords.get(selectedSubMeshName);
    if (!rec) return null;

    const [sx, sy, sz] = rec.restBoundsComp.size;
    const [cx, cy, cz] = rec.restBoundsComp.center;
    const boxGeom = new THREE.BoxGeometry(
      Math.max(0.02, sx + 0.016),
      Math.max(0.02, sy + 0.016),
      Math.max(0.02, sz + 0.016)
    );
    const edgesGeometry = new THREE.EdgesGeometry(boxGeom);
    boxGeom.dispose();

    const role = component.nodeRoles[selectedSubMeshName];
    let axisQuaternion: [number, number, number, number] | null = null;
    let ringQuaternion: [number, number, number, number] | null = null;
    let arrowLength = 0.28;
    let pivotPos: [number, number, number] = [cx, cy, cz];

    if (role?.role === 'LinearAxis') {
      const dir = normalizeVec(role.axis);
      const q = new THREE.Quaternion().setFromUnitVectors(UP_VEC, dir);
      axisQuaternion = [q.x, q.y, q.z, q.w];
      const strokeM = Math.abs(role.maxLimitMm - role.minLimitMm) * 0.001;
      arrowLength = Math.max(0.18, Math.min(0.85, strokeM + 0.1));
    } else if (role?.role === 'RotaryAxis') {
      const dir = normalizeVec(role.axis);
      const qShaft = new THREE.Quaternion().setFromUnitVectors(UP_VEC, dir);
      // Torus lies in XY plane (normal +Z) by default; align +Z with rotation axis
      const qRing = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        dir
      );
      axisQuaternion = [qShaft.x, qShaft.y, qShaft.z, qShaft.w];
      ringQuaternion = [qRing.x, qRing.y, qRing.z, qRing.w];
      const [ox, oy, oz] = role.pivotOffset ?? [0, 0, 0];
      pivotPos = [cx + ox, cy + oy, cz + oz];
      arrowLength = Math.max(0.2, Math.min(0.6, Math.max(sx, sz) * 0.55));
    }

    return {
      edgesGeometry,
      center: [cx, cy, cz] as [number, number, number],
      role,
      axisQuaternion,
      ringQuaternion,
      arrowLength,
      pivotPos,
      ringRadius: Math.max(0.12, Math.min(0.55, Math.max(sx, sy, sz) * 0.52)),
    };
    // rigVersion ensures overlay refreshes immediately once rig finishes building
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSelected, selectedSubMeshName, component.nodeRoles, rigVersion]);

  useEffect(() => {
    return () => {
      subMeshOverlay?.edgesGeometry.dispose();
    };
  }, [subMeshOverlay]);

  const resolveClickedSubMeshName = (hitObj: THREE.Object3D): string | null => {
    let curr: THREE.Object3D | null = hitObj;
    let fallbackMeshName: string | null = null;
    while (curr && curr !== clonedModel) {
      if (curr.name) {
        if (!fallbackMeshName) fallbackMeshName = curr.name;
        if (component.nodeRoles[curr.name]) {
          return curr.name;
        }
      }
      curr = curr.parent;
    }
    return fallbackMeshName;
  };

  const handleSelectClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (isDraggingRef.current || e.delta > 5) return;

    const store = useEditorStore.getState();

    // Milestone 3: Interactive 3D Spline Waypoint placement directly on conveyor mesh surface
    if (store.isDrawingSplinePath && isSelected) {
      store.appendSplineWaypointWorld(instance.id, [
        e.point.x,
        e.point.y,
        e.point.z,
      ]);
      return;
    }

    const pickedSubMesh = resolveClickedSubMeshName(e.object);

    if (!isSelected) {
      selectInstance(instance.id);
      if (store.inspectorTab === 'builder' && pickedSubMesh) {
        selectSubMesh(pickedSubMesh);
      }
      return;
    }

    // Already selected: pick clicked sub-mesh so user can inspect/configure it
    if (pickedSubMesh) {
      selectSubMesh(pickedSubMesh);
      const roleType = component.nodeRoles[pickedSubMesh]?.role ?? 'StaticMesh';
      setStatusMessage(
        `Selected sub-mesh "${pickedSubMesh}" (${roleType}) — open Builder tab or double-click part to configure Linear/Rotary joint.`
      );
    }
  };

  const handleDoubleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (isDraggingRef.current) return;
    selectInstance(instance.id);
    const pickedSubMesh = resolveClickedSubMeshName(e.object);
    setInspectorTab('builder');
    if (pickedSubMesh) {
      selectSubMesh(pickedSubMesh);
      setStatusMessage(
        `Editing "${pickedSubMesh}" in Component Builder — choose LinearAxis, RotaryAxis, or VisualEffect.`
      );
    }
  };

  const handleGizmoObjectChange = () => {
    if (!proxyObj || !isDraggingRef.current) return;

    const rawPos: [number, number, number] = [
      Number(proxyObj.position.x.toFixed(4)),
      Number(Math.max(0, proxyObj.position.y).toFixed(4)),
      Number(proxyObj.position.z.toFixed(4)),
    ];
    const rawRot = quaternionToEulerDeg(proxyObj.quaternion);
    const rawScale: [number, number, number] = [
      Number(Math.max(0.05, proxyObj.scale.x).toFixed(4)),
      Number(Math.max(0.05, proxyObj.scale.y).toFixed(4)),
      Number(Math.max(0.05, proxyObj.scale.z).toFixed(4)),
    ];

    const candidateTransform: TransformData = {
      position: rawPos,
      rotationDeg: rawRot,
      scale: rawScale,
    };

    const store = useEditorStore.getState();
    const env = store.scene.environment;

    if (gizmoMode === 'translate' && env.snapEnabled) {
      const catalogMap = new Map(
        store.scene.componentLibrary.map((c) => [c.id, c])
      );
      const snapResult = solveMagneticSnap({
        movingInstanceId: instance.id,
        movingComponent: component,
        candidateTransform,
        otherInstances: store.scene.instances,
        catalogMap,
        snapRadiusMeters: env.snapRadiusMeters,
        autoAlignRotation: env.autoAlignPortRotation,
      });

      if (snapResult.snapped) {
        setActiveSnapPreview(snapResult);
        updateInstanceTransform(instance.id, snapResult.transform, false);
        return;
      }
    }

    if (store.activeSnapPreview !== null) {
      setActiveSnapPreview(null);
    }
    updateInstanceTransform(instance.id, candidateTransform, false);
  };

  const handleDragStart = () => {
    isDraggingRef.current = true;
    setGizmoDragging(true);
  };

  const handleDragEnd = () => {
    isDraggingRef.current = false;
    const store = useEditorStore.getState();
    const latestInst = store.scene.instances.find((i) => i.id === instance.id);
    const lastSnap = store.activeSnapPreview;

    if (latestInst) {
      updateInstanceTransform(instance.id, latestInst.transform, true);
      if (proxyObj) {
        proxyObj.position.set(...latestInst.transform.position);
        proxyObj.quaternion.copy(
          eulerDegToQuaternion(latestInst.transform.rotationDeg)
        );
        proxyObj.scale.set(...latestInst.transform.scale);
      }
      if (lastSnap?.snapped) {
        setStatusMessage(
          `Snapped "${latestInst.name}" (${lastSnap.sourcePort?.name}) -> "${lastSnap.targetInstanceName}" (${lastSnap.targetPort?.name})`
        );
      }
    }

    setActiveSnapPreview(null);
    setGizmoDragging(false);
  };

  const isDrawingSplinePath = useEditorStore(
    (s) => isSelected && s.isDrawingSplinePath
  );

  if (!instance.visible) return null;

  const [rx, ry, rz] = instance.transform.rotationDeg;

  return (
    <>
      {/* Decoupled invisible Gizmo proxy so magnetic snapping never locks/fights mouse movement */}
      <group ref={setProxyObj} />

      {isSelected && !instance.locked && !isDrawingSplinePath && proxyObj && (
        <TransformControls
          object={proxyObj}
          mode={gizmoMode}
          size={0.82}
          onMouseDown={handleDragStart}
          onObjectChange={handleGizmoObjectChange}
          onMouseUp={handleDragEnd}
        />
      )}

      {/* Actual rendered 3D GLB / OpenUSD Machine Instance */}
      <group
        position={instance.transform.position}
        rotation={[rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD]}
        scale={instance.transform.scale}
        onClick={handleSelectClick}
        onDoubleClick={handleDoubleClick}
      >
        {clonedModel ? (
          <primitive object={clonedModel} />
        ) : (
          <lineSegments
            position={selectionBox.center}
            geometry={selectionBox.edgesGeometry}
          >
            <lineBasicMaterial color="#334155" />
          </lineSegments>
        )}

        {/* CAD Selection Bounding Box (12 outer edges only, no diagonal lines) */}
        {isSelected && (
          <lineSegments
            position={selectionBox.center}
            geometry={selectionBox.edgesGeometry}
            raycast={() => null}
          >
            <lineBasicMaterial
              color={instance.locked ? '#f59e0b' : '#22d3ee'}
              transparent
              opacity={selectedSubMeshName ? 0.42 : 0.8}
              toneMapped={false}
            />
          </lineSegments>
        )}

        {/* Milestone 2: Sub-Mesh Highlight Box + 3D Linear/Rotary Axis Preview */}
        {subMeshOverlay && (
          <>
            {/* Moving 12-edge Amber Sub-Mesh Wireframe Box */}
            <group ref={subMeshHighlightGroupRef} matrixAutoUpdate={false}>
              <lineSegments
                position={subMeshOverlay.center}
                geometry={subMeshOverlay.edgesGeometry}
                raycast={() => null}
              >
                <lineBasicMaterial
                  color="#f59e0b"
                  transparent
                  opacity={0.95}
                  toneMapped={false}
                />
              </lineSegments>
            </group>

            {/* 3D LinearAxis Travel Vector Arrow */}
            {subMeshOverlay.role?.role === 'LinearAxis' &&
              subMeshOverlay.axisQuaternion && (
                <group
                  position={subMeshOverlay.pivotPos}
                  quaternion={subMeshOverlay.axisQuaternion}
                >
                  <mesh
                    position={[0, subMeshOverlay.arrowLength * 0.5, 0]}
                    raycast={() => null}
                  >
                    <cylinderGeometry
                      args={[0.008, 0.008, subMeshOverlay.arrowLength, 12]}
                    />
                    <meshBasicMaterial color="#f59e0b" toneMapped={false} />
                  </mesh>
                  <mesh
                    position={[0, subMeshOverlay.arrowLength + 0.03, 0]}
                    raycast={() => null}
                  >
                    <coneGeometry args={[0.026, 0.065, 14]} />
                    <meshBasicMaterial color="#fbbf24" toneMapped={false} />
                  </mesh>
                </group>
              )}

            {/* 3D RotaryAxis Spindle & Orbit Ring */}
            {subMeshOverlay.role?.role === 'RotaryAxis' &&
              subMeshOverlay.axisQuaternion &&
              subMeshOverlay.ringQuaternion && (
                <group position={subMeshOverlay.pivotPos}>
                  <mesh
                    quaternion={subMeshOverlay.axisQuaternion}
                    raycast={() => null}
                  >
                    <cylinderGeometry
                      args={[0.007, 0.007, subMeshOverlay.arrowLength * 1.4, 12]}
                    />
                    <meshBasicMaterial color="#22d3ee" toneMapped={false} />
                  </mesh>
                  <mesh
                    quaternion={subMeshOverlay.ringQuaternion}
                    raycast={() => null}
                  >
                    <torusGeometry
                      args={[subMeshOverlay.ringRadius, 0.007, 10, 48]}
                    />
                    <meshBasicMaterial color="#22d3ee" toneMapped={false} />
                  </mesh>
                </group>
              )}
          </>
        )}
      </group>
    </>
  );
}
