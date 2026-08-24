#!/usr/bin/env python3
"""Import scraped PlayaEvents JSON into paywall.sqlite events table.

By default, replaces only rows previously imported from PlayaEvents
(matched via a [playaevents] marker, or a legacy playaevents.burningman.org
URL in description) so manual camp events stay intact.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import time
from pathlib import Path

PLAYA_URL_MARKER = "playaevents.burningman.org"
PLAYA_SOURCE_MARKER = "[playaevents]"
PLAYA_URL_RE = re.compile(
    r"(?:\s*[·•]\s*)?https?://(?:www\.)?playaevents\.burningman\.org\S*",
    re.I,
)


def sanitize(raw: str, max_len: int) -> str:
    return " ".join((raw or "").split()).strip()[:max_len]


def strip_playa_source(raw: str) -> str:
    text = PLAYA_URL_RE.sub(" ", raw or "")
    text = text.replace(PLAYA_SOURCE_MARKER, " ")
    return sanitize(text, 2000)


def playa_import_description(raw: str) -> str:
    desc = strip_playa_source(raw)
    room = max(0, 2000 - len(PLAYA_SOURCE_MARKER) - 1)
    desc = desc[:room].rstrip()
    return f"{desc} {PLAYA_SOURCE_MARKER}".strip() if desc else PLAYA_SOURCE_MARKER


def scrub_legacy_playa_urls(conn: sqlite3.Connection) -> int:
    rows = conn.execute(
        "SELECT id, description FROM events WHERE description LIKE ?",
        (f"%{PLAYA_URL_MARKER}%",),
    ).fetchall()
    for event_id, desc in rows:
        conn.execute(
            "UPDATE events SET description = ? WHERE id = ?",
            (playa_import_description(desc), event_id),
        )
    return len(rows)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", type=Path, default=Path("data/playa-events-2026.json"))
    ap.add_argument("--db", type=Path, default=Path("data/paywall.sqlite"))
    ap.add_argument(
        "--replace-playa",
        action="store_true",
        default=True,
        help="Delete existing playaevents-sourced rows before insert (default)",
    )
    ap.add_argument(
        "--no-replace-playa",
        action="store_true",
        help="Append without deleting prior playa rows",
    )
    ap.add_argument(
        "--replace-all",
        action="store_true",
        help="Delete ALL events first (including manual ones)",
    )
    ap.add_argument(
        "--scrub-only",
        action="store_true",
        help="Strip legacy playaevents URLs from descriptions; do not import",
    )
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA journal_mode=WAL")

    if args.scrub_only:
        n = scrub_legacy_playa_urls(conn)
        conn.commit()
        conn.close()
        print(f"Scrubbed playaevents URLs from {n} event descriptions → {args.db}")
        return 0

    payload = json.loads(args.json.read_text())
    rows = payload.get("db_rows") or []
    if not rows:
        raise SystemExit("No db_rows in JSON")

    before = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    deleted = 0
    if args.replace_all:
        deleted = conn.execute("DELETE FROM events").rowcount
    elif not args.no_replace_playa:
        deleted = conn.execute(
            "DELETE FROM events WHERE description LIKE ? OR description LIKE ?",
            (f"%{PLAYA_URL_MARKER}%", f"%{PLAYA_SOURCE_MARKER}%"),
        ).rowcount

    now = int(time.time() * 1000)
    conn.executemany(
        """
        INSERT INTO events (title, description, location, host, starts_at, ends_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                sanitize(r["title"], 80),
                playa_import_description(r.get("description") or ""),
                sanitize(r.get("location") or "", 80),
                sanitize(r.get("host") or "", 48),
                int(r["starts_at"]),
                int(r["ends_at"]) if r.get("ends_at") is not None else None,
                now,
                now,
            )
            for r in rows
        ],
    )
    conn.commit()
    count = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    conn.close()
    print(
        f"Imported {len(rows)} rows (deleted {deleted}; was {before}) → {args.db} now has {count} events"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
