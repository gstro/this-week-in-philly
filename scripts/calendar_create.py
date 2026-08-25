#!/usr/bin/env python3
"""Writes a week's Top 3 picks to the "Curated Events" Google Calendar.

Clears the *target* (upcoming) week's existing entries first (D2 fix --
the design's original draft said "prior week," which would destroy the
attendance signal attendance_check.py needs before it runs; must always be
the week being created, so re-runs don't duplicate). Up to 21 events (3 per
day x 7 days; fewer if a day has fewer than 3 qualifying picks -- D3).

"Clear the week being rendered" equals "clear the upcoming week" only when
the run is on-schedule, and on 2026-08-23 one wasn't. Merging PR #26 pushed
a backfill to data/2026-08-17/_selection_annotations.json, which matches
presentation.yml's path filter, so Presentation fired against a week that
had already ended: clear_target_week() deleted all 21 entries for
2026-08-17 -- including the ones Greg had deliberately removed, which *were*
the attendance record -- and recreated them, marking the whole week attended.
Verified after the fact: every event in that window carries a created
timestamp of 2026-08-23T03:38Z. That week is knowingly lost.

week_has_already_begun() below is the guard. A past-week run skips the
calendar write entirely and returns 0, so the report still renders and
publishes -- deliberately, because that same off-schedule run also did
something useful (it repaired two malformed times in the live 08-17 report).
Only the destructive half is suppressed.

End-time heuristics, from v1 (docs/v1/Scheduled/philly-events-presentation/
SKILL.md Step 5): literary +90 min, film +2 hrs, concert +3 hrs from door,
festival +6 hrs from open. The remaining five categories (Community &
Politics, Arts & Workshops, Tech & Maker, Markets & Outdoors, Horror &
Occult) have no documented heuristic anywhere in v1's docs -- defaults to
+2 hrs (same as film, a reasonable generic event length) for those; this
default is an inference beyond the documented spec, not validated against
any real historical data (no way to inspect Greg's actual calendar).

location: the pick's `address` field if present, else omitted entirely --
per spec ("address field if present"), not a venue-name fallback.
description: cost line included only if the cost is confirmed (not blank,
not a *(...)* placeholder) -- "cost if known" per spec.
"""

import argparse
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common

if TYPE_CHECKING:
    from googleapiclient._apis.calendar.v3.resources import CalendarResource
    from googleapiclient._apis.calendar.v3.schemas import Event

EASTERN = ZoneInfo(common.CALENDAR_TIMEZONE)

_LITERARY = "\U0001f4da Literary"
_FILM = "\U0001f3ac Film & Cinema"
_MUSIC = "\U0001f3b5 Music & Concerts"
_FESTIVAL = "\U0001f3aa Festivals & Major Events"

END_TIME_DELTA = {
    _LITERARY: timedelta(minutes=90),
    _FILM: timedelta(hours=2),
    _MUSIC: timedelta(hours=3),
    _FESTIVAL: timedelta(hours=6),
}
DEFAULT_END_TIME_DELTA = timedelta(hours=2)


def parse_start(day_date: str, event_time: str) -> datetime | None:
    event_time = common.strip_placeholder_wrapper(event_time)
    if not event_time:
        return None
    try:
        naive = datetime.strptime(f"{day_date} {event_time}", "%Y-%m-%d %I:%M %p")  # noqa: DTZ007 -- EASTERN attached below
    except ValueError:
        return None
    return naive.replace(tzinfo=EASTERN)


def build_event(day: dict, pick: dict) -> "Event | None":
    start = parse_start(day["date"], pick.get("time", ""))
    if start is None:
        print(
            f"  Skipping {pick['title']!r} ({day['date']}): unparseable/missing time",
            file=sys.stderr,
        )
        return None
    end = start + END_TIME_DELTA.get(pick["category"], DEFAULT_END_TIME_DELTA)

    description_parts = [pick["why"]]
    raw_cost = pick.get("cost", "")
    if raw_cost and not common.is_placeholder_cost(raw_cost):
        description_parts.append(f"Cost: {raw_cost}")
    if pick.get("url"):
        description_parts.append(pick["url"])

    event: Event = {
        "summary": pick["title"],
        "start": {"dateTime": start.isoformat()},
        "end": {"dateTime": end.isoformat()},
        "description": "\n\n".join(description_parts),
    }
    if pick.get("address"):
        event["location"] = pick["address"]
    return event


def today_eastern() -> date:
    """Today's date in Eastern. Seam for tests; see week_has_already_begun."""
    return datetime.now(EASTERN).date()


def week_has_already_begun(monday: date, today: date | None = None) -> bool:
    """True when `monday` is in the past, i.e. the week is over or underway.

    "Today" is Eastern, not the runner's UTC date -- this module already
    treats Eastern as authoritative for this calendar (see EASTERN above),
    and GitHub Actions cron is UTC and cannot follow DST (the same trap
    .github/workflows/collection.yml's cron comment describes). Mixing a UTC
    "now" into an Eastern-anchored week window is how off-by-one-day bugs
    get in.

    Deliberately `<` and not `!=`: a legitimate Sunday-evening-Eastern run
    has already crossed into Monday UTC, and an equality test would refuse
    it. Do not tighten this to `!=` -- the on-schedule path depends on it.
    """
    today = today or today_eastern()
    return monday < today


def clear_target_week(service: "CalendarResource", calendar_id: str, monday: date) -> int:
    start = datetime.combine(monday, datetime.min.time(), tzinfo=EASTERN)
    end = start + timedelta(days=7)
    deleted = 0
    page_token = None
    while True:
        result = (
            service.events()
            .list(
                calendarId=calendar_id,
                timeMin=start.isoformat(),
                timeMax=end.isoformat(),
                singleEvents=True,
                pageToken=page_token,
            )
            .execute()
        )
        for event in result.get("items", []):
            service.events().delete(calendarId=calendar_id, eventId=event["id"]).execute()
            deleted += 1
        page_token = result.get("nextPageToken")
        if not page_token:
            break
    return deleted


def main() -> None:
    parser = argparse.ArgumentParser(description="Write a week's Top 3 picks to the calendar")
    parser.add_argument("week_dir", type=Path, help="data/YYYY-MM-DD")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--force-calendar",
        action="store_true",
        help="override the past-week guard (see week_has_already_begun)",
    )
    args = parser.parse_args()

    selections = common.load_selections(args.week_dir)
    monday = date.fromisoformat(selections["days"][0]["date"])

    # Before auth, before the service object, before --dry-run: a past-week
    # run must not be able to reach the network at all. This ordering is what
    # makes `calendar_create.py data/<past-week>` -- the exact command that
    # caused the 2026-08-23 incident -- safe to run.
    today = today_eastern()
    if not args.force_calendar and week_has_already_begun(monday, today):
        age = (today - monday).days
        print(
            f"calendar_create: REFUSING to write.\n"
            f"  Week {monday.isoformat()} began {age} day(s) ago.\n"
            f"  Clearing a week that has already started destroys the attendance signal --\n"
            f"  presence of an entry at week's end is what records that Greg attended it\n"
            f"  (see CLAUDE.md's 'Attendance feedback loop').\n"
            f"  Skipping the calendar write; the rest of the pipeline still runs.\n"
            f"  Pass --force-calendar to override."
        )
        return

    events: list[Event] = []
    for day in selections["days"]:
        for pick in day["top3"]:
            event = build_event(day, pick)
            if event:
                events.append(event)

    if args.dry_run:
        print(
            f"[dry-run] Would clear existing events for week of {monday.isoformat()} "
            f"and create {len(events)} new events."
        )
        return

    service = common.get_calendar_service()
    calendar_id = common.get_calendar_id(service)

    deleted = clear_target_week(service, calendar_id, monday)

    created = 0
    for event in events:
        service.events().insert(calendarId=calendar_id, body=event).execute()
        created += 1

    print(
        f"Calendar sync complete. Cleared {deleted} stale events, "
        f"created {created} events for week of {monday.isoformat()}."
    )


if __name__ == "__main__":
    main()
