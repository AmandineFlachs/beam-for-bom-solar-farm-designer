"""Live site conditions from Open-Meteo — current irradiance, temp, wind, cloud.

Free API, no key. Short disk cache (10 min) so repeated HUD polls don't hammer
the service; failure returns a cached/stale payload if we have one, else raises.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import httpx

CACHE_DIR = Path(__file__).parent.parent / "cache" / "conditions"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
TTL_S = 600

URL = "https://api.open-meteo.com/v1/forecast"
PARAMS = {
    "current": ("temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m,"
                "wind_direction_10m,shortwave_radiation,direct_normal_irradiance,"
                "diffuse_radiation,is_day"),
    "timezone": "auto",
}


def site_conditions(lat: float, lon: float) -> dict:
    key = hashlib.sha256(f"{lat:.4f},{lon:.4f}".encode()).hexdigest()[:16]
    cache = CACHE_DIR / f"{key}.json"
    if cache.exists() and time.time() - cache.stat().st_mtime < TTL_S:
        return json.loads(cache.read_text())
    try:
        r = httpx.get(URL, params={**PARAMS, "latitude": lat, "longitude": lon},
                      timeout=15)
        r.raise_for_status()
        body = r.json()
        cur = body.get("current", {})
        out = {
            "source": "open-meteo live",
            "fetched_at": time.strftime("%H:%M:%S"),
            "ghi_wm2": cur.get("shortwave_radiation"),
            "dni_wm2": cur.get("direct_normal_irradiance"),
            "diffuse_wm2": cur.get("diffuse_radiation"),
            "temperature_c": cur.get("temperature_2m"),
            "humidity_pct": cur.get("relative_humidity_2m"),
            "cloud_cover_pct": cur.get("cloud_cover"),
            "wind_ms": cur.get("wind_speed_10m"),
            "wind_dir_deg": cur.get("wind_direction_10m"),
            "is_day": bool(cur.get("is_day")),
        }
        cache.write_text(json.dumps(out))
        return out
    except Exception as e:
        if cache.exists():
            d = json.loads(cache.read_text())
            d["source"] += " (stale)"
            return d
        raise RuntimeError(f"live conditions unavailable: {e}")
