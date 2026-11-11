import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  IPC_CHANNELS,
  type LoadedScenePayload,
  type OpenedGlbPayload,
  type PlcControlCommand,
  type RuntimeInfoPayload,
  type SavedFileResult,
} from '../src/shared/ipcChannels';
import type { PlcTagMap } from '../src/shared/schemas';

let mainWindow: BrowserWindow | null = null;
let plcWorker: UtilityProcess | null = null;

function spawnPlcUtilityWorker(): void {
  const workerScript = path.join(__dirname, 'worker', 'plcSyncWorker.cjs');
  try {
    plcWorker = utilityProcess.fork(workerScript, [], {
      serviceName: 'VC-PLC-CyclicSync-Worker',
    });

    plcWorker.on('message', (msg: { type?: string; frame?: Uint8Array }) => {
      if (
        msg?.type === 'plc-binary-frame' &&
        msg.frame &&
        mainWindow &&
        !mainWindow.isDestroyed()
      ) {
        // Throttle UI telemetry push to ~30Hz while internal PLC loop runs at 100-200Hz
        mainWindow.webContents.send(
          IPC_CHANNELS.PLC_BINARY_FRAME_TO_RENDERER,
          msg.frame
        );
      }
    });

    plcWorker.on('exit', () => {
      plcWorker = null;
    });
  } catch (err) {
    console.error('[Main] Failed to spawn UtilityProcess worker:', err);
  }
}

async function createMainWindow(): Promise<void> {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1640,
    height: 960,
    minWidth: 1200,
    minHeight: 740,
    backgroundColor: '#0c0f14',
    title: 'VC Digital Twin Studio — Standalone 3D Industrial Virtual Commissioning',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.APP_GET_RUNTIME_INFO,
    (): RuntimeInfoPayload => ({
      isElectron: true,
      platform: process.platform,
      electronVersion: process.versions.electron,
      workerActive: plcWorker !== null,
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_OPEN_GLB,
    async (): Promise<OpenedGlbPayload | null> => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Import 3D Machine Model (glTF .glb/.gltf or OpenUSD .usd/.usda/.usdc/.usdz)',
        filters: [
          {
            name: '3D Industrial Models (glTF & OpenUSD)',
            extensions: ['glb', 'gltf', 'usd', 'usda', 'usdc', 'usdz'],
          },
          {
            name: 'OpenUSD Stage / Package (.usd, .usda, .usdc, .usdz)',
            extensions: ['usd', 'usda', 'usdc', 'usdz'],
          },
          {
            name: 'glTF 2.0 Models (.glb, .gltf)',
            extensions: ['glb', 'gltf'],
          },
        ],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;

      const filePath = result.filePaths[0];
      const buffer = await fs.readFile(filePath);
      return {
        fileName: path.basename(filePath),
        filePath,
        base64Data: buffer.toString('base64'),
        byteLength: buffer.byteLength,
      };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SAVE_SCENE,
    async (
      _event,
      jsonContent: string,
      suggestedName: string
    ): Promise<SavedFileResult> => {
      if (!mainWindow) return { saved: false };
      const cleanDefault = suggestedName.endsWith('.json')
        ? suggestedName
        : `${suggestedName}.vcscene.json`;
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Factory Digital Twin Layout (.json)',
        defaultPath: cleanDefault,
        filters: [
          { name: 'VC Factory Scene JSON', extensions: ['json'] },
        ],
      });
      if (result.canceled || !result.filePath) return { saved: false };

      await fs.writeFile(result.filePath, jsonContent, 'utf-8');
      return { saved: true, filePath: result.filePath };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_LOAD_SCENE,
    async (): Promise<LoadedScenePayload | null> => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Load Factory Digital Twin Layout (.json)',
        filters: [{ name: 'VC Factory Scene JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;

      const filePath = result.filePaths[0];
      const jsonContent = await fs.readFile(filePath, 'utf-8');
      return {
        fileName: path.basename(filePath),
        filePath,
        jsonContent,
      };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SAVE_VCOMP,
    async (
      _event,
      jsonContent: string,
      suggestedName: string
    ): Promise<SavedFileResult> => {
      if (!mainWindow) return { saved: false };
      const cleanDefault = suggestedName.endsWith('.vcomp.json')
        ? suggestedName
        : `${suggestedName}.vcomp.json`;
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Reusable Component Definition (.vcomp.json)',
        defaultPath: cleanDefault,
        filters: [{ name: 'VC Component Definition', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { saved: false };

      await fs.writeFile(result.filePath, jsonContent, 'utf-8');
      return { saved: true, filePath: result.filePath };
    }
  );

  ipcMain.on(IPC_CHANNELS.PLC_CONTROL_STATE, (_event, cmd: PlcControlCommand) => {
    plcWorker?.postMessage({
      type: 'control',
      runState: cmd.runState,
      simSpeedMultiplier: cmd.simSpeedMultiplier,
    });
  });

  ipcMain.on(IPC_CHANNELS.PLC_CONFIGURE_TAG_MAP, (_event, tagMap: PlcTagMap) => {
    plcWorker?.postMessage({
      type: 'configure-tags',
      tagMap,
    });
  });

  ipcMain.on(IPC_CHANNELS.PLC_BINARY_CMD_TO_WORKER, (_event, frame: Uint8Array) => {
    plcWorker?.postMessage({
      type: 'cmd-frame',
      frame,
    });
  });
}

void app.whenReady().then(async () => {
  registerIpcHandlers();
  spawnPlcUtilityWorker();
  await createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (plcWorker) {
    plcWorker.kill();
    plcWorker = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
