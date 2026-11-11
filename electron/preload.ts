import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  type ElectronBridgeApi,
  type LoadedScenePayload,
  type OpenedGlbPayload,
  type PlcControlCommand,
  type RuntimeInfoPayload,
  type SavedFileResult,
} from '../src/shared/ipcChannels';
import type {
  PlcConnectionAction,
  PlcTagMap,
  PlcWorkerDiagnostics,
} from '../src/shared/schemas';

const api: ElectronBridgeApi = {
  isElectron: true,

  openGlbDialog: (): Promise<OpenedGlbPayload | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_GLB),

  saveSceneDialog: (
    jsonContent: string,
    suggestedName: string
  ): Promise<SavedFileResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SAVE_SCENE, jsonContent, suggestedName),

  loadSceneDialog: (): Promise<LoadedScenePayload | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_LOAD_SCENE),

  saveComponentDialog: (
    jsonContent: string,
    suggestedName: string
  ): Promise<SavedFileResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SAVE_VCOMP, jsonContent, suggestedName),

  sendPlcControl: (cmd: PlcControlCommand): void => {
    ipcRenderer.send(IPC_CHANNELS.PLC_CONTROL_STATE, cmd);
  },

  configurePlcTagMap: (tagMap: PlcTagMap): void => {
    ipcRenderer.send(IPC_CHANNELS.PLC_CONFIGURE_TAG_MAP, tagMap);
  },

  sendPlcConnectionAction: (action: PlcConnectionAction): void => {
    ipcRenderer.send(IPC_CHANNELS.PLC_CONNECTION_ACTION, action);
  },

  pushBinaryCommandFrame: (frame: Uint8Array): void => {
    ipcRenderer.send(IPC_CHANNELS.PLC_BINARY_CMD_TO_WORKER, frame);
  },

  onPlcBinaryFrame: (listener: (frame: Uint8Array) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, frame: Uint8Array): void => {
      listener(frame);
    };
    ipcRenderer.on(IPC_CHANNELS.PLC_BINARY_FRAME_TO_RENDERER, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.PLC_BINARY_FRAME_TO_RENDERER, handler);
    };
  },

  onPlcWorkerStatus: (
    listener: (status: PlcWorkerDiagnostics) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      status: PlcWorkerDiagnostics
    ): void => {
      listener(status);
    };
    ipcRenderer.on(IPC_CHANNELS.PLC_WORKER_STATUS_TO_RENDERER, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.PLC_WORKER_STATUS_TO_RENDERER, handler);
    };
  },

  getRuntimeInfo: (): Promise<RuntimeInfoPayload> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_GET_RUNTIME_INFO),
};

contextBridge.exposeInMainWorld('electronAPI', api);
