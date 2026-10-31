"""PVGIS yield estimation via pvlib, with disk cache and monthly fallback.
Never fabricates a yield number — raises on total failure."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

from ..models import DesignAssumptions, LayoutResult, Site, YieldResult

CACHE_DIR = Path(__file__).parent.parent / "cache" / "pvgis"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _key(lat, lon, tilt, az, kwp, loss) -> str:
    s = f"{lat:.4f}|{lon:.4f}|{tilt}|{az}|{kwp:.1f}|{loss}"
    return hashlib.sha256(s.encode()).hexdigest()


def estimate_yield(
    site: Site, layout: LayoutResult, assumptions: DesignAssumptions
) -> YieldResult:
    lat, lon = site.centroid["lat"], site.centroid["lon"]
    tilt = assumptions.array.tilt_degrees
    az = assumptions.array.azimuth_degrees
    kwp = layout.dc_capacity_kwp
    loss = assumptions.system_loss_percent

    key = _key(lat, lon, tilt, az, round(kwp), loss)
    cache_file = CACHE_DIR / f"{key}.json"
    if cache_file.exists():
        d = json.loads(cache_file.read_text())
        d["source"] = d.get("source", "PVGIS") + " (cached)"
        return YieldResult(**d)

    monthly = _pvgis_hourly(lat, lon, tilt, az, kwp, loss) or \
        _pvgis_hourly(lat, lon, tilt, az, kwp, loss)  # retry once
    source = "PVGIS (hourly)"
    if monthly is None:
        monthly = _pvgis_monthly(lat, lon, tilt, az, kwp, loss)
        source = "PVGIS (monthly)"
    if monthly is None:
        raise RuntimeError(
            "PVGIS is unavailable after retries. Yield could not be estimated — "
            "please retry later. No value has been fabricated."
        )

    annual = sum(monthly)
    result = {
        "annual_energy_kwh": round(annual, 0),
        "annual_energy_mwh": round(annual / 1000, 1),
        "specific_yield_kwh_per_kwp": round(annual / kwp, 0) if kwp else 0,
        "performance_ratio": round(1 - loss / 100, 3),
        "monthly_generation_kwh": [round(m, 0) for m in monthly],
        "source": source,
        "assumptions": {
            "tilt_degrees": tilt,
            "azimuth_degrees": az,
            "system_loss_percent": loss,
        },
        "warnings": [],
    }
    cache_file.write_text(json.dumps(result))
    return YieldResult(**result)


def _pvgis_hourly(lat, lon, tilt, az, kwp, loss) -> list[float] | None:
    try:
        from pvlib.iotools import get_pvgis_hourly

        data, _, _, _ = get_pvgis_hourly(
            latitude=lat, longitude=lon,
            start=2020, end=2020,
            surface_tilt=tilt, surface_azimuth=az,
            peakpower=kwp, pvcalculation=True,
            loss=loss, outputformat="json",
        )
        # pvlib returns P in W per hour
        monthly = data["P"].resample("MS").sum() / 1000.0
        return [float(v) for v in monthly.values[:12]]
    except Exception:
        return None


def _pvgis_monthly(lat, lon, tilt, az, kwp, loss) -> list[float] | None:
    try:
        import httpx

        r = httpx.get(
            "https://re.jrc.ec.europa.eu/api/v5_2/PVcalc",
            params={
                "lat": lat, "lon": lon, "peakpower": kwp,
                "loss": loss, "angle": tilt,
                "aspect": az - 180,  # PVGIS: 0=south
                "pvcalculation": 1, "outputformat": "json",
            },
            timeout=30,
        )
        r.raise_for_status()
        months = r.json()["outputs"]["monthly"]["fixed"]
        return [float(m["E_m"]) for m in months]
    except Exception:
        return None
