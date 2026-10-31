"""Elevation fetching: Open-Meteo primary, Open-Elevation fallback, disk cache."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import httpx

CACHE_DIR = Path(__file__).parent.parent / "cache" / "elevation"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

OPEN_METEO_URL = "https://api.open-meteo.com/v1/elevation"
OPEN_ELEVATION_URL = "https://api.open-elevation.com/api/v1/lookup"


def _cache_key(points: list[tuple[float, float]]) -> str:
    s = ";".join(f"{lat:.5f},{lon:.5f}" for lat, lon in points)
    return hashlib.sha256(s.encode()).hexdigest()


def get_elevations(points: list[tuple[float, float]], timeout: float = 15.0) -> tuple[list[float], str]:
    """Return (elevations_m, source). Raises RuntimeError if both providers fail."""
    key = _cache_key(points)
    cache_file = CACHE_DIR / f"{key}.json"
    if cache_file.exists():
        data = json.loads(cache_file.read_text())
        return data["elevations"], f"{data['source']}-cache"

    # Open-Meteo accepts comma-joined lats/lons, max 100 coords per request.
    try:
        elevations: list[float] = []
        for i in range(0, len(points), 100):
            batch = points[i:i + 100]
            r = httpx.get(
                OPEN_METEO_URL,
                params={
                    "latitude": ",".join(f"{p[0]:.5f}" for p in batch),
                    "longitude": ",".join(f"{p[1]:.5f}" for p in batch),
                },
                timeout=timeout,
            )
            r.raise_for_status()
            elevations += [float(e) for e in r.json()["elevation"]]
        if len(elevations) != len(points):
            raise ValueError("elevation count mismatch")
        cache_file.write_text(json.dumps({"source": "open-meteo", "elevations": elevations}))
        return elevations, "open-meteo"
    except Exception:
        pass

    # Fallback: Open-Elevation (one request, locations array).
    try:
        r = httpx.post(
            OPEN_ELEVATION_URL,
            json={"locations": [{"latitude": p[0], "longitude": p[1]} for p in points]},
            timeout=timeout,
        )
        r.raise_for_status()
        elevations = [float(res["elevation"]) for res in r.json()["results"]]
        cache_file.write_text(json.dumps({"source": "open-elevation", "elevations": elevations}))
        return elevations, "open-elevation"
    except Exception as e:
        raise RuntimeError(f"All elevation providers failed: {e}")
