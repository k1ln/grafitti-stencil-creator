import { useState, useRef, useCallback, useEffect } from 'react';

// TypeScript declaration for the Potrace singleton loaded via public/potrace.js
declare const Potrace: {
  loadImageFromUrl: (url: string) => void;
  setParameter: (p: { turdsize?: number; optcurve?: boolean; alphamax?: number; opttolerance?: number; turnpolicy?: string }) => void;
  process: (callback: () => void) => void;
  getSVG: (size: number, type?: string) => string;
};

interface ColorInfo {
  hex: string;
  rgb: [number, number, number];
  frequency: number;
}

interface StencilInfo {
  canvas: HTMLCanvasElement;
  hasIslands: boolean;
  opaquePx: number;
}

// ── CIE Lab colour helpers ────────────────────────────────────────────────
// sRGB [0,255] → CIE L*a*b* (D65). Lab is perceptually uniform: equal
// numeric differences correspond to equal perceived colour differences,
// making it ideal for palette clustering and nearest-color assignment.
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  let rl = r / 255, gl = g / 255, bl = b / 255;
  rl = rl > 0.04045 ? Math.pow((rl + 0.055) / 1.055, 2.4) : rl / 12.92;
  gl = gl > 0.04045 ? Math.pow((gl + 0.055) / 1.055, 2.4) : gl / 12.92;
  bl = bl > 0.04045 ? Math.pow((bl + 0.055) / 1.055, 2.4) : bl / 12.92;
  // Linear RGB → XYZ (D65 illuminant)
  const X = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const Y = (0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl);
  const Z = (0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / 1.08883;
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787037 * t + 16 / 116;
  return [
    116 * f(Y) - 16,          // L  0..100
    500 * (f(X) - f(Y)),      // a  −128..+127
    200 * (f(Y) - f(Z)),      // b  −128..+127
  ];
}

// CIE L*a*b* → sRGB [0,255]  (used to convert Lab K-Means centres back to RGB)
function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const eps = 0.008856, kappa = 903.3;
  const xr = fx * fx * fx > eps ? fx * fx * fx : (116 * fx - 16) / kappa;
  const yr = L > kappa * eps ? Math.pow((L + 16) / 116, 3) : L / kappa;
  const zr = fz * fz * fz > eps ? fz * fz * fz : (116 * fz - 16) / kappa;
  const X = xr * 0.95047, Y = yr, Z = zr * 1.08883;
  let rl =  3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let gl = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  let bl_ =  0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  const gc = (c: number) => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
  return [
    Math.max(0, Math.min(255, Math.round(gc(rl)  * 255))),
    Math.max(0, Math.min(255, Math.round(gc(gl)  * 255))),
    Math.max(0, Math.min(255, Math.round(gc(bl_) * 255))),
  ];
}

function mkColor(r: number, g: number, b: number): ColorInfo {
  const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  return { hex, rgb: [r, g, b], frequency: 0 };
}

const PRESET_PALETTES: Array<{ name: string; group: string; colors: ColorInfo[] }> = [
  // ── Retro Computers ───────────────────────────────────────────────────────────
  { name: 'EGA 16', group: 'Retro', colors: [
    mkColor(0,0,0),     mkColor(0,0,170),     mkColor(0,170,0),     mkColor(0,170,170),
    mkColor(170,0,0),   mkColor(170,0,170),   mkColor(170,85,0),    mkColor(170,170,170),
    mkColor(85,85,85),  mkColor(85,85,255),   mkColor(85,255,85),   mkColor(85,255,255),
    mkColor(255,85,85), mkColor(255,85,255),  mkColor(255,255,85),  mkColor(255,255,255),
  ]},
  { name: 'ZX Spectrum', group: 'Retro', colors: [
    mkColor(0,0,0),    mkColor(0,0,205),   mkColor(205,0,0),   mkColor(205,0,205),
    mkColor(0,205,0),  mkColor(0,205,205), mkColor(205,205,0), mkColor(205,205,205),
    mkColor(0,0,255),  mkColor(255,0,0),   mkColor(255,0,255), mkColor(0,255,0),
    mkColor(0,255,255),mkColor(255,255,0), mkColor(255,255,255),
  ]},
  { name: 'C64', group: 'Retro', colors: [
    mkColor(0,0,0),      mkColor(255,255,255), mkColor(159,74,68),  mkColor(106,197,204),
    mkColor(160,89,156), mkColor(92,141,67),   mkColor(80,66,148),  mkColor(208,220,113),
    mkColor(148,112,63), mkColor(92,69,28),    mkColor(195,118,112),mkColor(98,98,98),
    mkColor(137,137,137),mkColor(157,217,127), mkColor(128,120,191),mkColor(165,165,165),
  ]},
  { name: 'Apple II', group: 'Retro', colors: [
    mkColor(0,0,0),    mkColor(114,38,64),  mkColor(64,51,127),  mkColor(228,52,254),
    mkColor(14,89,0),  mkColor(128,128,128),mkColor(27,154,254), mkColor(191,205,254),
    mkColor(64,50,0),  mkColor(228,101,1),  mkColor(241,166,191),mkColor(27,203,1),
    mkColor(191,217,128),mkColor(141,228,191),mkColor(255,255,255),
  ]},
  { name: 'MSX / TMS9918', group: 'Retro', colors: [
    mkColor(0,0,0),    mkColor(33,200,66),  mkColor(94,220,120), mkColor(84,85,237),
    mkColor(125,118,252),mkColor(212,82,77),mkColor(66,235,245), mkColor(252,85,84),
    mkColor(255,121,120),mkColor(212,193,84),mkColor(230,206,128),mkColor(33,176,59),
    mkColor(201,91,186),mkColor(204,204,204),mkColor(255,255,255),
  ]},
  { name: 'Game Boy', group: 'Retro', colors: [
    mkColor(15,56,15), mkColor(48,98,48), mkColor(139,172,15), mkColor(155,188,15),
  ]},
  { name: 'CGA Cyan/Mag', group: 'Retro', colors: [
    mkColor(0,0,0), mkColor(85,255,255), mkColor(255,85,255), mkColor(255,255,255),
  ]},
  { name: 'CGA Green/Red', group: 'Retro', colors: [
    mkColor(0,0,0), mkColor(85,255,85), mkColor(255,85,85), mkColor(255,255,85),
  ]},
  // ── Pixel Art ─────────────────────────────────────────────────────────────────
  { name: 'PICO-8', group: 'Pixel Art', colors: [
    mkColor(0,0,0),      mkColor(29,43,83),    mkColor(126,37,83),  mkColor(0,135,81),
    mkColor(171,82,54),  mkColor(95,87,79),    mkColor(194,195,199),mkColor(255,241,232),
    mkColor(255,0,77),   mkColor(255,163,0),   mkColor(255,236,39), mkColor(0,228,54),
    mkColor(41,173,255), mkColor(131,118,156), mkColor(255,119,168),mkColor(255,204,170),
  ]},
  { name: 'DawnBringer 16', group: 'Pixel Art', colors: [
    mkColor(20,12,28),   mkColor(68,36,52),    mkColor(48,52,109),  mkColor(78,74,78),
    mkColor(133,76,48),  mkColor(52,101,36),   mkColor(208,70,72),  mkColor(117,113,97),
    mkColor(89,125,206), mkColor(210,125,44),  mkColor(133,149,161),mkColor(109,170,44),
    mkColor(210,170,153),mkColor(109,194,202), mkColor(218,212,94), mkColor(222,238,214),
  ]},
  { name: 'DawnBringer 32', group: 'Pixel Art', colors: [
    mkColor(0,0,0),      mkColor(34,32,52),    mkColor(69,40,60),   mkColor(102,57,49),
    mkColor(143,86,59),  mkColor(223,113,38),  mkColor(217,160,102),mkColor(238,195,154),
    mkColor(251,242,54), mkColor(153,229,80),  mkColor(106,190,48), mkColor(55,148,110),
    mkColor(75,105,47),  mkColor(82,75,36),    mkColor(50,60,57),   mkColor(63,63,116),
    mkColor(48,96,130),  mkColor(91,110,225),  mkColor(99,155,255), mkColor(95,205,228),
    mkColor(203,219,252),mkColor(255,255,255), mkColor(155,173,183),mkColor(132,126,135),
    mkColor(105,106,106),mkColor(89,86,82),    mkColor(118,66,138), mkColor(172,50,50),
    mkColor(217,87,99),  mkColor(215,123,186), mkColor(143,151,74), mkColor(138,111,48),
  ]},
  { name: 'Sweetie 16', group: 'Pixel Art', colors: [
    mkColor(26,28,44),   mkColor(93,39,93),   mkColor(177,62,83),  mkColor(239,125,87),
    mkColor(255,205,117),mkColor(167,240,112),mkColor(56,183,100), mkColor(37,113,121),
    mkColor(41,54,111),  mkColor(59,93,201),  mkColor(65,166,246), mkColor(115,239,247),
    mkColor(244,244,244),mkColor(148,176,194),mkColor(86,108,134), mkColor(51,60,87),
  ]},
  { name: 'Arne 16', group: 'Pixel Art', colors: [
    mkColor(0,0,0),      mkColor(157,157,157),mkColor(255,255,255),mkColor(190,38,51),
    mkColor(224,111,139),mkColor(73,60,43),   mkColor(164,100,34), mkColor(235,137,49),
    mkColor(247,226,107),mkColor(47,72,78),   mkColor(68,137,26),  mkColor(163,206,39),
    mkColor(27,38,50),   mkColor(0,87,132),   mkColor(49,162,242), mkColor(178,220,239),
  ]},
  // ── Stencil-Friendly ──────────────────────────────────────────────────────────
  { name: 'Street Art', group: 'Stencil', colors: [
    mkColor(0,0,0),      mkColor(255,255,255),mkColor(220,20,60),  mkColor(255,69,0),
    mkColor(255,215,0),  mkColor(0,200,100),  mkColor(0,100,220),  mkColor(148,0,211),
    mkColor(255,105,180),mkColor(0,230,230),  mkColor(40,40,40),   mkColor(200,200,200),
    mkColor(180,100,0),  mkColor(0,140,0),    mkColor(255,140,50), mkColor(100,0,200),
  ]},
  { name: 'High Contrast 8', group: 'Stencil', colors: [
    mkColor(0,0,0),   mkColor(255,255,255),mkColor(220,20,60), mkColor(0,180,0),
    mkColor(0,50,220),mkColor(255,220,0),  mkColor(255,120,0), mkColor(155,0,240),
  ]},
  { name: 'Grayscale 4', group: 'Stencil', colors: [
    mkColor(0,0,0), mkColor(85,85,85), mkColor(170,170,170), mkColor(255,255,255),
  ]},
];

// ── Module-level canvas helpers ──────────────────────────────────────────────

function countOpaquePx(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] >= 128) n++;
  return n;
}

/**
 * Converts a stencil canvas to a smooth vector SVG using the Potrace algorithm.
 * Potrace fits Bezier curves and straight segments to the pixel bitmap, producing
 * compact, high-quality paths ideal for cutting plotters (Silhouette, Cricut…).
 */
function canvasToSVGPotrace(canvas: HTMLCanvasElement, fillColor: string): Promise<string> {
  return new Promise(resolve => {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!ctx || typeof (window as any).Potrace === 'undefined') { resolve(''); return; }

    // Build black-on-white temp canvas: opaque pixels → black, transparent → white.
    // Potrace traces dark regions (luminance < 128) as foreground.
    const src = ctx.getImageData(0, 0, w, h);
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tmpCtx = tmp.getContext('2d')!;
    const out = tmpCtx.createImageData(w, h);
    const od = out.data;
    for (let i = 0; i < w * h; i++) {
      if (src.data[i * 4 + 3] >= 128) {
        od[i * 4 + 3] = 255; // black (r,g,b stay 0)
      } else {
        od[i * 4] = 255; od[i * 4 + 1] = 255; od[i * 4 + 2] = 255; od[i * 4 + 3] = 255; // white
      }
    }
    tmpCtx.putImageData(out, 0, 0);

    Potrace.setParameter({ turdsize: 0, optcurve: true, alphamax: 1, opttolerance: 0.2 });
    Potrace.loadImageFromUrl(tmp.toDataURL());
    Potrace.process(() => {
      let svg = Potrace.getSVG(1);
      // Swap default black fill to the stencil's actual colour
      svg = svg.replace('fill="black"', `fill="${fillColor}"`);
      // Inject white background rect right after the opening <svg> tag
      svg = svg.replace('><path', `><rect width="${w}" height="${h}" fill="white"/><path`);
      resolve(svg);
    });
  });
}

function downloadSVG(svgContent: string, filename: string) {
  const blob = new Blob([svgContent], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/**
 * Otsu's method — finds the optimal binary threshold from a 256-bin histogram
 * that maximises the inter-class variance of the two resulting groups.
 * Returns a value in [0, 255].
 */
function otsuValue(hist: Uint32Array): number {
  let total = 0, sumAll = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sumAll += i * hist[i]; }
  if (total === 0) return 128;
  let wB = 0, sumB = 0, maxVar = 0, threshold = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; threshold = t; }
  }
  return threshold;
}

// ── HSL colour helpers ─────────────────────────────────────────────────────
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (t: number): number => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    r = hue2rgb(h + 1 / 3); g = hue2rgb(h); b = hue2rgb(h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function App() {
  const [originalImageData, setOriginalImageData] = useState<ImageData | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{width: number, height: number} | null>(null);
  const [colors, setColors] = useState<ColorInfo[]>([]);
  const [selectedColorIndex, setSelectedColorIndex] = useState<number>(0);
  const [paletteSize, setPaletteSize] = useState<number>(4);
  const [stencilCanvases, setStencilCanvases] = useState<StencilInfo[]>([]);
  const [processingProgress, setProcessingProgress] = useState<{current: number, total: number, label: string} | null>(null);
  const isGeneratingRef = useRef(false);
  const colorsEditedRef = useRef(false); // true when user has manually edited colors
  const [mergeSelection, setMergeSelection] = useState<Set<number>>(new Set());
  const [contrast, setContrast] = useState<number>(180);
  const [simplify, setSimplify] = useState<number>(0);
  const [posterize, setPosterize] = useState<number>(0);
  const [warmth, setWarmth] = useState<number>(0);
  const [bridgeWidth, setBridgeWidth] = useState<number>(4);
  const [minIslandSize, setMinIslandSize] = useState<number>(50);
  const [islandCleanupSize, setIslandCleanupSize] = useState<number>(0);
  const [displayStencils, setDisplayStencils] = useState<StencilInfo[]>([]);
  const [svgPreviewContent, setSvgPreviewContent] = useState<string | null>(null);
  const [svgPreviewBuilding, setSvgPreviewBuilding] = useState(false);
  const [selection, setSelection] = useState<{x: number, y: number, w: number, h: number} | null>(null);
  const [selectedPalette, setSelectedPalette] = useState<string>('auto');
  const [visibleLayers, setVisibleLayers] = useState<Set<number>>(new Set());
  // ── Color effects ──────────────────────────────────────────────────────────
  const [brightness, setBrightness] = useState(100);
  const [saturation, setSaturation] = useState(100);
  const [hue, setHue] = useState(0);
  const [invertColors, setInvertColors] = useState(false);
  // ── Background cutout ──────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState<'select' | 'erase' | 'wand'>('select');
  const [brushSize, setBrushSize] = useState(20);
  const [maskTolerance, setMaskTolerance] = useState(20);
  const [hasMask, setHasMask] = useState(false);
  const [eraseCursor, setEraseCursor] = useState<{cssX: number, cssY: number} | null>(null);
  // ── Chroma key ─────────────────────────────────────────────────────────────
  const [chromaKeyEnabled, setChromaKeyEnabled] = useState(false);
  const [chromaColor, setChromaColor] = useState('#ffffff');
  const [chromaTolerance, setChromaTolerance] = useState(30);
  const selectionDragRef = useRef<{startX: number, startY: number} | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rawImageRef = useRef<HTMLImageElement | null>(null);
  const alphaMaskRef = useRef<Uint8ClampedArray | null>(null);
  const isErasingRef = useRef(false);

  const rgbToHex = useCallback((r: number, g: number, b: number): string => {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
     }, []);

  const hexToRgb = useCallback((hex: string): [number, number, number] => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return [0, 0, 0];
    return [
      parseInt(result[1], 16),
      parseInt(result[2], 16),
      parseInt(result[3], 16)
       ];
     }, []);

  // Perceptual colour distance in CIE Lab space (ΔE)
  const colorDistance = useCallback((rgb1: [number, number, number], rgb2: [number, number, number]): number => {
    const [L1, a1, b1] = rgbToLab(rgb1[0], rgb1[1], rgb1[2]);
    const [L2, a2, b2] = rgbToLab(rgb2[0], rgb2[1], rgb2[2]);
    const dL = L1 - L2, da = a1 - a2, db = b1 - b2;
    return Math.sqrt(dL * dL + da * da + db * db);
  }, []);

  // WebGL-accelerated: generate all stencil layers in one GPU pass per color
  const generateAllStencilsWebGL = useCallback((
    imageData: ImageData,
    width: number,
    height: number,
    targetColors: ColorInfo[]
  ): HTMLCanvasElement[] | null => {
    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const gl = offscreen.getContext('webgl');
    if (!gl) return null;

    const vsSource = `
      attribute vec2 a_position;
      varying vec2 v_texCoord;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
      }
    `;
    const fsSource = `
      precision highp float;
      uniform sampler2D u_image;
      uniform vec3 u_palette[20];
      uniform int u_targetIndex;
      uniform vec3 u_targetColor;
      varying vec2 v_texCoord;

      // sRGB [0,1] -> CIE L*a*b* for perceptually-uniform nearest-colour search
      vec3 srgbToLab(vec3 c) {
        vec3 lin;
        lin.r = c.r <= 0.04045 ? c.r / 12.92 : pow((c.r + 0.055) / 1.055, 2.4);
        lin.g = c.g <= 0.04045 ? c.g / 12.92 : pow((c.g + 0.055) / 1.055, 2.4);
        lin.b = c.b <= 0.04045 ? c.b / 12.92 : pow((c.b + 0.055) / 1.055, 2.4);
        float X = (0.4124564*lin.r + 0.3575761*lin.g + 0.1804375*lin.b) / 0.95047;
        float Y =  0.2126729*lin.r + 0.7151522*lin.g + 0.0721750*lin.b;
        float Z = (0.0193339*lin.r + 0.1191920*lin.g + 0.9503041*lin.b) / 1.08883;
        float fx = X > 0.008856 ? pow(X, 0.333333) : 7.787037*X + 0.137931;
        float fy = Y > 0.008856 ? pow(Y, 0.333333) : 7.787037*Y + 0.137931;
        float fz = Z > 0.008856 ? pow(Z, 0.333333) : 7.787037*Z + 0.137931;
        return vec3(116.0*fy - 16.0, 500.0*(fx - fy), 200.0*(fy - fz));
      }

      void main() {
        vec4 pixel = texture2D(u_image, v_texCoord);
        if (pixel.a < 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0); return; }
        vec3 pixLab = srgbToLab(pixel.rgb);
        float minDist = 1.0e10;
        int closestIdx = 0;
        for (int i = 0; i < 20; i++) {
          vec3 palLab = srgbToLab(u_palette[i]);
          vec3 diff = pixLab - palLab;
          float dist = dot(diff, diff);
          if (dist < minDist) { minDist = dist; closestIdx = i; }
        }
        if (closestIdx == u_targetIndex) {
          gl_FragColor = vec4(u_targetColor, 1.0);
        } else {
          gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        }
      }
    `;

    const compileShader = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('Shader error:', gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
      }
      return s;
    };

    const vs = compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      return null;
    }
    gl.useProgram(program);

    // Fullscreen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Upload image as texture (without flip — compensated in vertex shader UV)
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageData);
    gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0);

    // Upload palette (unused slots filled with 2.0 — outside [0,1] range, never closest)
    const paletteFlat = new Float32Array(20 * 3).fill(2.0);
    for (let i = 0; i < targetColors.length; i++) {
      const [r, g, b] = targetColors[i].rgb;
      paletteFlat[i * 3]     = r / 255;
      paletteFlat[i * 3 + 1] = g / 255;
      paletteFlat[i * 3 + 2] = b / 255;
    }
    gl.uniform3fv(gl.getUniformLocation(program, 'u_palette[0]'), paletteFlat);

    const targetIndexLoc = gl.getUniformLocation(program, 'u_targetIndex');
    const targetColorLoc = gl.getUniformLocation(program, 'u_targetColor');
    gl.viewport(0, 0, width, height);

    const rawPixels = new Uint8Array(width * height * 4);
    const flippedData = new Uint8ClampedArray(width * height * 4);
    const results: HTMLCanvasElement[] = [];

    for (let colorIdx = 0; colorIdx < targetColors.length; colorIdx++) {
      const [r, g, b] = targetColors[colorIdx].rgb;
      gl.uniform1i(targetIndexLoc, colorIdx);
      gl.uniform3f(targetColorLoc, r / 255, g / 255, b / 255);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rawPixels);

      // readPixels is bottom-first; flip to top-first for ImageData
      for (let y = 0; y < height; y++) {
        const src = (height - 1 - y) * width * 4;
        flippedData.set(rawPixels.subarray(src, src + width * 4), y * width * 4);
      }

      const resultCanvas = document.createElement('canvas');
      resultCanvas.width = width;
      resultCanvas.height = height;
      resultCanvas.getContext('2d')!.putImageData(new ImageData(flippedData.slice(), width, height), 0, 0);
      results.push(resultCanvas);
    }

    return results;
  }, []);

  // Apply contrast + blur + posterization + color effects to raw image, returns adjusted ImageData.
  // Pass mask=null to get the un-masked result (for storing in originalImageData);
  // mask is applied separately for display and stencil generation.
  const applyContrastAndBlur = useCallback((
    img: HTMLImageElement, contrastVal: number, simplifyVal: number, posterizeVal: number,
    width: number, height: number,
    brightnessVal = 100, saturationVal = 100, hueVal = 0, invertVal = false,
    chromaEnabled = false, chromaHex = '#ffffff', chromaTol = 30,
  ): ImageData => {
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const scratchCtx = scratch.getContext('2d', { willReadFrequently: true })!;

    // Apply blur via CSS filter before drawing (simplify)
    if (simplifyVal > 0) {
      scratchCtx.filter = `blur(${simplifyVal}px)`;
    }
    scratchCtx.drawImage(img, 0, 0, width, height);
    scratchCtx.filter = 'none';

    const imageData = scratchCtx.getImageData(0, 0, width, height);
    const data = imageData.data;

    // Apply contrast
    const factor = contrastVal / 100.0;
    for (let i = 0; i < data.length; i += 4) {
      data[i]     = Math.max(0, Math.min(255, Math.round((data[i]     - 128) * factor + 128)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round((data[i + 1] - 128) * factor + 128)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round((data[i + 2] - 128) * factor + 128)));
    }

    // Apply posterization: quantize each channel to N levels
    if (posterizeVal >= 2) {
      const levels = posterizeVal;
      const step = 255 / (levels - 1);
      for (let i = 0; i < data.length; i += 4) {
        data[i]     = Math.round(Math.round(data[i]     / step) * step);
        data[i + 1] = Math.round(Math.round(data[i + 1] / step) * step);
        data[i + 2] = Math.round(Math.round(data[i + 2] / step) * step);
      }
    }

    // Invert
    if (invertVal) {
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        data[i] = 255 - data[i]; data[i + 1] = 255 - data[i + 1]; data[i + 2] = 255 - data[i + 2];
      }
    }

    // Brightness + Saturation + Hue (single combined HSL pass)
    if (brightnessVal !== 100 || saturationVal !== 100 || hueVal !== 0) {
      const bf = brightnessVal / 100;
      const sf = saturationVal / 100;
      const hf = hueVal / 360;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        let r = data[i], g = data[i + 1], b = data[i + 2];
        if (brightnessVal !== 100) {
          r = Math.max(0, Math.min(255, r * bf)) | 0;
          g = Math.max(0, Math.min(255, g * bf)) | 0;
          b = Math.max(0, Math.min(255, b * bf)) | 0;
        }
        if (saturationVal !== 100 || hueVal !== 0) {
          let [h, s, l] = rgbToHsl(r, g, b);
          if (saturationVal !== 100) s = Math.max(0, Math.min(1, s * sf));
          if (hueVal !== 0) h = ((h + hf) % 1 + 1) % 1;
          [r, g, b] = hslToRgb(h, s, l);
        }
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
      }
    }

    // Chroma key – make pixels within Lab tolerance of chromaHex transparent
    if (chromaEnabled && chromaHex) {
      const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(chromaHex);
      if (m) {
        const targetLab = rgbToLab(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue;
          const pLab = rgbToLab(data[i], data[i + 1], data[i + 2]);
          const dE = Math.sqrt((pLab[0] - targetLab[0]) ** 2 + (pLab[1] - targetLab[1]) ** 2 + (pLab[2] - targetLab[2]) ** 2);
          if (dE <= chromaTol) data[i + 3] = 0;
        }
      }
    }

    scratchCtx.putImageData(imageData, 0, 0);
    return scratchCtx.getImageData(0, 0, width, height);
  }, []);

  // Connect islands to boundary — 8-connected BFS (diagonal moves) for true shortest paths,
  // then draw each bridge with configurable thickness via square dilation.
  // Islands smaller than minIslandPx are filled (erased) instead of bridged.
  const bridgeIslands = useCallback((canvas: HTMLCanvasElement, bridgeHalfW: number, minIslandPx: number): void => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const width = canvas.width;
    const height = canvas.height;
    const n = width * height;

    // Read stencil fill color from first opaque pixel (all opaque pixels share the same color
    // after morphologicalClose). Used when filling island holes so they don't turn black.
    let fillR = 0, fillG = 0, fillB = 0;
    for (let i = 0; i < n; i++) {
      if (data[i * 4 + 3] >= 128) { fillR = data[i * 4]; fillG = data[i * 4 + 1]; fillB = data[i * 4 + 2]; break; }
    }
    const fillPx = (px: number) => {
      data[px * 4] = fillR; data[px * 4 + 1] = fillG; data[px * 4 + 2] = fillB; data[px * 4 + 3] = 255;
    };

    // 8-connectivity offsets: 4 cardinal + 4 diagonal
    const DX = [-1, 1, 0, 0, -1, -1, 1,  1];
    const DY = [ 0, 0,-1, 1, -1,  1,-1,  1];

    // Step 1: flood-fill to find all boundary-connected white pixels (4-connected is fine here)
    const isBoundaryWhite = new Uint8Array(n);
    const q1: number[] = [];
    const tryB = (px: number) => {
      if (!isBoundaryWhite[px] && data[px * 4 + 3] === 0) { isBoundaryWhite[px] = 1; q1.push(px); }
    };
    for (let x = 0; x < width; x++) { tryB(x); tryB((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { tryB(y * width); tryB(y * width + width - 1); }
    let head = 0;
    while (head < q1.length) {
      const px = q1[head++];
      const x = px % width, y = (px / width) | 0;
      if (x > 0 && !isBoundaryWhite[px-1] && data[(px-1)*4+3]===0) { isBoundaryWhite[px-1]=1; q1.push(px-1); }
      if (x < width-1 && !isBoundaryWhite[px+1] && data[(px+1)*4+3]===0) { isBoundaryWhite[px+1]=1; q1.push(px+1); }
      if (y > 0 && !isBoundaryWhite[px-width] && data[(px-width)*4+3]===0) { isBoundaryWhite[px-width]=1; q1.push(px-width); }
      if (y < height-1 && !isBoundaryWhite[px+width] && data[(px+width)*4+3]===0) { isBoundaryWhite[px+width]=1; q1.push(px+width); }
    }

    // Step 2: 0-1 BFS from all boundary-connected whites (8-connected).
    // Cost 0 for transparent pixels (already free path), cost 1 for opaque pixels (stencil cut).
    // This finds paths that detour through white gaps/turns to minimise stencil material cut.
    const dist = new Int32Array(n).fill(2147483647);
    const parent = new Int32Array(n).fill(-1);
    const processed = new Uint8Array(n);
    let curBucket: number[] = [];
    let nxtBucket: number[] = [];
    for (let i = 0; i < n; i++) { if (isBoundaryWhite[i]) { dist[i] = 0; curBucket.push(i); } }
    while (curBucket.length > 0) {
      nxtBucket.length = 0;
      let bIdx = 0;
      while (bIdx < curBucket.length) {
        const px = curBucket[bIdx++];
        if (processed[px]) continue;
        processed[px] = 1;
        const x = px % width, y = (px / width) | 0;
        for (let d = 0; d < 8; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nb = ny * width + nx;
          if (processed[nb]) continue;
          const cost = data[nb * 4 + 3] !== 0 ? 1 : 0;
          const nd = dist[px] + cost;
          if (nd < dist[nb]) {
            dist[nb] = nd; parent[nb] = px;
            if (cost === 0) curBucket.push(nb); else nxtBucket.push(nb);
          }
        }
      }
      const tmp = curBucket; curBucket = nxtBucket; nxtBucket = tmp;
    }

    // Step 3: Find island components (white, not boundary-connected) via 4-connectivity
    const compVisited = new Uint8Array(n);
    for (let i = 0; i < n; i++) compVisited[i] = isBoundaryWhite[i];

    // Collect bridge pixel sets before writing (avoid corrupting BFS data)
    const bridgePaths: number[][] = [];

    for (let startPx = 0; startPx < n; startPx++) {
      if (compVisited[startPx] || data[startPx * 4 + 3] !== 0) { compVisited[startPx] = 1; continue; }

      // Collect island component
      const component: number[] = [];
      const cq = [startPx];
      compVisited[startPx] = 1;
      let cHead = 0;
      while (cHead < cq.length) {
        const px = cq[cHead++];
        component.push(px);
        const x = px % width, y = (px / width) | 0;
        if (x > 0 && !compVisited[px-1] && data[(px-1)*4+3]===0) { compVisited[px-1]=1; cq.push(px-1); }
        if (x < width-1 && !compVisited[px+1] && data[(px+1)*4+3]===0) { compVisited[px+1]=1; cq.push(px+1); }
        if (y > 0 && !compVisited[px-width] && data[(px-width)*4+3]===0) { compVisited[px-width]=1; cq.push(px-width); }
        if (y < height-1 && !compVisited[px+width] && data[(px+width)*4+3]===0) { compVisited[px+width]=1; cq.push(px+width); }
      }

      // Small islands: fill with stencil color
      if (component.length <= minIslandPx) {
        for (const px of component) fillPx(px);
        continue;
      }

      // Find island pixel with the minimum stencil-cut cost to any boundary white (from 0-1 BFS)
      let bestPx = component[0], bestCut = dist[component[0]];
      for (const px of component) {
        if (dist[px] < bestCut) { bestCut = dist[px]; bestPx = px; }
      }

      // Trace the bridge path through parent pointers
      const path: number[] = [];
      let cur = bestPx;
      while (cur !== -1 && !isBoundaryWhite[cur]) { path.push(cur); cur = parent[cur]; }

      // If the minimum stencil cuts needed >= island size, filling is cheaper than bridging
      if (bestCut >= component.length) {
        for (const px of component) fillPx(px);
        continue;
      }

      bridgePaths.push(path);
    }

    // Draw all bridges — carve each path pixel white, then dilate by bridgeHalfW
    for (const path of bridgePaths) {
      for (const px of path) {
        const x = px % width, y = (px / width) | 0;
        // Square dilation for bridge thickness
        for (let dy = -bridgeHalfW; dy <= bridgeHalfW; dy++) {
          for (let dx = -bridgeHalfW; dx <= bridgeHalfW; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              data[(ny * width + nx) * 4 + 3] = 0; // carve white
            }
          }
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }, []);

  // Morphological closing using 2D integral image — O(N) regardless of radius
  // Fills small gaps and holes inside color regions, producing clean cuttable shapes
  const morphologicalClose = useCallback((canvas: HTMLCanvasElement, radius: number, color: ColorInfo): void => {
    if (radius <= 0) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const width = canvas.width;
    const height = canvas.height;
    const n = width * height;

    // Build binary alpha mask
    const alpha = new Uint8Array(n);
    for (let i = 0; i < n; i++) alpha[i] = data[i * 4 + 3] > 0 ? 1 : 0;

    // Build 2D prefix sum — allows O(1) rectangular window queries
    const sw = width + 1;
    const buildPrefix = (mask: Uint8Array): Int32Array => {
      const S = new Int32Array((width + 1) * (height + 1));
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          S[(y + 1) * sw + (x + 1)] = mask[y * width + x]
            + S[y * sw + (x + 1)]
            + S[(y + 1) * sw + x]
            - S[y * sw + x];
        }
      }
      return S;
    };

    const querySum = (S: Int32Array, x0: number, y0: number, x1: number, y1: number): number =>
      S[(y1 + 1) * sw + (x1 + 1)] - S[y0 * sw + (x1 + 1)] - S[(y1 + 1) * sw + x0] + S[y0 * sw + x0];

    // Dilation: pixel is 1 if any pixel in the square window is 1 — O(N)
    const dilate = (mask: Uint8Array): Uint8Array => {
      const S = buildPrefix(mask);
      const out = new Uint8Array(n);
      for (let y = 0; y < height; y++) {
        const y0 = Math.max(0, y - radius), y1 = Math.min(height - 1, y + radius);
        for (let x = 0; x < width; x++) {
          out[y * width + x] = querySum(S, Math.max(0, x - radius), y0, Math.min(width - 1, x + radius), y1) > 0 ? 1 : 0;
        }
      }
      return out;
    };

    // Erosion: pixel is 1 only if all pixels in the square window are 1 — O(N)
    const erode = (mask: Uint8Array): Uint8Array => {
      const S = buildPrefix(mask);
      const out = new Uint8Array(n);
      for (let y = 0; y < height; y++) {
        const y0 = Math.max(0, y - radius), y1 = Math.min(height - 1, y + radius);
        for (let x = 0; x < width; x++) {
          const x0 = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius);
          out[y * width + x] = querySum(S, x0, y0, x1, y1) === (x1 - x0 + 1) * (y1 - y0 + 1) ? 1 : 0;
        }
      }
      return out;
    };

    // Closing = dilate then erode
    const closed = erode(dilate(alpha));

    const [r, g, b] = color.rgb;
    for (let i = 0; i < n; i++) {
      if (closed[i]) {
        data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
      } else {
        data[i * 4 + 3] = 0;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }, []);

  // Remove colored blobs smaller than minSize pixels (sets them transparent)
  const removeSmallRegions = useCallback((canvas: HTMLCanvasElement, minSize: number): void => {
    if (minSize <= 0) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const width = canvas.width;
    const height = canvas.height;
    const visited = new Uint8Array(width * height);

    for (let startY = 0; startY < height; startY++) {
      for (let startX = 0; startX < width; startX++) {
        const startPx = startY * width + startX;
        if (visited[startPx]) continue;
        if (data[startPx * 4 + 3] === 0) { visited[startPx] = 1; continue; } // transparent

        // BFS to find all connected pixels of this component
        const component: number[] = [];
        const stack = [startPx];
        visited[startPx] = 1;

        while (stack.length > 0) {
          const px = stack.pop()!;
          component.push(px);
          const x = px % width;
          const y = Math.floor(px / width);

          const neighbors = [
            y > 0          ? px - width : -1,
            y < height - 1 ? px + width : -1,
            x > 0          ? px - 1     : -1,
            x < width - 1  ? px + 1     : -1,
          ];
          for (const n of neighbors) {
            if (n >= 0 && !visited[n] && data[n * 4 + 3] !== 0) {
              visited[n] = 1;
              stack.push(n);
            }
          }
        }

        // If blob too small, erase it
        if (component.length < minSize) {
          for (const px of component) {
            data[px * 4 + 3] = 0;
          }
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }, []);

  // Detect islands (white areas not connected to canvas boundary)
  const detectIslands = useCallback((canvas: HTMLCanvasElement): boolean => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const visited = new Set<number>();
    const width = canvas.width;
    const height = canvas.height;

    // Flood fill from boundaries to mark all boundary-connected white pixels
    const floodFill = (startX: number, startY: number) => {
      const queue = [[startX, startY]];
      while (queue.length > 0) {
        const [x, y] = queue.shift()!;
        const index = (y * width + x) * 4;
        
        if (visited.has(index)) continue;
        
        // Check if pixel is white (alpha = 0, fully transparent)
        if (data[index + 3] !== 0) continue;
        
        visited.add(index);
        
        // Add neighbors
        if (x > 0) queue.push([x - 1, y]);
        if (x < width - 1) queue.push([x + 1, y]);
        if (y > 0) queue.push([x, y - 1]);
        if (y < height - 1) queue.push([x, y + 1]);
      }
    };

    // Start flood fill from all boundary white pixels
    for (let x = 0; x < width; x++) {
      // Top row
      if (data[(0 * width + x) * 4 + 3] === 0) floodFill(x, 0);
      // Bottom row
      if (data[((height - 1) * width + x) * 4 + 3] === 0) floodFill(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
      // Left column
      if (data[(y * width + 0) * 4 + 3] === 0) floodFill(0, y);
      // Right column
      if (data[(y * width + (width - 1)) * 4 + 3] === 0) floodFill(width - 1, y);
    }

    // Check if any white pixels were NOT visited (these are islands)
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] === 0 && !visited.has(i - 3)) {
        return true; // Island found
      }
    }
    return false; // No islands
  }, []);

  /**
   * Cross-stencil island absorption.
   * Scans every stencil for connected components of opaque pixels that are
   * <= maxSize pixels. Each such "speck" is reassigned to whichever neighbouring
   * stencil shares the most border with it (or turned transparent if the speck
   * is surrounded mostly by background). Returns a new array of StencilInfo;
   * the original canvases are not modified.
   */
  const applyIslandCleanup = useCallback((
    infos: StencilInfo[],
    maxSize: number,
    width: number,
    height: number
  ): StencilInfo[] => {
    if (maxSize <= 0 || infos.length === 0) return infos;
    const n = infos.length;
    const total = width * height;

    // Read pixel data once per stencil
    const pixelDatas: Uint8ClampedArray[] = infos.map(info =>
      info.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height).data
    );

    // Build pixel ownership map: which stencil index owns each pixel? -1 = background
    const ownership = new Int16Array(total).fill(-1);
    for (let si = 0; si < n; si++) {
      const d = pixelDatas[si];
      for (let pi = 0; pi < total; pi++) {
        if (d[pi * 4 + 3] >= 128) ownership[pi] = si;
      }
    }

    const newOwnership = new Int16Array(ownership);
    // Use a single byte array where value `si+1` means "visited for stencil si".
    // This avoids stencils 1..n-1 being skipped because stencil 0's pass
    // pre-marked their pixels as visited.
    const visited = new Uint8Array(total);

    for (let si = 0; si < n; si++) {
      const mark = si + 1; // 1-based so 0 stays "unvisited for this stencil"
      for (let pi = 0; pi < total; pi++) {
        if (visited[pi] === mark) continue;      // already handled for this stencil
        if (ownership[pi] !== si) continue;      // not this stencil's pixel
        visited[pi] = mark;

        // BFS — collect connected component for stencil si
        const component: number[] = [pi];
        let head = 0;
        while (head < component.length) {
          const p = component[head++];
          const x = p % width, y = (p / width) | 0;
          const NBRS = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1];
          for (const nb of NBRS) {
            if (nb >= 0 && visited[nb] !== mark && ownership[nb] === si) { visited[nb] = mark; component.push(nb); }
          }
        }

        if (component.length > maxSize) continue; // keep as-is

        // Count contacts with other stencils / background
        const nbCount = new Int32Array(n);
        let bgCount = 0;
        for (const p of component) {
          const x = p % width, y = (p / width) | 0;
          const NBRS = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1];
          for (const nb of NBRS) {
            if (nb < 0) continue;
            const o = ownership[nb];
            if (o === -1) bgCount++;
            else if (o !== si) nbCount[o]++;
          }
        }

        // Best absorber: stencil with most contact, fallback to background
        let bestStencil = -1, bestCount = bgCount;
        for (let j = 0; j < n; j++) {
          if (nbCount[j] > bestCount) { bestCount = nbCount[j]; bestStencil = j; }
        }

        for (const p of component) newOwnership[p] = bestStencil;
      }
    }

    // Build output canvases from updated ownership
    return infos.map((info, si) => {
      const srcD = pixelDatas[si];
      // Determine this stencil's fill colour from first opaque pixel
      let fillR = 0, fillG = 0, fillB = 0;
      for (let pi = 0; pi < total; pi++) {
        if (srcD[pi * 4 + 3] >= 128) { fillR = srcD[pi * 4]; fillG = srcD[pi * 4 + 1]; fillB = srcD[pi * 4 + 2]; break; }
      }

      const newCanvas = document.createElement('canvas');
      newCanvas.width = width; newCanvas.height = height;
      const newCtx = newCanvas.getContext('2d')!;
      const outData = newCtx.createImageData(width, height);
      const nd = outData.data;

      for (let pi = 0; pi < total; pi++) {
        if (newOwnership[pi] === si) {
          if (ownership[pi] === si) {
            // Original pixel — keep exact colour
            nd[pi * 4] = srcD[pi * 4]; nd[pi * 4 + 1] = srcD[pi * 4 + 1]; nd[pi * 4 + 2] = srcD[pi * 4 + 2]; nd[pi * 4 + 3] = 255;
          } else {
            // Absorbed from another stencil — use this stencil's fill colour
            nd[pi * 4] = fillR; nd[pi * 4 + 1] = fillG; nd[pi * 4 + 2] = fillB; nd[pi * 4 + 3] = 255;
          }
        }
        // else stays transparent
      }

      newCtx.putImageData(outData, 0, 0);
      return { canvas: newCanvas, hasIslands: false, opaquePx: countOpaquePx(newCanvas) };
    });
  }, []);

  /**
   * K-Means++ colour clustering.
   * Uses deterministic farthest-point seeding: first center = most saturated pixel,
   * subsequent centers = pixel farthest from all existing centers.
   * Runs up to 30 EM iterations and returns `size` ColorInfo entries sorted by frequency.
   */
  const extractColors = useCallback((imageData: ImageData, k: number): ColorInfo[] => {
    const pixels = imageData.data;
    const n = pixels.length / 4;

    // ── 1. Build a flat sample array (max ~10 000 pixels for speed) ──────────
    const step = Math.max(1, Math.floor(n / 10000));
    // flat triplet storage: [r0,g0,b0, r1,g1,b1, ...]
    const tmp: number[] = [];
    for (let i = 0; i < n; i += step) {
      if (pixels[i * 4 + 3] < 128) continue;
      tmp.push(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]);
    }
    const sn = tmp.length / 3; // number of sample pixels
    if (sn < k) return [];
    const samples = new Float32Array(tmp);

    // ── 2. Pre-convert all samples to CIE Lab (perceptually uniform space) ───
    // Clustering in Lab means equal numeric distances map to equal perceived
    // colour differences — centres converge to genuinely distinct hues rather
    // than being pulled together by non-linearities in sRGB.
    const labSamples = new Float32Array(sn * 3);
    for (let si = 0; si < sn; si++) {
      const [L, a, b] = rgbToLab(samples[si * 3], samples[si * 3 + 1], samples[si * 3 + 2]);
      labSamples[si * 3] = L; labSamples[si * 3 + 1] = a; labSamples[si * 3 + 2] = b;
    }

    // ── 3. Farthest-point initialisation (K-Means++ style, in Lab space) ─────
    const cL = new Float32Array(k), cA = new Float32Array(k), cB = new Float32Array(k);

    // First center: most saturated pixel (high chroma = large a²+b² in Lab)
    let bestChroma = -1, firstIdx = 0;
    for (let si = 0; si < sn; si++) {
      const a = labSamples[si * 3 + 1], b = labSamples[si * 3 + 2];
      const chroma = a * a + b * b;
      if (chroma > bestChroma) { bestChroma = chroma; firstIdx = si; }
    }
    cL[0] = labSamples[firstIdx * 3]; cA[0] = labSamples[firstIdx * 3 + 1]; cB[0] = labSamples[firstIdx * 3 + 2];

    const minDistToCenter = new Float32Array(sn).fill(Infinity);
    for (let ki = 1; ki < k; ki++) {
      const pL = cL[ki - 1], pA = cA[ki - 1], pBv = cB[ki - 1];
      let farthest = 0, farthestIdx = 0;
      for (let si = 0; si < sn; si++) {
        const dL = labSamples[si * 3] - pL, dA = labSamples[si * 3 + 1] - pA, dBv = labSamples[si * 3 + 2] - pBv;
        const d = dL * dL + dA * dA + dBv * dBv;
        if (d < minDistToCenter[si]) minDistToCenter[si] = d;
        if (minDistToCenter[si] > farthest) { farthest = minDistToCenter[si]; farthestIdx = si; }
      }
      cL[ki] = labSamples[farthestIdx * 3]; cA[ki] = labSamples[farthestIdx * 3 + 1]; cB[ki] = labSamples[farthestIdx * 3 + 2];
    }

    // ── 4. K-Means EM iterations in Lab space ────────────────────────────────
    const assignments = new Int32Array(sn);
    for (let iter = 0; iter < 30; iter++) {
      let changed = false;

      // E-step: assign each sample to nearest Lab centre
      for (let si = 0; si < sn; si++) {
        const sL = labSamples[si * 3], sA = labSamples[si * 3 + 1], sBv = labSamples[si * 3 + 2];
        let best = 0, bestD = Infinity;
        for (let ki = 0; ki < k; ki++) {
          const dL = sL - cL[ki], dA = sA - cA[ki], dBv = sBv - cB[ki];
          const d = dL * dL + dA * dA + dBv * dBv;
          if (d < bestD) { bestD = d; best = ki; }
        }
        if (assignments[si] !== best) { assignments[si] = best; changed = true; }
      }
      if (!changed) break;

      // M-step: recompute Lab centres as mean of assigned samples
      const sumL = new Float64Array(k), sumA = new Float64Array(k), sumBv = new Float64Array(k);
      const cnt = new Int32Array(k);
      for (let si = 0; si < sn; si++) {
        const a = assignments[si];
        sumL[a] += labSamples[si * 3]; sumA[a] += labSamples[si * 3 + 1]; sumBv[a] += labSamples[si * 3 + 2];
        cnt[a]++;
      }
      for (let ki = 0; ki < k; ki++) {
        if (cnt[ki] > 0) { cL[ki] = sumL[ki] / cnt[ki]; cA[ki] = sumA[ki] / cnt[ki]; cB[ki] = sumBv[ki] / cnt[ki]; }
      }
    }

    // ── 5. Build ColorInfo — convert Lab centres back to sRGB ────────────────
    const freq = new Int32Array(k);
    for (let si = 0; si < sn; si++) freq[assignments[si]]++;
    return Array.from({ length: k }, (_, ki) => {
      const [r, g, b] = labToRgb(cL[ki], cA[ki], cB[ki]);
      return { hex: rgbToHex(r, g, b), rgb: [r, g, b] as [number, number, number], frequency: freq[ki] };
    }).filter(c => c.frequency > 0).sort((a, b) => b.frequency - a.frequency);
  }, [rgbToHex]);

  /**
   * Otsu's method applied per stencil layer.
   * For each opaque pixel, computes its Euclidean distance to the target cluster center.
   * Otsu finds the optimal threshold that separates "core" pixels (close to center) from
   * "borderline" pixels (far from center, near color boundaries).
   * Borderline pixels are set transparent → sharper, cleaner stencil edges.
   */
  const otsuSharpenLayer = useCallback((canvas: HTMLCanvasElement, color: ColorInfo): void => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;
    const [tr, tg, tb] = color.rgb;
    const np = canvas.width * canvas.height;
    const targetLab = rgbToLab(tr, tg, tb);

    // Compute perceptual ΔE distance (CIE Lab) for every opaque pixel — far better
    // than RGB Euclidean for detecting genuine colour boundaries.
    const dists = new Float32Array(np);
    let maxDist = 0;
    for (let pi = 0; pi < np; pi++) {
      if (data[pi * 4 + 3] < 128) { dists[pi] = -1; continue; }
      const [pL, pA, pB] = rgbToLab(data[pi * 4], data[pi * 4 + 1], data[pi * 4 + 2]);
      const dL = pL - targetLab[0], dA = pA - targetLab[1], dB = pB - targetLab[2];
      const d = Math.sqrt(dL * dL + dA * dA + dB * dB); // ΔE, approx 0–150
      dists[pi] = d;
      if (d > maxDist) maxDist = d;
    }
    if (maxDist < 1) return;

    // Build 256-bin histogram of distances (for opaque pixels only)
    const hist = new Uint32Array(256);
    for (let pi = 0; pi < np; pi++) {
      if (dists[pi] < 0) continue;
      hist[Math.min(255, Math.floor(dists[pi] / maxDist * 255))]++;
    }

    // Otsu threshold → distance cutoff in original units
    const t = otsuValue(hist);
    const cutoff = (t / 255) * maxDist;

    // Erase pixels that are weakly assigned (far from the cluster center)
    for (let pi = 0; pi < np; pi++) {
      if (dists[pi] > cutoff) data[pi * 4 + 3] = 0;
    }
    ctx.putImageData(imgData, 0, 0);
  }, []);

  const processImage = useCallback((img: HTMLImageElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    let width = img.width;
    let height = img.height;

    const maxWidth = 800;
    const maxHeight = 600;

    if (width > maxWidth || height > maxHeight) {
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      width = Math.floor(width * ratio);
      height = Math.floor(height * ratio);
      }

    canvas.width = width;
    canvas.height = height;

    // Store raw image for re-processing when sliders change
    rawImageRef.current = img;
    setImageDimensions({width, height});

    // Reset mask and edit mode for new image
    alphaMaskRef.current = new Uint8ClampedArray(width * height).fill(255);
    setHasMask(false);
    setEditMode('select');

    // Apply adjustments and display on canvas
    const adjustedData = applyContrastAndBlur(img, contrast, simplify, posterize, width, height,
      brightness, saturation, hue, invertColors, chromaKeyEnabled, chromaColor, chromaTolerance);
    ctx.putImageData(adjustedData, 0, 0);
    setOriginalImageData(adjustedData);

    setSelectedPalette('auto');
    const extractedColors = extractColors(adjustedData, paletteSize);
    setColors(extractedColors);
    }, [extractColors, paletteSize, contrast, simplify, posterize, brightness, saturation, hue, invertColors, chromaKeyEnabled, chromaColor, chromaTolerance, applyContrastAndBlur]);

  // Convert mouse event position to canvas pixel coordinates
  const canvasEventToPixel = useCallback((e: React.MouseEvent): {x: number, y: number} | null => {
    const canvas = canvasRef.current;
    if (!canvas || !imageDimensions) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = imageDimensions.width / rect.width;
    const scaleY = imageDimensions.height / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  }, [imageDimensions]);

  // ── Erase brush: paint transparency directly on the canvas + update alpha mask ──
  const paintErase = useCallback((imgX: number, imgY: number, restore = false) => {
    if (!imageDimensions || !canvasRef.current) return;
    const { width, height } = imageDimensions;
    if (!alphaMaskRef.current) alphaMaskRef.current = new Uint8ClampedArray(width * height).fill(255);
    const ctx = canvasRef.current.getContext('2d', { willReadFrequently: true })!;
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    const r = Math.ceil(brushSize);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const nx = imgX + dx, ny = imgY + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const pi = ny * width + nx;
        if (restore) {
          alphaMaskRef.current[pi] = 255;
          // We can't restore colour info from a transparent pixel — caller must trigger full redraw
        } else {
          alphaMaskRef.current[pi] = 0;
          data[pi * 4 + 3] = 0;
        }
      }
    }
    if (restore) {
      // Need full pipeline redraw to show restored pixels — handled via hasMask toggle
    } else {
      ctx.putImageData(imgData, 0, 0);
    }
    setHasMask(true);
  }, [imageDimensions, brushSize]);

  // ── Magic wand: flood-fill from clicked pixel, erasing similar connected region ──
  const handleMagicWandClick = useCallback((imgX: number, imgY: number) => {
    if (!imageDimensions || !canvasRef.current) return;
    const { width, height } = imageDimensions;
    if (!alphaMaskRef.current) alphaMaskRef.current = new Uint8ClampedArray(width * height).fill(255);
    const ctx = canvasRef.current.getContext('2d', { willReadFrequently: true })!;
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    const startPx = imgY * width + imgX;
    if (data[startPx * 4 + 3] === 0) return; // clicking transparent = no-op
    const seedLab = rgbToLab(data[startPx * 4], data[startPx * 4 + 1], data[startPx * 4 + 2]);
    const visited = new Uint8Array(width * height);
    const queue = [startPx];
    visited[startPx] = 1;
    let head = 0;
    while (head < queue.length) {
      const px = queue[head++];
      alphaMaskRef.current[px] = 0;
      data[px * 4 + 3] = 0;
      const x = px % width, y = (px / width) | 0;
      const neighbors = [x > 0 ? px - 1 : -1, x < width - 1 ? px + 1 : -1, y > 0 ? px - width : -1, y < height - 1 ? px + width : -1];
      for (const nb of neighbors) {
        if (nb < 0 || visited[nb] || data[nb * 4 + 3] === 0) continue;
        const nLab = rgbToLab(data[nb * 4], data[nb * 4 + 1], data[nb * 4 + 2]);
        const dE = Math.sqrt((nLab[0] - seedLab[0]) ** 2 + (nLab[1] - seedLab[1]) ** 2 + (nLab[2] - seedLab[2]) ** 2);
        if (dE <= maskTolerance) { visited[nb] = 1; queue.push(nb); }
      }
    }
    ctx.putImageData(imgData, 0, 0);
    setHasMask(true);
  }, [imageDimensions, maskTolerance]);

  // ── Auto remove background: fuzzy flood-fill from all image edges ──
  const autoRemoveBackground = useCallback(() => {
    if (!imageDimensions || !canvasRef.current) return;
    const { width, height } = imageDimensions;
    if (!alphaMaskRef.current) alphaMaskRef.current = new Uint8ClampedArray(width * height).fill(255);
    const ctx = canvasRef.current.getContext('2d', { willReadFrequently: true })!;
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    const visited = new Uint8Array(width * height);
    const queue: number[] = [];
    const tryAdd = (px: number) => { if (!visited[px] && data[px * 4 + 3] > 0) { visited[px] = 1; queue.push(px); } };
    for (let x = 0; x < width; x++) { tryAdd(x); tryAdd((height - 1) * width + x); }
    for (let y = 1; y < height - 1; y++) { tryAdd(y * width); tryAdd(y * width + width - 1); }
    let head = 0;
    while (head < queue.length) {
      const px = queue[head++];
      alphaMaskRef.current[px] = 0;
      data[px * 4 + 3] = 0;
      const x = px % width, y = (px / width) | 0;
      const pLab = rgbToLab(data[px * 4], data[px * 4 + 1], data[px * 4 + 2]);
      const neighbors = [x > 0 ? px - 1 : -1, x < width - 1 ? px + 1 : -1, y > 0 ? px - width : -1, y < height - 1 ? px + width : -1];
      for (const nb of neighbors) {
        if (nb < 0 || visited[nb] || data[nb * 4 + 3] === 0) continue;
        const nLab = rgbToLab(data[nb * 4], data[nb * 4 + 1], data[nb * 4 + 2]);
        const dE = Math.sqrt((pLab[0] - nLab[0]) ** 2 + (pLab[1] - nLab[1]) ** 2 + (pLab[2] - nLab[2]) ** 2);
        if (dE <= maskTolerance) { visited[nb] = 1; queue.push(nb); }
      }
    }
    ctx.putImageData(imgData, 0, 0);
    setHasMask(true);
  }, [imageDimensions, maskTolerance]);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    const pt = canvasEventToPixel(e);
    if (!pt) return;
    if (editMode === 'select') {
      selectionDragRef.current = { startX: pt.x, startY: pt.y };
      setSelection({ x: pt.x, y: pt.y, w: 0, h: 0 });
    } else if (editMode === 'erase') {
      isErasingRef.current = true;
      paintErase(pt.x, pt.y);
    } else if (editMode === 'wand') {
      handleMagicWandClick(pt.x, pt.y);
    }
  }, [canvasEventToPixel, editMode, paintErase, handleMagicWandClick]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    if (editMode === 'erase') {
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        setEraseCursor({ cssX: e.clientX - rect.left, cssY: e.clientY - rect.top });
      }
      if (isErasingRef.current) {
        const pt = canvasEventToPixel(e);
        if (pt) paintErase(pt.x, pt.y);
      }
      return;
    }
    if (!selectionDragRef.current) return;
    const pt = canvasEventToPixel(e);
    if (!pt) return;
    const { startX, startY } = selectionDragRef.current;
    setSelection({
      x: Math.min(startX, pt.x),
      y: Math.min(startY, pt.y),
      w: Math.abs(pt.x - startX),
      h: Math.abs(pt.y - startY),
    });
  }, [canvasEventToPixel, editMode, paintErase]);

  const handleCanvasMouseUp = useCallback(() => {
    selectionDragRef.current = null;
    isErasingRef.current = false;
  }, []);

  const handleCanvasMouseLeave = useCallback(() => {
    selectionDragRef.current = null;
    isErasingRef.current = false;
    setEraseCursor(null);
  }, []);

  const handleCropToSelection = useCallback(() => {
    if (!selection || !rawImageRef.current || !imageDimensions) return;
    if (selection.w < 4 || selection.h < 4) return;
    const { x, y, w, h } = selection;
    const img = rawImageRef.current;
    // Scale selection from display-canvas coords to original image coords
    const scaleX = img.naturalWidth / imageDimensions.width;
    const scaleY = img.naturalHeight / imageDimensions.height;
    const crop = document.createElement('canvas');
    crop.width = Math.round(w * scaleX);
    crop.height = Math.round(h * scaleY);
    crop.getContext('2d')!.drawImage(img,
      Math.round(x * scaleX), Math.round(y * scaleY),
      crop.width, crop.height,
      0, 0, crop.width, crop.height);
    const cropped = new Image();
    cropped.onload = () => { setSelection(null); processImage(cropped); };
    cropped.src = crop.toDataURL('image/png');
  }, [selection, imageDimensions, processImage]);

  const handleImageUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        processImage(img);
        };
      img.src = e.target?.result as string;
      };
    reader.readAsDataURL(file);
    };

  // CPU fallback stencil generation (used if WebGL unavailable)
  const generateStencilCPU = useCallback((color: ColorInfo, imgData: ImageData, allColors: ColorInfo[], width: number, height: number): HTMLCanvasElement => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, width, height);
    const pixels = imgData.data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (pixels[i + 3] < 128) continue;
        const rgb: [number, number, number] = [pixels[i], pixels[i + 1], pixels[i + 2]];
        let minDist = Infinity;
        let closest = color;
        for (const c of allColors) {
          const d = colorDistance(rgb, c.rgb);
          if (d < minDist) { minDist = d; closest = c; }
        }
        if (closest === color) {
          ctx.fillStyle = color.hex;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    return canvas;
  }, [colorDistance]);

  // Main generation pipeline — called explicitly from button, NOT via useEffect
  const runGeneration = useCallback(async (imgData: ImageData, targetColors: ColorInfo[], width: number, height: number) => {
    if (isGeneratingRef.current) return;
    isGeneratingRef.current = true;

    setProcessingProgress({ current: 0, total: targetColors.length, label: 'Generating color layers…' });
    await new Promise(r => setTimeout(r, 0)); // let React render progress bar

    // Try WebGL first (fast), fall back to CPU
    let rawCanvases = generateAllStencilsWebGL(imgData, width, height, targetColors);
    if (!rawCanvases) {
      rawCanvases = targetColors.map(c => generateStencilCPU(c, imgData, targetColors, width, height));
    }

    const stencilInfos: StencilInfo[] = [];
    for (let i = 0; i < rawCanvases.length; i++) {
      setProcessingProgress({ current: i + 1, total: targetColors.length, label: `Post-processing stencil ${i + 1} / ${targetColors.length}…` });
      await new Promise(r => setTimeout(r, 0));

      const canvas = rawCanvases[i];
      // 1. Otsu sharpening — remove borderline-assigned pixels near colour boundaries
      otsuSharpenLayer(canvas, targetColors[i]);
      // 2. Gap closing and min-feature removal are locked at 0 (disabled) —
      //    the vector tracer handles shape quality; no pixel-level morphology needed.
      // morphologicalClose(canvas, 0, targetColors[i]);
      // removeSmallRegions(canvas, 0);
      // 3. Fix any remaining isolated islands
      const hasIslands = detectIslands(canvas);
      if (hasIslands) bridgeIslands(canvas, Math.floor(bridgeWidth / 2), minIslandSize);
      const opaquePx = countOpaquePx(canvas);
      stencilInfos.push({ canvas, hasIslands, opaquePx });
    }

    setStencilCanvases(stencilInfos);
    // All layers visible by default
    setVisibleLayers(new Set(stencilInfos.map((_, i) => i)));
    setProcessingProgress(null);
    isGeneratingRef.current = false;
  }, [generateAllStencilsWebGL, generateStencilCPU, detectIslands, bridgeIslands, otsuSharpenLayer, bridgeWidth, minIslandSize]);

  // Live preview of adjustments on canvas without triggering stencil regeneration
  const previewAdjustments = useCallback(() => {
    if (!rawImageRef.current || !imageDimensions || !canvasRef.current) return;
    const {width, height} = imageDimensions;
    const adjustedData = applyContrastAndBlur(rawImageRef.current, contrast, simplify, posterize, width, height,
      brightness, saturation, hue, invertColors, chromaKeyEnabled, chromaColor, chromaTolerance);
    // Apply alpha mask on top for display
    let displayData: ImageData = adjustedData;
    if (alphaMaskRef.current) {
      const masked = new Uint8ClampedArray(adjustedData.data);
      const m = alphaMaskRef.current;
      for (let pi = 0; pi < m.length; pi++) if (m[pi] === 0) masked[pi * 4 + 3] = 0;
      displayData = new ImageData(masked, width, height);
    }
    canvasRef.current.getContext('2d')!.putImageData(displayData, 0, 0);
    }, [imageDimensions, contrast, simplify, posterize, brightness, saturation, hue, invertColors, chromaKeyEnabled, chromaColor, chromaTolerance, applyContrastAndBlur]);

  // Clear the alpha mask and redraw the full pipeline
  const clearAlphaMask = useCallback(() => {
    if (!imageDimensions) return;
    const { width, height } = imageDimensions;
    alphaMaskRef.current = new Uint8ClampedArray(width * height).fill(255);
    setHasMask(false);
    previewAdjustments();
  }, [imageDimensions, previewAdjustments]);

  // Apply adjustments and regenerate stencils
  const handleApplyAdjustments = useCallback(() => {
    if (!rawImageRef.current || !imageDimensions) return;
    const {width, height} = imageDimensions;
    // adjustedData has all color effects applied but NO mask (mask applied separately below)
    const adjustedData = applyContrastAndBlur(rawImageRef.current, contrast, simplify, posterize, width, height,
      brightness, saturation, hue, invertColors, chromaKeyEnabled, chromaColor, chromaTolerance);
    setOriginalImageData(adjustedData);
    // Build masked copy for display + stencil generation
    let stencilData: ImageData = adjustedData;
    if (alphaMaskRef.current) {
      const masked = new Uint8ClampedArray(adjustedData.data);
      const m = alphaMaskRef.current;
      for (let pi = 0; pi < m.length; pi++) if (m[pi] === 0) masked[pi * 4 + 3] = 0;
      stencilData = new ImageData(masked, width, height);
    }
    const ctx = canvasRef.current?.getContext('2d', { willReadFrequently: true });
    if (ctx) ctx.putImageData(stencilData, 0, 0);
    let colorSet: ColorInfo[];
    if (selectedPalette === 'auto' && !colorsEditedRef.current) {
      colorSet = extractColors(stencilData, paletteSize);
      setColors(colorSet);
    } else {
      colorSet = colors; // keep manually edited or preset palette
    }
    runGeneration(stencilData, colorSet, width, height);
    }, [imageDimensions, contrast, simplify, posterize, brightness, saturation, hue, invertColors, chromaKeyEnabled, chromaColor, chromaTolerance, applyContrastAndBlur, extractColors, paletteSize, runGeneration, selectedPalette, colors]);

  const updatePreview = useCallback(() => {
    if (!originalImageData || colors.length === 0 || !imageDimensions || !previewCanvasRef.current) return;
    const {width, height} = imageDimensions;
    const previewCtx = previewCanvasRef.current.getContext('2d', { willReadFrequently: true });
    if (!previewCtx) return;

    // Set canvas pixel dimensions to match image
    previewCanvasRef.current.width = width;
    previewCanvasRef.current.height = height;

    previewCtx.clearRect(0, 0, width, height);
    previewCtx.fillStyle = 'white';
    previewCtx.fillRect(0, 0, width, height);

    displayStencils.forEach((stencilInfo, i) => {
      if (visibleLayers.has(i)) previewCtx.drawImage(stencilInfo.canvas, 0, 0);
      });
    }, [displayStencils, visibleLayers, originalImageData, colors.length, imageDimensions]);

  /**
   * Click on the preview canvas → find which stencil layer owns that pixel
   * (iterating from top/last visible layer down) and select it for editing.
   */
  const handlePreviewClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!imageDimensions || displayStencils.length === 0) return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = imageDimensions.width / rect.width;
    const scaleY = imageDimensions.height / rect.height;
    const cx = Math.min(imageDimensions.width  - 1, Math.max(0, Math.floor((e.clientX - rect.left)  * scaleX)));
    const cy = Math.min(imageDimensions.height - 1, Math.max(0, Math.floor((e.clientY - rect.top)   * scaleY)));
    for (let i = displayStencils.length - 1; i >= 0; i--) {
      if (!visibleLayers.has(i)) continue;
      const ctx2 = displayStencils[i].canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx2) continue;
      const pixel = ctx2.getImageData(cx, cy, 1, 1).data;
      if (pixel[3] >= 128) { setSelectedColorIndex(i); return; }
    }
  }, [imageDimensions, displayStencils, visibleLayers]);

  /**
   * Build a composite vector SVG by tracing every visible layer with Potrace
   * and stacking the resulting <path> elements in a single <svg>.
   */
  const buildSVGPreview = useCallback(async () => {
    if (!imageDimensions || displayStencils.length === 0) return;
    setSvgPreviewBuilding(true);
    setSvgPreviewContent(null);
    const { width, height } = imageDimensions;
    let paths = '';
    for (let i = 0; i < displayStencils.length; i++) {
      if (!visibleLayers.has(i)) continue;
      const colorHex = colors[i]?.hex ?? '#000000';
      const svgStr = await canvasToSVGPotrace(displayStencils[i].canvas, colorHex);
      // Extract the <path .../> element(s) from the per-layer SVG
      const match = svgStr.match(/<path[\s\S]*?\/>/g);
      if (match) paths += match.join('\n') + '\n';
    }
    const combined = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<rect width="${width}" height="${height}" fill="white"/>`,
      paths,
      `</svg>`,
    ].join('\n');
    setSvgPreviewContent(combined);
    setSvgPreviewBuilding(false);
  }, [imageDimensions, displayStencils, visibleLayers, colors]);

  const handleColorPickerChange = (newHex: string) => {
    const idx = selectedColorIndex;
    if (idx < colors.length) {
      colorsEditedRef.current = true;
      const rgb = hexToRgb(newHex);
      const newColors = [...colors];
      newColors[idx] = { ...newColors[idx], hex: newHex, rgb };
      setColors(newColors);
      // Remap all pixels on this stencil layer to the new colour — instant swap, no re-render
      const cv = stencilCanvases[idx]?.canvas;
      if (cv) {
        const cx = cv.getContext('2d', { willReadFrequently: true });
        if (cx) {
          const id = cx.getImageData(0, 0, cv.width, cv.height);
          const dd = id.data;
          const [nr, ng, nb] = rgb;
          for (let pi = 0; pi < cv.width * cv.height; pi++) {
            if (dd[pi * 4 + 3] >= 128) { dd[pi * 4] = nr; dd[pi * 4 + 1] = ng; dd[pi * 4 + 2] = nb; }
          }
          cx.putImageData(id, 0, 0);
          setStencilCanvases(prev => [...prev]);
        }
      }
    }
  };

  const handleDeleteColor = useCallback((index: number) => {
    if (colors.length <= 1) return;
    colorsEditedRef.current = true;
    const newColors = colors.filter((_, i) => i !== index);
    const newStencils = stencilCanvases.filter((_, i) => i !== index);
    setColors(newColors);
    setStencilCanvases(newStencils);
    setSelectedColorIndex(prev => {
      if (prev === index) return Math.max(0, index - 1);
      if (prev > index) return prev - 1;
      return prev;
    });
    setVisibleLayers(prev => {
      const next = new Set<number>();
      prev.forEach(i => {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      });
      return next;
    });
    setMergeSelection(new Set());
  }, [colors, stencilCanvases]);

  const handleAddColor = useCallback(() => {
    colorsEditedRef.current = true;
    const newColor = mkColor(0, 0, 0);
    const newColors = [...colors, newColor];
    setColors(newColors);
    const width = imageDimensions?.width ?? 1;
    const height = imageDimensions?.height ?? 1;
    const blankCanvas = document.createElement('canvas');
    blankCanvas.width = width;
    blankCanvas.height = height;
    const blankInfo: StencilInfo = { canvas: blankCanvas, hasIslands: false, opaquePx: 0 };
    setStencilCanvases(prev => [...prev, blankInfo]);
    setSelectedColorIndex(newColors.length - 1);
    setVisibleLayers(prev => new Set([...prev, newColors.length - 1]));
  }, [colors, imageDimensions]);

  const handlePaletteSizeChange = (size: number) => {
    colorsEditedRef.current = false;
    setPaletteSize(size);
    setSelectedPalette('auto');
    if (originalImageData) {
      setColors(extractColors(originalImageData, size));
    }
  };

  const handleResetColors = () => {
    colorsEditedRef.current = false;
    if (selectedPalette !== 'auto') {
      const preset = PRESET_PALETTES.find(p => p.name === selectedPalette);
      if (preset) setColors(preset.colors);
    } else if (originalImageData) {
      setColors(extractColors(originalImageData, paletteSize));
    }
  };

  const handlePresetPaletteSelect = (name: string) => {
    colorsEditedRef.current = false;
    setSelectedPalette(name);
    if (name === 'auto') {
      if (originalImageData) setColors(extractColors(originalImageData, paletteSize));
    } else {
      const preset = PRESET_PALETTES.find(p => p.name === name);
      if (preset) {
        setColors(preset.colors);
        setPaletteSize(preset.colors.length);
      }
    }
  };

  const handleMergeStencils = useCallback(() => {
    if (mergeSelection.size < 2 || !imageDimensions) return;
    const { width, height } = imageDimensions;
    const selected = [...mergeSelection].sort((a, b) => a - b);

    // Average the RGB of the merged layers for a blended color label
    const avgR = Math.round(selected.reduce((s, i) => s + (colors[i]?.rgb[0] ?? 0), 0) / selected.length);
    const avgG = Math.round(selected.reduce((s, i) => s + (colors[i]?.rgb[1] ?? 0), 0) / selected.length);
    const avgB = Math.round(selected.reduce((s, i) => s + (colors[i]?.rgb[2] ?? 0), 0) / selected.length);
    const mergedColor: ColorInfo = { hex: rgbToHex(avgR, avgG, avgB), rgb: [avgR, avgG, avgB], frequency: 0 };

    // Union the alpha channels — a pixel is opaque if opaque in any source layer
    const merged = document.createElement('canvas');
    merged.width = width; merged.height = height;
    const mergedCtx = merged.getContext('2d', { willReadFrequently: true })!;
    const mergedData = mergedCtx.createImageData(width, height);
    for (const idx of selected) {
      const src = stencilCanvases[idx]?.canvas;
      if (!src) continue;
      const srcData = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
      for (let pi = 0; pi < width * height; pi++) {
        if (srcData[pi * 4 + 3] >= 128) {
          mergedData.data[pi * 4]     = avgR;
          mergedData.data[pi * 4 + 1] = avgG;
          mergedData.data[pi * 4 + 2] = avgB;
          mergedData.data[pi * 4 + 3] = 255;
        }
      }
    }
    mergedCtx.putImageData(mergedData, 0, 0);

    // Insert merged stencil at position of the first selected, remove the originals
    const firstIdx = selected[0];
    const mergedInfo: StencilInfo = { canvas: merged, hasIslands: false, opaquePx: countOpaquePx(merged) };
    const newStencils = stencilCanvases.filter((_, i) => !mergeSelection.has(i));
    const newColors   = colors.filter((_, i) => !mergeSelection.has(i));
    newStencils.splice(firstIdx, 0, mergedInfo);
    newColors.splice(firstIdx, 0, mergedColor);

    setStencilCanvases(newStencils);
    setColors(newColors);
    colorsEditedRef.current = true; // preserve the new merged color set
    setMergeSelection(new Set());
    setVisibleLayers(new Set(newStencils.map((_, i) => i)));
  }, [mergeSelection, imageDimensions, stencilCanvases, colors, rgbToHex]);

  const downloadCanvasAsPNG = (canvas: HTMLCanvasElement, filename: string) => {
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    link.click();
    };

  // Recompute displayStencils whenever the raw stencils or cleanup slider change
  useEffect(() => {
    if (stencilCanvases.length === 0 || !imageDimensions) {
      setDisplayStencils(stencilCanvases);
      return;
    }
    if (islandCleanupSize <= 0) {
      setDisplayStencils(stencilCanvases);
      return;
    }
    setDisplayStencils(
      applyIslandCleanup(stencilCanvases, islandCleanupSize, imageDimensions.width, imageDimensions.height)
    );
  }, [stencilCanvases, islandCleanupSize, imageDimensions, applyIslandCleanup]);

  // Live preview on slider changes (canvas only, no stencil regeneration)
  useEffect(() => {
    previewAdjustments();
    }, [previewAdjustments]);

  useEffect(() => {
    updatePreview();
    }, [updatePreview]);

  return (
       <div style={{ padding: '24px 28px', fontFamily: "'Inter', Arial, sans-serif", maxWidth: '1400px', margin: '0 auto', color: '#f0f0f0' }}>
         {/* ── Graffiti Logo ──────────────────────────────────────────── */}
         <div style={{ textAlign: 'center', marginBottom: '36px', padding: '20px 0 8px' }}>
           <div style={{
             fontFamily: "'Bangers', cursive",
             fontSize: 'clamp(42px, 7vw, 86px)',
             letterSpacing: '6px',
             lineHeight: 1.1,
             color: '#fff',
             textShadow: '4px 4px 0 #c0392b, 8px 8px 0 #e67e22, -2px -2px 0 rgba(102,126,234,0.9), 0 0 40px rgba(102,126,234,0.5), 0 0 80px rgba(231,76,60,0.25)',
             userSelect: 'none',
           }}>
             STENCIL TOOL
           </div>
           <div style={{
             fontFamily: "'Bangers', cursive",
             fontSize: '15px',
             letterSpacing: '9px',
             color: '#667eea',
             marginTop: '8px',
             opacity: 0.85,
           }}>
             ✦ STREET ART GENERATOR ✦
           </div>
         </div>

         <div style={{ marginBottom: '20px' }}>
           <button
             onClick={() => fileInputRef.current?.click()}
             style={{
               padding: '13px 36px',
               background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
               color: 'white',
               border: 'none',
               borderRadius: '6px',
               cursor: 'pointer',
               fontFamily: "'Bangers', cursive",
               fontSize: '22px',
               letterSpacing: '3px',
               boxShadow: '0 4px 20px rgba(102,126,234,0.5), inset 0 1px 0 rgba(255,255,255,0.15)',
             }}
           >
             📤 UPLOAD IMAGE
           </button>
           <input
             ref={fileInputRef}
             type="file"
             accept="image/*"
             onChange={(e) => {
               const file = e.target.files?.[0];
               if (file) handleImageUpload(file);
               }}
             style={{ display: 'none' }}
           />
         </div>

         {imageDimensions && (
           <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#252525', border: '1px solid #333', borderRadius: '8px' }}>
             <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', fontFamily: "'Bangers', cursive", letterSpacing: '2px', color: '#f0f0f0' }}>⚙ IMAGE ADJUSTMENTS</h3>
             <div style={{ display: 'flex', gap: '30px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
               <div style={{ flex: 1, minWidth: '200px' }}>
                 <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 'bold' }}>
                   Contrast: {contrast}%
                 </label>
                 <input
                   type="range"
                   min={50}
                   max={400}
                   value={contrast}
                   onChange={(e) => setContrast(Number(e.target.value))}
                   style={{ width: '100%' }}
                 />
                 <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#888' }}>
                   <span>Low</span><span>Normal (100%)</span><span>High</span>
                 </div>
               </div>
               <div style={{ flex: 1, minWidth: '200px' }}>
                 <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 'bold' }}>
                   Simplify: {simplify}px blur
                 </label>
                 <input
                   type="range"
                   min={0}
                   max={10}
                   value={simplify}
                   onChange={(e) => setSimplify(Number(e.target.value))}
                   style={{ width: '100%' }}
                 />
                 <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#888' }}>
                   <span>None</span><span>Medium</span><span>Max</span>
                 </div>
               </div>
               <div style={{ flex: 1, minWidth: '200px' }}>
                 <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 'bold' }}>
                   Posterize: {posterize < 2 ? 'Off' : `${posterize} levels`}
                 </label>
                 <input
                   type="range"
                   min={0}
                   max={8}
                   value={posterize}
                   onChange={(e) => setPosterize(Number(e.target.value))}
                   style={{ width: '100%' }}
                 />
                 <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#888' }}>
                   <span>Off</span><span>4 levels</span><span>8 levels</span>
                 </div>
               </div>
               <div style={{ flex: 1, minWidth: '200px' }}>
                 <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 'bold' }}>
                   Bridge width: {bridgeWidth}px
                 </label>
                 <input
                   type="range"
                   min={1}
                   max={20}
                   value={bridgeWidth}
                   onChange={(e) => setBridgeWidth(Number(e.target.value))}
                   style={{ width: '100%' }}
                 />
                 <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#888' }}>
                   <span>1px (thin)</span><span>4px</span><span>20px (thick)</span>
                 </div>
               </div>
               <div style={{ flex: 1, minWidth: '200px' }}>
                 <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 'bold' }}>
                   Fill islands ≤ {minIslandSize}px²
                 </label>
                 <input
                   type="range"
                   min={0}
                   max={500}
                   step={10}
                   value={minIslandSize}
                   onChange={(e) => setMinIslandSize(Number(e.target.value))}
                   style={{ width: '100%' }}
                 />
                 <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#888' }}>
                   <span>Bridge all</span><span>Fill ≤50px²</span><span>Fill ≤500px²</span>
                 </div>
               </div>
               <div>
                 <button
                   onClick={handleApplyAdjustments}
                   style={{
                     padding: '12px 26px',
                     background: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)',
                     color: '#051a05',
                     border: 'none',
                     borderRadius: '6px',
                     cursor: 'pointer',
                     fontFamily: "'Bangers', cursive",
                     fontSize: '20px',
                     letterSpacing: '2px',
                     boxShadow: '0 4px 18px rgba(17,153,142,0.5)',
                   }}
                 >
                   ⚡ APPLY &amp; GENERATE STENCILS
                 </button>
               </div>
             </div>

             {/* ── Color Effects row ──────────────────────────────────────────── */}
             <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px solid #3a3a3a' }}>
               <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#888', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '10px' }}>
                 Color Effects — applied live, click Apply to regenerate stencils
               </div>
               <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                 <div style={{ flex: 1, minWidth: '160px' }}>
                   <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 'bold' }}>
                     Brightness: {brightness}%
                   </label>
                   <input type="range" min={10} max={300} value={brightness}
                     onChange={(e) => setBrightness(Number(e.target.value))} style={{ width: '100%' }} />
                   <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#888' }}>
                     <span>Dark</span><span>Normal</span><span>Bright</span>
                   </div>
                 </div>
                 <div style={{ flex: 1, minWidth: '160px' }}>
                   <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 'bold' }}>
                     Saturation: {saturation}%
                   </label>
                   <input type="range" min={0} max={300} value={saturation}
                     onChange={(e) => setSaturation(Number(e.target.value))} style={{ width: '100%' }} />
                   <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#888' }}>
                     <span>Grayscale</span><span>Normal</span><span>Vivid</span>
                   </div>
                 </div>
                 <div style={{ flex: 1, minWidth: '160px' }}>
                   <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 'bold' }}>
                     Hue shift: {hue > 0 ? '+' : ''}{hue}°
                   </label>
                   <input type="range" min={-180} max={180} value={hue}
                     onChange={(e) => setHue(Number(e.target.value))} style={{ width: '100%' }} />
                   <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#888' }}>
                     <span>-180°</span><span>0°</span><span>+180°</span>
                   </div>
                 </div>
                 <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                   <button
                     onClick={() => setInvertColors(v => !v)}
                     style={{ padding: '8px 18px', background: invertColors ? 'linear-gradient(135deg, #c0392b 0%, #e74c3c 100%)' : '#3a3a3a', color: 'white', border: invertColors ? '2px solid #e74c3c' : '1px solid #555', borderRadius: '6px', cursor: 'pointer', fontFamily: "'Bangers', cursive", fontSize: '17px', letterSpacing: '1px' }}
                   >
                     {invertColors ? '⬛ INVERTED' : '⬜ Invert'}
                   </button>
                   <button
                     onClick={() => { setBrightness(100); setSaturation(100); setHue(0); setInvertColors(false); setChromaKeyEnabled(false); }}
                     style={{ padding: '5px 12px', background: 'transparent', color: '#888', border: '1px solid #444', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                   >
                     Reset effects
                   </button>
                 </div>
               </div>

               {/* Chroma key */}
               <div style={{ marginTop: '12px', padding: '10px 12px', backgroundColor: '#1e1e1e', border: `1px solid ${chromaKeyEnabled ? '#e74c3c' : '#333'}`, borderRadius: '6px' }}>
                 <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                   <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}>
                     <input type="checkbox" checked={chromaKeyEnabled} onChange={(e) => setChromaKeyEnabled(e.target.checked)} style={{ width: '15px', height: '15px' }} />
                     Transparent Color (Chroma Key)
                   </label>
                   <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                     <span style={{ fontSize: '12px', color: '#aaa' }}>Color:</span>
                     <input type="color" value={chromaColor} onChange={(e) => setChromaColor(e.target.value)}
                       style={{ width: '40px', height: '26px', padding: 0, border: '1px solid #555', borderRadius: '3px', cursor: 'pointer' }} />
                     <span style={{ fontSize: '11px', color: '#777', fontFamily: 'monospace' }}>{chromaColor}</span>
                   </div>
                   <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: '140px' }}>
                     <span style={{ fontSize: '12px', color: '#aaa', whiteSpace: 'nowrap' }}>Tolerance: {chromaTolerance}</span>
                     <input type="range" min={1} max={80} value={chromaTolerance}
                       onChange={(e) => setChromaTolerance(Number(e.target.value))} style={{ flex: 1 }} />
                   </div>
                   <span style={{ fontSize: '11px', color: '#666' }}>
                     Removes pixels matching the chosen color. Eyedropper: Ctrl+click or enable then click canvas.
                   </span>
                 </div>
               </div>
             </div>
           </div>
         )}

         {processingProgress && (
           <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#252525', borderRadius: '8px', border: '1px solid #333' }}>
             <div style={{ marginBottom: '8px', fontWeight: 'bold', fontSize: '14px' }}>
               {processingProgress.label}
             </div>
             <div style={{ width: '100%', height: '20px', backgroundColor: '#111', borderRadius: '3px', overflow: 'hidden', border: '1px solid #444' }}>
               <div
                 style={{
                   height: '100%',
                   width: `${(processingProgress.current / processingProgress.total) * 100}%`,
                   backgroundColor: '#667eea',
                   transition: 'width 0.3s ease',
                   display: 'flex',
                   alignItems: 'center',
                   justifyContent: 'center',
                   color: 'white',
                   fontSize: '12px',
                   fontWeight: 'bold'
                 }}
               >
                 {processingProgress.current > 0 && processingProgress.total > 0 && (
                   <span>{Math.round((processingProgress.current / processingProgress.total) * 100)}%</span>
                 )}
               </div>
             </div>
           </div>
         )}

         <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginBottom: '20px', alignItems: 'flex-start' }}>
           <div style={{ flex: 1, minWidth: '300px' }}>
             <h2>Original Image</h2>
             <div
               ref={canvasContainerRef}
               style={{ position: 'relative', display: 'inline-block', width: '100%', cursor: editMode === 'erase' ? 'none' : imageDimensions ? 'crosshair' : 'default' }}
               onMouseDown={handleCanvasMouseDown}
               onMouseMove={handleCanvasMouseMove}
               onMouseUp={handleCanvasMouseUp}
               onMouseLeave={handleCanvasMouseLeave}
             >
               <canvas
                 ref={canvasRef}
                 style={{ border: '1px solid #3a3a3a', width: '100%', height: 'auto', display: 'block', userSelect: 'none' }}
               />
               {/* Selection rect overlay */}
               {editMode === 'select' && selection && selection.w > 2 && selection.h > 2 && imageDimensions && (() => {
                 const canvas = canvasRef.current;
                 if (!canvas) return null;
                 const rect = canvas.getBoundingClientRect();
                 const displayW = rect.width || canvas.offsetWidth;
                 const scaleX = displayW / imageDimensions.width;
                 const scaleY = (displayW * imageDimensions.height / imageDimensions.width) / imageDimensions.height;
                 return (
                   <div style={{
                     position: 'absolute',
                     left: selection.x * scaleX,
                     top: selection.y * scaleY,
                     width: selection.w * scaleX,
                     height: selection.h * scaleY,
                     border: '2px dashed #e74c3c',
                     backgroundColor: 'rgba(231,76,60,0.12)',
                     pointerEvents: 'none',
                     boxSizing: 'border-box',
                   }} />
                 );
               })()}
               {/* Erase brush cursor overlay */}
               {editMode === 'erase' && eraseCursor && imageDimensions && (() => {
                 const canvas = canvasRef.current;
                 if (!canvas) return null;
                 const rect = canvas.getBoundingClientRect();
                 const scaleX = rect.width / imageDimensions.width;
                 const displayR = Math.max(4, brushSize * scaleX);
                 return (
                   <div style={{
                     position: 'absolute',
                     left: eraseCursor.cssX - displayR,
                     top: eraseCursor.cssY - displayR,
                     width: displayR * 2,
                     height: displayR * 2,
                     border: '2px solid rgba(255,80,80,0.9)',
                     borderRadius: '50%',
                     pointerEvents: 'none',
                     boxSizing: 'border-box',
                     zIndex: 10,
                   }} />
                 );
               })()}
             </div>
             {selection && selection.w > 4 && selection.h > 4 && editMode === 'select' && (
               <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                 <button
                   onClick={handleCropToSelection}
                   style={{ padding: '7px 18px', background: 'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontFamily: "'Bangers', cursive", fontSize: '16px', letterSpacing: '1px' }}
                 >
                   ✂ Crop to Selection
                 </button>
                 <button
                   onClick={() => setSelection(null)}
                   style={{ padding: '7px 14px', backgroundColor: '#3a3a3a', color: '#ccc', border: '1px solid #555', borderRadius: '4px', cursor: 'pointer', fontFamily: "'Bangers', cursive", fontSize: '15px', letterSpacing: '1px' }}
                 >
                   Clear
                 </button>
               </div>
             )}

             {/* ── Background Cutout Tools ──────────────────────────────────── */}
             {imageDimensions && (
               <div style={{ marginTop: '10px', padding: '10px 12px', backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '6px' }}>
                 <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#888', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '8px' }}>Cutout Tools</div>
                 {/* Mode buttons */}
                 <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
                   {(['select', 'erase', 'wand'] as const).map(mode => (
                     <button key={mode} onClick={() => setEditMode(mode)}
                       style={{ padding: '6px 14px', border: editMode === mode ? '2px solid #667eea' : '1px solid #444', borderRadius: '5px', cursor: 'pointer', backgroundColor: editMode === mode ? '#2a2f52' : '#2a2a2a', color: editMode === mode ? '#a78bfa' : '#aaa', fontWeight: editMode === mode ? 'bold' : 'normal', fontSize: '13px' }}>
                       {mode === 'select' ? '✥ Crop Select' : mode === 'erase' ? '🖌 Erase Brush' : '🪄 Magic Wand'}
                     </button>
                   ))}
                 </div>
                 {/* Erase mode controls */}
                 {editMode === 'erase' && (
                   <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px', flexWrap: 'wrap' }}>
                     <span style={{ fontSize: '12px', color: '#aaa', whiteSpace: 'nowrap' }}>Brush size: {brushSize}px</span>
                     <input type="range" min={2} max={80} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} style={{ flex: 1, minWidth: '100px' }} />
                     <span style={{ fontSize: '11px', color: '#666' }}>Drag to erase. Right-click drag to restore.</span>
                   </div>
                 )}
                 {/* Wand mode controls */}
                 {editMode === 'wand' && (
                   <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px', flexWrap: 'wrap' }}>
                     <span style={{ fontSize: '12px', color: '#aaa', whiteSpace: 'nowrap' }}>Tolerance: {maskTolerance}</span>
                     <input type="range" min={1} max={80} value={maskTolerance} onChange={(e) => setMaskTolerance(Number(e.target.value))} style={{ flex: 1, minWidth: '100px' }} />
                     <span style={{ fontSize: '11px', color: '#666' }}>Click a region to flood-fill erase it.</span>
                   </div>
                 )}
                 {/* Auto remove BG */}
                 <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                   <button onClick={autoRemoveBackground}
                     style={{ padding: '6px 16px', background: 'linear-gradient(135deg, #e67e22 0%, #f39c12 100%)', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontFamily: "'Bangers', cursive", fontSize: '16px', letterSpacing: '1px' }}>
                     ✂ Auto Remove BG
                   </button>
                   <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: '140px' }}>
                     <span style={{ fontSize: '12px', color: '#aaa', whiteSpace: 'nowrap' }}>Tol: {maskTolerance}</span>
                     <input type="range" min={1} max={80} value={maskTolerance} onChange={(e) => setMaskTolerance(Number(e.target.value))} style={{ flex: 1 }} />
                   </div>
                   {hasMask && (
                     <button onClick={clearAlphaMask}
                       style={{ padding: '6px 14px', background: '#c0392b', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold' }}>
                       ✕ Clear Mask
                     </button>
                   )}
                 </div>
               </div>
             )}
           </div>
        
           <div style={{ flex: 1, minWidth: '500px' }}>
             <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '6px' }}>
               <h2 style={{ margin: 0 }}>Preview (Layered Stencils)</h2>
               {imageDimensions && (
                 <button
                   onClick={handleApplyAdjustments}
                   style={{
                     padding: '8px 20px',
                     background: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)',
                     color: '#051a05',
                     border: 'none',
                     borderRadius: '6px',
                     cursor: 'pointer',
                     fontFamily: "'Bangers', cursive",
                     fontSize: '17px',
                     letterSpacing: '2px',
                     boxShadow: '0 3px 12px rgba(17,153,142,0.45)',
                   }}
                 >
                   ⚡ RE-RENDER
                 </button>
               )}
             </div>
             <canvas 
               ref={previewCanvasRef}
               onClick={handlePreviewClick}
               style={{ border: '1px solid #3a3a3a', width: '100%', height: 'auto', display: 'block', cursor: stencilCanvases.length > 0 ? 'crosshair' : 'default' }}
               title="Click a colour to select it for editing"
             />
             {stencilCanvases.length > 0 && colors.length > 0 && (() => {
               const selColor = colors[selectedColorIndex];
               return (
                 <div style={{ marginTop: '8px', padding: '8px 12px', backgroundColor: '#1e1e3a', border: '2px solid #667eea', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                   <span style={{ fontSize: '12px', color: '#667eea', fontWeight: 'bold', whiteSpace: 'nowrap' }}>↑ Click preview to pick</span>
                   <div style={{ width: '32px', height: '32px', backgroundColor: selColor?.hex ?? '#000', border: '2px solid #333', borderRadius: '4px', flexShrink: 0 }} />
                   <input
                     type="color"
                     value={selColor?.hex ?? '#000000'}
                     onChange={(e) => handleColorPickerChange(e.target.value)}
                     style={{ width: '48px', height: '32px', padding: '0', border: '1px solid #ccc', borderRadius: '4px', cursor: 'pointer' }}
                     title="Change colour"
                   />
                   <span style={{ fontSize: '12px', color: '#aaa', fontFamily: 'monospace' }}>{selColor?.hex ?? ''}</span>
                   <span style={{ fontSize: '11px', color: '#aaa' }}>Layer {selectedColorIndex + 1}</span>
                 </div>
               );
             })()}
             {stencilCanvases.length > 0 && (
               <div style={{ marginTop: '10px', padding: '10px 12px', backgroundColor: '#252525', border: '1px solid #333', borderRadius: '6px' }}>
                 <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                   <label style={{ fontSize: '13px', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                     Absorb islands ≤ {islandCleanupSize === 0 ? 'Off' : `${islandCleanupSize}px`}
                   </label>
                   <input
                     type="range" min={0} max={1024} step={1}
                     value={islandCleanupSize}
                     onChange={(e) => setIslandCleanupSize(Number(e.target.value))}
                     style={{ flex: 1, minWidth: '120px' }}
                   />
                   <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                     {[0,1,2,4,8,16,32,64,128,256,512,1024].map(v => (
                       <button key={v} onClick={() => setIslandCleanupSize(v)}
                         style={{ padding: '2px 6px', fontSize: '11px', border: '1px solid #444', borderRadius: '3px', cursor: 'pointer', backgroundColor: islandCleanupSize === v ? '#667eea' : '#2e2e2e', color: islandCleanupSize === v ? 'white' : '#ccc' }}>
                         {v === 0 ? 'Off' : v}
                       </button>
                     ))}
                   </div>
                 </div>
               </div>
             )}

             {/* ── Active colour swatches — directly under preview ────────────────── */}
             {colors.length > 0 && (
               <div style={{ marginTop: '14px', padding: '12px', backgroundColor: '#1e1e1e', border: '1px solid #333', borderRadius: '8px' }}>
                 <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#888', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '10px' }}>
                   Active Colours — click swatch to swap colour instantly
                 </div>
                 <div style={{ display: 'flex', gap: '9px', flexWrap: 'wrap', marginBottom: '10px', alignItems: 'flex-start' }}>
                   {colors.map((color, index) => (
                     <div key={index} onClick={() => setSelectedColorIndex(index)} title={`${color.hex} — click to swap colour instantly`}
                       style={{ position: 'relative', padding: '5px', border: index === selectedColorIndex ? '2px solid #a78bfa' : '1px solid #3a3a3a', borderRadius: '5px', cursor: 'pointer', backgroundColor: '#252525' }}>
                       <button onClick={(e) => { e.stopPropagation(); handleDeleteColor(index); }} title="Remove this colour"
                         style={{ position: 'absolute', top: '-8px', right: '-8px', width: '17px', height: '17px', background: '#c0392b', color: 'white', border: 'none', borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '11px', zIndex: 2, boxShadow: '0 1px 4px rgba(0,0,0,0.6)', padding: 0, lineHeight: 1 }}>×</button>
                       <div style={{ position: 'relative', width: '42px', height: '42px' }}>
                         <div style={{ width: '42px', height: '42px', backgroundColor: color.hex, outline: '1px solid rgba(255,255,255,0.12)' }} />
                         <input type="color" value={color.hex} onClick={(e) => e.stopPropagation()}
                           onChange={(e) => {
                             setSelectedColorIndex(index);
                             colorsEditedRef.current = true;
                             const rgb = hexToRgb(e.target.value);
                             const next = [...colors];
                             next[index] = { ...next[index], hex: e.target.value, rgb };
                             setColors(next);
                             const cv = stencilCanvases[index]?.canvas;
                             if (cv) { const cx = cv.getContext('2d', { willReadFrequently: true }); if (cx) { const id = cx.getImageData(0, 0, cv.width, cv.height); const dd = id.data; const [nr, ng, nb] = rgb; for (let pi = 0; pi < cv.width * cv.height; pi++) { if (dd[pi * 4 + 3] >= 128) { dd[pi * 4] = nr; dd[pi * 4 + 1] = ng; dd[pi * 4 + 2] = nb; } } cx.putImageData(id, 0, 0); setStencilCanvases(prev => [...prev]); } }
                           }}
                           title="Swap this colour — all pixels update instantly"
                           style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer', padding: 0, border: 'none' }}
                         />
                       </div>
                       <div style={{ fontSize: '9px', textAlign: 'center', color: '#888', marginTop: '3px' }}>{color.hex}</div>
                     </div>
                   ))}
                   <button onClick={handleAddColor} title="Add a new colour"
                     style={{ width: '56px', minHeight: '76px', border: '1px dashed #555', borderRadius: '5px', background: 'transparent', color: '#667eea', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '2px' }}>
                     <span style={{ fontSize: '24px', lineHeight: 1 }}>+</span>
                     <span style={{ fontSize: '9px', color: '#aaa' }}>Add</span>
                   </button>
                 </div>
                 <button onClick={handleResetColors}
                   style={{ padding: '6px 16px', background: 'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontFamily: "'Bangers', cursive", fontSize: '16px', letterSpacing: '1px' }}>
                   Reset Colors
                 </button>
               </div>
             )}
           </div>
         </div>

         {/* ── SVG Vector Preview ───────────────────────────────────────────── */}
         {displayStencils.length > 0 && (
           <div style={{ marginTop: '20px', padding: '16px', backgroundColor: '#252525', border: '1px solid #333', borderRadius: '8px' }}>
             <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '12px', flexWrap: 'wrap' }}>
               <h2 style={{ margin: 0 }}>SVG Vector Preview</h2>
               <button
                 onClick={buildSVGPreview}
                 disabled={svgPreviewBuilding}
                 style={{ padding: '9px 20px', background: svgPreviewBuilding ? '#444' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white', border: 'none', borderRadius: '5px', cursor: svgPreviewBuilding ? 'default' : 'pointer', fontFamily: "'Bangers', cursive", fontSize: '17px', letterSpacing: '1px' }}
               >
                 {svgPreviewBuilding ? 'Tracing…' : svgPreviewContent ? 'Re-trace' : 'Trace All Layers'}
               </button>
               {svgPreviewContent && (
                 <button
                   onClick={async () => {
                     const _totalPx = (imageDimensions?.width ?? 1) * (imageDimensions?.height ?? 1);
                     const _minPx = _totalPx * 0.005;
                     for (let i = 0; i < displayStencils.length; i++) {
                       if (!visibleLayers.has(i)) continue;
                       if (displayStencils[i].opaquePx < _minPx) continue;
                       const colorHex = colors[i]?.hex ?? '#000000';
                       const svgStr = await canvasToSVGPotrace(displayStencils[i].canvas, colorHex);
                       if (svgStr) downloadSVG(svgStr, `stencil-${i + 1}-${colorHex.replace('#', '')}.svg`);
                     }
                   }}
                   style={{ padding: '9px 20px', background: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)', color: '#051a05', border: 'none', borderRadius: '5px', cursor: 'pointer', fontFamily: "'Bangers', cursive", fontSize: '17px', letterSpacing: '1px' }}
                 >
                   Download All SVGs
                 </button>
               )}
               <span style={{ fontSize: '12px', color: '#888' }}>Bezier-fitted vector paths via Potrace — all visible layers composited</span>
             </div>
             {svgPreviewContent ? (
               <div style={{ border: '1px solid #333', borderRadius: '4px', overflow: 'auto', backgroundColor: '#1a1a1a', maxHeight: '680px' }}>
                 <div
                   style={{ width: '100%' }}
                   dangerouslySetInnerHTML={{ __html: svgPreviewContent
                     .replace(/width="\d+"/, 'width="100%"')
                     .replace(/\s*height="\d+"/, '')
                     .replace('<svg ', '<svg style="display:block;max-height:640px;width:100%;object-fit:contain;" ') }}
                 />
               </div>
             ) : (
               <div style={{ padding: '24px', textAlign: 'center', color: '#555', border: '1px dashed #444', borderRadius: '4px', backgroundColor: '#1a1a1a' }}>
                 Click “Trace All Layers” to generate a clean vector SVG with smooth Bezier curves
               </div>
             )}
           </div>
         )}

         <div style={{ marginTop: '20px' }}>
           <h2>Palette Presets</h2>

           {/* ── Palette presets ─────────────────────────────── */}
           <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#252525', border: '1px solid #333', borderRadius: '8px' }}>
             <div style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '10px', color: '#ccc', textTransform: 'uppercase', letterSpacing: '1px' }}>Palette Source</div>

             {/* Group labels + preset buttons */}
             {(['Retro', 'Pixel Art', 'Stencil'] as const).map(group => (
               <div key={group} style={{ marginBottom: '8px' }}>
                 <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>{group}</div>
                 <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                   {PRESET_PALETTES.filter(p => p.group === group).map(({ name, colors: pColors }) => (
                     <button
                       key={name}
                       onClick={() => handlePresetPaletteSelect(name)}
                       title={`${name} (${pColors.length} colours)`}
                       style={{
                         padding: '4px 6px',
                         border: selectedPalette === name ? '2px solid #667eea' : '1px solid #3a3a3a',
                         borderRadius: '5px',
                         cursor: 'pointer',
                         backgroundColor: selectedPalette === name ? '#2a2f52' : '#2a2a2a',
                       }}
                     >
                       <div style={{ display: 'flex', gap: '1px', marginBottom: '3px' }}>
                         {pColors.slice(0, 12).map((c, i) => (
                           <div key={i} style={{ width: '8px', height: '8px', backgroundColor: c.hex, outline: '1px solid rgba(0,0,0,0.12)' }} />
                         ))}
                         {pColors.length > 12 && <div style={{ width: '8px', height: '8px', backgroundColor: '#eee', fontSize: '7px', lineHeight: '8px', textAlign: 'center', color: '#999' }}>+</div>}
                       </div>
                       <div style={{ fontSize: '9px', whiteSpace: 'nowrap', textAlign: 'center', color: selectedPalette === name ? '#667eea' : '#aaa' }}>{name}</div>
                     </button>
                   ))}
                 </div>
               </div>
             ))}

             {/* Auto (from image) */}
             <div>
               <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>From Image</div>
               <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                 <button
                   onClick={() => handlePresetPaletteSelect('auto')}
                   style={{
                     padding: '5px 14px',
                     border: selectedPalette === 'auto' ? '2px solid #667eea' : '1px solid #3a3a3a',
                     borderRadius: '5px',
                     cursor: 'pointer',
                     backgroundColor: selectedPalette === 'auto' ? '#2a2f52' : '#2a2a2a',
                     fontWeight: selectedPalette === 'auto' ? 'bold' : 'normal',
                     color: selectedPalette === 'auto' ? '#667eea' : '#aaa',
                     fontSize: '12px',
                   }}
                 >
                   Auto-detect from image
                 </button>
                 {selectedPalette === 'auto' && (
                   <div style={{ display: 'flex', gap: '3px', alignItems: 'center', flexWrap: 'wrap' }}>
                     <span style={{ fontSize: '12px', color: '#888' }}>Colors:</span>
                     {Array.from({ length: 20 }, (_, i) => i + 1).map((size) => (
                       <button
                         key={size}
                         onClick={() => handlePaletteSizeChange(size)}
                         style={{
                           padding: '3px 7px',
                           backgroundColor: size === paletteSize ? '#667eea' : '#333',
                           color: size === paletteSize ? 'white' : '#ccc',
                           border: 'none',
                           borderRadius: '3px',
                           cursor: 'pointer',
                           fontSize: '12px',
                         }}
                       >
                         {size}
                       </button>
                     ))}
                   </div>
                 )}
               </div>
             </div>
           </div>
         </div>

         {stencilCanvases.length > 0 && (() => {
           const totalPx = (imageDimensions?.width ?? 1) * (imageDimensions?.height ?? 1);
           const minPx = totalPx * 0.005; // hide stencils covering < 0.5% of image area
           const visible = displayStencils
             .map((s, i) => ({ s, i }))
             .filter(({ s }) => s.opaquePx >= minPx);
           const hiddenCount = displayStencils.length - visible.length;
           return (
             <div style={{ marginTop: '20px' }}>
               <h2 style={{ marginBottom: '6px' }}>Stencils</h2>

               {hiddenCount > 0 && (
                 <div style={{ marginBottom: '12px', fontSize: '13px', color: '#888' }}>
                   {hiddenCount} stencil{hiddenCount > 1 ? 's' : ''} hidden (too little coverage)
                 </div>
               )}
               {mergeSelection.size >= 2 && (
                 <button
                   onClick={handleMergeStencils}
                   style={{ marginBottom: '12px', padding: '9px 22px', background: 'linear-gradient(135deg, #e67e22 0%, #f39c12 100%)', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontFamily: "'Bangers', cursive", fontSize: '18px', letterSpacing: '2px', boxShadow: '0 3px 12px rgba(230,126,34,0.45)' }}
                 >
                   Merge {mergeSelection.size} selected stencils
                 </button>
               )}
               <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                 {visible.map(({ s: stencilInfo, i: index }) => {
                   const coveragePct = ((stencilInfo.opaquePx / totalPx) * 100).toFixed(1);
                   const colorHex = colors[index]?.hex ?? '#000000';
                   const inMerge = mergeSelection.has(index);
                   return (
                     <div key={index} style={{ border: inMerge ? '2px solid #e67e22' : stencilInfo.hasIslands ? '2px solid #f39c12' : '1px solid #333', padding: '10px', backgroundColor: '#252525', minWidth: '220px', borderRadius: '6px' }}>
                       <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                         <input
                           type="checkbox"
                           checked={inMerge}
                           onChange={() => setMergeSelection(prev => {
                             const next = new Set(prev);
                             if (next.has(index)) next.delete(index); else next.add(index);
                             return next;
                           })}
                           title="Select for merge"
                           style={{ width: '15px', height: '15px', cursor: 'pointer', flexShrink: 0 }}
                         />
                         <div style={{ width: '18px', height: '18px', backgroundColor: colorHex, outline: '1px solid rgba(0,0,0,0.2)', borderRadius: '2px', flexShrink: 0 }} />
                         <span style={{ fontWeight: 'bold', fontSize: '14px' }}>Stencil {index + 1}</span>
                         <span style={{ fontSize: '12px', color: '#888' }}>{colorHex} · {coveragePct}%</span>
                         <button
                           onClick={() => setVisibleLayers(prev => {
                             const next = new Set(prev);
                             if (next.has(index)) next.delete(index); else next.add(index);
                             return next;
                           })}
                           title={visibleLayers.has(index) ? 'Hide in preview' : 'Show in preview'}
                           style={{
                             marginLeft: 'auto', padding: '2px 8px', border: '1px solid #444',
                             borderRadius: '4px', cursor: 'pointer', fontSize: '13px',
                             backgroundColor: visibleLayers.has(index) ? '#1e1e3f' : '#333',
                             color: visibleLayers.has(index) ? '#667eea' : '#666',
                             fontWeight: 'bold',
                           }}
                         >
                           {visibleLayers.has(index) ? '👁 On' : '👁 Off'}
                         </button>
                       </div>
                       {stencilInfo.hasIslands && (
                         <div style={{ backgroundColor: '#ffe74c', border: '1px solid #f39c12', padding: '5px 8px', marginBottom: '8px', borderRadius: '4px', color: '#c92a2a', fontSize: '12px' }}>
                           ✓ Islands bridged for safe cutting
                         </div>
                       )}
                       <img
                         src={stencilInfo.canvas.toDataURL('image/png')}
                         alt={`Stencil ${index + 1}`}
                         style={{ width: '100%', height: 'auto', display: 'block', border: '1px solid #333' }}
                       />
                       <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                         <button
                           onClick={() => downloadCanvasAsPNG(stencilInfo.canvas, `stencil-${index + 1}-${colorHex.replace('#', '')}.png`)}
                           style={{ flex: 1, padding: '7px 0', background: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)', color: '#031003', border: 'none', borderRadius: '4px', cursor: 'pointer', fontFamily: "'Bangers', cursive", fontSize: '16px', letterSpacing: '1px' }}
                         >
                           PNG
                         </button>
                         <button
                           onClick={async () => {
                             const svgContent = await canvasToSVGPotrace(stencilInfo.canvas, colorHex);
                             if (svgContent) downloadSVG(svgContent, `stencil-${index + 1}-${colorHex.replace('#', '')}.svg`);
                           }}
                           style={{ flex: 1, padding: '7px 0', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontFamily: "'Bangers', cursive", fontSize: '16px', letterSpacing: '1px' }}
                         >
                           SVG
                         </button>
                       </div>
                     </div>
                   );
                 })}
               </div>
             </div>
           );
         })()}
       </div>
     );
}

export default App;
