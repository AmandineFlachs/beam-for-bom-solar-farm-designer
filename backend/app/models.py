"""Pydantic models for BEAM for BOM."""
from __future__ import annotations

from typing import Any, Literal, Optional, Union
from pydantic import BaseModel, Field


# ---------- GeoJSON ----------
class PolygonGeometry(BaseModel):
    type: Literal["Polygon"] = "Polygon"
    coordinates: list[list[list[float]]]  # [[[lon, lat], ...]]


class MultiPolygonGeometry(BaseModel):
    type: Literal["MultiPolygon"] = "MultiPolygon"
    coordinates: list[list[list[list[float]]]]  # [[[[lon,lat],...]]]


class PointGeometry(BaseModel):
    type: Literal["Point"] = "Point"
    coordinates: list[float]  # [lon, lat]


class Exclusion(BaseModel):
    id: str = "exclusion_1"
    label: str = "Exclusion"
    geometry: PolygonGeometry


# ---------- Site ----------
class Site(BaseModel):
    site_id: str
    name: str = "Untitled site"
    boundary: Union[PolygonGeometry, MultiPolygonGeometry]
    exclusions: list[Exclusion] = []
    country: Optional[str] = None
    centroid: dict[str, float] = {}


class SiteCreateRequest(BaseModel):
    name: str = "Untitled site"
    boundary: Union[PolygonGeometry, MultiPolygonGeometry]
    exclusions: list[Exclusion] = []
    country: Optional[str] = None


class SiteCreateResponse(BaseModel):
    site_id: str


# ---------- Design assumptions ----------
class ModuleSpec(BaseModel):
    manufacturer: str = "Generic"
    model: str = "430W Mono"
    wattage: float = 430
    length_m: float = 2.3
    width_m: float = 1.1
    voc: float = 49.8
    vmpp: float = 41.0
    imp: float = 10.5


class ArraySpec(BaseModel):
    mounting: str = "fixed_tilt"
    tilt_degrees: float = 20
    azimuth_degrees: float = 180
    modules_per_table_row: int = 12
    module_rows_per_table: int = 2
    row_pitch_m: float = 6.0
    boundary_setback_m: float = 5.0
    exclusion_setback_m: float = 3.0
    access_aisle_every_n_rows: int = 8
    access_aisle_width_m: float = 4.0
    max_slope_degrees: float = 8.0


class GridSpec(BaseModel):
    connection_voltage: str = "11kV"
    max_lv_connection_kw: float = 400


class TargetSpec(BaseModel):
    mode: Literal["target_capacity", "max_fill", "budget"] = "target_capacity"
    target_dc_capacity_mwp: Optional[float] = 1.2
    land_use_factor: float = 1.0  # <1 = denser packing target


class DesignAssumptions(BaseModel):
    module: ModuleSpec = ModuleSpec()
    array: ArraySpec = ArraySpec()
    grid: GridSpec = GridSpec()
    target: TargetSpec = TargetSpec()
    system_loss_percent: float = 14.0


# ---------- Results ----------
class TerrainCell(BaseModel):
    lat: float
    lon: float
    elevation_m: float
    slope_degrees: float
    aspect_degrees: float
    suitability: str


class TerrainResult(BaseModel):
    total_area_ha: float
    usable_area_ha: float
    excluded_area_ha: float
    average_slope_degrees: float
    max_slope_degrees: float
    elevation_source: str = "open-meteo"
    suitability_grid: list[TerrainCell] = []
    suitable_polygon: Optional[dict] = None  # Polygon or MultiPolygon GeoJSON
    auto_exclusions: list[dict] = []  # OSM-detected buildings/water/woodland/roads
    warnings: list[str] = []


class PVTable(BaseModel):
    table_id: str
    module_count: int
    dc_capacity_kwp: float
    geometry: PolygonGeometry
    centroid: dict[str, float]
    string_ids: list[str] = []


class LayoutResult(BaseModel):
    module_count: int
    table_count: int
    dc_capacity_kwp: float
    modules_per_table: int
    tables: list[PVTable] = []
    target_met: bool = True
    warnings: list[str] = []


class ElectricalResult(BaseModel):
    modules_per_string: int
    string_count: int
    strings_per_inverter: int
    inverter_count: int
    inverter_capacity_kw: float
    inverter_model: str
    total_inverter_capacity_kw: float
    dc_ac_ratio: float
    estimated_dc_cable_length_m: float
    estimated_ac_cable_length_m: float
    ac_cable_spec: str = "4C 95 mm² Cu XLPE/SWA"
    voltage_drop_percent: float
    transformer_required: bool
    transformer_kva: Optional[float] = None
    grid_connection_recommendation: str
    dno_confirmation_required: bool = True
    inverter_points: list[dict[str, Any]] = []      # [{id, lon, lat, capacity_kw}]
    transformer_point: Optional[dict[str, Any]] = None
    cable_routes: list[dict[str, Any]] = []         # [{type, coordinates:[[lon,lat]...]}]
    warnings: list[str] = []


class YieldResult(BaseModel):
    annual_energy_kwh: float
    annual_energy_mwh: float
    specific_yield_kwh_per_kwp: float
    performance_ratio: Optional[float] = None
    monthly_generation_kwh: list[float]
    source: str = "PVGIS"
    assumptions: dict[str, Any] = {}
    warnings: list[str] = []


class BOMItem(BaseModel):
    item: str
    quantity: float
    unit: str
    package: str
    basis: str
    confidence: str = "high"
    supplier_confirmation_required: bool = False
    dno_confirmation_required: bool = False


class BOMPackage(BaseModel):
    package: str
    items: list[BOMItem]


class BOMResult(BaseModel):
    packages: list[BOMPackage]
    line_count: int


class DesignResponse(BaseModel):
    site: Site
    terrain: Optional[TerrainResult] = None
    layout: Optional[LayoutResult] = None
    electrical: Optional[ElectricalResult] = None
    yield_result: Optional[YieldResult] = Field(default=None, alias="yield")
    bom: Optional[BOMResult] = None
    beam_summary: dict[str, Any] = {}
    warnings: list[str] = []
    assumptions: list[str] = []

    model_config = {"populate_by_name": True}


# ---------- API request bodies ----------
class TerrainRequest(BaseModel):
    site_id: str
    grid_resolution_m: float = 30


class LayoutRequest(BaseModel):
    site_id: str
    design_assumptions: DesignAssumptions = DesignAssumptions()


class ElectricalRequest(BaseModel):
    site_id: str
    layout: Optional[LayoutResult] = None
    design_assumptions: DesignAssumptions = DesignAssumptions()


class YieldRequest(BaseModel):
    site_id: str
    layout: Optional[LayoutResult] = None
    design_assumptions: DesignAssumptions = DesignAssumptions()


class BOMRequest(BaseModel):
    site_id: str
    layout: Optional[LayoutResult] = None
    electrical: Optional[ElectricalResult] = None
    yield_result: Optional[YieldResult] = Field(default=None, alias="yield")
    model_config = {"populate_by_name": True}


class DesignRequest(BaseModel):
    site_id: str
    design_assumptions: DesignAssumptions = DesignAssumptions()


class ExportRequest(BaseModel):
    site_id: str
    format: str = "all"


class ChatRequest(BaseModel):
    site_id: Optional[str] = None
    message: str
    design_assumptions: Optional[DesignAssumptions] = None
    effort: Optional[str] = None  # Beam reasoning_effort override


class ChatResponse(BaseModel):
    reply: str
    design: Optional[DesignResponse] = None
    steps: list[dict[str, Any]] = []
    reasoning: Optional[str] = None        # Beam's reasoning_content trace
    meta: dict[str, Any] = {}              # model, effort, tokens, latency, mode
