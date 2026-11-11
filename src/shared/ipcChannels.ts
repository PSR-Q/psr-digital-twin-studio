import type {
  PlcConnectionAction,
  PlcTagMap,
  PlcWorkerDiagnostics,
  SimulationRunState,
} from './schemas';

/**
 * Typed Electron IPC Channels connecting Renderer <-> Main <-> UtilityProcess Worker
 */

export const IPC_CHANNELS = {
  DIALOG_OPEN_GLB: 'vc:dialog:open-glb',
  DIALOG_SAVE_SCENE: 'vc:dialog:save-scene',
  DIALOG_LOAD_SCENE: 'vc:dialog:load-scene',
  DIALOG_SAVE_VCOMP: 'vc:dialog:save-vcomp',
  PLC_BINARY_FRAME_TO_RENDERER: 'vc:plc:frame-to-renderer',
  PLC_BINARY_CMD_TO_WORKER: 'vc:plc:cmd-to-worker',
  PLC_CONTROL_STATE: 'vc:plc:control-state',
  PLC_CONFIGURE_TAG_MAP: 'vc:plc:configure-tag-map',
  PLC_CONNECTION_ACTION: 'vc:plc:connection-action',
  PLC_WORKER_STATUS_TO_RENDERER: 'vc:plc:worker-status',
  APP_GET_RUNTIME_INFO: 'vc:app:runtime-info',
} as const;

export interface OpenedGlbPayload {
  fileName: string;
  filePath: string;
  base64Data: string;
  byteLength: number;
}

export interface LoadedScenePayload {
  fileName: string;
  filePath: string;
  jsonContent: string;
}

export interface SavedFileResult {
  saved: boolean;
  filePath?: string;
}

export interface PlcControlCommand {
  runState: SimulationRunState;
  simSpeedMultiplier: number;
}

export interface RuntimeInfoPayload {
  isElectron: boolean;
  platform: string;
  electronVersion?: string;
  workerActive: boolean;
}

export interface ElectronBridgeApi {
  isElectron: true;
  openGlbDialog: () => Promise<OpenedGlbPayload | null>;
  saveSceneDialog: (
    jsonContent: string,
    suggestedName: string
  ) => Promise<SavedFileResult>;
  loadSceneDialog: () => Promise<LoadedScenePayload | null>;
  saveComponentDialog: (
    jsonContent: string,
    suggestedName: string
  ) => Promise<SavedFileResult>;
  sendPlcControl: (cmd: PlcControlCommand) => void;
  configurePlcTagMap: (tagMap: PlcTagMap) => void;
  sendPlcConnectionAction: (action: PlcConnectionAction) => void;
  pushBinaryCommandFrame: (frame: Uint8Array) => void;
  onPlcBinaryFrame: (listener: (frame: Uint8Array) => void) => () => void;
  onPlcWorkerStatus: (
    listener: (status: PlcWorkerDiagnostics) => void
  ) => () => void;
  getRuntimeInfo: () => Promise<RuntimeInfoPayload>;
}

declare global {
  interface Window {
    electronAPI?: ElectronBridgeApi;
  }
}
