import {
  Cpu,
  ExternalLink,
  Link2,
  Magnet,
  Plus,
  Route,
  Sliders,
  Trash2,
  Wrench,
  Zap,
} from 'lucide-react';
import { useMemo } from 'react';
import type { SnapPortDefinition, Vector3Tuple } from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';
import { ComponentBuilderPanel } from '../inspector/ComponentBuilderPanel';
import { PlcDriverAndTagPanel } from '../inspector/PlcDriverAndTagPanel';
import { SignalForcePanel } from '../inspector/SignalForcePanel';
import { TransportBuilderPanel } from '../inspector/TransportBuilderPanel';

const NORMAL_PRESETS: Array<{ label: string; vec: Vector3Tuple }> = [
  { label: '-X (Left)', vec: [-1, 0, 0] },
  { label: '+X (Right)', vec: [1, 0, 0] },
  { label: '-Z (North)', vec: [0, 0, -1] },
  { label: '+Z (South)', vec: [0, 0, 1] },
  { label: '+Y (Top)', vec: [0, 1, 0] },
  { label: '-Y (Bottom)', vec: [0, -1, 0] },
];

export function RightInspector() {
  const inspectorTab = useEditorStore((s) => s.inspectorTab);
  const setInspectorTab = useEditorStore((s) => s.setInspectorTab);

  const selectedInstanceId = useEditorStore((s) => s.selectedInstanceId);
  const instances = useEditorStore((s) => s.scene.instances);
  const library = useEditorStore((s) => s.scene.componentLibrary);
  const snapConnections = useEditorStore((s) => s.scene.snapConnections);
  const bindings = useEditorStore((s) => s.scene.plcTagMap.bindings);
  const env = useEditorStore((s) => s.scene.environment);

  const renameInstance = useEditorStore((s) => s.renameInstance);
  const updateInstanceTransform = useEditorStore((s) => s.updateInstanceTransform);
  const updateEnvironment = useEditorStore((s) => s.updateEnvironment);
  const addSnapPort = useEditorStore((s) => s.addSnapPort);
  const updateSnapPort = useEditorStore((s) => s.updateSnapPort);
  const deleteSnapPort = useEditorStore((s) => s.deleteSnapPort);
  const exportComponentVcompInteractive = useEditorStore(
    (s) => s.exportComponentVcompInteractive
  );

  const selectedInstance = useMemo(
    () => instances.find((i) => i.id === selectedInstanceId) ?? null,
    [instances, selectedInstanceId]
  );

  const selectedComponent = useMemo(
    () =>
      selectedInstance
        ? library.find((c) => c.id === selectedInstance.componentId) ?? null
        : null,
    [library, selectedInstance]
  );

  const instanceConnections = useMemo(() => {
    if (!selectedInstance) return [];
    return snapConnections.filter(
      (c) =>
        c.sourceInstanceId === selectedInstance.id ||
        c.targetInstanceId === selectedInstance.id
    );
  }, [snapConnections, selectedInstance]);

  const activeForceCount = useMemo(
    () => bindings.filter((b) => b.manualForceEnabled).length,
    [bindings]
  );

  const updateVecAxis = (
    field: 'position' | 'rotationDeg' | 'scale',
    axisIdx: 0 | 1 | 2,
    rawVal: string
  ) => {
    if (!selectedInstance) return;
    const parsed = Number(rawVal);
    if (Number.isNaN(parsed)) return;
    const nextTuple = [...selectedInstance.transform[field]] as Vector3Tuple;
    nextTuple[axisIdx] = parsed;
    updateInstanceTransform(
      selectedInstance.id,
      {
        ...selectedInstance.transform,
        [field]: nextTuple,
      },
      true
    );
  };

  const quickRotateY = (yawDeg: number) => {
    if (!selectedInstance) return;
    const [rx, , rz] = selectedInstance.transform.rotationDeg;
    updateInstanceTransform(
      selectedInstance.id,
      {
        ...selectedInstance.transform,
        rotationDeg: [rx, yawDeg, rz],
      },
      true
    );
  };

  const updatePortCoord = (
    port: SnapPortDefinition,
    axisIdx: 0 | 1 | 2,
    val: string
  ) => {
    if (!selectedComponent) return;
    const num = Number(val);
    if (Number.isNaN(num)) return;
    const nextPos = [...port.localPosition] as Vector3Tuple;
    nextPos[axisIdx] = num;
    updateSnapPort(selectedComponent.id, port.id, { localPosition: nextPos });
  };

  return (
    <aside id="vc-right-inspector" className="vc-right-dock">
      <div className="vc-pane-header">
        <div className="vc-pane-title">
          <Sliders size={14} />
          <span>
            {selectedInstance ? 'INSPECTOR & BUILDER' : 'INSPECTOR · PLANT'}
          </span>
        </div>
        {selectedComponent && (
          <button
            id="btn-export-vcomp"
            type="button"
            className="vc-mini-action-btn"
            onClick={() =>
              void exportComponentVcompInteractive(selectedComponent.id)
            }
            title="Export reusable .vcomp.json Component Definition"
          >
            <ExternalLink size={11} />
            <span>.vcomp</span>
          </button>
        )}
      </div>

      {/* 5-Mode Inspector Tabs (Always Accessible) */}
      <div className="vc-inspector-tabs">
        <button
          id="tab-inspector-transform"
          type="button"
          className={`vc-insp-tab ${inspectorTab === 'transform' ? 'active' : ''}`}
          onClick={() => setInspectorTab('transform')}
          title="6-DOF Transform & SnapPorts"
        >
          <Magnet size={11} />
          <span>Layout</span>
        </button>
        <button
          id="tab-inspector-builder"
          type="button"
          className={`vc-insp-tab ${inspectorTab === 'builder' ? 'active' : ''}`}
          onClick={() => setInspectorTab('builder')}
          title="Kinematics Axis Builder (Linear / Rotary / VFX)"
        >
          <Wrench size={11} />
          <span>Builder</span>
        </button>
        <button
          id="tab-inspector-flow"
          type="button"
          className={`vc-insp-tab ${inspectorTab === 'flow' ? 'active' : ''}`}
          onClick={() => setInspectorTab('flow')}
          title="Spline Conveyor Paths, Sensors & HSC Encoders"
        >
          <Route size={11} />
          <span>Flow</span>
        </button>
        <button
          id="tab-inspector-signals"
          type="button"
          className={`vc-insp-tab ${inspectorTab === 'signals' ? 'active' : ''}`}
          onClick={() => setInspectorTab('signals')}
          title="Signal Force Console (PLC I/O)"
        >
          <Zap
            size={11}
            className={activeForceCount > 0 ? 'vc-amber-text' : undefined}
          />
          <span>
            Force{activeForceCount > 0 ? `(${activeForceCount})` : ''}
          </span>
        </button>
        <button
          id="tab-inspector-plc"
          type="button"
          className={`vc-insp-tab ${inspectorTab === 'plc' ? 'active' : ''}`}
          onClick={() => setInspectorTab('plc')}
          title="Live PLC Drivers (S7 / MELSEC 3E / OPC UA) & I/O Tag Matrix"
        >
          <Cpu size={11} />
          <span>PLC</span>
        </button>
      </div>

      <div className="vc-inspector-scroll">
        {/* Selected Machine Identity Header (shown in Layout, Builder & Flow modes when selected) */}
        {selectedInstance &&
          selectedComponent &&
          inspectorTab !== 'signals' &&
          inspectorTab !== 'plc' && (
            <div className="vc-inspector-card">
              <label className="vc-field-label" htmlFor="input-instance-name">
                INSTANCE IDENTIFIER
              </label>
              <input
                id="input-instance-name"
                type="text"
                value={selectedInstance.name}
                onChange={(e) => renameInstance(selectedInstance.id, e.target.value)}
                className="vc-text-input"
              />
              <div className="vc-source-meta">
                <span>Asset: {selectedComponent.modelSource.fileName}</span>
                <span>
                  BBox:{' '}
                  {selectedComponent.boundingBox.size
                    .map((n) => n.toFixed(2))
                    .join('×')}
                  m
                </span>
              </div>
            </div>
          )}

        {/* TAB 5: LIVE PLC DRIVERS & TAG CONSOLE */}
        {inspectorTab === 'plc' ? (
          <PlcDriverAndTagPanel />
        ) : inspectorTab === 'signals' ? (
          <SignalForcePanel />
        ) : inspectorTab === 'flow' ? (
          <TransportBuilderPanel
            instance={selectedInstance}
            component={selectedComponent}
          />
        ) : !selectedInstance || !selectedComponent ? (
          <>
            {inspectorTab === 'builder' && (
              <div className="vc-inspector-card">
                <div className="vc-section-label">
                  <Wrench size={12} className="vc-amber-text" />
                  <span>COMPONENT BUILDER</span>
                </div>
                <div className="vc-subtle-note">
                  Click or double-click any 3D machine in the Viewport to inspect its{' '}
                  <code>.glb</code> / <code>OpenUSD</code> sub-meshes and configure{' '}
                  <strong>LinearAxis</strong> or <strong>RotaryAxis</strong> joints.
                </div>
              </div>
            )}

            <div className="vc-inspector-card">
              <div className="vc-section-label">MAGNETIC SNAP ENGINE</div>

              <label className="vc-toggle-row" htmlFor="chk-auto-align-rot">
                <span>Auto-Align Mating Port Normals</span>
                <input
                  id="chk-auto-align-rot"
                  type="checkbox"
                  checked={env.autoAlignPortRotation}
                  onChange={(e) =>
                    updateEnvironment({ autoAlignPortRotation: e.target.checked })
                  }
                />
              </label>

              <label className="vc-toggle-row" htmlFor="chk-show-snap-ports">
                <span>Show 3D SnapPort Indicators</span>
                <input
                  id="chk-show-snap-ports"
                  type="checkbox"
                  checked={env.showSnapPorts}
                  onChange={(e) =>
                    updateEnvironment({ showSnapPorts: e.target.checked })
                  }
                />
              </label>
            </div>

            <div className="vc-inspector-card">
              <div className="vc-section-label">SCENE SUMMARY</div>
              <div className="vc-kv-row">
                <span>Component Library</span>
                <strong className="vc-mono-text">
                  {library.length} definitions
                </strong>
              </div>
              <div className="vc-kv-row">
                <span>Placed Instances</span>
                <strong className="vc-mono-text">{instances.length} machines</strong>
              </div>
              <div className="vc-kv-row">
                <span>Active Snap Links</span>
                <strong className="vc-mono-text vc-emerald-text">
                  {snapConnections.length} docked
                </strong>
              </div>
              <div className="vc-kv-row">
                <span>Mapped I/O Tags</span>
                <strong className="vc-mono-text vc-cyan-text">
                  {bindings.length} signals
                </strong>
              </div>
            </div>

            <div className="vc-empty-hint">
              Select any 3D machine to edit 6-DOF transforms &{' '}
              <code>SnapPorts</code>, double-click a part to configure{' '}
              <strong>Linear/Rotary Axes</strong>, or open{' '}
              <strong>Force I/O</strong> above to run actuators live.
            </div>
          </>
        ) : inspectorTab === 'builder' ? (
          <ComponentBuilderPanel
            instance={selectedInstance}
            component={selectedComponent}
          />
        ) : (
          <>
            {/* 6-DOF World Transform */}
            <div className="vc-inspector-card">
              <div className="vc-section-label">WORLD TRANSFORM (METERS / DEG)</div>

              <div className="vc-vec3-block">
                <span className="vc-vec3-title">Position (m)</span>
                <div className="vc-vec3-grid">
                  {(['X', 'Y', 'Z'] as const).map((axis, idx) => (
                    <label key={axis} className="vc-axis-input-wrap">
                      <span className={`vc-axis-badge axis-${axis.toLowerCase()}`}>
                        {axis}
                      </span>
                      <input
                        id={`input-pos-${axis.toLowerCase()}`}
                        type="number"
                        step={0.05}
                        value={selectedInstance.transform.position[idx]}
                        onChange={(e) =>
                          updateVecAxis('position', idx as 0 | 1 | 2, e.target.value)
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="vc-vec3-block">
                <div className="vc-vec3-header-inline">
                  <span className="vc-vec3-title">Rotation (°)</span>
                  <div className="vc-quick-yaw-group">
                    {[-90, 0, 90, 180].map((deg) => (
                      <button
                        key={deg}
                        id={`btn-quick-yaw-${deg}`}
                        type="button"
                        className="vc-yaw-chip"
                        onClick={() => quickRotateY(deg)}
                      >
                        {deg}°
                      </button>
                    ))}
                  </div>
                </div>
                <div className="vc-vec3-grid">
                  {(['RX', 'RY', 'RZ'] as const).map((axis, idx) => (
                    <label key={axis} className="vc-axis-input-wrap">
                      <span
                        className={`vc-axis-badge axis-${['x', 'y', 'z'][idx]}`}
                      >
                        {axis}
                      </span>
                      <input
                        id={`input-rot-${axis.toLowerCase()}`}
                        type="number"
                        step={5}
                        value={selectedInstance.transform.rotationDeg[idx]}
                        onChange={(e) =>
                          updateVecAxis(
                            'rotationDeg',
                            idx as 0 | 1 | 2,
                            e.target.value
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="vc-vec3-block">
                <span className="vc-vec3-title">Scale</span>
                <div className="vc-vec3-grid">
                  {(['SX', 'SY', 'SZ'] as const).map((axis, idx) => (
                    <label key={axis} className="vc-axis-input-wrap">
                      <span className="vc-axis-badge">{axis}</span>
                      <input
                        id={`input-scale-${axis.toLowerCase()}`}
                        type="number"
                        step={0.1}
                        min={0.05}
                        value={selectedInstance.transform.scale[idx]}
                        onChange={(e) =>
                          updateVecAxis('scale', idx as 0 | 1 | 2, e.target.value)
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {/* Active Docked Snap Links */}
            <div className="vc-inspector-card">
              <div className="vc-section-label">
                <Link2 size={12} />
                <span>
                  ACTIVE MAGNETIC CONNECTIONS ({instanceConnections.length})
                </span>
              </div>

              {instanceConnections.length === 0 ? (
                <div className="vc-subtle-note">
                  Not snapped yet. Drag with Move Gizmo near a compatible Input/Output
                  port.
                </div>
              ) : (
                <div className="vc-conn-list">
                  {instanceConnections.map((conn) => {
                    const otherId =
                      conn.sourceInstanceId === selectedInstance.id
                        ? conn.targetInstanceId
                        : conn.sourceInstanceId;
                    const otherInst = instances.find((i) => i.id === otherId);
                    return (
                      <div key={conn.id} className="vc-conn-badge">
                        <span className="vc-conn-dot" />
                        <span>
                          Docked with <strong>{otherInst?.name ?? otherId}</strong>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* SnapPort Editor for Custom / Imported .glb & OpenUSD Components */}
            <div className="vc-inspector-card">
              <div className="vc-section-header-row">
                <span className="vc-section-label">
                  COMPONENT SNAP PORTS ({selectedComponent.snapPorts.length})
                </span>
                <div className="vc-inline-btns">
                  <button
                    id="btn-add-inport"
                    type="button"
                    className="vc-port-add-btn vc-cyan"
                    onClick={() => addSnapPort(selectedComponent.id, 'InputPort')}
                    title="Add InputPort to this Component"
                  >
                    <Plus size={11} /> In
                  </button>
                  <button
                    id="btn-add-outport"
                    type="button"
                    className="vc-port-add-btn vc-amber"
                    onClick={() => addSnapPort(selectedComponent.id, 'OutputPort')}
                    title="Add OutputPort to this Component"
                  >
                    <Plus size={11} /> Out
                  </button>
                </div>
              </div>

              <div className="vc-ports-editor-list">
                {selectedComponent.snapPorts.map((port) => (
                  <div key={port.id} className="vc-port-editor-item">
                    <div className="vc-port-editor-top">
                      <span
                        className={`vc-port-role-pill ${
                          port.role === 'InputPort' ? 'in' : 'out'
                        }`}
                      >
                        {port.role === 'InputPort' ? 'IN' : 'OUT'}
                      </span>
                      <input
                        id={`port-name-${port.id}`}
                        type="text"
                        value={port.name}
                        onChange={(e) =>
                          updateSnapPort(selectedComponent.id, port.id, {
                            name: e.target.value,
                          })
                        }
                        className="vc-port-name-input"
                      />
                      <button
                        id={`del-port-${port.id}`}
                        type="button"
                        className="vc-tree-icon-btn vc-danger-hover"
                        onClick={() =>
                          deleteSnapPort(selectedComponent.id, port.id)
                        }
                        title="Remove SnapPort"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>

                    <div className="vc-vec3-grid">
                      {(['X', 'Y', 'Z'] as const).map((ax, idx) => (
                        <label key={ax} className="vc-axis-input-wrap">
                          <span className="vc-axis-badge">{ax}</span>
                          <input
                            id={`port-${port.id}-pos-${ax}`}
                            type="number"
                            step={0.02}
                            value={port.localPosition[idx]}
                            onChange={(e) =>
                              updatePortCoord(port, idx as 0 | 1 | 2, e.target.value)
                            }
                          />
                        </label>
                      ))}
                    </div>

                    <div className="vc-port-normal-row">
                      <span>Face Normal:</span>
                      <select
                        id={`port-${port.id}-normal`}
                        value={port.localNormal.join(',')}
                        onChange={(e) => {
                          const parts = e.target.value.split(',').map(Number);
                          if (parts.length === 3) {
                            updateSnapPort(selectedComponent.id, port.id, {
                              localNormal: parts as Vector3Tuple,
                            });
                          }
                        }}
                        className="vc-compact-select"
                      >
                        {NORMAL_PRESETS.map((np) => (
                          <option key={np.label} value={np.vec.join(',')}>
                            {np.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
