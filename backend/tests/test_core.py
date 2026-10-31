"""Core engine tests on a synthetic square site (~4 ha)."""
import math

import pytest
from shapely.geometry import Polygon

from app.models import DesignAssumptions, Site, Exclusion
from app.services.geo import LocalCRS, area_ha, validate_polygon
from app.services.layout import generate_layout
from app.services.electrical import design_electrical
from app.services.bom import generate_bom
from app.services import osm_features


@pytest.fixture(autouse=True)
def _no_osm(monkeypatch):
    """Tests must not hit the Overpass API."""
    monkeypatch.setattr(osm_features, "fetch_osm_features", lambda *a, **k: [])


def square_site(size_m: float = 200.0, lat0: float = 53.6, lon0: float = -2.1,
                exclusions=None) -> Site:
    """~200 m square in NW England (~4 ha)."""
    crs = LocalCRS(lat0, lon0)
    half = size_m / 2
    ring_local = [(-half, -half), (half, -half), (half, half), (-half, half), (-half, -half)]
    ring_wgs = [[lon, lat] for lon, lat in (crs.to_wgs84(x, y) for x, y in ring_local)]
    exs = []
    for i, ex in enumerate(exclusions or []):
        exs.append(Exclusion(id=f"ex_{i}", label=ex.get("label", "ex"),
                             geometry=ex["geometry"]))
    return Site(
        site_id="site_test", name="Test Field",
        boundary={"type": "Polygon", "coordinates": [ring_wgs]},
        exclusions=exs,
        centroid={"lat": lat0, "lon": lon0},
    )


def test_area_calculation():
    site = square_site()
    ha = area_ha(site.boundary.model_dump())
    assert ha == pytest.approx(4.0, rel=0.05)


def test_coordinate_transform_roundtrip():
    crs = LocalCRS(53.6, -2.1)
    lon, lat = crs.to_wgs84(100, 200)
    x, y = crs.to_local(lon, lat)
    assert x == pytest.approx(100, abs=0.01)
    assert y == pytest.approx(200, abs=0.01)


def test_validate_polygon_repairs():
    # bowtie (self-intersecting)
    geom = {"type": "Polygon", "coordinates": [[
        [0, 0], [2, 2], [2, 0], [0, 2], [0, 0]]]}
    poly = validate_polygon(geom)
    assert poly.is_valid and poly.area > 0


def test_layout_table_count():
    site = square_site()
    a = DesignAssumptions()
    a.target.mode = "max_fill"  # don't trim
    res = generate_layout(site, a, terrain=None)
    assert res.table_count > 0
    assert res.module_count == res.table_count * a.array.modules_per_table_row * a.array.module_rows_per_table
    # sanity: each table ~27.6 x 4.6 m, pitch 6 m — 4 ha should fit ~100+ tables
    assert res.table_count > 60
    # all tables inside boundary (with setback)
    for t in res.tables[:5]:
        assert t.table_id.startswith("PV-T-")


def test_layout_exclusion_removes_tables():
    lat0, lon0 = 53.6, -2.1
    crs = LocalCRS(lat0, lon0)
    ex_ring = [[lon, lat] for lon, lat in
               (crs.to_wgs84(x, y) for x, y in
                [(-100, -100), (0, -100), (0, 0), (-100, 0), (-100, -100)])]
    site = square_site(exclusions=[{"label": "wood",
                                    "geometry": {"type": "Polygon",
                                                 "coordinates": [ex_ring]}}])
    a = DesignAssumptions()
    a.target.mode = "max_fill"
    res = generate_layout(site, a)
    res_full = generate_layout(square_site(), a)
    assert res.table_count < res_full.table_count


def test_electrical_sizing():
    site = square_site()
    a = DesignAssumptions()
    a.target.mode = "max_fill"
    layout = generate_layout(site, a)
    elec = design_electrical(site, layout, a)
    # 430W, Voc 49.8 -> floor(990/49.8)=19 -> capped 18
    assert elec.modules_per_string == 18
    assert elec.string_count == math.ceil(layout.module_count / 18)
    # inverter count targets DC/AC ~1.2
    assert elec.inverter_count == max(
        1, min(math.ceil(elec.string_count / elec.strings_per_inverter),
               round(layout.dc_capacity_kwp / (250 * 1.2))))
    assert elec.dc_ac_ratio == pytest.approx(
        layout.dc_capacity_kwp / (elec.inverter_count * 250), rel=1e-3)
    assert elec.transformer_required  # 11kV
    assert elec.transformer_kva in [500, 800, 1000, 1250, 1600, 2000, 2500, 3150]


def test_equipment_clear_of_tables():
    site = square_site()
    a = DesignAssumptions()
    a.target.mode = "max_fill"
    layout = generate_layout(site, a)
    elec = design_electrical(site, layout, a)
    from shapely.geometry import Point
    tables = [Point(t.centroid["lon"], t.centroid["lat"]) for t in layout.tables]
    from app.services.geo import LocalCRS
    from shapely.geometry import shape
    tabs = [shape(t.geometry.model_dump()) for t in layout.tables]
    for ip in elec.inverter_points:
        p = Point(ip["lon"], ip["lat"])
        assert not any(t.intersects(p.buffer(1e-5)) for t in tabs), ip["id"]
    assert elec.transformer_point
    tp = Point(elec.transformer_point["lon"], elec.transformer_point["lat"])
    assert not any(t.intersects(tp.buffer(2e-5)) for t in tabs)


def test_ac_cable_sizing():
    site = square_site()
    a = DesignAssumptions()
    a.target.mode = "max_fill"
    layout = generate_layout(site, a)
    elec = design_electrical(site, layout, a)
    assert elec.voltage_drop_percent <= 2.0
    assert "mm²" in elec.ac_cable_spec


def test_transformer_rule_400v():
    site = square_site()
    a = DesignAssumptions()
    a.grid.connection_voltage = "400V"
    a.target.mode = "max_fill"
    layout = generate_layout(site, a)
    elec = design_electrical(site, layout, a)
    # 4ha site >400 kW -> still requires transformer
    assert elec.transformer_required


def test_bom_quantities():
    site = square_site()
    a = DesignAssumptions()
    a.target.mode = "max_fill"
    layout = generate_layout(site, a)
    elec = design_electrical(site, layout, a)
    bom = generate_bom(site, layout, elec, None, a)
    flat = {i.item: i for p in bom.packages for i in p.items}
    assert flat["430 W monocrystalline PV module"].quantity == layout.module_count
    assert flat["Fixed-tilt PV table"].quantity == layout.table_count
    assert flat["Ground screw / pile"].quantity == layout.table_count * 8
    assert flat["250 kW string inverter"].quantity == elec.inverter_count
