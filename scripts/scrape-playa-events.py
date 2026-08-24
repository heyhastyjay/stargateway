#!/usr/bin/env python3
"""Scrape Burning Man PlayaEvents listings + detail pages for a given year.

Walks every day via the date-nav (Previous/Next Day) and follows any listing
pagination "Next" links so we never stop at the first page of a day.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

BASE = "https://playaevents.burningman.org"
PLAYA_TZ = ZoneInfo("America/Los_Angeles")
MONTHS = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}
TIME_RE = re.compile(
    r"(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?P<p>AM|PM)",
    re.I,
)
DATE_TIME_RE = re.compile(
    r"(?P<weekday>\w+),\s+(?P<month>\w+)\s+(?P<day>\d+)(?:st|nd|rd|th)?,\s+"
    r"(?P<year>\d{4}),\s+(?P<start>.+?)\s*[–—-]\s*(?P<end>.+)",
    re.I | re.S,
)
EVENT_ID_RE = re.compile(r"/playa_event/(\d+)/")
DAY_PATH_RE = re.compile(r"/(\d{4})/playa_events/(\d{1,2})/?")


def fetch(url: str, retries: int = 4) -> str:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            proc = subprocess.run(
                [
                    "curl",
                    "-sL",
                    "--fail",
                    "--max-time",
                    "90",
                    "-A",
                    "Mozilla/5.0 (compatible; CampStarlinkBot/1.0)",
                    url,
                ],
                check=True,
                capture_output=True,
            )
            return proc.stdout.decode("utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


def absolute_url(href: str) -> str:
    return urljoin(BASE + "/", href)


def normalize_url(url: str) -> str:
    parsed = urlparse(url)
    # Drop fragment; keep query (pagination often uses ?page=N).
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", parsed.query, ""))


def parse_clock(text: str) -> tuple[int, int]:
    m = TIME_RE.search(text.strip())
    if not m:
        raise ValueError(f"bad time: {text!r}")
    h = int(m.group("h"))
    minute = int(m.group("m") or 0)
    ampm = m.group("p").upper()
    if ampm == "AM":
        h = 0 if h == 12 else h
    else:
        h = 12 if h == 12 else h + 12
    return h, minute


def to_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def parse_occurrence(raw: str) -> dict[str, int] | None:
    cleaned = re.sub(r"\s+", " ", raw).strip()
    if not cleaned:
        return None
    m = DATE_TIME_RE.match(cleaned)
    if not m:
        return None
    month = MONTHS[m.group("month").lower()]
    day = int(m.group("day"))
    year = int(m.group("year"))
    sh, sm = parse_clock(m.group("start"))
    eh, em = parse_clock(m.group("end"))
    start = datetime(year, month, day, sh, sm, tzinfo=PLAYA_TZ)
    end = datetime(year, month, day, eh, em, tzinfo=PLAYA_TZ)
    if end <= start:
        end += timedelta(days=1)
    return {"starts_at": to_ms(start), "ends_at": to_ms(end)}


def row_label_value(soup: BeautifulSoup) -> dict[str, BeautifulSoup]:
    out: dict[str, BeautifulSoup] = {}
    for row in soup.select(".event-display > .row"):
        cols = row.find_all("div", recursive=False)
        if len(cols) < 2:
            continue
        label = cols[0].get_text(" ", strip=True).rstrip(":").strip().lower()
        if label:
            out[label] = cols[1]
    return out


def parse_detail(html: str, event_id: str, url: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    root = soup.select_one(".event-display")
    title_el = root.select_one("h2") if root else None
    title = title_el.get_text(" ", strip=True) if title_el else f"Event {event_id}"
    fields = row_label_value(soup) if root else {}

    occurrences: list[dict[str, int]] = []
    dates = fields.get("dates and times") or fields.get("date and time")
    if dates:
        # Prefer splitting on <br> so each occurrence is one chunk; fall back to full text.
        chunks: list[str] = []
        buf: list[str] = []
        for child in dates.children:
            name = getattr(child, "name", None)
            if name == "br":
                text = re.sub(r"\s+", " ", "".join(buf)).strip()
                if text:
                    chunks.append(text)
                buf = []
            else:
                buf.append(child if isinstance(child, str) else child.get_text(" ", strip=False))
        tail = re.sub(r"\s+", " ", "".join(buf)).strip()
        if tail:
            chunks.append(tail)
        if not chunks:
            chunks = [re.sub(r"\s+", " ", dates.get_text(" ", strip=True))]
        for chunk in chunks:
            occ = parse_occurrence(chunk)
            if occ:
                occurrences.append(occ)

    type_el = fields.get("type")
    event_type = type_el.get_text(" ", strip=True) if type_el else ""

    camp_el = fields.get("located at camp")
    host = camp_el.get_text(" ", strip=True) if camp_el else ""

    loc_el = fields.get("location")
    location = loc_el.get_text(" ", strip=True) if loc_el else host

    desc = ""
    desc_el = fields.get("description")
    if desc_el:
        desc = desc_el.get_text(" ", strip=True)
    if not desc and root:
        for p in root.find_all("p"):
            text = p.get_text(" ", strip=True)
            if text.lower().startswith("description"):
                continue
            if text:
                desc = text
                break

    if event_type and not desc.startswith(f"[{event_type}]"):
        desc = f"[{event_type}] {desc}".strip() if desc else f"[{event_type}]"

    return {
        "id": event_id,
        "url": url,
        "title": title,
        "host": host,
        "location": location,
        "type": event_type,
        "description": desc,
        "occurrences": occurrences,
    }


def extract_event_ids(soup: BeautifulSoup) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for a in soup.select("a.gold-flame[href*='/playa_event/']"):
        m = EVENT_ID_RE.search(a.get("href", ""))
        if not m:
            continue
        eid = m.group(1)
        if eid in seen:
            continue
        seen.add(eid)
        ids.append(eid)
    return ids


def day_slug_from_url(url: str) -> str | None:
    m = DAY_PATH_RE.search(urlparse(url).path)
    if not m:
        return None
    return f"{int(m.group(2)):02d}"


def find_next_day_url(soup: BeautifulSoup, year: int, current_day: str) -> str | None:
    """Follow the date-nav next-day control (pull-right), not previous-day or event titles."""
    nav = soup.select_one("#date-nav")
    if not nav:
        return None
    cur = int(current_day)

    def accept(href: str) -> str | None:
        abs_url = absolute_url(href)
        if f"/{year}/playa_events/" not in abs_url:
            return None
        slug = day_slug_from_url(abs_url)
        if not slug or int(slug) <= cur:
            return None
        return abs_url

    # PlayaEvents puts the forward day in .pull-right.
    for a in nav.select(".pull-right a[href*='/playa_events/']"):
        hit = accept(a.get("href") or "")
        if hit:
            return hit

    # Fallback: smallest day number greater than current in the date-nav.
    candidates: list[tuple[int, str]] = []
    for a in nav.select("a[href*='/playa_events/']"):
        hit = accept(a.get("href") or "")
        if hit:
            slug = day_slug_from_url(hit)
            if slug:
                candidates.append((int(slug), hit))
    if not candidates:
        return None
    candidates.sort()
    return candidates[0][1]


def find_next_page_url(soup: BeautifulSoup, page_url: str) -> str | None:
    """Return the listing pagination Next link, if the site exposes one."""
    current = normalize_url(page_url)

    def is_next_link(a) -> bool:
        text = a.get_text(" ", strip=True).lower()
        rel = a.get("rel")
        rels = {r.lower() for r in rel} if isinstance(rel, list) else {str(rel or "").lower()}
        aria = (a.get("aria-label") or "").lower()
        classes = " ".join(a.get("class") or []).lower()
        if "next" in rels:
            return True
        if aria in {"next", "next page", "go to next page"}:
            return True
        if text in {"next", "next ›", "next »", "›", "»", "→"}:
            return True
        if text.startswith("next") and "day" not in text:
            return True
        if "next" in classes and "disabled" not in classes:
            return True
        return False

    scopes = []
    for sel in (".pagination", ".paginator", ".pager", "ul.pagination"):
        scopes.extend(soup.select(sel))
    for nav in soup.find_all("nav"):
        aria = (nav.get("aria-label") or "").lower()
        if "paginat" in aria or "pagination" in aria:
            scopes.append(nav)
    if not scopes:
        scopes = [soup]

    for scope in scopes:
        for a in scope.find_all("a", href=True):
            if not is_next_link(a):
                continue
            classes = " ".join(a.get("class") or []).lower()
            parent_classes = " ".join((a.parent.get("class") if a.parent else []) or []).lower()
            if "disabled" in classes or "disabled" in parent_classes:
                continue
            href = absolute_url(a["href"])
            if "/playa_event/" in href and "/playa_events/" not in href:
                continue
            if normalize_url(href) == current:
                continue
            return href
    return None


def listing_event_ids_for_day(year: int, day: str, start_url: str | None = None) -> list[str]:
    """Collect event ids for one day, following Next page buttons until exhausted."""
    url = start_url or f"{BASE}/{year}/playa_events/{day}/"
    ids: list[str] = []
    seen: set[str] = set()
    seen_pages: set[str] = set()
    page_num = 0

    while url:
        page_num += 1
        key = normalize_url(url)
        if key in seen_pages:
            break
        seen_pages.add(key)

        html = fetch(url)
        soup = BeautifulSoup(html, "html.parser")
        if "Server Error" in (soup.title.get_text() if soup.title else ""):
            break

        page_ids = extract_event_ids(soup)
        print(f"  day {day} page {page_num}: {len(page_ids)} events ({url})", flush=True)
        for eid in page_ids:
            if eid not in seen:
                seen.add(eid)
                ids.append(eid)

        next_url = find_next_page_url(soup, url)
        if not next_url:
            break
        url = next_url

    return ids


def discover_days(year: int) -> list[tuple[str, str]]:
    """Walk date-nav from day 01 forward. Returns [(day_slug, listing_url), ...]."""
    start = f"{BASE}/{year}/playa_events/01/"
    days: list[tuple[str, str]] = []
    seen_days: set[str] = set()
    url: str | None = start
    safety = 0

    while url and safety < 40:
        safety += 1
        html = fetch(url)
        soup = BeautifulSoup(html, "html.parser")
        title = soup.title.get_text() if soup.title else ""
        if "Server Error" in title:
            break

        day = day_slug_from_url(url)
        if not day:
            break
        if day in seen_days:
            break

        has_listing = bool(soup.select(".listing"))
        has_events = bool(soup.select(".listing a.gold-flame"))
        if not has_listing and not has_events:
            # Empty trailing day — stop walking.
            if days:
                break
            # Day 01 empty but page exists: still record and try next.
        seen_days.add(day)
        days.append((day, normalize_url(url)))
        heading = ""
        h3 = soup.select_one("#date-nav h3")
        if h3:
            heading = re.sub(r"\s+", " ", h3.get_text(" ", strip=True))
        print(f"Discovered day {day}: {heading or url}", flush=True)

        url = find_next_day_url(soup, year, day)

    return days


def scrape_event(year: int, event_id: str) -> dict:
    url = f"{BASE}/{year}/playa_event/{event_id}/"
    html = fetch(url)
    return parse_detail(html, event_id, url)


def expand_for_db(events: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for ev in events:
        occs = ev.get("occurrences") or []
        if not occs:
            continue
        for occ in occs:
            rows.append(
                {
                    "source_id": ev["id"],
                    "title": ev["title"],
                    "description": ev.get("description") or "",
                    "location": ev.get("location") or "",
                    "host": ev.get("host") or "",
                    "starts_at": occ["starts_at"],
                    "ends_at": occ["ends_at"],
                    "url": ev.get("url") or "",
                }
            )
    rows.sort(key=lambda r: (r["starts_at"], r["title"]))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=2026)
    ap.add_argument(
        "--days",
        default="all",
        help='Comma days like "01,02" or "all" (walk date-nav)',
    )
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument(
        "--out",
        type=Path,
        default=Path("data/playa-events-2026.json"),
    )
    ap.add_argument(
        "--only-new",
        action="store_true",
        help="Skip detail fetch for event ids already present in --out JSON",
    )
    args = ap.parse_args()

    prior_by_id: dict[str, dict] = {}
    if args.only_new and args.out.exists():
        try:
            prior = json.loads(args.out.read_text())
            for ev in prior.get("events") or []:
                if ev.get("id"):
                    prior_by_id[str(ev["id"])] = ev
            print(f"Loaded {len(prior_by_id)} prior events from {args.out}", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"Warning: could not read prior JSON ({e}); fetching all", flush=True)

    day_urls: list[tuple[str, str]]
    if args.days.strip().lower() == "all":
        print("Walking day pages via date-nav…", flush=True)
        day_urls = discover_days(args.year)
    else:
        days = [d.strip().zfill(2) for d in args.days.split(",") if d.strip()]
        day_urls = [(d, f"{BASE}/{args.year}/playa_events/{d}/") for d in days]

    if not day_urls:
        print("No day pages found", file=sys.stderr)
        return 1

    print(f"Days: {', '.join(d for d, _ in day_urls)}", flush=True)
    all_ids: list[str] = []
    seen: set[str] = set()
    for day, url in day_urls:
        ids = listing_event_ids_for_day(args.year, day, start_url=url)
        print(f"  day {day} total unique: {len(ids)}", flush=True)
        for eid in ids:
            if eid not in seen:
                seen.add(eid)
                all_ids.append(eid)

    to_fetch = [eid for eid in all_ids if eid not in prior_by_id]
    reuse = [prior_by_id[eid] for eid in all_ids if eid in prior_by_id]
    print(
        f"Listings: {len(all_ids)} unique · fetch details: {len(to_fetch)} · reuse: {len(reuse)}",
        flush=True,
    )

    events: list[dict] = list(reuse)
    errors: list[dict] = []
    done = 0
    if to_fetch:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futs = {pool.submit(scrape_event, args.year, eid): eid for eid in to_fetch}
            for fut in as_completed(futs):
                eid = futs[fut]
                done += 1
                try:
                    events.append(fut.result())
                except Exception as e:  # noqa: BLE001
                    errors.append({"id": eid, "error": str(e)})
                if done % 50 == 0 or done == len(to_fetch):
                    print(f"  {done}/{len(to_fetch)} details…", flush=True)

    events.sort(key=lambda e: int(e["id"]))
    rows = expand_for_db(events)
    payload = {
        "scraped_at": datetime.now(tz=PLAYA_TZ).isoformat(),
        "year": args.year,
        "days": [d for d, _ in day_urls],
        "unique_events": len(events),
        "occurrence_rows": len(rows),
        "errors": errors,
        "events": events,
        "db_rows": rows,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(
        f"Wrote {args.out} — {len(events)} events, {len(rows)} occurrence rows, {len(errors)} errors",
        flush=True,
    )
    return 0 if not errors else 2


if __name__ == "__main__":
    raise SystemExit(main())
