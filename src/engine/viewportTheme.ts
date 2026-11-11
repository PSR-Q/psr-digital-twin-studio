import type { SceneEnvironmentConfig, ViewportThemeId } from '../shared/schemas';

export interface ViewportThemePresetMeta {
  id: ViewportThemeId;
  label: string;
  labelTh: string;
  shortLabel: string;
  skySwatch: string;
  floorSwatch: string;
  description: string;
}

export const VIEWPORT_THEME_PRESETS: ViewportThemePresetMeta[] = [
  {
    id: 'sketchup-white',
    label: 'SketchUp White',
    labelTh: 'พื้นขาวคลีน (SketchUp)',
    shortLabel: 'White',
    skySwatch: '#f8fafc',
    floorSwatch: '#ffffff',
    description: 'Clean SketchUp architectural white studio with crisp RGB axes & soft shadows.',
  },
  {
    id: 'sketchup-sky',
    label: 'SketchUp Sky & Ground',
    labelTh: 'ท้องฟ้า + พื้นขาว (SketchUp)',
    shortLabel: 'Sky+White',
    skySwatch: '#d4eafc',
    floorSwatch: '#f9fbfd',
    description: 'Classic SketchUp modeling view with pale blue horizon sky & white ground.',
  },
  {
    id: 'cad-light-gray',
    label: 'CAD Light Gray',
    labelTh: 'พื้นเทาสว่าง (CAD)',
    shortLabel: 'Light Gray',
    skySwatch: '#e6ebf2',
    floorSwatch: '#e6ebf2',
    description: 'Soft neutral engineering gray background comfortable for long commissioning sessions.',
  },
  {
    id: 'dark-studio',
    label: 'Dark Industrial',
    labelTh: 'พื้นมืด (Dark Studio)',
    shortLabel: 'Dark',
    skySwatch: '#0c1017',
    floorSwatch: '#0c1017',
    description: 'High-contrast dark Virtual Commissioning studio theme.',
  },
  {
    id: 'custom',
    label: 'Custom Color',
    labelTh: 'กำหนดสีพื้นเอง',
    shortLabel: 'Custom',
    skySwatch: '#ffffff',
    floorSwatch: '#f1f5f9',
    description: 'Choose any custom Sky / Background and Ground / Floor hex colors.',
  },
];

export interface ResolvedViewportTheme {
  id: ViewportThemeId;
  label: string;
  labelTh: string;
  shortLabel: string;
  isLight: boolean;
  backgroundColor: string;
  floorColor: string;
  hasDistinctGroundPlane: boolean;
  fogColor: string;
  fogNear: number;
  fogFar: number;
  gridCellColor: string;
  gridSectionColor: string;
  shadowOpacity: number;
  ambientIntensity: number;
  hemiSkyColor: string;
  hemiGroundColor: string;
  hemiIntensity: number;
  keyLightIntensity: number;
  fillLightColor: string;
  fillLightIntensity: number;
  selectionWireframeColor: string;
  inputPortColor: string;
}

const STORAGE_KEY = 'vc_viewport_prefs_v1';

export interface StoredViewportPrefs {
  viewportTheme?: ViewportThemeId;
  showOriginAxes?: boolean;
  showGrid?: boolean;
  customBackgroundColor?: string;
  customFloorColor?: string;
}

function normalizeHex(hex: string | undefined, fallback: string): string {
  if (!hex || typeof hex !== 'string') return fallback;
  const trimmed = hex.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

function hexToRgb01(hex: string): [number, number, number] {
  const clean = normalizeHex(hex, '#ffffff').slice(1);
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

function rgb01ToHex(r: number, g: number, b: number): string {
  const clampByte = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${clampByte(r)}${clampByte(g)}${clampByte(b)}`;
}

function computeRelativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb01(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function shiftHexBrightness(hex: string, delta: number): string {
  const [r, g, b] = hexToRgb01(hex);
  return rgb01ToHex(r + delta, g + delta, b + delta);
}

export function resolveViewportTheme(
  env: Partial<SceneEnvironmentConfig> | undefined
): ResolvedViewportTheme {
  const themeId: ViewportThemeId = env?.viewportTheme ?? 'sketchup-white';

  switch (themeId) {
    case 'sketchup-white':
      return {
        id: 'sketchup-white',
        label: 'SketchUp White',
        labelTh: 'พื้นขาวคลีน (SketchUp)',
        shortLabel: 'White',
        isLight: true,
        backgroundColor: '#f8fafc',
        floorColor: '#f8fafc',
        hasDistinctGroundPlane: false,
        fogColor: '#f8fafc',
        fogNear: 38,
        fogFar: 96,
        gridCellColor: '#dde4ee',
        gridSectionColor: '#b8c4d6',
        shadowOpacity: 0.16,
        ambientIntensity: 0.92,
        hemiSkyColor: '#ffffff',
        hemiGroundColor: '#e2e8f0',
        hemiIntensity: 0.78,
        keyLightIntensity: 1.5,
        fillLightColor: '#e0f2fe',
        fillLightIntensity: 0.62,
        selectionWireframeColor: '#0284c7',
        inputPortColor: '#0284c7',
      };

    case 'sketchup-sky':
      return {
        id: 'sketchup-sky',
        label: 'SketchUp Sky & Ground',
        labelTh: 'ท้องฟ้า + พื้นขาว (SketchUp)',
        shortLabel: 'Sky+White',
        isLight: true,
        backgroundColor: '#d4eafc',
        floorColor: '#f9fbfd',
        hasDistinctGroundPlane: true,
        fogColor: '#e3f1fc',
        fogNear: 44,
        fogFar: 135,
        gridCellColor: '#dce3ed',
        gridSectionColor: '#b6c3d6',
        shadowOpacity: 0.17,
        ambientIntensity: 0.92,
        hemiSkyColor: '#e0f2fe',
        hemiGroundColor: '#f1f5f9',
        hemiIntensity: 0.8,
        keyLightIntensity: 1.52,
        fillLightColor: '#e0f2fe',
        fillLightIntensity: 0.6,
        selectionWireframeColor: '#0284c7',
        inputPortColor: '#0284c7',
      };

    case 'cad-light-gray':
      return {
        id: 'cad-light-gray',
        label: 'CAD Light Gray',
        labelTh: 'พื้นเทาสว่าง (CAD)',
        shortLabel: 'Light Gray',
        isLight: true,
        backgroundColor: '#e6ebf2',
        floorColor: '#e6ebf2',
        hasDistinctGroundPlane: false,
        fogColor: '#e6ebf2',
        fogNear: 36,
        fogFar: 92,
        gridCellColor: '#cfd8e3',
        gridSectionColor: '#a6b4c6',
        shadowOpacity: 0.2,
        ambientIntensity: 0.88,
        hemiSkyColor: '#f8fafc',
        hemiGroundColor: '#cbd5e1',
        hemiIntensity: 0.72,
        keyLightIntensity: 1.5,
        fillLightColor: '#dbeafe',
        fillLightIntensity: 0.58,
        selectionWireframeColor: '#0284c7',
        inputPortColor: '#0284c7',
      };

    case 'dark-studio':
      return {
        id: 'dark-studio',
        label: 'Dark Industrial',
        labelTh: 'พื้นมืด (Dark Studio)',
        shortLabel: 'Dark',
        isLight: false,
        backgroundColor: '#0c1017',
        floorColor: '#0c1017',
        hasDistinctGroundPlane: false,
        fogColor: '#0c1017',
        fogNear: 26,
        fogFar: 68,
        gridCellColor: '#1b2432',
        gridSectionColor: '#2e3d52',
        shadowOpacity: 0.28,
        ambientIntensity: 0.68,
        hemiSkyColor: '#cbd5e1',
        hemiGroundColor: '#1e293b',
        hemiIntensity: 0.65,
        keyLightIntensity: 1.55,
        fillLightColor: '#bae6fd',
        fillLightIntensity: 0.52,
        selectionWireframeColor: '#22d3ee',
        inputPortColor: '#22d3ee',
      };

    case 'custom': {
      const bg = normalizeHex(env?.customBackgroundColor, '#ffffff');
      const fl = normalizeHex(env?.customFloorColor, bg);
      const lum = computeRelativeLuminance(fl);
      const isLight = lum > 0.45;
      const hasDistinctGroundPlane = bg !== fl;
      const gridCellColor = isLight
        ? shiftHexBrightness(fl, -0.09)
        : shiftHexBrightness(fl, 0.08);
      const gridSectionColor = isLight
        ? shiftHexBrightness(fl, -0.22)
        : shiftHexBrightness(fl, 0.17);

      return {
        id: 'custom',
        label: 'Custom Color',
        labelTh: 'กำหนดสีพื้นเอง',
        shortLabel: 'Custom',
        isLight,
        backgroundColor: bg,
        floorColor: fl,
        hasDistinctGroundPlane,
        fogColor: bg,
        fogNear: isLight ? 40 : 28,
        fogFar: isLight ? 110 : 74,
        gridCellColor,
        gridSectionColor,
        shadowOpacity: isLight ? 0.17 : 0.28,
        ambientIntensity: isLight ? 0.9 : 0.7,
        hemiSkyColor: isLight ? '#ffffff' : '#cbd5e1',
        hemiGroundColor: fl,
        hemiIntensity: isLight ? 0.76 : 0.65,
        keyLightIntensity: 1.52,
        fillLightColor: isLight ? '#e0f2fe' : '#bae6fd',
        fillLightIntensity: isLight ? 0.6 : 0.52,
        selectionWireframeColor: isLight ? '#0284c7' : '#22d3ee',
        inputPortColor: isLight ? '#0284c7' : '#22d3ee',
      };
    }
  }
}

export function loadSavedViewportPrefs(): StoredViewportPrefs {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {};
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredViewportPrefs;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveViewportPrefs(env: SceneEnvironmentConfig): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const payload: StoredViewportPrefs = {
      viewportTheme: env.viewportTheme ?? 'sketchup-white',
      showOriginAxes: env.showOriginAxes ?? true,
      showGrid: env.showGrid,
      customBackgroundColor: env.customBackgroundColor ?? '#ffffff',
      customFloorColor: env.customFloorColor ?? '#ffffff',
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota / private mode errors
  }
}
