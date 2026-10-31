"""Deterministic fixed-tilt PV table layout engine."""
from __future__ import annotations

import math

from shapely.affinity import rotate
from shapely.geometry import MultiPolygon, Polygon, box
from shapely.ops import unary_union

from ..models import DesignAssumptions, LayoutResult, PVTable, Site, TerrainResult
from .geo import LocalCRS, shapely_to_geojson, validate_polygon


def generate_layout(
    site: Site,
    assumptions: DesignAssumptions,
    terrain: TerrainResult | None = None,
) -> LayoutResult:
    warnings: list[str] = []
    boundary_ll = validate_polygon(site.boundary.model_dump())
    centroid_ll = boundary_ll.centroid
    crs = LocalCRS(centroid_ll.y, centroid_ll.x)
    boundary_m = crs.geom_to_local(boundary_ll)

    arr = assumptions.array
    mod = assumptions.module

    # ---- buildable area ----
    buildable = boundary_m.buffer(-arr.boundary_setback_m)
    for ex in site.exclusions:
        try:
            ex_m = crs.geom_to_local(validate_polygon(ex.geometry.model_dump()))
            buildable = buildable.difference(ex_m.buffer(arr.exclusion_setback_m))
        except ValueError:
            pass

    # OSM auto-detected constraints — reuse terrain's fetch (same padded bbox,
    # single Overpass call). Only fetch here if terrain didn't run.
    try:
        auto = None
        if terrain is not None:
            auto = (terrain.get("auto_exclusions") if isinstance(terrain, dict)
                    else getattr(terrain, "auto_exclusions", None))
        if auto is None:
            from . import osm_features
            import math as _m
            bx0, by0, bx1, by1 = boundary_ll.bounds
            pad_lat = 250 / 111320
            pad_lon = 250 / (111320 * _m.cos(_m.radians(boundary_ll.centroid.y)))
            auto = osm_features.fetch_osm_features(
                by0 - pad_lat, bx0 - pad_lon, by1 + pad_lat, bx1 + pad_lon)
        for f in auto:
            if f.get("context"):
                continue  # context features are outside the fence
            try:
                from . import osm_features
                buildable = buildable.difference(
                    osm_features.feature_to_shapely(f, crs))
            except Exception:
                pass
    except Exception:
        pass  # OSM unavailable — user exclusions still apply

    # terrain suitability clip (accept model or stored dict)
    suit_poly = (terrain.get("suitable_polygon") if isinstance(terrain, dict)
                 else getattr(terrain, "suitable_polygon", None)) if terrain else None
    if suit_poly:
        try:
            from shapely.geometry import shape as _shape
            suit_m = crs.geom_to_local(_shape(suit_poly))
            clipped = buildable.intersection(suit_m)
            if not clipped.is_empty:
                buildable = clipped
            else:
                warnings.append("Terrain suitability mask removed all buildable area.")
        except ValueError:
            warnings.append("Suitable-area polygon invalid; ignoring terrain mask.")

    if buildable.is_empty or buildable.area < 50:
        return LayoutResult(
            module_count=0, table_count=0, dc_capacity_kwp=0,
            modules_per_table=arr.modules_per_table_row * arr.module_rows_per_table,
            tables=[], target_met=False,
            warnings=["No buildable area after setbacks and exclusions."] + warnings,
        )

    polys = (
        list(buildable.geoms)
        if buildable.geom_type in ("MultiPolygon", "GeometryCollection")
        else [buildable]
    )

    # ---- table footprint in a rotated frame aligned to azimuth ----
    # Table: modules_per_table_row modules along the row (x), module_rows stacked (y).
    # Footprint width = n_row * module_width (modules mounted portrait, side by side)
    # Footprint depth = n_rows * module_length
    table_w = arr.modules_per_table_row * mod.width_m
    table_d = arr.module_rows_per_table * mod.length_m
    modules_per_table = arr.modules_per_table_row * arr.module_rows_per_table
    table_kwp = modules_per_table * mod.wattage / 1000.0
    land_factor = max(0.2, min(assumptions.target.land_use_factor, 1.0))
    # projected fixed-tilt footprint: row pitch must clear the projected
    # shadow of the tilted table at the design tilt angle.
    tilt = max(getattr(arr, "tilt_degrees", 20.0) or 20.0, 1.0)
    projected_pitch = table_d / math.tan(math.radians(tilt)) + 0.5
    row_pitch = max(arr.row_pitch_m * land_factor, projected_pitch)

    # rotate buildable so that "azimuth" direction becomes +y in rotated frame
    # azimuth 180 (south): rotate by 180 - azimuth = 0 => rows run east-west
    rot_angle = 180.0 - arr.azimuth_degrees
    tables: list[PVTable] = []
    tid = 0
    spacing_x = 2.0 * land_factor  # lateral gap between tables in a row

    for poly in polys:
        if poly.is_empty or poly.area < table_w * table_d:
            continue
        rot_poly = rotate(poly, -rot_angle, origin="centroid", use_radians=False)
        minx, miny, maxx, maxy = rot_poly.bounds
        row_y = miny + table_d / 2
        row_idx = 0
        while row_y + table_d / 2 <= maxy:
            in_aisle = (
                arr.access_aisle_every_n_rows > 0
                and row_idx > 0
                and row_idx % arr.access_aisle_every_n_rows == 0
            )
            if in_aisle:
                row_y += arr.access_aisle_width_m
                row_idx += 1
                continue
            x = minx + table_w / 2
            while x + table_w / 2 <= maxx:
                cand = box(x - table_w / 2, row_y - table_d / 2,
                           x + table_w / 2, row_y + table_d / 2)
                if rot_poly.covers(cand):
                    cand_back = rotate(cand, rot_angle, origin=rot_poly.centroid)
                    tid += 1
                    gj = shapely_to_geojson(crs.geom_to_wgs84(cand_back))
                    c = crs.geom_to_wgs84(cand_back).centroid
                    tables.append(
                        PVTable(
                            table_id=f"PV-T-{tid:03d}",
                            module_count=modules_per_table,
                            dc_capacity_kwp=round(table_kwp, 3),
                            geometry=gj,
                            centroid={"lat": c.y, "lon": c.x},
                        )
                    )
                x += table_w + spacing_x
            row_y += row_pitch
            row_idx += 1

    module_count = len(tables) * modules_per_table
    dc_kwp = module_count * mod.wattage / 1000.0

    # ---- target capacity ----
    target_met = True
    tgt = assumptions.target
    if tgt.mode == "target_capacity" and tgt.target_dc_capacity_mwp:
        target_kwp = tgt.target_dc_capacity_mwp * 1000
        if dc_kwp > target_kwp * 1.05:
            # trim to ~target by dropping tables (evenly, from the end)
            keep = max(1, int(len(tables) * target_kwp / dc_kwp))
            tables = tables[:keep]
            module_count = len(tables) * modules_per_table
            dc_kwp = module_count * mod.wattage / 1000.0
            warnings.append(
                f"Layout trimmed to meet target capacity ({dc_kwp/1000:.2f} MWp)."
            )
        elif dc_kwp < target_kwp * 0.9:
            target_met = False
            warnings.append(
                f"Target {tgt.target_dc_capacity_mwp} MWp cannot be met; "
                f"maximum feasible layout is {dc_kwp/1000:.2f} MWp."
            )

    return LayoutResult(
        module_count=module_count,
        table_count=len(tables),
        dc_capacity_kwp=round(dc_kwp, 2),
        modules_per_table=modules_per_table,
        tables=tables,
        target_met=target_met,
        warnings=warnings,
    )
