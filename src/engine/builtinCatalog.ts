import {
  SCHEMA_VERSION,
  type ComponentDefinition,
  type SubMeshRoleAssignment,
} from '../shared/schemas';
import { synthesizeComponentSignals } from './signalCatalogSync';

function withSynthesizedSignals(
  def: Omit<ComponentDefinition, 'exposedSignals'>
): ComponentDefinition {
  return {
    ...def,
    exposedSignals: synthesizeComponentSignals(def.nodeRoles),
  };
}

const CONVEYOR_NODE_ROLES: Record<string, SubMeshRoleAssignment> = {
  Frame_Chassis: { role: 'StaticMesh', nodeName: 'Frame_Chassis' },
  Belt_Surface: {
    role: 'VisualEffect',
    nodeName: 'Belt_Surface',
    effectType: 'uv-scroll',
    uvScrollAxis: 'u',
    uvScrollScale: 1.0,
    nominalRpm: 60,
  },
  Drive_Motor_Unit: { role: 'StaticMesh', nodeName: 'Drive_Motor_Unit' },
};

/**
 * Built-in Industrial 3D Asset Catalog (.glb + OpenUSD .usdz)
 * Pre-calibrated with SnapPorts (0.78m line elevation), FK joint presets, and synthesized I/O signals.
 */
export const BUILTIN_COMPONENT_CATALOG: ComponentDefinition[] = [
  withSynthesizedSignals({
    id: 'builtin-belt-conveyor-2m',
    schemaVersion: SCHEMA_VERSION,
    name: 'Belt Conveyor 2.0m',
    category: 'Conveyors',
    description:
      'Standard 2.0m industrial flat belt conveyor (0.78m elevation) with UV-scroll belt drive and Input/Output SnapPorts.',
    modelSource: {
      kind: 'builtin',
      uri: './sample-models/belt-conveyor-2m.glb',
      fileName: 'belt-conveyor-2m.glb',
    },
    boundingBox: {
      min: [-1.0, 0, -0.31],
      max: [1.0, 0.8, 0.43],
      size: [2.0, 0.8, 0.74],
    },
    nodeRoles: structuredClone(CONVEYOR_NODE_ROLES),
    snapPorts: [
      {
        id: 'port-in',
        name: 'InPort (-X)',
        role: 'InputPort',
        protocol: 'material-flow',
        localPosition: [-1.0, 0.78, 0],
        localNormal: [-1, 0, 0],
        localUp: [0, 1, 0],
      },
      {
        id: 'port-out',
        name: 'OutPort (+X)',
        role: 'OutputPort',
        protocol: 'material-flow',
        localPosition: [1.0, 0.78, 0],
        localNormal: [1, 0, 0],
        localUp: [0, 1, 0],
      },
    ],
    transportPaths: [
      {
        id: 'path-main',
        name: 'Main Belt Centerline',
        inPortId: 'port-in',
        outPortId: 'port-out',
        waypoints: [
          [-1.0, 0.8, 0],
          [0, 0.8, 0],
          [1.0, 0.8, 0],
        ],
        interpolation: 'catmull-rom',
        defaultSpeedMmPerSec: 450,
      },
    ],
    sensors: [],
  }),
  withSynthesizedSignals({
    id: 'builtin-belt-conveyor-1m',
    schemaVersion: SCHEMA_VERSION,
    name: 'Transfer Conveyor 1.0m',
    category: 'Conveyors',
    description:
      'Compact 1.0m buffer/transfer belt module for tight cell layouts and accumulation zones.',
    modelSource: {
      kind: 'builtin',
      uri: './sample-models/belt-conveyor-1m.glb',
      fileName: 'belt-conveyor-1m.glb',
    },
    boundingBox: {
      min: [-0.5, 0, -0.31],
      max: [0.5, 0.8, 0.43],
      size: [1.0, 0.8, 0.74],
    },
    nodeRoles: structuredClone(CONVEYOR_NODE_ROLES),
    snapPorts: [
      {
        id: 'port-in',
        name: 'InPort (-X)',
        role: 'InputPort',
        protocol: 'material-flow',
        localPosition: [-0.5, 0.78, 0],
        localNormal: [-1, 0, 0],
        localUp: [0, 1, 0],
      },
      {
        id: 'port-out',
        name: 'OutPort (+X)',
        role: 'OutputPort',
        protocol: 'material-flow',
        localPosition: [0.5, 0.78, 0],
        localNormal: [1, 0, 0],
        localUp: [0, 1, 0],
      },
    ],
    transportPaths: [
      {
        id: 'path-main',
        name: 'Transfer Belt Centerline',
        inPortId: 'port-in',
        outPortId: 'port-out',
        waypoints: [
          [-0.5, 0.8, 0],
          [0.5, 0.8, 0],
        ],
        interpolation: 'polyline',
        defaultSpeedMmPerSec: 450,
      },
    ],
    sensors: [],
  }),
  withSynthesizedSignals({
    id: 'builtin-rotary-turntable',
    schemaVersion: SCHEMA_VERSION,
    name: '90° Rotary Turntable',
    category: 'Conveyors',
    description:
      '4-Way indexing turntable conveyor with bounded RotaryAxis (-90°..+90°) and West/East/North/South SnapPorts.',
    modelSource: {
      kind: 'builtin',
      uri: './sample-models/rotary-turntable.glb',
      fileName: 'rotary-turntable.glb',
    },
    boundingBox: {
      min: [-0.48, 0, -0.48],
      max: [0.48, 0.83, 0.48],
      size: [0.96, 0.83, 0.96],
    },
    nodeRoles: {
      Turntable_Pedestal_Base: {
        role: 'StaticMesh',
        nodeName: 'Turntable_Pedestal_Base',
      },
      Turntable_Index_Deck_Axis: {
        role: 'RotaryAxis',
        nodeName: 'Turntable_Index_Deck_Axis',
        axis: [0, 1, 0],
        mode: 'bounded',
        minDeg: -90,
        maxDeg: 90,
        defaultRpm: 15,
      },
    },
    snapPorts: [
      {
        id: 'port-west-in',
        name: 'InPort West (-X)',
        role: 'InputPort',
        protocol: 'material-flow',
        localPosition: [-0.48, 0.78, 0],
        localNormal: [-1, 0, 0],
        localUp: [0, 1, 0],
      },
      {
        id: 'port-east-out',
        name: 'OutPort East (+X)',
        role: 'OutputPort',
        protocol: 'material-flow',
        localPosition: [0.48, 0.78, 0],
        localNormal: [1, 0, 0],
        localUp: [0, 1, 0],
      },
      {
        id: 'port-north-out',
        name: 'OutPort North (-Z)',
        role: 'OutputPort',
        protocol: 'material-flow',
        localPosition: [0, 0.78, -0.48],
        localNormal: [0, 0, -1],
        localUp: [0, 1, 0],
      },
      {
        id: 'port-south-out',
        name: 'OutPort South (+Z)',
        role: 'OutputPort',
        protocol: 'material-flow',
        localPosition: [0, 0.78, 0.48],
        localNormal: [0, 0, 1],
        localUp: [0, 1, 0],
      },
    ],
    transportPaths: [],
    sensors: [],
  }),
  withSynthesizedSignals({
    id: 'builtin-pneumatic-stopper',
    schemaVersion: SCHEMA_VERSION,
    name: 'Pneumatic Blade Stopper',
    category: 'Actuators',
    description:
      'Inline pneumatic stopper gate with vertical LinearAxis blade, automatic Reed Switch limits, and status beacon.',
    modelSource: {
      kind: 'builtin',
      uri: './sample-models/pneumatic-stopper.glb',
      fileName: 'pneumatic-stopper.glb',
    },
    boundingBox: {
      min: [-0.14, 0, -0.34],
      max: [0.14, 0.98, 0.34],
      size: [0.28, 0.98, 0.68],
    },
    nodeRoles: {
      Cylinder_Mount_Frame: { role: 'StaticMesh', nodeName: 'Cylinder_Mount_Frame' },
      Piston_Stopper_Blade_Axis: {
        role: 'LinearAxis',
        nodeName: 'Piston_Stopper_Blade_Axis',
        axis: [0, 1, 0],
        minLimitMm: 0,
        maxLimitMm: 110,
        initialPosMm: 0,
        behavior: {
          presetType: 'PneumaticCylinder',
          actingMode: 'single-acting',
          extendSpeedMmPerSec: 220,
          retractSpeedMmPerSec: 250,
          emitReedSwitches: true,
        },
      },
      Reed_Switch_Status_Lamp: {
        role: 'VisualEffect',
        nodeName: 'Reed_Switch_Status_Lamp',
        effectType: 'emissive-lamp',
        emissiveOnHex: '#10b981',
        emissiveOffHex: '#334155',
      },
    },
    snapPorts: [
      {
        id: 'port-in',
        name: 'InPort (-X)',
        role: 'InputPort',
        protocol: 'material-flow',
        localPosition: [-0.14, 0.78, 0],
        localNormal: [-1, 0, 0],
        localUp: [0, 1, 0],
      },
      {
        id: 'port-out',
        name: 'OutPort (+X)',
        role: 'OutputPort',
        protocol: 'material-flow',
        localPosition: [0.14, 0.78, 0],
        localNormal: [1, 0, 0],
        localUp: [0, 1, 0],
      },
    ],
    transportPaths: [
      {
        id: 'path-pass',
        name: 'Stopper Gate Pass-Through',
        inPortId: 'port-in',
        outPortId: 'port-out',
        waypoints: [
          [-0.14, 0.8, 0],
          [0.14, 0.8, 0],
        ],
        interpolation: 'polyline',
        defaultSpeedMmPerSec: 450,
      },
    ],
    sensors: [],
  }),
  withSynthesizedSignals({
    id: 'builtin-mixing-tank-agitator',
    schemaVersion: SCHEMA_VERSION,
    name: 'Process Mixing Tank',
    category: 'ProcessEquipment',
    description:
      'Translucent sight-glass process vessel with continuous RotaryAxis dual-tier agitator impeller and flange SnapPorts.',
    modelSource: {
      kind: 'builtin',
      uri: './sample-models/mixing-tank-agitator.glb',
      fileName: 'mixing-tank-agitator.glb',
    },
    boundingBox: {
      min: [-0.8, 0, -0.62],
      max: [0.8, 2.15, 0.62],
      size: [1.6, 2.15, 1.24],
    },
    nodeRoles: {
      Tank_Support_Skid: { role: 'StaticMesh', nodeName: 'Tank_Support_Skid' },
      Stainless_Tank_Vessel: { role: 'StaticMesh', nodeName: 'Stainless_Tank_Vessel' },
      Agitator_Impeller_Axis: {
        role: 'RotaryAxis',
        nodeName: 'Agitator_Impeller_Axis',
        axis: [0, 1, 0],
        mode: 'continuous',
        minDeg: 0,
        maxDeg: 360,
        defaultRpm: 90,
        behavior: {
          presetType: 'ConveyorDrive',
          nominalSpeedMmPerSec: 0,
          nominalRpm: 90,
          allowReverse: true,
          useAnalogSpeedPercent: true,
          syncUvScrolling: false,
        },
      },
    },
    snapPorts: [
      {
        id: 'port-inlet',
        name: 'Inlet Flange (-X)',
        role: 'InputPort',
        protocol: 'material-flow',
        localPosition: [-0.8, 0.78, 0],
        localNormal: [-1, 0, 0],
        localUp: [0, 1, 0],
      },
      {
        id: 'port-outlet',
        name: 'Outlet Flange (+X)',
        role: 'OutputPort',
        protocol: 'material-flow',
        localPosition: [0.8, 0.78, 0],
        localNormal: [1, 0, 0],
        localUp: [0, 1, 0],
      },
    ],
    transportPaths: [],
    sensors: [],
  }),
  withSynthesizedSignals({
    id: 'builtin-openusd-cartesian-gantry',
    schemaVersion: SCHEMA_VERSION,
    name: 'Cartesian Pick & Place (OpenUSD)',
    category: 'Actuators',
    description:
      'AOUSD Z-up metric OpenUSD (.usdz) overhead servo traverse carriage + chained pneumatic Z-mast & vacuum gripper.',
    modelSource: {
      kind: 'builtin',
      uri: './sample-models/cartesian-gantry-cell.usdz',
      fileName: 'cartesian-gantry-cell.usdz',
      format: 'usdz',
    },
    boundingBox: {
      min: [-0.5, 0, -0.485],
      max: [0.5, 1.63, 0.485],
      size: [1.0, 1.63, 0.97],
    },
    nodeRoles: {
      Portal_Leg_FL: { role: 'StaticMesh', nodeName: 'Portal_Leg_FL' },
      Portal_Leg_FR: { role: 'StaticMesh', nodeName: 'Portal_Leg_FR' },
      Portal_Leg_BL: { role: 'StaticMesh', nodeName: 'Portal_Leg_BL' },
      Portal_Leg_BR: { role: 'StaticMesh', nodeName: 'Portal_Leg_BR' },
      Side_Header_Front: { role: 'StaticMesh', nodeName: 'Side_Header_Front' },
      Side_Header_Back: { role: 'StaticMesh', nodeName: 'Side_Header_Back' },
      Overhead_Bridge_Beam: { role: 'StaticMesh', nodeName: 'Overhead_Bridge_Beam' },
      Servo_Traverse_Carriage_Axis: {
        role: 'LinearAxis',
        nodeName: 'Servo_Traverse_Carriage_Axis',
        axis: [0, 0, 1],
        minLimitMm: -280,
        maxLimitMm: 280,
        initialPosMm: 0,
        behavior: {
          presetType: 'ServoPositioning',
          maxVelocityUnitsPerSec: 360,
          accelerationUnitsPerSec2: 1100,
          decelerationUnitsPerSec2: 1400,
          homeOffset: 0,
        },
      },
      Vertical_Z_Mast_Axis: {
        role: 'LinearAxis',
        nodeName: 'Vertical_Z_Mast_Axis',
        axis: [0, -1, 0],
        minLimitMm: 0,
        maxLimitMm: 220,
        initialPosMm: 0,
        parentNodeName: 'Servo_Traverse_Carriage_Axis',
        behavior: {
          presetType: 'PneumaticCylinder',
          actingMode: 'single-acting',
          extendSpeedMmPerSec: 210,
          retractSpeedMmPerSec: 250,
          emitReedSwitches: true,
        },
      },
      Vacuum_Gripper_Tool_Axis: {
        role: 'StaticMesh',
        nodeName: 'Vacuum_Gripper_Tool_Axis',
      },
      Safety_Beacon_Lamp: {
        role: 'VisualEffect',
        nodeName: 'Safety_Beacon_Lamp',
        effectType: 'emissive-lamp',
        emissiveOnHex: '#f59e0b',
        emissiveOffHex: '#334155',
      },
    },
    snapPorts: [
      {
        id: 'port-in',
        name: 'InPort (-X)',
        role: 'InputPort',
        protocol: 'material-flow',
        localPosition: [-0.5, 0.78, 0],
        localNormal: [-1, 0, 0],
        localUp: [0, 1, 0],
      },
      {
        id: 'port-out',
        name: 'OutPort (+X)',
        role: 'OutputPort',
        protocol: 'material-flow',
        localPosition: [0.5, 0.78, 0],
        localNormal: [1, 0, 0],
        localUp: [0, 1, 0],
      },
    ],
    transportPaths: [
      {
        id: 'path-pass',
        name: 'Gantry Pass-Through Zone',
        inPortId: 'port-in',
        outPortId: 'port-out',
        waypoints: [
          [-0.5, 0.8, 0],
          [0.5, 0.8, 0],
        ],
        interpolation: 'polyline',
        defaultSpeedMmPerSec: 450,
      },
    ],
    sensors: [],
  }),
];
