# BMW M Hybrid V8 — WRT Director

Three.js paddock viewer + **commercial video authoring** for the **#15 BMW M Hybrid V8** (Team WRT). Dial the wet-studio look, then direct cameras, lights, shadow planes, and titles on a timeline and export an H.264 MP4.

## Quick start

```bash
npm install
npm run dev
```

Open the local Vite URL (default `http://localhost:5173`).

Default model: `public/models/bmw-m-hybrid-v8-15-wrt.glb`  
WRT logo: `public/brand/wrt-logo.png`  
Floor: `public/textures/concrete_floor/` — Poly Haven [concrete_floor](https://polyhaven.com/a/concrete_floor) (CC0)

Drag-and-drop another `.glb` / `.gltf` onto the window to swap models.

## Director UI

| Panel | What it does |
|--------|----------------|
| **Left** | Scene hierarchy — cameras, custom lights, occluder planes, texts |
| **Center** | 3D viewport (orbit when not playing) |
| **Right** | Selection inspector + Look sections (display, softboxes, paint, FX, logo) |
| **Bottom** | Multi-track timeline — scrub, play, keyframes |
| **Top** | Save / Export / Import project JSON, Record commercial |

## Authoring a commercial

1. Orbit to a hero frame → select a camera → **Capture view**.
2. Add spot lights and matte **planes** for shadow wipes (planes cast shadows; softboxes are look-dev only).
3. Add **text** (presets from car specs) — rendered in-canvas so it appears in the MP4.
4. Scrub the playhead → **+ Keyframe** on the selected object.
5. **Play** to preview → **Record** to play from `t=0` and export `bmw-m-hybrid-v8-wrt.mp4`.

Projects autosave to `localStorage` (`wrt-paddock-project`). Use **Export JSON** for backups.

First MP4 export downloads ffmpeg.wasm cores from jsDelivr (needs network).

## Car specs

See [`src/data/carSpecs.ts`](src/data/carSpecs.ts) — from the [WRT BMW M Hybrid V8 page](https://www.w-racingteam.com/racing/cars/bmw-m-hybrid-v8-7).

## Roadmap

- Embeddable website player (play/loop + interaction) sharing the same project JSON

## Stack

Vite · TypeScript · Three.js · @ffmpeg/ffmpeg
