import { useState, useRef, useCallback, useEffect } from 'react';

interface ColorInfo {
  hex: string;
  rgb: [number, number, number];
  frequency: number;
}

interface StencilInfo {
  canvas: HTMLCanvasElement;
  hasIslands: boolean;
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
  const [contrast, setContrast] = useState<number>(180);
  const [simplify, setSimplify] = useState<number>(0);
  const [posterize, setPosterize] = useState<number>(0);
  const [warmth, setWarmth] = useState<number>(0);
  const [minFeatureSize, setMinFeatureSize] = useState<number>(100);
  const [gapCloseRadius, setGapCloseRadius] = useState<number>(4);
  const [bridgeWidth, setBridgeWidth] = useState<number>(4);
  const [minIslandSize, setMinIslandSize] = useState<number>(50);
  const [selection, setSelection] = useState<{x: number, y: number, w: number, h: number} | null>(null);
  const selectionDragRef = useRef<{startX: number, startY: number} | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rawImageRef = useRef<HTMLImageElement | null>(null);

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

  const colorDistance = useCallback((rgb1: [number, number, number], rgb2: [number, number, number]): number => {
    const dr = rgb1[0] - rgb2[0];
    const dg = rgb1[1] - rgb2[1];
    const db = rgb1[2] - rgb2[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
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
      void main() {
        vec4 pixel = texture2D(u_image, v_texCoord);
        if (pixel.a < 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0); return; }
        vec3 rgb = pixel.rgb;
        float minDist = 1.0e10;
        int closestIdx = 0;
        for (int i = 0; i < 20; i++) {
          vec3 diff = rgb - u_palette[i];
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

  // Apply contrast + blur + posterization to raw image, returns adjusted ImageData
  const applyContrastAndBlur = useCallback((img: HTMLImageElement, contrastVal: number, simplifyVal: number, posterizeVal: number, width: number, height: number): ImageData => {
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const scratchCtx = scratch.getContext('2d')!;

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

    scratchCtx.putImageData(imageData, 0, 0);
    return scratchCtx.getImageData(0, 0, width, height);
  }, []);

  // Connect islands to boundary — 8-connected BFS (diagonal moves) for true shortest paths,
  // then draw each bridge with configurable thickness via square dilation.
  // Islands smaller than minIslandPx are filled (erased) instead of bridged.
  const bridgeIslands = useCallback((canvas: HTMLCanvasElement, bridgeHalfW: number, minIslandPx: number): void => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const width = canvas.width;
    const height = canvas.height;
    const n = width * height;

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

      // Small islands: erase (fill transparent → they'll show as stencil color in the layer)
      if (component.length <= minIslandPx) {
        for (const px of component) data[px * 4 + 3] = 255; // make opaque = stencil color
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
        for (const px of component) data[px * 4 + 3] = 255;
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
    const ctx = canvas.getContext('2d');
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
    const ctx = canvas.getContext('2d');
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
    const ctx = canvas.getContext('2d');
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

  const extractColors = useCallback((imageData: ImageData, size: number): ColorInfo[] => {
    const pixels = imageData.data;
    const colorMap = new Map<string, number>();

    const step = 4;
    for (let i = 0; i < pixels.length; i += 4 * step) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const a = pixels[i + 3];

      if (a < 128) continue;

      const qr = Math.round(r / 32) * 32;
      const qg = Math.round(g / 32) * 32;
      const qb = Math.round(b / 32) * 32;

      const key = `${qr},${qg},${qb}`;
      colorMap.set(key, (colorMap.get(key) || 0) + 1);
       }

    const sortedColors = Array.from(colorMap.entries())
         .sort((a, b) => b[1] - a[1])
         .slice(0, 50);

    return sortedColors.map(([key, frequency]) => {
      const [r, g, b] = key.split(',').map(Number);
      return {
        hex: rgbToHex(r, g, b),
        rgb: [r, g, b] as [number, number, number],
        frequency
       };
     }).slice(0, size);
    }, [rgbToHex]);

  const processImage = useCallback((img: HTMLImageElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
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

    // Apply adjustments and display on canvas
    const adjustedData = applyContrastAndBlur(img, contrast, simplify, posterize, width, height);
    ctx.putImageData(adjustedData, 0, 0);
    setOriginalImageData(adjustedData);

    const extractedColors = extractColors(adjustedData, paletteSize);
    setColors(extractedColors);
    }, [extractColors, paletteSize, contrast, simplify, posterize, applyContrastAndBlur]);

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

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    const pt = canvasEventToPixel(e);
    if (!pt) return;
    selectionDragRef.current = { startX: pt.x, startY: pt.y };
    setSelection({ x: pt.x, y: pt.y, w: 0, h: 0 });
  }, [canvasEventToPixel]);

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
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
  }, [canvasEventToPixel]);

  const handleCanvasMouseUp = useCallback(() => {
    selectionDragRef.current = null;
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
      // 1. Close gaps and small holes → clean, connected regions
      morphologicalClose(canvas, gapCloseRadius, targetColors[i]);
      // 2. Remove blobs still too small to cut
      removeSmallRegions(canvas, minFeatureSize);
      // 3. Fix any remaining isolated islands
      const hasIslands = detectIslands(canvas);
      if (hasIslands) bridgeIslands(canvas, Math.floor(bridgeWidth / 2), minIslandSize);
      stencilInfos.push({ canvas, hasIslands });
    }

    setStencilCanvases(stencilInfos);
    setProcessingProgress(null);
    isGeneratingRef.current = false;
  }, [generateAllStencilsWebGL, generateStencilCPU, morphologicalClose, removeSmallRegions, detectIslands, bridgeIslands, gapCloseRadius, minFeatureSize, bridgeWidth, minIslandSize]);

  // Live preview of adjustments on canvas without triggering stencil regeneration
  const previewAdjustments = useCallback(() => {
    if (!rawImageRef.current || !imageDimensions || !canvasRef.current) return;
    const {width, height} = imageDimensions;
    const adjustedData = applyContrastAndBlur(rawImageRef.current, contrast, simplify, posterize, width, height);
    const ctx = canvasRef.current.getContext('2d')!;
    ctx.putImageData(adjustedData, 0, 0);
    }, [imageDimensions, contrast, simplify, posterize, applyContrastAndBlur]);

  // Apply adjustments and regenerate stencils
  const handleApplyAdjustments = useCallback(() => {
    if (!rawImageRef.current || !imageDimensions) return;
    const {width, height} = imageDimensions;
    const adjustedData = applyContrastAndBlur(rawImageRef.current, contrast, simplify, posterize, width, height);
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) ctx.putImageData(adjustedData, 0, 0);
    setOriginalImageData(adjustedData);
    const extractedColors = extractColors(adjustedData, paletteSize);
    setColors(extractedColors);
    // Run generation immediately with the freshly computed data (avoids stale state)
    runGeneration(adjustedData, extractedColors, width, height);
    }, [imageDimensions, contrast, simplify, posterize, applyContrastAndBlur, extractColors, paletteSize, runGeneration]);

  const updatePreview = useCallback(() => {
    if (!originalImageData || colors.length === 0 || !imageDimensions || !previewCanvasRef.current) return;
    const {width, height} = imageDimensions;
    const previewCtx = previewCanvasRef.current.getContext('2d');
    if (!previewCtx) return;

    // Set canvas pixel dimensions to match image
    previewCanvasRef.current.width = width;
    previewCanvasRef.current.height = height;

    previewCtx.clearRect(0, 0, width, height);
    previewCtx.fillStyle = 'white';
    previewCtx.fillRect(0, 0, width, height);

    stencilCanvases.forEach(stencilInfo => {
      previewCtx.drawImage(stencilInfo.canvas, 0, 0);
      });
    }, [stencilCanvases, originalImageData, colors.length, imageDimensions]);

  const handleColorPickerChange = (newHex: string) => {
    if (selectedColorIndex < colors.length) {
      const rgb = hexToRgb(newHex);
      const newColors = [...colors];
      newColors[selectedColorIndex] = {
        ...newColors[selectedColorIndex],
        hex: newHex,
        rgb
       };
      setColors(newColors);
      }
    };

  const handlePaletteSizeChange = (size: number) => {
    setPaletteSize(size);
    if (originalImageData) {
      const extractedColors = extractColors(originalImageData, size);
      setColors(extractedColors);
      }
    };

  const handleResetColors = () => {
    if (originalImageData) {
      const extractedColors = extractColors(originalImageData, paletteSize);
      setColors(extractedColors);
      }
    };

  const downloadCanvasAsPNG = (canvas: HTMLCanvasElement, filename: string) => {
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    link.click();
    };

  // Live preview on slider changes (canvas only, no stencil regeneration)
  useEffect(() => {
    previewAdjustments();
    }, [previewAdjustments]);

  useEffect(() => {
    updatePreview();
    }, [updatePreview]);

  return (
       <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif', maxWidth: '1400px', margin: '0 auto' }}>
         <h1>Stencil Creator</h1>
      
         <div style={{ marginBottom: '20px' }}>
           <button
             onClick={() => fileInputRef.current?.click()}
             style={{
               padding: '10px 20px',
               backgroundColor: '#667eea',
               color: 'white',
               border: 'none',
               borderRadius: '5px',
               cursor: 'pointer'
               }}
             >
             Upload Image
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
           <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: '5px' }}>
             <h3 style={{ margin: '0 0 12px 0', fontSize: '16px' }}>Image Adjustments</h3>
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
                   Min feature: {minFeatureSize}px²
                 </label>
                 <input
                   type="range"
                   min={0}
                   max={2000}
                   step={25}
                   value={minFeatureSize}
                   onChange={(e) => setMinFeatureSize(Number(e.target.value))}
                   style={{ width: '100%' }}
                 />
                 <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#888' }}>
                   <span>All detail</span><span>Medium</span><span>Bold only</span>
                 </div>
               </div>
               <div style={{ flex: 1, minWidth: '200px' }}>
                 <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px', fontWeight: 'bold' }}>
                   Close gaps: {gapCloseRadius === 0 ? 'Off' : `${gapCloseRadius}px`}
                 </label>
                 <input
                   type="range"
                   min={0}
                   max={20}
                   value={gapCloseRadius}
                   onChange={(e) => setGapCloseRadius(Number(e.target.value))}
                   style={{ width: '100%' }}
                 />
                 <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#888' }}>
                   <span>Off</span><span>Medium (4px)</span><span>Max (20px)</span>
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
                     padding: '10px 24px',
                     backgroundColor: '#27ae60',
                     color: 'white',
                     border: 'none',
                     borderRadius: '5px',
                     cursor: 'pointer',
                     fontWeight: 'bold',
                     fontSize: '14px'
                   }}
                 >
                   Apply &amp; Generate Stencils
                 </button>
               </div>
             </div>
           </div>
         )}

         {processingProgress && (
           <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#ecf0f1', borderRadius: '5px' }}>
             <div style={{ marginBottom: '8px', fontWeight: 'bold', fontSize: '14px' }}>
               {processingProgress.label}
             </div>
             <div style={{ width: '100%', height: '20px', backgroundColor: '#bdc3c7', borderRadius: '3px', overflow: 'hidden' }}>
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

         <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginBottom: '20px' }}>
           <div style={{ flex: 1, minWidth: '300px' }}>
             <h2>Original Image</h2>
             <div
               ref={canvasContainerRef}
               style={{ position: 'relative', display: 'inline-block', width: '100%', cursor: imageDimensions ? 'crosshair' : 'default' }}
               onMouseDown={handleCanvasMouseDown}
               onMouseMove={handleCanvasMouseMove}
               onMouseUp={handleCanvasMouseUp}
               onMouseLeave={handleCanvasMouseUp}
             >
               <canvas
                 ref={canvasRef}
                 style={{ border: '1px solid #ccc', width: '100%', height: 'auto', display: 'block', userSelect: 'none' }}
               />
               {selection && selection.w > 2 && selection.h > 2 && imageDimensions && (() => {
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
             </div>
             {selection && selection.w > 4 && selection.h > 4 && (
               <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                 <button
                   onClick={handleCropToSelection}
                   style={{ padding: '6px 16px', backgroundColor: '#e74c3c', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                 >
                   ✂ Crop to Selection
                 </button>
                 <button
                   onClick={() => setSelection(null)}
                   style={{ padding: '6px 12px', backgroundColor: '#95a5a6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                 >
                   Clear
                 </button>
               </div>
             )}
           </div>
        
           <div style={{ flex: 1, minWidth: '500px' }}>
             <h2>Preview (Layered Stencils)</h2>
             <canvas 
               ref={previewCanvasRef} 
               style={{ border: '1px solid #ccc', width: '100%', height: 'auto', display: 'block' }} 
             />
           </div>
         </div>

         <div style={{ marginTop: '20px' }}>
           <h2>Colors ({colors.length})</h2>
           <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
             {colors.map((color, index) => (
               <div
                 key={index}
                 onClick={() => setSelectedColorIndex(index)}
                 style={{
                   padding: '10px',
                   border: index === selectedColorIndex ? '2px solid #333' : '1px solid #ccc',
                   borderRadius: '5px',
                   cursor: 'pointer',
                   backgroundColor: color.hex,
                   minWidth: '80px'
                   }}
                 >
                 <div style={{ width: '50px', height: '50px', backgroundColor: color.hex, marginBottom: '5px' }} />
                 <div style={{ fontSize: '12px' }}>Color {index + 1}</div>
               </div>
             ))}
           </div>
        
           {colors.length > 0 && (
             <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '20px' }}>
               <label>Edit Selected Color: </label>
               <input
                 type="color"
                 value={colors[selectedColorIndex]?.hex || '#000000'}
                 onChange={(e) => handleColorPickerChange(e.target.value)}
                 style={{ width: '50px', height: '30px' }}
               />
               <button
                 onClick={handleResetColors}
                 style={{
                   padding: '5px 15px',
                   backgroundColor: '#e74c3c',
                   color: 'white',
                   border: 'none',
                   borderRadius: '5px',
                   cursor: 'pointer'
                   }}
                 >
                 Reset All Colors
               </button>
             </div>
           )}
         </div>

         <div style={{ marginTop: '20px', marginBottom: '20px' }}>
           <h2>Palette Size</h2>
           <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
             {Array.from({ length: 20 }, (_, i) => i + 1).map((size) => (
               <button
                 key={size}
                 onClick={() => handlePaletteSizeChange(size)}
                 style={{
                   padding: '5px 10px',
                   backgroundColor: size === paletteSize ? '#667eea' : '#f0f0f0',
                   color: size === paletteSize ? 'white' : '#333',
                   border: 'none',
                   borderRadius: '3px',
                   cursor: 'pointer'
                   }}
                 >
                   {size}
               </button>
             ))}
           </div>
         </div>

         {stencilCanvases.length > 0 && (
           <div style={{ marginTop: '20px' }}>
             <h2>Individual Stencils (Full Size)</h2>
             <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
               {stencilCanvases.map((stencilInfo, index) => (
                 <div key={index} style={{ border: stencilInfo.hasIslands ? '2px solid #f39c12' : '1px solid #ccc', padding: '10px', backgroundColor: 'white' }}>
                   <h3 style={{ margin: '0 0 10px 0' }}>Stencil {index + 1} - {colors[index]?.hex}</h3>
                   {stencilInfo.hasIslands && (
                     <div style={{ backgroundColor: '#ffe74c', border: '2px solid #f39c12', padding: '8px', marginBottom: '10px', borderRadius: '4px', color: '#c92a2a', fontWeight: 'bold', fontSize: '14px' }}>
                       ✓ Islands detected and connected with bridges to the template edge for safe cutting.
                     </div>
                   )}
                   <img 
                     src={stencilInfo.canvas.toDataURL('image/png')} 
                     alt={`Stencil ${index + 1}`}
                     style={{ width: '100%', height: 'auto', display: 'block' }}
                   />
                   <button
                     onClick={() => downloadCanvasAsPNG(stencilInfo.canvas, `stencil-color-${index + 1}.png`)}
                     style={{
                       marginTop: '10px',
                       padding: '5px 15px',
                       backgroundColor: '#2ecc71',
                       color: 'white',
                       border: 'none',
                       borderRadius: '3px',
                       cursor: 'pointer'
                       }}
                     >
                     Download
                   </button>
                 </div>
               ))}
             </div>
           </div>
         )}
       </div>
     );
}

export default App;
