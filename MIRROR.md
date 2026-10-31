# BEAM for BOM — handoff for rebuilding/extending with Mirror

Hand this file to Mirror (Reflection's agent) on the Mac. It describes the
system so Beam can extend or rebuild parts without reverse-engineering it.

## What this is

"BEAM for BOM" — draw a land boundary on a satellite globe; Beam-1.0 (via
tool calls) drives a deterministic engineering pipeline and returns a
preliminary solar-farm design + procurement BOM. Built for the Build with
Beam competition (HF Space submission required).

## Layout

```
backend/    FastAPI + Pydantic v2 + Shapely + PyProj + NumPy + httpx + pvlib
  app/main.py            API routes (see list below)
  app/models.py          all request/response models
  app/store.py           sqlite-ish local store (sites + designs)
  app/services/
    design_workflow.py   run_full_design() + run_stage() orchestrator
    agent.py             Beam tool-calling loop (OpenAI-compatible) + offline fallback
    terrain.py           elevation grid → slope/suitability, OSM exclusions
    osm_features.py      Overpass fetch (buildings/water/woodland), disk cache
    layout.py            fixed-tilt table packing engine
    electrical.py        strings/inverters/cables/transformer rules
    yield_service.py     PVGIS via pvlib, cached fallback
    bom.py               BOM generator
    export_service.py    GeoJSON/CSV/MD/JSON exports
    conditions.py        Open-Meteo live site conditions (10-min cache)
  app/demo_site.json     committed demo parcel (Peak District, pond+woodland)
  app/cache/             committed warm caches (elevation/osm/pvgis/conditions)
  tests/test_core.py     pytest, monkeypatched network

frontend/   React 19 + TS + Vite 6 + Tailwind v4 + CesiumJS + Three.js
  src/App.tsx            3-column app shell
  src/MapView.tsx        Cesium globe: draw boundary/exclusions, results layers
  src/Scene3D.tsx        Three.js photoreal preview overlay (the showcase piece)
  src/LeftPanel.tsx      search, draw tools, assumptions form, demo button
  src/RightPanel.tsx     step tracker, live conditions HUD, metrics, BOM,
                         monthly chart, Beam chat (reasoning trace + effort)
  src/terrain.ts         custom terrarium height provider — SAMPLING ONLY,
                         never attach to Cesium globe (breaks rendering)
  src/api.ts             typed API client
```

## API

POST /api/site, GET /api/site/{id}, GET /api/site/{id}/conditions,
POST /api/{terrain,layout,electrical,yield,bom,design}, POST /api/design/stream
(SSE steps), POST /api/chat, POST /api/demo, POST /api/export, GET /api/geocode,
GET /exports/*, GET /api/health (`beam_agent` flag).

## Run

```bash
cd backend && pip install -r requirements.txt
python -m uvicorn app.main:app --port 8000
cd frontend && npm install && npm run dev    # note the printed port (5173+)
```

Copy `backend/.env.example` → `backend/.env` and fill BEAM_* for the live
model (works without it via offline scripted Beam).

## Beam integration contract (important — model-specific)

- Endpoint: OpenAI-compatible `https://api.reflection.ai/openai/v1`,
  model `Beam-1.0-501B-A23B`, chat/completions + tools + `reasoning_effort`.
- **reasoning_content must be echoed back verbatim on every assistant
  tool-call turn** — a turn without it gets HTTP 400. See `_llm_chat`.
- Tools available to the model: run_full_design, run_stage,
  compare_scenarios, get_design_summary, get_site_conditions, export_project.
- Every number in a reply must come from a tool result (system prompt).
- ChatResponse carries `reasoning` (trace) + `meta` (model, effort, latency,
  token usage, mode live|offline-scripted).

## Demo script (for judging)

1. `POST /api/demo` → "Moor Side" parcel, Peak District (pond + woodland
   inside boundary; slope up to ~8.5° so screening visibly triggers).
2. Generate → watch step stream; terrain finds water+woodland via OSM.
3. 3D Preview → heightfield, water, trees, sun slider + flythrough.
4. Chat: "reduce land use by 20%" (run_full_design w/ land_use_factor 0.8),
   "change tilt to 25°" (run_stage path), "how is it producing right now?"
   (get_site_conditions → live Open-Meteo).
5. Export package.

## Suggested Mirror tasks

- Port Scene3D terrain to real OSM-derived hedges/roads; add a site-photo
  mode or Gaussian-splat-lite background.
- Improve table geometry to projected fixed-tilt footprint + shading-derived
  row pitch.
- MultiPolygon boundary support.
- The UI/UX polish backlog in AGENTS.md.

## Constraints

- Caches in backend/app/cache are committed on purpose (offline demo).
- Keep determinism: services compute, Beam reasons. Never let the model
  invent numbers.
- Do not commit backend/.env (contains the API key).
