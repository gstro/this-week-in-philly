#!/usr/bin/env python3
"""Writes a week's Top 3 picks to the "Curated Events" Google Calendar.

Clears the *target* (upcoming) week's existing entries first (D2 fix --
the design's original draft said "prior week," which would destroy the
attendance signal attendance_check.py needs before it runs; must always be
the week being created, so re-runs don't duplicate). Up to 21 events (3 per
day x 7 days; fewer if a day has fewer than 3 qualifying picks -- D3).

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
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common

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
        naive = datetime.strptime(f"{day_date} {event_time}", "%Y-%m-%d %I:%M %p")
    except ValueError:
        return None
    return naive.replace(tzinfo=EASTERN)


def build_event(day: dict, pick: dict) -> dict | None:
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

    event = {
        "summary": pick["title"],
        "start": {"dateTime": start.isoformat()},
        "end": {"dateTime": end.isoformat()},
        "description": "\n\n".join(description_parts),
    }
    if pick.get("address"):
        event["location"] = pick["address"]
    return event


def clear_target_week(service, calendar_id: str, monday: date) -> int:
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


def main():
    parser = argparse.ArgumentParser(description="Write a week's Top 3 picks to the calendar")
    parser.add_argument("week_dir", type=Path, help="data/YYYY-MM-DD")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    selections = common.load_selections(args.week_dir)
    monday = date.fromisoformat(selections["days"][0]["date"])

    events = []
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
