"""Tests for scripts/spotify_playlist.py.

Everything that touches Spotify takes `sp` as a parameter, so it's tested
against a fake client rather than the network -- the same approach
test_spotify_lookup.py uses for find_spotify_match.

The fake records every mutating call, because the properties that matter here
are behavioural, not return-value: that a re-run *replaces* rather than
appends (the 2026-08-23 duplicate-write shape), that a stored id is preferred
over a name search, and that a deleted playlist falls through to creation
instead of raising.

Track source note: this originally targeted GET /v1/artists/{id}/top-tracks.
That endpoint 403'd for every artist tried the first time this ran for real
(including a global megastar, under both auth flows) and is now marked
Deprecated on Spotify's own reference page -- see spotify_playlist.py's
module docstring. FakeSpotify below models artist_albums/album_tracks
instead, verified against this project's real 2026-09-07 matched artists
before being adopted (not just a celebrity, whose results turned out not to
be representative of the small DIY acts this pipeline actually surfaces).
test_track_source_endpoints_still_work is the one test in this file that
hits the real network (network-marked, excluded by default) -- specifically
to catch it if Spotify deprecates this source too.
"""

import os
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import spotify_playlist as sp_mod


def _album(album_id: str, release_date: str, album_type: str = "album") -> dict:
    return {"id": album_id, "release_date": release_date, "album_type": album_type}


def _track(uri: str) -> dict:
    return {"uri": uri}


class FakeSpotify:
    """Minimal stand-in for the spotipy client surface this script uses."""

    def __init__(
        self,
        user_id: str = "greg",
        playlists: list[dict] | None = None,
        albums_by_artist: dict[str, list[dict]] | None = None,
        tracks_by_album: dict[str, list[dict]] | None = None,
    ) -> None:
        self.user_id = user_id
        self.playlists = playlists or []
        self.albums_by_artist = albums_by_artist or {}
        self.tracks_by_album = tracks_by_album or {}
        self.replaced: list[tuple[str, list[str]]] = []
        self.added: list[tuple[str, list[str]]] = []
        self.created: list[dict] = []
        self.details_changed: list[dict] = []

    def current_user(self) -> dict:
        return {"id": self.user_id}

    def artist_albums(
        self,
        artist_id: str,
        album_type: str | None = None,
        include_groups: str | None = None,
        country: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        return {"items": self.albums_by_artist.get(artist_id, [])}

    def album_tracks(
        self, album_id: str, limit: int = 50, offset: int = 0, market: str | None = None
    ) -> dict:
        return {"items": self.tracks_by_album.get(album_id, [])[:limit]}

    def playlist(self, playlist_id: str, fields: str | None = None) -> dict:
        for playlist in self.playlists:
            if playlist["id"] == playlist_id:
                return playlist
        raise RuntimeError(f"404 playlist {playlist_id} not found")

    def current_user_playlists(self, limit: int = 50) -> dict:
        return {"items": self.playlists, "next": None}

    def next(self, result: dict) -> dict | None:
        return None

    def current_user_playlist_create(
        self, name: str, public: bool = True, collaborative: bool = False, description: str = ""
    ) -> dict:
        # POST /me/playlists -- not user_playlist_create's POST
        # /users/{user_id}/playlists, which Spotify's February 2026
        # Development Mode changes removed. See sync_playlist's comment.
        created = {
            "id": f"new-{len(self.created)}",
            "name": name,
            "owner": {"id": self.user_id},
            "public": public,
            "description": description,
        }
        self.created.append(created)
        self.playlists.append(created)
        return created

    def playlist_change_details(
        self, playlist_id: str, name: str = "", description: str = ""
    ) -> None:
        self.details_changed.append(
            {"id": playlist_id, "name": name, "description": description}
        )

    def playlist_replace_items(self, playlist_id: str, uris: list[str]) -> None:
        self.replaced.append((playlist_id, list(uris)))

    def playlist_add_items(self, playlist_id: str, uris: list[str]) -> None:
        self.added.append((playlist_id, list(uris)))


def _owned(playlist_id: str, name: str, user_id: str = "greg") -> dict:
    return {"id": playlist_id, "name": name, "owner": {"id": user_id}}


# --- playlist_name ---


def test_playlist_name_puts_the_date_first_for_sortable_truncation() -> None:
    assert sp_mod.playlist_name(date(2026, 9, 7)) == "2026-09-07: This Week in Philly"


# --- playlist_description ---


def test_playlist_description_spans_monday_to_sunday_and_links_the_report() -> None:
    description = sp_mod.playlist_description(date(2026, 9, 7))
    assert "September 7-13, 2026" in description
    assert description.endswith("/weeks/2026-09-07.html")


# --- artist_id_from_url ---


def test_artist_id_from_url_extracts_the_id() -> None:
    url = "https://open.spotify.com/artist/6G8LVRZv0VxPuLwSQfVkEb"
    assert sp_mod.artist_id_from_url(url) == "6G8LVRZv0VxPuLwSQfVkEb"


@pytest.mark.parametrize(
    "url",
    [
        "",
        "https://open.spotify.com/album/6G8LVRZv0VxPuLwSQfVkEb",
        "https://open.spotify.com/artist/",
        "not a url",
    ],
)
def test_artist_id_from_url_returns_none_for_non_artist_urls(url: str) -> None:
    assert sp_mod.artist_id_from_url(url) is None


# --- matched_artist_ids ---


def _selections(*days: list[dict]) -> dict:
    return {
        "days": [
            {"date": f"2026-09-0{i + 7}", "top3": picks}
            for i, picks in enumerate(days)
        ]
    }


def _pick(title: str, is_music: bool = True) -> dict:
    return {"title": title, "is_music": is_music}


def test_matched_artist_ids_follows_report_order_not_spotify_json_order() -> None:
    selections = _selections([_pick("Monday Act")], [_pick("Tuesday Act")])
    # _spotify.json is written sort_keys=True, so its own iteration order is
    # alphabetical -- "Monday" after... nothing here, so build the reversed
    # case explicitly to prove day order wins over dict order.
    spotify = {
        "Tuesday Act": {"spotify_url": "https://open.spotify.com/artist/bbb"},
        "Monday Act": {"spotify_url": "https://open.spotify.com/artist/aaa"},
    }
    assert sp_mod.matched_artist_ids(selections, spotify) == ["aaa", "bbb"]


def test_matched_artist_ids_skips_non_music_and_unmatched_picks() -> None:
    selections = _selections(
        [
            _pick("A Band"),
            _pick("A Film Screening", is_music=False),
            _pick("No Match Band"),
        ]
    )
    spotify = {
        "A Band": {"spotify_url": "https://open.spotify.com/artist/aaa"},
        "A Film Screening": {"spotify_url": "https://open.spotify.com/artist/zzz"},
        "No Match Band": None,
    }
    assert sp_mod.matched_artist_ids(selections, spotify) == ["aaa"]


def test_matched_artist_ids_dedupes_an_artist_playing_twice_in_a_week() -> None:
    selections = _selections([_pick("Band at Venue A")], [_pick("Band at Venue B")])
    spotify = {
        "Band at Venue A": {"spotify_url": "https://open.spotify.com/artist/aaa"},
        "Band at Venue B": {"spotify_url": "https://open.spotify.com/artist/aaa"},
    }
    assert sp_mod.matched_artist_ids(selections, spotify) == ["aaa"]


# --- track_uris_for_artist ---


def test_track_uris_for_artist_takes_from_the_newest_release_first() -> None:
    sp = FakeSpotify(
        albums_by_artist={
            "aaa": [
                _album("old", "2020-01-01"),
                _album("new", "2026-05-08"),
            ]
        },
        tracks_by_album={
            "old": [_track("uri:old1")],
            "new": [_track("uri:new1"), _track("uri:new2")],
        },
    )
    assert sp_mod.track_uris_for_artist(sp, "aaa", 3) == ["uri:new1", "uri:new2", "uri:old1"]


def test_track_uris_for_artist_does_not_trust_artist_albums_result_order() -> None:
    """artist_albums' own ordering isn't documented as guaranteed, so the
    newest-first behavior must come from re-sorting by release_date, not from
    relying on whatever order the API happens to return."""
    sp = FakeSpotify(
        albums_by_artist={
            "aaa": [
                _album("new", "2026-05-08"),  # returned FIRST by the fake API
                _album("old", "2020-01-01"),
            ]
        },
        tracks_by_album={
            "old": [_track("uri:old1")],
            "new": [_track("uri:new1")],
        },
    )
    assert sp_mod.track_uris_for_artist(sp, "aaa", 2) == ["uri:new1", "uri:old1"]


def test_track_uris_for_artist_returns_empty_for_an_artist_with_no_albums() -> None:
    """No albums/singles is a normal outcome, not an error -- distinct from
    an API call raising, which collect_track_uris treats very differently."""
    sp = FakeSpotify()
    assert sp_mod.track_uris_for_artist(sp, "no-releases", 3) == []


def test_track_uris_for_artist_stops_once_the_limit_is_reached() -> None:
    sp = FakeSpotify(
        albums_by_artist={"aaa": [_album("a", "2026-01-01")]},
        tracks_by_album={"a": [_track(f"uri:{i}") for i in range(10)]},
    )
    assert sp_mod.track_uris_for_artist(sp, "aaa", 3) == ["uri:0", "uri:1", "uri:2"]


def test_track_uris_for_artist_dedupes_a_track_repeated_across_releases() -> None:
    sp = FakeSpotify(
        albums_by_artist={
            "aaa": [_album("single", "2026-05-08"), _album("album", "2026-01-01")]
        },
        tracks_by_album={
            "single": [_track("uri:shared")],
            "album": [_track("uri:shared"), _track("uri:unique")],
        },
    )
    assert sp_mod.track_uris_for_artist(sp, "aaa", 3) == ["uri:shared", "uri:unique"]


# --- collect_track_uris ---


def test_collect_track_uris_concatenates_across_artists_in_order() -> None:
    sp = FakeSpotify(
        albums_by_artist={
            "aaa": [_album("a", "2026-01-01")],
            "bbb": [_album("b", "2026-01-01")],
        },
        tracks_by_album={"a": [_track("uri:a")], "b": [_track("uri:b")]},
    )
    assert sp_mod.collect_track_uris(sp, ["aaa", "bbb"], 3) == ["uri:a", "uri:b"]


def test_collect_track_uris_propagates_a_failure_immediately() -> None:
    """A raised exception means the API call itself is broken (auth, rate
    limit, a dead endpoint) -- almost certainly true for every remaining
    artist too. This must NOT be swallowed into an empty result for that one
    artist and continue; it must stop the whole batch immediately, exactly
    once, rather than repeating the same failure across every artist."""

    class Broken(FakeSpotify):
        def artist_albums(self, artist_id: str, **kwargs: object) -> dict:
            if artist_id == "bbb":
                raise RuntimeError("410 Gone -- deprecated endpoint")
            return super().artist_albums(artist_id, **kwargs)

    sp = Broken(
        albums_by_artist={"aaa": [_album("a", "2026-01-01")], "ccc": [_album("c", "2026-01-01")]},
        tracks_by_album={"a": [_track("uri:a")], "c": [_track("uri:c")]},
    )
    with pytest.raises(RuntimeError, match="deprecated endpoint"):
        sp_mod.collect_track_uris(sp, ["aaa", "bbb", "ccc"], 3)


# --- find_existing_playlist ---


def test_find_existing_playlist_prefers_the_stored_id() -> None:
    sp = FakeSpotify(
        playlists=[
            _owned("stored", "2026-09-07: This Week in Philly"),
            _owned("by-name", "2026-09-07: This Week in Philly"),
        ]
    )
    found = sp_mod.find_existing_playlist(
        sp, "greg", "2026-09-07: This Week in Philly", "stored"
    )
    assert found == "stored"


def test_find_existing_playlist_falls_back_to_an_exact_name_match() -> None:
    sp = FakeSpotify(playlists=[_owned("by-name", "2026-09-07: This Week in Philly")])
    found = sp_mod.find_existing_playlist(
        sp, "greg", "2026-09-07: This Week in Philly", None
    )
    assert found == "by-name"


def test_find_existing_playlist_ignores_another_users_same_named_playlist() -> None:
    sp = FakeSpotify(
        playlists=[_owned("theirs", "2026-09-07: This Week in Philly", user_id="someone")]
    )
    found = sp_mod.find_existing_playlist(
        sp, "greg", "2026-09-07: This Week in Philly", None
    )
    assert found is None


def test_find_existing_playlist_survives_a_stored_id_that_was_deleted() -> None:
    """A playlist Greg deleted by hand 404s on the id path; that must fall
    through to the name search, not raise and kill the step."""
    sp = FakeSpotify(playlists=[])
    found = sp_mod.find_existing_playlist(
        sp, "greg", "2026-09-07: This Week in Philly", "gone"
    )
    assert found is None


# --- set_playlist_tracks ---


def test_set_playlist_tracks_replaces_rather_than_appends() -> None:
    """The idempotency property: a second run of the same week must converge,
    not stack a second copy of every track onto the playlist."""
    sp = FakeSpotify()
    sp_mod.set_playlist_tracks(sp, "pid", ["uri:a", "uri:b"])
    sp_mod.set_playlist_tracks(sp, "pid", ["uri:a", "uri:b"])
    assert sp.replaced == [("pid", ["uri:a", "uri:b"]), ("pid", ["uri:a", "uri:b"])]
    assert sp.added == []


def test_set_playlist_tracks_chunks_past_the_100_item_api_cap() -> None:
    sp = FakeSpotify()
    uris = [f"uri:{i}" for i in range(230)]
    sp_mod.set_playlist_tracks(sp, "pid", uris)
    assert sp.replaced == [("pid", uris[:100])]
    assert sp.added == [("pid", uris[100:200]), ("pid", uris[200:])]


# --- sync_playlist ---


def test_sync_playlist_creates_a_public_playlist_when_none_exists() -> None:
    sp = FakeSpotify()
    result = sp_mod.sync_playlist(sp, date(2026, 9, 7), ["uri:1", "uri:2", "uri:3"], 1)

    assert len(sp.created) == 1
    assert sp.created[0]["public"] is True
    assert sp.created[0]["name"] == "2026-09-07: This Week in Philly"
    assert result["track_count"] == 3
    assert result["artist_count"] == 1
    assert result["playlist_url"] == f"https://open.spotify.com/playlist/{result['playlist_id']}"


def test_sync_playlist_reuses_the_stored_playlist_instead_of_creating_a_second() -> None:
    sp = FakeSpotify(playlists=[_owned("pid", "2026-09-07: This Week in Philly")])
    result = sp_mod.sync_playlist(sp, date(2026, 9, 7), ["uri:1"], 1, stored_id="pid")

    assert sp.created == []
    assert result["playlist_id"] == "pid"
    assert sp.replaced == [("pid", ["uri:1"])]


def test_sync_playlist_refreshes_the_description_of_an_existing_playlist() -> None:
    sp = FakeSpotify(playlists=[_owned("pid", "2026-09-07: This Week in Philly")])
    sp_mod.sync_playlist(sp, date(2026, 9, 7), ["uri:1"], 1, stored_id="pid")

    assert sp.details_changed[0]["id"] == "pid"
    assert "September 7-13, 2026" in sp.details_changed[0]["description"]


# --- live network canary ---
#
# Excluded by default (pytest -m network runs it). Its whole job is to fail
# loudly and specifically if Spotify deprecates artist_albums/album_tracks
# the way it already deprecated artist_top_tracks -- see the module
# docstring for that history. Needs SPOTIFY_CLIENT_ID/SECRET in the
# environment; Client Credentials is enough since these are read endpoints.


@pytest.mark.network
def test_track_source_endpoints_still_work() -> None:
    client_id = os.environ.get("SPOTIFY_CLIENT_ID")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not client_id or not client_secret:
        pytest.skip("SPOTIFY_CLIENT_ID/SECRET not set")

    import spotipy
    from spotipy.oauth2 import SpotifyClientCredentials

    sp = spotipy.Spotify(
        auth_manager=SpotifyClientCredentials(
            client_id=client_id, client_secret=client_secret
        )
    )
    # Social Distortion -- a real, working artist id, not hardcoded fixture data.
    uris = sp_mod.track_uris_for_artist(sp, "16nn7kCHPWIB6uK09GQCNI", 3)
    assert len(uris) >= 1
