#!/usr/bin/env python3
"""Appends a week's Top 3 picks and honorable mentions to
data/event-picks-log.csv, per CLAUDE.md's picks-log columns contract.

Idempotent on (week_of, title): re-running for a week already logged is a
no-op for rows that already exist. New rows get attended="" -- filled in
retrospectively by attendance_check.py on a later run (per CLAUDE.md's
attendance feedback loop), never guessed here.

price_tier inference (validated against the real archived week's rows in
docs/v1/Data/event-picks-log.csv, 2026-06-22 -- 30 rows cross-checked):
  - sold_out: true                       -> "paid"
  - cost is a *(...)* placeholder        -> ""      (unconfirmed; never guess)
  - cost is "free" / "no cover"          -> "free"
  - cost contains a $amount              -> "low" if < $15, else "paid"
  - anything else (no $ amount stated,
    e.g. "donation to store requested")  -> "free"  (no fixed price stated)

`tags` is always written blank. _selections.json carries no tag/theme data
for events (only category, source, cost, etc.) -- v1's tags column was
LLM-authored thematic judgment (e.g. "leftist", "punk", "cinematalk") with
nothing in the JSON schema to derive it from deterministically. Inventing
tags would mean guessing, which this pipeline avoids everywhere else.
"""

import argparse
import csv
import difflib
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common


def infer_price_tier(cost: str, sold_out: bool = False) -> str:
    if sold_out:
        return "paid"
    if common.is_placeholder_cost(cost):
        return ""
    cost = common.strip_placeholder_wrapper(cost)
    if not cost:
        return ""
    if common.is_free_cost(cost):
        return "free"
    match = re.search(r"\$(\d+(?:\.\d+)?)", cost)
    if match:
        return "low" if float(match.group(1)) < 15 else "paid"
    return "free"


def find_matching_event(mention: dict, events: list[dict]) -> dict:
    """honorable_mentions only carries {title, venue}; cost/sold_out/source
    have to come from the matching entry in the day's full events array.
    Usually an exact title match, but Selection sometimes writes the
    honorable-mention title slightly differently than the events-array
    entry for the same event (e.g. a "(SOLD OUT)" suffix added, or a
    subtitle inserted/dropped) -- confirmed on the real archived week
    (WILDWOOD, NJ..., Tommy Conwell...), so fall back to fuzzy title
    matching rather than silently losing category/source/price_tier."""
    for event in events:
        if event["title"] == mention["title"]:
            return event
    best, best_score = None, 0.0
    for event in events:
        score = difflib.SequenceMatcher(
            None, mention["title"].casefold(), event["title"].casefold()
        ).ratio()
        if score > best_score:
            best_score, best = score, event
    return best if best_score >= 0.6 else {}


def build_rows(selections: dict, spotify: dict) -> list[dict]:
    rows = []
    for day in selections["days"]:
        for pick in day["top3"]:
            spotify_entry = spotify.get(pick["title"]) if pick.get("is_music") else None
            rows.append(
                {
                    "city": "Philadelphia",
                    "week_of": selections["week"],
                    "day": day["day_name"],
                    "date": day["date"],
                    "title": pick["title"],
                    "venue": pick["venue"],
                    "category": common.CATEGORY_TO_CSV_SLUG.get(
                        pick["category"], pick["category"]
                    ),
                    "source": pick["source"],
                    "rank": str(pick["rank"]),
                    "price_tier": infer_price_tier(
                        pick.get("cost", ""), pick.get("sold_out", False)
                    ),
                    "spotify_link": spotify_entry["spotify_url"] if spotify_entry else "",
                    "tags": "",
                    "attended": "",
                }
            )

        for mention in day.get("honorable_mentions", []):
            event = find_matching_event(mention, day["events"])
            rows.append(
                {
                    "city": "Philadelphia",
                    "week_of": selections["week"],
                    "day": day["day_name"],
                    "date": day["date"],
                    "title": mention["title"],
                    "venue": mention["venue"],
                    "category": common.CATEGORY_TO_CSV_SLUG.get(
                        event.get("category"), event.get("category", "")
                    ),
                    "source": event.get("source", ""),
                    "rank": "HM",
                    "price_tier": infer_price_tier(
                        event.get("cost", ""), event.get("sold_out", False)
                    ),
                    "spotify_link": "",
                    "tags": "",
                    "attended": "",
                }
            )
    return rows


def load_existing_keys(path: Path) -> set[tuple[str, str]]:
    if not path.exists():
        return set()
    with open(path, newline="") as f:
        return {(row["week_of"], row["title"]) for row in csv.DictReader(f)}


def append_rows(path: Path, rows: list[dict]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    file_exists = path.exists()
    written = 0
    with open(path, "a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=common.PICKS_LOG_COLUMNS)
        if not file_exists:
            writer.writeheader()
        for row in rows:
            writer.writerow(row)
            written += 1
    return written


def main():
    parser = argparse.ArgumentParser(description="Append a week's picks to the picks log")
    parser.add_argument("week_dir", type=Path, help="data/YYYY-MM-DD")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    selections = common.load_selections(args.week_dir)
    spotify = common.load_spotify(args.week_dir)
    all_rows = build_rows(selections, spotify)

    log_path = common.picks_log_path()
    existing_keys = load_existing_keys(log_path)
    new_rows = [
        r for r in all_rows if (r["week_of"], r["title"]) not in existing_keys
    ]
    skipped = len(all_rows) - len(new_rows)

    if args.dry_run:
        print(
            f"[dry-run] Would append {len(new_rows)} rows to {log_path} "
            f"({skipped} already logged)."
        )
        return

    written = append_rows(log_path, new_rows)
    print(f"CSV log complete. {written} rows appended, {skipped} already logged.")


if __name__ == "__main__":
    main()
