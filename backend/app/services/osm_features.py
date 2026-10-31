"""Auto-detected site constraints from OpenStreetMap via the Overpass API.

Fetches buildings, water, woodland and roads intersecting the site boundary and
returns them as labelled GeoJSON polygons — these are subtracted from the
buildable area just like user-drawn exclusions. Cached on disk; failure is
non-fatal (the caller decides whether to warn).
"""
from __future__ import annotations

import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from shapely.geometry import LineString, Polygon

CACHE_DIR = Path(__file__).parent.parent / "cache" / "osm"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.nchc.org.tw/api/interpreter",
]

# feature tag -> (label, polygon buffer in metres)
RULES = {
    "building": ("Building", 5.0),
    "water": ("Waterbody", 5.0),
    "wood": ("Woodland", 4.0),
    "road": ("Road", 6.0),
}

# Split queries: Overpass public endpoints are heavily rate-limited and a big
# union query can time out — several small queries are far more reliable.
QUERIES = [
    '[out:json][timeout:15];way["building"]({s},{w},{n},{e});out geom;',
    ('[out:json][timeout:15];('
     'way["natural"="water"]({s},{w},{n},{e});'
     'way["natural"="wood"]({s},{w},{n},{e});'
     'way["landuse"="forest"]({s},{w},{n},{e});'
     'way["landcover"="trees"]({s},{w},{n},{e});'
     ');out geom;'),
    '[out:json][timeout:15];way["highway"]({s},{w},{n},{e});out geom;',
]


_FAILED: dict[str, float] = {}   # bbox key -> time of last total failure
FAIL_TTL_S = 300                 # don't re-hammer Overpass for 5 min after a miss


def fetch_osm_features(south: float, west: float, north: float, east: float) -> list[dict]:
    """Return [{kind, label, geometry(geojson Polygon|LineString), buffer_m}]. Cached."""
    key = hashlib.sha256(f"{south:.5f},{west:.5f},{north:.5f},{east:.5f}".encode()).hexdigest()
    cache = CACHE_DIR / f"{key}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    if time.time() - _FAILED.get(key, 0) < FAIL_TTL_S:
        raise RuntimeError("Overpass unavailable (recent failure, retry later)")

    headers = {"User-Agent": "beam-for-bom/0.1 (solar pre-design tool, hackathon)"}

    def run(q_tpl: str):
        q = q_tpl.format(s=south, w=west, n=north, e=east)
        err: Exception | None = None
        for url in OVERPASS_URLS[:3]:
            try:
                r = httpx.get(url, params={"data": q}, headers=headers, timeout=55)
                r.raise_for_status()
                return r.json().get("elements", []), None
            except Exception as e:
                err = e
        return None, err

    # queries in parallel, short timeouts: worst case ~36 s instead of minutes
    with ThreadPoolExecutor(len(QUERIES)) as ex:
        results = list(ex.map(run, QUERIES))
    if any(els is None for els, _ in results):
        # partial data would silently drop constraints — treat as unavailable
        _FAILED[key] = time.time()
        raise RuntimeError(f"Overpass unavailable: {next(e for els, e in results if els is None)}")
    data = {"elements": [el for els, _ in results for el in els]}

    features: list[dict] = []
    for el in data.get("elements", []):
        if el.get("type") != "way" or not el.get("geometry"):
            continue
        tags = el.get("tags", {})
        kind = _classify(tags)
        if not kind:
            continue
        coords = [(pt["lon"], pt["lat"]) for pt in el["geometry"]]
        label, buf = RULES[kind]
        if kind == "road":
            # roads are linestrings — buffer into a polygon later
            geom = {"type": "LineString", "coordinates": coords}
        else:
            if len(coords) < 3:
                continue
            if coords[0] != coords[-1]:
                coords.append(coords[0])
            geom = {"type": "Polygon", "coordinates": [coords]}
        features.append({
            "id": f"osm_{el['type']}_{el['id']}",
            "kind": kind, "label": label,
            "geometry": geom, "buffer_m": buf,
            "name": tags.get("name"),
        })

    cache.write_text(json.dumps(features))
    return features


def _classify(tags: dict) -> str | None:
    if tags.get("building"):
        return "building"
    if tags.get("natural") == "water":
        return "water"
    if tags.get("natural") == "wood" or tags.get("landuse") == "forest" \
            or tags.get("landcover") == "trees":
        return "wood"
    if tags.get("highway"):
        return "road"
    return None


def feature_to_shapely(f: dict, crs):
    """Project a feature to local CRS, applying its buffer. Returns shapely geom."""
    geom = f["geometry"]
    if geom["type"] == "LineString":
        line = crs.geom_to_local(LineString(geom["coordinates"]))
        return line.buffer(f["buffer_m"])
    poly = crs.geom_to_local(Polygon(geom["coordinates"][0]))
    return poly.buffer(f["buffer_m"])
