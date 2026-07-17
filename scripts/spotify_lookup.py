#!/usr/bin/env python3
"""Batch Spotify artist lookup for a week's Top 3 music picks.

Reads data/YYYY-MM-DD/_selections.json, looks up a Spotify artist page for
every Top 3 pick with is_music: true, and writes data/YYYY-MM-DD/_spotify.json
as {title: {"spotify_url": ..., "matched_text": ...} | null}. `matched_text`
is the substring of the title that should be hyperlinked -- often not the
whole title (e.g. "Die Sexual" within "Gothic night: Die Sexual, Ronnie
Stone & DJ Baby Berlin"). Non-music picks and honorable mentions are not
looked up (per events-report-format/SKILL.md, Spotify linking only applies
to Top 3 music acts).

No-match -> null, never guess: only an exact (casefolded) artist-name match
against a Spotify search result counts as a hit.
"""

import argparse
import concurrent.futures
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common

# Splits a compound listing title ("A w/ B, C" / "A & B" / "A -- subtitle")
# so a clean headliner name can still be tried after the full title fails.
# Note: does NOT include ":" -- a leading "Subtitle: Act, Act2" prefix is
# handled separately below, since the act name follows the colon there,
# not precedes it (e.g. "Gothic night: Die Sexual, Ronnie Stone & DJ Baby
# Berlin" -> "Die Sexual", not "Gothic night").
_SEPARATOR_PATTERN = re.compile(
    r"\s*(?:,| & | and | w/ | with | — | – | - )\s*", re.IGNORECASE
)


def candidate_names(title: str) -> list[str]:
    """Deterministic search candidates, most to least specific.

    Only a single (headliner) candidate is ever extracted beyond the full
    title -- titles that list multiple Spotify-matchable acts (e.g. a
    three-act bill) will only ever get one linked. This is an accepted
    simplification versus v1, where an LLM could link several acts within
    one title; scripting that generically without guessing isn't feasible.

    A colon splits titles both ways in practice ("Gothic night: Die Sexual,
    Ronnie Stone & DJ Baby Berlin" -- act list after the colon; "LAYER MEAT,
    SPECTRAL FORCES: A Benefit Show..." -- act list before it), so both
    sides are tried as candidates; exact-match is what keeps this safe.
    """
    title = title.strip()
    candidates = [title]
    segments = [title]
    if ":" in title:
        before, after = title.split(":", 1)
        segments = [before.strip(), after.strip()]
    for segment in segments:
        head = _SEPARATOR_PATTERN.split(segment, maxsplit=1)[0].strip()
        if head and head not in candidates:
            candidates.append(head)
    return candidates


def find_spotify_match(sp, title: str) -> dict | None:
    """Returns {"spotify_url": ..., "matched_text": ...} for the first
    candidate with an exact-name hit, or None. `matched_text` is the
    substring of `title` the renderer should wrap in the link -- not
    necessarily the whole title (see candidate_names)."""
    for candidate in candidate_names(title):
        try:
            result = sp.search(q=f'artist:"{candidate}"', type="artist", limit=1)
        except Exception as exc:
            print(f"  Spotify search failed for {candidate!r}: {exc}", file=sys.stderr)
            continue
        items = result.get("artists", {}).get("items", [])
        if not items:
            continue
        artist = items[0]
        if artist["name"].strip().casefold() == candidate.casefold():
            return {
                "spotify_url": artist["external_urls"]["spotify"],
                "matched_text": candidate,
            }
    return None


def music_titles(selections: dict) -> list[str]:
    titles = []
    for day in selections["days"]:
        for pick in day["top3"]:
            if pick.get("is_music"):
                titles.append(pick["title"])
    return titles


def main():
    parser = argparse.ArgumentParser(
        description="Batch Spotify artist lookup for a week's Top 3 music picks"
    )
    parser.add_argument("week_dir", type=Path, help="data/YYYY-MM-DD")
    parser.add_argument("--max-workers", type=int, default=5)
    args = parser.parse_args()

    selections = common.load_selections(args.week_dir)
    titles = music_titles(selections)

    if not titles:
        out_path = Path(args.week_dir) / "_spotify.json"
        with open(out_path, "w") as f:
            json.dump({}, f, indent=2)
        print("Spotify lookup complete. 0 matched, 0 not found (no music picks).")
        return

    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not client_id or not client_secret:
        print(
            "Missing SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET env vars.",
            file=sys.stderr,
        )
        sys.exit(1)

    import spotipy
    from spotipy.oauth2 import SpotifyClientCredentials

    sp = spotipy.Spotify(
        auth_manager=SpotifyClientCredentials(
            client_id=client_id, client_secret=client_secret
        )
    )

    results: dict[str, dict | None] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as executor:
        future_to_title = {
            executor.submit(find_spotify_match, sp, title): title for title in titles
        }
        for future in concurrent.futures.as_completed(future_to_title):
            title = future_to_title[future]
            results[title] = future.result()

    matched = sum(1 for v in results.values() if v)
    not_found = len(results) - matched

    out_path = Path(args.week_dir) / "_spotify.json"
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False, sort_keys=True)

    print(f"Spotify lookup complete. {matched} matched, {not_found} not found.")


if __name__ == "__main__":
    main()
