# Graffiti Stencil Creator

A browser-based tool for turning photos and illustrations into print-ready multi-layer stencils. Upload an image, pick your colour palette, tweak the settings, and export clean vector SVG files ready for a cutting plotter or laser cutter.

![Preview screenshot](docs/screenshot.png)

---

## Features

### Image Processing
- **Upload any image** — PNG, JPEG, WebP, GIF, etc.
- **Crop to selection** — draw a rectangle on the preview to focus on the area you care about
- **Contrast & Blur sliders** — boost edges or smooth noise before tracing
- **Posterize** — reduce tonal complexity to 2–8 levels
- **Live preview** — all adjustments reflect on the canvas in real time before you commit

### Colour Palette
- **Auto-detect** — K-Means++ clustering extracts 1–20 dominant colours from your image
- **20+ preset palettes** — EGA, ZX Spectrum, C64, PICO-8, DawnBringer 32, Game Boy, Street Art, and more
- **Manual editing** — click any swatch to select it, then use the colour picker to change it
- **Click-to-select in preview** — click directly on the layered preview canvas to jump to that layer's colour
- **Merge layers** — tick two or more stencils and merge them into one combined layer
- **Reset** — revert to auto-detected or preset colours at any time

### Stencil Generation
- **WebGL-accelerated** colour separation (GPU path) with automatic CPU fallback
- **Otsu sharpening** — removes borderline pixels near colour boundaries for crisp edges
- **Island absorption slider** — absorbs isolated pixel specks (1–1024 px²) into whichever neighbouring colour touches them most; live preview updates instantly
- **Bridge islands** — automatically connects floating colour islands to the boundary so every stencil remains cuttable in one piece
- **Layer visibility toggles** — show/hide individual layers in the composite preview
- **Coverage percentage** shown per layer; layers covering < 0.5 % of the image are hidden automatically

### SVG Export
- **Potrace tracing** — each stencil is converted to smooth Bézier curves (not pixel rectangles) using the [kilobtye/potrace](https://github.com/kilobtye/potrace) JavaScript port
- **Per-stencil SVG** — download any individual layer as a clean vector file
- **Download All SVGs** — traces and downloads every visible layer as separate numbered files in one click
- **SVG Vector Preview** — composite all visible layers into a single in-browser SVG preview before downloading; supports re-trace after colour or absorption changes
- **PNG export** — also available per layer for raster use

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI framework | React 19 + TypeScript |
| Build tool | Vite 8 |
| Rendering | HTML Canvas 2D + WebGL |
| Vector tracing | [kilobtye/potrace](https://github.com/kilobtye/potrace) (JS port of Potrace) |
| Colour clustering | Custom K-Means++ (runs in-browser, no server) |
| Morphology | Custom integral-image dilation/erosion (O(N)) |

No backend. Everything runs entirely in the browser.

---

## Getting Started

### Prerequisites
- Node.js 18 or later
- npm 9 or later

### Install & run

```bash
git clone https://github.com/your-username/grafitti-stencil-creator.git
cd grafitti-stencil-creator/stencil-app
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build for production

```bash
npm run build
# output is in stencil-app/dist/
```

---

## Usage

1. **Upload** a photo or illustration with the "Upload Image" button.
2. Adjust **Contrast**, **Simplify** (blur), and **Posterize** to taste — the preview canvas updates live.
3. Choose a **palette source**: auto-detect (pick the number of colours) or one of the preset palettes.
4. Click **Apply & Generate Stencils**.
5. Use the **Absorb islands** slider under the preview to clean up specks — the preview updates immediately.
6. Click a colour in the preview to select it, then change it with the inline picker.
7. In the **SVG Vector Preview** section, click **Trace All Layers** to generate smooth Bézier SVG paths.
8. Click **Download All SVGs** to save one SVG file per layer, ready for your cutting program.

### Cutting plotter tips
- Import each SVG layer as a separate colour/pass in your cutting software (Silhouette Studio, Cricut Design Space, Inkscape + axidraw, etc.).
- Use the **Absorb islands** and **Bridge width** controls to ensure every shape is physically connected — isolated islands will fall out of the stencil when cut.
- Increase **Simplify** (blur) before generating if the image has fine noise that creates too many tiny shapes.

---

## Project Structure

```
grafitti-stencil-creator/
├── readme.md
└── stencil-app/
    ├── index.html          # Entry point; loads potrace.js global
    ├── public/
    │   └── potrace.js      # Potrace JS port (served as static asset)
    ├── src/
    │   ├── App.tsx         # Main application component (~1900 lines)
    │   └── index.tsx       # React root mount
    ├── package.json
    ├── tsconfig.json
    └── vite.config.ts
```

---

## Licence

This project is provided as-is for personal and creative use.  
The bundled **potrace.js** is a port of [Potrace](http://potrace.sourceforge.net/) by Peter Selinger and is licensed under **GPL-2.0**.  
All other code in this repository is released under the **MIT licence** unless stated otherwise.

---

## Acknowledgements

- [Peter Selinger](http://potrace.sourceforge.net/) — original Potrace algorithm
- [kilobtye](https://github.com/kilobtye/potrace) — JavaScript port of Potrace
