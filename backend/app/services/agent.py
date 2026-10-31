"""Beam agent layer.

If BEAM_API_BASE/BEAM_API_KEY/BEAM_MODEL are set (OpenAI-compatible endpoint —
Reflection AI or Hugging Face), /api/chat runs a real tool-calling loop: the
model calls typed tools that wrap the backend services, and every number in its
reply comes from a tool result. Beam's reasoning_content is preserved across
turns (required by the Reflection API) and surfaced to the UI — it's the most
visible proof the model is actually reasoning over the engineering pipeline.
Otherwise a deterministic scripted Beam narrates real tool results (offline
demo resilience), clearly labelled mode="offline-scripted".
"""
from __future__ import annotations

import json
import os
import time

from ..models import ChatResponse, DesignAssumptions, DesignResponse, Site
from .. import store
from .design_workflow import run_full_design, run_stage

SYSTEM_PROMPT = """You are BEAM, a solar-farm pre-design engineer inside the BEAM for BOM application.

Your job is to help a user turn a drawn land boundary into a preliminary
utility-scale solar-farm design by driving a deterministic engineering
pipeline through tools.

Rules:
- Use tools for every numerical result. Never invent module counts, table
  counts, yield, cable lengths, inverter counts, transformer sizes, or BOM
  quantities.
- Clearly distinguish calculated results, user assumptions, engineering
  recommendations, and items requiring external confirmation.
- Explain trade-offs between land use, shading risk, DC/AC ratio, energy
  yield, and BOM cost/complexity. Use conservative assumptions.
- Flag transformer, grid-connection, planning, and shading issues as
  requiring confirmation.

Pipeline guidance:
- For a fresh design or a broad change (density, capacity, tilt), call
  run_full_design once — it runs terrain → layout → electrical → yield → BOM.
- For a narrow change (e.g. only the tilt), prefer run_stage: re-run layout,
  then yield, then bom; terrain is unaffected by array parameters, and
  electrical only needs re-running if capacity/stringing changed.
- After any design run, review the warnings it returns. If a single
  parameter change could plausibly resolve a warning (e.g. a high DC/AC
  ratio → adjust target capacity), re-run once with the adjusted parameter
  and explain what you fixed and why. Do not loop more than once.
- compare_scenarios runs several land-use factors back-to-back; use it when
  the user asks to trade off density vs yield/cost rather than for one value.

Output style:
- Concise, technical, practical. Metric units.
- Cite the tool result or assumption behind every number.
- If data is missing, ask one clear clarifying question.
- If a request is infeasible, explain why and propose the nearest feasible
  alternative."""

_STAGE_PARAMS = {
    "type": "object",
    "properties": {
        "stage": {"type": "string",
                  "enum": ["terrain", "layout", "electrical", "yield", "bom"]},
        "land_use_factor": {"type": "number"},
        "target_dc_capacity_mwp": {"type": "number"},
        "tilt_degrees": {"type": "number"},
        "azimuth_degrees": {"type": "number"},
    },
    "required": ["stage"],
}

_DESIGN_PARAMS = {
    "type": "object",
    "properties": {
        "land_use_factor": {"type": "number",
                            "description": "1.0 = default spacing; 0.8 = ~20% denser packing"},
        "target_dc_capacity_mwp": {"type": "number"},
        "tilt_degrees": {"type": "number"},
        "azimuth_degrees": {"type": "number"},
    },
}

TOOLS = [
    {"type": "function", "function": {
        "name": "run_full_design",
        "description": ("Run the complete BEAM workflow: terrain screening, PV table layout, "
                        "electrical sizing, PVGIS yield and BOM. Use for a fresh design or a "
                        "broad change."),
        "parameters": _DESIGN_PARAMS}},
    {"type": "function", "function": {
        "name": "run_stage",
        "description": ("Re-run one pipeline stage using stored upstream results. Prefer this "
                        "for narrow changes, e.g. a new tilt → run_stage(layout) then "
                        "run_stage(yield) then run_stage(bom)."),
        "parameters": _STAGE_PARAMS}},
    {"type": "function", "function": {
        "name": "compare_scenarios",
        "description": ("Run the full design for several land_use_factor values and return a "
                        "comparison table (tables, MWp, yield, BOM lines, warnings). Use for "
                        "density-vs-output trade-off questions."),
        "parameters": {"type": "object", "properties": {
            "land_use_factors": {"type": "array", "items": {"type": "number"},
                                 "description": "e.g. [1.0, 0.8]"}},
            "required": ["land_use_factors"]}}},
    {"type": "function", "function": {
        "name": "get_site_conditions",
        "description": ("Live weather/irradiance at the site centroid (Open-Meteo): GHI, DNI, "
                        "temperature, wind, cloud cover. Use for 'how is it producing right "
                        "now' questions; always cite it as live data."),
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "get_design_summary",
        "description": "Get the most recent stored design results for the site.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "export_project",
        "description": "Export GeoJSON, CSV BOM, Markdown proposal and project JSON.",
        "parameters": {"type": "object", "properties": {}}}},
]


def beam_configured() -> bool:
    return bool(os.getenv("BEAM_API_BASE") and os.getenv("BEAM_API_KEY"))


def scripted_beam_reply(design: DesignResponse | None, site: Site | None,
                        message: str) -> str:
    """Deterministic Beam narration of real tool results — no LLM needed."""
    if design is None:
        return ("Draw a site boundary and any exclusion zones, set your assumptions, "
                "then click **Generate BEAM Design**. I'll run terrain, layout, "
                "electrical, yield and BOM in sequence and cite every number from "
                "the tool results.")
    t, l, e, y, b = (design.terrain, design.layout, design.electrical,
                     design.yield_result, design.bom)
    parts = ["Here's the preliminary design.\n"]
    if t:
        parts.append(
            f"**Site** — {t.total_area_ha} ha total, {t.usable_area_ha} ha usable "
            f"(avg slope {t.average_slope_degrees}°, max {t.max_slope_degrees}°, "
            f"elevations: {t.elevation_source}).")
    if l:
        parts.append(
            f"**Array** — {l.table_count} tables, {l.module_count} modules, "
            f"{l.dc_capacity_kwp/1000:.2f} MWp DC.")
    if e:
        parts.append(
            f"**Electrical** — {e.string_count} strings × {e.modules_per_string} modules, "
            f"{e.inverter_count} × {e.inverter_capacity_kw:.0f} kW inverters "
            f"(DC/AC {e.dc_ac_ratio}). {e.grid_connection_recommendation} "
            "— DNO confirmation required.")
    if y:
        parts.append(
            f"**Energy** ({y.source}) — {y.annual_energy_mwh} MWh/yr, "
            f"{y.specific_yield_kwh_per_kwp} kWh/kWp/yr.")
    if b:
        parts.append(f"**BOM** — {b.line_count} line items across "
                     f"{len(b.packages)} packages, ready to export.")
    if design.warnings:
        parts.append("**Warnings:** " + " | ".join(design.warnings))
    return "\n\n".join(parts)


def _stored_design(site_id: str) -> DesignResponse | None:
    d = store.get_design(site_id)
    return DesignResponse(**d) if d else None


def _apply_args(a: DesignAssumptions, args: dict) -> DesignAssumptions:
    a = a.model_copy(deep=True)
    if args.get("land_use_factor") is not None:
        a.target.land_use_factor = args["land_use_factor"]
    if args.get("target_dc_capacity_mwp"):
        a.target.target_dc_capacity_mwp = args["target_dc_capacity_mwp"]
    if args.get("tilt_degrees") is not None:
        a.array.tilt_degrees = args["tilt_degrees"]
    if args.get("azimuth_degrees") is not None:
        a.array.azimuth_degrees = args["azimuth_degrees"]
    return a


def _site_context(site: Site, design: DesignResponse | None) -> str:
    """Compact site/design context so Beam can *explain* the site, not just
    recite outputs (e.g. 'the pond forced tables out of the SE corner')."""
    lines = [f"Site: {site.name} at ({site.centroid.get('lat')}, "
             f"{site.centroid.get('lon')}), {len(site.exclusions)} user-drawn "
             f"exclusion(s): {[x.label for x in site.exclusions] or 'none'}."]
    if design and design.terrain:
        t = design.terrain
        auto = t.auto_exclusions or []
        kinds = {}
        for f in auto:
            if not f.get("context"):
                kinds[f["kind"]] = kinds.get(f["kind"], 0) + 1
        lines.append(
            f"Terrain: {t.total_area_ha} ha total, {t.usable_area_ha} ha usable, "
            f"avg slope {t.average_slope_degrees}°, max {t.max_slope_degrees}°, "
            f"elevations {t.elevation_source}. "
            f"OSM auto-detected constraints: {kinds or 'none'}.")
    if design and design.beam_summary:
        lines.append(f"Latest design summary: {json.dumps(design.beam_summary)}")
    if design and design.warnings:
        lines.append("Current warnings: " + " | ".join(design.warnings))
    return "\n".join(lines)


# ---------------------------------------------------------------- LLM path
def _llm_chat(site: Site, message: str, assumptions: DesignAssumptions,
              effort: str | None) -> tuple[str, DesignResponse | None, list[dict], str, dict]:
    import httpx

    base = os.environ["BEAM_API_BASE"].rstrip("/")
    key = os.environ["BEAM_API_KEY"]
    model = os.getenv("BEAM_MODEL", "beam-1")
    effort = effort or os.getenv("BEAM_REASONING_EFFORT", "medium")

    design: DesignResponse | None = _stored_design(site.site_id)
    steps: list[dict] = []
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT + "\n\n" + _site_context(site, design)},
        {"role": "user", "content":
            f"Site id {site.site_id}. "
            f"Current assumptions: {assumptions.model_dump_json()}\n\n"
            f"User request: {message}"},
    ]

    def call_tool(name: str, args: dict) -> str:
        nonlocal steps
        if name == "run_full_design":
            design_, steps_ = run_full_design(site, _apply_args(assumptions, args))
            steps += steps_
            nonlocal_design[0] = design_
            return design_.model_dump_json(by_alias=True)
        if name == "run_stage":
            a = _apply_args(assumptions, args)
            d, summary = run_stage(site, a, args["stage"])
            steps.append({"step": args["stage"], "status": "done", "summary": summary})
            nonlocal_design[0] = DesignResponse(**d)
            return json.dumps({"stage": args["stage"], "result": summary,
                               "beam_summary": d.get("beam_summary")})
        if name == "compare_scenarios":
            rows = []
            for f in (args.get("land_use_factors") or [1.0]):
                a = _apply_args(assumptions, {"land_use_factor": f})
                d_, s_ = run_full_design(site, a)
                steps += s_
                nonlocal_design[0] = d_
                rows.append({"land_use_factor": f, **(d_.beam_summary or {}),
                             "warnings": d_.warnings})
            return json.dumps({"scenarios": rows})
        if name == "get_site_conditions":
            from . import conditions as cond_svc
            try:
                return json.dumps(cond_svc.site_conditions(
                    site.centroid["lat"], site.centroid["lon"]))
            except Exception as e:
                return json.dumps({"error": str(e)})
        if name == "get_design_summary":
            cur = _stored_design(site.site_id)
            return (cur.model_dump_json(by_alias=True) if cur
                    else '{"error": "no design has been generated yet"}')
        if name == "export_project":
            from . import export_service
            d = store.get_design(site.site_id)
            if not d:
                return '{"error": "nothing to export — run a design first"}'
            return json.dumps(export_service.export_all(site.site_id, d))
        return '{"error": "unknown tool"}'

    nonlocal_design = [design]
    reasoning_parts: list[str] = []
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "reasoning_tokens": 0}
    t0 = time.time()

    for _ in range(8):  # tool loop
        r = httpx.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": model, "messages": messages, "tools": TOOLS,
                  "reasoning_effort": effort},
            timeout=300,
        )
        r.raise_for_status()
        body = r.json()
        msg = body["choices"][0]["message"]
        u = body.get("usage") or {}
        usage["prompt_tokens"] += u.get("prompt_tokens", 0)
        usage["completion_tokens"] += u.get("completion_tokens", 0)
        usage["reasoning_tokens"] += (u.get("completion_tokens_details") or {}
                                    ).get("reasoning_tokens", 0)
        if msg.get("reasoning_content"):
            reasoning_parts.append(msg["reasoning_content"])
        # Reflection API: assistant tool-call turns must carry reasoning_content
        if msg.get("tool_calls") and not msg.get("reasoning_content"):
            msg["reasoning_content"] = "Calling tools to answer the request."
        messages.append(msg)
        if not msg.get("tool_calls"):
            meta = {"model": model, "effort": effort, "mode": "live",
                    "latency_s": round(time.time() - t0, 1), **usage}
            return (msg.get("content") or "", nonlocal_design[0], steps,
                    "\n\n---\n\n".join(reasoning_parts), meta)
        for tc in msg["tool_calls"]:
            fn, args = tc["function"]["name"], json.loads(tc["function"].get("arguments") or "{}")
            try:
                out = call_tool(fn, args)
            except Exception as e:
                out = json.dumps({"error": str(e)})
            messages.append({"role": "tool", "tool_call_id": tc["id"], "content": out})

    meta = {"model": model, "effort": effort, "mode": "live",
            "latency_s": round(time.time() - t0, 1), **usage}
    return ("Design complete — see the results panel.", nonlocal_design[0], steps,
            "\n\n---\n\n".join(reasoning_parts), meta)


# ---------------------------------------------------------------- fallback path
def _scripted_chat(site: Site | None, message: str,
                   assumptions: DesignAssumptions | None) -> ChatResponse:
    lower = message.lower()
    wants_design = any(k in lower for k in
                       ("design", "generate", "build", "reduce", "increase",
                        "density", "capacity", "run", "solar farm", "pv"))
    design = _stored_design(site.site_id) if site else None
    steps: list[dict] = []

    if site and wants_design:
        a = assumptions or DesignAssumptions()
        if "reduce" in lower and ("land" in lower or "20" in lower) or "denser" in lower:
            a.target.land_use_factor = 0.8
        design, steps = run_full_design(site, a)
        return ChatResponse(reply=scripted_beam_reply(design, site, message),
                            design=design, steps=steps,
                            meta={"mode": "offline-scripted"})

    return ChatResponse(reply=scripted_beam_reply(design, site, message),
                        design=design, steps=steps,
                        meta={"mode": "offline-scripted"})


def handle_chat(site_id: str | None, message: str,
                assumptions: DesignAssumptions | None,
                effort: str | None = None) -> ChatResponse:
    site = store.get_site(site_id) if site_id else None
    if site and beam_configured():
        try:
            reply, design, steps, reasoning, meta = _llm_chat(
                site, message, assumptions or DesignAssumptions(), effort)
            return ChatResponse(reply=reply, design=design, steps=steps,
                                reasoning=reasoning or None, meta=meta)
        except Exception as e:
            # fall through to scripted beam rather than failing the demo
            r = _scripted_chat(site, message, assumptions)
            r.reply = f"_(Beam endpoint error: {e} — continuing in offline mode)_\n\n" + r.reply
            return r
    return _scripted_chat(site, message, assumptions)
