"""Terrain screening: grid sampling, slope/aspect, suitability mask."""
from __future__ import annotations

import math

from shapely.geometry import MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union

from ..models import Site, TerrainCell, TerrainResult
from . import elevation, osm_features
from .geo import LocalCRS, geojson_to_shapely, shapely_to_geojson, validate_polygon


def analyse_terrain(site: Site, grid_resolution_m: float = 30.0) -> TerrainResult:
    warnings: list[str] = []
    boundary_ll = validate_polygon(site.boundary.model_dump())
    centroid = boundary_ll.centroid
    crs = LocalCRS(centroid.y, centroid.x)

    boundary_m = crs.geom_to_local(boundary_ll)
    total_area_ha = boundary_m.area / 10_000

    exclusions_m = []
    for ex in site.exclusions:
        try:
            exclusions_m.append(crs.geom_to_local(validate_polygon(ex.geometry.model_dump())))
        except ValueError:
            warnings.append(f"Ignored invalid exclusion polygon '{ex.label}'")
    exclusion_union = unary_union(exclusions_m) if exclusions_m else None

    # ---- OSM auto-detected features (buildings, water, woodland, roads) ----
    # Query a padded bbox: features inside the boundary become exclusions;
    # nearby features are kept as render context for the 3D scene.
    auto_exclusions: list[dict] = []
    osm_geoms_m: list = []
    try:
        minx0, miny0, maxx0, maxy0 = boundary_ll.bounds  # (lon, lat)
        pad_lat, pad_lon = 250 / 111320, 250 / (111320 * math.cos(math.radians(centroid.y)))
        feats = osm_features.fetch_osm_features(
            miny0 - pad_lat, minx0 - pad_lon, maxy0 + pad_lat, maxx0 + pad_lon)
        for f in feats:
            try:
                g = osm_features.feature_to_shapely(f, crs)
                inside = g.intersects(boundary_m)
                f["context"] = not inside
                if inside:
                    osm_geoms_m.append(g.intersection(boundary_m))
                auto_exclusions.append(f)
            except Exception:
                pass
        if auto_exclusions:
            by_kind: dict[str, int] = {}
            for f in auto_exclusions:
                if not f.get("context"):
                    by_kind[f["label"]] = by_kind.get(f["label"], 0) + 1
            if by_kind:
                warnings.append(
                    "OSM auto-detected constraints: " +
                    ", ".join(f"{n}× {k}" for k, n in by_kind.items()))
    except Exception as e:
        warnings.append(f"OSM feature detection unavailable: {e}")

    all_excl = exclusions_m + osm_geoms_m
    exclusion_union = unary_union(all_excl) if all_excl else None
    excluded_area_ha = (boundary_m.intersection(exclusion_union).area / 10_000) if exclusion_union else 0.0

    # ---- build sampling grid in local CRS ----
    minx, miny, maxx, maxy = boundary_m.bounds
    xs = _frange(minx, maxx, grid_resolution_m)
    ys = _frange(miny, maxy, grid_resolution_m)
    grid_pts_local = [(x, y) for x in xs for y in ys]
    if len(grid_pts_local) < 9:
        # too coarse / small site — densify
        res = max(min(maxx - minx, maxy - miny) / 8.0, 5.0)
        xs = _frange(minx, maxx, res)
        ys = _frange(miny, maxy, res)
        grid_pts_local = [(x, y) for x in xs for y in ys]
        grid_resolution_m = res

    pts_wgs = [crs.to_wgs84(x, y) for x, y in grid_pts_local]  # (lon, lat)

    # ---- elevations ----
    elev_source = "open-meteo"
    try:
        elevations, elev_source = elevation.get_elevations(
            [(lat, lon) for lon, lat in pts_wgs]
        )
    except RuntimeError as e:
        warnings.append(
            "Elevation data unavailable — proceeding without terrain screening. "
            f"({e})"
        )
        elevations = None

    # ---- slope / aspect per grid node (finite differences) ----
    cells: list[TerrainCell] = []
    suitable_cells_local: list[Polygon] = []
    slopes: list[float] = []

    nx, ny = len(xs), len(ys)
    elev_grid = {}
    if elevations:
        for i, (x, y) in enumerate(grid_pts_local):
            elev_grid[(x, y)] = elevations[i]

    inside_excl = 0
    inside_setback = 0
    steep = 0
    max_slope_cfg = 8.0

    for ix, x in enumerate(xs):
        for iy, y in enumerate(ys):
            lon, lat = crs.to_wgs84(x, y)
            cell_poly = box(
                x - grid_resolution_m / 2, y - grid_resolution_m / 2,
                x + grid_resolution_m / 2, y + grid_resolution_m / 2,
            )
            in_boundary = boundary_m.contains(Point(x, y))
            if not in_boundary:
                continue

            slope = aspect = 0.0
            if elevations:
                slope, aspect = _slope_aspect(
                    elev_grid, xs, ys, ix, iy, grid_resolution_m
                )
                slopes.append(slope)

            # suitability checks
            reason = None
            if exclusion_union and cell_poly.intersects(exclusion_union):
                reason, inside_excl = "excluded", inside_excl + 1
            elif not boundary_m.buffer(-5).contains(Point(x, y)):
                reason, inside_setback = "setback", inside_setback + 1
            elif elevations and slope > max_slope_cfg:
                reason, steep = "too_steep", steep + 1

            suitability = "suitable" if reason is None else reason
            if reason is None:
                suitable_cells_local.append(cell_poly)

            cells.append(
                TerrainCell(
                    lat=lat, lon=lon,
                    elevation_m=elev_grid.get((x, y), 0.0),
                    slope_degrees=round(slope, 2),
                    aspect_degrees=round(aspect, 1),
                    suitability=suitability,
                )
            )

    suitable_union = unary_union(suitable_cells_local) if suitable_cells_local else Polygon()
    usable_area_ha = max(boundary_m.intersection(suitable_union).area, 0.0) / 10_000 if suitable_cells_local else (boundary_m.area / 10_000 - excluded_area_ha)

    if elevations is None:
        # no screening — usable = boundary minus exclusions minus setback
        usable = boundary_m.buffer(-5)
        if exclusion_union:
            usable = usable.difference(exclusion_union)
        suitable_union = usable
        usable_area_ha = max(usable.area, 0.0) / 10_000
        warnings.append("Terrain screening skipped; usable area is a geometric estimate only.")
    elif not suitable_cells_local:
        warnings.append(
            f"No suitable land remains (excluded cells: {inside_excl}, "
            f"setback: {inside_setback}, slope>{max_slope_cfg}°: {steep})."
        )

    avg_slope = sum(slopes) / len(slopes) if slopes else 0.0
    suitable_gj = (
        shapely_to_geojson(crs.geom_to_wgs84(_largest(suitable_union)))
        if not suitable_union.is_empty
        else None
    )

    return TerrainResult(
        total_area_ha=round(total_area_ha, 3),
        usable_area_ha=round(usable_area_ha, 3),
        excluded_area_ha=round(excluded_area_ha, 3),
        average_slope_degrees=round(avg_slope, 2),
        max_slope_degrees=round(max(slopes), 2) if slopes else 0.0,
        elevation_source=elev_source,
        suitability_grid=cells,
        suitable_polygon=suitable_gj,
        auto_exclusions=auto_exclusions,
        warnings=warnings,
    )


def _frange(start: float, stop: float, step: float) -> list[float]:
    vals = []
    v = start + step / 2
    while v < stop:
        vals.append(v)
        v += step
    return vals or [start + (stop - start) / 2]


def _slope_aspect(elev_grid, xs, ys, ix, iy, res) -> tuple[float, float]:
    def z(i, j):
        i = min(max(i, 0), len(xs) - 1)
        j = min(max(j, 0), len(ys) - 1)
        return elev_grid.get((xs[i], ys[j]), 0.0)

    dzdx = (z(ix + 1, iy) - z(ix - 1, iy)) / (2 * res)
    dzdy = (z(ix, iy + 1) - z(ix, iy - 1)) / (2 * res)
    slope = math.degrees(math.atan(math.hypot(dzdx, dzdy)))
    aspect = (math.degrees(math.atan2(dzdx, -dzdy)) + 360) % 360  # 0 = north-facing
    return slope, aspect


def _largest(geom):
    if geom.geom_type == "MultiPolygon":
        return geom  # keep all suitable cells merged
    return geom
