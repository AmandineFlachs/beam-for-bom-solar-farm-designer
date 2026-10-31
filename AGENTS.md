# BEAM — solar farm planning

React + Vite + TypeScript frontend (Cesium + Three.js), FastAPI backend (Python, `uv`).

## Run

- Backend: `cd backend && uv run uvicorn app.main:app --port 8000` (or it runs detached; log `/tmp/beam-backend.log`)
- Frontend: `cd frontend && npm run dev` → http://localhost:5173 (node lives in `~/.local/node/bin`)
- Typecheck: `cd frontend && npx tsc --noEmit`

## Rendering architecture — two renderers, one data source

There are deliberately **two** 3D surfaces, and this split is intentional:

- **MapView (Cesium)** — the working map. Flat ellipsoid; every entity
  (boundary, exclusions, suitability dots, tables, electrical) is rendered at
  height 0 on the same reference so nothing can misalign. Free terrain
  providers were tried (Esri quantized-mesh) and rejected — re-draped imagery
  looked worse. Optional `VITE_GOOGLE_MAPS_API_KEY` swaps in photorealistic
  3D tiles, but the project must work without it (key-based, not wanted).
- **Scene3D (Three.js)** — the cinematic preview overlay. Builds a *real*
  heightfield from Mapterhorn Terrarium DEM tiles (z15, `terrain.ts` helpers
  inline in `Scene3D.tsx`), drapes Esri World Imagery on it, and places the
  same GeoJSON geometries via the shared `toXY` lon/lat→metres transform.
  PV tables sit on least-squares **graded pads** blended into the terrain.

Rules for keeping them consistent:

- **Never invent features** — no synthetic hedgerows, trees, or buildings.
  Only render what the design payload / OSM auto-exclusions contain.
- **Never rescale ShapeGeometry** — its vertices are scene-space; `scale`
  shrinks toward the origin and displaces the feature (this caused the
  "panels on water" bug).
- Flat surfaces (water, pads) seat on the polygon's lowest sampled edge.
- If the previews ever must be one world, the path is Google Photorealistic
  3D Tiles behind `VITE_GOOGLE_MAPS_API_KEY` — or reimplement Scene3D
  rendering inside Cesium with locally fetched terrain.

## Ask Beam

- Live mode requires `BEAM_API_BASE` + `BEAM_API_KEY` in `backend/.env`
  (gitignored — do NOT commit; repo is intended to go public).
- Without a `site_id` it deliberately returns `meta.mode: "offline-scripted"`.

## Before publishing

- Scan `chat1.json` / `chat2.json` and the repo for secrets.
- Keep `backend/.env` ignored; `backend/.env.example` has placeholders only.
