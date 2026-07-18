"""Shared helpers for the This Week in Philly v2 script suite.

Google auth is Calendar-only and reconstructed entirely from env vars (G3) --
Routines and GitHub Actions runners have no durable home directory, so
credentials.json/token.json are never written to disk. All paths are
repo-relative; there is no Drive or Gmail access in v2.
"""

import json
import os
from datetime import date, timedelta
from pathlib import Path

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import Resource, build

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"

CALENDAR_NAME = "Curated Events"
CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"]
CALENDAR_TIMEZONE = "America/New_York"

# The nine canonical category strings (emoji included, exact match), in
# report display order. See docs/v1/Skills/events-report-format/SKILL.md.
CATEGORY_ORDER = [
    "\U0001f3b5 Music & Concerts",
    "\U0001f3ac Film & Cinema",
    "\U0001f4da Literary",
    "\U0001f91d Community & Politics",
    "\U0001f3a8 Arts & Workshops",
    "\U0001f4bb Tech & Maker",
    "\U0001f33f Markets & Outdoors",
    "\U0001f47b Horror & Occult",
    "\U0001f3aa Festivals & Major Events",
]

# Maps the canonical emoji category strings to the short lowercase slugs
# used in the picks-log CSV's category column. Validated against the real
# 2026-06-22 archived week's rows in docs/v1/Data/event-picks-log.csv
# (all nine slugs confirmed; "outdoors" and "horror" only had precedent in
# other weeks in that file, not 2026-06-22 itself, since those categories
# didn't appear in that week's Top 3/honorable-mention picks).
CATEGORY_TO_CSV_SLUG = {
    "\U0001f3b5 Music & Concerts": "music",
    "\U0001f3ac Film & Cinema": "film",
    "\U0001f4da Literary": "literary",
    "\U0001f91d Community & Politics": "community",
    "\U0001f3a8 Arts & Workshops": "arts",
    "\U0001f4bb Tech & Maker": "tech",
    "\U0001f33f Markets & Outdoors": "outdoors",
    "\U0001f47b Horror & Occult": "horror",
    "\U0001f3aa Festivals & Major Events": "festival",
}

# Picks-log columns per CLAUDE.md's "Key contracts" section -- change with
# care, this is the interface csv_log.py and attendance_check.py share.
PICKS_LOG_COLUMNS = [
    "city",
    "week_of",
    "day",
    "date",
    "title",
    "venue",
    "category",
    "source",
    "rank",
    "price_tier",
    "spotify_link",
    "tags",
    "attended",
]

# Cost values treated as free beyond the literal "free" (case-insensitive).
# Validated against tests/golden/2026-06-22.html and the real picks-log CSV;
# extend if a future week surfaces another synonym, but don't guess ahead
# of evidence.
FREE_COST_SYNONYMS = {"free", "no cover"}


def is_placeholder_cost(text: str) -> bool:
    """True if `text` is a literal *(...)* unconfirmed-value wrapper, e.g.
    "*(confirm details)*" -- Selection's convention for "don't know yet"."""
    text = (text or "").strip()
    return text.startswith("*(") and text.endswith(")*")


def strip_placeholder_wrapper(text: str) -> str:
    """Strips a literal *(...)* placeholder wrapper (e.g. "*(confirm
    details)*" -> "confirm details"). Used for both cost and time -- both
    fields use this convention to flag uncertain/unconfirmed values."""
    text = (text or "").strip()
    if is_placeholder_cost(text):
        return text[2:-2].strip()
    return text


def is_free_cost(cost: str) -> bool:
    return strip_placeholder_wrapper(cost).casefold() in FREE_COST_SYNONYMS


def picks_log_path() -> Path:
    """Repo-relative by default; overridable via PICKS_LOG_PATH env var."""
    override = os.environ.get("PICKS_LOG_PATH")
    if override:
        return REPO_ROOT / override if not os.path.isabs(override) else Path(override)
    return DATA_DIR / "event-picks-log.csv"


def target_week_monday(today: date | None = None) -> date:
    """The Monday immediately following `today` (strictly after, never today).

    Per CLAUDE.md's week window convention: every stage covers the Monday
    immediately following the run date through the Sunday after, computed at
    runtime and never hardcoded.
    """
    today = today or date.today()
    days_ahead = (0 - today.weekday()) % 7  # Monday == 0
    if days_ahead == 0:
        days_ahead = 7
    return today + timedelta(days=days_ahead)


def week_dates(monday: date) -> list[date]:
    """The 7 dates (Monday through Sunday) for the week starting `monday`."""
    return [monday + timedelta(days=i) for i in range(7)]


def week_dir_path(monday: date) -> Path:
    return DATA_DIR / monday.isoformat()


def load_json(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def load_selections(week_dir: Path) -> dict:
    path = Path(week_dir) / "_selections.json"
    if not path.exists():
        raise FileNotFoundError(
            f"Selections have not run for this week. Run the report selection "
            f"task first. Expected: {path}"
        )
    return load_json(path)


def load_spotify(week_dir: Path) -> dict:
    """Returns {} if _spotify.json doesn't exist yet (spotify_lookup.py hasn't run)."""
    path = Path(week_dir) / "_spotify.json"
    if not path.exists():
        return {}
    return load_json(path)


def get_calendar_credentials() -> Credentials:
    """Reconstructs Google OAuth2 credentials from env vars (G3).

    Required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.
    Raises RuntimeError with a clear message if any are missing, rather than
    letting the underlying library fail cryptically.
    """
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    refresh_token = os.environ.get("GOOGLE_REFRESH_TOKEN")
    missing = [
        name
        for name, val in [
            ("GOOGLE_CLIENT_ID", client_id),
            ("GOOGLE_CLIENT_SECRET", client_secret),
            ("GOOGLE_REFRESH_TOKEN", refresh_token),
        ]
        if not val
    ]
    if missing:
        raise RuntimeError(
            f"Missing required env var(s) for Google auth: {', '.join(missing)}"
        )

    return Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
        scopes=CALENDAR_SCOPES,
    )


def get_calendar_service() -> Resource:
    return build("calendar", "v3", credentials=get_calendar_credentials())


def get_calendar_id(service: Resource) -> str:
    """Finds the "Curated Events" calendar by name. Raises if not found --
    matches v1's behavior of stopping and telling Greg to create it first."""
    page_token = None
    while True:
        result = service.calendarList().list(pageToken=page_token).execute()
        for entry in result.get("items", []):
            if entry.get("summary") == CALENDAR_NAME:
                return entry["id"]
        page_token = result.get("nextPageToken")
        if not page_token:
            break
    raise RuntimeError(
        f'Calendar "{CALENDAR_NAME}" not found. Create it before continuing.'
    )
