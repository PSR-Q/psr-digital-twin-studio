import {
  Activity,
  Play,
  Power,
  Radio,
  RotateCcw,
  SlidersHorizontal,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { runtimeBusClient } from '../../engine/runtimeBusClient';
import { collectInstanceAllSignals } from '../../engine/signalCatalogSync';
import type {
  ComponentDefinition,
  ComponentSignalDescriptor,
  PlcTagBinding,
  UUID,
} from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';

interface MachineSignalGroup {
  instanceId: UUID;
  instanceName: string;
  componentName: string;
  commands: Array<{
    binding: PlcTagBinding;
    descriptor?: ComponentSignalDescriptor;
  }>;
  feedbacks: Array<{
    binding: PlcTagBinding;
    descriptor?: ComponentSignalDescriptor;
  }>;
}

export function SignalForcePanel() {
  const [scope, setScope] = useState<'selected' | 'all'>('selected');
  const [liveValues, setLiveValues] = useState<Record<string, boolean | number>>({});

  const selectedInstanceId = useEditorStore((s) => s.selectedInstanceId);
  const instances = useEditorStore((s) => s.scene.instances);
  const library = useEditorStore((s) => s.scene.componentLibrary);
  const transportGraph = useEditorStore((s) => s.scene.transportGraph);
  const bindings = useEditorStore((s) => s.scene.plcTagMap.bindings);
  const runState = useEditorStore((s) => s.runState);

  const selectInstance = useEditorStore((s) => s.selectInstance);
  const setRunState = useEditorStore((s) => s.setRunState);
  const setSignalForce = useEditorStore((s) => s.setSignalForce);
  const clearAllForces = useEditorStore((s) => s.clearAllForces);

  const effectiveScope = selectedInstanceId ? scope : 'all';

  // Poll BinaryIpcBufferView at 10Hz ONLY while Force Panel is open — zero impact on 3D FPS
  useEffect(() => {
    const sampleLiveBus = () => {
      const snapshot: Record<string, boolean | number> = {};
      const currentBindings = useEditorStore.getState().scene.plcTagMap.bindings;
      for (let i = 0; i < currentBindings.length; i++) {
        const b = currentBindings[i];
        snapshot[b.id] = runtimeBusClient.readBindingLiveValue(b);
      }
      setLiveValues(snapshot);
    };

    sampleLiveBus();
    const timer = window.setInterval(sampleLiveBus, 100);
    return () => window.clearInterval(timer);
  }, []);

  const forcedCount = useMemo(
    () => bindings.filter((b) => b.manualForceEnabled).length,
    [bindings]
  );

  const groups = useMemo<MachineSignalGroup[]>(() => {
    const compMap = new Map<UUID, ComponentDefinition>(
      library.map((c) => [c.id, c])
    );
    const targetInstances =
      effectiveScope === 'selected' && selectedInstanceId
        ? instances.filter((i) => i.id === selectedInstanceId)
        : instances;

    const result: MachineSignalGroup[] = [];
    for (const inst of targetInstances) {
      const comp = compMap.get(inst.componentId);
      if (!comp) continue;

      const allSignals = collectInstanceAllSignals(
        inst.id,
        comp,
        transportGraph
      );
      const descByKey = new Map(allSignals.map((s) => [s.key, s]));
      const instBindings = bindings.filter((b) => b.instanceId === inst.id);
      if (instBindings.length === 0) continue;

      const commands: MachineSignalGroup['commands'] = [];
      const feedbacks: MachineSignalGroup['feedbacks'] = [];

      for (const binding of instBindings) {
        const descriptor = descByKey.get(binding.componentSignalKey);
        if (binding.direction === 'PLC_TO_SIM') {
          commands.push({ binding, descriptor });
        } else {
          feedbacks.push({ binding, descriptor });
        }
      }

      result.push({
        instanceId: inst.id,
        instanceName: inst.name,
        componentName: comp.name,
        commands,
        feedbacks,
      });
    }

    return result;
  }, [
    bindings,
    effectiveScope,
    instances,
    library,
    selectedInstanceId,
    transportGraph,
  ]);

  const shortSignalLabel = (
    binding: PlcTagBinding,
    descriptor?: ComponentSignalDescriptor
  ): string => {
    if (descriptor?.label) return descriptor.label;
    const parts = binding.signalName.split(' · ');
    return parts.length > 1 ? parts.slice(1).join(' · ') : binding.signalName;
  };

  return (
    <div className="vc-force-stack">
      {/* Top Commissioning Control Strip */}
      <div className="vc-inspector-card vc-force-header-card">
        <div className="vc-section-header-row">
          <span className="vc-section-label">
            <Zap size={12} className="vc-amber-text" />
            <span>SIGNAL FORCE CONSOLE</span>
          </span>
          {forcedCount > 0 && (
            <button
              id="btn-clear-all-forces"
              type="button"
              className="vc-unforce-all-btn"
              onClick={clearAllForces}
              title="Release all forced PLC_TO_SIM signals"
            >
              Unforce ({forcedCount})
            </button>
          )}
        </div>

        <div className="vc-force-toolbar-row">
          <div className="vc-segmented-group">
            {selectedInstanceId && (
              <button
                id="btn-force-scope-selected"
                type="button"
                className={`vc-seg-btn ${
                  effectiveScope === 'selected' ? 'active' : ''
                }`}
                onClick={() => setScope('selected')}
              >
                Selected
              </button>
            )}
            <button
              id="btn-force-scope-all"
              type="button"
              className={`vc-seg-btn ${effectiveScope === 'all' ? 'active' : ''}`}
              onClick={() => setScope('all')}
            >
              All Scene ({instances.length})
            </button>
          </div>

          <div className="vc-inline-btns">
            {runState !== 'RUNNING' ? (
              <button
                id="btn-force-panel-play"
                type="button"
                className="vc-port-add-btn vc-emerald-btn"
                onClick={() => setRunState('RUNNING')}
                title="Start simulation loop"
              >
                <Play size={11} />
                <span>Run</span>
              </button>
            ) : (
              <button
                id="btn-force-panel-reset"
                type="button"
                className="vc-port-add-btn"
                onClick={() => setRunState('STOPPED')}
                title="Stop & reset actuators to Home"
              >
                <RotateCcw size={11} />
                <span>Home</span>
              </button>
            )}
          </div>
        </div>

        <div className="vc-micro-hint" style={{ marginTop: 6 }}>
          Force signals immediately drive 3D actuators without opening an external PLC.
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="vc-inspector-card">
          <div className="vc-subtle-note">
            No controllable I/O signals found in this scope. Select a machine and
            assign a <strong>LinearAxis</strong> or <strong>RotaryAxis</strong> in the{' '}
            <strong>Builder</strong> tab.
          </div>
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.instanceId} className="vc-inspector-card vc-machine-io-card">
            <div className="vc-machine-io-header">
              <button
                type="button"
                className="vc-machine-focus-btn"
                onClick={() => selectInstance(group.instanceId)}
                title="Select this machine in 3D Viewport"
              >
                <span className="vc-machine-focus-name">{group.instanceName}</span>
                <span className="vc-machine-focus-sub">{group.componentName}</span>
              </button>
            </div>

            {/* PLC -> SIM Actuator Commands */}
            {group.commands.length > 0 && (
              <div className="vc-io-group-section">
                <div className="vc-io-subhead">
                  <SlidersHorizontal size={11} />
                  <span>PLC → SIM COMMANDS (FORCE)</span>
                </div>

                <div className="vc-io-rows">
                  {group.commands.map(({ binding, descriptor }) => {
                    const liveVal = liveValues[binding.id];
                    const isForced = binding.manualForceEnabled;
                    const label = shortSignalLabel(binding, descriptor);

                    if (binding.dataType === 'BOOL') {
                      const boolActive = Boolean(
                        isForced ? binding.manualForceValue : liveVal
                      );
                      return (
                        <div
                          key={binding.id}
                          className={`vc-force-bool-row ${isForced ? 'forced' : ''}`}
                        >
                          <div className="vc-force-sig-meta">
                            <span className="vc-force-sig-label" title={label}>
                              {label}
                            </span>
                            <span className="vc-mono-text vc-plc-addr-tag">
                              {binding.plcAddress}
                            </span>
                          </div>

                          <div className="vc-force-bool-controls">
                            {/* Latching Force ON/OFF Switch */}
                            <button
                              id={`btn-force-toggle-${binding.id}`}
                              type="button"
                              className={`vc-force-latch-btn ${
                                boolActive ? 'on' : 'off'
                              }`}
                              onClick={() =>
                                setSignalForce(binding.id, true, !boolActive)
                              }
                              title="Toggle latched Force TRUE / FALSE"
                            >
                              <Power size={10} />
                              <span>{boolActive ? 'ON' : 'OFF'}</span>
                            </button>

                            {/* Momentary Push-to-Actuate Jog Button */}
                            <button
                              id={`btn-force-jog-${binding.id}`}
                              type="button"
                              className="vc-force-jog-btn"
                              onPointerDown={(e) => {
                                e.currentTarget.setPointerCapture(e.pointerId);
                                setSignalForce(binding.id, true, true);
                              }}
                              onPointerUp={() =>
                                setSignalForce(binding.id, false, false, false)
                              }
                              onPointerCancel={() =>
                                setSignalForce(binding.id, false, false, false)
                              }
                              title="Hold to momentarily energize (Jog), release to turn OFF"
                            >
                              JOG
                            </button>

                            {isForced && (
                              <button
                                type="button"
                                className="vc-unforce-mini"
                                onClick={() =>
                                  setSignalForce(binding.id, false, false, false)
                                }
                                title="Release manual force"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    }

                    // Numeric Analog Setpoint (FLOAT32 / INT16 / DINT32)
                    const minVal = descriptor?.minVal ?? -200;
                    const maxVal = descriptor?.maxVal ?? 200;
                    const numVal = Number(
                      isForced
                        ? binding.manualForceValue
                        : (liveVal ?? descriptor?.defaultVal ?? 0)
                    );
                    const stepSize =
                      Math.abs(maxVal - minVal) <= 20 ? 0.5 : 1;

                    return (
                      <div
                        key={binding.id}
                        className={`vc-force-analog-row ${isForced ? 'forced' : ''}`}
                      >
                        <div className="vc-force-analog-top">
                          <div className="vc-force-sig-meta">
                            <span className="vc-force-sig-label" title={label}>
                              {label}
                            </span>
                            <span className="vc-mono-text vc-plc-addr-tag">
                              {binding.plcAddress}
                            </span>
                          </div>

                          <div className="vc-force-analog-num-wrap">
                            <input
                              id={`input-force-num-${binding.id}`}
                              type="number"
                              step={stepSize}
                              min={minVal}
                              max={maxVal}
                              value={Number(numVal.toFixed(1))}
                              onChange={(e) => {
                                const parsed = Number(e.target.value);
                                if (!Number.isNaN(parsed)) {
                                  setSignalForce(binding.id, true, parsed);
                                }
                              }}
                              className="vc-analog-num-box"
                            />
                            {descriptor?.unit && (
                              <span className="vc-micro-unit">{descriptor.unit}</span>
                            )}
                            {isForced && (
                              <button
                                type="button"
                                className="vc-unforce-mini"
                                onClick={() =>
                                  setSignalForce(
                                    binding.id,
                                    false,
                                    descriptor?.defaultVal ?? 0,
                                    false
                                  )
                                }
                                title="Reset to default setpoint"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </div>

                        <input
                          id={`slider-force-analog-${binding.id}`}
                          type="range"
                          min={minVal}
                          max={maxVal}
                          step={stepSize}
                          value={Math.min(maxVal, Math.max(minVal, numVal))}
                          onChange={(e) =>
                            setSignalForce(binding.id, true, Number(e.target.value))
                          }
                          className="vc-range-slider"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* SIM -> PLC Live Sensor & Servo Feedback */}
            {group.feedbacks.length > 0 && (
              <div className="vc-io-group-section vc-io-feedback-section">
                <div className="vc-io-subhead">
                  <Radio size={11} className="vc-emerald-text" />
                  <span>SIM → PLC FEEDBACK (LIVE SENSORS)</span>
                </div>

                <div className="vc-io-rows">
                  {group.feedbacks.map(({ binding, descriptor }) => {
                    const val = liveValues[binding.id];
                    const label = shortSignalLabel(binding, descriptor);

                    if (binding.dataType === 'BOOL') {
                      const active = Boolean(val);
                      return (
                        <div key={binding.id} className="vc-feedback-row">
                          <div className="vc-force-sig-meta">
                            <span className="vc-force-sig-label" title={label}>
                              {label}
                            </span>
                            <span className="vc-mono-text vc-plc-addr-tag">
                              {binding.plcAddress}
                            </span>
                          </div>

                          <div
                            className={`vc-sensor-pill ${active ? 'high' : 'low'}`}
                          >
                            <span
                              className={`vc-led-dot ${
                                active ? 'vc-led-ok' : 'vc-led-off'
                              }`}
                            />
                            <span className="vc-mono-text">
                              {active ? 'TRUE' : 'FALSE'}
                            </span>
                          </div>
                        </div>
                      );
                    }

                    const numFeedback = Number(val ?? 0);
                    const isIntType =
                      binding.dataType === 'DINT32' ||
                      binding.dataType === 'INT16';
                    const formattedNum = isIntType
                      ? Math.round(numFeedback).toLocaleString()
                      : numFeedback.toFixed(1);

                    return (
                      <div key={binding.id} className="vc-feedback-row">
                        <div className="vc-force-sig-meta">
                          <span className="vc-force-sig-label" title={label}>
                            {label}
                          </span>
                          <span className="vc-mono-text vc-plc-addr-tag">
                            {binding.plcAddress}
                          </span>
                        </div>

                        <div className="vc-feedback-num-readout vc-mono-text">
                          <span
                            className={`vc-dtype-pill ${
                              isIntType ? 'dint' : 'real'
                            }`}
                          >
                            {binding.dataType === 'DINT32'
                              ? 'DINT'
                              : binding.dataType === 'INT16'
                                ? 'INT'
                                : 'REAL'}
                          </span>
                          <Activity size={11} className="vc-cyan-text" />
                          <span>
                            {formattedNum}
                            {descriptor?.unit ? ` ${descriptor.unit}` : ''}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
