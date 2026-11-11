import {
  Activity,
  Box,
  Download,
  FilePlus2,
  FolderOpen,
  Grid3x3,
  Magnet,
  Maximize2,
  Move,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Route,
  Save,
  Sparkles,
  Table2,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { runtimeBusClient } from '../../engine/runtimeBusClient';
import type { PlcAdapterType, PlcConnectionState } from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';

const SPEED_OPTIONS = [0.2, 0.5, 1.0, 2.0, 5.0];

const SHORT_ADAPTER_LABEL: Record<PlcAdapterType, string> = {
  InternalSimAdapter: 'InternalSim',
  SiemensS7Adapter: 'S7-PLCSIM',
  MitsubishiMcAdapter: 'MELSEC-3E',
  OpcUaAdapter: 'OPC-UA',
};

export function TopToolbar() {
  const sceneName = useEditorStore((s) => s.scene.metadata.name);
  const env = useEditorStore((s) => s.scene.environment);
  const gizmoMode = useEditorStore((s) => s.gizmoMode);
  const runState = useEditorStore((s) => s.runState);
  const inspectorTab = useEditorStore((s) => s.inspectorTab);
  const activeAdapter = useEditorStore((s) => s.scene.plcTagMap.activeAdapter);
  const isTagMatrixModalOpen = useEditorStore((s) => s.isTagMatrixModalOpen);
  const forcedCount = useEditorStore(
    (s) => s.scene.plcTagMap.bindings.filter((b) => b.manualForceEnabled).length
  );
  const isDirty = useEditorStore((s) => s.isDirty);

  const renameScene = useEditorStore((s) => s.renameScene);
  const newEmptyScene = useEditorStore((s) => s.newEmptyScene);
  const loadStarterDemoScene = useEditorStore((s) => s.loadStarterDemoScene);
  const importGlbInteractive = useEditorStore((s) => s.importGlbInteractive);
  const openSceneInteractive = useEditorStore((s) => s.openSceneInteractive);
  const saveSceneInteractive = useEditorStore((s) => s.saveSceneInteractive);
  const setGizmoMode = useEditorStore((s) => s.setGizmoMode);
  const setInspectorTab = useEditorStore((s) => s.setInspectorTab);
  const setTagMatrixModalOpen = useEditorStore((s) => s.setTagMatrixModalOpen);
  const updateEnvironment = useEditorStore((s) => s.updateEnvironment);
  const setRunState = useEditorStore((s) => s.setRunState);
  const setSimSpeedMultiplier = useEditorStore((s) => s.setSimSpeedMultiplier);

  const [scanMs, setScanMs] = useState<number>(10.0);
  const [connState, setConnState] = useState<PlcConnectionState>('CONNECTED');

  // Lightweight 4Hz telemetry readout for toolbar badge (never re-renders 3D scene!)
  useEffect(() => {
    const timer = window.setInterval(() => {
      const t = runtimeBusClient.readTelemetryFast();
      const diag = runtimeBusClient.getDiagnostics();
      if (t.scanCycleMs > 0) {
        setScanMs(t.scanCycleMs);
      } else if (diag.actualScanCycleMs > 0) {
        setScanMs(diag.actualScanCycleMs);
      }
      setConnState(diag.connectionState);
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  const ledClass =
    connState === 'CONNECTED'
      ? 'vc-led-ok'
      : connState === 'CONNECTING'
        ? 'vc-led-warn'
        : connState === 'FAULT'
          ? 'vc-led-err'
          : 'vc-led-off';

  return (
    <header id="vc-top-toolbar" className="vc-toolbar">
      {/* Brand & Scene Name */}
      <div className="vc-toolbar-section">
        <div className="vc-brand-mark" title="Standalone 3D Industrial Virtual Commissioning">
          <Box size={16} />
          <span className="vc-brand-title">VC TWIN</span>
          <span className="vc-milestone-tag">M4</span>
        </div>

        <div className="vc-scene-title-wrap">
          <input
            id="vc-scene-name-input"
            type="text"
            value={sceneName}
            onChange={(e) => renameScene(e.target.value)}
            className="vc-scene-name-input"
            aria-label="Factory Scene Name"
          />
          {isDirty && <span className="vc-dirty-dot" title="Unsaved scene changes" />}
        </div>
      </div>

      {/* File & Asset Pipeline Controls */}
      <div className="vc-toolbar-section vc-toolbar-divider">
        <button
          id="btn-new-empty-scene"
          type="button"
          className="vc-tool-btn"
          onClick={newEmptyScene}
          title="New Empty Factory Floor"
        >
          <FilePlus2 size={14} />
          <span>New</span>
        </button>

        <button
          id="btn-load-demo-scene"
          type="button"
          className="vc-tool-btn"
          onClick={loadStarterDemoScene}
          title="Load Starter Demo Packaging Line"
        >
          <Sparkles size={14} />
          <span>Demo</span>
        </button>

        <button
          id="btn-import-glb"
          type="button"
          className="vc-tool-btn vc-tool-btn-accent"
          onClick={() => void importGlbInteractive()}
          title="Import 3D Model (.glb, .gltf, .usd, .usda, .usdc, .usdz)"
        >
          <Download size={14} />
          <span>Import 3D (.GLB / .USD)</span>
        </button>

        <button
          id="btn-load-scene-json"
          type="button"
          className="vc-tool-btn"
          onClick={() => void openSceneInteractive()}
          title="Load Factory Layout (.json)"
        >
          <FolderOpen size={14} />
          <span>Load JSON</span>
        </button>

        <button
          id="btn-save-scene-json"
          type="button"
          className="vc-tool-btn vc-tool-btn-primary"
          onClick={() => void saveSceneInteractive()}
          title="Save Factory Layout (.json) (Ctrl+S)"
        >
          <Save size={14} />
          <span>Save JSON</span>
        </button>
      </div>

      {/* Transform Gizmo & Magnetic SnapPort Controls */}
      <div className="vc-toolbar-section vc-toolbar-divider">
        <div className="vc-segmented-group" role="group" aria-label="Transform Gizmo Mode">
          <button
            id="btn-gizmo-translate"
            type="button"
            className={`vc-seg-btn ${gizmoMode === 'translate' ? 'active' : ''}`}
            onClick={() => setGizmoMode('translate')}
            title="Translate / Move Gizmo (W)"
          >
            <Move size={14} />
            <span>Move</span>
          </button>
          <button
            id="btn-gizmo-rotate"
            type="button"
            className={`vc-seg-btn ${gizmoMode === 'rotate' ? 'active' : ''}`}
            onClick={() => setGizmoMode('rotate')}
            title="Rotate Gizmo (E)"
          >
            <RotateCw size={14} />
            <span>Rotate</span>
          </button>
          <button
            id="btn-gizmo-scale"
            type="button"
            className={`vc-seg-btn ${gizmoMode === 'scale' ? 'active' : ''}`}
            onClick={() => setGizmoMode('scale')}
            title="Scale Gizmo (R)"
          >
            <Maximize2 size={14} />
            <span>Scale</span>
          </button>
        </div>

        <button
          id="btn-toggle-magnetic-snap"
          type="button"
          className={`vc-tool-btn ${env.snapEnabled ? 'vc-tool-btn-snap-on' : ''}`}
          onClick={() => updateEnvironment({ snapEnabled: !env.snapEnabled })}
          title="Toggle Magnetic Port-to-Port Snapping"
        >
          <Magnet size={14} />
          <span>Snap {env.snapEnabled ? 'ON' : 'OFF'}</span>
        </button>

        <div className="vc-snap-radius-box" title="Magnetic Snap Capture Radius (meters)">
          <span className="vc-micro-label">R:</span>
          <input
            id="input-snap-radius"
            type="number"
            min={0.1}
            max={1.5}
            step={0.05}
            value={env.snapRadiusMeters}
            onChange={(e) =>
              updateEnvironment({
                snapRadiusMeters: Math.max(0.05, Math.min(2.0, Number(e.target.value) || 0.45)),
              })
            }
            className="vc-compact-num"
          />
          <span className="vc-micro-unit">m</span>
        </div>

        <button
          id="btn-toggle-transport-paths"
          type="button"
          className={`vc-icon-toggle ${env.showTransportPaths !== false ? 'active' : ''}`}
          onClick={() =>
            updateEnvironment({
              showTransportPaths: !(env.showTransportPaths !== false),
            })
          }
          title="Toggle 3D Conveyor Spline Paths & Laser Beams"
        >
          <Route size={14} />
        </button>

        <button
          id="btn-toggle-grid"
          type="button"
          className={`vc-icon-toggle ${env.showGrid ? 'active' : ''}`}
          onClick={() => updateEnvironment({ showGrid: !env.showGrid })}
          title="Toggle Metric Floor Grid"
        >
          <Grid3x3 size={14} />
        </button>
      </div>

      {/* Simulation Playback, Tag Matrix & PLC Scan Telemetry */}
      <div className="vc-toolbar-section vc-toolbar-right">
        <div className="vc-segmented-group" role="group" aria-label="Simulation Controls">
          <button
            id="btn-sim-play"
            type="button"
            className={`vc-seg-btn ${runState === 'RUNNING' ? 'vc-sim-running' : ''}`}
            onClick={() => setRunState('RUNNING')}
            title="Run Virtual Commissioning Loop"
          >
            <Play size={13} />
          </button>
          <button
            id="btn-sim-pause"
            type="button"
            className={`vc-seg-btn ${runState === 'PAUSED' ? 'active' : ''}`}
            onClick={() => setRunState('PAUSED')}
            title="Pause Simulation"
          >
            <Pause size={13} />
          </button>
          <button
            id="btn-sim-reset"
            type="button"
            className="vc-seg-btn"
            onClick={() => setRunState('STOPPED')}
            title="Stop & Reset Simulation"
          >
            <RotateCcw size={13} />
          </button>
        </div>

        <select
          id="select-sim-speed"
          value={env.simSpeedMultiplier}
          onChange={(e) => setSimSpeedMultiplier(Number(e.target.value))}
          className="vc-speed-select"
          aria-label="Simulation Speed Multiplier"
        >
          {SPEED_OPTIONS.map((sp) => (
            <option key={sp} value={sp}>
              {sp.toFixed(1)}x
            </option>
          ))}
        </select>

        <button
          id="btn-toolbar-force-io"
          type="button"
          className={`vc-tool-btn ${
            inspectorTab === 'signals' || forcedCount > 0
              ? 'vc-tool-btn-accent'
              : ''
          }`}
          onClick={() =>
            setInspectorTab(inspectorTab === 'signals' ? 'transform' : 'signals')
          }
          title="Open Signal Force Console (Manual Actuator & Sensor Testing)"
        >
          <Zap size={13} />
          <span>Force{forcedCount > 0 ? ` (${forcedCount})` : ''}</span>
        </button>

        <button
          id="plc-telemetry-badge"
          type="button"
          className={`vc-plc-badge vc-plc-badge-btn ${
            isTagMatrixModalOpen ? 'active' : ''
          }`}
          onClick={() => setTagMatrixModalOpen(!isTagMatrixModalOpen)}
          title="Open Full I/O Tag Binding Matrix & Live PLC Driver Monitor"
        >
          <span className={`vc-led-dot ${ledClass}`} />
          <Activity size={13} className="vc-plc-icon" />
          <span className="vc-mono-text">
            {SHORT_ADAPTER_LABEL[activeAdapter]} · {scanMs.toFixed(1)}ms
          </span>
          <Table2 size={12} />
        </button>
      </div>
    </header>
  );
}
