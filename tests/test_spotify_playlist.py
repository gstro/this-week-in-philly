"""Tests for scripts/spotify_playlist.py.

Everything that touches Spotify takes `sp` as a parameter, so it's tested
against a fake client rather than the network -- the same approach
test_spotify_lookup.py uses for find_spotify_match.

The fake records every mutating call, because the properties that matter here
are behavioural, not return-value: that a re-run *replaces* rather than
appends (the 2026-08-23 duplicate-write shape), that a stored id is preferred
over a name search, and that a deleted playlist falls through to creation
instead of raising.
"""

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import spotify_playlist as sp_mod


class FakeSpotify:
    """Minimal stand-in for the spotipy client surface this script uses."""

    def __init__(
        self,
        user_id: str = "greg",
        playlists: list[dict] | None = None,
        top_tracks: dict[str, list[str]] | None = None,
    ) -> None:
        self.user_id = user_id
        self.playlists = playlists or []
        self.top_tracks = top_tracks or {}
        self.replaced: list[tuple[str, list[str]]] = []
        self.added: list[tuple[str, list[str]]] = []
        self.created: list[dict] = []
        self.details_changed: list[dict] = []

    def current_user(self) -> dict:
        return {"id": self.user_id}

    def artist_top_tracks(self, artist_id: str, country: str = "US") -> dict:
        uris = self.top_tracks.get(artist_id, [])
        return {"tracks": [{"uri": uri} for uri in uris]}

    def playlist(self, playlist_id: str, fields: str | None = None) -> dict:
        for playlist in self.playlists:
            if playlist["id"] == playlist_id:
                return playlist
        raise RuntimeError(f"404 playlist {playlist_id} not found")

    def current_user_playlists(self, limit: int = 50) -> dict:
        return {"items": self.playlists, "next": None}

    def next(self, result: dict) -> dict | None:
        return None

    def user_playlist_create(
        self, user_id: str, name: str, public: bool = True, description: str = ""
    ) -> dict:
        created = {
            "id": f"new-{len(self.created)}",
            "name": name,
            "owner": {"id": user_id},
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


# --- top_track_uris ---


def test_top_track_uris_slices_to_the_requested_limit() -> None:
    sp = FakeSpotify(top_tracks={"aaa": [f"uri:{i}" for i in range(10)]})
    assert sp_mod.top_track_uris(sp, "aaa", 3) == ["uri:0", "uri:1", "uri:2"]


def test_top_track_uris_returns_empty_when_the_lookup_raises() -> None:
    class Broken(FakeSpotify):
        def artist_top_tracks(self, artist_id: str, country: str = "US") -> dict:
            raise RuntimeError("rate limited")

    assert sp_mod.top_track_uris(Broken(), "aaa", 3) == []


def test_one_artist_failing_does_not_lose_the_other_artists_tracks() -> None:
    class PartlyBroken(FakeSpotify):
        def artist_top_tracks(self, artist_id: str, country: str = "US") -> dict:
            if artist_id == "bbb":
                raise RuntimeError("boom")
            return super().artist_top_tracks(artist_id, country)

    sp = PartlyBroken(top_tracks={"aaa": ["uri:a"], "ccc": ["uri:c"]})
    result = sp_mod.build_playlist(sp, date(2026, 9, 7), ["aaa", "bbb", "ccc"], 3)
    assert result["track_count"] == 2
    assert sp.replaced[0][1] == ["uri:a", "uri:c"]


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


# --- build_playlist ---


def test_build_playlist_refuses_to_empty_a_playlist_when_every_lookup_fails() -> None:
    """Total top-tracks failure (rate limit, outage) must not be mistaken for
    "this week has no music": replacing with [] would clear the existing
    playlist and then publish a report linking to an empty one. Partial
    failure is fine -- see test_one_artist_failing_... above."""

    class AllBroken(FakeSpotify):
        def artist_top_tracks(self, artist_id: str, country: str = "US") -> dict:
            raise RuntimeError("rate limited")

    sp = AllBroken(playlists=[_owned("pid", "2026-09-07: This Week in Philly")])
    with pytest.raises(RuntimeError, match="refusing to replace"):
        sp_mod.build_playlist(sp, date(2026, 9, 7), ["aaa", "bbb"], 3, stored_id="pid")

    assert sp.replaced == []
    assert sp.created == []


def test_build_playlist_creates_a_public_playlist_when_none_exists() -> None:
    sp = FakeSpotify(top_tracks={"aaa": ["uri:1", "uri:2", "uri:3", "uri:4"]})
    result = sp_mod.build_playlist(sp, date(2026, 9, 7), ["aaa"], 3)

    assert len(sp.created) == 1
    assert sp.created[0]["public"] is True
    assert sp.created[0]["name"] == "2026-09-07: This Week in Philly"
    assert result["track_count"] == 3
    assert result["artist_count"] == 1
    assert result["playlist_url"] == f"https://open.spotify.com/playlist/{result['playlist_id']}"


def test_build_playlist_reuses_the_stored_playlist_instead_of_creating_a_second() -> None:
    sp = FakeSpotify(
        playlists=[_owned("pid", "2026-09-07: This Week in Philly")],
        top_tracks={"aaa": ["uri:1"]},
    )
    result = sp_mod.build_playlist(sp, date(2026, 9, 7), ["aaa"], 3, stored_id="pid")

    assert sp.created == []
    assert result["playlist_id"] == "pid"
    assert sp.replaced == [("pid", ["uri:1"])]


def test_build_playlist_refreshes_the_description_of_an_existing_playlist() -> None:
    sp = FakeSpotify(
        playlists=[_owned("pid", "2026-09-07: This Week in Philly")],
        top_tracks={"aaa": ["uri:1"]},
    )
    sp_mod.build_playlist(sp, date(2026, 9, 7), ["aaa"], 3, stored_id="pid")

    assert sp.details_changed[0]["id"] == "pid"
    assert "September 7-13, 2026" in sp.details_changed[0]["description"]
