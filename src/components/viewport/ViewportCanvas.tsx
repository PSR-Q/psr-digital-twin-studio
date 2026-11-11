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
import { transportRuntime } from '../../engine/transportEngine';
import { resolveViewportTheme } from '../../engine/viewportTheme';
import type { ComponentDefinition, Vector3Tuple } from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';
import { SceneInstanceMesh } from './SceneInstanceMesh';
import { SnapPortIndicators } from './SnapPortIndicators';
import { TransportFlowOverlay } from './TransportFlowOverlay';

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const GRID_PLANE_ARGS: [number, number] = [40, 40];

/**
 * SketchUp-style extended World Origin RGB Axes:
 * Solid positive rays (+X Red, +Y Green Up, +Z Blue) & dashed negative rays (-X, -Z),
 * lifted 4mm with depthWrite=false so they never Z-fight or intercept pointer clicks.
 */
const SketchUpOriginAxes = memo(function SketchUpOriginAxes({
  isLight,
}: {
  isLight: boolean;
}) {
  const axesGroup = useMemo(() => {
    const group = new THREE.Group();
    group.name = 'SketchUpOriginAxes';

    const xColor = isLight ? '#dc2626' : '#ef4444';
    const yColor = isLight ? '#16a34a' : '#22c55e';
    const zColor = isLight ? '#2563eb' : '#3b82f6';
    const solidOpacity = isLight ? 0.88 : 0.85;
    const dashedOpacity = isLight ? 0.42 : 0.36;

    const addSolidRay = (
      from: [number, number, number],
      to: [number, number, number],
      color: string
    ) => {
      const geom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...from),
        new THREE.Vector3(...to),
      ]);
      const mat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: solidOpacity,
        depthWrite: false,
        toneMapped: false,
      });
      const line = new THREE.Line(geom, mat);
      line.renderOrder = 0;
      line.raycast = () => {};
      group.add(line);
    };

    const addDashedRay = (
      from: [number, number, number],
      to: [number, number, number],
      color: string
    ) => {
      const geom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...from),
        new THREE.Vector3(...to),
      ]);
      const mat = new THREE.LineDashedMaterial({
        color,
        dashSize: 0.14,
        gapSize: 0.1,
        transparent: true,
        opacity: dashedOpacity,
        depthWrite: false,
        toneMapped: false,
      });
      const line = new THREE.Line(geom, mat);
      line.computeLineDistances();
      line.renderOrder = 0;
      line.raycast = () => {};
      group.add(line);
    };

    const yLift = 0.004;
    addSolidRay([0, yLift, 0], [22, yLift, 0], xColor);
    addDashedRay([0, yLift, 0], [-22, yLift, 0], xColor);
    addSolidRay([0, yLift, 0], [0, yLift, 22], zColor);
    addDashedRay([0, yLift, 0], [0, yLift, -22], zColor);
    addSolidRay([0, 0, 0], [0, 8, 0], yColor);

    return group;
  }, [isLight]);

  useEffect(() => {
    return () => {
      axesGroup.traverse((obj) => {
        if (obj instanceof THREE.Line) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
    };
  }, [axesGroup]);

  return <primitive object={axesGroup} />;
});

/**
 * Isolated & memoized Floor + Infinite Grid + SketchUp Origin Axes layer.
 * Never re-renders when dragging 3D instances, eliminating geometry recreation flicker,
 * and disables depthWrite on the floor & shadow planes to eliminate Z-fighting during camera orbit.
 */
const SceneFloor = memo(function SceneFloor() {
  const showGrid = useEditorStore((s) => s.scene.environment.showGrid);
  const showOriginAxes = useEditorStore(
    (s) => s.scene.environment.showOriginAxes !== false
  );
  const viewportTheme = useEditorStore(
    (s) => s.scene.environment.viewportTheme ?? 'sketchup-white'
  );
  const customBg = useEditorStore(
    (s) => s.scene.environment.customBackgroundColor ?? '#ffffff'
  );
  const customFloor = useEditorStore(
    (s) => s.scene.environment.customFloorColor ?? '#ffffff'
  );

  const theme = useMemo(
    () =>
      resolveViewportTheme({
        viewportTheme,
        customBackgroundColor: customBg,
        customFloorColor: customFloor,
      }),
    [viewportTheme, customBg, customFloor]
  );

  return (
    <group name="FactoryFloorGroup">
      {/* Horizon ground plane when Sky color differs from Ground color (e.g. SketchUp Sky + White Ground) */}
      {theme.hasDistinctGroundPlane && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, -0.016, 0]}
          renderOrder={-3}
          raycast={() => null}
        >
          <circleGeometry args={[180, 72]} />
          <meshBasicMaterial
            color={theme.floorColor}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}

      {/* Shadow-receiving plane with depthWrite=false so it never Z-fights with the Y=0 Grid */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.008, 0]}
        renderOrder={-2}
        receiveShadow
        raycast={() => null}
      >
        <planeGeometry args={[120, 120]} />
        <shadowMaterial
          color="#0f172a"
          transparent
          opacity={theme.shadowOpacity}
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
          cellColor={theme.gridCellColor}
          sectionSize={2.0}
          sectionThickness={1.35}
          sectionColor={theme.gridSectionColor}
          fadeDistance={34}
          fadeStrength={2.1}
          side={THREE.DoubleSide}
          infiniteGrid
        />
      )}

      {/* SketchUp-style Extended RGB Origin Axes */}
      {showOriginAxes && <SketchUpOriginAxes isLight={theme.isLight} />}
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

interface ViewportRayBridge {
  raycastFloor: (clientX: number, clientY: number) => Vector3Tuple;
  getCameraRay: (
    clientX: number,
    clientY: number
  ) => { origin: Vector3Tuple; direction: Vector3Tuple };
}

/**
 * Exposes zero-overhead functions to compute 3D camera rays (for elevated conveyor spline
 * workpiece drops) and Y=0 factory floor intersections (for machine & .glb/.usd drops).
 */
function DropRaycasterBridge({
  bridgeRef,
}: {
  bridgeRef: React.MutableRefObject<ViewportRayBridge | null>;
}) {
  const { camera, gl } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  useEffect(() => {
    configureGlbRendererSupport(gl);
    bridgeRef.current = {
      raycastFloor: (clientX: number, clientY: number): Vector3Tuple => {
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
      },
      getCameraRay: (clientX: number, clientY: number) => {
        const rect = gl.domElement.getBoundingClientRect();
        const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
        return {
          origin: [
            raycaster.ray.origin.x,
            raycaster.ray.origin.y,
            raycaster.ray.origin.z,
          ],
          direction: [
            raycaster.ray.direction.x,
            raycaster.ray.direction.y,
            raycaster.ray.direction.z,
          ],
        };
      },
    };
    return () => {
      bridgeRef.current = null;
    };
  }, [bridgeRef, camera, gl, raycaster]);

  const ipcPushAccumRef = useRef(0);

  // Read BinaryIpcBufferView inside R3F useFrame with ZERO React state re-renders (Spec §2.3)
  useFrame((_, delta) => {
    runtimeBusClient.readTelemetryFast();
    ipcPushAccumRef.current += delta;
    if (ipcPushAccumRef.current >= 0.02) {
      ipcPushAccumRef.current = 0;
      runtimeBusClient.pushSimInputsToWorker();
    }
  });

  return null;
}

export function ViewportCanvas() {
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [workpieceAimText, setWorkpieceAimText] = useState<string | null>(null);
  const lastAimTextRef = useRef<string | null>(null);
  const raycastDropRef = useRef<ViewportRayBridge | null>(null);

  const selectInstance = useEditorStore((s) => s.selectInstance);
  const spawnInstance = useEditorStore((s) => s.spawnInstance);
  const dropWorkpieceByRay = useEditorStore((s) => s.dropWorkpieceByRay);
  const importGlbBuffer = useEditorStore((s) => s.importGlbBuffer);
  const loadSceneFromJsonString = useEditorStore((s) => s.loadSceneFromJsonString);
  const setStatusMessage = useEditorStore((s) => s.setStatusMessage);

  const updateAimTextDeduped = useCallback((next: string | null) => {
    if (lastAimTextRef.current === next) return;
    lastAimTextRef.current = next;
    setWorkpieceAimText(next);
  }, []);

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';

      const types = Array.from(e.dataTransfer.types);
      const isWorkpieceDrag =
        types.includes('application/vc-workpiece-preset') ||
        types.includes('application/vc-workpiece-component-id');

      if (isWorkpieceDrag) {
        if (isFileDragOver) setIsFileDragOver(false);
        const bridge = raycastDropRef.current;
        if (bridge) {
          const ray = bridge.getCameraRay(e.clientX, e.clientY);
          const st = useEditorStore.getState();
          const hit = transportRuntime.findClosestBeltPointFromRay({
            rayOrigin: ray.origin,
            rayDirection: ray.direction,
            graph: st.scene.transportGraph,
            instances: st.scene.instances,
            componentLibrary: st.scene.componentLibrary,
            bindings: st.scene.plcTagMap.bindings,
            bufferView: runtimeBusClient.bufferView,
            maxCaptureRadiusMeters: 0.92,
          });
          transportRuntime.setDragPreviewHit(hit);

          if (hit) {
            const instName =
              st.scene.instances.find((i) => i.id === hit.instanceId)?.name ??
              hit.instanceId;
            updateAimTextDeduped(
              `DROP WORKPIECE ON BELT: ${instName} @ ${Math.round(hit.distanceMm)} mm — Release to Place`
            );
          } else {
            updateAimTextDeduped(
              'AIM AT ANY CYAN CONVEYOR SPLINE PATH TO PLACE WORKPIECE ON BELT'
            );
          }
        }
        return;
      }

      // Only display the full-screen file drop card when dragging external OS files
      const hasExternalFiles = types.includes('Files');
      if (hasExternalFiles && !isFileDragOver) {
        setIsFileDragOver(true);
      }
    },
    [isFileDragOver, updateAimTextDeduped]
  );

  const handleDragLeave = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setIsFileDragOver(false);
      transportRuntime.setDragPreviewHit(null);
      updateAimTextDeduped(null);
    },
    [updateAimTextDeduped]
  );

  const handleDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsFileDragOver(false);
      transportRuntime.setDragPreviewHit(null);
      transportRuntime.setActiveDraggedWorkpiece(null);
      updateAimTextDeduped(null);

      // Case 1: Dragged a Test Workpiece Preset onto a 3D Conveyor Belt
      const workpiecePresetId = e.dataTransfer.getData(
        'application/vc-workpiece-preset'
      );
      if (workpiecePresetId && raycastDropRef.current) {
        const ray = raycastDropRef.current.getCameraRay(e.clientX, e.clientY);
        dropWorkpieceByRay(ray.origin, ray.direction, {
          kind: 'preset',
          presetId: workpiecePresetId,
        });
        return;
      }

      // Case 2: Dragged a Custom 3D (.GLB / .USD) Workpiece onto a 3D Conveyor Belt
      const workpieceCompId = e.dataTransfer.getData(
        'application/vc-workpiece-component-id'
      );
      if (workpieceCompId && raycastDropRef.current) {
        const ray = raycastDropRef.current.getCameraRay(e.clientX, e.clientY);
        dropWorkpieceByRay(ray.origin, ray.direction, {
          kind: 'component',
          componentId: workpieceCompId,
        });
        return;
      }

      const dropPos: Vector3Tuple = raycastDropRef.current
        ? raycastDropRef.current.raycastFloor(e.clientX, e.clientY)
        : [0, 0, 0];

      // Case 3: Dragged a catalog machine component card onto factory floor
      const catalogCompId = e.dataTransfer.getData('application/vc-component-id');
      if (catalogCompId) {
        spawnInstance(catalogCompId, dropPos);
        return;
      }

      // Case 4: Dragged external 3D model (.glb/.gltf/.usd/.usda/.usdc/.usdz) or .json scene from OS
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
    [
      dropWorkpieceByRay,
      spawnInstance,
      importGlbBuffer,
      loadSceneFromJsonString,
      setStatusMessage,
      updateAimTextDeduped,
    ]
  );

  const isDrawingSplinePath = useEditorStore((s) => s.isDrawingSplinePath);
  const setIsDrawingSplinePath = useEditorStore((s) => s.setIsDrawingSplinePath);
  const viewportTheme = useEditorStore(
    (s) => s.scene.environment.viewportTheme ?? 'sketchup-white'
  );
  const customBg = useEditorStore(
    (s) => s.scene.environment.customBackgroundColor ?? '#ffffff'
  );
  const customFloor = useEditorStore(
    (s) => s.scene.environment.customFloorColor ?? '#ffffff'
  );

  const activeTheme = useMemo(
    () =>
      resolveViewportTheme({
        viewportTheme,
        customBackgroundColor: customBg,
        customFloorColor: customFloor,
      }),
    [viewportTheme, customBg, customFloor]
  );

  return (
    <div
      id="vc-3d-viewport-container"
      className="vc-viewport-wrapper"
      data-viewport-light={activeTheme.isLight ? 'true' : 'false'}
      style={{ backgroundColor: activeTheme.backgroundColor }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ position: [4.8, 3.8, 5.6], fov: 44, near: 0.15, far: 160 }}
        onPointerMissed={(e) => {
          if (e.type === 'click') {
            if (useEditorStore.getState().isDrawingSplinePath) return;
            selectInstance(null);
          }
        }}
      >
        <color attach="background" args={[activeTheme.backgroundColor]} />
        <fog
          attach="fog"
          args={[activeTheme.fogColor, activeTheme.fogNear, activeTheme.fogFar]}
        />

        {/* Offline-safe 3-Point Studio Lighting calibrated for SketchUp Light & Industrial Dark */}
        <ambientLight intensity={activeTheme.ambientIntensity} />
        <hemisphereLight
          args={[
            activeTheme.hemiSkyColor,
            activeTheme.hemiGroundColor,
            activeTheme.hemiIntensity,
          ]}
        />
        <directionalLight
          position={[9, 14, 8]}
          intensity={activeTheme.keyLightIntensity}
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
        <directionalLight
          position={[-8, 6, -7]}
          intensity={activeTheme.fillLightIntensity}
          color={activeTheme.fillLightColor}
        />

        <DropRaycasterBridge bridgeRef={raycastDropRef} />
        <SceneFloor />
        <SceneInstancesLayer />
        <TransportFlowOverlay />
        <SnapPortIndicators />
        <CameraOrbitController />

        <GizmoHelper alignment="bottom-right" margin={[70, 70]}>
          <GizmoViewport
            axisColors={['#ef4444', '#22c55e', '#3b82f6']}
            labelColor="#ffffff"
          />
        </GizmoHelper>
      </Canvas>

      {/* Viewport HUD Overlay */}
      <div className="vc-viewport-hud-top-left">
        <span className="vc-hud-pill">PERSPECTIVE · Y-UP · METRIC (m)</span>
        {workpieceAimText ? (
          <span className="vc-hud-pill vc-hud-belt-snap">{workpieceAimText}</span>
        ) : isDrawingSplinePath ? (
          <button
            type="button"
            className="vc-hud-pill vc-hud-draw-active"
            onClick={() => setIsDrawingSplinePath(false)}
          >
            SPLINE DRAW ACTIVE — Click Belt to Add Waypoints · Click Here or Esc to Done
          </button>
        ) : (
          <span className="vc-hud-pill vc-hud-pill-muted">
            Space = Play/Pause · Drag Workpiece onto Belt · Double-Click Part = Axis Builder
          </span>
        )}
      </div>

      {/* Drag-and-Drop Visual Target Overlay (only for external OS files) */}
      {isFileDragOver && (
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
