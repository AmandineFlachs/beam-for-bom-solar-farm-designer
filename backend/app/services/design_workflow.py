"""Full BEAM workflow orchestrator: terrain -> layout -> electrical -> yield -> BOM."""
from __future__ import annotations

from ..models import DesignAssumptions, DesignResponse, Site
from .. import store
from . import bom as bom_svc
from . import electrical as elec_svc
from . import layout as layout_svc
from . import terrain as terrain_svc
from . import yield_service


def _step(name: str, status: str, summary: str = "") -> dict:
    return {"step": name, "status": status, "summary": summary}


def run_full_design(site: Site, assumptions: DesignAssumptions,
                    progress=None) -> tuple[DesignResponse, list[dict]]:
    steps: list[dict] = []
    warnings: list[str] = []

    def emit(s: dict) -> None:
        steps.append(s)
        if progress:
            progress(s)

    emit(_step("boundary", "done",
               f"Boundary and {len(site.exclusions)} exclusion(s) received"))

    # 1. terrain
    try:
        terrain = terrain_svc.analyse_terrain(site)
        warnings += terrain.warnings
        emit(_step("terrain", "done",
                           f"{terrain.usable_area_ha} ha usable of "
                           f"{terrain.total_area_ha} ha ({terrain.elevation_source})"))
    except Exception as e:
        terrain = None
        warnings.append(f"Terrain analysis failed: {e}")
        emit(_step("terrain", "failed", str(e)))

    # 2. layout
    layout = layout_svc.generate_layout(site, assumptions, terrain)
    warnings += layout.warnings
    if layout.table_count == 0:
        emit(_step("layout", "failed",
                           "No buildable area after constraints"))
        resp = DesignResponse(site=site, terrain=terrain, layout=layout,
                              warnings=warnings,
                              assumptions=_assumption_notes(assumptions))
        store.save_design(site.site_id, resp.model_dump(by_alias=True))
        return resp, steps
    emit(_step("layout", "done",
                       f"{layout.table_count} tables, "
                       f"{layout.dc_capacity_kwp/1000:.2f} MWp"))

    # 3. electrical
    electrical = _apply_electrical(site, layout, assumptions)
    warnings += electrical.warnings
    emit(_step("electrical", "done",
                       f"{electrical.inverter_count} inverters, "
                       f"{electrical.grid_connection_recommendation}"))

    # 4. yield (may fail — PVGIS outage must not kill the design)
    yld = None
    try:
        yld = yield_service.estimate_yield(site, layout, assumptions)
        emit(_step("yield", "done",
                           f"{yld.annual_energy_mwh} MWh/yr ({yld.source})"))
    except Exception as e:
        warnings.append(str(e))
        emit(_step("yield", "failed", str(e)))

    # 5. BOM
    bom = bom_svc.generate_bom(site, layout, electrical, yld, assumptions)
    emit(_step("bom", "done", f"{bom.line_count} line items"))
    emit(_step("export", "done", "Project package ready"))

    resp = DesignResponse(
        site=site, terrain=terrain, layout=layout, electrical=electrical,
        yield_result=yld, bom=bom,
        warnings=warnings,
        assumptions=_assumption_notes(assumptions),
        beam_summary={
            "dc_capacity_mwp": round(layout.dc_capacity_kwp / 1000, 3),
            "table_count": layout.table_count,
            "module_count": layout.module_count,
            "inverter_count": electrical.inverter_count,
            "transformer_kva": electrical.transformer_kva,
            "annual_energy_mwh": yld.annual_energy_mwh if yld else None,
        },
    )
    store.save_design(site.site_id, resp.model_dump(by_alias=True))
    return resp, steps


def _apply_electrical(site: Site, layout, assumptions: DesignAssumptions):
    electrical = elec_svc.design_electrical(site, layout, assumptions)
    # assign string IDs to tables (strings span tables sequentially)
    mps = electrical.modules_per_string
    for idx, tb in enumerate(layout.tables):
        lo, hi = idx * tb.module_count, idx * tb.module_count + tb.module_count - 1
        tb.string_ids = [f"STR-{s+1:03d}" for s in range(lo // mps, hi // mps + 1)]
    return electrical


def run_stage(site: Site, assumptions: DesignAssumptions,
              stage: str) -> tuple[dict, str]:
    """Run one pipeline stage against the stored design, persist, return
    (updated design dict, human summary). Stages consume results already in
    the store, so Beam can re-run only what a parameter change affects."""
    from ..models import (ElectricalResult, LayoutResult,
                          TerrainResult, YieldResult)
    d = store.get_design(site.site_id) or {
        "site": site.model_dump(), "warnings": [], "assumptions": []}

    if stage == "terrain":
        terrain = terrain_svc.analyse_terrain(site)
        d["terrain"] = terrain.model_dump()
        for k in ("layout", "electrical", "yield", "bom"):
            d.pop(k, None)
        summary = (f"{terrain.usable_area_ha} ha usable of "
                   f"{terrain.total_area_ha} ha, max slope "
                   f"{terrain.max_slope_degrees}° ({terrain.elevation_source})")
    elif stage == "layout":
        terrain = TerrainResult(**d["terrain"]) if d.get("terrain") else None
        layout = layout_svc.generate_layout(site, assumptions, terrain)
        d["layout"] = layout.model_dump()
        for k in ("electrical", "yield", "bom"):
            d.pop(k, None)
        summary = (f"{layout.table_count} tables, "
                   f"{layout.dc_capacity_kwp/1000:.2f} MWp")
    elif stage == "electrical":
        if not d.get("layout"):
            raise ValueError("run layout first")
        layout = LayoutResult(**d["layout"])
        electrical = _apply_electrical(site, layout, assumptions)
        d["layout"] = layout.model_dump()
        d["electrical"] = electrical.model_dump()
        d.pop("bom", None)
        summary = (f"{electrical.inverter_count} × "
                   f"{electrical.inverter_capacity_kw:.0f} kW inverters, "
                   f"DC/AC {electrical.dc_ac_ratio}, "
                   f"{electrical.grid_connection_recommendation}")
    elif stage == "yield":
        if not d.get("layout"):
            raise ValueError("run layout first")
        layout = LayoutResult(**d["layout"])
        yld = yield_service.estimate_yield(site, layout, assumptions)
        d["yield"] = yld.model_dump()
        d.pop("bom", None)
        summary = (f"{yld.annual_energy_mwh} MWh/yr, "
                   f"{yld.specific_yield_kwh_per_kwp} kWh/kWp ({yld.source})")
    elif stage == "bom":
        if not d.get("layout") or not d.get("electrical"):
            raise ValueError("run layout and electrical first")
        layout = LayoutResult(**d["layout"])
        electrical = ElectricalResult(**d["electrical"])
        yld = YieldResult(**d["yield"]) if d.get("yield") else None
        bom = bom_svc.generate_bom(site, layout, electrical, yld, assumptions)
        d["bom"] = bom.model_dump()
        summary = f"{bom.line_count} BOM line items"
    else:
        raise ValueError(f"unknown stage {stage}")

    # refresh beam_summary when we have a complete-enough design
    if d.get("layout") and d.get("electrical"):
        lay, ele = d["layout"], d["electrical"]
        d["beam_summary"] = {
            "dc_capacity_mwp": round(lay["dc_capacity_kwp"] / 1000, 3),
            "table_count": lay["table_count"],
            "module_count": lay["module_count"],
            "inverter_count": ele["inverter_count"],
            "transformer_kva": ele.get("transformer_kva"),
            "annual_energy_mwh": (d.get("yield") or {}).get("annual_energy_mwh"),
        }
    store.save_design(site.site_id, d)
    return d, summary


def _assumption_notes(a: DesignAssumptions) -> list[str]:
    return [
        f"Fixed-tilt, {a.array.tilt_degrees}° tilt, azimuth {a.array.azimuth_degrees}°",
        f"Module: {a.module.wattage:.0f} W ({a.module.model})",
        f"Row pitch {a.array.row_pitch_m} m, boundary setback {a.array.boundary_setback_m} m",
        f"Grid connection: {a.grid.connection_voltage}",
        f"System losses: {a.system_loss_percent}%",
        "Preliminary feasibility only — not bankable; grid, transformer and "
        "shading assumptions require DNO/supplier/planning confirmation.",
    ]
