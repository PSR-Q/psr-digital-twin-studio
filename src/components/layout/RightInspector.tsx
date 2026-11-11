import {
  Cpu,
  ExternalLink,
  GitBranch,
  Link2,
  Magnet,
  Plus,
  Sliders,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { SnapPortDefinition, Vector3Tuple } from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';

const NORMAL_PRESETS: Array<{ label: string; vec: Vector3Tuple }> = [
  { label: '-X (Left)', vec: [-1, 0, 0] },
  { label: '+X (Right)', vec: [1, 0, 0] },
  { label: '-Z (North)', vec: [0, 0, -1] },
  { label: '+Z (South)', vec: [0, 0, 1] },
  { label: '+Y (Top)', vec: [0, 1, 0] },
  { label: '-Y (Bottom)', vec: [0, -1, 0] },
];

export function RightInspector() {
  const [activeTab, setActiveTab] = useState<'transform' | 'hierarchy'>('transform');

  const selectedInstanceId = useEditorStore((s) => s.selectedInstanceId);
  const instances = useEditorStore((s) => s.scene.instances);
  const library = useEditorStore((s) => s.scene.componentLibrary);
  const snapConnections = useEditorStore((s) => s.scene.snapConnections);
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

  if (!selectedInstance || !selectedComponent) {
    return (
      <aside id="vc-right-inspector" className="vc-right-dock">
        <div className="vc-pane-header">
          <div className="vc-pane-title">
            <Sliders size={14} />
            <span>INSPECTOR · SCENE SETTINGS</span>
          </div>
        </div>

        <div className="vc-inspector-scroll">
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
              <strong className="vc-mono-text">{library.length} definitions</strong>
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
          </div>

          <div className="vc-empty-hint">
            Click any 3D machine in the viewport or Scene Hierarchy to inspect its
            6-DOF transform, customize magnetic <code>SnapPorts</code>, or view its{' '}
            <code>.glb</code> sub-mesh tree.
          </div>
        </div>
      </aside>
    );
  }

  const updateVecAxis = (
    field: 'position' | 'rotationDeg' | 'scale',
    axisIdx: 0 | 1 | 2,
    rawVal: string
  ) => {
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
          <span>INSPECTOR</span>
        </div>
        <button
          id="btn-export-vcomp"
          type="button"
          className="vc-mini-action-btn"
          onClick={() => void exportComponentVcompInteractive(selectedComponent.id)}
          title="Export reusable .vcomp.json Component Definition"
        >
          <ExternalLink size={11} />
          <span>.vcomp</span>
        </button>
      </div>

      {/* Inspector Mode Tabs */}
      <div className="vc-inspector-tabs">
        <button
          id="tab-inspector-transform"
          type="button"
          className={`vc-insp-tab ${activeTab === 'transform' ? 'active' : ''}`}
          onClick={() => setActiveTab('transform')}
        >
          <Magnet size={13} />
          <span>Transform & SnapPorts</span>
        </button>
        <button
          id="tab-inspector-hierarchy"
          type="button"
          className={`vc-insp-tab ${activeTab === 'hierarchy' ? 'active' : ''}`}
          onClick={() => setActiveTab('hierarchy')}
        >
          <GitBranch size={13} />
          <span>3D Nodes & I/O</span>
        </button>
      </div>

      <div className="vc-inspector-scroll">
        {/* Selected Machine Identity */}
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
              BBox: {selectedComponent.boundingBox.size.map((n) => n.toFixed(2)).join('×')}m
            </span>
          </div>
        </div>

        {activeTab === 'transform' ? (
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
                          updateVecAxis('rotationDeg', idx as 0 | 1 | 2, e.target.value)
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
                <span>ACTIVE MAGNETIC CONNECTIONS ({instanceConnections.length})</span>
              </div>

              {instanceConnections.length === 0 ? (
                <div className="vc-subtle-note">
                  Not snapped yet. Drag with Move Gizmo near a compatible Input/Output port.
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

            {/* SnapPort Editor for Custom / Imported .glb Components */}
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
                        onClick={() => deleteSnapPort(selectedComponent.id, port.id)}
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
        ) : (
          <>
            {/* Sub-Mesh Hierarchy & Milestone 2-4 Schema Preview */}
            <div className="vc-inspector-card">
              <div className="vc-section-label">
                DISCOVERED 3D SUB-MESH NODES (
                {Object.keys(selectedComponent.nodeRoles).length})
              </div>
              <div className="vc-node-role-list">
                {Object.values(selectedComponent.nodeRoles).map((assignment) => (
                  <div key={assignment.nodeName} className="vc-node-role-row">
                    <span className="vc-mono-text">{assignment.nodeName}</span>
                    <span className={`vc-role-chip role-${assignment.role}`}>
                      {assignment.role}
                    </span>
                  </div>
                ))}
              </div>
              <div className="vc-subtle-note" style={{ marginTop: 8 }}>
                Interactive Linear/Rotary Joint Builder & Signal Force Panel unlock in{' '}
                <strong>Milestone 2</strong>.
              </div>
            </div>

            <div className="vc-inspector-card">
              <div className="vc-section-label">
                <Cpu size={12} />
                <span>PRE-MAPPED COMPONENT SIGNALS ({selectedComponent.exposedSignals.length})</span>
              </div>
              {selectedComponent.exposedSignals.length === 0 ? (
                <div className="vc-subtle-note">
                  Custom .glb signals will be generated automatically when assigning axes/sensors in Milestones 2–4.
                </div>
              ) : (
                <div className="vc-node-role-list">
                  {selectedComponent.exposedSignals.map((sig) => (
                    <div key={sig.key} className="vc-node-role-row">
                      <span>{sig.label}</span>
                      <span className="vc-mono-text vc-sig-chip">
                        {sig.direction === 'PLC_TO_SIM' ? 'OUT' : 'IN'} · {sig.dataType}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
