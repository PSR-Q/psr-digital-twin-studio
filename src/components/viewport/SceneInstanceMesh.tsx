import { TransformControls } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { loadComponentGlbAsset } from '../../engine/glbAssetRegistry';
import {
  eulerDegToQuaternion,
  quaternionToEulerDeg,
  solveMagneticSnap,
} from '../../engine/snapEngine';
import type {
  ComponentDefinition,
  SceneNodeInstance,
  TransformData,
} from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';

interface SceneInstanceMeshProps {
  instance: SceneNodeInstance;
  component: ComponentDefinition;
}

const DEG2RAD = Math.PI / 180;

export function SceneInstanceMesh({ instance, component }: SceneInstanceMeshProps) {
  const [clonedModel, setClonedModel] = useState<THREE.Group | null>(null);
  const [proxyObj, setProxyObj] = useState<THREE.Group | null>(null);
  const isDraggingRef = useRef(false);

  const selectedInstanceId = useEditorStore((s) => s.selectedInstanceId);
  const gizmoMode = useEditorStore((s) => s.gizmoMode);
  const selectInstance = useEditorStore((s) => s.selectInstance);
  const updateInstanceTransform = useEditorStore((s) => s.updateInstanceTransform);
  const setGizmoDragging = useEditorStore((s) => s.setGizmoDragging);
  const setActiveSnapPreview = useEditorStore((s) => s.setActiveSnapPreview);
  const setStatusMessage = useEditorStore((s) => s.setStatusMessage);

  const isSelected = selectedInstanceId === instance.id;

  // Load binary .glb and clone scene graph for this instance
  useEffect(() => {
    let cancelled = false;
    loadComponentGlbAsset(component)
      .then((asset) => {
        if (cancelled) return;
        const cloned = asset.sceneTemplate.clone(true);
        setClonedModel(cloned);
      })
      .catch((err) => {
        console.error(`[Viewport] Failed to load GLB for ${component.name}:`, err);
      });

    return () => {
      cancelled = true;
    };
  }, [component]);

  // Keep decoupled Gizmo proxy synchronized with committed instance transform whenever not dragging
  useEffect(() => {
    if (!proxyObj || isDraggingRef.current) return;
    proxyObj.position.set(...instance.transform.position);
    proxyObj.quaternion.copy(eulerDegToQuaternion(instance.transform.rotationDeg));
    proxyObj.scale.set(...instance.transform.scale);
    proxyObj.updateMatrixWorld();
  }, [proxyObj, instance.transform]);

  // Selection wireframe box dimensions
  const selectionBox = useMemo(() => {
    const [sx, sy, sz] = component.boundingBox.size;
    const [minX, minY, minZ] = component.boundingBox.min;
    const [maxX, maxY, maxZ] = component.boundingBox.max;
    return {
      size: [sx + 0.04, sy + 0.04, sz + 0.04] as [number, number, number],
      center: [
        (minX + maxX) * 0.5,
        (minY + maxY) * 0.5,
        (minZ + maxZ) * 0.5,
      ] as [number, number, number],
    };
  }, [component.boundingBox]);

  const handleSelectClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    selectInstance(instance.id);
  };

  const handleGizmoObjectChange = () => {
    if (!proxyObj || !isDraggingRef.current) return;

    const rawPos: [number, number, number] = [
      Number(proxyObj.position.x.toFixed(4)),
      // Prevent accidental underground dragging below factory floor unless intentionally lifted
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

  if (!instance.visible) return null;

  const [rx, ry, rz] = instance.transform.rotationDeg;

  return (
    <>
      {/* Decoupled invisible Gizmo proxy so magnetic snapping never locks/fights mouse movement */}
      <group ref={setProxyObj} />

      {isSelected && !instance.locked && proxyObj && (
        <TransformControls
          object={proxyObj}
          mode={gizmoMode}
          size={0.82}
          onMouseDown={handleDragStart}
          onObjectChange={handleGizmoObjectChange}
          onMouseUp={handleDragEnd}
        />
      )}

      {/* Actual rendered 3D GLB Machine Instance */}
      <group
        position={instance.transform.position}
        rotation={[rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD]}
        scale={instance.transform.scale}
        onClick={handleSelectClick}
      >
        {clonedModel ? (
          <primitive object={clonedModel} />
        ) : (
          <mesh position={selectionBox.center}>
            <boxGeometry args={selectionBox.size} />
            <meshStandardMaterial color="#1e293b" wireframe />
          </mesh>
        )}

        {/* CAD Selection Bounding Highlight */}
        {isSelected && (
          <mesh position={selectionBox.center}>
            <boxGeometry args={selectionBox.size} />
            <meshBasicMaterial
              color={instance.locked ? '#f59e0b' : '#22d3ee'}
              wireframe
              transparent
              opacity={0.55}
            />
          </mesh>
        )}
      </group>
    </>
  );
}
