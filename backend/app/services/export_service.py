"""Export: GeoJSON, CSV BOM, Markdown proposal, JSON project."""
from __future__ import annotations

import csv
import io
import json
from pathlib import Path

EXPORT_DIR = Path(__file__).parent.parent.parent / "exports"
EXPORT_DIR.mkdir(parents=True, exist_ok=True)


def export_all(site_id: str, design: dict) -> dict:
    files = {
        "geojson_url": (".geojson", _geojson(design)),
        "bom_csv_url": ("_bom.csv", _bom_csv(design)),
        "proposal_md_url": ("_proposal.md", _proposal(design)),
        "project_json_url": (".json", json.dumps(design, indent=2, default=str)),
    }
    out = {}
    for key, (suffix, content) in files.items():
        p = EXPORT_DIR / f"{site_id}{suffix}"
        p.write_text(content, encoding="utf-8")
        out[key] = f"/exports/{site_id}{suffix}"
    return out


def _feature(geom: dict, props: dict) -> dict:
    return {"type": "Feature", "properties": props, "geometry": geom}


def _geojson(d: dict) -> str:
    feats = []
    site = d["site"]
    feats.append(_feature(site["boundary"], {"feature_type": "boundary", "name": site["name"]}))
    for ex in site.get("exclusions", []):
        feats.append(_feature(ex["geometry"], {
            "feature_type": "exclusion", "id": ex["id"], "label": ex["label"]}))
    if d.get("terrain") and d["terrain"].get("suitable_polygon"):
        feats.append(_feature(d["terrain"]["suitable_polygon"],
                              {"feature_type": "suitable_area"}))
    for t in (d.get("layout") or {}).get("tables", []):
        feats.append(_feature(t["geometry"], {
            "feature_type": "pv_table", "id": t["table_id"],
            "module_count": t["module_count"], "dc_capacity_kwp": t["dc_capacity_kwp"],
            "string_ids": t.get("string_ids", [])}))
    elec = d.get("electrical") or {}
    for ip in elec.get("inverter_points", []):
        feats.append(_feature(
            {"type": "Point", "coordinates": [ip["lon"], ip["lat"]]},
            {"feature_type": "inverter", "id": ip["id"], "capacity_kw": ip["capacity_kw"]}))
    if elec.get("transformer_point"):
        tp = elec["transformer_point"]
        feats.append(_feature(
            {"type": "Point", "coordinates": [tp["lon"], tp["lat"]]},
            {"feature_type": "transformer", "id": tp["id"],
             "kva": elec.get("transformer_kva"),
             "dno_confirmation_required": True}))
    for r in elec.get("cable_routes", []):
        feats.append(_feature(
            {"type": "LineString", "coordinates": r["coordinates"]},
            {"feature_type": "cable_route", "cable_type": r["type"],
             "from": r["from"], "to": r["to"]}))
    return json.dumps({"type": "FeatureCollection", "features": feats}, indent=2)


def _bom_csv(d: dict) -> str:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["package", "item", "quantity", "unit", "basis", "confidence",
                "supplier_confirmation_required", "dno_confirmation_required"])
    for p in (d.get("bom") or {}).get("packages", []):
        for i in p["items"]:
            w.writerow([p["package"], i["item"], i["quantity"], i["unit"],
                        i["basis"], i["confidence"],
                        i["supplier_confirmation_required"],
                        i["dno_confirmation_required"]])
    return out.getvalue()


def _proposal(d: dict) -> str:
    site, t, l, e, y, b = (d.get("site") or {}, d.get("terrain") or {},
                         d.get("layout") or {}, d.get("electrical") or {},
                         d.get("yield_result") or d.get("yield") or {},
                         d.get("bom") or {})
    lines = [
        f"# BEAM for BOM — Preliminary Solar Farm Proposal",
        f"",
        f"## Executive summary",
        f"Site: **{site.get('name','—')}** — {t.get('total_area_ha','?')} ha total, "
        f"{t.get('usable_area_ha','?')} ha usable. Proposed fixed-tilt array: "
        f"**{(l.get('dc_capacity_kwp',0))/1000:.2f} MWp** "
        f"({l.get('module_count','?')} modules, {l.get('table_count','?')} tables).",
        f"",
        f"## Terrain assessment",
        f"- Average slope: {t.get('average_slope_degrees','?')}° "
        f"(max {t.get('max_slope_degrees','?')}°)",
        f"- Excluded area: {t.get('excluded_area_ha','?')} ha",
        f"- Elevation source: {t.get('elevation_source','?')}",
        f"",
        f"## PV array design",
        f"- {l.get('table_count','?')} tables × {l.get('modules_per_table','?')} modules",
        f"- DC capacity: {l.get('dc_capacity_kwp','?')} kWp",
        f"",
        f"## Electrical design",
        f"- {e.get('string_count','?')} strings of {e.get('modules_per_string','?')} modules",
        f"- {e.get('inverter_count','?')} × {e.get('inverter_capacity_kw','?')} kW inverters "
        f"(DC/AC {e.get('dc_ac_ratio','?')})",
        f"- Grid: {e.get('grid_connection_recommendation','—')}",
        f"",
        f"## Energy estimate ({y.get('source','PVGIS')})",
        f"- Annual generation: {y.get('annual_energy_mwh','?')} MWh",
        f"- Specific yield: {y.get('specific_yield_kwh_per_kwp','?')} kWh/kWp/yr",
        f"",
        f"## Bill of materials",
    ]
    for p in b.get("packages", []):
        lines.append(f"### {p['package']}")
        for i in p["items"]:
            flag = " ⚠ confirm" if (i["supplier_confirmation_required"] or i["dno_confirmation_required"]) else ""
            lines.append(f"- {i['item']}: {i['quantity']} {i['unit']} — _{i['basis']}_{flag}")
    lines += [
        "",
        "## Assumptions and risks",
        "- Preliminary feasibility only — not a bankable or construction-ready design.",
        "- Transformer and grid connection require DNO confirmation.",
        "- Shading, planning constraints, and ground conditions not assessed.",
        "- Yield from PVGIS with stated loss assumptions.",
    ]
    for w in d.get("warnings", []):
        lines.append(f"- ⚠ {w}")
    return "\n".join(lines) + "\n"
