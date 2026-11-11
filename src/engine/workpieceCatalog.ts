import type {
  ComponentDefinition,
  Vector3Tuple,
  WorkpiecePreset,
  WorkpieceShapeType,
} from '../shared/schemas';

/**
 * Industrial Test Workpiece & Product Catalog
 * Ready-to-drop 3D products for commissioning Conveyor Splines, Photoelectric (PE) &
 * Inductive Proximity (PX) Sensors, Pneumatic Stopper Queues, Turntables, and HSC Counters.
 */

export const BUILTIN_WORKPIECE_PRESETS: WorkpiecePreset[] = [
  {
    id: 'wp-carton-std',
    name: 'Carton Box',
    nameTh: 'กล่องพัสดุ',
    shape: 'carton',
    dimensionsMm: [280, 220, 160],
    colorHex: '#0ea5e9',
    materialTag: 'Cardboard',
    description:
      'Standard corrugated shipping carton with top barcode manifest for Photoelectric (PE) & Stopper queue testing.',
  },
  {
    id: 'wp-euro-pallet',
    name: 'Industrial Pallet',
    nameTh: 'พาเลทสินค้า',
    shape: 'pallet',
    dimensionsMm: [460, 380, 135],
    colorHex: '#d97706',
    materialTag: 'Wood',
    description:
      'Slatted pallet skid with strapped unit load for heavy conveyor pitch, accumulation & 90° turntable transfers.',
  },
  {
    id: 'wp-tote-bin',
    name: 'KLT Tote Bin',
    nameTh: 'ลังพลาสติก KLT',
    shape: 'tote',
    dimensionsMm: [320, 240, 150],
    colorHex: '#2563eb',
    materialTag: 'Polymer',
    description:
      'Open-top ribbed automotive intralogistics tote container with recessed cavity and reinforced stacking rim.',
  },
  {
    id: 'wp-cylinder-drum',
    name: 'Cylinder / Canister',
    nameTh: 'ทรงกระบอก / ขวด',
    shape: 'cylinder',
    dimensionsMm: [180, 180, 220],
    colorHex: '#10b981',
    materialTag: 'Aluminum',
    description:
      'Cylindrical canister/bottle with narrow cross-section for high-speed sensor pulse width & HSC timing checks.',
  },
  {
    id: 'wp-metal-plate',
    name: 'CNC Metal Billet',
    nameTh: 'แผ่นโลหะ / ชิ้นงานกลึง',
    shape: 'plate',
    dimensionsMm: [240, 200, 52],
    colorHex: '#94a3b8',
    materialTag: 'Steel',
    description:
      'Low-profile machined steel billet for Inductive Proximity (PX) sensor triggering & Gantry Pick-and-Place.',
  },
];

export function getWorkpiecePresetById(id: string): WorkpiecePreset | undefined {
  return BUILTIN_WORKPIECE_PRESETS.find((p) => p.id === id);
}

export function findPresetForShape(shape: WorkpieceShapeType | undefined): WorkpiecePreset {
  if (!shape || shape === 'custom-model') return BUILTIN_WORKPIECE_PRESETS[0];
  return (
    BUILTIN_WORKPIECE_PRESETS.find((p) => p.shape === shape) ??
    BUILTIN_WORKPIECE_PRESETS[0]
  );
}

/**
 * Computes conveyor-friendly [Length, Width, Height] in millimeters from any
 * imported .glb / .gltf / OpenUSD (.usd/.usda/.usdc/.usdz) ComponentDefinition.
 * Preserves 1:1 CAD dimensions for parcel-sized models (<= 600mm) and uniformly scales down
 * oversized equipment models so any 3D asset rides cleanly along standard 500-600mm belts.
 */
export function computeWorkpieceDimensionsFromComponent(
  comp: ComponentDefinition
): Vector3Tuple {
  const [sxM, syM, szM] = comp.boundingBox.size;
  let rawLenMm = Math.max(40, sxM * 1000);
  let rawWidMm = Math.max(40, szM * 1000);
  let rawHgtMm = Math.max(30, syM * 1000);

  const maxHoriz = Math.max(rawLenMm, rawWidMm);
  if (maxHoriz > 520) {
    const scaleDown = 360 / maxHoriz;
    rawLenMm *= scaleDown;
    rawWidMm *= scaleDown;
    rawHgtMm *= scaleDown;
  } else if (maxHoriz < 70) {
    const scaleUp = 140 / Math.max(1, maxHoriz);
    rawLenMm *= scaleUp;
    rawWidMm *= scaleUp;
    rawHgtMm *= scaleUp;
  }

  return [
    Math.min(600, Math.max(70, Math.round(rawLenMm))),
    Math.min(500, Math.max(70, Math.round(rawWidMm))),
    Math.min(480, Math.max(35, Math.round(rawHgtMm))),
  ];
}
