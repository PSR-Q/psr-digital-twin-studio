import { create } from 'zustand';
import { BUILTIN_COMPONENT_CATALOG } from '../engine/builtinCatalog';
import { buildComponentDefinitionFromGlbBuffer } from '../engine/glbAssetRegistry';
import { runtimeBusClient } from '../engine/runtimeBusClient';
import {
  recomputeSceneSnapConnections,
  solveMagneticSnap,
  type SnapSolveResult,
} from '../engine/snapEngine';
import {
  createEmptySceneSchema,
  isValidSceneSchema,
  type ComponentDefinition,
  type SceneEnvironmentConfig,
  type SceneNodeInstance,
  type SceneSchema,
  type SimulationRunState,
  type SnapPortDefinition,
  type TransformData,
  type UUID,
  type Vector3Tuple,
} from '../shared/schemas';

export type GizmoTransformMode = 'translate' | 'rotate' | 'scale';

function buildStarterDemoScene(): SceneSchema {
  const base = createEmptySceneSchema(structuredClone(BUILTIN_COMPONENT_CATALOG));
  base.metadata.name = 'Packaging & Mixing Line Demo';

  const instances: SceneNodeInstance[] = [
    {
      id: 'inst-conv-01',
      name: 'Infeed_Conveyor_01',
      componentId: 'builtin-belt-conveyor-2m',
      transform: {
        position: [-2.2, 0, 0],
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
        position: [-1.06, 0, 0],
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
        position: [0.38, 0, 0.42],
        rotationDeg: [0, 12, 0],
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
        position: [2.75, 0, 0],
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
        position: [2.75, 0, -2.1],
        rotationDeg: [0, 90, 0],
        scale: [1, 1, 1],
      },
      visible: true,
      locked: false,
      parameters: {},
    },
  ];

  const catalogMap = new Map(base.componentLibrary.map((c) => [c.id, c]));
  base.instances = instances;
  base.snapConnections = recomputeSceneSnapConnections(instances, catalogMap);
  return base;
}

export interface EditorStoreState {
  scene: SceneSchema;
  selectedInstanceId: UUID | null;
  gizmoMode: GizmoTransformMode;
  isGizmoDragging: boolean;
  activeSnapPreview: SnapSolveResult | null;
  runState: SimulationRunState;
  isDirty: boolean;
  statusMessage: string;

  // Selection & Gizmo
  selectInstance: (id: UUID | null) => void;
  setGizmoMode: (mode: GizmoTransformMode) => void;
  setGizmoDragging: (dragging: boolean) => void;
  setActiveSnapPreview: (snap: SnapSolveResult | null) => void;
  setStatusMessage: (msg: string) => void;

  // Simulation controls
  setRunState: (state: SimulationRunState) => void;
  setSimSpeedMultiplier: (speed: number) => void;

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

  // Snap Port Authoring (Milestone 1 Component Snap Customizer)
  addSnapPort: (componentId: UUID, role: SnapPortDefinition['role']) => void;
  updateSnapPort: (
    componentId: UUID,
    portId: UUID,
    patch: Partial<SnapPortDefinition>
  ) => void;
  deleteSnapPort: (componentId: UUID, portId: UUID) => void;
}

function getCatalogMap(library: ComponentDefinition[]): Map<UUID, ComponentDefinition> {
  return new Map(library.map((c) => [c.id, c]));
}

export const useEditorStore = create<EditorStoreState>((set, get) => ({
  scene: buildStarterDemoScene(),
  selectedInstanceId: 'inst-conv-02',
  gizmoMode: 'translate',
  isGizmoDragging: false,
  activeSnapPreview: null,
  runState: 'STOPPED',
  isDirty: false,
  statusMessage:
    'Ready — Drag Buffer_Conveyor_02 with Gizmo arrows toward Stopper_Gate_01 to test magnetic SnapPorts, or drop any .glb file.',

  selectInstance: (id) => set({ selectedInstanceId: id }),

  setGizmoMode: (gizmoMode) => set({ gizmoMode }),

  setGizmoDragging: (isGizmoDragging) =>
    set((s) => ({
      isGizmoDragging,
      activeSnapPreview: isGizmoDragging ? s.activeSnapPreview : null,
    })),

  setActiveSnapPreview: (activeSnapPreview) => set({ activeSnapPreview }),

  setStatusMessage: (statusMessage) => set({ statusMessage }),

  setRunState: (runState) => {
    const mult = get().scene.environment.simSpeedMultiplier;
    runtimeBusClient.sendControl(runState, mult);
    set({
      runState,
      statusMessage:
        runState === 'RUNNING'
          ? `Simulation RUNNING (${mult.toFixed(1)}x speed — Cyclic I/O Bus Active)`
          : runState === 'PAUSED'
            ? 'Simulation PAUSED'
            : 'Simulation STOPPED & Reset',
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

  updateEnvironment: (patch) =>
    set((state) => ({
      isDirty: true,
      scene: {
        ...state.scene,
        environment: {
          ...state.scene.environment,
          ...patch,
        },
      },
    })),

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
    runtimeBusClient.sendControl('STOPPED', 1.0);
    set({
      scene: createEmptySceneSchema(structuredClone(BUILTIN_COMPONENT_CATALOG)),
      selectedInstanceId: null,
      activeSnapPreview: null,
      runState: 'STOPPED',
      isDirty: false,
      statusMessage: 'Created new empty factory layout. Drag a .glb or click an asset from the Catalog.',
    });
  },

  loadStarterDemoScene: () => {
    runtimeBusClient.sendControl('STOPPED', 1.0);
    set({
      scene: buildStarterDemoScene(),
      selectedInstanceId: 'inst-conv-02',
      activeSnapPreview: null,
      runState: 'STOPPED',
      isDirty: false,
      statusMessage: 'Loaded Packaging & Mixing Line Demo layout.',
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

      // Ensure built-in catalog items remain available alongside custom imported .glb definitions
      const mergedMap = new Map<UUID, ComponentDefinition>();
      for (const builtin of BUILTIN_COMPONENT_CATALOG) {
        mergedMap.set(builtin.id, structuredClone(builtin));
      }
      for (const comp of parsed.componentLibrary) {
        mergedMap.set(comp.id, comp);
      }
      const mergedLibrary = Array.from(mergedMap.values());
      const snapConnections = recomputeSceneSnapConnections(
        parsed.instances,
        mergedMap
      );

      runtimeBusClient.sendControl('STOPPED', parsed.environment.simSpeedMultiplier ?? 1.0);
      runtimeBusClient.syncTagMap(parsed.plcTagMap);

      set({
        scene: {
          ...parsed,
          componentLibrary: mergedLibrary,
          snapConnections,
        },
        selectedInstanceId: parsed.instances[0]?.id ?? null,
        activeSnapPreview: null,
        runState: 'STOPPED',
        isDirty: false,
        statusMessage: `Loaded "${parsed.metadata.name}" from ${sourceLabel} (${parsed.instances.length} machines, ${snapConnections.length} snapped links).`,
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
    const safeFileSlug = updatedScene.metadata.name
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

    // Browser Live Preview download fallback
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

    // Browser Live Preview file input fallback
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
    const baseSlug = component.name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
    const instanceName = `${baseSlug}_${String(countOfType).padStart(2, '0')}`;
    const newId = `inst-${crypto.randomUUID().slice(0, 8)}`;

    // Default spawn position staggered near center if clicked instead of dragged
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

    set({
      isDirty: true,
      selectedInstanceId: newId,
      scene: {
        ...state.scene,
        instances: nextInstances,
        snapConnections: nextConnections,
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
      const msg = err instanceof Error ? err.message : 'Unsupported GLB/GLTF binary';
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
      input.accept = '.glb,.gltf,model/gltf-binary,model/gltf+json';
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
      const nextConnections = commitConnections
        ? recomputeSceneSnapConnections(
            nextInstances,
            getCatalogMap(state.scene.componentLibrary)
          )
        : state.scene.snapConnections;

      return {
        isDirty: true,
        scene: {
          ...state.scene,
          instances: nextInstances,
          snapConnections: nextConnections,
        },
      };
    }),

  renameInstance: (instanceId, name) =>
    set((state) => ({
      isDirty: true,
      scene: {
        ...state.scene,
        instances: state.scene.instances.map((inst) =>
          inst.id === instanceId ? { ...inst, name } : inst
        ),
      },
    })),

  toggleInstanceVisibility: (instanceId) =>
    set((state) => {
      const nextInstances = state.scene.instances.map((inst) =>
        inst.id === instanceId ? { ...inst, visible: !inst.visible } : inst
      );
      return {
        isDirty: true,
        scene: {
          ...state.scene,
          instances: nextInstances,
          snapConnections: recomputeSceneSnapConnections(
            nextInstances,
            getCatalogMap(state.scene.componentLibrary)
          ),
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
    const nextConnections = recomputeSceneSnapConnections(
      nextInstances,
      getCatalogMap(state.scene.componentLibrary)
    );

    set({
      isDirty: true,
      selectedInstanceId: dupId,
      scene: {
        ...state.scene,
        instances: nextInstances,
        snapConnections: nextConnections,
      },
      statusMessage: `Duplicated "${target.name}" -> "${duplicated.name}"`,
    });
  },

  deleteInstance: (instanceId) =>
    set((state) => {
      const removed = state.scene.instances.find((i) => i.id === instanceId);
      const nextInstances = state.scene.instances.filter((i) => i.id !== instanceId);
      const nextConnections = recomputeSceneSnapConnections(
        nextInstances,
        getCatalogMap(state.scene.componentLibrary)
      );
      return {
        isDirty: true,
        selectedInstanceId:
          state.selectedInstanceId === instanceId ? null : state.selectedInstanceId,
        activeSnapPreview: null,
        scene: {
          ...state.scene,
          instances: nextInstances,
          snapConnections: nextConnections,
        },
        statusMessage: removed ? `Deleted "${removed.name}"` : state.statusMessage,
      };
    }),

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

      return {
        isDirty: true,
        scene: {
          ...state.scene,
          componentLibrary: nextLib,
          snapConnections: recomputeSceneSnapConnections(
            state.scene.instances,
            getCatalogMap(nextLib)
          ),
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

      return {
        isDirty: true,
        scene: {
          ...state.scene,
          componentLibrary: nextLib,
          snapConnections: recomputeSceneSnapConnections(
            state.scene.instances,
            getCatalogMap(nextLib)
          ),
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

      return {
        isDirty: true,
        scene: {
          ...state.scene,
          componentLibrary: nextLib,
          snapConnections: recomputeSceneSnapConnections(
            state.scene.instances,
            getCatalogMap(nextLib)
          ),
        },
      };
    }),
}));
