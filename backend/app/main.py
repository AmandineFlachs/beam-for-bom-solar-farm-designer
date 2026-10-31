"""BEAM for BOM — FastAPI backend."""
from __future__ import annotations

import json
import queue
import threading

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

from . import store
from .models import (
    BOMRequest, ChatRequest, ChatResponse, DesignAssumptions, DesignRequest,
    DesignResponse, ElectricalRequest, ExportRequest, LayoutRequest, Site,
    SiteCreateRequest, SiteCreateResponse, TerrainRequest, YieldRequest,
)
from .services import agent, bom as bom_svc, electrical as elec_svc, export_service
from .services import layout as layout_svc, terrain as terrain_svc, yield_service
from .services.design_workflow import run_full_design
from .services.geo import polygon_centroid, validate_polygon

from pathlib import Path

_DEMO_SITE_PATH = Path(__file__).parent / "demo_site.json"

app = FastAPI(title="BEAM for BOM", version="0.1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok", "beam_agent": agent.beam_configured()}


@app.post("/api/site", response_model=SiteCreateResponse)
def create_site(req: SiteCreateRequest):
    try:
        validate_polygon(req.boundary.model_dump())
        for ex in req.exclusions:
            validate_polygon(ex.geometry.model_dump())
    except ValueError as e:
        raise HTTPException(422, str(e))
    site = Site(
        site_id=store.new_site_id(), name=req.name,
        boundary=req.boundary, exclusions=req.exclusions,
        country=req.country,
        centroid=polygon_centroid(req.boundary.model_dump()),
    )
    from .services.geo import area_ha
    if area_ha(req.boundary.model_dump()) < 0.5:
        raise HTTPException(422, "Site is too small for a viable PV layout.")
    store.save_site(site)
    return SiteCreateResponse(site_id=site.site_id)


@app.get("/api/site/{site_id}", response_model=Site)
def get_site(site_id: str):
    site = store.get_site(site_id)
    if not site:
        raise HTTPException(404, "Site not found")
    return site


def _site_or_404(site_id: str) -> Site:
    site = store.get_site(site_id)
    if not site:
        raise HTTPException(404, "Site not found — create it first via POST /api/site")
    return site


def _stored_result(site_id: str, key: str):
    d = store.get_design(site_id)
    return d.get(key) if d else None


@app.get("/api/site/{site_id}/conditions")
def conditions(site_id: str):
    site = _site_or_404(site_id)
    from .services import conditions as cond_svc
    try:
        return cond_svc.site_conditions(site.centroid["lat"], site.centroid["lon"])
    except Exception as e:
        raise HTTPException(502, str(e))


@app.post("/api/terrain")
def terrain(req: TerrainRequest):
    site = _site_or_404(req.site_id)
    return terrain_svc.analyse_terrain(site, req.grid_resolution_m)


@app.post("/api/layout")
def layout(req: LayoutRequest):
    site = _site_or_404(req.site_id)
    terrain = _stored_result(req.site_id, "terrain")
    return layout_svc.generate_layout(site, req.design_assumptions, terrain)


@app.post("/api/electrical")
def electrical(req: ElectricalRequest):
    site = _site_or_404(req.site_id)
    layout = req.layout or _stored_result(req.site_id, "layout")
    if not layout:
        raise HTTPException(400, "No layout available — run /api/layout first")
    return elec_svc.design_electrical(
        site, _to_layout(layout), req.design_assumptions)


@app.post("/api/yield")
def yield_ep(req: YieldRequest):
    site = _site_or_404(req.site_id)
    layout = req.layout or _stored_result(req.site_id, "layout")
    if not layout:
        raise HTTPException(400, "No layout available — run /api/layout first")
    try:
        return yield_service.estimate_yield(site, _to_layout(layout), req.design_assumptions)
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@app.post("/api/bom")
def bom_ep(req: BOMRequest):
    site = _site_or_404(req.site_id)
    layout = req.layout or _stored_result(req.site_id, "layout")
    elec = req.electrical or _stored_result(req.site_id, "electrical")
    if not layout or not elec:
        raise HTTPException(400, "Layout and electrical results required first")
    yld = req.yield_result or _stored_result(req.site_id, "yield")
    return bom_svc.generate_bom(
        site, _to_layout(layout), _to_electrical(elec), yld, DesignAssumptions())


@app.post("/api/design", response_model=DesignResponse)
def design(req: DesignRequest):
    site = _site_or_404(req.site_id)
    resp, _ = run_full_design(site, req.design_assumptions)
    return resp


@app.post("/api/design/stream")
def design_stream(req: DesignRequest):
    """SSE stream: emits each workflow step as it completes, then the result."""
    site = _site_or_404(req.site_id)
    q: queue.Queue = queue.Queue()

    def run():
        try:
            resp, _ = run_full_design(
                site, req.design_assumptions,
                progress=lambda s: q.put({"type": "step", "data": s}))
            q.put({"type": "result",
                   "data": resp.model_dump(by_alias=True)})
        except Exception as e:
            q.put({"type": "error", "data": {"detail": str(e)}})
        finally:
            q.put(None)

    threading.Thread(target=run, daemon=True).start()

    def gen():
        while True:
            item = q.get()
            if item is None:
                break
            yield f"data: {json.dumps(item, default=str)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/demo")
def load_demo():
    """Preloaded demo site for live judging — works fully offline once caches
    for elevation/PVGIS are warm (they are committed to the repo)."""
    demo = _DEMO_SITE_PATH
    if not demo.exists():
        raise HTTPException(404, "Demo site not found")
    site = Site.model_validate_json(demo.read_text())
    store.save_site(site)  # always refresh — DB may hold a stale demo site
    return {"site_id": site.site_id}


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    return agent.handle_chat(req.site_id, req.message, req.design_assumptions, req.effort)


@app.post("/api/export")
def export(req: ExportRequest):
    design = store.get_design(req.site_id)
    if not design:
        raise HTTPException(404, "No design found — run /api/design first")
    return export_service.export_all(req.site_id, design)


@app.post("/api/proposal")
def proposal(req: ExportRequest):
    design = store.get_design(req.site_id)
    if not design:
        raise HTTPException(404, "No design found — run /api/design first")
    if not agent.beam_configured():
        return {"markdown": export_service._proposal(design), "mode": "template"}
    import json as _json
    messages = [
        {"role": "system", "content":
         "You write the narrative sections of a solar-farm proposal. Every "
         "number must come verbatim from the design JSON provided. Never "
         "invent figures. Output markdown."},
        {"role": "user", "content":
         "Design JSON:\n" + _json.dumps(design, indent=2) +
         "\n\nWrite the site rationale, constraint trade-offs, and warnings "
         "explained as markdown narrative."},
    ]
    body = agent.beam_call(messages, surface="proposal")
    content = body["choices"][0]["message"].get("content", "")
    # echo reasoning_content on tool-less turn not required; done
    return {"markdown": content or export_service._proposal(design),
            "mode": "beam"}


@app.get("/api/geocode")
async def geocode(q: str):
    """Open-Meteo geocoding (free, no key)."""
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": q, "count": 5, "language": "en", "format": "json"})
    results = (r.json() or {}).get("results") or []
    return {"results": [
        {"name": x.get("name"), "lat": x["latitude"], "lon": x["longitude"],
         "admin": x.get("admin1"), "country": x.get("country")}
        for x in results
    ]}


def _to_layout(d):
    from .models import LayoutResult
    return d if isinstance(d, LayoutResult) else LayoutResult(**d)


def _to_electrical(d):
    from .models import ElectricalResult
    return d if isinstance(d, ElectricalResult) else ElectricalResult(**d)


# exports as static files + optional frontend build
app.mount("/exports", StaticFiles(directory=str(export_service.EXPORT_DIR)), name="exports")
try:
    app.mount("/", StaticFiles(directory="../frontend/dist", html=True), name="frontend")
except Exception:
    pass
