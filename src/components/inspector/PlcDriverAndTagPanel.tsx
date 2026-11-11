import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  ExternalLink,
  Network,
  PlugZap,
  RefreshCw,
  Table2,
  Unplug,
  Upload,
  Wand2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  validatePlcAddress,
  type VendorAddressPreset,
} from '../../engine/plcAddressSyntax';
import { runtimeBusClient } from '../../engine/runtimeBusClient';
import {
  createDefaultPlcDiagnostics,
  type PlcAdapterType,
  type PlcTagBinding,
  type PlcWorkerDiagnostics,
} from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';

const ADAPTER_OPTIONS: Array<{
  value: PlcAdapterType;
  shortLabel: string;
  vendorSubtitle: string;
}> = [
  {
    value: 'InternalSimAdapter',
    shortLabel: 'InternalSim (Built-In Bus)',
    vendorSubtitle: 'Zero-latency 4KB local I/O bus + Manual Force testing',
  },
  {
    value: 'SiemensS7Adapter',
    shortLabel: 'Siemens S7 (PLCSIM Adv / S7-1500)',
    vendorSubtitle: 'RFC1006 ISO-on-TCP (Port 102) + S7Comm + SHM Hook',
  },
  {
    value: 'MitsubishiMcAdapter',
    shortLabel: 'Mitsubishi MC (GX Simulator3 / iQ-R)',
    vendorSubtitle: 'MELSEC QnA 3E Binary TCP (Batch Read 0401 / Write 1402)',
  },
  {
    value: 'OpcUaAdapter',
    shortLabel: 'OPC UA Binary (Sysmac / CODESYS)',
    vendorSubtitle: 'IEC 62541-6 opc.tcp Session + Multi-Node Read/Write',
  },
];

const SCAN_PERIOD_OPTIONS = [5, 10, 15, 20];

function formatLiveValCompact(
  binding: PlcTagBinding,
  rawVal: boolean | number | undefined
): string {
  if (binding.dataType === 'BOOL') {
    return rawVal ? 'TRUE' : 'FALSE';
  }
  const num = typeof rawVal === 'number' ? rawVal : 0;
  if (binding.dataType === 'INT16' || binding.dataType === 'DINT32') {
    return String(Math.round(num));
  }
  return num.toFixed(2);
}

export function PlcDriverAndTagPanel() {
  const plcTagMap = useEditorStore((s) => s.scene.plcTagMap);
  const selectedInstanceId = useEditorStore((s) => s.selectedInstanceId);
  const instances = useEditorStore((s) => s.scene.instances);

  const setPlcActiveAdapter = useEditorStore((s) => s.setPlcActiveAdapter);
  const setPlcScanCycleMs = useEditorStore((s) => s.setPlcScanCycleMs);
  const updateS7DriverConfig = useEditorStore((s) => s.updateS7DriverConfig);
  const updateMcDriverConfig = useEditorStore((s) => s.updateMcDriverConfig);
  const updateOpcUaDriverConfig = useEditorStore(
    (s) => s.updateOpcUaDriverConfig
  );
  const updatePlcTagBinding = useEditorStore((s) => s.updatePlcTagBinding);
  const applyPlcAddressPreset = useEditorStore((s) => s.applyPlcAddressPreset);
  const triggerPlcConnectionAction = useEditorStore(
    (s) => s.triggerPlcConnectionAction
  );
  const exportPlcTagCsvInteractive = useEditorStore(
    (s) => s.exportPlcTagCsvInteractive
  );
  const importPlcTagCsvText = useEditorStore((s) => s.importPlcTagCsvText);
  const setTagMatrixModalOpen = useEditorStore((s) => s.setTagMatrixModalOpen);

  const csvInputRef = useRef<HTMLInputElement | null>(null);
  const [scopeMode, setScopeMode] = useState<'selected' | 'all'>('selected');
  const [diagnostics, setDiagnostics] = useState<PlcWorkerDiagnostics>(() =>
    createDefaultPlcDiagnostics()
  );
  const [liveValues, setLiveValues] = useState<Record<string, boolean | number>>(
    {}
  );

  // 8Hz live diagnostics & value polling for Right Dock PLC Console
  useEffect(() => {
    const refresh = () => {
      setDiagnostics(runtimeBusClient.getDiagnostics());
      const bindings = useEditorStore.getState().scene.plcTagMap.bindings;
      const snap: Record<string, boolean | number> = {};
      for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i];
        snap[b.id] = runtimeBusClient.readBindingLiveValue(b);
      }
      setLiveValues(snap);
    };
    refresh();
    const timer = window.setInterval(refresh, 125);
    return () => window.clearInterval(timer);
  }, []);

  const selectedInstance = useMemo(
    () => instances.find((i) => i.id === selectedInstanceId) ?? null,
    [instances, selectedInstanceId]
  );

  const visibleBindings = useMemo(() => {
    if (scopeMode === 'selected' && selectedInstance) {
      return plcTagMap.bindings.filter(
        (b) => b.instanceId === selectedInstance.id
      );
    }
    return plcTagMap.bindings;
  }, [plcTagMap.bindings, scopeMode, selectedInstance]);

  const validationStats = useMemo(() => {
    let valid = 0;
    for (const b of plcTagMap.bindings) {
      if (
        validatePlcAddress(
          plcTagMap.activeAdapter,
          b.plcAddress,
          b.dataType,
          plcTagMap.opcUaConfig.namespaceIndex
        ).valid
      ) {
        valid++;
      }
    }
    return {
      valid,
      total: plcTagMap.bindings.length,
      invalid: plcTagMap.bindings.length - valid,
    };
  }, [
    plcTagMap.activeAdapter,
    plcTagMap.bindings,
    plcTagMap.opcUaConfig.namespaceIndex,
  ]);

  const activeAdapterMeta =
    ADAPTER_OPTIONS.find((a) => a.value === plcTagMap.activeAdapter) ??
    ADAPTER_OPTIONS[0];

  const handleCsvFileSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    importPlcTagCsvText(text, file.name);
  };

  const connState = diagnostics.connectionState;
  const connBadgeClass =
    connState === 'CONNECTED'
      ? 'connected'
      : connState === 'CONNECTING'
        ? 'connecting'
        : connState === 'FAULT'
          ? 'fault'
          : 'disconnected';

  return (
    <div className="vc-plc-panel-stack">
      {/* 1. Active PLC Driver & UtilityProcess Scan Engine */}
      <div className="vc-inspector-card">
        <div className="vc-section-header-row">
          <span className="vc-section-label">
            <Cpu size={12} className="vc-cyan-text" />
            <span>PLC ENGINE & CYCLIC WORKER</span>
          </span>
          <span className={`vc-plc-conn-pill ${connBadgeClass}`}>
            <span className="vc-plc-conn-dot" />
            {connState}
          </span>
        </div>

        <div className="vc-joint-form">
          <label className="vc-field-label" htmlFor="select-plc-driver">
            ACTIVE PROTOCOL ADAPTER
          </label>
          <select
            id="select-plc-driver"
            value={plcTagMap.activeAdapter}
            onChange={(e) =>
              setPlcActiveAdapter(e.target.value as PlcAdapterType, true)
            }
            className="vc-text-input vc-mono-text"
          >
            {ADAPTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.shortLabel}
              </option>
            ))}
          </select>
          <div className="vc-micro-hint">{activeAdapterMeta.vendorSubtitle}</div>

          <div className="vc-field-row">
            <span>Target Scan Cycle</span>
            <div className="vc-segmented-group">
              {SCAN_PERIOD_OPTIONS.map((ms) => (
                <button
                  key={ms}
                  id={`btn-plc-scan-${ms}ms`}
                  type="button"
                  className={`vc-seg-btn ${
                    plcTagMap.scanCycleMs === ms ? 'active' : ''
                  }`}
                  onClick={() => setPlcScanCycleMs(ms)}
                  title={`${Math.round(1000 / ms)} Hz deterministic scan period`}
                >
                  {ms}ms
                </button>
              ))}
            </div>
          </div>

          {/* Live Worker Telemetry Strip */}
          <div className="vc-plc-telemetry-grid">
            <div className="vc-plc-stat-cell">
              <span className="vc-plc-stat-label">Actual Cycle</span>
              <strong className="vc-mono-text vc-cyan-text">
                {diagnostics.actualScanCycleMs.toFixed(1)} ms
              </strong>
            </div>
            <div className="vc-plc-stat-cell">
              <span className="vc-plc-stat-label">Cyclic Rx / Tx</span>
              <strong className="vc-mono-text vc-emerald-text">
                {diagnostics.cyclicReadCount} / {diagnostics.cyclicWriteCount}
              </strong>
            </div>
            <div className="vc-plc-stat-cell">
              <span className="vc-plc-stat-label">Errors</span>
              <strong
                className={`vc-mono-text ${
                  diagnostics.errorCount > 0 ? 'vc-danger-text' : ''
                }`}
              >
                {diagnostics.errorCount}
              </strong>
            </div>
          </div>

          {/* Connection Control Buttons */}
          <div className="vc-two-col-grid">
            <button
              id="btn-plc-connect"
              type="button"
              className="vc-action-btn vc-action-btn-emerald"
              onClick={() =>
                triggerPlcConnectionAction(
                  connState === 'CONNECTED' ? 'reconnect' : 'connect'
                )
              }
            >
              {connState === 'CONNECTED' ? (
                <>
                  <RefreshCw size={12} />
                  <span>Reconnect</span>
                </>
              ) : (
                <>
                  <PlugZap size={12} />
                  <span>Connect PLC</span>
                </>
              )}
            </button>

            <button
              id="btn-plc-disconnect"
              type="button"
              className="vc-action-btn"
              onClick={() => triggerPlcConnectionAction('disconnect')}
            >
              <Unplug size={12} />
              <span>Disconnect</span>
            </button>
          </div>

          {diagnostics.isBrowserFallback && (
            <div className="vc-plc-alert vc-plc-alert-warn">
              <AlertTriangle size={13} />
              <div>
                <strong>Web Preview Sandbox Mode:</strong> Raw TCP sockets (ports{' '}
                <code>102</code> / <code>5002</code> / <code>4840</code>) require
                the standalone <strong>Windows .exe</strong>. Tag mapping, CSV
                export, and local 3D Force simulation remain 100% active here.
              </div>
            </div>
          )}

          {!diagnostics.isBrowserFallback && diagnostics.lastError && (
            <div className="vc-plc-alert vc-plc-alert-error">
              <AlertTriangle size={13} />
              <div>
                <strong>Driver Diagnostic:</strong> {diagnostics.lastError}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 2. Protocol-Specific Connection Settings */}
      <div className="vc-inspector-card">
        <div className="vc-section-label">
          <Network size={12} className="vc-amber-text" />
          <span>
            {plcTagMap.activeAdapter === 'SiemensS7Adapter'
              ? 'SIEMENS S7 / PLCSIM ADV ENDPOINT'
              : plcTagMap.activeAdapter === 'MitsubishiMcAdapter'
                ? 'MITSUBISHI 3E BINARY MC ENDPOINT'
                : plcTagMap.activeAdapter === 'OpcUaAdapter'
                  ? 'OPC UA BINARY TCP ENDPOINT'
                  : 'INTERNAL MEMORY BUS LAYOUT'}
          </span>
        </div>

        {plcTagMap.activeAdapter === 'SiemensS7Adapter' && (
          <div className="vc-joint-form">
            <div className="vc-two-col-grid">
              <label className="vc-stack-field">
                <span>PLC IP Address</span>
                <input
                  id="input-s7-host"
                  type="text"
                  value={plcTagMap.s7Config.host}
                  onChange={(e) =>
                    updateS7DriverConfig({ host: e.target.value.trim() })
                  }
                  placeholder="192.168.0.1"
                  className="vc-text-input vc-mono-text"
                />
              </label>
              <label className="vc-stack-field">
                <span>ISO-on-TCP Port</span>
                <input
                  id="input-s7-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={plcTagMap.s7Config.port}
                  onChange={(e) =>
                    updateS7DriverConfig({
                      port: Math.max(1, Number(e.target.value) || 102),
                    })
                  }
                  className="vc-text-input vc-mono-text"
                />
              </label>
            </div>

            <div className="vc-two-col-grid">
              <label className="vc-stack-field">
                <span>CPU Rack</span>
                <input
                  id="input-s7-rack"
                  type="number"
                  min={0}
                  max={7}
                  value={plcTagMap.s7Config.rack}
                  onChange={(e) =>
                    updateS7DriverConfig({
                      rack: Math.max(0, Math.min(7, Number(e.target.value) || 0)),
                    })
                  }
                  className="vc-text-input vc-mono-text"
                />
              </label>
              <label className="vc-stack-field">
                <span>CPU Slot (S7-1500 = 1)</span>
                <input
                  id="input-s7-slot"
                  type="number"
                  min={0}
                  max={31}
                  value={plcTagMap.s7Config.slot}
                  onChange={(e) =>
                    updateS7DriverConfig({
                      slot: Math.max(0, Math.min(31, Number(e.target.value) || 1)),
                    })
                  }
                  className="vc-text-input vc-mono-text"
                />
              </label>
            </div>

            <label className="vc-toggle-row" htmlFor="chk-s7-shm-hook">
              <span>PLCSIM Adv Native Shared Memory Hook</span>
              <input
                id="chk-s7-shm-hook"
                type="checkbox"
                checked={plcTagMap.s7Config.enablePlcsimAdvSharedMemoryHook}
                onChange={(e) =>
                  updateS7DriverConfig({
                    enablePlcsimAdvSharedMemoryHook: e.target.checked,
                  })
                }
              />
            </label>

            {plcTagMap.s7Config.enablePlcsimAdvSharedMemoryHook && (
              <div className="vc-plc-shm-box">
                <label className="vc-stack-field">
                  <span>PLCSIM Adv Virtual Instance Name</span>
                  <input
                    id="input-s7-shm-instance"
                    type="text"
                    value={plcTagMap.s7Config.plcsimAdvInstanceName}
                    onChange={(e) =>
                      updateS7DriverConfig({
                        plcsimAdvInstanceName: e.target.value,
                      })
                    }
                    className="vc-text-input vc-mono-text"
                  />
                </label>
                <div className="vc-micro-hint vc-wrap-hint">
                  Hook Status: <code>{diagnostics.sharedMemoryHookStatus}</code>
                </div>
              </div>
            )}

            <div className="vc-subtle-note">
              Supports <code>I</code>, <code>Q</code>, <code>M</code>, and{' '}
              <code>DBn</code> (ensure <em>Permit PUT/GET communication</em> &
              non-optimized DB access on S7-1200/1500 or Virtual Ethernet Adapter
              on PLCSIM Advanced).
            </div>
          </div>
        )}

        {plcTagMap.activeAdapter === 'MitsubishiMcAdapter' && (
          <div className="vc-joint-form">
            <div className="vc-two-col-grid">
              <label className="vc-stack-field">
                <span>GX Sim3 / PLC Host</span>
                <input
                  id="input-mc-host"
                  type="text"
                  value={plcTagMap.mcConfig.host}
                  onChange={(e) =>
                    updateMcDriverConfig({ host: e.target.value.trim() })
                  }
                  placeholder="127.0.0.1"
                  className="vc-text-input vc-mono-text"
                />
              </label>
              <label className="vc-stack-field">
                <span>MC TCP Port</span>
                <input
                  id="input-mc-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={plcTagMap.mcConfig.port}
                  onChange={(e) =>
                    updateMcDriverConfig({
                      port: Math.max(1, Number(e.target.value) || 5002),
                    })
                  }
                  className="vc-text-input vc-mono-text"
                />
              </label>
            </div>

            <div className="vc-two-col-grid">
              <label className="vc-stack-field">
                <span>Network No</span>
                <input
                  id="input-mc-net"
                  type="number"
                  min={0}
                  max={255}
                  value={plcTagMap.mcConfig.networkNo}
                  onChange={(e) =>
                    updateMcDriverConfig({
                      networkNo: Math.max(
                        0,
                        Math.min(255, Number(e.target.value) || 0)
                      ),
                    })
                  }
                  className="vc-text-input vc-mono-text"
                />
              </label>
              <label className="vc-stack-field">
                <span>PC No (255 = 0xFF)</span>
                <input
                  id="input-mc-pc"
                  type="number"
                  min={0}
                  max={255}
                  value={plcTagMap.mcConfig.pcNo}
                  onChange={(e) =>
                    updateMcDriverConfig({
                      pcNo: Math.max(
                        0,
                        Math.min(255, Number(e.target.value) || 255)
                      ),
                    })
                  }
                  className="vc-text-input vc-mono-text"
                />
              </label>
            </div>

            <div className="vc-two-col-grid">
              <label className="vc-stack-field">
                <span>Unit I/O (1023 = 03FF)</span>
                <input
                  id="input-mc-unitio"
                  type="number"
                  min={0}
                  max={65535}
                  value={plcTagMap.mcConfig.unitIoNo}
                  onChange={(e) =>
                    updateMcDriverConfig({
                      unitIoNo: Math.max(
                        0,
                        Math.min(65535, Number(e.target.value) || 1023)
                      ),
                    })
                  }
                  className="vc-text-input vc-mono-text"
                />
              </label>
              <label className="vc-stack-field">
                <span>Station No</span>
                <input
                  id="input-mc-station"
                  type="number"
                  min={0}
                  max={255}
                  value={plcTagMap.mcConfig.unitStationNo}
                  onChange={(e) =>
                    updateMcDriverConfig({
                      unitStationNo: Math.max(
                        0,
                        Math.min(255, Number(e.target.value) || 0)
                      ),
                    })
                  }
                  className="vc-text-input vc-mono-text"
                />
              </label>
            </div>

            <div className="vc-subtle-note">
              QnA <strong>3E Binary</strong> (<code>50 00</code>): coalesced
              Batch Read (<code>0401</code>) & Random Write (<code>1402</code>)
              for <code>X</code>, <code>Y</code>, <code>M</code>, <code>L</code>
              , <code>B</code>, <code>D</code>, <code>W</code>, <code>R</code>.
            </div>
          </div>
        )}

        {plcTagMap.activeAdapter === 'OpcUaAdapter' && (
          <div className="vc-joint-form">
            <label className="vc-stack-field">
              <span>OPC UA Server Endpoint URL</span>
              <input
                id="input-opc-endpoint"
                type="text"
                value={plcTagMap.opcUaConfig.endpointUrl}
                onChange={(e) =>
                  updateOpcUaDriverConfig({ endpointUrl: e.target.value.trim() })
                }
                placeholder="opc.tcp://127.0.0.1:4840"
                className="vc-text-input vc-mono-text"
              />
            </label>

            <div className="vc-two-col-grid">
              <label className="vc-stack-field">
                <span>Security Mode</span>
                <select
                  id="select-opc-sec-mode"
                  value={plcTagMap.opcUaConfig.securityMode}
                  onChange={(e) =>
                    updateOpcUaDriverConfig({
                      securityMode: e.target
                        .value as typeof plcTagMap.opcUaConfig.securityMode,
                    })
                  }
                  className="vc-text-input vc-mono-text"
                >
                  <option value="None">None (Anonymous Sim)</option>
                  <option value="Sign">Sign</option>
                  <option value="SignAndEncrypt">SignAndEncrypt</option>
                </select>
              </label>

              <label className="vc-stack-field">
                <span>Default Namespace (ns)</span>
                <input
                  id="input-opc-ns"
                  type="number"
                  min={0}
                  max={65535}
                  value={plcTagMap.opcUaConfig.namespaceIndex}
                  onChange={(e) =>
                    updateOpcUaDriverConfig({
                      namespaceIndex: Math.max(
                        0,
                        Math.min(65535, Number(e.target.value) || 2)
                      ),
                    })
                  }
                  className="vc-text-input vc-mono-text"
                />
              </label>
            </div>

            <div className="vc-subtle-note">
              Connects to Omron Sysmac Studio OPC UA, CODESYS Control Win,
              Beckhoff TwinCAT, or S7-1500 OPC UA Server via{' '}
              <code>ns=2;s=Tag</code> or <code>ns=2;i=1001</code>.
            </div>
          </div>
        )}

        {plcTagMap.activeAdapter === 'InternalSimAdapter' && (
          <div className="vc-subtle-note" style={{ marginTop: 6 }}>
            Deterministic zero-allocation 4,096-byte{' '}
            <code>BinaryIpcBufferView</code> active: 512 <code>BOOL</code> coils,
            256 <code>INT16</code> words, 256 <code>DINT32</code> HSC registers,
            and 496 <code>FLOAT32</code> servo registers.
          </div>
        )}
      </div>

      {/* 3. Full I/O Tag Binding Matrix Launcher + 1-Click Presets + CSV */}
      <div className="vc-inspector-card">
        <div className="vc-section-header-row">
          <span className="vc-section-label">
            <Table2 size={12} className="vc-emerald-text" />
            <span>I/O TAG BINDING MATRIX</span>
          </span>
          <span
            className={`vc-syntax-summary-pill ${
              validationStats.invalid === 0 ? 'ok' : 'err'
            }`}
          >
            {validationStats.invalid === 0 ? (
              <>
                <CheckCircle2 size={11} />
                <span>
                  {validationStats.valid}/{validationStats.total} Valid
                </span>
              </>
            ) : (
              <>
                <AlertTriangle size={11} />
                <span>{validationStats.invalid} Invalid</span>
              </>
            )}
          </span>
        </div>

        <button
          id="btn-open-full-tag-matrix"
          type="button"
          className="vc-open-matrix-cta"
          onClick={() => setTagMatrixModalOpen(true)}
        >
          <Table2 size={14} />
          <span>
            Open Full I/O Tag Matrix ({plcTagMap.bindings.length} Signals)
          </span>
          <ExternalLink size={12} />
        </button>

        <div className="vc-preset-sublabel">
          <Wand2 size={11} />
          <span>1-Click Auto-Address Presets</span>
        </div>
        <div className="vc-two-col-grid">
          {(
            [
              { id: 's7-process-image', label: 'S7 I / Q / ID' },
              { id: 's7-db1', label: 'S7 DB1 Block' },
              { id: 'mitsubishi-xy-d', label: 'MELSEC X / Y / D' },
              { id: 'opcua-symbolic', label: 'OPC UA Symbolic' },
            ] as Array<{ id: VendorAddressPreset; label: string }>
          ).map((p) => (
            <button
              key={p.id}
              id={`btn-preset-${p.id}`}
              type="button"
              className="vc-mini-preset-btn"
              onClick={() => applyPlcAddressPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="vc-two-col-grid" style={{ marginTop: 6 }}>
          <button
            id="btn-export-plc-csv"
            type="button"
            className="vc-action-btn"
            onClick={exportPlcTagCsvInteractive}
          >
            <Download size={12} />
            <span>Export CSV</span>
          </button>

          <button
            id="btn-import-plc-csv"
            type="button"
            className="vc-action-btn"
            onClick={() => csvInputRef.current?.click()}
          >
            <Upload size={12} />
            <span>Import CSV</span>
          </button>
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => void handleCsvFileSelected(e)}
          />
        </div>
      </div>

      {/* 4. Quick Inline Tag Address List */}
      <div className="vc-inspector-card">
        <div className="vc-section-header-row">
          <span className="vc-section-label">QUICK ADDRESS MAP</span>
          <div className="vc-segmented-group">
            <button
              type="button"
              className={`vc-seg-btn ${scopeMode === 'selected' ? 'active' : ''}`}
              onClick={() => setScopeMode('selected')}
            >
              Selected
            </button>
            <button
              type="button"
              className={`vc-seg-btn ${scopeMode === 'all' ? 'active' : ''}`}
              onClick={() => setScopeMode('all')}
            >
              All ({plcTagMap.bindings.length})
            </button>
          </div>
        </div>

        {visibleBindings.length === 0 ? (
          <div className="vc-subtle-note">
            Select a 3D machine in the Viewport or switch to{' '}
            <strong>All</strong> to inspect mapped PLC tags.
          </div>
        ) : (
          <div className="vc-quick-tag-list">
            {visibleBindings.map((b) => {
              const check = validatePlcAddress(
                plcTagMap.activeAdapter,
                b.plcAddress,
                b.dataType,
                plcTagMap.opcUaConfig.namespaceIndex
              );
              const valStr = formatLiveValCompact(b, liveValues[b.id]);
              return (
                <div key={b.id} className="vc-quick-tag-row">
                  <div className="vc-quick-tag-top">
                    <span
                      className={`vc-dir-mini-badge ${
                        b.direction === 'PLC_TO_SIM' ? 'out' : 'in'
                      }`}
                      title={
                        b.direction === 'PLC_TO_SIM'
                          ? 'PLC Output -> Simulation Input'
                          : 'Simulation Sensor/Encoder -> PLC Input'
                      }
                    >
                      {b.direction === 'PLC_TO_SIM' ? 'PLC→SIM' : 'SIM→PLC'}
                    </span>
                    <span className="vc-quick-tag-name" title={b.signalName}>
                      {b.componentSignalKey}
                    </span>
                    <span className="vc-quick-tag-live vc-mono-text">
                      {valStr}
                    </span>
                  </div>

                  <div className="vc-quick-tag-addr-wrap">
                    <span
                      className={`vc-addr-valid-dot ${check.valid ? 'ok' : 'err'}`}
                      title={check.hint}
                    />
                    <input
                      type="text"
                      value={b.plcAddress}
                      onChange={(e) =>
                        updatePlcTagBinding(b.id, { plcAddress: e.target.value })
                      }
                      className={`vc-quick-addr-input vc-mono-text ${
                        check.valid ? '' : 'invalid'
                      }`}
                      title={check.hint}
                    />
                    <span className="vc-dtype-chip">{b.dataType}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
