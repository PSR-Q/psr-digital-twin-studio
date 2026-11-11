import {
  ArrowRight,
  Cpu,
  Crosshair,
  Layers,
  Magnet,
  RotateCcw,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { loadComponentGlbAsset } from '../../engine/glbAssetRegistry';
import type {
  ComponentDefinition,
  LinearAxisRole,
  RotaryAxisRole,
  SceneNodeInstance,
  SubMeshRoleAssignment,
  VacuumGripperRole,
  Vector3Tuple,
  VisualEffectRole,
} from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';

interface ComponentBuilderPanelProps {
  instance: SceneNodeInstance;
  component: ComponentDefinition;
}

const AXIS_PRESETS: Array<{ label: string; vec: Vector3Tuple }> = [
  { label: '+X', vec: [1, 0, 0] },
  { label: '-X', vec: [-1, 0, 0] },
  { label: '+Y', vec: [0, 1, 0] },
  { label: '-Y', vec: [0, -1, 0] },
  { label: '+Z', vec: [0, 0, 1] },
  { label: '-Z', vec: [0, 0, -1] },
];

function isSameVec(a: Vector3Tuple, b: Vector3Tuple): boolean {
  return (
    Math.abs(a[0] - b[0]) < 1e-3 &&
    Math.abs(a[1] - b[1]) < 1e-3 &&
    Math.abs(a[2] - b[2]) < 1e-3
  );
}

function shortRoleBadge(role: SubMeshRoleAssignment['role']): string {
  if (role === 'LinearAxis') return 'Linear';
  if (role === 'RotaryAxis') return 'Rotary';
  if (role === 'VacuumGripper') return 'Gripper';
  if (role === 'VisualEffect') return 'Effect';
  return 'Static';
}

export function ComponentBuilderPanel({
  instance,
  component,
}: ComponentBuilderPanelProps) {
  const [discoveredNames, setDiscoveredNames] = useState<string[]>([]);

  const selectedSubMeshName = useEditorStore((s) => s.selectedSubMeshName);
  const jogPreview = useEditorStore((s) => s.jogPreview);
  const selectSubMesh = useEditorStore((s) => s.selectSubMesh);
  const setSubMeshRole = useEditorStore((s) => s.setSubMeshRole);
  const setJogPreview = useEditorStore((s) => s.setJogPreview);
  const setInspectorTab = useEditorStore((s) => s.setInspectorTab);

  // Discover any sub-mesh names from the parsed 3D model in case a custom or legacy file omitted any
  useEffect(() => {
    let cancelled = false;
    loadComponentGlbAsset(component)
      .then((asset) => {
        if (!cancelled) {
          setDiscoveredNames(asset.subMeshNames);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [component]);

  const allNodeNames = useMemo(() => {
    const merged = new Set<string>(Object.keys(component.nodeRoles));
    for (const n of discoveredNames) merged.add(n);
    return Array.from(merged);
  }, [component.nodeRoles, discoveredNames]);

  const activeNodeName =
    selectedSubMeshName && allNodeNames.includes(selectedSubMeshName)
      ? selectedSubMeshName
      : (allNodeNames[0] ?? null);

  const activeAssignment: SubMeshRoleAssignment | null = useMemo(() => {
    if (!activeNodeName) return null;
    return (
      component.nodeRoles[activeNodeName] ?? {
        role: 'StaticMesh',
        nodeName: activeNodeName,
      }
    );
  }, [activeNodeName, component.nodeRoles]);

  const nodeSignals = useMemo(() => {
    if (!activeNodeName) return [];
    return component.exposedSignals.filter((s) => s.nodeName === activeNodeName);
  }, [activeNodeName, component.exposedSignals]);

  const handleSwitchRoleType = (targetRole: SubMeshRoleAssignment['role']) => {
    if (!activeNodeName || !activeAssignment) return;
    if (activeAssignment.role === targetRole) return;

    if (targetRole === 'StaticMesh') {
      setSubMeshRole(component.id, activeNodeName, {
        role: 'StaticMesh',
        nodeName: activeNodeName,
      });
      return;
    }

    if (targetRole === 'LinearAxis') {
      const nextLinear: LinearAxisRole = {
        role: 'LinearAxis',
        nodeName: activeNodeName,
        axis: [0, 1, 0],
        minLimitMm: 0,
        maxLimitMm: 120,
        initialPosMm: 0,
        behavior: {
          presetType: 'PneumaticCylinder',
          actingMode: 'single-acting',
          extendSpeedMmPerSec: 220,
          retractSpeedMmPerSec: 250,
          emitReedSwitches: true,
        },
      };
      setSubMeshRole(component.id, activeNodeName, nextLinear);
      return;
    }

    if (targetRole === 'RotaryAxis') {
      const likelyContinuous = /impeller|agitator|motor|roller|fan|spindle/i.test(
        activeNodeName
      );
      const nextRotary: RotaryAxisRole = {
        role: 'RotaryAxis',
        nodeName: activeNodeName,
        axis: [0, 1, 0],
        mode: likelyContinuous ? 'continuous' : 'bounded',
        minDeg: likelyContinuous ? 0 : -90,
        maxDeg: likelyContinuous ? 360 : 90,
        defaultRpm: likelyContinuous ? 60 : 20,
      };
      setSubMeshRole(component.id, activeNodeName, nextRotary);
      return;
    }

    if (targetRole === 'VacuumGripper') {
      const verticalAxisParent = Object.values(component.nodeRoles).find(
        (r) =>
          r.nodeName !== activeNodeName &&
          r.role === 'LinearAxis' &&
          Math.abs(r.axis[1]) > 0.7
      );
      const fallbackAxisParent = Object.values(component.nodeRoles).find(
        (r) => r.nodeName !== activeNodeName && r.role === 'LinearAxis'
      );
      const nextGripper: VacuumGripperRole = {
        role: 'VacuumGripper',
        nodeName: activeNodeName,
        parentNodeName:
          verticalAxisParent?.nodeName ?? fallbackAxisParent?.nodeName,
        grabRadiusMm: 180,
        grabHeightToleranceMm: 45,
        placeTargetPosMm: 800,
      };
      setSubMeshRole(component.id, activeNodeName, nextGripper);
      return;
    }

    if (targetRole === 'VisualEffect') {
      const likelyLamp = /lamp|led|beacon|light|indicator|reed/i.test(activeNodeName);
      const nextVfx: VisualEffectRole = {
        role: 'VisualEffect',
        nodeName: activeNodeName,
        effectType: likelyLamp ? 'emissive-lamp' : 'uv-scroll',
        uvScrollAxis: 'u',
        uvScrollScale: 1.0,
        nominalRpm: 60,
        emissiveOnHex: '#10b981',
        emissiveOffHex: '#334155',
      };
      setSubMeshRole(component.id, activeNodeName, nextVfx);
    }
  };

  const updateLinearPatch = (patch: Partial<LinearAxisRole>) => {
    if (!activeNodeName || activeAssignment?.role !== 'LinearAxis') return;
    setSubMeshRole(component.id, activeNodeName, {
      ...activeAssignment,
      ...patch,
    });
  };

  const updateRotaryPatch = (patch: Partial<RotaryAxisRole>) => {
    if (!activeNodeName || activeAssignment?.role !== 'RotaryAxis') return;
    setSubMeshRole(component.id, activeNodeName, {
      ...activeAssignment,
      ...patch,
    });
  };

  const updateGripperPatch = (patch: Partial<VacuumGripperRole>) => {
    if (!activeNodeName || activeAssignment?.role !== 'VacuumGripper') return;
    setSubMeshRole(component.id, activeNodeName, {
      ...activeAssignment,
      ...patch,
    });
  };

  const updateVisualPatch = (patch: Partial<VisualEffectRole>) => {
    if (!activeNodeName || activeAssignment?.role !== 'VisualEffect') return;
    setSubMeshRole(component.id, activeNodeName, {
      ...activeAssignment,
      ...patch,
    });
  };

  const pneuPreset =
    activeAssignment?.role === 'LinearAxis' &&
    activeAssignment.behavior?.presetType === 'PneumaticCylinder'
      ? activeAssignment.behavior
      : undefined;

  const currentJogVal =
    jogPreview &&
    jogPreview.instanceId === instance.id &&
    jogPreview.nodeName === activeNodeName
      ? jogPreview.value
      : null;

  return (
    <div className="vc-builder-stack">
      {/* 1. Sub-Mesh Hierarchy Picker */}
      <div className="vc-inspector-card">
        <div className="vc-section-header-row">
          <span className="vc-section-label">
            <Layers size={12} />
            <span>3D SUB-MESH NODES ({allNodeNames.length})</span>
          </span>
          <span className="vc-micro-hint">Click here or in 3D</span>
        </div>

        {allNodeNames.length === 0 ? (
          <div className="vc-subtle-note">
            Loading 3D sub-mesh hierarchy from model...
          </div>
        ) : (
          <div className="vc-submesh-pick-list">
            {allNodeNames.map((nodeName) => {
              const roleObj = component.nodeRoles[nodeName];
              const roleType = roleObj?.role ?? 'StaticMesh';
              const selected = nodeName === activeNodeName;
              return (
                <button
                  key={nodeName}
                  id={`btn-pick-submesh-${nodeName}`}
                  type="button"
                  className={`vc-submesh-pick-row ${selected ? 'selected' : ''}`}
                  onClick={() => selectSubMesh(nodeName)}
                >
                  <span className="vc-submesh-name vc-mono-text" title={nodeName}>
                    <Crosshair size={11} className="vc-submesh-pin" />
                    <span>{nodeName}</span>
                  </span>
                  <span className={`vc-role-chip role-${roleType}`}>
                    {shortRoleBadge(roleType)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 2. Selected Sub-Mesh Role & Kinematics Configurator */}
      {activeNodeName && activeAssignment && (
        <div className="vc-inspector-card">
          <div className="vc-section-header-row">
            <span className="vc-section-label">
              <Wrench size={12} />
              <span>JOINT / ROLE BUILDER</span>
            </span>
            <span className="vc-mono-text vc-amber-text vc-truncate-tag">
              {activeNodeName}
            </span>
          </div>

          {/* 5-Way Role Type Selector */}
          <div
            className="vc-role-segmented vc-five-seg"
            role="group"
            aria-label="Sub-Mesh Role"
          >
            {(
              [
                ['StaticMesh', 'Static'],
                ['LinearAxis', 'Linear'],
                ['RotaryAxis', 'Rotary'],
                ['VacuumGripper', 'Gripper'],
                ['VisualEffect', 'Effect'],
              ] as const
            ).map(([roleKey, label]) => (
              <button
                key={roleKey}
                id={`btn-role-${roleKey}`}
                type="button"
                className={`vc-role-seg-btn ${
                  activeAssignment.role === roleKey ? `active role-${roleKey}` : ''
                }`}
                onClick={() => handleSwitchRoleType(roleKey)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* LINEAR AXIS EDITOR */}
          {activeAssignment.role === 'LinearAxis' && (
            <div className="vc-joint-form">
              <div className="vc-vec3-block">
                <div className="vc-vec3-header-inline">
                  <span className="vc-vec3-title">Slide Direction Vector</span>
                  <div className="vc-quick-yaw-group">
                    {AXIS_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className={`vc-yaw-chip ${
                          isSameVec(activeAssignment.axis, preset.vec) ? 'active' : ''
                        }`}
                        onClick={() => updateLinearPatch({ axis: preset.vec })}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="vc-vec3-grid">
                  {(['X', 'Y', 'Z'] as const).map((ax, idx) => (
                    <label key={ax} className="vc-axis-input-wrap">
                      <span className={`vc-axis-badge axis-${ax.toLowerCase()}`}>
                        {ax}
                      </span>
                      <input
                        type="number"
                        step={0.1}
                        value={activeAssignment.axis[idx]}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isNaN(v)) return;
                          const next = [...activeAssignment.axis] as Vector3Tuple;
                          next[idx] = v;
                          updateLinearPatch({ axis: next });
                        }}
                      />
                    </label>
                  ))}
                </div>
              </div>

              {/* Stroke Limits (mm) */}
              <div className="vc-vec3-block">
                <span className="vc-vec3-title">Stroke Travel Limits (mm)</span>
                <div className="vc-vec3-grid">
                  <label className="vc-axis-input-wrap">
                    <span className="vc-axis-badge">MIN</span>
                    <input
                      id="input-linear-min-mm"
                      type="number"
                      step={5}
                      value={activeAssignment.minLimitMm}
                      onChange={(e) =>
                        updateLinearPatch({
                          minLimitMm: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </label>
                  <label className="vc-axis-input-wrap">
                    <span className="vc-axis-badge">MAX</span>
                    <input
                      id="input-linear-max-mm"
                      type="number"
                      step={5}
                      value={activeAssignment.maxLimitMm}
                      onChange={(e) =>
                        updateLinearPatch({
                          maxLimitMm: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </label>
                  <label className="vc-axis-input-wrap">
                    <span className="vc-axis-badge">HOME</span>
                    <input
                      id="input-linear-home-mm"
                      type="number"
                      step={5}
                      value={activeAssignment.initialPosMm}
                      onChange={(e) =>
                        updateLinearPatch({
                          initialPosMm: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </label>
                </div>
              </div>

              {/* Actuator Drive Preset */}
              <div className="vc-field-row">
                <span>Actuator Type:</span>
                <select
                  id="select-linear-preset"
                  className="vc-compact-select"
                  value={
                    activeAssignment.behavior?.presetType === 'ServoPositioning'
                      ? 'ServoPositioning'
                      : 'PneumaticCylinder'
                  }
                  onChange={(e) => {
                    if (e.target.value === 'ServoPositioning') {
                      updateLinearPatch({
                        behavior: {
                          presetType: 'ServoPositioning',
                          maxVelocityUnitsPerSec: 350,
                          accelerationUnitsPerSec2: 1200,
                          decelerationUnitsPerSec2: 1500,
                          homeOffset: 0,
                        },
                      });
                    } else {
                      updateLinearPatch({
                        behavior: {
                          presetType: 'PneumaticCylinder',
                          actingMode: 'single-acting',
                          extendSpeedMmPerSec: 220,
                          retractSpeedMmPerSec: 250,
                          emitReedSwitches: true,
                        },
                      });
                    }
                  }}
                >
                  <option value="PneumaticCylinder">Pneumatic Cylinder</option>
                  <option value="ServoPositioning">Servo Linear Axis</option>
                </select>
              </div>

              {activeAssignment.behavior?.presetType === 'ServoPositioning' ? (
                <div className="vc-vec3-grid">
                  <label className="vc-axis-input-wrap" title="Max Velocity (mm/s)">
                    <span className="vc-axis-badge">VEL</span>
                    <input
                      type="number"
                      step={20}
                      min={10}
                      value={activeAssignment.behavior.maxVelocityUnitsPerSec}
                      onChange={(e) =>
                        updateLinearPatch({
                          behavior: {
                            ...(activeAssignment.behavior as Extract<
                              LinearAxisRole['behavior'],
                              { presetType: 'ServoPositioning' }
                            >),
                            maxVelocityUnitsPerSec: Math.max(
                              10,
                              Number(e.target.value) || 300
                            ),
                          },
                        })
                      }
                    />
                  </label>
                  <label className="vc-axis-input-wrap" title="Acceleration (mm/s²)">
                    <span className="vc-axis-badge">ACC</span>
                    <input
                      type="number"
                      step={100}
                      min={50}
                      value={activeAssignment.behavior.accelerationUnitsPerSec2}
                      onChange={(e) =>
                        updateLinearPatch({
                          behavior: {
                            ...(activeAssignment.behavior as Extract<
                              LinearAxisRole['behavior'],
                              { presetType: 'ServoPositioning' }
                            >),
                            accelerationUnitsPerSec2: Math.max(
                              50,
                              Number(e.target.value) || 1000
                            ),
                          },
                        })
                      }
                    />
                  </label>
                  <label className="vc-axis-input-wrap" title="Deceleration (mm/s²)">
                    <span className="vc-axis-badge">DEC</span>
                    <input
                      type="number"
                      step={100}
                      min={50}
                      value={activeAssignment.behavior.decelerationUnitsPerSec2}
                      onChange={(e) =>
                        updateLinearPatch({
                          behavior: {
                            ...(activeAssignment.behavior as Extract<
                              LinearAxisRole['behavior'],
                              { presetType: 'ServoPositioning' }
                            >),
                            decelerationUnitsPerSec2: Math.max(
                              50,
                              Number(e.target.value) || 1200
                            ),
                          },
                        })
                      }
                    />
                  </label>
                </div>
              ) : (
                <>
                  <div className="vc-field-row">
                    <span>Valve Mode:</span>
                    <select
                      className="vc-compact-select"
                      value={pneuPreset?.actingMode ?? 'single-acting'}
                      onChange={(e) =>
                        updateLinearPatch({
                          behavior: {
                            presetType: 'PneumaticCylinder',
                            actingMode:
                              e.target.value === 'double-acting'
                                ? 'double-acting'
                                : 'single-acting',
                            extendSpeedMmPerSec:
                              pneuPreset?.extendSpeedMmPerSec ?? 220,
                            retractSpeedMmPerSec:
                              pneuPreset?.retractSpeedMmPerSec ?? 250,
                            emitReedSwitches: pneuPreset?.emitReedSwitches ?? true,
                          },
                        })
                      }
                    >
                      <option value="single-acting">Single-Acting (Spring)</option>
                      <option value="double-acting">Double-Acting (Dual Coil)</option>
                    </select>
                  </div>

                  <div className="vc-two-col-grid">
                    <label
                      className="vc-axis-input-wrap"
                      title="Extend Speed (mm/s)"
                    >
                      <span className="vc-axis-badge">EXT</span>
                      <input
                        type="number"
                        step={10}
                        min={10}
                        value={pneuPreset?.extendSpeedMmPerSec ?? 220}
                        onChange={(e) =>
                          updateLinearPatch({
                            behavior: {
                              presetType: 'PneumaticCylinder',
                              actingMode: pneuPreset?.actingMode ?? 'single-acting',
                              extendSpeedMmPerSec: Math.max(
                                10,
                                Number(e.target.value) || 220
                              ),
                              retractSpeedMmPerSec:
                                pneuPreset?.retractSpeedMmPerSec ?? 250,
                              emitReedSwitches:
                                pneuPreset?.emitReedSwitches ?? true,
                            },
                          })
                        }
                      />
                    </label>
                    <label
                      className="vc-axis-input-wrap"
                      title="Retract Speed (mm/s)"
                    >
                      <span className="vc-axis-badge">RET</span>
                      <input
                        type="number"
                        step={10}
                        min={10}
                        value={pneuPreset?.retractSpeedMmPerSec ?? 250}
                        onChange={(e) =>
                          updateLinearPatch({
                            behavior: {
                              presetType: 'PneumaticCylinder',
                              actingMode: pneuPreset?.actingMode ?? 'single-acting',
                              extendSpeedMmPerSec:
                                pneuPreset?.extendSpeedMmPerSec ?? 220,
                              retractSpeedMmPerSec: Math.max(
                                10,
                                Number(e.target.value) || 250
                              ),
                              emitReedSwitches:
                                pneuPreset?.emitReedSwitches ?? true,
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                </>
              )}

              {/* Kinematic Parent Chain Selector */}
              <div className="vc-field-row">
                <span>Carried By Axis:</span>
                <select
                  className="vc-compact-select"
                  value={activeAssignment.parentNodeName ?? ''}
                  onChange={(e) =>
                    updateLinearPatch({
                      parentNodeName: e.target.value || undefined,
                    })
                  }
                >
                  <option value="">(None · Machine Base)</option>
                  {allNodeNames
                    .filter((n) => n !== activeNodeName)
                    .map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                </select>
              </div>

              {/* Live 3D Jog Test Slider */}
              <div className="vc-jog-box">
                <div className="vc-jog-header">
                  <span>TEST JOG STROKE</span>
                  <span className="vc-mono-text vc-amber-text">
                    {(currentJogVal ?? activeAssignment.initialPosMm).toFixed(1)} mm
                  </span>
                </div>
                <div className="vc-jog-controls">
                  <input
                    id="slider-builder-jog-linear"
                    type="range"
                    min={Math.min(
                      activeAssignment.minLimitMm,
                      activeAssignment.maxLimitMm
                    )}
                    max={Math.max(
                      activeAssignment.minLimitMm,
                      activeAssignment.maxLimitMm
                    )}
                    step={1}
                    value={currentJogVal ?? activeAssignment.initialPosMm}
                    onChange={(e) =>
                      setJogPreview({
                        instanceId: instance.id,
                        nodeName: activeNodeName,
                        value: Number(e.target.value),
                      })
                    }
                    className="vc-range-slider"
                  />
                  <button
                    type="button"
                    className="vc-yaw-chip"
                    onClick={() => setJogPreview(null)}
                    title="Reset Jog to Home"
                  >
                    <RotateCcw size={11} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ROTARY AXIS EDITOR */}
          {activeAssignment.role === 'RotaryAxis' && (
            <div className="vc-joint-form">
              <div className="vc-vec3-block">
                <div className="vc-vec3-header-inline">
                  <span className="vc-vec3-title">Rotation Spindle Axis</span>
                  <div className="vc-quick-yaw-group">
                    {AXIS_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className={`vc-yaw-chip ${
                          isSameVec(activeAssignment.axis, preset.vec) ? 'active' : ''
                        }`}
                        onClick={() => updateRotaryPatch({ axis: preset.vec })}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="vc-vec3-grid">
                  {(['X', 'Y', 'Z'] as const).map((ax, idx) => (
                    <label key={ax} className="vc-axis-input-wrap">
                      <span className={`vc-axis-badge axis-${ax.toLowerCase()}`}>
                        {ax}
                      </span>
                      <input
                        type="number"
                        step={0.1}
                        value={activeAssignment.axis[idx]}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isNaN(v)) return;
                          const next = [...activeAssignment.axis] as Vector3Tuple;
                          next[idx] = v;
                          updateRotaryPatch({ axis: next });
                        }}
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="vc-field-row">
                <span>Rotary Mode:</span>
                <select
                  id="select-rotary-mode"
                  className="vc-compact-select"
                  value={activeAssignment.mode}
                  onChange={(e) => {
                    const nextMode =
                      e.target.value === 'continuous' ? 'continuous' : 'bounded';
                    updateRotaryPatch({
                      mode: nextMode,
                      minDeg: nextMode === 'continuous' ? 0 : -90,
                      maxDeg: nextMode === 'continuous' ? 360 : 90,
                    });
                  }}
                >
                  <option value="continuous">Continuous Spin (Motor / Impeller)</option>
                  <option value="bounded">Bounded Index / Servo (°)</option>
                </select>
              </div>

              {activeAssignment.mode === 'continuous' ? (
                <div className="vc-field-row">
                  <span>Nominal Speed (RPM):</span>
                  <input
                    id="input-rotary-rpm"
                    type="number"
                    step={5}
                    min={1}
                    value={activeAssignment.defaultRpm}
                    onChange={(e) =>
                      updateRotaryPatch({
                        defaultRpm: Math.max(1, Number(e.target.value) || 60),
                      })
                    }
                    className="vc-small-num-input"
                  />
                </div>
              ) : (
                <div className="vc-vec3-grid">
                  <label className="vc-axis-input-wrap" title="Min Angle (°)">
                    <span className="vc-axis-badge">MIN°</span>
                    <input
                      type="number"
                      step={15}
                      value={activeAssignment.minDeg}
                      onChange={(e) =>
                        updateRotaryPatch({ minDeg: Number(e.target.value) || 0 })
                      }
                    />
                  </label>
                  <label className="vc-axis-input-wrap" title="Max Angle (°)">
                    <span className="vc-axis-badge">MAX°</span>
                    <input
                      type="number"
                      step={15}
                      value={activeAssignment.maxDeg}
                      onChange={(e) =>
                        updateRotaryPatch({ maxDeg: Number(e.target.value) || 90 })
                      }
                    />
                  </label>
                  <label className="vc-axis-input-wrap" title="Nominal Speed (RPM)">
                    <span className="vc-axis-badge">RPM</span>
                    <input
                      type="number"
                      step={5}
                      min={1}
                      value={activeAssignment.defaultRpm}
                      onChange={(e) =>
                        updateRotaryPatch({
                          defaultRpm: Math.max(1, Number(e.target.value) || 15),
                        })
                      }
                    />
                  </label>
                </div>
              )}

              {/* Optional Pivot Offset for Hinges / Robot Arms */}
              <div className="vc-vec3-block">
                <span className="vc-vec3-title">Pivot Offset from Center (m)</span>
                <div className="vc-vec3-grid">
                  {(['dX', 'dY', 'dZ'] as const).map((lbl, idx) => (
                    <label key={lbl} className="vc-axis-input-wrap">
                      <span className="vc-axis-badge">{lbl}</span>
                      <input
                        type="number"
                        step={0.02}
                        value={(activeAssignment.pivotOffset ?? [0, 0, 0])[idx]}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isNaN(v)) return;
                          const next = [
                            ...(activeAssignment.pivotOffset ?? [0, 0, 0]),
                          ] as Vector3Tuple;
                          next[idx] = v;
                          updateRotaryPatch({ pivotOffset: next });
                        }}
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="vc-field-row">
                <span>Carried By Axis:</span>
                <select
                  className="vc-compact-select"
                  value={activeAssignment.parentNodeName ?? ''}
                  onChange={(e) =>
                    updateRotaryPatch({
                      parentNodeName: e.target.value || undefined,
                    })
                  }
                >
                  <option value="">(None · Machine Base)</option>
                  {allNodeNames
                    .filter((n) => n !== activeNodeName)
                    .map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                </select>
              </div>

              {/* Live 3D Rotary Jog Test Slider */}
              <div className="vc-jog-box">
                <div className="vc-jog-header">
                  <span>TEST JOG ANGLE</span>
                  <span className="vc-mono-text vc-cyan-text">
                    {(currentJogVal ?? 0).toFixed(1)}°
                  </span>
                </div>
                <div className="vc-jog-controls">
                  <input
                    id="slider-builder-jog-rotary"
                    type="range"
                    min={
                      activeAssignment.mode === 'continuous'
                        ? 0
                        : Math.min(activeAssignment.minDeg, activeAssignment.maxDeg)
                    }
                    max={
                      activeAssignment.mode === 'continuous'
                        ? 360
                        : Math.max(activeAssignment.minDeg, activeAssignment.maxDeg)
                    }
                    step={1}
                    value={currentJogVal ?? 0}
                    onChange={(e) =>
                      setJogPreview({
                        instanceId: instance.id,
                        nodeName: activeNodeName,
                        value: Number(e.target.value),
                      })
                    }
                    className="vc-range-slider"
                  />
                  <button
                    type="button"
                    className="vc-yaw-chip"
                    onClick={() => setJogPreview(null)}
                    title="Reset Jog to 0°"
                  >
                    <RotateCcw size={11} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* VACUUM GRIPPER EDITOR */}
          {activeAssignment.role === 'VacuumGripper' && (
            <div className="vc-joint-form">
              <div className="vc-vec3-block">
                <span className="vc-vec3-title">
                  <Magnet size={11} style={{ display: 'inline', marginRight: 4 }} />
                  Suction Capture & Transfer Parameters (mm)
                </span>
                <div className="vc-vec3-grid">
                  <label
                    className="vc-axis-input-wrap"
                    title="Horizontal Suction Grab Radius (mm)"
                  >
                    <span className="vc-axis-badge">RAD</span>
                    <input
                      id="input-gripper-radius-mm"
                      type="number"
                      step={10}
                      min={20}
                      value={activeAssignment.grabRadiusMm}
                      onChange={(e) =>
                        updateGripperPatch({
                          grabRadiusMm: Math.max(
                            20,
                            Number(e.target.value) || 180
                          ),
                        })
                      }
                    />
                  </label>
                  <label
                    className="vc-axis-input-wrap"
                    title="Vertical Suction Contact Tolerance (mm)"
                  >
                    <span className="vc-axis-badge">TOL</span>
                    <input
                      id="input-gripper-tol-mm"
                      type="number"
                      step={5}
                      min={5}
                      value={activeAssignment.grabHeightToleranceMm}
                      onChange={(e) =>
                        updateGripperPatch({
                          grabHeightToleranceMm: Math.max(
                            5,
                            Number(e.target.value) || 45
                          ),
                        })
                      }
                    />
                  </label>
                  <label
                    className="vc-axis-input-wrap"
                    title="Default Auto-Cycle Traverse Place Target (mm)"
                  >
                    <span className="vc-axis-badge">PLC</span>
                    <input
                      id="input-gripper-place-mm"
                      type="number"
                      step={50}
                      value={activeAssignment.placeTargetPosMm ?? 800}
                      onChange={(e) =>
                        updateGripperPatch({
                          placeTargetPosMm: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </label>
                </div>
              </div>

              <div className="vc-field-row">
                <span>Carried By Axis:</span>
                <select
                  id="select-gripper-parent-axis"
                  className="vc-compact-select"
                  value={activeAssignment.parentNodeName ?? ''}
                  onChange={(e) =>
                    updateGripperPatch({
                      parentNodeName: e.target.value || undefined,
                    })
                  }
                >
                  <option value="">(None · Machine Base)</option>
                  {allNodeNames
                    .filter((n) => n !== activeNodeName)
                    .map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                </select>
              </div>

              <div className="vc-subtle-note">
                Picks workpieces when <code>DO_VacuumOn</code> or{' '}
                <code>DO_AutoCycle</code> is active, stops Z-cylinder compliantly on
                part contact, carries in 6-DOF, and hands off onto target conveyor
                splines.
              </div>
            </div>
          )}

          {/* VISUAL EFFECT EDITOR */}
          {activeAssignment.role === 'VisualEffect' && (
            <div className="vc-joint-form">
              <div className="vc-field-row">
                <Sparkles size={12} className="vc-emerald-text" />
                <span>Effect Mode:</span>
                <select
                  className="vc-compact-select"
                  value={activeAssignment.effectType}
                  onChange={(e) =>
                    updateVisualPatch({
                      effectType: e.target.value as VisualEffectRole['effectType'],
                    })
                  }
                >
                  <option value="uv-scroll">Conveyor Belt UV-Scroll</option>
                  <option value="emissive-lamp">Status Lamp (Emissive)</option>
                  <option value="tank-level">Tank Liquid Level (%)</option>
                </select>
              </div>

              {activeAssignment.effectType === 'uv-scroll' && (
                <div className="vc-vec3-grid">
                  <label className="vc-axis-input-wrap" title="UV Scroll Direction">
                    <span className="vc-axis-badge">AXIS</span>
                    <select
                      className="vc-inline-select"
                      value={activeAssignment.uvScrollAxis ?? 'u'}
                      onChange={(e) =>
                        updateVisualPatch({
                          uvScrollAxis: e.target.value === 'v' ? 'v' : 'u',
                        })
                      }
                    >
                      <option value="u">U (X)</option>
                      <option value="v">V (Y)</option>
                    </select>
                  </label>
                  <label
                    className="vc-axis-input-wrap"
                    title="Nominal Belt Drive Speed (RPM)"
                  >
                    <span className="vc-axis-badge">RPM</span>
                    <input
                      id="input-uv-nominal-rpm"
                      type="number"
                      min={1}
                      step={5}
                      value={activeAssignment.nominalRpm ?? 60}
                      onChange={(e) =>
                        updateVisualPatch({
                          nominalRpm: Math.max(1, Number(e.target.value) || 60),
                        })
                      }
                    />
                  </label>
                  <label
                    className="vc-axis-input-wrap"
                    title="UV Texture Speed Scale Multiplier"
                  >
                    <span className="vc-axis-badge">SCL</span>
                    <input
                      type="number"
                      step={0.2}
                      value={activeAssignment.uvScrollScale ?? 1.0}
                      onChange={(e) =>
                        updateVisualPatch({
                          uvScrollScale: Number(e.target.value) || 1.0,
                        })
                      }
                    />
                  </label>
                </div>
              )}

              {activeAssignment.effectType === 'emissive-lamp' && (
                <div className="vc-two-col-grid">
                  <label className="vc-color-row">
                    <span>ON</span>
                    <input
                      type="color"
                      value={activeAssignment.emissiveOnHex ?? '#10b981'}
                      onChange={(e) =>
                        updateVisualPatch({ emissiveOnHex: e.target.value })
                      }
                    />
                  </label>
                  <label className="vc-color-row">
                    <span>OFF</span>
                    <input
                      type="color"
                      value={activeAssignment.emissiveOffHex ?? '#334155'}
                      onChange={(e) =>
                        updateVisualPatch({ emissiveOffHex: e.target.value })
                      }
                    />
                  </label>
                </div>
              )}

              {activeAssignment.effectType === 'tank-level' && (
                <div className="vc-jog-box">
                  <div className="vc-jog-header">
                    <span>TEST FILL LEVEL</span>
                    <span className="vc-mono-text vc-emerald-text">
                      {(currentJogVal ?? 50).toFixed(0)}%
                    </span>
                  </div>
                  <div className="vc-jog-controls">
                    <input
                      type="range"
                      min={2}
                      max={100}
                      step={1}
                      value={currentJogVal ?? 50}
                      onChange={(e) =>
                        setJogPreview({
                          instanceId: instance.id,
                          nodeName: activeNodeName,
                          value: Number(e.target.value),
                        })
                      }
                      className="vc-range-slider"
                    />
                    <button
                      type="button"
                      className="vc-yaw-chip"
                      onClick={() => setJogPreview(null)}
                    >
                      <RotateCcw size={11} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeAssignment.role === 'StaticMesh' && (
            <div className="vc-subtle-note" style={{ marginTop: 8 }}>
              Rigid structural sub-mesh. Switch to <strong>Linear</strong>,{' '}
              <strong>Rotary</strong>, or <strong>Gripper</strong> above to synthesize
              PLC actuator & sensor signals.
            </div>
          )}
        </div>
      )}

      {/* 3. Synthesized Signals Summary + Jump to Force Panel */}
      <div className="vc-inspector-card">
        <div className="vc-section-header-row">
          <span className="vc-section-label">
            <Cpu size={12} />
            <span>NODE I/O SIGNALS ({nodeSignals.length})</span>
          </span>
          <button
            id="btn-jump-force-panel"
            type="button"
            className="vc-port-add-btn vc-amber"
            onClick={() => setInspectorTab('signals')}
          >
            <span>Force I/O</span>
            <ArrowRight size={11} />
          </button>
        </div>

        {nodeSignals.length === 0 ? (
          <div className="vc-subtle-note">
            Assign a <strong>LinearAxis</strong>, <strong>RotaryAxis</strong>,{' '}
            <strong>VacuumGripper</strong>, or <strong>VisualEffect</strong> role to
            generate controllable I/O tags.
          </div>
        ) : (
          <div className="vc-node-role-list">
            {nodeSignals.map((sig) => (
              <div key={sig.key} className="vc-node-role-row">
                <span title={sig.label}>{sig.label}</span>
                <span
                  className={`vc-mono-text vc-sig-chip ${
                    sig.direction === 'SIM_TO_PLC' ? 'vc-emerald-text' : ''
                  }`}
                >
                  {sig.direction === 'PLC_TO_SIM' ? 'CMD' : 'FBK'} · {sig.dataType}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
