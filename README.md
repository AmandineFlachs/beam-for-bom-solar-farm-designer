# BEAM for BOM: Solar Farm Designer

## Project summary

BEAM for BOM is an agentic solar-farm feasibility studio built on Beam,
Reflection's 501B-parameter reasoning model, for the **Build with Beam**
challenge. The problem it tackles: first-pass site screening for
utility-scale solar still takes weeks of manual GIS work per site,
redone every time a constraint changes. You draw a land boundary on
a satellite globe and Beam designs the farm end to end: it detects
constraints from OpenStreetMap, packs panel tables around them, sizes
the electrical kit, estimates generation from PVGIS data, and writes a
procurement-ready bill of materials and proposal. A Three.js preview
rebuilds the site on real elevation terrain with a time-of-day sun
study and a walkable first-person mode, and a conversational layer
("Ask Beam") lets you re-plan the site in plain language while you
watch it reason.

[![Video](docs/video-thumbnail.png)](VIDEO_URL)

## Repository

```bash
├── backend
│   ├── app            # FastAPI services: terrain, layout, electrical, yield, BOM, agent
│   └── eval           # Agentic eval: tasks.json, run_eval.py, results.csv, ledger.jsonl
├── docs               # Architecture + agent-loop diagrams
├── eval               # Submission assets: video script, diagrams (HTML), session notes
├── frontend           # React + Vite + TypeScript: Cesium MapView, Three.js Scene3D
├── Dockerfile         # Single-container build for Hugging Face Spaces
├── LICENSE
└── README.md
```

## Architecture

Two 3D surfaces share one data source. A React + Cesium globe is the
working map (every entity flat on the same reference ellipsoid), and a
Three.js scene is the cinematic preview: a real heightfield from
Mapterhorn DEM tiles with draped Esri imagery. A FastAPI backend runs
the deterministic engineering services; Beam drives them through a
tool-calling loop.

![Architecture](docs/architecture.png)

```
React + CesiumJS frontend (Esri World Imagery, Turf)      ← working map
React + Three.js scene (Mapterhorn DEM, draped imagery)   ← 3D preview
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

![Agent loop](docs/agent_loop.png)

### Beam integration

- **Real model**: `Beam-1.0-501B-A23B` via Reflection's OpenAI-compatible
  endpoint (`BEAM_API_BASE=https://api.reflection.ai/openai/v1`).
- **Tools**: `run_full_design` (whole pipeline), `run_stage` (re-run one
  stage; Beam plans narrow changes like "tilt → layout+yield+bom, skip
  terrain"), `compare_scenarios`, `get_design_summary`, `export_project`.
- **Reasoning is visible**: Beam always reasons; its `reasoning_content`
  is captured per turn and shown in the chat UI ("Beam's reasoning"),
  plus latency + token usage per reply. Effort is selectable
  (`low`→`max`) via `BEAM_REASONING_EFFORT` or the UI selector.
- **Multi-turn quirk**: the Reflection API *requires* `reasoning_content`
  to be echoed back on every assistant tool-call turn. We preserve it
  verbatim in the message history (a missing field is a `400`). This is
  what makes the loop genuinely multi-turn rather than a stateless
  wrapper.
- **Grounding**: every figure comes from a typed tool call; Beam never
  invents a number. With no Beam endpoint configured, the app falls
  back to a deterministic scripted Beam narrating real tool results,
  and the UI labels it "offline scripted mode".
- **Call ledger**: all LLM calls land in a JSONL ledger
  (`backend/eval/ledger.jsonl`): surface, effort, per-call tokens
  including reasoning, tool calls with args, latency.

The services compute and Beam decides: it maps intent to tool calls
("reduce land use 20%" → `run_full_design(land_use_factor=0.8)`),
decides which pipeline stages a change actually requires (the hard
part; see eval below), and narrates answers grounded only in tool
output. Asked to "just guess" a number, it called a tool instead in 5
of 6 runs.

## Evaluating Beam

`backend/eval/tasks.json` holds 11 chat prompts, each with a rule-based
grader that checks three things: did Beam call the right tool, did it
re-run only the pipeline stages the change actually requires
(`terrain → layout → electrical → yield → bom`), and are its numbers
grounded in tool output. Example: "change the tilt to 25°" should call
`run_stage` and re-run `layout, yield, bom`; `terrain` should stay
skipped (the site didn't move) and so should `electrical` (the wiring
didn't change).

Each task ran at three reasoning efforts, 2 runs per cell, against the
live model: 66 runs total (`backend/eval/results.csv`).

| effort | runs passed | avg reasoning tokens | avg completion tokens | avg latency |
|---|---|---|---|---|
| low    | 16/22 | 190 | 602   | 5.8 s |
| medium | 16/22 | 449 | 919   | 7.2 s |
| high   | 15/22 | 748 | 1,279 | 9.1 s |

The failures concentrate in one category. Tool selection is correct in
nearly every run at every effort, so `high` buys ~2.1× the output
tokens for no measured gain.

![Effort vs cost](docs/effort_cost.png)

The observed failure mode is scoping: on narrow edits like the tilt
change above, Beam picks `run_stage` correctly but re-runs
`electrical` anyway, in all 12 narrow-edit runs (2 tasks × 2 runs ×
3 efforts).

![Stage scoping](docs/scoping_map.png)

Re-run with `uv run python eval/run_eval.py --effort low medium high
--runs 3` (needs a live backend with `BEAM_API_*` set). Small-n caveat:
2 runs per cell is directional, not statistical.

## Tech stack

- **Frontend**: React + Vite + TypeScript, CesiumJS, Three.js, Esri
  World Imagery, Recharts, Tailwind CSS
- **Backend**: Python 3.11+, FastAPI, Pydantic, Shapely, pyproj, pvlib,
  httpx, SQLite
- **Agent**: OpenAI-compatible tool calling against `BEAM_API_BASE`

## Run demo

Needs Python 3.11+ (`uv`) and Node 18+. No API keys required for the
offline scripted mode; a Reflection Beam endpoint enables live mode.

```bash
# backend
cd backend
uv run uvicorn app.main:app --port 8000

# frontend (new terminal)
cd frontend
npm install
npm run dev    # http://localhost:5173, proxies /api -> :8000
```

Then click **Run the demo**: an irregular ~10 ha East York site combining a
mapped farmland field with its adjoining ~1.12 ha waterbody. This is an
illustrative site-boundary assumption; land ownership is not verified. BEAM
detects the waterbody and its 5 m buffer (~1.35 ha), nearby roads/woodland, and the
adjoining farmstead yard: five mapped buildings in the east-side farmstead pocket, shown as
red no-panel areas; Heeling House across the pond remains outside the site.
The 2.5 MWp target produces 248 tables / 5,952 modules for a 2.559 MWp
array, estimated at ~2,364.5 MWh/yr via PVGIS.

**Tour:** run the demo → **Report** → **3D Preview** (terrain scene,
sun study, first-person walk) → **Ask Beam** "reduce land use by 20%".

Optional real-Beam agent (see `backend/.env.example`):

```bash
export BEAM_API_BASE=... BEAM_API_KEY=... BEAM_MODEL=...
```

## Data & limitations

Data: Esri/Maxar imagery (non-commercial demo use), Mapterhorn DEM,
Open-Meteo elevation + geocoding, OpenStreetMap exclusions, PVGIS 5.x
yield via `pvlib.iotools`, SimReady GLB props by
[codepawl/simready-glb](https://github.com/codepawl/simready-glb)
(CC-BY-4.0). Elevation, OSM and PVGIS responses are cached.

Feasibility-grade only: slope limit 8°, no shading simulation, no
planning constraints, simplified right-angle cable routes, rule-based
transformer/grid sizing — **DNO confirmation always required**.
Elevation grid ~30 m; small sites densify automatically.

## Team

- Amandine Flachs
- Built with Mirror (Reflection's agent) and Devin (Cognition's
  agent): Mirror wrote MultiPolygon boundaries, `/api/proposal` and
  shading-derived row pitch (`eval/mirror_session.md`); agent commits
  verifiable in git.

## License

MIT, as found in the [LICENSE](LICENSE) file.
