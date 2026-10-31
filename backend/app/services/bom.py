"""Deterministic BOM generation from design results."""
from __future__ import annotations

import math

from ..models import (
    BOMItem, BOMPackage, BOMResult, DesignAssumptions,
    ElectricalResult, LayoutResult, Site, YieldResult,
)


def generate_bom(
    site: Site,
    layout: LayoutResult,
    electrical: ElectricalResult,
    yld: YieldResult | None,
    assumptions: DesignAssumptions,
) -> BOMResult:
    mod = assumptions.module

    def item(name, qty, unit, pkg, basis, conf="high",
             sup=False, dno=False) -> BOMItem:
        return BOMItem(item=name, quantity=qty, unit=unit, package=pkg,
                       basis=basis, confidence=conf,
                       supplier_confirmation_required=sup,
                       dno_confirmation_required=dno)

    # site perimeter for fencing
    from shapely.geometry import shape
    from .geo import LocalCRS
    b = shape(site.boundary.model_dump())
    crs = LocalCRS(b.centroid.y, b.centroid.x)
    perimeter_m = crs.geom_to_local(b).length

    packages = [
        BOMPackage(package="PV modules", items=[
            item(f"{mod.wattage:.0f} W monocrystalline PV module",
                 layout.module_count, "units", "PV modules", "Layout engine"),
        ]),
        BOMPackage(package="Mounting", items=[
            item("Fixed-tilt PV table", layout.table_count, "tables",
                 "Mounting", "Layout engine"),
            item("Ground screw / pile", layout.table_count * 8, "units",
                 "Mounting", "8 posts per table"),
            item("Module rail / clamp set",
                 math.ceil(layout.module_count / 4), "sets",
                 "Mounting", "1 set per 4 modules"),
        ]),
        BOMPackage(package="DC electrical", items=[
            item("PV string cable (6 mm²)", electrical.estimated_dc_cable_length_m, "m",
                 "DC electrical", "string_count × 50 m"),
            item("DC connector pair (MC4-type)", layout.module_count, "pairs",
                 "DC electrical", "1 per module"),
            item("Combiner box", electrical.inverter_count, "units",
                 "DC electrical", "1 per inverter"),
            item("DC surge protection device", electrical.inverter_count, "units",
                 "DC electrical", "1 per inverter"),
        ]),
        BOMPackage(package="Inverters", items=[
            item(f"{electrical.inverter_capacity_kw:.0f} kW string inverter",
                 electrical.inverter_count, "units",
                 "Inverters", "Electrical sizing", conf="medium", sup=True),
        ]),
        BOMPackage(package="AC electrical", items=[
            item("LV distribution panel", 1, "unit", "AC electrical",
                 "Single LV board at transformer", conf="medium"),
            item(f"AC cable ({electrical.ac_cable_spec})",
                 electrical.estimated_ac_cable_length_m, "m", "AC electrical",
                 f"Inverter→LV panel trench routes; sized for "
                 f"{electrical.voltage_drop_percent:.1f}% max voltage drop", conf="medium"),
            item("Export energy meter", 1, "unit", "AC electrical",
                 "Revenue metering", conf="medium", sup=True),
        ]),
        BOMPackage(package="Grid connection", items=(
            [
                item(f"{electrical.transformer_kva:.0f} kVA transformer", 1, "unit",
                     "Grid connection", "Rule-based grid sizing; confirm with DNO",
                     conf="medium", sup=True, dno=True),
                item("Transformer station / kiosk", 1, "unit",
                     "Grid connection", "Packaged substation", conf="medium",
                     sup=True, dno=True),
                item("HV/LV switchgear", 1, "set", "Grid connection",
                     "Ring main unit + LV feeder", conf="medium", sup=True, dno=True),
            ] if electrical.transformer_required else [
                item("LV connection kit (400V)", 1, "set", "Grid connection",
                     "Direct LV connection; confirm with DNO", conf="medium",
                     sup=True, dno=True),
            ]
        )),
        BOMPackage(package="Civil works", items=[
            item("Perimeter fencing (deer/security)", round(perimeter_m), "m",
                 "Civil works", "Site perimeter"),
            item("Access gate", 2, "units", "Civil works",
                 "Main + maintenance access", conf="medium"),
        ]),
        BOMPackage(package="Monitoring", items=[
            item("Plant datalogger / SCADA gateway", 1, "unit", "Monitoring",
                 "Standard monitoring package", conf="medium", sup=True),
            item("Weather station (irradiance + temp)", 1, "unit", "Monitoring",
                 "Standard monitoring package", conf="medium", sup=True),
        ]),
        BOMPackage(package="Safety & compliance", items=[
            item("Earthing kit", 1, "set", "Safety & compliance",
                 "Site-wide earthing", conf="medium"),
            item("Signage and labelling pack", 1, "set", "Safety & compliance",
                 "Regulatory signage"),
            item("Documentation / compliance pack", 1, "set",
                 "Safety & compliance", "Handover documentation"),
        ]),
    ]

    line_count = sum(len(p.items) for p in packages)
    return BOMResult(packages=packages, line_count=line_count)
