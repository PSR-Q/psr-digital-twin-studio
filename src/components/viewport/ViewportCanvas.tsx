import {
  GizmoHelper,
  GizmoViewport,
  Grid,
  OrbitControls,
} from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import * as THREE from 'three';
import { runtimeBusClient } from '../../engine/runtimeBusClient';
import type { ComponentDefinition, Vector3Tuple } from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';
import { SceneInstanceMesh } from './SceneInstanceMesh';
import { SnapPortIndicators } from './SnapPortIndicators';

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/**
 * Exposes a zero-overhead function to raycast screen pixel coordinates onto the Y=0 factory floor
 * when dropping .glb files or Asset Catalog items onto the Canvas.
 */
function DropRaycasterBridge({
  bridgeRef,
}: {
  bridgeRef: React.MutableRefObject<
    ((clientX: number, clientY: number) => Vector3Tuple) | null
  >;
}) {
  const { camera, gl } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  useEffect(() => {
    bridgeRef.current = (clientX: number, clientY: number): Vector3Tuple => {
      const rect = gl.domElement.getBoundingClientRect();
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      const hit = new THREE.Vector3();
      const intersected = raycaster.ray.intersectPlane(GROUND_PLANE, hit);
      if (!intersected) return [0, 0, 0];
      return [
        Math.max(-25, Math.min(25, hit.x)),
        0,
        Math.max(-25, Math.min(25, hit.z)),
      ];
    };
    return () => {
      bridgeRef.current = null;
    };
  }, [bridgeRef, camera, gl, raycaster]);

  // Read BinaryIpcBufferView inside R3F useFrame with ZERO React state re-renders (Spec §2.3)
  useFrame(() => {
    runtimeBusClient.readTelemetryFast();
  });

  return null;
}

export function ViewportCanvas() {
  const [isDragOver, setIsDragOver] = useState(false);
  const raycastDropRef = useRef<
    ((clientX: number, clientY: number) => Vector3Tuple) | null
  >(null);

  const instances = useEditorStore((s) => s.scene.instances);
  const library = useEditorStore((s) => s.scene.componentLibrary);
  const showGrid = useEditorStore((s) => s.scene.environment.showGrid);
  const isGizmoDragging = useEditorStore((s) => s.isGizmoDragging);
  const selectInstance = useEditorStore((s) => s.selectInstance);
  const spawnInstance = useEditorStore((s) => s.spawnInstance);
  const importGlbBuffer = useEditorStore((s) => s.importGlbBuffer);
  const loadSceneFromJsonString = useEditorStore((s) => s.loadSceneFromJsonString);
  const setStatusMessage = useEditorStore((s) => s.setStatusMessage);

  const catalogMap = useMemo(
    () => new Map<string, ComponentDefinition>(library.map((c) => [c.id, c])),
    [library]
  );

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  }, [isDragOver]);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);

      const dropPos: Vector3Tuple = raycastDropRef.current
        ? raycastDropRef.current(e.clientX, e.clientY)
        : [0, 0, 0];

      // Case 1: Dragged a catalog component card from Left Dock
      const catalogCompId = e.dataTransfer.getData('application/vc-component-id');
      if (catalogCompId) {
        spawnInstance(catalogCompId, dropPos);
        return;
      }

      // Case 2: Dragged external .glb / .gltf or .json file from OS Desktop / Explorer
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      for (const file of files) {
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
          const buffer = await file.arrayBuffer();
          await importGlbBuffer(file.name, buffer, {
            spawnInScene: true,
            dropPos,
          });
        } else if (lower.endsWith('.json')) {
          const text = await file.text();
          loadSceneFromJsonString(text, file.name);
        } else {
          setStatusMessage(
            `Unsupported file "${file.name}". Drop a .glb/.gltf model or .json layout.`
          );
        }
      }
    },
    [spawnInstance, importGlbBuffer, loadSceneFromJsonString, setStatusMessage]
  );

  return (
    <div
      id="vc-3d-viewport-container"
      className="vc-viewport-wrapper"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: [4.6, 3.6, 5.4], fov: 44, near: 0.08, far: 300 }}
        onPointerMissed={(e) => {
          if (e.type === 'click') selectInstance(null);
        }}
      >
        <color attach="background" args={['#0c1017']} />
        <fog attach="fog" args={['#0c1017', 28, 75]} />

        {/* Offline-safe 3-Point Industrial Studio Lighting (Zero external CDN dependencies) */}
        <ambientLight intensity={0.68} />
        <hemisphereLight args={['#cbd5e1', '#1e293b', 0.65]} />
        <directionalLight
          position={[9, 14, 8]}
          intensity={1.55}
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-camera-near={0.5}
          shadow-camera-far={45}
          shadow-camera-left={-12}
          shadow-camera-right={12}
          shadow-camera-top={12}
          shadow-camera-bottom={-12}
        />
        <directionalLight position={[-8, 6, -7]} intensity={0.52} color="#bae6fd" />

        <DropRaycasterBridge bridgeRef={raycastDropRef} />

        {/* Shadow-receiving industrial concrete floor plane */}
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, -0.002, 0]}
          receiveShadow
        >
          <planeGeometry args={[120, 120]} />
          <shadowMaterial transparent opacity={0.32} />
        </mesh>

        {/* Infinite Engineering Metric Floor Grid */}
        {showGrid && (
          <Grid
            position={[0, 0, 0]}
            args={[40, 40]}
            cellSize={0.5}
            cellThickness={0.6}
            cellColor="#1e293b"
            sectionSize={2.0}
            sectionThickness={1.15}
            sectionColor="#334155"
            fadeDistance={42}
            fadeStrength={1.2}
            infiniteGrid
          />
        )}

        {/* World Origin Triad Marker (0, 0, 0) */}
        <axesHelper args={[0.45]} />

        {/* Placed 3D .glb Machine Instances */}
        {instances.map((inst) => {
          const comp = catalogMap.get(inst.componentId);
          if (!comp) return null;
          return (
            <SceneInstanceMesh
              key={inst.id}
              instance={inst}
              component={comp}
            />
          );
        })}

        {/* Magnetic SnapPort Cones, Locked Collars & Live Docking Beacon */}
        <SnapPortIndicators />

        <OrbitControls
          makeDefault
          enabled={!isGizmoDragging}
          enableDamping
          dampingFactor={0.08}
          maxPolarAngle={Math.PI / 2 - 0.01}
          minDistance={0.6}
          maxDistance={65}
        />

        <GizmoHelper alignment="bottom-right" margin={[70, 70]}>
          <GizmoViewport
            axisColors={['#ef4444', '#22c55e', '#3b82f6']}
            labelColor="#f8fafc"
          />
        </GizmoHelper>
      </Canvas>

      {/* Viewport HUD Overlay */}
      <div className="vc-viewport-hud-top-left">
        <span className="vc-hud-pill">PERSPECTIVE · Y-UP · METRIC (m)</span>
        <span className="vc-hud-pill vc-hud-pill-muted">
          LMB Select/Gizmo · RMB Pan · Scroll Zoom · Drop .GLB Anywhere
        </span>
      </div>

      {/* Drag-and-Drop Visual Target Overlay */}
      {isDragOver && (
        <div className="vc-dropzone-overlay">
          <div className="vc-dropzone-card">
            <Upload size={28} />
            <div>
              <div className="vc-dropzone-title">
                Drop 3D Machine (.glb / .gltf) or Scene (.json)
              </div>
              <div className="vc-dropzone-sub">
                Models automatically generate Input/Output SnapPorts and land on the 3D cursor floor point
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
