import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  Lock,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Search,
  Table2,
  Unlock,
  Unplug,
  Upload,
  Wand2,
  X,
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
  type PlcSignalDataType,
  type PlcSignalDirection,
  type PlcTagBinding,
  type PlcWorkerDiagnostics,
} from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';

const PROTOCOL_SYNTAX_GUIDE: Record<PlcAdapterType, string> = {
  InternalSimAdapter:
    'InternalSim: Direct 4KB BinaryIpcBufferView slots — any symbolic address accepted.',
  SiemensS7Adapter:
    'Siemens S7 Syntax: BOOL = Q0.0, I0.1, M0.0, DB1,X0.0  |  INT16 = QW100, IW100, DB1,INT2  |  DINT32 = QD200, ID200, DB1,DINT4  |  FLOAT32 = QD400, ID400, DB1,REAL8',
  MitsubishiMcAdapter:
    'MELSEC 3E Syntax: BOOL = Y0..Y1F (Hex), X0..X1F (Hex), M0..M999 (Dec)  |  INT16 = D100, W0  |  DINT32 / FLOAT32 = D200 (2 contiguous words D200..D201)',
  OpcUaAdapter:
    'OPC UA NodeId Syntax: ns=2;s=Infeed_Conveyor_01.BeltRun  |  ns=2;i=1001  |  or bare symbolic tag name (uses Default Namespace Index)',
};

function formatSlotBadge(b: PlcTagBinding): string {
  const prefix =
    b.dataType === 'BOOL'
      ? b.direction === 'PLC_TO_SIM'
        ? 'DO'
        : 'DI'
      : b.dataType === 'INT16'
        ? 'W'
        : b.dataType === 'DINT32'
          ? 'DW'
          : 'R';
  return `${prefix}#${b.bufferSlotIndex}`;
}

function formatMatrixLiveValue(
  b: PlcTagBinding,
  rawVal: boolean | number | undefined
): string {
  if (b.dataType === 'BOOL') {
    return rawVal ? 'TRUE (1)' : 'FALSE (0)';
  }
  const num = typeof rawVal === 'number' ? rawVal : 0;
  if (b.dataType === 'INT16' || b.dataType === 'DINT32') {
    return Math.round(num).toLocaleString('en-US');
  }
  return num.toFixed(2);
}

export function PlcTagMatrixModal() {
  const isOpen = useEditorStore((s) => s.isTagMatrixModalOpen);
  const setTagMatrixModalOpen = useEditorStore((s) => s.setTagMatrixModalOpen);

  const plcTagMap = useEditorStore((s) => s.scene.plcTagMap);
  const instances = useEditorStore((s) => s.scene.instances);

  const setPlcActiveAdapter = useEditorStore((s) => s.setPlcActiveAdapter);
  const updatePlcTagBinding = useEditorStore((s) => s.updatePlcTagBinding);
  const applyPlcAddressPreset = useEditorStore((s) => s.applyPlcAddressPreset);
  const triggerPlcConnectionAction = useEditorStore(
    (s) => s.triggerPlcConnectionAction
  );
  const setSignalForce = useEditorStore((s) => s.setSignalForce);
  const clearAllForces = useEditorStore((s) => s.clearAllForces);
  const exportPlcTagCsvInteractive = useEditorStore(
    (s) => s.exportPlcTagCsvInteractive
  );
  const importPlcTagCsvText = useEditorStore((s) => s.importPlcTagCsvText);

  const csvFileRef = useRef<HTMLInputElement | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [machineFilter, setMachineFilter] = useState<string>('ALL');
  const [dirFilter, setDirFilter] = useState<'ALL' | PlcSignalDirection>('ALL');
  const [typeFilter, setTypeFilter] = useState<'ALL' | PlcSignalDataType>('ALL');
  const [onlyInvalid, setOnlyInvalid] = useState(false);

  const [diagnostics, setDiagnostics] = useState<PlcWorkerDiagnostics>(() =>
    createDefaultPlcDiagnostics()
  );
  const [liveValues, setLiveValues] = useState<Record<string, boolean | number>>(
    {}
  );

  // Poll 10Hz live telemetry only while Modal is open
  useEffect(() => {
    if (!isOpen) return;
    const poll = () => {
      setDiagnostics(runtimeBusClient.getDiagnostics());
      const bindings = useEditorStore.getState().scene.plcTagMap.bindings;
      const next: Record<string, boolean | number> = {};
      for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i];
        next[b.id] = runtimeBusClient.readBindingLiveValue(b);
      }
      setLiveValues(next);
    };
    poll();
    const timer = window.setInterval(poll, 100);
    return () => window.clearInterval(timer);
  }, [isOpen]);

  const instanceNameMap = useMemo(
    () => new Map(instances.map((i) => [i.id, i.name])),
    [instances]
  );

  const enrichedRows = useMemo(() => {
    return plcTagMap.bindings.map((b) => {
      const check = validatePlcAddress(
        plcTagMap.activeAdapter,
        b.plcAddress,
        b.dataType,
        plcTagMap.opcUaConfig.namespaceIndex
      );
      return {
        binding: b,
        machineName: instanceNameMap.get(b.instanceId) ?? b.instanceId,
        valid: check.valid,
        hint: check.hint,
      };
    });
  }, [
    plcTagMap.bindings,
    plcTagMap.activeAdapter,
    plcTagMap.opcUaConfig.namespaceIndex,
    instanceNameMap,
  ]);

  const invalidCount = useMemo(
    () => enrichedRows.filter((r) => !r.valid).length,
    [enrichedRows]
  );

  const forcedCount = useMemo(
    () => plcTagMap.bindings.filter((b) => b.manualForceEnabled).length,
    [plcTagMap.bindings]
  );

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return enrichedRows.filter((r) => {
      if (machineFilter !== 'ALL' && r.binding.instanceId !== machineFilter) {
        return false;
      }
      if (dirFilter !== 'ALL' && r.binding.direction !== dirFilter) {
        return false;
      }
      if (typeFilter !== 'ALL' && r.binding.dataType !== typeFilter) {
        return false;
      }
      if (onlyInvalid && r.valid) {
        return false;
      }
      if (q) {
        const hay =
          `${r.machineName} ${r.binding.signalName} ${r.binding.componentSignalKey} ${r.binding.plcAddress}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [
    enrichedRows,
    machineFilter,
    dirFilter,
    typeFilter,
    onlyInvalid,
    searchQuery,
  ]);

  if (!isOpen) return null;

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const text = await f.text();
    importPlcTagCsvText(text, f.name);
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
    <div
      id="vc-plc-tag-matrix-backdrop"
      className="vc-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          setTagMatrixModalOpen(false);
        }
      }}
    >
      <section
        id="vc-plc-tag-matrix-modal"
        className="vc-matrix-modal"
        aria-label="I/O Tag Binding Matrix"
      >
        {/* Top Header */}
        <header className="vc-matrix-header">
          <div className="vc-matrix-title-group">
            <Table2 size={16} className="vc-cyan-text" />
            <div>
              <h2 className="vc-matrix-title">
                I/O TAG BINDING MATRIX &amp; LIVE PLC BUS MONITOR
              </h2>
              <div className="vc-matrix-subtitle">
                <Cpu size={11} />
                <span>{diagnostics.endpointSummary}</span>
                <span>·</span>
                <span className="vc-mono-text">
                  Scan {diagnostics.actualScanCycleMs.toFixed(1)} ms (Target{' '}
                  {plcTagMap.scanCycleMs} ms)
                </span>
              </div>
            </div>
          </div>

          <div className="vc-matrix-header-actions">
            <select
              id="matrix-select-driver"
              value={plcTagMap.activeAdapter}
              onChange={(e) =>
                setPlcActiveAdapter(e.target.value as PlcAdapterType, true)
              }
              className="vc-matrix-driver-select vc-mono-text"
              aria-label="Active PLC Protocol Adapter"
            >
              <option value="InternalSimAdapter">InternalSimAdapter</option>
              <option value="SiemensS7Adapter">
                SiemensS7Adapter (PLCSIM Adv / S7)
              </option>
              <option value="MitsubishiMcAdapter">
                MitsubishiMcAdapter (3E Binary MC)
              </option>
              <option value="OpcUaAdapter">
                OpcUaAdapter (Sysmac / CODESYS)
              </option>
            </select>

            <span className={`vc-plc-conn-pill ${connBadgeClass}`}>
              <span className="vc-plc-conn-dot" />
              {connState}
            </span>

            <button
              id="btn-matrix-connect"
              type="button"
              className="vc-tool-btn vc-tool-btn-primary"
              onClick={() =>
                triggerPlcConnectionAction(
                  connState === 'CONNECTED' ? 'reconnect' : 'connect'
                )
              }
            >
              {connState === 'CONNECTED' ? (
                <>
                  <RefreshCw size={13} />
                  <span>Reconnect</span>
                </>
              ) : (
                <>
                  <PlugZap size={13} />
                  <span>Connect</span>
                </>
              )}
            </button>

            <button
              id="btn-matrix-disconnect"
              type="button"
              className="vc-tool-btn"
              onClick={() => triggerPlcConnectionAction('disconnect')}
            >
              <Unplug size={13} />
              <span>Disconnect</span>
            </button>

            <button
              id="btn-close-tag-matrix"
              type="button"
              className="vc-matrix-close-btn"
              onClick={() => setTagMatrixModalOpen(false)}
              title="Close Tag Matrix (Esc)"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {/* Filter, Auto-Addressing & CSV Toolbar */}
        <div className="vc-matrix-toolbar">
          <div className="vc-matrix-filters">
            <div className="vc-matrix-search-box">
              <Search size={13} />
              <input
                id="input-matrix-search"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search signal, machine, or PLC address..."
              />
            </div>

            <select
              id="select-matrix-machine"
              value={machineFilter}
              onChange={(e) => setMachineFilter(e.target.value)}
              className="vc-matrix-filter-select"
            >
              <option value="ALL">All Machines ({instances.length})</option>
              {instances.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.name}
                </option>
              ))}
            </select>

            <div className="vc-segmented-group">
              {(
                [
                  { id: 'ALL', label: 'All Dir' },
                  { id: 'PLC_TO_SIM', label: 'PLC → SIM' },
                  { id: 'SIM_TO_PLC', label: 'SIM → PLC' },
                ] as const
              ).map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`vc-seg-btn ${dirFilter === d.id ? 'active' : ''}`}
                  onClick={() => setDirFilter(d.id)}
                >
                  {d.label}
                </button>
              ))}
            </div>

            <div className="vc-segmented-group">
              {(
                ['ALL', 'BOOL', 'INT16', 'DINT32', 'FLOAT32'] as const
              ).map((dt) => (
                <button
                  key={dt}
                  type="button"
                  className={`vc-seg-btn ${typeFilter === dt ? 'active' : ''}`}
                  onClick={() => setTypeFilter(dt)}
                >
                  {dt === 'FLOAT32'
                    ? 'REAL'
                    : dt === 'DINT32'
                      ? 'DINT'
                      : dt === 'INT16'
                        ? 'INT'
                        : dt}
                </button>
              ))}
            </div>

            {invalidCount > 0 && (
              <button
                type="button"
                className={`vc-tool-btn ${
                  onlyInvalid ? 'vc-tool-btn-accent' : ''
                }`}
                onClick={() => setOnlyInvalid(!onlyInvalid)}
              >
                <AlertTriangle size={12} />
                <span>{invalidCount} Invalid</span>
              </button>
            )}
          </div>

          <div className="vc-matrix-tools-right">
            <span className="vc-micro-label">
              <Wand2 size={11} /> Auto-Map:
            </span>
            {(
              [
                { id: 's7-process-image', label: 'S7 I/Q' },
                { id: 's7-db1', label: 'S7 DB1' },
                { id: 'mitsubishi-xy-d', label: 'MELSEC' },
                { id: 'opcua-symbolic', label: 'OPC UA' },
              ] as Array<{ id: VendorAddressPreset; label: string }>
            ).map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="vc-mini-preset-btn"
                onClick={() => applyPlcAddressPreset(preset.id)}
              >
                {preset.label}
              </button>
            ))}

            <button
              type="button"
              className="vc-tool-btn"
              onClick={() => csvFileRef.current?.click()}
              title="Import PLC Addresses & Scale/Offset from CSV"
            >
              <Upload size={12} />
              <span>Import CSV</span>
            </button>
            <input
              ref={csvFileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => void handleImportFile(e)}
            />

            <button
              type="button"
              className="vc-tool-btn"
              onClick={exportPlcTagCsvInteractive}
              title="Export Full I/O Tag Matrix to CSV"
            >
              <Download size={12} />
              <span>Export CSV</span>
            </button>

            {forcedCount > 0 && (
              <button
                type="button"
                className="vc-tool-btn vc-tool-btn-accent"
                onClick={clearAllForces}
                title="Release all Manual Force overrides"
              >
                <RotateCcw size={12} />
                <span>Unforce ({forcedCount})</span>
              </button>
            )}
          </div>
        </div>

        {/* Wide Industrial Data Table */}
        <div className="vc-matrix-table-scroll">
          <table className="vc-matrix-table">
            <thead>
              <tr>
                <th style={{ width: '74px' }}>Slot</th>
                <th style={{ width: '175px' }}>Machine Instance</th>
                <th>Signal Key &amp; Tag Name</th>
                <th style={{ width: '98px' }}>Direction</th>
                <th style={{ width: '82px' }}>IEC Type</th>
                <th style={{ width: '215px' }}>PLC Address</th>
                <th style={{ width: '154px' }}>Scale / Offset</th>
                <th style={{ width: '132px' }}>Live Value</th>
                <th style={{ width: '205px' }}>Manual Force Override</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="vc-matrix-empty-cell">
                    No I/O tag bindings match the current filter criteria.
                  </td>
                </tr>
              ) : (
                filteredRows.map(({ binding: b, machineName, valid, hint }) => {
                  const liveVal = liveValues[b.id];
                  const isBool = b.dataType === 'BOOL';
                  const boolActive = Boolean(liveVal);

                  return (
                    <tr
                      key={b.id}
                      className={b.manualForceEnabled ? 'vc-row-forced' : ''}
                    >
                      <td className="vc-mono-text vc-muted-cell">
                        {formatSlotBadge(b)}
                      </td>

                      <td>
                        <span className="vc-machine-chip" title={machineName}>
                          {machineName}
                        </span>
                      </td>

                      <td>
                        <div className="vc-sig-cell-main">
                          <strong>{b.componentSignalKey}</strong>
                          <small className="vc-mono-text">{b.signalName}</small>
                        </div>
                      </td>

                      <td>
                        <span
                          className={`vc-dir-mini-badge ${
                            b.direction === 'PLC_TO_SIM' ? 'out' : 'in'
                          }`}
                        >
                          {b.direction === 'PLC_TO_SIM'
                            ? 'PLC → SIM'
                            : 'SIM → PLC'}
                        </span>
                      </td>

                      <td>
                        <span
                          className={`vc-dtype-pill ${
                            b.dataType === 'DINT32'
                              ? 'dint'
                              : b.dataType === 'FLOAT32'
                                ? 'real'
                                : b.dataType === 'INT16'
                                  ? 'int'
                                  : 'bool'
                          }`}
                        >
                          {b.dataType === 'FLOAT32'
                            ? 'REAL'
                            : b.dataType === 'DINT32'
                              ? 'DINT'
                              : b.dataType === 'INT16'
                                ? 'INT'
                                : 'BOOL'}
                        </span>
                      </td>

                      <td>
                        <div className="vc-matrix-addr-cell" title={hint}>
                          {valid ? (
                            <CheckCircle2
                              size={12}
                              className="vc-emerald-text vc-shrink-0"
                            />
                          ) : (
                            <AlertTriangle
                              size={12}
                              className="vc-danger-text vc-shrink-0"
                            />
                          )}
                          <input
                            type="text"
                            value={b.plcAddress}
                            onChange={(e) =>
                              updatePlcTagBinding(b.id, {
                                plcAddress: e.target.value,
                              })
                            }
                            className={`vc-matrix-addr-input vc-mono-text ${
                              valid ? '' : 'invalid'
                            }`}
                          />
                        </div>
                      </td>

                      <td>
                        {isBool ? (
                          <span className="vc-mono-text vc-muted-cell">
                            1-bit discrete
                          </span>
                        ) : (
                          <div className="vc-scale-offset-pair">
                            <input
                              type="number"
                              step={0.1}
                              value={b.scaleFactor}
                              onChange={(e) => {
                                const sc = Number(e.target.value);
                                if (Number.isFinite(sc) && sc !== 0) {
                                  updatePlcTagBinding(b.id, { scaleFactor: sc });
                                }
                              }}
                              title="Engineering Scale Factor (eng = raw * scale + offset)"
                              className="vc-scale-input vc-mono-text"
                            />
                            <input
                              type="number"
                              step={1}
                              value={b.offset}
                              onChange={(e) => {
                                const off = Number(e.target.value);
                                if (Number.isFinite(off)) {
                                  updatePlcTagBinding(b.id, { offset: off });
                                }
                              }}
                              title="Engineering Offset (eng = raw * scale + offset)"
                              className="vc-scale-input vc-mono-text"
                            />
                          </div>
                        )}
                      </td>

                      <td>
                        {isBool ? (
                          <span
                            className={`vc-live-bool-badge ${
                              boolActive ? 'on' : 'off'
                            }`}
                          >
                            <span className="vc-live-bool-dot" />
                            {boolActive ? 'TRUE' : 'FALSE'}
                          </span>
                        ) : (
                          <span className="vc-live-num-readout vc-mono-text">
                            {formatMatrixLiveValue(b, liveVal)}
                          </span>
                        )}
                      </td>

                      <td>
                        <div className="vc-matrix-force-cell">
                          <button
                            type="button"
                            className={`vc-force-lock-btn ${
                              b.manualForceEnabled ? 'forced' : ''
                            }`}
                            onClick={() =>
                              setSignalForce(
                                b.id,
                                !b.manualForceEnabled,
                                b.manualForceEnabled
                                  ? isBool
                                    ? false
                                    : 0
                                  : (liveVal ?? b.manualForceValue),
                                false
                              )
                            }
                            title={
                              b.manualForceEnabled
                                ? 'Release Force override'
                                : 'Enable Manual Force override'
                            }
                          >
                            {b.manualForceEnabled ? (
                              <>
                                <Lock size={11} />
                                <span>FORCED</span>
                              </>
                            ) : (
                              <>
                                <Unlock size={11} />
                                <span>Force</span>
                              </>
                            )}
                          </button>

                          {isBool ? (
                            <button
                              type="button"
                              className={`vc-force-val-toggle ${
                                Boolean(b.manualForceValue) &&
                                b.manualForceEnabled
                                  ? 'high'
                                  : ''
                              }`}
                              onClick={() =>
                                setSignalForce(
                                  b.id,
                                  true,
                                  !(b.manualForceEnabled
                                    ? Boolean(b.manualForceValue)
                                    : boolActive),
                                  b.direction === 'PLC_TO_SIM'
                                )
                              }
                            >
                              {b.manualForceEnabled
                                ? b.manualForceValue
                                  ? '1 (ON)'
                                  : '0 (OFF)'
                                : 'Toggle'}
                            </button>
                          ) : (
                            <input
                              type="number"
                              step={b.dataType === 'FLOAT32' ? 1 : 10}
                              value={
                                b.manualForceEnabled
                                  ? Number(b.manualForceValue ?? 0)
                                  : typeof liveVal === 'number'
                                    ? Number(liveVal.toFixed(2))
                                    : 0
                              }
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                if (!Number.isNaN(v)) {
                                  setSignalForce(
                                    b.id,
                                    true,
                                    v,
                                    b.direction === 'PLC_TO_SIM'
                                  );
                                }
                              }}
                              className="vc-force-num-box vc-mono-text"
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer Syntax Cheat Sheet & Live Summary */}
        <footer className="vc-matrix-footer">
          <div className="vc-matrix-syntax-tip vc-mono-text">
            {PROTOCOL_SYNTAX_GUIDE[plcTagMap.activeAdapter]}
          </div>
          <div className="vc-matrix-footer-stats vc-mono-text">
            <span>
              Showing <strong>{filteredRows.length}</strong> /{' '}
              {plcTagMap.bindings.length} tags
            </span>
            <span>·</span>
            <span>
              Rx/Tx: {diagnostics.cyclicReadCount}/
              {diagnostics.cyclicWriteCount}
            </span>
            <span>·</span>
            <span>Forced: {forcedCount}</span>
          </div>
        </footer>
      </section>
    </div>
  );
}
