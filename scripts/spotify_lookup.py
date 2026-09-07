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

import spotipy
from spotipy.oauth2 import SpotifyClientCredentials

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common

# Splits a compound listing title ("A w/ B, C" / "A & B" / "A -- subtitle")
# so every act in the bill can be tried, not just the piece before the
# first separator. Note: does NOT include ":" -- a leading "Subtitle: Act,
# Act2" prefix is handled separately below, since the act name follows the
# colon there, not precedes it (e.g. "Gothic night: Die Sexual, Ronnie
# Stone & DJ Baby Berlin" -> "Die Sexual", not "Gothic night"). Requires
# surrounding spaces on the symbol separators (+, x, /, |) so this never
# splits inside a real name like "AC/DC" or "BIG|BRAVE". The comma
# alternative also swallows an immediately-following connector word
# ("The Body, with BIG|BRAVE" -> "The Body" / "BIG|BRAVE", not a stray
# "with BIG|BRAVE" fragment).
_SEPARATOR_PATTERN = re.compile(
    r"\s*(?:,\s*(?:with\b|w/|and\b|&)?"
    r"| & | and | w/ | with | — | – | - | \+ | x | / | \| )\s*",
    re.IGNORECASE,
)

# Strips a trailing "@ Venue Name" suffix (not a separator -- the venue
# isn't a candidate act, so this is removed before splitting rather than
# split out as one).
_VENUE_SUFFIX_PATTERN = re.compile(r"\s+@\s+.*$")

# Trailing punctuation/whitespace noise ("!!!!!"). Deliberately excludes
# "." -- stripping periods would turn "M.I.A." into "M.I.A", which will
# never exact-match Spotify's real artist name.
_TRAILING_PUNCT_PATTERN = re.compile(r"[!?\s]+$")

# A trailing parenthetical, tried both kept ("Durex (mtl)", where the
# parenthetical disambiguates the act) and stripped ("SKEKSIS (RVA)" ->
# also try "SKEKSIS") -- some parens are load-bearing, some are just
# presenter/city noise, and there's no way to tell which without guessing.
_TRAILING_PAREN_PATTERN = re.compile(r"(?:\s*\([^()]*\))+$")

# DIY show flyers often list several acts back to back with no separator
# between them beyond a "(origin city)" tag on each ("VOIDHAMMER (LA) HARSH
# REALM (AVL) DIURETIC") -- the whitespace right after a closing paren, when
# followed by the start of another word, marks the boundary between two
# acts. Guarded on both sides: the negative lookahead defers to " with "/
# "w/"/" and "/"&" (a real connector, not a boundary -- "Foo (bar) with Baz"
# stays for _SEPARATOR_PATTERN to split cleanly into "Foo (bar)"/"Baz"
# rather than a stray "with Baz"), and requiring an alnum start defers to
# any symbol-led separator starting at the same whitespace ("(Denton) /
# Sweepers" stays for the "/" separator, not a stray "/ Sweepers").
_PAREN_BOUNDARY_PATTERN = re.compile(
    r"(?<=\))\s+(?!with\b|w/|and\b|&)(?=[A-Za-z0-9])", re.IGNORECASE
)

# A trailing ensemble-size word ("DoYeon Kim Quartet" -> also try "DoYeon
# Kim") -- jazz/classical listings often name the configuration, not just
# the artist. Deliberately excludes words like "Band"/"Orchestra" that are
# routinely part of a real Spotify act's exact name (e.g. "Dave Matthews
# Band" is its own distinct artist from "Dave Matthews") -- stripping those
# risks linking the wrong one.
_ENSEMBLE_SUFFIX_PATTERN = re.compile(
    r"\s+(?:Quartet|Trio|Duo|Quintet|Sextet|Septet|Ensemble)\s*$", re.IGNORECASE
)

# Bounds worst-case Spotify calls per pick (a long comma-separated bill).
_MAX_CANDIDATES = 8

# Generic words that full multi-segment splitting can produce as byproducts
# of boilerplate clauses ("... & More!" -> "More", "... Screening &
# Performance" -> "Screening"/"Performance"). These aren't real act names,
# and trying them risks an exact-name collision with an unrelated real
# Spotify artist -- a wrong link in a published report. Kept as a literal
# stop-list rather than a length/genericness heuristic, since real one-word
# act names in this project's data (e.g. "Ditch", "Bane", "Sediment") are
# just as short and must not be filtered.
_NOISE_CANDIDATES = frozenset(
    {
        "more",
        "and more",
        "screening",
        "performance",
        "benefit show",
        "special guests",
        "guests",
        "tba",
        "dj set",
        "and friends",
        "free",
    }
)


def candidate_names(title: str) -> list[str]:
    """Deterministic search candidates, most to least specific.

    Every act in a multi-act bill gets tried (not just one "headliner"),
    since candidate order determines which act wins -- find_spotify_match
    still returns on the first exact hit, and _spotify.json's schema only
    supports one linked act per pick. Order is preserved left-to-right as
    the acts appear in the title, so an earlier-listed act still wins ties,
    consistent with the previous single-headliner design intent.

    A colon splits titles both ways in practice ("Gothic night: Die Sexual,
    Ronnie Stone & DJ Baby Berlin" -- act list after the colon; "LAYER MEAT,
    SPECTRAL FORCES: A Benefit Show..." -- act list before it), so both
    sides are tried as candidates; exact-match is what keeps this safe.
    """
    title = title.strip()
    candidates = [title]

    def add(candidate: str) -> None:
        if (
            candidate
            and candidate.casefold() not in _NOISE_CANDIDATES
            and candidate not in candidates
        ):
            candidates.append(candidate)

    cleaned = _VENUE_SUFFIX_PATTERN.sub("", title)
    cleaned = _TRAILING_PUNCT_PATTERN.sub("", cleaned).strip()

    segments = [cleaned]
    if ":" in cleaned:
        before, after = cleaned.split(":", 1)
        segments = [before.strip(), after.strip()]

    for segment in segments:
        for chunk in _PAREN_BOUNDARY_PATTERN.split(segment):
            for piece in _SEPARATOR_PATTERN.split(chunk):
                piece = piece.strip()
                if not piece:
                    continue
                add(piece)
                variants = [piece]
                stripped = _TRAILING_PAREN_PATTERN.sub("", piece).strip()
                if stripped and stripped != piece:
                    add(stripped)
                    variants.append(stripped)
                for variant in variants:
                    suffix_stripped = _ENSEMBLE_SUFFIX_PATTERN.sub("", variant).strip()
                    if suffix_stripped and suffix_stripped != variant:
                        add(suffix_stripped)
                if len(candidates) >= _MAX_CANDIDATES:
                    return candidates[:_MAX_CANDIDATES]
    return candidates


def find_spotify_match(sp: spotipy.Spotify, title: str) -> dict | None:
    """Returns {"spotify_url": ..., "matched_text": ...} for the first
    candidate with an exact-name hit, or None. `matched_text` is the
    substring of `title` the renderer should wrap in the link -- not
    necessarily the whole title (see candidate_names)."""
    for candidate in candidate_names(title):
        try:
            result = sp.search(q=f'artist:"{candidate}"', type="artist", limit=5)
        except Exception as exc:  # noqa: BLE001 -- one candidate's search failing shouldn't skip the rest
            print(f"  Spotify search failed for {candidate!r}: {exc}", file=sys.stderr)
            continue
        items = result.get("artists", {}).get("items", [])
        # Check all returned results for an exact match, not just the top
        # one -- Spotify's own ranking can put a fuzzy/unrelated same-named
        # result above the real exact-name match. Still "never guess": this
        # only widens which of Spotify's own results counts, the exact-name
        # requirement itself is unchanged.
        for artist in items:
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


def main() -> None:
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
