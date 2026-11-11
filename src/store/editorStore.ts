import * as THREE from 'three';
import { create } from 'zustand';
import { BUILTIN_COMPONENT_CATALOG } from '../engine/builtinCatalog';
import { buildComponentDefinitionFromGlbBuffer } from '../engine/glbAssetRegistry';
import type { JogPreviewState } from '../engine/kinematicsEngine';
import {
  exportTagBindingsToCsv,
  generateVendorAddressesForBindings,
  parseTagBindingsCsvPatch,
  validatePlcAddress,
  type VendorAddressPreset,
} from '../engine/plcAddressSyntax';
import { runtimeBusClient } from '../engine/runtimeBusClient';
import {
  collectInstanceAllSignals,
  makeSpawnerEnableKey,
  synthesizeComponentSignals,
} from '../engine/signalCatalogSync';
import {
  eulerDegToQuaternion,
  recomputeSceneSnapConnections,
  solveMagneticSnap,
  type SnapSolveResult,
} from '../engine/snapEngine';
import { transportRuntime } from '../engine/transportEngine';
import {
  makeTransportPathNodeId,
  syncSceneTransportAndSignals,
} from '../engine/transportGraphSync';
import {
  loadSavedViewportPrefs,
  saveViewportPrefs,
} from '../engine/viewportTheme';
import {
  computeWorkpieceDimensionsFromComponent,
  getWorkpiecePresetById,
} from '../engine/workpieceCatalog';
import {
  createEmptySceneSchema,
  createEmptyTransportGraph,
  isValidSceneSchema,
  type ComponentDefinition,
  type ComponentPathTemplate,
  type MitsubishiMcDriverConfig,
  type OpcUaDriverConfig,
  type PartSourceRuntimeConfig,
  type PathSensorBinding,
  type PlcAdapterType,
  type PlcConnectionAction,
  type PlcTagBinding,
  type SceneEnvironmentConfig,
  type SceneNodeInstance,
  type SceneSchema,
  type SiemensS7DriverConfig,
  type SimulationRunState,
  type SnapPortDefinition,
  type SubMeshRoleAssignment,
  type TransformData,
  type UUID,
  type Vector3Tuple,
  type VirtualEncoderConfig,
  type WorkpieceShapeType,
} from '../shared/schemas';

export type WorkpieceDropSource =
  | { kind: 'preset'; presetId: string }
  | { kind: 'component'; componentId: UUID };

export type GizmoTransformMode = 'translate' | 'rotate' | 'scale';
export type InspectorTabMode =
  | 'transform'
  | 'builder'
  | 'flow'
  | 'signals'
  | 'plc';

function pickDefaultSubMesh(comp: ComponentDefinition | undefined): string | null {
  if (!comp) return null;
  const roles = Object.values(comp.nodeRoles);
  const activeGripper = roles.find((r) => r.role === 'VacuumGripper');
  if (activeGripper) return activeGripper.nodeName;
  const activeAxis = roles.find(
    (r) => r.role === 'LinearAxis' || r.role === 'RotaryAxis'
  );
  if (activeAxis) return activeAxis.nodeName;
  const activeVfx = roles.find((r) => r.role === 'VisualEffect');
  if (activeVfx) return activeVfx.nodeName;
  return roles[0]?.nodeName ?? null;
}

function buildAutoCenterlinePath(comp: ComponentDefinition): ComponentPathTemplate {
  const inPort = comp.snapPorts.find((p) => p.role === 'InputPort');
  const outPort = comp.snapPorts.find((p) => p.role === 'OutputPort');
  const [minX, , minZ] = comp.boundingBox.min;
  const [maxX, maxY, maxZ] = comp.boundingBox.max;
  const centerZ = Number(((minZ + maxZ) * 0.5).toFixed(3));
  const surfaceY = Number(Math.max(0.1, maxY).toFixed(3));

  const startPt: Vector3Tuple = inPort
    ? [inPort.localPosition[0], surfaceY, inPort.localPosition[2]]
    : [minX, surfaceY, centerZ];
  const endPt: Vector3Tuple = outPort
    ? [outPort.localPosition[0], surfaceY, outPort.localPosition[2]]
    : [maxX, surfaceY, centerZ];
  const midPt: Vector3Tuple = [
    Number(((startPt[0] + endPt[0]) * 0.5).toFixed(3)),
    Number(((startPt[1] + endPt[1]) * 0.5).toFixed(3)),
    Number(((startPt[2] + endPt[2]) * 0.5).toFixed(3)),
  ];

  return {
    id: comp.transportPaths[0]?.id ?? 'path-main',
    name: comp.transportPaths[0]?.name ?? 'Main Spline Path',
    inPortId: inPort?.id,
    outPortId: outPort?.id,
    waypoints: [startPt, midPt, endPt],
    interpolation: 'catmull-rom',
    defaultSpeedMmPerSec: 450,
  };
}

function worldPointToLocalInstanceSpace(
  worldPoint: Vector3Tuple,
  transform: TransformData
): Vector3Tuple {
  const pos = new THREE.Vector3(...transform.position);
  const invQuat = eulerDegToQuaternion(transform.rotationDeg).invert();
  const sx = Math.abs(transform.scale[0]) > 1e-4 ? transform.scale[0] : 1;
  const sy = Math.abs(transform.scale[1]) > 1e-4 ? transform.scale[1] : 1;
  const sz = Math.abs(transform.scale[2]) > 1e-4 ? transform.scale[2] : 1;

  const v = new THREE.Vector3(...worldPoint).sub(pos).applyQuaternion(invQuat);
  return [
    Number((v.x / sx).toFixed(3)),
    Number((v.y / sy).toFixed(3)),
    Number((v.z / sz).toFixed(3)),
  ];
}

function buildStarterDemoScene(): SceneSchema {
  const base = createEmptySceneSchema(structuredClone(BUILTIN_COMPONENT_CATALOG));
  base.environment = {
    ...base.environment,
    ...loadSavedViewportPrefs(),
  };
  base.metadata.name = 'Dual-Lane Vacuum Pick & Transfer + HSC Line Demo';

  // Precision-docked Dual-Lane Packaging & Vacuum Pick-and-Transfer Line:
  //   Main Lane (Z = 0.00 m): Infeed_Conveyor_01 -> Stopper_Gate_01 -> Buffer_Conveyor_02 -> PickPlace_Gantry_01 -> Corner_Turntable_01 -> Outfeed_Conveyor_03
  //   Transfer Lane (Z = +0.80 m): PickPlace_Gantry_01 (Transfer Bed) -> Transfer_Outfeed_04
  const instances: SceneNodeInstance[] = [
    {
      id: 'inst-conv-01',
      name: 'Infeed_Conveyor_01',
      componentId: 'builtin-belt-conveyor-2m',
      transform: {
        position: [-2.6, 0, 0],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
      },
      visible: true,
      locked: false,
      parameters: {},
    },
    {
      id: 'inst-stopper-01',
      name: 'Stopper_Gate_01',
      componentId: 'builtin-pneumatic-stopper',
      transform: {
        position: [-1.46, 0, 0],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
      },
      visible: true,
      locked: false,
      parameters: {},
    },
    {
      id: 'inst-conv-02',
      name: 'Buffer_Conveyor_02',
      componentId: 'builtin-belt-conveyor-2m',
      transform: {
        position: [-0.32, 0, 0],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
      },
      visible: true,
      locked: false,
      parameters: {},
    },
    {
      id: 'inst-gantry-01',
      name: 'PickPlace_Gantry_01',
      componentId: 'builtin-openusd-cartesian-gantry',
      transform: {
        position: [1.18, 0, 0],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
      },
      visible: true,
      locked: false,
      parameters: {},
    },
    {
      id: 'inst-turntable-01',
      name: 'Corner_Turntable_01',
      componentId: 'builtin-rotary-turntable',
      transform: {
        position: [2.16, 0, 0],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
      },
      visible: true,
      locked: false,
      parameters: {},
    },
    {
      id: 'inst-conv-03',
      name: 'Outfeed_Conveyor_03',
      componentId: 'builtin-belt-conveyor-1m',
      transform: {
        position: [3.14, 0, 0],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
      },
      visible: true,
      locked: false,
      parameters: {},
    },
    {
      id: 'inst-conv-04',
      name: 'Transfer_Outfeed_04',
      componentId: 'builtin-belt-conveyor-1m',
      transform: {
        position: [2.18, 0, 0.8],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
      },
      visible: true,
      locked: false,
      parameters: {},
    },
    {
      id: 'inst-tank-01',
      name: 'Mixing_Vessel_01',
      componentId: 'builtin-mixing-tank-agitator',
      transform: {
        position: [0.8, 0, -2.05],
        rotationDeg: [0, 90, 0],
        scale: [1, 1, 1],
      },
      visible: true,
      locked: false,
      parameters: {},
    },
  ];

  const catalogMap = new Map(base.componentLibrary.map((c) => [c.id, c]));
  const snapConnections = recomputeSceneSnapConnections(instances, catalogMap);

  const seedGraph = createEmptyTransportGraph();
  seedGraph.spawners = [
    {
      id: 'spawner-infeed-01',
      instanceId: 'inst-conv-01',
      targetPathNodeId: makeTransportPathNodeId('inst-conv-01', 'path-main'),
      enabled: true,
      mode: 'interval',
      intervalSec: 2.8,
      maxActiveItems: 40,
      partDimensionsMm: [280, 220, 160],
      partColorHex: '#0ea5e9',
    },
  ];
  seedGraph.sinks = [
    {
      id: 'sink-outfeed-03',
      instanceId: 'inst-conv-03',
      sourcePathNodeId: makeTransportPathNodeId('inst-conv-03', 'path-main'),
    },
    {
      id: 'sink-transfer-04',
      instanceId: 'inst-conv-04',
      sourcePathNodeId: makeTransportPathNodeId('inst-conv-04', 'path-main'),
    },
  ];
  seedGraph.sensors = [
    {
      id: 'sens-pe-infeed',
      name: 'PE_Infeed',
      instanceId: 'inst-conv-01',
      pathNodeId: makeTransportPathNodeId('inst-conv-01', 'path-main'),
      offsetMm: 550,
      detectionRadiusMm: 22,
      sensorType: 'photoelectric',
      outputBoolSlot: -1,
    },
    {
      id: 'sens-pe-buffer',
      name: 'PE_AfterStopper',
      instanceId: 'inst-conv-02',
      pathNodeId: makeTransportPathNodeId('inst-conv-02', 'path-main'),
      offsetMm: 360,
      detectionRadiusMm: 22,
      sensorType: 'photoelectric',
      outputBoolSlot: -1,
    },
    {
      id: 'sens-px-exit',
      name: 'PX_BufferExit',
      instanceId: 'inst-conv-02',
      pathNodeId: makeTransportPathNodeId('inst-conv-02', 'path-main'),
      offsetMm: 1680,
      detectionRadiusMm: 45,
      sensorType: 'proximity',
      outputBoolSlot: -1,
    },
  ];

  const synced = syncSceneTransportAndSignals({
    instances,
    componentLibrary: base.componentLibrary,
    snapConnections,
    prevTransportGraph: seedGraph,
    prevTagMap: base.plcTagMap,
  });

  // Enable PickPlace_Gantry_01 Auto Pick & Place (`DO_AutoCycle = TRUE`) out-of-the-box so pressing Play
  // immediately demonstrates live 3D Vacuum Suction Pick -> Lift -> +800mm Traverse -> Lane 2 Transfer!
  synced.plcTagMap.bindings = synced.plcTagMap.bindings.map((b) =>
    b.instanceId === 'inst-gantry-01' &&
    b.componentSignalKey === 'Vacuum_Gripper_Tool_Axis::DO_AutoCycle'
      ? { ...b, manualForceEnabled: true, manualForceValue: true }
      : b
  );

  base.instances = instances;
  base.snapConnections = snapConnections;
  base.transportGraph = synced.transportGraph;
  base.plcTagMap = synced.plcTagMap;
  return base;
}

export interface EditorStoreState {
  scene: SceneSchema;
  selectedInstanceId: UUID | null;
  selectedSubMeshName: string | null;
  inspectorTab: InspectorTabMode;
  jogPreview: JogPreviewState | null;
  isDrawingSplinePath: boolean;
  gizmoMode: GizmoTransformMode;
  isGizmoDragging: boolean;
  activeSnapPreview: SnapSolveResult | null;
  runState: SimulationRunState;
  isDirty: boolean;
  statusMessage: string;

  // Selection, Sub-Mesh Picking & Gizmo
  selectInstance: (id: UUID | null) => void;
  selectSubMesh: (nodeName: string | null) => void;
  setInspectorTab: (tab: InspectorTabMode) => void;
  setJogPreview: (preview: JogPreviewState | null) => void;
  setIsDrawingSplinePath: (drawing: boolean) => void;
  setGizmoMode: (mode: GizmoTransformMode) => void;
  setGizmoDragging: (dragging: boolean) => void;
  setActiveSnapPreview: (snap: SnapSolveResult | null) => void;
  setStatusMessage: (msg: string) => void;

  // Simulation controls
  setRunState: (state: SimulationRunState) => void;
  setSimSpeedMultiplier: (speed: number) => void;

  // Milestone 2: Component Builder & Signal Force Panel
  setSubMeshRole: (
    componentId: UUID,
    nodeName: string,
    assignment: SubMeshRoleAssignment
  ) => void;
  setSignalForce: (
    bindingId: UUID,
    enabled: boolean,
    value: boolean | number,
    autoRun?: boolean
  ) => void;
  clearAllForces: () => void;

  // Milestone 3: Spline Transport Path, Sensors, Spawner/Sink & HSC Encoder Authoring
  ensureComponentSplinePath: (
    instanceId: UUID,
    mode?: 'auto-centerline' | 'draw-blank'
  ) => void;
  appendSplineWaypointWorld: (instanceId: UUID, worldPoint: Vector3Tuple) => void;
  updateSplineWaypointLocal: (
    instanceId: UUID,
    waypointIndex: number,
    nextLocal: Vector3Tuple
  ) => void;
  insertSplineMidpoint: (instanceId: UUID) => void;
  removeSplineWaypoint: (instanceId: UUID, waypointIndex: number) => void;
  reverseSplinePath: (instanceId: UUID) => void;
  clearSplinePath: (instanceId: UUID) => void;
  updateComponentPathSettings: (
    instanceId: UUID,
    patch: {
      interpolation?: 'catmull-rom' | 'polyline';
      defaultSpeedMmPerSec?: number;
      name?: string;
    }
  ) => void;

  setInstanceFlowEndpointRole: (
    instanceId: UUID,
    role: 'none' | 'spawner' | 'sink'
  ) => void;
  updateInstanceSpawner: (
    instanceId: UUID,
    patch: Partial<PartSourceRuntimeConfig>
  ) => void;
  setAllSpawnersEnabled: (enabled: boolean) => void;
  triggerManualSpawnNow: (instanceId: UUID) => void;
  dropWorkpieceByRay: (
    rayOrigin: Vector3Tuple,
    rayDirection: Vector3Tuple,
    source: WorkpieceDropSource
  ) => boolean;
  dropWorkpieceQuick: (
    source: WorkpieceDropSource,
    targetInstanceId?: UUID
  ) => boolean;
  clearAllActiveFlowItems: () => void;

  addInstancePathSensor: (
    instanceId: UUID,
    sensorType: 'photoelectric' | 'proximity'
  ) => void;
  updateInstancePathSensor: (
    sensorId: UUID,
    patch: Partial<PathSensorBinding>
  ) => void;
  deleteInstancePathSensor: (sensorId: UUID) => void;

  addInstanceVirtualEncoder: (instanceId: UUID) => void;
  updateInstanceVirtualEncoder: (
    encoderId: UUID,
    patch: Partial<VirtualEncoderConfig>
  ) => void;
  deleteInstanceVirtualEncoder: (encoderId: UUID) => void;

  // Environment settings
  updateEnvironment: (patch: Partial<SceneEnvironmentConfig>) => void;
  renameScene: (name: string) => void;

  // Scene Lifecycle
  newEmptyScene: () => void;
  loadStarterDemoScene: () => void;
  loadSceneFromJsonString: (jsonText: string, sourceLabel?: string) => boolean;
  saveSceneInteractive: () => Promise<void>;
  openSceneInteractive: () => Promise<void>;

  // Asset & Instance operations
  spawnInstance: (componentId: UUID, worldDropPos?: Vector3Tuple) => UUID | null;
  importGlbBuffer: (
    fileName: string,
    buffer: ArrayBuffer,
    options?: { spawnInScene?: boolean; dropPos?: Vector3Tuple; filePath?: string }
  ) => Promise<ComponentDefinition | null>;
  importGlbInteractive: () => Promise<void>;
  exportComponentVcompInteractive: (componentId: UUID) => Promise<void>;

  updateInstanceTransform: (
    instanceId: UUID,
    transform: TransformData,
    commitConnections?: boolean
  ) => void;
  renameInstance: (instanceId: UUID, name: string) => void;
  toggleInstanceVisibility: (instanceId: UUID) => void;
  toggleInstanceLock: (instanceId: UUID) => void;
  duplicateInstance: (instanceId: UUID) => void;
  deleteInstance: (instanceId: UUID) => void;

  // Snap Port Authoring
  addSnapPort: (componentId: UUID, role: SnapPortDefinition['role']) => void;
  updateSnapPort: (
    componentId: UUID,
    portId: UUID,
    patch: Partial<SnapPortDefinition>
  ) => void;
  deleteSnapPort: (componentId: UUID, portId: UUID) => void;

  // Milestone 4: Live PLC Drivers & Full I/O Tag Binding Matrix
  isTagMatrixModalOpen: boolean;
  setTagMatrixModalOpen: (open: boolean) => void;
  setPlcActiveAdapter: (
    adapter: PlcAdapterType,
    autoConvertAddresses?: boolean
  ) => void;
  setPlcScanCycleMs: (scanCycleMs: number) => void;
  updateS7DriverConfig: (patch: Partial<SiemensS7DriverConfig>) => void;
  updateMcDriverConfig: (patch: Partial<MitsubishiMcDriverConfig>) => void;
  updateOpcUaDriverConfig: (patch: Partial<OpcUaDriverConfig>) => void;
  updatePlcTagBinding: (
    bindingId: UUID,
    patch: Partial<Pick<PlcTagBinding, 'plcAddress' | 'scaleFactor' | 'offset'>>
  ) => void;
  applyPlcAddressPreset: (preset: VendorAddressPreset) => void;
  triggerPlcConnectionAction: (action: PlcConnectionAction) => void;
  exportPlcTagCsvInteractive: () => void;
  importPlcTagCsvText: (csvText: string, sourceName?: string) => number;
}

function getCatalogMap(library: ComponentDefinition[]): Map<UUID, ComponentDefinition> {
  return new Map(library.map((c) => [c.id, c]));
}

/**
 * Ensures editing a component's transportPaths on a selected instance clones the ComponentDefinition
 * if other instances in the scene share that same ComponentDefinition ID (Copy-on-Write),
 * so custom spline paths on one conveyor don't unexpectedly alter other conveyors!
 */
function ensureUniqueComponentForPathEdit(
  instances: SceneNodeInstance[],
  library: ComponentDefinition[],
  targetInstanceId: UUID
): {
  instances: SceneNodeInstance[];
  library: ComponentDefinition[];
  targetComponent: ComponentDefinition | null;
} {
  const inst = instances.find((i) => i.id === targetInstanceId);
  if (!inst) return { instances, library, targetComponent: null };
  const comp = library.find((c) => c.id === inst.componentId);
  if (!comp) return { instances, library, targetComponent: null };

  const sharedCount = instances.filter((i) => i.componentId === comp.id).length;
  if (sharedCount <= 1) {
    return { instances, library, targetComponent: comp };
  }

  const clonedComp: ComponentDefinition = {
    ...structuredClone(comp),
    id: `${comp.id}-custom-${targetInstanceId.slice(-4)}`,
    name: `${comp.name} (${inst.name})`,
  };
  const nextInstances = instances.map((i) =>
    i.id === targetInstanceId ? { ...i, componentId: clonedComp.id } : i
  );
  const nextLibrary = [...library, clonedComp];
  return {
    instances: nextInstances,
    library: nextLibrary,
    targetComponent: clonedComp,
  };
}

const initialDemoScene = buildStarterDemoScene();
runtimeBusClient.syncTagMap(initialDemoScene.plcTagMap);

export const useEditorStore = create<EditorStoreState>((set, get) => ({
  scene: initialDemoScene,
  selectedInstanceId: 'inst-gantry-01',
  selectedSubMeshName: null,
  inspectorTab: 'transform',
  isTagMatrixModalOpen: false,
  jogPreview: null,
  isDrawingSplinePath: false,
  gizmoMode: 'translate',
  isGizmoDragging: false,
  activeSnapPreview: null,
  runState: 'STOPPED',
  isDirty: false,
  statusMessage:
    'Vacuum Pick & Transfer Ready — Press Play (Space) to watch PickPlace_Gantry_01 pick cartons off Main Lane and transfer +800 mm onto Lane 2!',

  selectInstance: (id) =>
    set((state) => {
      if (state.selectedInstanceId === id) return state;
      let nextSubMesh: string | null = null;
      if (id && state.inspectorTab === 'builder') {
        const inst = state.scene.instances.find((i) => i.id === id);
        const comp = inst
          ? state.scene.componentLibrary.find((c) => c.id === inst.componentId)
          : undefined;
        nextSubMesh = pickDefaultSubMesh(comp);
      }
      return {
        selectedInstanceId: id,
        selectedSubMeshName: nextSubMesh,
        jogPreview: null,
        isDrawingSplinePath: false,
      };
    }),

  selectSubMesh: (selectedSubMeshName) =>
    set({
      selectedSubMeshName,
      jogPreview: null,
    }),

  setInspectorTab: (inspectorTab) =>
    set((state) => {
      let nextSubMesh = state.selectedSubMeshName;
      if (inspectorTab === 'builder' && !nextSubMesh && state.selectedInstanceId) {
        const inst = state.scene.instances.find(
          (i) => i.id === state.selectedInstanceId
        );
        const comp = inst
          ? state.scene.componentLibrary.find((c) => c.id === inst.componentId)
          : undefined;
        nextSubMesh = pickDefaultSubMesh(comp);
      } else if (inspectorTab !== 'builder') {
        nextSubMesh = null;
      }
      return {
        inspectorTab,
        selectedSubMeshName: nextSubMesh,
        jogPreview: null,
        isDrawingSplinePath:
          inspectorTab === 'flow' ? state.isDrawingSplinePath : false,
      };
    }),

  setJogPreview: (jogPreview) => set({ jogPreview }),

  setIsDrawingSplinePath: (isDrawingSplinePath) =>
    set((state) => ({
      isDrawingSplinePath,
      statusMessage: isDrawingSplinePath
        ? 'Spline Draw Mode ACTIVE — Click along the 3D conveyor surface to place waypoints (Esc to finish).'
        : state.statusMessage,
    })),

  setGizmoMode: (gizmoMode) => set({ gizmoMode }),

  setGizmoDragging: (isGizmoDragging) =>
    set((s) => ({
      isGizmoDragging,
      activeSnapPreview: isGizmoDragging ? s.activeSnapPreview : null,
    })),

  setActiveSnapPreview: (activeSnapPreview) => set({ activeSnapPreview }),

  setStatusMessage: (statusMessage) => set({ statusMessage }),

  setRunState: (runState) => {
    const state = get();
    const mult = state.scene.environment.simSpeedMultiplier;
    if (runState === 'STOPPED') {
      transportRuntime.clearAllFlowItems(
        runtimeBusClient.bufferView,
        state.scene.transportGraph
      );
    }
    runtimeBusClient.sendControl(runState, mult);
    set({
      runState,
      jogPreview: null,
      isDrawingSplinePath: false,
      statusMessage:
        runState === 'RUNNING'
          ? `Simulation RUNNING (${mult.toFixed(1)}x — Spline Material Flow, Sensors & HSC Encoders Active)`
          : runState === 'PAUSED'
            ? 'Simulation PAUSED — Workpieces & Encoder registers held'
            : 'Simulation STOPPED — Reset actuators, cleared flow items & zeroed belt encoders',
    });
  },

  setSimSpeedMultiplier: (simSpeedMultiplier) => {
    const clamped = Math.min(5, Math.max(0.1, Number(simSpeedMultiplier.toFixed(2))));
    runtimeBusClient.sendControl(get().runState, clamped);
    set((state) => ({
      scene: {
        ...state.scene,
        environment: {
          ...state.scene.environment,
          simSpeedMultiplier: clamped,
        },
      },
    }));
  },

  setSubMeshRole: (componentId, nodeName, assignment) => {
    const state = get();
    const nextLibrary = state.scene.componentLibrary.map((comp) => {
      if (comp.id !== componentId) return comp;
      const nextNodeRoles: Record<string, SubMeshRoleAssignment> = {
        ...comp.nodeRoles,
        [nodeName]: assignment,
      };
      return {
        ...comp,
        nodeRoles: nextNodeRoles,
        exposedSignals: synthesizeComponentSignals(nextNodeRoles),
      };
    });

    const synced = syncSceneTransportAndSignals({
      instances: state.scene.instances,
      componentLibrary: nextLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: state.scene.transportGraph,
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      selectedSubMeshName: nodeName,
      jogPreview: null,
      scene: {
        ...state.scene,
        componentLibrary: nextLibrary,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage: `Updated "${nodeName}" role -> ${assignment.role} (${synced.plcTagMap.bindings.length} scene I/O tags synced).`,
    });
  },

  setSignalForce: (bindingId, enabled, value, autoRun = true) => {
    const state = get();
    const targetBinding = state.scene.plcTagMap.bindings.find(
      (b) => b.id === bindingId
    );
    if (!targetBinding) return;

    let effectiveVal: boolean | number = value;
    if (!enabled) {
      const inst = state.scene.instances.find(
        (i) => i.id === targetBinding.instanceId
      );
      const comp = inst
        ? state.scene.componentLibrary.find((c) => c.id === inst.componentId)
        : undefined;
      const sigDesc = comp
        ? collectInstanceAllSignals(
            targetBinding.instanceId,
            comp,
            state.scene.transportGraph
          ).find((s) => s.key === targetBinding.componentSignalKey)
        : undefined;

      if (targetBinding.dataType === 'BOOL') {
        effectiveVal = sigDesc?.defaultBool ?? false;
      } else {
        effectiveVal = sigDesc?.defaultVal ?? 0;
      }
    }

    // Keep Part Feeder UI ON/OFF switches synchronized when DO_FeedEnable is toggled in Force Console
    const isSpawnerEnableTag =
      targetBinding.componentSignalKey.startsWith('FLOW::') &&
      targetBinding.componentSignalKey.endsWith('::DO_FeedEnable');

    const nextTransportGraph =
      isSpawnerEnableTag && enabled
        ? {
            ...state.scene.transportGraph,
            spawners: state.scene.transportGraph.spawners.map((sp) =>
              makeSpawnerEnableKey(sp.id) === targetBinding.componentSignalKey
                ? { ...sp, enabled: Boolean(effectiveVal) }
                : sp
            ),
          }
        : state.scene.transportGraph;

    const nextBindings = state.scene.plcTagMap.bindings.map((b) =>
      b.id === bindingId
        ? {
            ...b,
            manualForceEnabled: enabled,
            manualForceValue: effectiveVal,
          }
        : b
    );

    const nextTagMap = {
      ...state.scene.plcTagMap,
      bindings: nextBindings,
    };

    runtimeBusClient.syncTagMap(nextTagMap);

    let nextRunState = state.runState;
    const shouldAutoStart =
      enabled &&
      autoRun &&
      state.runState === 'STOPPED' &&
      !(isSpawnerEnableTag && effectiveVal === false);

    if (shouldAutoStart) {
      nextRunState = 'RUNNING';
      runtimeBusClient.sendControl(
        'RUNNING',
        state.scene.environment.simSpeedMultiplier
      );
    }

    set({
      runState: nextRunState,
      jogPreview: null,
      scene: {
        ...state.scene,
        transportGraph: nextTransportGraph,
        plcTagMap: nextTagMap,
      },
    });
  },

  clearAllForces: () => {
    const state = get();
    const compMap = getCatalogMap(state.scene.componentLibrary);
    const instMap = new Map(state.scene.instances.map((i) => [i.id, i]));

    const nextBindings = state.scene.plcTagMap.bindings.map((b) => {
      const inst = instMap.get(b.instanceId);
      const comp = inst ? compMap.get(inst.componentId) : undefined;
      const sigDesc = comp
        ? collectInstanceAllSignals(
            b.instanceId,
            comp,
            state.scene.transportGraph
          ).find((s) => s.key === b.componentSignalKey)
        : undefined;
      const resetVal: boolean | number =
        b.dataType === 'BOOL'
          ? (sigDesc?.defaultBool ?? false)
          : (sigDesc?.defaultVal ?? 0);
      return {
        ...b,
        manualForceEnabled: false,
        manualForceValue: resetVal,
      };
    });

    const nextTagMap = {
      ...state.scene.plcTagMap,
      bindings: nextBindings,
    };
    runtimeBusClient.syncTagMap(nextTagMap);

    set({
      scene: {
        ...state.scene,
        plcTagMap: nextTagMap,
      },
      statusMessage: 'Cleared all manual Forced I/O overrides.',
    });
  },

  // =========================================================================
  // MILESTONE 3: SPLINE PATH, SENSOR, SPAWNER/SINK & VIRTUAL HSC ENCODER ACTIONS
  // =========================================================================

  ensureComponentSplinePath: (instanceId, mode = 'auto-centerline') => {
    const state = get();
    const cow = ensureUniqueComponentForPathEdit(
      state.scene.instances,
      state.scene.componentLibrary,
      instanceId
    );
    if (!cow.targetComponent) return;

    const autoTpl = buildAutoCenterlinePath(cow.targetComponent);
    const nextPath: ComponentPathTemplate =
      mode === 'draw-blank'
        ? {
            ...autoTpl,
            waypoints: [],
          }
        : autoTpl;

    const nextLibrary = cow.library.map((c) =>
      c.id === cow.targetComponent!.id ? { ...c, transportPaths: [nextPath] } : c
    );
    const catalogMap = getCatalogMap(nextLibrary);
    const nextConnections = recomputeSceneSnapConnections(cow.instances, catalogMap);
    const synced = syncSceneTransportAndSignals({
      instances: cow.instances,
      componentLibrary: nextLibrary,
      snapConnections: nextConnections,
      prevTransportGraph: state.scene.transportGraph,
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      isDrawingSplinePath: mode === 'draw-blank',
      scene: {
        ...state.scene,
        instances: cow.instances,
        componentLibrary: nextLibrary,
        snapConnections: nextConnections,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage:
        mode === 'draw-blank'
          ? 'Click 2 or more points along the 3D belt surface to draw your custom Spline Path.'
          : `Generated InPort -> OutPort Spline Path (${nextPath.waypoints.length} waypoints).`,
    });
  },

  appendSplineWaypointWorld: (instanceId, worldPoint) => {
    const state = get();
    const cow = ensureUniqueComponentForPathEdit(
      state.scene.instances,
      state.scene.componentLibrary,
      instanceId
    );
    if (!cow.targetComponent) return;
    const inst = cow.instances.find((i) => i.id === instanceId);
    if (!inst) return;

    const localPt = worldPointToLocalInstanceSpace(worldPoint, inst.transform);
    // Lift slightly onto belt surface if clicked on top face
    const existingTpl =
      cow.targetComponent.transportPaths[0] ??
      ({
        ...buildAutoCenterlinePath(cow.targetComponent),
        waypoints: [],
      } satisfies ComponentPathTemplate);

    const nextWaypoints: Vector3Tuple[] = [...existingTpl.waypoints, localPt];
    const nextTpl: ComponentPathTemplate = {
      ...existingTpl,
      waypoints: nextWaypoints,
    };

    const nextLibrary = cow.library.map((c) =>
      c.id === cow.targetComponent!.id
        ? { ...c, transportPaths: [nextTpl, ...c.transportPaths.slice(1)] }
        : c
    );
    const catalogMap = getCatalogMap(nextLibrary);
    const nextConnections = recomputeSceneSnapConnections(cow.instances, catalogMap);
    const synced = syncSceneTransportAndSignals({
      instances: cow.instances,
      componentLibrary: nextLibrary,
      snapConnections: nextConnections,
      prevTransportGraph: state.scene.transportGraph,
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        instances: cow.instances,
        componentLibrary: nextLibrary,
        snapConnections: nextConnections,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage: `Added Spline Waypoint #${nextWaypoints.length} at local [${localPt.join(', ')}] m.`,
    });
  },

  updateSplineWaypointLocal: (instanceId, waypointIndex, nextLocal) => {
    const state = get();
    const cow = ensureUniqueComponentForPathEdit(
      state.scene.instances,
      state.scene.componentLibrary,
      instanceId
    );
    if (!cow.targetComponent || cow.targetComponent.transportPaths.length === 0) return;

    const tpl = cow.targetComponent.transportPaths[0];
    if (waypointIndex < 0 || waypointIndex >= tpl.waypoints.length) return;

    const nextWaypoints = tpl.waypoints.map((wp, idx) =>
      idx === waypointIndex ? nextLocal : wp
    );
    const nextLibrary = cow.library.map((c) =>
      c.id === cow.targetComponent!.id
        ? {
            ...c,
            transportPaths: [
              { ...tpl, waypoints: nextWaypoints },
              ...c.transportPaths.slice(1),
            ],
          }
        : c
    );
    const synced = syncSceneTransportAndSignals({
      instances: cow.instances,
      componentLibrary: nextLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: state.scene.transportGraph,
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        instances: cow.instances,
        componentLibrary: nextLibrary,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
    });
  },

  insertSplineMidpoint: (instanceId) => {
    const state = get();
    const cow = ensureUniqueComponentForPathEdit(
      state.scene.instances,
      state.scene.componentLibrary,
      instanceId
    );
    if (!cow.targetComponent) return;

    const tpl =
      cow.targetComponent.transportPaths[0] ??
      buildAutoCenterlinePath(cow.targetComponent);

    let nextWaypoints: Vector3Tuple[];
    if (tpl.waypoints.length < 2) {
      nextWaypoints = buildAutoCenterlinePath(cow.targetComponent).waypoints;
    } else {
      const lastIdx = tpl.waypoints.length - 1;
      const a = tpl.waypoints[lastIdx - 1];
      const b = tpl.waypoints[lastIdx];
      const mid: Vector3Tuple = [
        Number(((a[0] + b[0]) * 0.5).toFixed(3)),
        Number(((a[1] + b[1]) * 0.5).toFixed(3)),
        Number(((a[2] + b[2]) * 0.5).toFixed(3)),
      ];
      nextWaypoints = [
        ...tpl.waypoints.slice(0, lastIdx),
        mid,
        tpl.waypoints[lastIdx],
      ];
    }

    const nextLibrary = cow.library.map((c) =>
      c.id === cow.targetComponent!.id
        ? {
            ...c,
            transportPaths: [
              { ...tpl, waypoints: nextWaypoints },
              ...c.transportPaths.slice(1),
            ],
          }
        : c
    );
    const synced = syncSceneTransportAndSignals({
      instances: cow.instances,
      componentLibrary: nextLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: state.scene.transportGraph,
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        instances: cow.instances,
        componentLibrary: nextLibrary,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage: `Inserted curve control point (${nextWaypoints.length} waypoints).`,
    });
  },

  removeSplineWaypoint: (instanceId, waypointIndex) => {
    const state = get();
    const cow = ensureUniqueComponentForPathEdit(
      state.scene.instances,
      state.scene.componentLibrary,
      instanceId
    );
    if (!cow.targetComponent || cow.targetComponent.transportPaths.length === 0) return;

    const tpl = cow.targetComponent.transportPaths[0];
    const nextWaypoints = tpl.waypoints.filter((_, idx) => idx !== waypointIndex);
    const nextLibrary = cow.library.map((c) =>
      c.id === cow.targetComponent!.id
        ? {
            ...c,
            transportPaths: [
              { ...tpl, waypoints: nextWaypoints },
              ...c.transportPaths.slice(1),
            ],
          }
        : c
    );
    const synced = syncSceneTransportAndSignals({
      instances: cow.instances,
      componentLibrary: nextLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: state.scene.transportGraph,
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        instances: cow.instances,
        componentLibrary: nextLibrary,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
    });
  },

  reverseSplinePath: (instanceId) => {
    const state = get();
    const cow = ensureUniqueComponentForPathEdit(
      state.scene.instances,
      state.scene.componentLibrary,
      instanceId
    );
    if (!cow.targetComponent || cow.targetComponent.transportPaths.length === 0) return;

    const tpl = cow.targetComponent.transportPaths[0];
    const reversed: ComponentPathTemplate = {
      ...tpl,
      inPortId: tpl.outPortId,
      outPortId: tpl.inPortId,
      waypoints: [...tpl.waypoints].reverse(),
    };
    const nextLibrary = cow.library.map((c) =>
      c.id === cow.targetComponent!.id
        ? { ...c, transportPaths: [reversed, ...c.transportPaths.slice(1)] }
        : c
    );
    const synced = syncSceneTransportAndSignals({
      instances: cow.instances,
      componentLibrary: nextLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: state.scene.transportGraph,
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        instances: cow.instances,
        componentLibrary: nextLibrary,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage: 'Reversed Spline Path transport direction.',
    });
  },

  clearSplinePath: (instanceId) => {
    const state = get();
    const cow = ensureUniqueComponentForPathEdit(
      state.scene.instances,
      state.scene.componentLibrary,
      instanceId
    );
    if (!cow.targetComponent) return;

    const nextLibrary = cow.library.map((c) =>
      c.id === cow.targetComponent!.id ? { ...c, transportPaths: [] } : c
    );
    const synced = syncSceneTransportAndSignals({
      instances: cow.instances,
      componentLibrary: nextLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: state.scene.transportGraph,
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      isDrawingSplinePath: false,
      scene: {
        ...state.scene,
        instances: cow.instances,
        componentLibrary: nextLibrary,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage: 'Cleared Spline Path on selected machine.',
    });
  },

  updateComponentPathSettings: (instanceId, patch) => {
    const state = get();
    const cow = ensureUniqueComponentForPathEdit(
      state.scene.instances,
      state.scene.componentLibrary,
      instanceId
    );
    if (!cow.targetComponent || cow.targetComponent.transportPaths.length === 0) return;

    const tpl = cow.targetComponent.transportPaths[0];
    const nextTpl: ComponentPathTemplate = { ...tpl, ...patch };
    const nextLibrary = cow.library.map((c) =>
      c.id === cow.targetComponent!.id
        ? { ...c, transportPaths: [nextTpl, ...c.transportPaths.slice(1)] }
        : c
    );
    const synced = syncSceneTransportAndSignals({
      instances: cow.instances,
      componentLibrary: nextLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: state.scene.transportGraph,
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        instances: cow.instances,
        componentLibrary: nextLibrary,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
    });
  },

  setInstanceFlowEndpointRole: (instanceId, role) => {
    const state = get();
    const primaryNode = Object.values(state.scene.transportGraph.nodes).find(
      (n) => n.instanceId === instanceId
    );
    if (!primaryNode) {
      set({
        statusMessage:
          'Create or Auto-Generate a Spline Path on this machine first before assigning a Spawner or Sink.',
      });
      return;
    }

    const filteredSpawners = state.scene.transportGraph.spawners.filter(
      (s) => s.instanceId !== instanceId
    );
    const filteredSinks = state.scene.transportGraph.sinks.filter(
      (s) => s.instanceId !== instanceId
    );

    if (role === 'spawner') {
      filteredSpawners.push({
        id: `spawner-${instanceId}`,
        instanceId,
        targetPathNodeId: primaryNode.id,
        enabled: true,
        mode: 'interval',
        intervalSec: 2.2,
        maxActiveItems: 40,
        partDimensionsMm: [280, 220, 160],
        partColorHex: '#0ea5e9',
      });
    } else if (role === 'sink') {
      filteredSinks.push({
        id: `sink-${instanceId}`,
        instanceId,
        sourcePathNodeId: primaryNode.id,
      });
    }

    const synced = syncSceneTransportAndSignals({
      instances: state.scene.instances,
      componentLibrary: state.scene.componentLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: {
        ...state.scene.transportGraph,
        spawners: filteredSpawners,
        sinks: filteredSinks,
      },
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage:
        role === 'spawner'
          ? 'Configured machine as Part Feeder (Auto Feed ON).'
          : role === 'sink'
            ? 'Configured machine as Exit Despawner (PartSink).'
            : 'Set machine to Pass-Through Transport.',
    });
  },

  updateInstanceSpawner: (instanceId, patch) => {
    const state = get();
    const targetSpawner = state.scene.transportGraph.spawners.find(
      (sp) => sp.instanceId === instanceId
    );
    const nextSpawners = state.scene.transportGraph.spawners.map((sp) =>
      sp.instanceId === instanceId ? { ...sp, ...patch } : sp
    );

    // Clear any manual override on DO_FeedEnable when toggling enabled via UI switches
    const enableKey = targetSpawner ? makeSpawnerEnableKey(targetSpawner.id) : null;
    const cleanedPrevTagMap =
      patch.enabled !== undefined && enableKey
        ? {
            ...state.scene.plcTagMap,
            bindings: state.scene.plcTagMap.bindings.map((b) =>
              b.instanceId === instanceId && b.componentSignalKey === enableKey
                ? {
                    ...b,
                    manualForceEnabled: false,
                    manualForceValue: Boolean(patch.enabled),
                  }
                : b
            ),
          }
        : state.scene.plcTagMap;

    const synced = syncSceneTransportAndSignals({
      instances: state.scene.instances,
      componentLibrary: state.scene.componentLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: {
        ...state.scene.transportGraph,
        spawners: nextSpawners,
      },
      prevTagMap: cleanedPrevTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    const instName =
      state.scene.instances.find((i) => i.id === instanceId)?.name ?? instanceId;

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      ...(patch.enabled !== undefined
        ? {
            statusMessage: patch.enabled
              ? `Part Feeder ON (${instName}) — Auto-feeding workpieces onto conveyor.`
              : `Part Feeder OFF (${instName}) — Auto-feed paused (use Workpieces tab or +1 Feed manually).`,
          }
        : {}),
    });
  },

  setAllSpawnersEnabled: (enabled) => {
    const state = get();
    if (state.scene.transportGraph.spawners.length === 0) {
      set({
        statusMessage:
          'No Part Feeder configured in this scene. Select an infeed conveyor -> Flow tab -> Part Feeder.',
      });
      return;
    }

    const enableKeys = new Set(
      state.scene.transportGraph.spawners.map((sp) => makeSpawnerEnableKey(sp.id))
    );
    const nextSpawners = state.scene.transportGraph.spawners.map((sp) => ({
      ...sp,
      enabled,
    }));
    const cleanedPrevTagMap = {
      ...state.scene.plcTagMap,
      bindings: state.scene.plcTagMap.bindings.map((b) =>
        enableKeys.has(b.componentSignalKey)
          ? {
              ...b,
              manualForceEnabled: false,
              manualForceValue: enabled,
            }
          : b
      ),
    };

    const synced = syncSceneTransportAndSignals({
      instances: state.scene.instances,
      componentLibrary: state.scene.componentLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: {
        ...state.scene.transportGraph,
        spawners: nextSpawners,
      },
      prevTagMap: cleanedPrevTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage: enabled
        ? `Part Feeder ON (${nextSpawners.length} feeder${nextSpawners.length > 1 ? 's' : ''}) — Auto-feeding workpieces.`
        : 'Part Feeder OFF — Paused automatic feeding so you can test or drag workpieces onto the belt manually.',
    });
  },

  triggerManualSpawnNow: (instanceId) => {
    const state = get();
    const spawned = transportRuntime.spawnSinglePartNow(
      state.scene.transportGraph,
      instanceId
    );
    if (!spawned) {
      set({
        statusMessage:
          'Spawn entry zone currently occupied — wait for box clearance or run the belt.',
      });
      return;
    }

    let nextRunState = state.runState;
    if (state.runState === 'STOPPED') {
      nextRunState = 'RUNNING';
      runtimeBusClient.sendControl(
        'RUNNING',
        state.scene.environment.simSpeedMultiplier
      );
    }

    set({
      runState: nextRunState,
      statusMessage: `Spawned workpiece #${spawned.serialNumber} (${spawned.dimensionsMm.join('×')} mm).`,
    });
  },

  dropWorkpieceByRay: (rayOrigin, rayDirection, source) => {
    const state = get();
    let shape: WorkpieceShapeType = 'carton';
    let dimensionsMm: Vector3Tuple = [280, 220, 160];
    let colorHex = '#0ea5e9';
    let label = 'Carton Box';
    let customComponentId: UUID | undefined;

    if (source.kind === 'preset') {
      const preset = getWorkpiecePresetById(source.presetId);
      if (!preset) return false;
      shape = preset.shape;
      dimensionsMm = [...preset.dimensionsMm] as Vector3Tuple;
      colorHex = preset.colorHex;
      label = preset.name;
    } else {
      const comp = state.scene.componentLibrary.find(
        (c) => c.id === source.componentId
      );
      if (!comp) return false;
      shape = 'custom-model';
      customComponentId = comp.id;
      dimensionsMm = computeWorkpieceDimensionsFromComponent(comp);
      colorHex = '#38bdf8';
      label = comp.name;
    }

    const hit = transportRuntime.findClosestBeltPointFromRay({
      rayOrigin,
      rayDirection,
      graph: state.scene.transportGraph,
      instances: state.scene.instances,
      componentLibrary: state.scene.componentLibrary,
      bindings: state.scene.plcTagMap.bindings,
      bufferView: runtimeBusClient.bufferView,
      maxCaptureRadiusMeters: 0.92,
    });

    if (!hit) {
      set({
        statusMessage:
          'Missed conveyor belt — drag the workpiece onto any cyan Conveyor Spline path, or click "+ On Belt".',
      });
      return false;
    }

    const placed = transportRuntime.placeWorkpieceOnPath({
      graph: state.scene.transportGraph,
      instances: state.scene.instances,
      componentLibrary: state.scene.componentLibrary,
      bindings: state.scene.plcTagMap.bindings,
      bufferView: runtimeBusClient.bufferView,
      pathNodeId: hit.pathNodeId,
      distanceMm: hit.distanceMm,
      shape,
      dimensionsMm,
      colorHex,
      customComponentId,
    });

    if (!placed) {
      set({
        statusMessage: 'Selected conveyor belt is completely full — clear or run the line.',
      });
      return false;
    }

    // Immediately push updated PE/PX sensor states to PLC worker even if STOPPED/PAUSED!
    runtimeBusClient.pushSimInputsToWorker();

    const instName =
      state.scene.instances.find((i) => i.id === hit.instanceId)?.name ??
      hit.instanceId;

    set({
      statusMessage:
        state.runState === 'RUNNING'
          ? `Dropped ${label} (#${placed.serialNumber}) onto ${instName} @ ${Math.round(placed.distanceMm)} mm — flowing!`
          : `Staged ${label} (#${placed.serialNumber}) on ${instName} @ ${Math.round(placed.distanceMm)} mm (Sensors active! Press Play / Space to run belt).`,
    });
    return true;
  },

  dropWorkpieceQuick: (source, targetInstanceId) => {
    const state = get();
    const graph = state.scene.transportGraph;
    const allNodes = Object.values(graph.nodes);
    if (allNodes.length === 0) {
      set({
        statusMessage:
          'No Conveyor Spline Path in scene yet — add a Conveyor or generate a Spline Path first.',
      });
      return false;
    }

    let shape: WorkpieceShapeType = 'carton';
    let dimensionsMm: Vector3Tuple = [280, 220, 160];
    let colorHex = '#0ea5e9';
    let label = 'Carton Box';
    let customComponentId: UUID | undefined;

    if (source.kind === 'preset') {
      const preset = getWorkpiecePresetById(source.presetId);
      if (!preset) return false;
      shape = preset.shape;
      dimensionsMm = [...preset.dimensionsMm] as Vector3Tuple;
      colorHex = preset.colorHex;
      label = preset.name;
    } else {
      const comp = state.scene.componentLibrary.find(
        (c) => c.id === source.componentId
      );
      if (!comp) return false;
      shape = 'custom-model';
      customComponentId = comp.id;
      dimensionsMm = computeWorkpieceDimensionsFromComponent(comp);
      colorHex = '#38bdf8';
      label = comp.name;
    }

    const desiredInstId = targetInstanceId ?? state.selectedInstanceId;
    const selectedNode = desiredInstId
      ? allNodes.find((n) => n.instanceId === desiredInstId && n.arcLengthMm >= 250) ??
        allNodes.find((n) => n.instanceId === desiredInstId)
      : undefined;

    const spawnerNode = graph.spawners[0]
      ? graph.nodes[graph.spawners[0].targetPathNodeId]
      : undefined;

    const targetNode = selectedNode ?? spawnerNode ?? allNodes[0];
    if (!targetNode) return false;

    const startOffsetMm = Math.min(
      targetNode.arcLengthMm * 0.25,
      dimensionsMm[0] * 0.5 + 45
    );

    const placed = transportRuntime.placeWorkpieceOnPath({
      graph,
      instances: state.scene.instances,
      componentLibrary: state.scene.componentLibrary,
      bindings: state.scene.plcTagMap.bindings,
      bufferView: runtimeBusClient.bufferView,
      pathNodeId: targetNode.id,
      distanceMm: startOffsetMm,
      shape,
      dimensionsMm,
      colorHex,
      customComponentId,
    });

    if (!placed) {
      set({
        statusMessage: 'Target conveyor belt is currently full — run or clear parts.',
      });
      return false;
    }

    runtimeBusClient.pushSimInputsToWorker();

    let nextRunState = state.runState;
    if (state.runState === 'STOPPED') {
      nextRunState = 'RUNNING';
      runtimeBusClient.sendControl(
        'RUNNING',
        state.scene.environment.simSpeedMultiplier
      );
    }

    const instName =
      state.scene.instances.find((i) => i.id === targetNode.instanceId)?.name ??
      targetNode.instanceId;

    set({
      runState: nextRunState,
      statusMessage: `Fed ${label} (#${placed.serialNumber}, ${dimensionsMm.join('×')} mm) onto ${instName}.`,
    });
    return true;
  },

  clearAllActiveFlowItems: () => {
    const state = get();
    transportRuntime.clearAllFlowItems(
      runtimeBusClient.bufferView,
      state.scene.transportGraph
    );
    set({
      statusMessage: 'Cleared all active workpieces and reset belt counters.',
    });
  },

  addInstancePathSensor: (instanceId, sensorType) => {
    const state = get();
    const primaryNode = Object.values(state.scene.transportGraph.nodes).find(
      (n) => n.instanceId === instanceId
    );
    if (!primaryNode) {
      set({
        statusMessage: 'Create a Spline Path on this conveyor before adding a sensor.',
      });
      return;
    }

    const existingCount = state.scene.transportGraph.sensors.filter(
      (s) => s.instanceId === instanceId
    ).length;
    const prefix = sensorType === 'photoelectric' ? 'PE' : 'PX';
    const sensorId = `sens-${crypto.randomUUID().slice(0, 6)}`;
    const defaultOffset = Number(
      Math.min(
        primaryNode.arcLengthMm * 0.85,
        primaryNode.arcLengthMm * (0.35 + (existingCount % 3) * 0.25)
      ).toFixed(0)
    );

    const newSensor: PathSensorBinding = {
      id: sensorId,
      name: `${prefix}_Sensor_${existingCount + 1}`,
      instanceId,
      pathNodeId: primaryNode.id,
      offsetMm: defaultOffset,
      detectionRadiusMm: sensorType === 'photoelectric' ? 22 : 45,
      sensorType,
      outputBoolSlot: -1,
    };

    const synced = syncSceneTransportAndSignals({
      instances: state.scene.instances,
      componentLibrary: state.scene.componentLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: {
        ...state.scene.transportGraph,
        sensors: [...state.scene.transportGraph.sensors, newSensor],
      },
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage: `Mounted ${newSensor.name} (${sensorType}) at ${defaultOffset} mm along path.`,
    });
  },

  updateInstancePathSensor: (sensorId, patch) => {
    const state = get();
    const nextSensors = state.scene.transportGraph.sensors.map((s) =>
      s.id === sensorId ? { ...s, ...patch } : s
    );
    const synced = syncSceneTransportAndSignals({
      instances: state.scene.instances,
      componentLibrary: state.scene.componentLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: {
        ...state.scene.transportGraph,
        sensors: nextSensors,
      },
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
    });
  },

  deleteInstancePathSensor: (sensorId) => {
    const state = get();
    const nextSensors = state.scene.transportGraph.sensors.filter(
      (s) => s.id !== sensorId
    );
    const synced = syncSceneTransportAndSignals({
      instances: state.scene.instances,
      componentLibrary: state.scene.componentLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: {
        ...state.scene.transportGraph,
        sensors: nextSensors,
      },
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage: 'Removed Path Sensor.',
    });
  },

  addInstanceVirtualEncoder: (instanceId) => {
    const state = get();
    const inst = state.scene.instances.find((i) => i.id === instanceId);
    if (!inst) return;
    const comp = state.scene.componentLibrary.find((c) => c.id === inst.componentId);
    if (!comp) return;

    const primaryNode = Object.values(state.scene.transportGraph.nodes).find(
      (n) => n.instanceId === instanceId
    );
    const linearOrRotary = Object.values(comp.nodeRoles).find(
      (r) => r.role === 'LinearAxis' || r.role === 'RotaryAxis'
    );

    let newEnc: VirtualEncoderConfig | null = null;
    if (primaryNode) {
      newEnc = {
        id: `enc-${crypto.randomUUID().slice(0, 6)}`,
        name: 'Belt HSC',
        sourceKind: 'transport-path',
        targetInstanceId: instanceId,
        targetSubKey: primaryNode.componentPathId,
        pulsesPerRevolution: 1024,
        travelMmPerRevolution: 471.24,
        rolloverModulo: 1_000_000,
        cumulativePulsesDintSlot: -1,
        actualPositionRealSlot: -1,
        actualVelocityRealSlot: -1,
      };
    } else if (linearOrRotary) {
      const isRot = linearOrRotary.role === 'RotaryAxis';
      newEnc = {
        id: `enc-${crypto.randomUUID().slice(0, 6)}`,
        name: isRot ? 'Rotary Servo' : 'Linear Servo',
        sourceKind: isRot ? 'rotary-axis' : 'linear-axis',
        targetInstanceId: instanceId,
        targetSubKey: linearOrRotary.nodeName,
        pulsesPerRevolution: 4096,
        travelMmPerRevolution: isRot ? 360 : 10,
        rolloverModulo: 2_147_483_647,
        cumulativePulsesDintSlot: -1,
        actualPositionRealSlot: -1,
        actualVelocityRealSlot: -1,
      };
    }

    if (!newEnc) {
      set({
        statusMessage:
          'Add a Spline Path or a Linear/Rotary Axis on this machine first to attach an Encoder.',
      });
      return;
    }

    const nextInstances = state.scene.instances.map((i) =>
      i.id === instanceId
        ? { ...i, parameters: { ...i.parameters, __disableAutoEncoder: false } }
        : i
    );
    const synced = syncSceneTransportAndSignals({
      instances: nextInstances,
      componentLibrary: state.scene.componentLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: {
        ...state.scene.transportGraph,
        encoders: [...state.scene.transportGraph.encoders, newEnc],
      },
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        instances: nextInstances,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage: `Attached Virtual HSC Encoder "${newEnc.name}" (DINT32 Pulses + REAL Position).`,
    });
  },

  updateInstanceVirtualEncoder: (encoderId, patch) => {
    const state = get();
    const nextEncoders = state.scene.transportGraph.encoders.map((e) =>
      e.id === encoderId ? { ...e, ...patch } : e
    );
    const synced = syncSceneTransportAndSignals({
      instances: state.scene.instances,
      componentLibrary: state.scene.componentLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: {
        ...state.scene.transportGraph,
        encoders: nextEncoders,
      },
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
    });
  },

  deleteInstanceVirtualEncoder: (encoderId) => {
    const state = get();
    const target = state.scene.transportGraph.encoders.find((e) => e.id === encoderId);
    const nextEncoders = state.scene.transportGraph.encoders.filter(
      (e) => e.id !== encoderId
    );
    const nextInstances = target
      ? state.scene.instances.map((i) =>
          i.id === target.targetInstanceId
            ? { ...i, parameters: { ...i.parameters, __disableAutoEncoder: true } }
            : i
        )
      : state.scene.instances;

    const synced = syncSceneTransportAndSignals({
      instances: nextInstances,
      componentLibrary: state.scene.componentLibrary,
      snapConnections: state.scene.snapConnections,
      prevTransportGraph: {
        ...state.scene.transportGraph,
        encoders: nextEncoders,
      },
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        instances: nextInstances,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage: 'Removed Virtual Encoder.',
    });
  },

  updateEnvironment: (patch) =>
    set((state) => {
      const nextEnvironment: SceneEnvironmentConfig = {
        ...state.scene.environment,
        ...patch,
      };
      saveViewportPrefs(nextEnvironment);
      return {
        isDirty: true,
        scene: {
          ...state.scene,
          environment: nextEnvironment,
        },
      };
    }),

  renameScene: (name) =>
    set((state) => ({
      isDirty: true,
      scene: {
        ...state.scene,
        metadata: {
          ...state.scene.metadata,
          name,
          updatedAt: new Date().toISOString(),
        },
      },
    })),

  newEmptyScene: () => {
    const empty = createEmptySceneSchema(structuredClone(BUILTIN_COMPONENT_CATALOG));
    empty.environment = {
      ...empty.environment,
      ...loadSavedViewportPrefs(),
    };
    transportRuntime.clearAllFlowItems(
      runtimeBusClient.bufferView,
      empty.transportGraph
    );
    runtimeBusClient.sendControl('STOPPED', 1.0);
    runtimeBusClient.syncTagMap(empty.plcTagMap);
    set({
      scene: empty,
      selectedInstanceId: null,
      selectedSubMeshName: null,
      jogPreview: null,
      isDrawingSplinePath: false,
      activeSnapPreview: null,
      runState: 'STOPPED',
      isDirty: false,
      statusMessage:
        'Created new empty factory layout. Drag a .glb / OpenUSD file or click an asset from the Catalog.',
    });
  },

  loadStarterDemoScene: () => {
    const demo = buildStarterDemoScene();
    transportRuntime.clearAllFlowItems(
      runtimeBusClient.bufferView,
      demo.transportGraph
    );
    runtimeBusClient.sendControl('STOPPED', 1.0);
    runtimeBusClient.syncTagMap(demo.plcTagMap);
    set({
      scene: demo,
      selectedInstanceId: 'inst-gantry-01',
      selectedSubMeshName: null,
      jogPreview: null,
      isDrawingSplinePath: false,
      activeSnapPreview: null,
      runState: 'STOPPED',
      isDirty: false,
      statusMessage:
        'Loaded Dual-Lane Vacuum Pick & Transfer Demo Line — press Play (Space) to watch cartons get picked & transferred to Lane 2!',
    });
  },

  loadSceneFromJsonString: (jsonText, sourceLabel = 'JSON file') => {
    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (!isValidSceneSchema(parsed)) {
        set({
          statusMessage: `Invalid Scene Schema in ${sourceLabel}: missing required VC Digital Twin fields.`,
        });
        return false;
      }

      const mergedMap = new Map<UUID, ComponentDefinition>();
      for (const builtin of BUILTIN_COMPONENT_CATALOG) {
        mergedMap.set(builtin.id, structuredClone(builtin));
      }
      for (const comp of parsed.componentLibrary) {
        const builtinDef =
          comp.modelSource.kind === 'builtin'
            ? BUILTIN_COMPONENT_CATALOG.find((b) => b.id === comp.id)
            : undefined;
        const mergedNodeRoles = builtinDef
          ? { ...structuredClone(builtinDef.nodeRoles), ...structuredClone(comp.nodeRoles) }
          : structuredClone(comp.nodeRoles);

        // Migrate legacy strokes & upgrade saved OpenUSD Cartesian Gantry to v0.5.0 Dual-Lane VacuumGripper
        if (
          comp.id === 'builtin-pneumatic-stopper' &&
          mergedNodeRoles.Piston_Stopper_Blade_Axis?.role === 'LinearAxis' &&
          mergedNodeRoles.Piston_Stopper_Blade_Axis.maxLimitMm === 110
        ) {
          mergedNodeRoles.Piston_Stopper_Blade_Axis.maxLimitMm = 95;
        }
        const upgradeDualLaneGantry =
          comp.id === 'builtin-openusd-cartesian-gantry' && builtinDef !== undefined;
        if (upgradeDualLaneGantry && builtinDef) {
          if (
            mergedNodeRoles.Vertical_Z_Mast_Axis?.role === 'LinearAxis' &&
            (mergedNodeRoles.Vertical_Z_Mast_Axis.maxLimitMm === 240 ||
              mergedNodeRoles.Vertical_Z_Mast_Axis.maxLimitMm === 165)
          ) {
            mergedNodeRoles.Vertical_Z_Mast_Axis.maxLimitMm = 250;
          }
          if (
            mergedNodeRoles.Servo_Traverse_Carriage_Axis?.role === 'LinearAxis' &&
            mergedNodeRoles.Servo_Traverse_Carriage_Axis.maxLimitMm === 420
          ) {
            mergedNodeRoles.Servo_Traverse_Carriage_Axis.minLimitMm = -150;
            mergedNodeRoles.Servo_Traverse_Carriage_Axis.maxLimitMm = 900;
          }
          if (
            !mergedNodeRoles.Vacuum_Gripper_Tool_Axis ||
            mergedNodeRoles.Vacuum_Gripper_Tool_Axis.role === 'StaticMesh'
          ) {
            mergedNodeRoles.Vacuum_Gripper_Tool_Axis = structuredClone(
              builtinDef.nodeRoles.Vacuum_Gripper_Tool_Axis
            );
          }
        }

        mergedMap.set(comp.id, {
          ...comp,
          ...(builtinDef
            ? {
                boundingBox: structuredClone(builtinDef.boundingBox),
                modelSource: structuredClone(builtinDef.modelSource),
                ...(upgradeDualLaneGantry && comp.transportPaths.length < 2
                  ? {
                      snapPorts: structuredClone(builtinDef.snapPorts),
                      transportPaths: structuredClone(builtinDef.transportPaths),
                    }
                  : {}),
              }
            : {}),
          nodeRoles: mergedNodeRoles,
          exposedSignals: synthesizeComponentSignals(mergedNodeRoles),
        });
      }
      const mergedLibrary = Array.from(mergedMap.values());
      const snapConnections = recomputeSceneSnapConnections(
        parsed.instances,
        mergedMap
      );
      const synced = syncSceneTransportAndSignals({
        instances: parsed.instances,
        componentLibrary: mergedLibrary,
        snapConnections,
        prevTransportGraph: parsed.transportGraph ?? createEmptyTransportGraph(),
        prevTagMap: parsed.plcTagMap,
      });

      transportRuntime.clearAllFlowItems(
        runtimeBusClient.bufferView,
        synced.transportGraph
      );
      runtimeBusClient.sendControl(
        'STOPPED',
        parsed.environment.simSpeedMultiplier ?? 1.0
      );
      runtimeBusClient.syncTagMap(synced.plcTagMap);

      const savedPrefs = loadSavedViewportPrefs();
      set({
        scene: {
          ...parsed,
          environment: {
            showTransportPaths: true,
            showOriginAxes: savedPrefs.showOriginAxes ?? true,
            viewportTheme: savedPrefs.viewportTheme ?? 'sketchup-white',
            customBackgroundColor: savedPrefs.customBackgroundColor ?? '#ffffff',
            customFloorColor: savedPrefs.customFloorColor ?? '#ffffff',
            ...parsed.environment,
          },
          componentLibrary: mergedLibrary,
          snapConnections,
          transportGraph: synced.transportGraph,
          plcTagMap: synced.plcTagMap,
        },
        selectedInstanceId: parsed.instances[0]?.id ?? null,
        selectedSubMeshName: null,
        jogPreview: null,
        isDrawingSplinePath: false,
        activeSnapPreview: null,
        runState: 'STOPPED',
        isDirty: false,
        statusMessage: `Loaded "${parsed.metadata.name}" from ${sourceLabel} (${parsed.instances.length} machines, ${synced.plcTagMap.bindings.length} I/O signals).`,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Malformed JSON';
      set({ statusMessage: `Failed to parse ${sourceLabel}: ${message}` });
      return false;
    }
  },

  saveSceneInteractive: async () => {
    const state = get();
    const updatedScene: SceneSchema = {
      ...state.scene,
      metadata: {
        ...state.scene.metadata,
        updatedAt: new Date().toISOString(),
      },
    };
    const jsonPayload = JSON.stringify(updatedScene, null, 2);
    const safeFileSlug =
      updatedScene.metadata.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'factory-layout';
    const suggestedName = `${safeFileSlug}.vcscene.json`;

    if (typeof window !== 'undefined' && window.electronAPI) {
      const res = await window.electronAPI.saveSceneDialog(jsonPayload, suggestedName);
      if (res.saved) {
        set({
          scene: updatedScene,
          isDirty: false,
          statusMessage: `Saved Scene JSON to ${res.filePath}`,
        });
      }
      return;
    }

    const blob = new Blob([jsonPayload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = suggestedName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);

    set({
      scene: updatedScene,
      isDirty: false,
      statusMessage: `Exported "${suggestedName}" (${(jsonPayload.length / 1024).toFixed(1)} KB)`,
    });
  },

  openSceneInteractive: async () => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      const loaded = await window.electronAPI.loadSceneDialog();
      if (!loaded) return;
      get().loadSceneFromJsonString(loaded.jsonContent, loaded.fileName);
      return;
    }

    await new Promise<void>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (file) {
          const text = await file.text();
          get().loadSceneFromJsonString(text, file.name);
        }
        resolve();
      };
      input.click();
    });
  },

  spawnInstance: (componentId, worldDropPos) => {
    const state = get();
    const catalogMap = getCatalogMap(state.scene.componentLibrary);
    const component = catalogMap.get(componentId);
    if (!component) return null;

    const countOfType =
      state.scene.instances.filter((i) => i.componentId === componentId).length + 1;
    const baseSlug = component.name
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
    const instanceName = `${baseSlug}_${String(countOfType).padStart(2, '0')}`;
    const newId = `inst-${crypto.randomUUID().slice(0, 8)}`;

    const fallbackOffset = (state.scene.instances.length % 5) * 0.65 - 1.2;
    const initialPos: Vector3Tuple = worldDropPos
      ? [
          Number(worldDropPos[0].toFixed(3)),
          Number(worldDropPos[1].toFixed(3)),
          Number(worldDropPos[2].toFixed(3)),
        ]
      : [Number(fallbackOffset.toFixed(2)), 0, Number((fallbackOffset * 0.5).toFixed(2))];

    let initialTransform: TransformData = {
      position: initialPos,
      rotationDeg: [0, 0, 0],
      scale: [1, 1, 1],
    };

    let snapNote = '';
    if (state.scene.environment.snapEnabled) {
      const snapCheck = solveMagneticSnap({
        movingInstanceId: newId,
        movingComponent: component,
        candidateTransform: initialTransform,
        otherInstances: state.scene.instances,
        catalogMap,
        snapRadiusMeters: state.scene.environment.snapRadiusMeters,
        autoAlignRotation: state.scene.environment.autoAlignPortRotation,
      });
      if (snapCheck.snapped) {
        initialTransform = snapCheck.transform;
        snapNote = ` — Magnetically docked to ${snapCheck.targetInstanceName} (${snapCheck.targetPort?.name})`;
      }
    }

    const newInstance: SceneNodeInstance = {
      id: newId,
      name: instanceName,
      componentId,
      transform: initialTransform,
      visible: true,
      locked: false,
      parameters: {},
    };

    const nextInstances = [...state.scene.instances, newInstance];
    const nextConnections = recomputeSceneSnapConnections(nextInstances, catalogMap);
    const synced = syncSceneTransportAndSignals({
      instances: nextInstances,
      componentLibrary: state.scene.componentLibrary,
      snapConnections: nextConnections,
      prevTransportGraph: state.scene.transportGraph,
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      selectedInstanceId: newId,
      selectedSubMeshName:
        state.inspectorTab === 'builder' ? pickDefaultSubMesh(component) : null,
      jogPreview: null,
      isDrawingSplinePath: false,
      scene: {
        ...state.scene,
        instances: nextInstances,
        snapConnections: nextConnections,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage: `Placed "${instanceName}"${snapNote}`,
    });

    return newId;
  },

  importGlbBuffer: async (fileName, buffer, options) => {
    try {
      set({ statusMessage: `Parsing 3D model "${fileName}"...` });
      const definition = await buildComponentDefinitionFromGlbBuffer(
        fileName,
        buffer,
        options?.filePath
      );

      set((state) => ({
        isDirty: true,
        scene: {
          ...state.scene,
          componentLibrary: [...state.scene.componentLibrary, definition],
        },
      }));

      if (options?.spawnInScene !== false) {
        get().spawnInstance(definition.id, options?.dropPos);
      } else {
        set({
          statusMessage: `Imported "${definition.name}" into Component Library (${definition.snapPorts.length} auto SnapPorts).`,
        });
      }

      return definition;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Unsupported glTF (.glb/.gltf) or OpenUSD (.usd/.usda/.usdc/.usdz) file';
      set({ statusMessage: `Failed to import "${fileName}": ${msg}` });
      return null;
    }
  },

  importGlbInteractive: async () => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      const opened = await window.electronAPI.openGlbDialog();
      if (!opened) return;
      const binaryString = atob(opened.base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      await get().importGlbBuffer(opened.fileName, bytes.buffer, {
        spawnInScene: true,
        filePath: opened.filePath,
      });
      return;
    }

    await new Promise<void>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept =
        '.glb,.gltf,.usd,.usda,.usdc,.usdz,model/gltf-binary,model/gltf+json,model/vnd.usdz+zip,model/vnd.usd';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (file) {
          const buf = await file.arrayBuffer();
          await get().importGlbBuffer(file.name, buf, { spawnInScene: true });
        }
        resolve();
      };
      input.click();
    });
  },

  exportComponentVcompInteractive: async (componentId) => {
    const comp = get().scene.componentLibrary.find((c) => c.id === componentId);
    if (!comp) return;

    const payload = JSON.stringify(comp, null, 2);
    const slug = comp.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const suggestedName = `${slug}.vcomp.json`;

    if (typeof window !== 'undefined' && window.electronAPI) {
      const res = await window.electronAPI.saveComponentDialog(payload, suggestedName);
      if (res.saved) {
        set({ statusMessage: `Exported Component Definition to ${res.filePath}` });
      }
      return;
    }

    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    set({ statusMessage: `Exported reusable component "${suggestedName}"` });
  },

  updateInstanceTransform: (instanceId, transform, commitConnections = false) =>
    set((state) => {
      const nextInstances = state.scene.instances.map((inst) =>
        inst.id === instanceId ? { ...inst, transform } : inst
      );
      if (!commitConnections) {
        return {
          isDirty: true,
          scene: {
            ...state.scene,
            instances: nextInstances,
          },
        };
      }

      const nextConnections = recomputeSceneSnapConnections(
        nextInstances,
        getCatalogMap(state.scene.componentLibrary)
      );
      const synced = syncSceneTransportAndSignals({
        instances: nextInstances,
        componentLibrary: state.scene.componentLibrary,
        snapConnections: nextConnections,
        prevTransportGraph: state.scene.transportGraph,
        prevTagMap: state.scene.plcTagMap,
      });
      runtimeBusClient.syncTagMap(synced.plcTagMap);

      return {
        isDirty: true,
        scene: {
          ...state.scene,
          instances: nextInstances,
          snapConnections: nextConnections,
          transportGraph: synced.transportGraph,
          plcTagMap: synced.plcTagMap,
        },
      };
    }),

  renameInstance: (instanceId, name) =>
    set((state) => {
      const nextInstances = state.scene.instances.map((inst) =>
        inst.id === instanceId ? { ...inst, name } : inst
      );
      const synced = syncSceneTransportAndSignals({
        instances: nextInstances,
        componentLibrary: state.scene.componentLibrary,
        snapConnections: state.scene.snapConnections,
        prevTransportGraph: state.scene.transportGraph,
        prevTagMap: state.scene.plcTagMap,
      });
      return {
        isDirty: true,
        scene: {
          ...state.scene,
          instances: nextInstances,
          transportGraph: synced.transportGraph,
          plcTagMap: synced.plcTagMap,
        },
      };
    }),

  toggleInstanceVisibility: (instanceId) =>
    set((state) => {
      const nextInstances = state.scene.instances.map((inst) =>
        inst.id === instanceId ? { ...inst, visible: !inst.visible } : inst
      );
      const nextConnections = recomputeSceneSnapConnections(
        nextInstances,
        getCatalogMap(state.scene.componentLibrary)
      );
      const synced = syncSceneTransportAndSignals({
        instances: nextInstances,
        componentLibrary: state.scene.componentLibrary,
        snapConnections: nextConnections,
        prevTransportGraph: state.scene.transportGraph,
        prevTagMap: state.scene.plcTagMap,
      });
      runtimeBusClient.syncTagMap(synced.plcTagMap);

      return {
        isDirty: true,
        scene: {
          ...state.scene,
          instances: nextInstances,
          snapConnections: nextConnections,
          transportGraph: synced.transportGraph,
          plcTagMap: synced.plcTagMap,
        },
      };
    }),

  toggleInstanceLock: (instanceId) =>
    set((state) => ({
      isDirty: true,
      scene: {
        ...state.scene,
        instances: state.scene.instances.map((inst) =>
          inst.id === instanceId ? { ...inst, locked: !inst.locked } : inst
        ),
      },
    })),

  duplicateInstance: (instanceId) => {
    const state = get();
    const target = state.scene.instances.find((i) => i.id === instanceId);
    if (!target) return;

    const dupId = `inst-${crypto.randomUUID().slice(0, 8)}`;
    const duplicated: SceneNodeInstance = {
      ...structuredClone(target),
      id: dupId,
      name: `${target.name}_Copy`,
      transform: {
        ...structuredClone(target.transform),
        position: [
          Number((target.transform.position[0] + 0.6).toFixed(3)),
          target.transform.position[1],
          Number((target.transform.position[2] + 0.6).toFixed(3)),
        ],
      },
    };

    const nextInstances = [...state.scene.instances, duplicated];
    const catalogMap = getCatalogMap(state.scene.componentLibrary);
    const nextConnections = recomputeSceneSnapConnections(nextInstances, catalogMap);
    const synced = syncSceneTransportAndSignals({
      instances: nextInstances,
      componentLibrary: state.scene.componentLibrary,
      snapConnections: nextConnections,
      prevTransportGraph: state.scene.transportGraph,
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      selectedInstanceId: dupId,
      jogPreview: null,
      isDrawingSplinePath: false,
      scene: {
        ...state.scene,
        instances: nextInstances,
        snapConnections: nextConnections,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage: `Duplicated "${target.name}" -> "${duplicated.name}"`,
    });
  },

  deleteInstance: (instanceId) => {
    const state = get();
    const removed = state.scene.instances.find((i) => i.id === instanceId);
    const nextInstances = state.scene.instances.filter((i) => i.id !== instanceId);
    const nextConnections = recomputeSceneSnapConnections(
      nextInstances,
      getCatalogMap(state.scene.componentLibrary)
    );
    const synced = syncSceneTransportAndSignals({
      instances: nextInstances,
      componentLibrary: state.scene.componentLibrary,
      snapConnections: nextConnections,
      prevTransportGraph: state.scene.transportGraph,
      prevTagMap: state.scene.plcTagMap,
    });
    runtimeBusClient.syncTagMap(synced.plcTagMap);

    set({
      isDirty: true,
      selectedInstanceId:
        state.selectedInstanceId === instanceId ? null : state.selectedInstanceId,
      selectedSubMeshName:
        state.selectedInstanceId === instanceId ? null : state.selectedSubMeshName,
      jogPreview: null,
      isDrawingSplinePath: false,
      activeSnapPreview: null,
      scene: {
        ...state.scene,
        instances: nextInstances,
        snapConnections: nextConnections,
        transportGraph: synced.transportGraph,
        plcTagMap: synced.plcTagMap,
      },
      statusMessage: removed ? `Deleted "${removed.name}"` : state.statusMessage,
    });
  },

  addSnapPort: (componentId, role) =>
    set((state) => {
      const nextLib = state.scene.componentLibrary.map((comp) => {
        if (comp.id !== componentId) return comp;
        const idx = comp.snapPorts.length + 1;
        const defaultNormal: Vector3Tuple =
          role === 'InputPort' ? [-1, 0, 0] : [1, 0, 0];
        const defaultX =
          role === 'InputPort' ? comp.boundingBox.min[0] : comp.boundingBox.max[0];
        const newPort: SnapPortDefinition = {
          id: `port-${crypto.randomUUID().slice(0, 6)}`,
          name: `${role === 'InputPort' ? 'InPort' : role === 'OutputPort' ? 'OutPort' : 'BiPort'}_${idx}`,
          role,
          protocol: 'material-flow',
          localPosition: [defaultX, 0.78, 0],
          localNormal: defaultNormal,
          localUp: [0, 1, 0],
        };
        return {
          ...comp,
          snapPorts: [...comp.snapPorts, newPort],
        };
      });

      const nextConnections = recomputeSceneSnapConnections(
        state.scene.instances,
        getCatalogMap(nextLib)
      );
      const synced = syncSceneTransportAndSignals({
        instances: state.scene.instances,
        componentLibrary: nextLib,
        snapConnections: nextConnections,
        prevTransportGraph: state.scene.transportGraph,
        prevTagMap: state.scene.plcTagMap,
      });

      return {
        isDirty: true,
        scene: {
          ...state.scene,
          componentLibrary: nextLib,
          snapConnections: nextConnections,
          transportGraph: synced.transportGraph,
          plcTagMap: synced.plcTagMap,
        },
        statusMessage: `Added new ${role} to component.`,
      };
    }),

  updateSnapPort: (componentId, portId, patch) =>
    set((state) => {
      const nextLib = state.scene.componentLibrary.map((comp) => {
        if (comp.id !== componentId) return comp;
        return {
          ...comp,
          snapPorts: comp.snapPorts.map((p) =>
            p.id === portId ? { ...p, ...patch } : p
          ),
        };
      });

      const nextConnections = recomputeSceneSnapConnections(
        state.scene.instances,
        getCatalogMap(nextLib)
      );
      const synced = syncSceneTransportAndSignals({
        instances: state.scene.instances,
        componentLibrary: nextLib,
        snapConnections: nextConnections,
        prevTransportGraph: state.scene.transportGraph,
        prevTagMap: state.scene.plcTagMap,
      });

      return {
        isDirty: true,
        scene: {
          ...state.scene,
          componentLibrary: nextLib,
          snapConnections: nextConnections,
          transportGraph: synced.transportGraph,
          plcTagMap: synced.plcTagMap,
        },
      };
    }),

  deleteSnapPort: (componentId, portId) =>
    set((state) => {
      const nextLib = state.scene.componentLibrary.map((comp) => {
        if (comp.id !== componentId) return comp;
        return {
          ...comp,
          snapPorts: comp.snapPorts.filter((p) => p.id !== portId),
        };
      });

      const nextConnections = recomputeSceneSnapConnections(
        state.scene.instances,
        getCatalogMap(nextLib)
      );
      const synced = syncSceneTransportAndSignals({
        instances: state.scene.instances,
        componentLibrary: nextLib,
        snapConnections: nextConnections,
        prevTransportGraph: state.scene.transportGraph,
        prevTagMap: state.scene.plcTagMap,
      });

      return {
        isDirty: true,
        scene: {
          ...state.scene,
          componentLibrary: nextLib,
          snapConnections: nextConnections,
          transportGraph: synced.transportGraph,
          plcTagMap: synced.plcTagMap,
        },
      };
    }),

  // =========================================================================
  // MILESTONE 4: LIVE PLC DRIVERS & FULL I/O TAG BINDING MATRIX ACTIONS
  // =========================================================================

  setTagMatrixModalOpen: (isTagMatrixModalOpen) => set({ isTagMatrixModalOpen }),

  setPlcActiveAdapter: (adapter, autoConvertAddresses = true) => {
    const state = get();
    const prevMap = state.scene.plcTagMap;
    let nextBindings = prevMap.bindings;
    let autoRemappedLabel = '';

    if (
      autoConvertAddresses &&
      adapter !== 'InternalSimAdapter' &&
      prevMap.bindings.length > 0
    ) {
      const validCount = prevMap.bindings.filter(
        (b) =>
          validatePlcAddress(
            adapter,
            b.plcAddress,
            b.dataType,
            prevMap.opcUaConfig.namespaceIndex
          ).valid
      ).length;

      if (validCount < Math.ceil(prevMap.bindings.length * 0.5)) {
        const preset: VendorAddressPreset =
          adapter === 'SiemensS7Adapter'
            ? 's7-process-image'
            : adapter === 'MitsubishiMcAdapter'
              ? 'mitsubishi-xy-d'
              : 'opcua-symbolic';
        nextBindings = generateVendorAddressesForBindings(
          prevMap.bindings,
          preset,
          prevMap.opcUaConfig.namespaceIndex
        );
        autoRemappedLabel = ` (auto-mapped ${nextBindings.length} tags to ${preset})`;
      }
    }

    const nextTagMap = {
      ...prevMap,
      activeAdapter: adapter,
      bindings: nextBindings,
    };
    runtimeBusClient.syncTagMap(nextTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        plcTagMap: nextTagMap,
      },
      statusMessage: `Switched PLC Engine Driver -> ${adapter}${autoRemappedLabel}.`,
    });
  },

  setPlcScanCycleMs: (scanCycleMs) => {
    const state = get();
    const clamped = Math.max(5, Math.min(20, Math.round(scanCycleMs || 10)));
    const nextTagMap = {
      ...state.scene.plcTagMap,
      scanCycleMs: clamped,
    };
    runtimeBusClient.syncTagMap(nextTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        plcTagMap: nextTagMap,
      },
      statusMessage: `Updated cyclic PLC scan period -> ${clamped} ms (${Math.round(1000 / clamped)} Hz).`,
    });
  },

  updateS7DriverConfig: (patch) => {
    const state = get();
    const nextTagMap = {
      ...state.scene.plcTagMap,
      s7Config: {
        ...state.scene.plcTagMap.s7Config,
        ...patch,
      },
    };
    runtimeBusClient.syncTagMap(nextTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        plcTagMap: nextTagMap,
      },
    });
  },

  updateMcDriverConfig: (patch) => {
    const state = get();
    const nextTagMap = {
      ...state.scene.plcTagMap,
      mcConfig: {
        ...state.scene.plcTagMap.mcConfig,
        ...patch,
      },
    };
    runtimeBusClient.syncTagMap(nextTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        plcTagMap: nextTagMap,
      },
    });
  },

  updateOpcUaDriverConfig: (patch) => {
    const state = get();
    const nextTagMap = {
      ...state.scene.plcTagMap,
      opcUaConfig: {
        ...state.scene.plcTagMap.opcUaConfig,
        ...patch,
      },
    };
    runtimeBusClient.syncTagMap(nextTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        plcTagMap: nextTagMap,
      },
    });
  },

  updatePlcTagBinding: (bindingId, patch) => {
    const state = get();
    const nextBindings = state.scene.plcTagMap.bindings.map((b) => {
      if (b.id !== bindingId) return b;
      const nextScale =
        patch.scaleFactor !== undefined &&
        Number.isFinite(patch.scaleFactor) &&
        patch.scaleFactor !== 0
          ? patch.scaleFactor
          : b.scaleFactor;
      const nextOffset =
        patch.offset !== undefined && Number.isFinite(patch.offset)
          ? patch.offset
          : b.offset;
      return {
        ...b,
        plcAddress: patch.plcAddress !== undefined ? patch.plcAddress : b.plcAddress,
        scaleFactor: nextScale,
        offset: nextOffset,
      };
    });

    const nextTagMap = {
      ...state.scene.plcTagMap,
      bindings: nextBindings,
    };
    runtimeBusClient.syncTagMap(nextTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        plcTagMap: nextTagMap,
      },
    });
  },

  applyPlcAddressPreset: (preset) => {
    const state = get();
    const prevMap = state.scene.plcTagMap;
    const nextBindings = generateVendorAddressesForBindings(
      prevMap.bindings,
      preset,
      prevMap.opcUaConfig.namespaceIndex
    );

    const targetAdapter: PlcAdapterType =
      preset === 's7-process-image' || preset === 's7-db1'
        ? prevMap.activeAdapter === 'SiemensS7Adapter' ||
          prevMap.activeAdapter === 'InternalSimAdapter'
          ? prevMap.activeAdapter
          : 'SiemensS7Adapter'
        : preset === 'mitsubishi-xy-d'
          ? prevMap.activeAdapter === 'MitsubishiMcAdapter' ||
            prevMap.activeAdapter === 'InternalSimAdapter'
            ? prevMap.activeAdapter
            : 'MitsubishiMcAdapter'
          : prevMap.activeAdapter === 'OpcUaAdapter' ||
              prevMap.activeAdapter === 'InternalSimAdapter'
            ? prevMap.activeAdapter
            : 'OpcUaAdapter';

    const nextTagMap = {
      ...prevMap,
      activeAdapter: targetAdapter,
      bindings: nextBindings,
    };
    runtimeBusClient.syncTagMap(nextTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        plcTagMap: nextTagMap,
      },
      statusMessage: `Applied "${preset}" vendor address mapping across ${nextBindings.length} I/O signals.`,
    });
  },

  triggerPlcConnectionAction: (action) => {
    const state = get();
    runtimeBusClient.sendConnectionAction(action);
    set({
      statusMessage: `PLC Driver [${state.scene.plcTagMap.activeAdapter}] -> ${action.toUpperCase()} requested.`,
    });
  },

  exportPlcTagCsvInteractive: () => {
    const state = get();
    const csv = exportTagBindingsToCsv(state.scene.plcTagMap.bindings);
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const safeName =
      state.scene.metadata.name
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/^_|_$/g, '') || 'vc_scene';

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}_plc_tags.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    set({
      statusMessage: `Exported ${state.scene.plcTagMap.bindings.length} I/O tag bindings to ${safeName}_plc_tags.csv.`,
    });
  },

  importPlcTagCsvText: (csvText, sourceName = 'CSV') => {
    const state = get();
    const patches = parseTagBindingsCsvPatch(csvText);
    if (patches.size === 0) {
      set({
        statusMessage: `No valid PlcAddress rows found in ${sourceName}. Expected header with BindingId or SignalName + PlcAddress.`,
      });
      return 0;
    }

    let updatedCount = 0;
    const nextBindings = state.scene.plcTagMap.bindings.map((b) => {
      const patch = patches.get(b.id) ?? patches.get(`NAME::${b.signalName}`);
      if (!patch) return b;
      updatedCount++;
      return {
        ...b,
        plcAddress: patch.plcAddress,
        scaleFactor:
          patch.scaleFactor !== undefined ? patch.scaleFactor : b.scaleFactor,
        offset: patch.offset !== undefined ? patch.offset : b.offset,
      };
    });

    const nextTagMap = {
      ...state.scene.plcTagMap,
      bindings: nextBindings,
    };
    runtimeBusClient.syncTagMap(nextTagMap);

    set({
      isDirty: true,
      scene: {
        ...state.scene,
        plcTagMap: nextTagMap,
      },
      statusMessage: `Imported ${updatedCount} PLC tag address/scale bindings from ${sourceName}.`,
    });
    return updatedCount;
  },
}));
