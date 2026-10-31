"""Geodesy helpers: WGS84 <-> local metric CRS, polygon validation, area."""
from __future__ import annotations

import json
import math

import numpy as np
from pyproj import CRS, Transformer
from shapely.geometry import Polygon, mapping, shape
from shapely import transform as shp_transform_vec


def geojson_to_shapely(geom: dict) -> Polygon:
    return shape(geom)


def shapely_to_geojson(geom) -> dict:
    return json.loads(json.dumps(mapping(geom)))


def validate_polygon(geom: dict) -> Polygon:
    """Validate a GeoJSON polygon, fixing self-intersections. Raises ValueError."""
    try:
        poly = shape(geom)
    except Exception as e:
        raise ValueError(f"Invalid polygon geometry: {e}")
    if poly.is_empty:
        raise ValueError("Polygon is empty")
    if not poly.is_valid:
        fixed = poly.buffer(0)
        if fixed.is_empty or not fixed.is_valid:
            raise ValueError("Polygon is invalid and cannot be repaired")
        poly = fixed
    if poly.geom_type == "MultiPolygon":
        if not poly.geoms:
            raise ValueError("MultiPolygon is empty")
    if poly.area == 0:
        raise ValueError("Polygon has zero area")
    return poly


def polygon_centroid(geom: dict) -> dict:
    poly = shape(geom)
    c = poly.centroid
    return {"lat": c.y, "lon": c.x}


class LocalCRS:
    """Azimuthal-equidistant projection centred on the site — metric, low distortion
    for a single field. Good enough for layout work at hectare scale."""

    def __init__(self, lat: float, lon: float):
        self.lat, self.lon = lat, lon
        crs = CRS.from_proj4(
            f"+proj=aeqd +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m +no_defs"
        )
        self._fwd = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        self._inv = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

    def geom_to_local(self, geom):
        return shp_transform_vec(geom, self._fwd_fn, include_z=False)

    def geom_to_wgs84(self, geom):
        return shp_transform_vec(geom, self._inv_fn, include_z=False)

    def _fwd_fn(self, coords):
        x, y = self._fwd.transform(coords[:, 0], coords[:, 1])
        return np.column_stack([x, y])

    def _inv_fn(self, coords):
        lon, lat = self._inv.transform(coords[:, 0], coords[:, 1])
        return np.column_stack([lon, lat])

    def to_local(self, lon: float, lat: float) -> tuple[float, float]:
        return self._fwd.transform(lon, lat)

    def to_wgs84(self, x: float, y: float) -> tuple[float, float]:
        """Returns (lon, lat)."""
        return self._inv.transform(x, y)


def area_ha(geom: dict) -> float:
    """Geodesic area in hectares using a local projection."""
    poly = shape(geom)
    c = poly.centroid
    crs = LocalCRS(c.y, c.x)
    return crs.geom_to_local(poly).area / 10_000


def rotate_around_centroid(geom, angle_degrees: float):
    """Rotate a local-CRS geometry around its own centroid (for azimuth alignment)."""
    from shapely.affinity import rotate
    return rotate(geom, angle_degrees, origin="centroid", use_radians=False)
