#!/usr/bin/env python3
"""Builds a public Spotify playlist from a week's Top 3 music picks.

Reads data/YYYY-MM-DD/_spotify.json (spotify_lookup.py's output) and
_selections.json, takes the top N tracks for every matched artist, and
replaces the contents of a per-week playlist named
"YYYY-MM-DD: This Week in Philly" -- date first so that a truncated title in
Spotify's sidebar still sorts and reads chronologically. The playlist's id and
URL are written to data/YYYY-MM-DD/_playlist.json, which html_render.py reads
to put a link in the report header.

Runs between spotify_lookup.py and html_render.py in runner.sh: it needs the
former's artist matches, and the latter needs its URL.

Auth is NOT spotify_lookup.py's. That script uses Client Credentials, which
is app-only and cannot touch a user's playlists; this one uses the
user-authorized client from common.get_spotify_user_client(). See
scripts/spotify_oauth_bootstrap.py for the one-time consent step.

Idempotency, and why it matters here specifically: presentation.yml fires on
any push to a _selection_annotations.json, backfills of historical weeks
included -- that is exactly the shape that caused the 2026-08-23 calendar
incident (see calendar_create.py's docstring). So a re-run must converge, not
accumulate: the playlist is looked up by stored id, then by exact name, and
only created if neither hits, and its tracks are *replaced* rather than
appended.

Unlike calendar_create.py there is deliberately no past-week guard. That
guard exists to protect the attendance signal, which lives in the presence or
absence of calendar entries; a playlist carries no such signal, so rebuilding
a past week's playlist destroys nothing, and a guard would only block
legitimate backfill re-renders.

Two inherited scope limits, both from _spotify.json rather than from here:
it covers Top 3 music picks only (honorable-mention acts contribute no
tracks), and it holds one matched artist per title, so a multi-act bill
contributes only its headliner. Widening either means changing
spotify_lookup.py's matching, not this script.
"""

import argparse
import json
import sys
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

import spotipy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common

REPORT_BASE_URL = "https://gstro.github.io/this-week-in-philly/weeks"

# Spotify's playlist-items endpoints cap each call at 100 URIs.
_MAX_ITEMS_PER_CALL = 100

# artist_top_tracks is market-scoped; without a market it returns nothing.
_MARKET = "US"


def playlist_name(monday: date) -> str:
    """Date first, deliberately: Spotify truncates playlist titles in the
    sidebar and in shared cards, and a leading ISO date keeps a truncated
    title both sortable and readable."""
    return f"{monday.isoformat()}: This Week in Philly"


def playlist_description(monday: date) -> str:
    sunday = common.week_dates(monday)[-1]
    return (
        f"Top 3 music picks for {monday:%B %-d}-{sunday:%-d}, {sunday.year}. "
        f"{REPORT_BASE_URL}/{monday.isoformat()}.html"
    )


def artist_id_from_url(url: str) -> str | None:
    """Pulls the id out of an open.spotify.com/artist/<id> URL.

    Parsing beats adding an `artist_id` field to _spotify.json: the schema
    stays as spotify_lookup.py and html_render.py already know it, and every
    week already on disk works unchanged.
    """
    parts = [p for p in urlparse(url or "").path.split("/") if p]
    if len(parts) >= 2 and parts[-2] == "artist":
        return parts[-1]
    return None


def matched_artist_ids(selections: dict, spotify: dict) -> list[str]:
    """Artist ids for the week's matched music picks, in the order they appear
    in the report (day, then rank), deduped.

    Iterating _selections.json rather than _spotify.json's keys is what makes
    the playlist run chronologically through the week -- spotify_lookup.py
    writes its output sorted by title, which would otherwise scramble it.
    """
    ids: list[str] = []
    seen: set[str] = set()
    for day in selections["days"]:
        for pick in day["top3"]:
            if not pick.get("is_music"):
                continue
            entry = spotify.get(pick["title"])
            if not entry:
                continue
            artist_id = artist_id_from_url(entry.get("spotify_url", ""))
            if artist_id and artist_id not in seen:
                seen.add(artist_id)
                ids.append(artist_id)
    return ids


def top_track_uris(sp: spotipy.Spotify, artist_id: str, limit: int) -> list[str]:
    """Up to `limit` of an artist's top tracks. A failure for one artist is
    printed and skipped rather than losing the whole playlist."""
    try:
        result = sp.artist_top_tracks(artist_id, country=_MARKET)
    except Exception as exc:  # noqa: BLE001 -- one artist failing shouldn't sink the rest
        print(f"  Top-tracks lookup failed for artist {artist_id}: {exc}", file=sys.stderr)
        return []
    return [track["uri"] for track in result.get("tracks", [])[:limit]]


def find_existing_playlist(sp: spotipy.Spotify, user_id: str, name: str, stored_id: str | None) -> str | None:
    """The stored id first, then an exact name match among the user's own
    playlists, then None.

    The name-search fallback is not redundant. _playlist.json is committed by
    presentation.yml, but a run whose push fails -- or any run before that
    commit step was added -- leaves a real playlist with no record of it. On
    the id path, a playlist Greg deleted by hand returns 404 and must fall
    through to creation rather than crashing the step.
    """
    if stored_id:
        try:
            # No `fields` filter on purpose: Spotify's filter syntax drills
            # into nested objects with parentheses (`owner(id)`), not dots, and
            # a wrong filter yields a response with no `owner` key at all --
            # which would KeyError into the except below and silently demote
            # this path to the name scan on every single run. One playlist
            # object is cheap; the footgun isn't.
            playlist = sp.playlist(stored_id)
            if playlist["owner"]["id"] == user_id:
                return playlist["id"]
        except Exception as exc:  # noqa: BLE001 -- deleted/unreachable playlist falls through to name search
            print(f"  Stored playlist {stored_id} unusable ({exc}); searching by name.")

    results = sp.current_user_playlists(limit=50)
    while results:
        for playlist in results.get("items", []):
            if playlist["name"] == name and playlist["owner"]["id"] == user_id:
                return playlist["id"]
        results = sp.next(results) if results.get("next") else None
    return None


def set_playlist_tracks(sp: spotipy.Spotify, playlist_id: str, uris: list[str]) -> None:
    """Replace, never append -- a re-run must converge, not accumulate.

    The first call is items_replace (which also clears a playlist when `uris`
    is empty); any overflow past Spotify's 100-per-call cap is appended after
    it. The current week's shape (~8 artists x 3 tracks) is nowhere near that,
    but chunking here costs nothing and removes a silent cliff.
    """
    sp.playlist_replace_items(playlist_id, uris[:_MAX_ITEMS_PER_CALL])
    for start in range(_MAX_ITEMS_PER_CALL, len(uris), _MAX_ITEMS_PER_CALL):
        sp.playlist_add_items(playlist_id, uris[start : start + _MAX_ITEMS_PER_CALL])


def build_playlist(
    sp: spotipy.Spotify,
    monday: date,
    artist_ids: list[str],
    tracks_per_artist: int,
    stored_id: str | None = None,
) -> dict:
    name = playlist_name(monday)
    description = playlist_description(monday)

    uris: list[str] = []
    for artist_id in artist_ids:
        uris.extend(top_track_uris(sp, artist_id, tracks_per_artist))

    # Zero tracks from a non-empty artist list means every top-tracks lookup
    # failed (rate limit, outage) -- not that the week has no music. Replacing
    # with [] there would CLEAR an existing playlist and then publish a report
    # linking to it. top_track_uris swallows per-artist failures by design, so
    # this is the only place that total failure is distinguishable.
    if not uris:
        raise RuntimeError(
            f"No tracks resolved for any of {len(artist_ids)} matched artist(s) -- "
            "refusing to replace the playlist with an empty one"
        )

    user_id = sp.current_user()["id"]
    playlist_id = find_existing_playlist(sp, user_id, name, stored_id)
    if playlist_id:
        sp.playlist_change_details(playlist_id, name=name, description=description)
    else:
        created = sp.user_playlist_create(
            user_id, name, public=True, description=description
        )
        playlist_id = created["id"]

    set_playlist_tracks(sp, playlist_id, uris)

    return {
        "name": name,
        "playlist_id": playlist_id,
        "playlist_url": f"https://open.spotify.com/playlist/{playlist_id}",
        "artist_count": len(artist_ids),
        "track_count": len(uris),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a public Spotify playlist from a week's Top 3 music picks"
    )
    parser.add_argument("week_dir", type=Path, help="data/YYYY-MM-DD")
    parser.add_argument(
        "--tracks-per-artist",
        type=int,
        default=3,
        help="Top tracks to take per matched artist (default: 3)",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    selections = common.load_selections(args.week_dir)
    spotify = common.load_spotify(args.week_dir)
    monday = date.fromisoformat(selections["days"][0]["date"])
    artist_ids = matched_artist_ids(selections, spotify)

    if not artist_ids:
        print("No matched music artists this week; no playlist to build.")
        return

    if args.dry_run:
        print(
            f"[dry-run] Would sync playlist {playlist_name(monday)!r} with "
            f"up to {len(artist_ids) * args.tracks_per_artist} tracks from "
            f"{len(artist_ids)} artists."
        )
        return

    stored_id = common.load_playlist(args.week_dir).get("playlist_id")

    # Every Spotify-facing failure is non-fatal on purpose: an expired refresh
    # token or a Spotify outage must not stop the report from rendering and
    # publishing. Same shape as calendar_create.py's past-week skip -- say why
    # loudly, exit 0, let the rest of runner.sh proceed. html_render.py treats
    # a missing _playlist.json as "no link", so the report simply omits it.
    try:
        sp = common.get_spotify_user_client()
        result = build_playlist(
            sp, monday, artist_ids, args.tracks_per_artist, stored_id
        )
    except Exception as exc:  # noqa: BLE001 -- must not block the report; see above
        print(
            f"spotify_playlist: SKIPPING playlist build -- {exc}\n"
            f"  The report will render without a playlist link.",
            file=sys.stderr,
        )
        return

    out_path = Path(args.week_dir) / "_playlist.json"
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(
        f"Playlist synced. {result['track_count']} tracks from "
        f"{result['artist_count']} artists: {result['playlist_url']}"
    )


if __name__ == "__main__":
    main()
