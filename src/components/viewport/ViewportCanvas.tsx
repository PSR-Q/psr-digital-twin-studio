import {
  GizmoHelper,
  GizmoViewport,
  Grid,
  OrbitControls,
} from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Upload } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import * as THREE from 'three';
import {
  configureGlbRendererSupport,
  isSupported3dModelFile,
} from '../../engine/glbAssetRegistry';
import { runtimeBusClient } from '../../engine/runtimeBusClient';
import type { ComponentDefinition, Vector3Tuple } from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';
import { SceneInstanceMesh } from './SceneInstanceMesh';
import { SnapPortIndicators } from './SnapPortIndicators';

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const GRID_PLANE_ARGS: [number, number] = [40, 40];

/**
 * Isolated & memoized Floor + Infinite Grid layer.
 * Never re-renders when dragging 3D instances, eliminating geometry recreation flicker,
 * and disables depthWrite on the shadow plane to eliminate Z-fighting during camera orbit.
 */
const SceneFloor = memo(function SceneFloor() {
  const showGrid = useEditorStore((s) => s.scene.environment.showGrid);

  return (
    <group name="FactoryFloorGroup">
      {/* Shadow-receiving plane with depthWrite=false so it never Z-fights with the Y=0 Grid */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.008, 0]}
        renderOrder={-2}
        receiveShadow
      >
        <planeGeometry args={[120, 120]} />
        <shadowMaterial
          transparent
          opacity={0.28}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={4}
          polygonOffsetUnits={4}
        />
      </mesh>

      {/* Anti-aliased Infinite Engineering Metric Floor Grid */}
      {showGrid && (
        <Grid
          args={GRID_PLANE_ARGS}
          renderOrder={-1}
          cellSize={0.5}
          cellThickness={1.0}
          cellColor="#1b2432"
          sectionSize={2.0}
          sectionThickness={1.35}
          sectionColor="#2e3d52"
          fadeDistance={32}
          fadeStrength={2.2}
          side={THREE.DoubleSide}
          infiniteGrid
        />
      )}

      {/* World Origin Triad Marker lifted 4mm above floor to prevent coplanar line Z-fighting */}
      <axesHelper args={[0.45]} position={[0, 0.004, 0]} />
    </group>
  );
});

/**
 * Isolated 3D Machine Instances layer so transform updates during Gizmo drag
 * only reconcile SceneInstanceMesh items without re-rendering Canvas, Lights, or Grid.
 */
const SceneInstancesLayer = memo(function SceneInstancesLayer() {
  const instances = useEditorStore((s) => s.scene.instances);
  const library = useEditorStore((s) => s.scene.componentLibrary);

  const catalogMap = useMemo(
    () => new Map<string, ComponentDefinition>(library.map((c) => [c.id, c])),
    [library]
  );

  return (
    <>
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
    </>
  );
});

const CameraOrbitController = memo(function CameraOrbitController() {
  const isGizmoDragging = useEditorStore((s) => s.isGizmoDragging);
  return (
    <OrbitControls
      makeDefault
      enabled={!isGizmoDragging}
      enableDamping
      dampingFactor={0.08}
      maxPolarAngle={Math.PI / 2 - 0.015}
      minDistance={0.6}
      maxDistance={60}
    />
  );
});

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
    configureGlbRendererSupport(gl);
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

  const selectInstance = useEditorStore((s) => s.selectInstance);
  const spawnInstance = useEditorStore((s) => s.spawnInstance);
  const importGlbBuffer = useEditorStore((s) => s.importGlbBuffer);
  const loadSceneFromJsonString = useEditorStore((s) => s.loadSceneFromJsonString);
  const setStatusMessage = useEditorStore((s) => s.setStatusMessage);

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!isDragOver) setIsDragOver(true);
    },
    [isDragOver]
  );

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

      // Case 2: Dragged external 3D model (.glb/.gltf/.usd/.usda/.usdc/.usdz) or .json scene from OS
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      for (const file of files) {
        const lower = file.name.toLowerCase();
        if (isSupported3dModelFile(file.name)) {
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
            `Unsupported file "${file.name}". Drop a .glb/.gltf, OpenUSD (.usd/.usda/.usdc/.usdz), or .json layout.`
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
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ position: [4.6, 3.6, 5.4], fov: 44, near: 0.15, far: 160 }}
        onPointerMissed={(e) => {
          if (e.type === 'click') selectInstance(null);
        }}
      >
        <color attach="background" args={['#0c1017']} />
        <fog attach="fog" args={['#0c1017', 26, 68]} />

        {/* Offline-safe 3-Point Industrial Studio Lighting */}
        <ambientLight intensity={0.68} />
        <hemisphereLight args={['#cbd5e1', '#1e293b', 0.65]} />
        <directionalLight
          position={[9, 14, 8]}
          intensity={1.55}
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-bias={-0.0002}
          shadow-camera-near={0.5}
          shadow-camera-far={45}
          shadow-camera-left={-12}
          shadow-camera-right={12}
          shadow-camera-top={12}
          shadow-camera-bottom={-12}
        />
        <directionalLight position={[-8, 6, -7]} intensity={0.52} color="#bae6fd" />

        <DropRaycasterBridge bridgeRef={raycastDropRef} />
        <SceneFloor />
        <SceneInstancesLayer />
        <SnapPortIndicators />
        <CameraOrbitController />

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
          LMB Select/Gizmo · RMB Pan · Scroll Zoom · Drop .GLB / OpenUSD Anywhere
        </span>
      </div>

      {/* Drag-and-Drop Visual Target Overlay */}
      {isDragOver && (
        <div className="vc-dropzone-overlay">
          <div className="vc-dropzone-card">
            <Upload size={28} />
            <div>
              <div className="vc-dropzone-title">
                Drop 3D Machine (.glb / .gltf / OpenUSD .usd .usda .usdc .usdz) or Scene (.json)
              </div>
              <div className="vc-dropzone-sub">
                glTF & OpenUSD stages (including Z-up & metric units) auto-generate Input/Output SnapPorts on the floor
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
