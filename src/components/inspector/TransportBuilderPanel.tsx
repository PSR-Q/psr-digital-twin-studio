import {
  ArrowLeftRight,
  Boxes,
  Cpu,
  Crosshair,
  Gauge,
  GitBranch,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Route,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { runtimeBusClient } from '../../engine/runtimeBusClient';
import {
  makeEncoderPosKey,
  makeEncoderPulsesKey,
  makeSensorSignalKey,
} from '../../engine/signalCatalogSync';
import { transportRuntime } from '../../engine/transportEngine';
import type {
  ComponentDefinition,
  PlcTagBinding,
  SceneNodeInstance,
  UUID,
  Vector3Tuple,
  VirtualEncoderConfig,
} from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';

interface TransportBuilderPanelProps {
  instance: SceneNodeInstance | null;
  component: ComponentDefinition | null;
}

interface LiveFlowSnapshot {
  activeParts: number;
  queuedParts: number;
  sensorTriggered: Record<UUID, boolean>;
  spawnerCounts: Record<UUID, number>;
  sinkCounts: Record<UUID, number>;
  encoders: Record<
    UUID,
    {
      pulsesDint: number;
      servoPositionReal: number;
      velocityReal: number;
    }
  >;
}

const EMPTY_SNAPSHOT: LiveFlowSnapshot = {
  activeParts: 0,
  queuedParts: 0,
  sensorTriggered: {},
  spawnerCounts: {},
  sinkCounts: {},
  encoders: {},
};

export function TransportBuilderPanel({
  instance,
  component,
}: TransportBuilderPanelProps) {
  const [live, setLive] = useState<LiveFlowSnapshot>(EMPTY_SNAPSHOT);

  const instances = useEditorStore((s) => s.scene.instances);
  const transportGraph = useEditorStore((s) => s.scene.transportGraph);
  const bindings = useEditorStore((s) => s.scene.plcTagMap.bindings);
  const runState = useEditorStore((s) => s.runState);
  const isDrawingSplinePath = useEditorStore((s) => s.isDrawingSplinePath);

  const selectInstance = useEditorStore((s) => s.selectInstance);
  const setRunState = useEditorStore((s) => s.setRunState);
  const setIsDrawingSplinePath = useEditorStore((s) => s.setIsDrawingSplinePath);

  const ensureComponentSplinePath = useEditorStore(
    (s) => s.ensureComponentSplinePath
  );
  const updateSplineWaypointLocal = useEditorStore(
    (s) => s.updateSplineWaypointLocal
  );
  const insertSplineMidpoint = useEditorStore((s) => s.insertSplineMidpoint);
  const removeSplineWaypoint = useEditorStore((s) => s.removeSplineWaypoint);
  const reverseSplinePath = useEditorStore((s) => s.reverseSplinePath);
  const clearSplinePath = useEditorStore((s) => s.clearSplinePath);
  const updateComponentPathSettings = useEditorStore(
    (s) => s.updateComponentPathSettings
  );

  const setInstanceFlowEndpointRole = useEditorStore(
    (s) => s.setInstanceFlowEndpointRole
  );
  const updateInstanceSpawner = useEditorStore((s) => s.updateInstanceSpawner);
  const triggerManualSpawnNow = useEditorStore((s) => s.triggerManualSpawnNow);
  const clearAllActiveFlowItems = useEditorStore((s) => s.clearAllActiveFlowItems);

  const addInstancePathSensor = useEditorStore((s) => s.addInstancePathSensor);
  const updateInstancePathSensor = useEditorStore(
    (s) => s.updateInstancePathSensor
  );
  const deleteInstancePathSensor = useEditorStore(
    (s) => s.deleteInstancePathSensor
  );

  const addInstanceVirtualEncoder = useEditorStore(
    (s) => s.addInstanceVirtualEncoder
  );
  const updateInstanceVirtualEncoder = useEditorStore(
    (s) => s.updateInstanceVirtualEncoder
  );
  const deleteInstanceVirtualEncoder = useEditorStore(
    (s) => s.deleteInstanceVirtualEncoder
  );

  // Lightweight 10Hz UI polling of BinaryIpcBufferView & TransportRuntimeEngine
  useEffect(() => {
    const poll = () => {
      const state = useEditorStore.getState();
      const g = state.scene.transportGraph;
      const bv = runtimeBusClient.bufferView;
      const items = transportRuntime.getFlowItems();

      let queued = 0;
      for (let i = 0; i < items.length; i++) {
        if (items[i].isAccumulated) queued++;
      }

      const sensorTriggered: Record<UUID, boolean> = {};
      for (const s of g.sensors) {
        sensorTriggered[s.id] =
          s.outputBoolSlot >= 0
            ? bv.readSimToPlcBool(s.outputBoolSlot)
            : transportRuntime.isSensorTriggered(s.id);
      }

      const spawnerCounts: Record<UUID, number> = {};
      for (const sp of g.spawners) {
        spawnerCounts[sp.id] =
          sp.spawnedCountDintSlot !== undefined && sp.spawnedCountDintSlot >= 0
            ? bv.readDint32(sp.spawnedCountDintSlot)
            : transportRuntime.getSpawnerCount(sp.id);
      }

      const sinkCounts: Record<UUID, number> = {};
      for (const sk of g.sinks) {
        sinkCounts[sk.id] =
          sk.countedPartsDintSlot !== undefined && sk.countedPartsDintSlot >= 0
            ? bv.readDint32(sk.countedPartsDintSlot)
            : transportRuntime.getSinkCount(sk.id);
      }

      const encoders: LiveFlowSnapshot['encoders'] = {};
      for (const enc of g.encoders) {
        encoders[enc.id] = {
          pulsesDint:
            enc.cumulativePulsesDintSlot >= 0
              ? bv.readDint32(enc.cumulativePulsesDintSlot)
              : 0,
          servoPositionReal:
            enc.actualPositionRealSlot >= 0
              ? bv.readFloat32(enc.actualPositionRealSlot)
              : 0,
          velocityReal:
            enc.actualVelocityRealSlot >= 0
              ? bv.readFloat32(enc.actualVelocityRealSlot)
              : 0,
        };
      }

      setLive({
        activeParts: items.length,
        queuedParts: queued,
        sensorTriggered,
        spawnerCounts,
        sinkCounts,
        encoders,
      });
    };

    poll();
    const timer = window.setInterval(poll, 100);
    return () => window.clearInterval(timer);
  }, []);

  const bindingBySigKey = useMemo(() => {
    const map = new Map<string, PlcTagBinding>();
    for (const b of bindings) {
      map.set(`${b.instanceId}::${b.componentSignalKey}`, b);
    }
    return map;
  }, [bindings]);

  const instanceNameById = useMemo(
    () => new Map(instances.map((i) => [i.id, i.name])),
    [instances]
  );

  // =========================================================================
  // GLOBAL PLANT MATERIAL FLOW & HSC TELEMETRY VIEW (When no machine selected)
  // =========================================================================
  if (!instance || !component) {
    const pathNodesCount = Object.keys(transportGraph.nodes).length;
    const totalDispatched = transportGraph.sinks.reduce(
      (sum, sk) => sum + (live.sinkCounts[sk.id] ?? 0),
      0
    );

    return (
      <div className="vc-flow-stack">
        <div className="vc-inspector-card">
          <div className="vc-section-header-row">
            <span className="vc-section-label">
              <Route size={12} className="vc-cyan-text" />
              <span>PLANT FLOW & HSC MONITOR</span>
            </span>

            <div className="vc-inline-btns">
              {runState !== 'RUNNING' ? (
                <button
                  id="btn-flow-global-run"
                  type="button"
                  className="vc-port-add-btn vc-emerald-btn"
                  onClick={() => setRunState('RUNNING')}
                >
                  <Play size={10} /> Run
                </button>
              ) : (
                <button
                  id="btn-flow-global-reset"
                  type="button"
                  className="vc-port-add-btn"
                  onClick={() => setRunState('STOPPED')}
                >
                  <RotateCcw size={10} /> Reset
                </button>
              )}
              <button
                id="btn-flow-clear-parts"
                type="button"
                className="vc-port-add-btn"
                onClick={clearAllActiveFlowItems}
                title="Clear active cartons & reset counters"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="vc-flow-kpi-grid">
            <div className="vc-flow-kpi-box">
              <span className="vc-flow-kpi-label">ACTIVE PARTS</span>
              <strong className="vc-mono-text vc-cyan-text">
                {live.activeParts}
              </strong>
            </div>
            <div className="vc-flow-kpi-box">
              <span className="vc-flow-kpi-label">QUEUED / ACCUM</span>
              <strong className="vc-mono-text vc-amber-text">
                {live.queuedParts}
              </strong>
            </div>
            <div className="vc-flow-kpi-box">
              <span className="vc-flow-kpi-label">DISPATCHED (DINT)</span>
              <strong className="vc-mono-text vc-emerald-text">
                {totalDispatched.toLocaleString()}
              </strong>
            </div>
          </div>

          <div className="vc-kv-row">
            <span>Spline Path Nodes</span>
            <strong className="vc-mono-text">{pathNodesCount} conveyors</strong>
          </div>
          <div className="vc-kv-row">
            <span>Docked Routing Handoffs</span>
            <strong className="vc-mono-text vc-emerald-text">
              {transportGraph.edges.length} edges
            </strong>
          </div>
          <div className="vc-kv-row">
            <span>Mounted Path Sensors</span>
            <strong className="vc-mono-text">
              {transportGraph.sensors.length} sensors
            </strong>
          </div>
        </div>

        {/* All Plant Virtual HSC Encoders & Servo Positions */}
        <div className="vc-inspector-card">
          <div className="vc-section-label">
            <Gauge size={12} className="vc-amber-text" />
            <span>
              LIVE HSC ENCODERS & SERVO POS ({transportGraph.encoders.length})
            </span>
          </div>

          <div className="vc-encoder-list">
            {transportGraph.encoders.map((enc) => {
              const eLive = live.encoders[enc.id];
              const pulses = eLive?.pulsesDint ?? 0;
              const posVal = eLive?.servoPositionReal ?? 0;
              const velVal = eLive?.velocityReal ?? 0;
              const posUnit = enc.sourceKind === 'rotary-axis' ? '°' : 'mm';
              const velUnit = enc.sourceKind === 'rotary-axis' ? 'deg/s' : 'mm/s';
              const pulseBinding = bindingBySigKey.get(
                `${enc.targetInstanceId}::${makeEncoderPulsesKey(enc.id)}`
              );
              const posBinding = bindingBySigKey.get(
                `${enc.targetInstanceId}::${makeEncoderPosKey(enc.id)}`
              );

              return (
                <div key={enc.id} className="vc-encoder-card">
                  <button
                    type="button"
                    className="vc-machine-focus-btn"
                    onClick={() => selectInstance(enc.targetInstanceId)}
                  >
                    <span className="vc-machine-focus-name">
                      {instanceNameById.get(enc.targetInstanceId) ??
                        enc.targetInstanceId}{' '}
                      · {enc.name}
                    </span>
                    <span className="vc-machine-focus-sub vc-mono-text">
                      {enc.pulsesPerRevolution} PPR
                    </span>
                  </button>

                  <div className="vc-hsc-telemetry-grid">
                    <div className="vc-hsc-cell">
                      <div className="vc-hsc-cell-head">
                        <span className="vc-dtype-pill dint">DINT</span>
                        <span className="vc-mono-text vc-plc-addr-tag">
                          {pulseBinding?.plcAddress ?? 'ID—'}
                        </span>
                      </div>
                      <div className="vc-hsc-val vc-mono-text">
                        {pulses.toLocaleString()} <small>pulse</small>
                      </div>
                    </div>

                    <div className="vc-hsc-cell">
                      <div className="vc-hsc-cell-head">
                        <span className="vc-dtype-pill real">REAL</span>
                        <span className="vc-mono-text vc-plc-addr-tag">
                          {posBinding?.plcAddress ?? 'ID—'}
                        </span>
                      </div>
                      <div className="vc-hsc-val vc-mono-text">
                        {posVal.toFixed(1)} <small>{posUnit}</small>
                      </div>
                    </div>
                  </div>

                  <div className="vc-hsc-vel-bar vc-mono-text">
                    <span>Actual Velocity:</span>
                    <span>
                      {velVal.toFixed(1)} {velUnit}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="vc-empty-hint">
          Click any conveyor, stopper, turntable, or servo gantry in the 3D Viewport
          to draw custom <strong>Spline Paths</strong>, mount{' '}
          <strong>Photoelectric / Proximity Sensors</strong>, or tune{' '}
          <strong>HSC Encoder PPR</strong>.
        </div>
      </div>
    );
  }

  // =========================================================================
  // SELECTED MACHINE FLOW, SPLINE, SENSOR & HSC ENCODER BUILDER
  // =========================================================================
  const pathTemplate = component.transportPaths[0] ?? null;
  const primaryNode =
    Object.values(transportGraph.nodes).find(
      (n) => n.instanceId === instance.id
    ) ?? null;

  const incomingEdges = primaryNode
    ? transportGraph.edges.filter((e) => e.toPathNodeId === primaryNode.id)
    : [];
  const outgoingEdges = primaryNode
    ? transportGraph.edges.filter((e) => e.fromPathNodeId === primaryNode.id)
    : [];

  const instanceSpawner =
    transportGraph.spawners.find((sp) => sp.instanceId === instance.id) ?? null;
  const instanceSink =
    transportGraph.sinks.find((sk) => sk.instanceId === instance.id) ?? null;
  const endpointRole: 'none' | 'spawner' | 'sink' = instanceSpawner
    ? 'spawner'
    : instanceSink
      ? 'sink'
      : 'none';

  const instanceSensors = transportGraph.sensors.filter(
    (s) => s.instanceId === instance.id
  );
  const instanceEncoders = transportGraph.encoders.filter(
    (enc) => enc.targetInstanceId === instance.id
  );

  const hasMotionSourceForEncoder =
    Boolean(primaryNode) ||
    Object.values(component.nodeRoles).some(
      (r) => r.role === 'LinearAxis' || r.role === 'RotaryAxis'
    );

  const handleToggleDrawSpline = () => {
    if (isDrawingSplinePath) {
      setIsDrawingSplinePath(false);
    } else {
      if (!pathTemplate) {
        ensureComponentSplinePath(instance.id, 'draw-blank');
      }
      setIsDrawingSplinePath(true);
    }
  };

  const updateWaypointAxis = (
    wpIdx: number,
    axisIdx: 0 | 1 | 2,
    rawVal: string
  ) => {
    if (!pathTemplate) return;
    const parsed = Number(rawVal);
    if (Number.isNaN(parsed)) return;
    const current = pathTemplate.waypoints[wpIdx];
    if (!current) return;
    const nextTuple: Vector3Tuple = [...current] as Vector3Tuple;
    nextTuple[axisIdx] = parsed;
    updateSplineWaypointLocal(instance.id, wpIdx, nextTuple);
  };

  const updatePartDimAxis = (axisIdx: 0 | 1 | 2, rawVal: string) => {
    if (!instanceSpawner) return;
    const parsed = Number(rawVal);
    if (Number.isNaN(parsed)) return;
    const nextDims: Vector3Tuple = [
      ...instanceSpawner.partDimensionsMm,
    ] as Vector3Tuple;
    nextDims[axisIdx] = Math.max(40, Math.min(1500, Math.round(parsed)));
    updateInstanceSpawner(instance.id, { partDimensionsMm: nextDims });
  };

  const renderEncoderCard = (enc: VirtualEncoderConfig) => {
    const eLive = live.encoders[enc.id];
    const pulses = eLive?.pulsesDint ?? 0;
    const posVal = eLive?.servoPositionReal ?? 0;
    const velVal = eLive?.velocityReal ?? 0;
    const isRotary = enc.sourceKind === 'rotary-axis';
    const posUnit = isRotary ? '°' : 'mm';
    const velUnit = isRotary ? 'deg/s' : 'mm/s';

    const pulseBind = bindingBySigKey.get(
      `${instance.id}::${makeEncoderPulsesKey(enc.id)}`
    );
    const posBind = bindingBySigKey.get(
      `${instance.id}::${makeEncoderPosKey(enc.id)}`
    );

    return (
      <div key={enc.id} className="vc-encoder-card">
        <div className="vc-port-editor-top">
          <Cpu size={12} className="vc-amber-text" />
          <input
            id={`enc-name-${enc.id}`}
            type="text"
            value={enc.name}
            onChange={(e) =>
              updateInstanceVirtualEncoder(enc.id, { name: e.target.value })
            }
            className="vc-port-name-input"
            aria-label="Virtual Encoder Name"
          />
          <span className="vc-role-chip">
            {enc.sourceKind === 'transport-path'
              ? 'BELT HSC'
              : enc.sourceKind === 'linear-axis'
                ? 'LINEAR'
                : 'ROTARY'}
          </span>
          <button
            id={`del-enc-${enc.id}`}
            type="button"
            className="vc-tree-icon-btn vc-danger-hover"
            onClick={() => deleteInstanceVirtualEncoder(enc.id)}
            title="Remove Virtual Encoder"
          >
            <Trash2 size={12} />
          </button>
        </div>

        {/* Live DINT32 Pulse & REAL Servo Position Readouts */}
        <div className="vc-hsc-telemetry-grid">
          <div className="vc-hsc-cell">
            <div className="vc-hsc-cell-head">
              <span className="vc-dtype-pill dint">DINT</span>
              <span className="vc-mono-text vc-plc-addr-tag">
                {pulseBind?.plcAddress ?? 'ID—'}
              </span>
            </div>
            <div className="vc-hsc-label">Encoder Pulse</div>
            <div className="vc-hsc-val vc-mono-text">
              {pulses.toLocaleString()} <small>pulse</small>
            </div>
          </div>

          <div className="vc-hsc-cell">
            <div className="vc-hsc-cell-head">
              <span className="vc-dtype-pill real">REAL</span>
              <span className="vc-mono-text vc-plc-addr-tag">
                {posBind?.plcAddress ?? 'ID—'}
              </span>
            </div>
            <div className="vc-hsc-label">Servo Position</div>
            <div className="vc-hsc-val vc-mono-text">
              {posVal.toFixed(2)} <small>{posUnit}</small>
            </div>
          </div>
        </div>

        <div className="vc-hsc-vel-bar vc-mono-text">
          <span>Actual Velocity (REAL):</span>
          <span>
            {velVal.toFixed(1)} {velUnit}
          </span>
        </div>

        {/* Encoder Resolution Parameters */}
        <div className="vc-two-col-grid">
          <label className="vc-axis-input-wrap" title="Pulses Per Revolution (PPR)">
            <span className="vc-axis-badge">PPR</span>
            <input
              id={`enc-ppr-${enc.id}`}
              type="number"
              min={1}
              step={128}
              value={enc.pulsesPerRevolution}
              onChange={(e) =>
                updateInstanceVirtualEncoder(enc.id, {
                  pulsesPerRevolution: Math.max(
                    1,
                    Math.round(Number(e.target.value) || 1024)
                  ),
                })
              }
            />
          </label>

          <label
            className="vc-axis-input-wrap"
            title={`Travel per shaft revolution (${posUnit}/rev)`}
          >
            <span className="vc-axis-badge">{posUnit}/rev</span>
            <input
              id={`enc-travel-${enc.id}`}
              type="number"
              min={0.1}
              step={1}
              value={enc.travelMmPerRevolution}
              onChange={(e) =>
                updateInstanceVirtualEncoder(enc.id, {
                  travelMmPerRevolution: Math.max(
                    0.1,
                    Number(e.target.value) || 10
                  ),
                })
              }
            />
          </label>
        </div>

        <div className="vc-field-row">
          <span>Rollover Modulo (DINT)</span>
          <input
            id={`enc-mod-${enc.id}`}
            type="number"
            min={1000}
            step={10000}
            value={enc.rolloverModulo}
            onChange={(e) =>
              updateInstanceVirtualEncoder(enc.id, {
                rolloverModulo: Math.max(
                  1000,
                  Math.round(Number(e.target.value) || 1_000_000)
                ),
              })
            }
            className="vc-small-num-input vc-wide-num-input"
          />
        </div>
      </div>
    );
  };

  return (
    <div className="vc-flow-stack">
      {/* Live Simulation Strip */}
      <div className="vc-inspector-card">
        <div className="vc-section-header-row">
          <span className="vc-section-label">
            <Boxes size={12} className="vc-cyan-text" />
            <span>MATERIAL FLOW STATUS</span>
          </span>

          <div className="vc-inline-btns">
            {primaryNode && (
              <button
                id="btn-spawn-one-now"
                type="button"
                className="vc-port-add-btn vc-cyan"
                onClick={() => triggerManualSpawnNow(instance.id)}
                title="Drop 1 test workpiece onto this machine's spline path"
              >
                <Plus size={10} /> Drop Box
              </button>
            )}
            <button
              id="btn-clear-parts-selected"
              type="button"
              className="vc-port-add-btn"
              onClick={clearAllActiveFlowItems}
              title="Clear all active workpieces in scene"
            >
              Clear ({live.activeParts})
            </button>
          </div>
        </div>

        <div className="vc-flow-kpi-grid">
          <div className="vc-flow-kpi-box">
            <span className="vc-flow-kpi-label">IN SCENE</span>
            <strong className="vc-mono-text vc-cyan-text">
              {live.activeParts} pcs
            </strong>
          </div>
          <div className="vc-flow-kpi-box">
            <span className="vc-flow-kpi-label">ACCUMULATED</span>
            <strong className="vc-mono-text vc-amber-text">
              {live.queuedParts} pcs
            </strong>
          </div>
          <div className="vc-flow-kpi-box">
            <span className="vc-flow-kpi-label">PATH LENGTH</span>
            <strong className="vc-mono-text">
              {primaryNode ? `${Math.round(primaryNode.arcLengthMm)} mm` : '—'}
            </strong>
          </div>
        </div>
      </div>

      {/* SECTION 1: SPLINE TRANSPORT PATH EDITOR */}
      <div className="vc-inspector-card">
        <div className="vc-section-header-row">
          <span className="vc-section-label">
            <Route size={12} className="vc-cyan-text" />
            <span>1. SPLINE TRANSPORT PATH</span>
          </span>

          <div className="vc-inline-btns">
            <button
              id="btn-draw-spline-3d"
              type="button"
              className={`vc-port-add-btn ${
                isDrawingSplinePath ? 'vc-amber' : 'vc-cyan'
              }`}
              onClick={handleToggleDrawSpline}
              title="Click directly on the 3D conveyor surface to place spline waypoints"
            >
              <Crosshair size={10} />
              <span>{isDrawingSplinePath ? 'Done Draw' : 'Draw 3D'}</span>
            </button>
            <button
              id="btn-auto-centerline"
              type="button"
              className="vc-port-add-btn"
              onClick={() =>
                ensureComponentSplinePath(instance.id, 'auto-centerline')
              }
              title="Auto-generate straight centerline from InputPort to OutputPort"
            >
              <Wand2 size={10} />
              <span>Auto In→Out</span>
            </button>
          </div>
        </div>

        {isDrawingSplinePath && (
          <div className="vc-draw-banner-inline">
            Click along the 3D belt surface in the Viewport to append waypoints.
            Press <strong>Esc</strong> or <strong>Done Draw</strong> when finished.
          </div>
        )}

        {!pathTemplate ? (
          <div className="vc-subtle-note">
            No transport spline on this component yet. Click{' '}
            <strong>Auto In→Out</strong> or <strong>Draw 3D</strong> to turn any
            imported <code>.glb</code> / <code>OpenUSD</code> model into an active
            conveyor!
          </div>
        ) : (
          <div className="vc-joint-form">
            <div className="vc-field-row">
              <span>Curve Mode</span>
              <select
                id="select-spline-interpolation"
                value={pathTemplate.interpolation}
                onChange={(e) =>
                  updateComponentPathSettings(instance.id, {
                    interpolation: e.target.value as 'catmull-rom' | 'polyline',
                  })
                }
                className="vc-compact-select"
              >
                <option value="catmull-rom">Catmull-Rom Smooth Spline</option>
                <option value="polyline">Linear Polyline</option>
              </select>
            </div>

            <div className="vc-spline-tools-row">
              <button
                id="btn-spline-add-mid"
                type="button"
                className="vc-yaw-chip"
                onClick={() => insertSplineMidpoint(instance.id)}
                title="Insert midpoint for curved conveyor shaping"
              >
                + Midpoint
              </button>
              <button
                id="btn-spline-reverse"
                type="button"
                className="vc-yaw-chip"
                onClick={() => reverseSplinePath(instance.id)}
                title="Reverse flow direction"
              >
                <ArrowLeftRight size={10} /> Reverse
              </button>
              <button
                id="btn-spline-clear"
                type="button"
                className="vc-yaw-chip vc-danger-hover"
                onClick={() => clearSplinePath(instance.id)}
                title="Remove spline path from this machine"
              >
                Clear Path
              </button>
            </div>

            {/* Upstream / Downstream Routing Graph Handoffs */}
            {(incomingEdges.length > 0 || outgoingEdges.length > 0) && (
              <div className="vc-routing-badges">
                {incomingEdges.map((edge) => (
                  <span key={edge.id} className="vc-route-pill in">
                    <GitBranch size={10} /> In ←{' '}
                    {instanceNameById.get(edge.fromInstanceId) ??
                      edge.fromInstanceId}
                  </span>
                ))}
                {outgoingEdges.map((edge) => (
                  <span key={edge.id} className="vc-route-pill out">
                    <GitBranch size={10} /> Out →{' '}
                    {instanceNameById.get(edge.toInstanceId) ?? edge.toInstanceId}
                  </span>
                ))}
              </div>
            )}

            {/* Local Waypoints Editor */}
            <div className="vc-waypoint-list">
              {pathTemplate.waypoints.map((wp, idx) => (
                <div key={idx} className="vc-waypoint-row">
                  <span className="vc-wp-index vc-mono-text">P{idx + 1}</span>
                  <div className="vc-vec3-grid vc-wp-grid">
                    {(['X', 'Y', 'Z'] as const).map((ax, aIdx) => (
                      <label key={ax} className="vc-axis-input-wrap">
                        <span
                          className={`vc-axis-badge axis-${ax.toLowerCase()}`}
                        >
                          {ax}
                        </span>
                        <input
                          type="number"
                          step={0.05}
                          value={wp[aIdx]}
                          onChange={(e) =>
                            updateWaypointAxis(
                              idx,
                              aIdx as 0 | 1 | 2,
                              e.target.value
                            )
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="vc-tree-icon-btn vc-danger-hover"
                    onClick={() => removeSplineWaypoint(instance.id, idx)}
                    title="Delete Waypoint"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* SECTION 2: PART FEEDER (PartSource) / EXIT SINK (PartSink) */}
      {primaryNode && (
        <div className="vc-inspector-card">
          <div className="vc-section-label">
            <Sparkles size={12} className="vc-emerald-text" />
            <span>2. PART FEEDER / EXIT SINK</span>
          </div>

          <div
            className="vc-role-segmented vc-three-seg"
            role="group"
            aria-label="Conveyor Endpoint Flow Role"
          >
            <button
              id="btn-flow-role-none"
              type="button"
              className={`vc-role-seg-btn ${
                endpointRole === 'none' ? 'active' : ''
              }`}
              onClick={() => setInstanceFlowEndpointRole(instance.id, 'none')}
            >
              Pass-Through
            </button>
            <button
              id="btn-flow-role-spawner"
              type="button"
              className={`vc-role-seg-btn ${
                endpointRole === 'spawner' ? 'active role-RotaryAxis' : ''
              }`}
              onClick={() => setInstanceFlowEndpointRole(instance.id, 'spawner')}
            >
              Part Feeder
            </button>
            <button
              id="btn-flow-role-sink"
              type="button"
              className={`vc-role-seg-btn ${
                endpointRole === 'sink' ? 'active role-VisualEffect' : ''
              }`}
              onClick={() => setInstanceFlowEndpointRole(instance.id, 'sink')}
            >
              Part Sink
            </button>
          </div>

          {instanceSpawner && (
            <div className="vc-joint-form">
              <div className="vc-field-row">
                <span>Feed Mode</span>
                <select
                  id="select-spawner-mode"
                  value={instanceSpawner.mode}
                  onChange={(e) =>
                    updateInstanceSpawner(instance.id, {
                      mode: e.target.value as 'interval' | 'plc-trigger',
                    })
                  }
                  className="vc-compact-select"
                >
                  <option value="interval">Auto Interval Timer</option>
                  <option value="plc-trigger">PLC Trigger (DO_SpawnPart)</option>
                </select>
              </div>

              {instanceSpawner.mode === 'interval' && (
                <div className="vc-field-row">
                  <span>Spawn Cycle (sec)</span>
                  <input
                    id="input-spawner-interval"
                    type="number"
                    min={0.5}
                    max={30}
                    step={0.1}
                    value={instanceSpawner.intervalSec}
                    onChange={(e) =>
                      updateInstanceSpawner(instance.id, {
                        intervalSec: Math.max(0.4, Number(e.target.value) || 2.0),
                      })
                    }
                    className="vc-small-num-input"
                  />
                </div>
              )}

              <div className="vc-vec3-block">
                <span className="vc-vec3-title">
                  Workpiece Box Size L × W × H (mm)
                </span>
                <div className="vc-vec3-grid">
                  {(['L', 'W', 'H'] as const).map((lbl, idx) => (
                    <label key={lbl} className="vc-axis-input-wrap">
                      <span className="vc-axis-badge">{lbl}</span>
                      <input
                        type="number"
                        step={10}
                        min={50}
                        value={instanceSpawner.partDimensionsMm[idx]}
                        onChange={(e) =>
                          updatePartDimAxis(idx as 0 | 1 | 2, e.target.value)
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="vc-color-row">
                <span>Carton Color</span>
                <input
                  id="input-spawner-color"
                  type="color"
                  value={instanceSpawner.partColorHex}
                  onChange={(e) =>
                    updateInstanceSpawner(instance.id, {
                      partColorHex: e.target.value,
                    })
                  }
                />
              </div>

              <div className="vc-kv-row">
                <span>Spawned Count (DINT)</span>
                <strong className="vc-mono-text vc-cyan-text">
                  {(live.spawnerCounts[instanceSpawner.id] ?? 0).toLocaleString()}{' '}
                  pcs
                </strong>
              </div>
            </div>
          )}

          {instanceSink && (
            <div className="vc-joint-form">
              <div className="vc-kv-row">
                <span>Dispatched Count (DINT)</span>
                <strong className="vc-mono-text vc-emerald-text">
                  {(live.sinkCounts[instanceSink.id] ?? 0).toLocaleString()} pcs
                </strong>
              </div>
              <div className="vc-subtle-note">
                Workpieces reaching the end of this conveyor despawn cleanly and
                increment the 32-bit <code>DINT</code> PLC counter.
              </div>
            </div>
          )}
        </div>
      )}

      {/* SECTION 3: DETERMINISTIC PATH SENSORS */}
      {primaryNode && (
        <div className="vc-inspector-card">
          <div className="vc-section-header-row">
            <span className="vc-section-label">
              <Radio size={12} className="vc-emerald-text" />
              <span>3. PATH SENSORS ({instanceSensors.length})</span>
            </span>

            <div className="vc-inline-btns">
              <button
                id="btn-add-pe-sensor"
                type="button"
                className="vc-port-add-btn vc-emerald-btn"
                onClick={() =>
                  addInstancePathSensor(instance.id, 'photoelectric')
                }
                title="Mount Photoelectric Through-Beam Laser Sensor"
              >
                <Plus size={10} /> PE Beam
              </button>
              <button
                id="btn-add-px-sensor"
                type="button"
                className="vc-port-add-btn vc-amber"
                onClick={() => addInstancePathSensor(instance.id, 'proximity')}
                title="Mount Inductive/Capacitive Proximity Sensor"
              >
                <Plus size={10} /> Prox
              </button>
            </div>
          </div>

          {instanceSensors.length === 0 ? (
            <div className="vc-subtle-note">
              No path sensors mounted on this conveyor. Click{' '}
              <strong>+ PE Beam</strong> or <strong>+ Prox</strong> to mount a
              live <code>SIM → PLC</code> sensor along the spline.
            </div>
          ) : (
            <div className="vc-ports-editor-list">
              {instanceSensors.map((sensor) => {
                const active = Boolean(live.sensorTriggered[sensor.id]);
                const maxOffset = Math.max(50, Math.round(primaryNode.arcLengthMm));
                const sigBind = bindingBySigKey.get(
                  `${instance.id}::${makeSensorSignalKey(sensor.id)}`
                );

                return (
                  <div key={sensor.id} className="vc-port-editor-item">
                    <div className="vc-port-editor-top">
                      <span
                        className={`vc-port-role-pill ${
                          sensor.sensorType === 'photoelectric' ? 'in' : 'out'
                        }`}
                      >
                        {sensor.sensorType === 'photoelectric' ? 'PE' : 'PROX'}
                      </span>
                      <input
                        id={`sensor-name-${sensor.id}`}
                        type="text"
                        value={sensor.name}
                        onChange={(e) =>
                          updateInstancePathSensor(sensor.id, {
                            name: e.target.value,
                          })
                        }
                        className="vc-port-name-input"
                      />
                      <div className={`vc-sensor-pill ${active ? 'high' : 'low'}`}>
                        <span
                          className={`vc-led-dot ${
                            active ? 'vc-led-ok' : 'vc-led-off'
                          }`}
                        />
                        <span className="vc-mono-text">
                          {sigBind?.plcAddress ?? 'DI'}
                        </span>
                      </div>
                      <button
                        id={`del-sensor-${sensor.id}`}
                        type="button"
                        className="vc-tree-icon-btn vc-danger-hover"
                        onClick={() => deleteInstancePathSensor(sensor.id)}
                        title="Remove Sensor"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>

                    <div className="vc-jog-controls">
                      <input
                        type="range"
                        min={0}
                        max={maxOffset}
                        step={10}
                        value={Math.min(maxOffset, Math.max(0, sensor.offsetMm))}
                        onChange={(e) =>
                          updateInstancePathSensor(sensor.id, {
                            offsetMm: Number(e.target.value),
                          })
                        }
                        className="vc-range-slider"
                      />
                      <span className="vc-mono-text vc-micro-hint">
                        {Math.round(sensor.offsetMm)} / {maxOffset} mm
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* SECTION 4: VIRTUAL HSC ENCODER (DINT32) & SERVO POSITION (REAL) */}
      <div className="vc-inspector-card">
        <div className="vc-section-header-row">
          <span className="vc-section-label">
            <Gauge size={12} className="vc-amber-text" />
            <span>
              4. HSC ENCODER & SERVO POS ({instanceEncoders.length})
            </span>
          </span>

          {hasMotionSourceForEncoder && (
            <button
              id="btn-add-virtual-encoder"
              type="button"
              className="vc-port-add-btn vc-amber"
              onClick={() => addInstanceVirtualEncoder(instance.id)}
              title="Attach Virtual High-Speed Counter (DINT) & Servo Position (REAL) Register"
            >
              <Plus size={10} /> Encoder
            </button>
          )}
        </div>

        {instanceEncoders.length === 0 ? (
          <div className="vc-subtle-note">
            {hasMotionSourceForEncoder
              ? 'Click + Encoder to generate cumulative 32-bit DINT HSC Pulses and REAL Servo Position registers.'
              : 'Configure a Spline Path or Linear/Rotary Axis on this machine first to attach an Encoder.'}
          </div>
        ) : (
          <div className="vc-encoder-list">
            {instanceEncoders.map(renderEncoderCard)}
          </div>
        )}
      </div>
    </div>
  );
}
