"""In-memory + SQLite project store."""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from pathlib import Path

from .models import Site

_DB = Path(__file__).parent.parent / "beam_projects.db"
_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sites (site_id TEXT PRIMARY KEY, data TEXT)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS designs (site_id TEXT PRIMARY KEY, data TEXT)"
    )
    return conn


def new_site_id() -> str:
    return f"site_{uuid.uuid4().hex[:8]}"


def save_site(site: Site) -> None:
    with _lock, _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO sites (site_id, data) VALUES (?, ?)",
            (site.site_id, site.model_dump_json()),
        )


def get_site(site_id: str) -> Site | None:
    with _lock, _conn() as c:
        row = c.execute("SELECT data FROM sites WHERE site_id = ?", (site_id,)).fetchone()
    return Site.model_validate_json(row[0]) if row else None


def save_design(site_id: str, design: dict) -> None:
    with _lock, _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO designs (site_id, data) VALUES (?, ?)",
            (site_id, json.dumps(design)),
        )


def get_design(site_id: str) -> dict | None:
    with _lock, _conn() as c:
        row = c.execute("SELECT data FROM designs WHERE site_id = ?", (site_id,)).fetchone()
    return json.loads(row[0]) if row else None
