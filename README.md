# BEAM for BOM: Solar Farm Designer

**Draw a boundary. Beam designs the solar farm, estimates the energy,
and writes the report — then lets you walk the site in 3D.**

Browser-based agentic solar-farm feasibility studio built for the Beam
hackathon. A user draws a land boundary on a satellite globe, and BEAM
(the agent) produces a preliminary utility-scale design end to end:
terrain screening with OSM auto-exclusions, PV table layout, DC/AC
electrical sizing, PVGIS yield estimate, grid/transformer
recommendation, a procurement-ready bill of materials, and a written
proposal. A Three.js preview rebuilds the site on real heightfield
terrain with a time-of-day sun study and walkable first-person mode,
and a conversational layer ("Ask Beam") lets you re-plan the site in
plain language.

> Preliminary feasibility and procurement-planning only. Not a bankable,
> construction-ready, or grid-application design.

## The pipeline

- **Boundary** — draw the site and exclusion zones on satellite imagery
- **Energy** — PVGIS solar-resource assessment and generation estimate
- **Array** — deterministic fixed-tilt PV table layout engine
- **Materials** — DC/AC electrical sizing, transformer rules, BOM, exports

The agent (Beam, Reflection's 501B-parameter reasoning model, via tool
calling) **never invents a number** — every
figure comes from a typed backend tool call. If no Beam endpoint is configured
the app falls back to a deterministic scripted Beam that narrates the same
tool results, so the demo always works (the UI labels it "offline scripted
mode" honestly).

### Beam integration notes

- **Real model**: `Beam-1.0-501B-A23B` via Reflection's OpenAI-compatible
  endpoint (`BEAM_API_BASE=https://api.reflection.ai/openai/v1`).
- **Tools**: `run_full_design` (whole pipeline), `run_stage` (re-run one
  stage — Beam plans narrow changes like "tilt → layout+yield+bom, skip
  terrain"), `compare_scenarios`, `get_design_summary`, `export_project`.
- **Reasoning is visible**: Beam always reasons; its `reasoning_content` is
  captured per turn and shown in the chat UI ("Beam's reasoning"), plus
  latency + token usage per reply. Effort is selectable (`low`→`max`) via
  `BEAM_REASONING_EFFORT` or the UI selector.
- **Multi-turn quirk**: the Reflection API *requires* `reasoning_content` to
  be echoed back on every assistant tool-call turn — we preserve it
  verbatim in the message history (a missing field is a `400`). This is
  what makes the loop genuinely multi-turn rather than a stateless wrapper.

## Architecture

```
React + CesiumJS frontend (Esri World Imagery, Turf)
        | REST
FastAPI backend
        +-- Terrain service    (Open-Meteo/Open-Elevation, slope/aspect mask)
        +-- Layout service     (Shapely clipping, azimuth-rotated table grid)
        +-- Electrical service (strings, inverters, cables, transformer rules)
        +-- Yield service      (PVGIS via pvlib, hourly -> monthly fallback, cached)
        +-- BOM service        (deterministic package generation)
        +-- Export service     (GeoJSON / CSV / Markdown / JSON)
        +-- Agent layer        (OpenAI-compatible Beam endpoint or scripted fallback)
SQLite project store
```

## Tech stack

- **Frontend**: React + Vite + TypeScript, CesiumJS, Esri World Imagery, Recharts, Tailwind CSS
- **Backend**: Python 3.11+, FastAPI, Pydantic, Shapely, pyproj, pvlib, httpx, SQLite
- **Agent**: OpenAI-compatible tool calling against `BEAM_API_BASE`

## Run locally

```bash
# backend
cd backend
pip install -r requirements.txt
uvicorn app.main:app --port 8000

# frontend (new terminal)
cd frontend
npm install
npm run dev    # http://localhost:5173, proxies /api -> :8000
```

Optional real-Beam agent (see `backend/.env.example`):

```bash
export BEAM_API_BASE=... BEAM_API_KEY=... BEAM_MODEL=...
```

## Deploy (Hugging Face Space)

Create a **Docker** Space and push this repo — `Dockerfile` builds the frontend
and serves it from FastAPI on port 7860. Set `BEAM_API_*` as Space secrets.

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/site` | Create site (boundary + exclusions GeoJSON) |
| `POST /api/terrain` | Elevation grid, slope/aspect, suitability mask |
| `POST /api/layout` | PV table layout |
| `POST /api/electrical` | Strings, inverters, cables, transformer |
| `POST /api/yield` | PVGIS energy estimate |
| `POST /api/bom` | Bill of materials |
| `POST /api/design` | Full workflow (main agent endpoint) |
| `POST /api/chat` | Beam agent (tool-calling or scripted fallback) |
| `POST /api/export` | GeoJSON + CSV BOM + Markdown proposal + JSON |
| `GET /api/geocode` | Place search (Open-Meteo) |

## Demo scenario

Click **Run the demo**: a ~7 ha real OSM farmland parcel at Escrick
Field in the Vale of York — flat, unprotected, with a pond and a copse
the pipeline detects from OpenStreetMap and excludes automatically.
The layout engine packs 145 tables / 3,480 modules around them for a
1.5 MWp array, estimated at ~1,383 MWh/yr via PVGIS.

**60-second demo:** run the demo → globe fly-in → design pipeline →
**Report** for capacity, yield and the BOM one-pager → **3D Preview**
for the terrain scene, sun-slider exposure study and first-person walk
(WASD + mouse, sprint/jump, equipment inspection labels, cable
trenches, weather mast, gate) → **Ask Beam** e.g. "reduce land use by
20%" — it re-runs the layout with a denser packing factor and updates
the BOM.

During terrain analysis, BEAM also queries OpenStreetMap for buildings,
water bodies and woodland inside the boundary and auto-excludes them
(with per-type buffers) — no VLM required, and every detection is real
geodata the agent can cite.

## Data sources

- Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community —
  non-commercial demonstration use
- Elevation: Open-Meteo Elevation API (fallback: Open-Elevation), cached
- Yield: PVGIS 5.x via `pvlib.iotools` (hourly, monthly fallback, cached)
- Geocoding: Open-Meteo Geocoding API

## Limitations

- Feasibility-grade only; slope limit 8°, no shading simulation, no planning
  constraints, no geotechnical assessment
- Cable routes are simplified right-angle estimates
- Transformer/grid sizing is rule-based — **DNO confirmation always required**
- Elevation grid resolution ~30 m; small sites densify automatically

## Roadmap

Rooftop + shading → trackers / east-west → cable routing optimisation →
supplier pricing → CapEx/LCOE model → DNO workflow → planning constraints →
construction-ready exports.

## License

MIT (hackathon prototype)
