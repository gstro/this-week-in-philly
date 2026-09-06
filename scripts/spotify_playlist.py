#!/usr/bin/env python3
"""Builds a public Spotify playlist from a week's Top 3 music picks.

Reads data/YYYY-MM-DD/_spotify.json (spotify_lookup.py's output) and
_selections.json, takes a handful of recent tracks for every matched artist,
and replaces the contents of a per-week playlist named "YYYY-MM-DD: This Week
in Philly" -- date first so that a truncated title in Spotify's sidebar still
sorts and reads chronologically. The playlist's id and URL are written to
data/YYYY-MM-DD/_playlist.json, which html_render.py reads to put a link in
the report header.

Runs between spotify_lookup.py and html_render.py in runner.sh: it needs the
former's artist matches, and the latter needs its URL.

Track source: an artist's most recent album or single's tracks, NOT their
"top tracks." That endpoint (GET /v1/artists/{id}/top-tracks) is what this
script was originally built against; it returned 403 for every artist tried
-- including a global megastar, under both Client Credentials and a fully
user-authorized token -- and Spotify's own reference page for it now reads
"Deprecated." Search's `track` results lost their `popularity` field in the
same pass, ruling out the other obvious replacement (search + sort by
popularity). artist_albums()/album_tracks() were verified working against
this project's actual 2026-09-07 matched artists (not just a celebrity) before
being adopted here -- see the PR discussion for the comparison. This may not
be the last such change; if artist_albums/album_tracks also go, the fallback
is the same shape (any endpoint returning track URIs for a known artist_id).

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

# Both artist_albums and album_tracks are market-scoped; without one, results
# can be incomplete or empty for an artist not licensed everywhere.
_MARKET = "US"

# How many of an artist's most recent albums/singles to consider before
# giving up on finding enough tracks. Plenty for --tracks-per-artist's
# default of 3 -- most artists fill that from their single latest release.
_ALBUMS_TO_CONSIDER = 10


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


def track_uris_for_artist(sp: spotipy.Spotify, artist_id: str, limit: int) -> list[str]:
    """Up to `limit` track URIs from an artist's most recent albums/singles,
    newest release first.

    include_groups="album,single" excludes compilations and "appears on"
    credits -- the latter would otherwise pull in tracks from tribute albums,
    festival samplers, etc. that don't represent the artist's own work.
    artist_albums' own result order isn't documented as guaranteed, so
    release_date is re-sorted client-side rather than trusted as-is; dates of
    mixed precision (a bare year vs a full YYYY-MM-DD) can sort slightly out
    of true order against each other, an accepted rough edge rather than a
    reason to hand-parse partial ISO dates none of this project's other code
    has needed to.

    An artist with zero albums/singles simply yields [] -- a normal outcome
    (handled by the caller topping up from other artists), not an error.
    Genuine API failures (auth, rate limit, a now-deprecated endpoint -- see
    the module docstring) are deliberately NOT caught here: they propagate to
    collect_track_uris, which stops immediately rather than repeating the
    same failure over every remaining artist.
    """
    albums = sp.artist_albums(
        artist_id, include_groups="album,single", country=_MARKET, limit=_ALBUMS_TO_CONSIDER
    )
    ordered = sorted(albums["items"], key=lambda a: a.get("release_date", ""), reverse=True)

    uris: list[str] = []
    seen: set[str] = set()
    for album in ordered:
        if len(uris) >= limit:
            break
        tracks = sp.album_tracks(album["id"], market=_MARKET, limit=limit)
        for track in tracks["items"]:
            if track["uri"] not in seen:
                seen.add(track["uri"])
                uris.append(track["uri"])
            if len(uris) >= limit:
                break
    return uris


def collect_track_uris(sp: spotipy.Spotify, artist_ids: list[str], limit: int) -> list[str]:
    """Track URIs for every matched artist, in order, concatenated.

    Deliberately no per-artist try/except: track_uris_for_artist raising
    means the underlying API call itself failed (not "this artist has no
    tracks," which is a normal empty list, not an exception) -- almost always
    something systemic (auth, rate limit, a dead endpoint) that will recur
    identically for every remaining artist. Stopping at the first failure
    turns what would otherwise be N nearly-identical stack traces in the logs
    into one, and hands the real error straight to main()'s catch-all rather
    than losing it under a wall of repeats.
    """
    uris: list[str] = []
    for artist_id in artist_ids:
        uris.extend(track_uris_for_artist(sp, artist_id, limit))
    return uris


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


def sync_playlist(
    sp: spotipy.Spotify,
    monday: date,
    uris: list[str],
    artist_count: int,
    stored_id: str | None = None,
) -> dict:
    """Find-or-create the week's playlist and replace its contents with
    `uris` (already resolved by collect_track_uris). Separated from track
    resolution so main() can run the (read-only, safe) resolution step under
    --dry-run without ever reaching these mutating calls."""
    name = playlist_name(monday)
    description = playlist_description(monday)

    user_id = sp.current_user()["id"]
    playlist_id = find_existing_playlist(sp, user_id, name, stored_id)
    if playlist_id:
        sp.playlist_change_details(playlist_id, name=name, description=description)
    else:
        # current_user_playlist_create, NOT user_playlist_create: the latter
        # posts to POST /users/{user_id}/playlists, which Spotify's February
        # 2026 Development Mode changes removed outright in favor of
        # POST /me/playlists (spotipy's own docstring already flags
        # user_playlist_create as deprecated, for the same reason, though not
        # by that date). Confirmed directly: the old path 403s with no detail
        # regardless of scope, token freshness, or Spotify Developer
        # Dashboard User Management state -- all things this bug's error
        # message could easily be, and none of which it actually was.
        created = sp.current_user_playlist_create(
            name, public=True, description=description
        )
        playlist_id = created["id"]

    set_playlist_tracks(sp, playlist_id, uris)

    return {
        "name": name,
        "playlist_id": playlist_id,
        "playlist_url": f"https://open.spotify.com/playlist/{playlist_id}",
        "artist_count": artist_count,
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
        help="Recent tracks to take per matched artist (default: 3)",
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

    # Every Spotify-facing failure is non-fatal on purpose: an expired refresh
    # token, a dead endpoint, or an outage must not stop the report from
    # rendering and publishing. Same shape as calendar_create.py's past-week
    # skip -- say why loudly, exit 0, let the rest of runner.sh proceed.
    # html_render.py treats a missing _playlist.json as "no link", so the
    # report simply omits it.
    #
    # Track resolution happens here, inside this try, for BOTH --dry-run and
    # a real run -- it's read-only, so --dry-run gains nothing by skipping
    # it, and skipping it is exactly how an earlier version of this script
    # passed --dry-run against a now-deprecated endpoint with a clean "would
    # sync N tracks" message that a real run then couldn't back up at all.
    try:
        sp = common.get_spotify_user_client()
        uris = collect_track_uris(sp, artist_ids, args.tracks_per_artist)
    except Exception as exc:  # noqa: BLE001 -- must not block the report; see above
        print(
            f"spotify_playlist: SKIPPING playlist build -- {exc}\n"
            f"  The report will render without a playlist link.",
            file=sys.stderr,
        )
        return

    # Zero tracks from a non-empty artist list means every lookup failed to
    # turn up anything (or collect_track_uris would have raised already on a
    # hard API error) -- not that the week has no music. Replacing with []
    # would CLEAR an existing playlist and then publish a report linking to
    # it, so refuse instead of proceeding.
    if not uris:
        print(
            f"spotify_playlist: SKIPPING playlist build -- no tracks found for "
            f"any of {len(artist_ids)} matched artist(s).\n"
            f"  The report will render without a playlist link.",
            file=sys.stderr,
        )
        return

    if args.dry_run:
        print(
            f"[dry-run] Would sync playlist {playlist_name(monday)!r} with "
            f"{len(uris)} tracks from {len(artist_ids)} artists."
        )
        return

    stored_id = common.load_playlist(args.week_dir).get("playlist_id")
    try:
        result = sync_playlist(sp, monday, uris, len(artist_ids), stored_id)
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
