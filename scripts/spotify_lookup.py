#!/usr/bin/env python3
"""Batch Spotify artist lookup for every music act in a week's report.

Reads data/YYYY-MM-DD/_selections.json, looks up Spotify artist pages for
every music event in the report (common.music_events: Top 3 picks by their
is_music flag, everything else by the Music & Concerts category), and writes
data/YYYY-MM-DD/_spotify.json as

    {title: {"spotify_url": ..., "matched_text": ...,
             "artists": [{"spotify_url": ..., "matched_text": ...}, ...]}
            | null}

`artists` holds every act on the bill that matched, in the order they're
listed. `spotify_url`/`matched_text` repeat its first entry and are what
html_render.py links -- the report still links one act per Top 3 pick, and
non-Top 3 entries exist only for spotify_playlist.py. `matched_text` is the
substring of the title that should be hyperlinked -- often not the whole
title (e.g. "Die Sexual" within "Gothic night: Die Sexual, Ronnie Stone & DJ
Baby Berlin"). Files written before `artists` existed lack it; readers fall
back to the top-level pair.

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

# Bounds worst-case Spotify calls per title (a long comma-separated bill).
# Every act on a bill is looked up now, not just the first hit, so this has
# to cover a real seven-act hardcore bill plus its variants -- 8 (the
# single-headliner era's value) cut those off partway.
_MAX_CANDIDATES = 20

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


def candidate_groups(title: str) -> list[list[str]]:
    """Deterministic search candidates, grouped by act, most to least
    specific within each group.

    Group 0 is always the full title on its own. Every later group is one
    act from the bill, left to right as listed, with its fallback variants
    (trailing parenthetical stripped, ensemble-size word stripped) after the
    act as written -- find_spotify_matches takes the first hit per group, so
    "SKEKSIS (RVA)" is preferred over "SKEKSIS" when both exist, and a match
    never produces a second link for the same act.

    A colon splits titles both ways in practice ("Gothic night: Die Sexual,
    Ronnie Stone & DJ Baby Berlin" -- act list after the colon; "LAYER MEAT,
    SPECTRAL FORCES: A Benefit Show..." -- act list before it), so both
    sides are tried as candidates; exact-match is what keeps this safe.

    A candidate already seen in an earlier group is dropped, and the total
    across all groups is capped at _MAX_CANDIDATES.
    """
    title = title.strip()
    groups = [[title]]
    seen = {title}
    count = 1

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
                variants = [piece]
                stripped = _TRAILING_PAREN_PATTERN.sub("", piece).strip()
                if stripped and stripped != piece:
                    variants.append(stripped)
                for variant in list(variants):
                    suffix_stripped = _ENSEMBLE_SUFFIX_PATTERN.sub("", variant).strip()
                    if suffix_stripped and suffix_stripped != variant:
                        variants.append(suffix_stripped)

                group = []
                for variant in variants:
                    if variant.casefold() in _NOISE_CANDIDATES or variant in seen:
                        continue
                    seen.add(variant)
                    group.append(variant)
                if not group:
                    continue
                group = group[: _MAX_CANDIDATES - count]
                groups.append(group)
                count += len(group)
                if count >= _MAX_CANDIDATES:
                    return groups
    return groups


def _exact_match_url(sp: spotipy.Spotify, candidate: str) -> str | None:
    try:
        result = sp.search(q=f'artist:"{candidate}"', type="artist", limit=5)
    except Exception as exc:  # noqa: BLE001 -- one candidate's search failing shouldn't skip the rest
        print(f"  Spotify search failed for {candidate!r}: {exc}", file=sys.stderr)
        return None
    items = result.get("artists", {}).get("items", [])
    # Check all returned results for an exact match, not just the top one --
    # Spotify's own ranking can put a fuzzy/unrelated same-named result above
    # the real exact-name match. Still "never guess": this only widens which
    # of Spotify's own results counts, the exact-name requirement itself is
    # unchanged.
    #
    # When several results match exactly (name clashes: there are at least two
    # artists named "Lee Fields"), Spotify's order drifts between runs, so
    # taking the first would flip the link run to run. Pick the one with the
    # most followers instead. `followers` may be absent -- Spotify's 2026 API
    # changes removed `popularity` from track results and it's unverified that
    # artist `followers` survives -- in which case every key is -1 and max()
    # keeps the first, i.e. Spotify's order, exactly as before the tie-break.
    exact = [a for a in items if a["name"].strip().casefold() == candidate.casefold()]
    if not exact:
        return None
    if len(exact) == 1:
        return exact[0]["external_urls"]["spotify"]

    def followers(artist: dict) -> int:
        total = (artist.get("followers") or {}).get("total")
        return -1 if total is None else total

    chosen = max(exact, key=followers)
    url = chosen["external_urls"]["spotify"]
    print(
        f"  {len(exact)} exact matches for {candidate!r}; chose {url} ({followers(chosen)} followers)",
        file=sys.stderr,
    )
    return url


def find_spotify_matches(sp: spotipy.Spotify, title: str) -> list[dict]:
    """[{"spotify_url": ..., "matched_text": ...}, ...] -- one per act on the
    bill that exact-matched, in listed order, deduped by URL. `matched_text`
    is the substring of `title` the renderer should wrap in the link.

    If the full title itself is an exact artist name, that is the only
    match: "Simon & Garfunkel" is one act, and splitting it would add two
    others that merely share the words.
    """
    groups = candidate_groups(title)
    matches: list[dict] = []
    seen_urls: set[str] = set()
    for index, group in enumerate(groups):
        for candidate in group:
            url = _exact_match_url(sp, candidate)
            if url:
                if url not in seen_urls:
                    seen_urls.add(url)
                    matches.append({"spotify_url": url, "matched_text": candidate})
                break
        if index == 0 and matches:
            return matches
    return matches


def spotify_entry(matches: list[dict]) -> dict | None:
    """The _spotify.json value for one title (see the module docstring)."""
    if not matches:
        return None
    return {**matches[0], "artists": matches}


def music_titles(selections: dict) -> list[str]:
    """Every music event title in the report, deduped, in report order."""
    return list(dict.fromkeys(title for title, _ in common.music_events(selections)))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Batch Spotify artist lookup for every music act in a week's report"
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
        print("Spotify lookup complete. 0 matched, 0 not found (no music events).")
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
            executor.submit(find_spotify_matches, sp, title): title for title in titles
        }
        for future in concurrent.futures.as_completed(future_to_title):
            title = future_to_title[future]
            results[title] = spotify_entry(future.result())

    matched = sum(1 for v in results.values() if v)
    not_found = len(results) - matched
    artists = sum(len(v["artists"]) for v in results.values() if v)

    out_path = Path(args.week_dir) / "_spotify.json"
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False, sort_keys=True)

    print(
        f"Spotify lookup complete. {matched} matched ({artists} artists), "
        f"{not_found} not found."
    )


if __name__ == "__main__":
    main()
