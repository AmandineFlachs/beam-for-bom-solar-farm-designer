"""Electrical design: strings, inverters, cables, transformer rules."""
from __future__ import annotations

import math

from shapely.geometry import Point, shape
from shapely.ops import unary_union

from ..models import DesignAssumptions, ElectricalResult, LayoutResult, Site
from .geo import LocalCRS, validate_polygon

STANDARD_TX_KVA = [500, 800, 1000, 1250, 1600, 2000, 2500, 3150]
INVERTER = {
    "model": "Generic 250 kW string inverter",
    "capacity_kw": 250,
    "max_dc_voltage": 1100,
}
AVG_DC_STRING_LENGTH_M = 50
RHO_CU_90C = 0.0225          # Ω·mm²/m, copper at XLPE operating temperature
MAX_VD_PERCENT = 2.0
# 4-core XLPE/SWA copper, direct-buried current rating (A) — BS 7671 ballpark
AC_CABLE_SIZES = [(95, 245), (120, 280), (150, 315), (185, 355), (240, 415), (300, 470)]
INVERTER_CLEARANCE_M = 1.8    # free radius around an inverter skid
TRANSFORMER_CLEARANCE_M = 3.5  # free radius around the kiosk + pad


def design_electrical(
    site: Site, layout: LayoutResult, assumptions: DesignAssumptions
) -> ElectricalResult:
    warnings: list[str] = []
    mod = assumptions.module
    dc_kwp = layout.dc_capacity_kwp

    # ---- strings ----
    modules_per_string = int((INVERTER["max_dc_voltage"] * 0.9) // mod.voc)
    modules_per_string = min(modules_per_string, 18)  # conservative cap per spec
    modules_per_string = max(modules_per_string, 1)
    string_count = math.ceil(layout.module_count / modules_per_string) if layout.module_count else 0
    string_power_kw = modules_per_string * mod.wattage / 1000.0
    strings_per_inverter = int(INVERTER["capacity_kw"] // string_power_kw) if string_power_kw else 0
    # target DC/AC ~1.2 (typical for fixed-tilt), min 1 inverter
    TARGET_DCAC = 1.2
    inverter_count = max(1, round(dc_kwp / (INVERTER["capacity_kw"] * TARGET_DCAC))) if dc_kwp else 0
    # never exceed what the strings can actually feed
    if strings_per_inverter and inverter_count:
        inverter_count = min(inverter_count, math.ceil(string_count / max(strings_per_inverter, 1)))
        inverter_count = max(inverter_count, 1)
    total_inv_kw = inverter_count * INVERTER["capacity_kw"]
    dc_ac = dc_kwp / total_inv_kw if total_inv_kw else 0.0

    # Equipment is sited in local metres against the real table footprints so
    # inverters / the kiosk never sit on top of a PV table (2D and 3D share it).
    boundary_ll = validate_polygon(site.boundary.model_dump())
    crs = LocalCRS(boundary_ll.centroid.y, boundary_ll.centroid.x)
    boundary_m = crs.geom_to_local(boundary_ll)
    tables_m = unary_union([crs.geom_to_local(shape(t.geometry.model_dump()))
                            for t in layout.tables]) if layout.tables else None

    def free_spot(x0: float, y0: float, clearance: float) -> tuple[float, float]:
        """Nearest point to (x0, y0) whose clearance disc misses every table and
        stays inside the fence — rings of candidates, closest first. If nothing
        is fully clear (packed site), return the candidate with the widest gap."""
        inner = boundary_m.buffer(-1.0)
        best, best_gap = (x0, y0), -1.0
        for r in [0.0] + [1.0 * k for k in range(2, 61)]:
            n = 1 if r == 0 else max(12, int(2 * math.pi * r / 1.5))
            for k in range(n):
                c = (x0 + r * math.cos(2 * math.pi * k / n),
                     y0 + r * math.sin(2 * math.pi * k / n))
                p = Point(c)
                if not inner.contains(p.buffer(min(clearance * 0.6, 1.2))):
                    continue
                gap = tables_m.distance(p) if tables_m is not None else 1e9
                if gap > best_gap:
                    best, best_gap = c, gap
                if gap >= clearance:
                    return c
        return best

    # ---- inverter placement: one per block of tables, beside its block ----
    inverter_points: list[dict] = []
    if layout.tables and inverter_count:
        n = len(layout.tables)
        for i in range(inverter_count):
            t = layout.tables[min(int((i + 0.5) * n / inverter_count), n - 1)]
            x, y = free_spot(*crs.to_local(t.centroid["lon"], t.centroid["lat"]),
                             INVERTER_CLEARANCE_M)
            lon, lat = crs.to_wgs84(x, y)
            inverter_points.append({
                "id": f"INV-{i+1:02d}",
                "lon": lon,
                "lat": lat,
                "capacity_kw": INVERTER["capacity_kw"],
                "strings": min(strings_per_inverter, string_count - i * strings_per_inverter),
            })

    # ---- transformer / LV panel: just OUTSIDE the fence on the edge nearest
    # the array — where UK DNO package substations actually sit; guarantees it
    # never overlaps a PV table on a packed site ----
    arr_c = tables_m.centroid if tables_m is not None else boundary_m.centroid
    parts = boundary_m.geoms if boundary_m.geom_type == "MultiPolygon" else [boundary_m]
    cands = [p for part in parts
             for p in (part.exterior.interpolate(d)
                       for d in _linspace(0, part.exterior.length, 300))]
    edge = min(cands, key=lambda p: p.distance(arr_c))
    dx, dy = arr_c.x - edge.x, arr_c.y - edge.y   # inward direction
    dl = math.hypot(dx, dy) or 1.0
    tx_x, tx_y = edge.x - dx / dl * 3.0, edge.y - dy / dl * 3.0
    tx_lon, tx_lat = crs.to_wgs84(tx_x, tx_y)
    transformer_point = {"id": "TX-01", "lon": tx_lon, "lat": tx_lat}

    # ---- cable routes (right-angle trench routes in local metres) ----
    cable_routes: list[dict] = []
    dc_len = string_count * AVG_DC_STRING_LENGTH_M
    ac_len = 0.0
    route_lengths: list[float] = []
    for ip in inverter_points:
        ix, iy = crs.to_local(ip["lon"], ip["lat"])
        corner = crs.to_wgs84(tx_x, iy)
        route = [[ip["lon"], ip["lat"]], [corner[0], corner[1]], [tx_lon, tx_lat]]
        cable_routes.append({"type": "ac", "from": ip["id"], "to": "TX-01", "coordinates": route})
        length = abs(ix - tx_x) + abs(iy - tx_y)
        route_lengths.append(length)
        ac_len += length

    # ---- AC cable sizing: smallest conductor (≤2 parallel runs) that meets
    # both ampacity and ≤2% voltage drop on the longest run (3-phase) ----
    v_sys = 400.0
    current = (INVERTER["capacity_kw"] * 1000) / (math.sqrt(3) * v_sys)
    worst_ac = max(route_lengths, default=0.0)

    def vd_pct(area_mm2: float, runs: int) -> float:
        r_per_m = RHO_CU_90C / (area_mm2 * runs)
        return math.sqrt(3) * current * r_per_m * worst_ac / v_sys * 100

    size, runs, vd = AC_CABLE_SIZES[-1][0], 2, vd_pct(AC_CABLE_SIZES[-1][0], 2)
    for r in (1, 2):
        pick = next(((a, amp) for a, amp in AC_CABLE_SIZES
                     if amp * r >= current and vd_pct(a, r) <= MAX_VD_PERCENT), None)
        if pick:
            size, runs, vd = pick[0], r, vd_pct(pick[0], r)
            break
    ac_cable_spec = f"{'2× ' if runs == 2 else ''}4C {size} mm² Cu XLPE/SWA"
    if vd > MAX_VD_PERCENT:
        warnings.append(
            f"AC voltage drop {vd:.1f}% exceeds {MAX_VD_PERCENT:.0f}% even with "
            f"{ac_cable_spec}; relocate the LV panel closer to the array.")

    # ---- transformer rules ----
    g = assumptions.grid
    if g.connection_voltage == "400V" and dc_kwp <= g.max_lv_connection_kw:
        tx_required, tx_kva = False, None
        rec = "Direct 400V LV connection (within LV limit); confirm with DNO."
    else:
        tx_required = True
        required_kva = (inverter_count * INVERTER["capacity_kw"]) / 0.95 if inverter_count else dc_kwp / 0.95
        tx_kva = next((k for k in STANDARD_TX_KVA if k >= required_kva), STANDARD_TX_KVA[-1])
        rec = f"{g.connection_voltage} connection with {tx_kva} kVA transformer"
    warnings.append(
        "Transformer and grid-connection capacity must be confirmed with the local "
        "distribution network operator (DNO)."
    )

    return ElectricalResult(
        modules_per_string=modules_per_string,
        string_count=string_count,
        strings_per_inverter=strings_per_inverter,
        inverter_count=inverter_count,
        inverter_capacity_kw=INVERTER["capacity_kw"],
        inverter_model=INVERTER["model"],
        total_inverter_capacity_kw=total_inv_kw,
        dc_ac_ratio=round(dc_ac, 3),
        estimated_dc_cable_length_m=round(dc_len, 0),
        estimated_ac_cable_length_m=round(ac_len * runs, 0),
        ac_cable_spec=ac_cable_spec,
        voltage_drop_percent=round(vd, 2),
        transformer_required=tx_required,
        transformer_kva=tx_kva,
        grid_connection_recommendation=rec,
        dno_confirmation_required=tx_required,
        inverter_points=inverter_points,
        transformer_point=transformer_point if tx_required else None,
        cable_routes=cable_routes,
        warnings=warnings,
    )


def _haversine(lat1, lon1, lat2, lon2) -> float:
    R = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _linspace(a, b, n):
    return [a + (b - a) * i / (n - 1) for i in range(n)]
