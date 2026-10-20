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
| **Left** | Scenes list (add / duplicate / delete) + hierarchy — cameras, lights, planes, texts |
| **Center** | 3D viewport (orbit when not playing) |
| **Right** | Selection inspector + Look sections (display, softboxes, paint, FX, logo) |
| **Bottom** | **Scene mode:** multi-track timeline. **Master mode:** clip strip that sequences scenes |
| **Top** | Scene / Master toggle, Save / Export / Import JSON, Preview, Record |

## Scenes + master

Projects are **version 3**: any number of scenes, each with its own look, cameras, and timeline. The **master** sequence is an ordered list of clips (scene + in/out) that assemble the final commercial.

1. Edit shots in **Scene** mode (Cut / Animate on the scene timeline).
2. Add more scenes from the left panel (**+** / **Dup**).
3. Switch to **Master**, add clips, reorder / trim, then **Preview** or **Record**.
4. Record in Master mode exports the full sequence; Record in Scene mode exports only the active scene.

Older v2 project JSON files migrate automatically on import / load.

## Authoring a commercial

1. Orbit to a hero frame → select a camera → **Capture view**.
2. Add spot lights and matte **planes** for shadow wipes (planes cast shadows; softboxes are look-dev only).
3. Add **text** (presets from car specs) — rendered in-canvas so it appears in the MP4.
4. Scrub the playhead → **Cut** (switch camera) or **Animate** (move within a shot).
5. Build the **Master** sequence → **Play** / **Preview** → **Record** to export `bmw-m-hybrid-v8-wrt.mp4`.

Projects autosave to `localStorage` (`wrt-paddock-project`). Use **Export JSON** for backups.

First MP4 export downloads ffmpeg.wasm cores from jsDelivr (needs network).

## Car specs

See [`src/data/carSpecs.ts`](src/data/carSpecs.ts) — from the [WRT BMW M Hybrid V8 page](https://www.w-racingteam.com/racing/cars/bmw-m-hybrid-v8-7).

## Roadmap

- Embeddable website player (play/loop + interaction) sharing the same project JSON

## Stack

Vite · TypeScript · Three.js · @ffmpeg/ffmpeg
