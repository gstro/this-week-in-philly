#!/usr/bin/env python3
"""Updates the `attended` column in data/event-picks-log.csv for last week's
Philadelphia rows, based on presence in the "Curated Events" Google
Calendar. Per CLAUDE.md's attendance feedback loop: Greg deletes calendar
entries he didn't attend, so presence at week's end means attended.

"Last week" is derived from --week-dir (the upcoming week runner.sh is
processing), not wall-clock today -- last_week_monday = that week's
Monday minus 7 days. Must run before csv_log.py (shared file; per
V2_IMPLEMENTATION_PLAN.md's runner.sh, attendance_check writes/reads the
prior week's rows while csv_log.py is about to append new ones for the
upcoming week -- disjoint week_of values, but same file).

Note: calendar_create.py only creates events for the 21 Top 3 picks, not
honorable mentions (per docs/v1/Scheduled/philly-events-presentation/
SKILL.md Step 5) -- so honorable-mention rows can never be "present" and
will always resolve to attended=false. Confirmed this is v1's actual
historical behavior too (HM rows do get attended=false, never true, in
docs/v1/Data/event-picks-log.csv) rather than being left blank, so this
script updates all matching rows uniformly regardless of rank.
"""

import argparse
import csv
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common

EASTERN = ZoneInfo(common.CALENDAR_TIMEZONE)


def last_week_monday(target_monday: date) -> date:
    return target_monday - timedelta(days=7)


def fetch_calendar_titles(service, calendar_id: str, monday: date) -> set[str]:
    start = datetime.combine(monday, datetime.min.time(), tzinfo=EASTERN)
    end = start + timedelta(days=7)
    titles = set()
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
            summary = event.get("summary")
            if summary:
                titles.add(summary)
        page_token = result.get("nextPageToken")
        if not page_token:
            break
    return titles


def update_attendance(rows: list[dict], week_of: str, calendar_titles: set[str]) -> int:
    updated = 0
    for row in rows:
        if row["city"] == "Philadelphia" and row["week_of"] == week_of:
            row["attended"] = "true" if row["title"] in calendar_titles else "false"
            updated += 1
    return updated


def main():
    parser = argparse.ArgumentParser(
        description="Update attendance for last week's picks in the CSV log"
    )
    parser.add_argument(
        "--week-dir",
        type=Path,
        required=True,
        help="data/YYYY-MM-DD (the upcoming week being processed)",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    target_monday = date.fromisoformat(args.week_dir.name)
    week_of = last_week_monday(target_monday).isoformat()

    log_path = common.picks_log_path()
    if not log_path.exists():
        print(f"No picks log at {log_path}; nothing to check.")
        return

    with open(log_path, newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        rows = list(reader)

    matching = [r for r in rows if r["city"] == "Philadelphia" and r["week_of"] == week_of]
    if not matching:
        print(f"No Philadelphia rows for week_of={week_of}; skipping.")
        return

    service = common.get_calendar_service()
    calendar_id = common.get_calendar_id(service)
    calendar_titles = fetch_calendar_titles(
        service, calendar_id, last_week_monday(target_monday)
    )

    updated = update_attendance(rows, week_of, calendar_titles)
    attended_true = sum(
        1
        for r in rows
        if r["city"] == "Philadelphia" and r["week_of"] == week_of and r["attended"] == "true"
    )

    if args.dry_run:
        print(
            f"[dry-run] Would update {updated} rows for week_of={week_of} "
            f"({attended_true} attended, {updated - attended_true} not attended)."
        )
        return

    with open(log_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(
        f"Attendance check complete. {updated} rows updated for week_of={week_of} "
        f"({attended_true} attended, {updated - attended_true} not attended)."
    )


if __name__ == "__main__":
    main()
