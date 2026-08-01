"""Tests for scripts/spotify_lookup.py.

find_spotify_match takes `sp` as a parameter, so it's tested against a fake
Spotify client with a `.search()` method -- zero network, following the
_FakeSession dependency-injection precedent used elsewhere in this repo's
tests rather than mocking spotipy internals.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from spotify_lookup import candidate_names, find_spotify_match, music_titles

# --- candidate_names ---


def test_candidate_names_always_includes_the_full_title() -> None:
    assert candidate_names("Some Show Title")[0] == "Some Show Title"


def test_candidate_names_splits_on_a_leading_colon_prefix() -> None:
    """"Gothic night: Die Sexual, Ronnie Stone & DJ Baby Berlin" -> the act
    list follows the colon, and the head of THAT segment (split on the next
    comma) is the headliner -- "Die Sexual", not "Gothic night"."""
    title = "Gothic night: Die Sexual, Ronnie Stone & DJ Baby Berlin"
    candidates = candidate_names(title)
    assert candidates == [title, "Gothic night", "Die Sexual"]


def test_candidate_names_splits_on_a_trailing_colon_subtitle() -> None:
    """"LAYER MEAT, SPECTRAL FORCES: A Benefit Show" -- here the act list
    precedes the colon, so the pre-colon segment's head ("LAYER MEAT") is
    the useful candidate, not the post-colon subtitle."""
    title = "LAYER MEAT, SPECTRAL FORCES: A Benefit Show"
    candidates = candidate_names(title)
    assert "LAYER MEAT" in candidates
    assert candidates[0] == title


def test_candidate_names_splits_on_comma_without_a_colon() -> None:
    title = "CONTRACHARGE (chi), AGONESIAC, DISCLAIM"
    candidates = candidate_names(title)
    assert candidates == [title, "CONTRACHARGE (chi)"]


def test_candidate_names_does_not_duplicate_an_identical_head_from_both_sides() -> None:
    candidates = candidate_names("Foo: Foo")
    assert candidates == ["Foo: Foo", "Foo"]


def test_candidate_names_splits_on_ampersand_and_and_and_slash_variants() -> None:
    assert candidate_names("Die Sexual & The Rest")[1] == "Die Sexual"
    assert candidate_names("Die Sexual and The Rest")[1] == "Die Sexual"
    assert candidate_names("Die Sexual w/ The Rest")[1] == "Die Sexual"
    assert candidate_names("Die Sexual with The Rest")[1] == "Die Sexual"


def test_candidate_names_no_separator_returns_only_the_full_title() -> None:
    assert candidate_names("Just One Act") == ["Just One Act"]


# --- music_titles ---


def test_music_titles_collects_only_is_music_true_picks_across_all_days() -> None:
    selections = {
        "days": [
            {"top3": [{"title": "Music Pick", "is_music": True}, {"title": "Reading", "is_music": False}]},
            {"top3": [{"title": "Another Band", "is_music": True}]},
        ]
    }
    assert music_titles(selections) == ["Music Pick", "Another Band"]


def test_music_titles_returns_empty_list_when_no_music_picks() -> None:
    selections = {"days": [{"top3": [{"title": "A Reading", "is_music": False}]}]}
    assert music_titles(selections) == []


def test_music_titles_treats_missing_is_music_key_as_false() -> None:
    selections = {"days": [{"top3": [{"title": "No Flag Set"}]}]}
    assert music_titles(selections) == []


# --- find_spotify_match ---


class _FakeSpotify:
    def __init__(self, by_query: dict[str, list[dict] | Exception]) -> None:
        """by_query maps a candidate string (as passed in the `artist:"..."` query)
        to either a list of artist result dicts, or an Exception to raise."""
        self._by_query = by_query
        self.queries: list[str] = []

    def search(self, q: str, type: str, limit: int) -> dict:  # matches spotipy's real kwarg name ("type")
        del type, limit
        # q is of the form 'artist:"<candidate>"'
        candidate = q[len('artist:"') : -1]
        self.queries.append(candidate)
        result = self._by_query.get(candidate, [])
        if isinstance(result, Exception):
            raise result
        return {"artists": {"items": result}}


def _artist(name: str, url: str = "https://open.spotify.com/artist/xyz") -> dict:
    return {"name": name, "external_urls": {"spotify": url}}


def test_find_spotify_match_exact_hit_on_full_title() -> None:
    sp = _FakeSpotify({"Die Sexual": [_artist("Die Sexual")]})
    match = find_spotify_match(sp, "Die Sexual")  # type: ignore[arg-type]
    assert match == {"spotify_url": "https://open.spotify.com/artist/xyz", "matched_text": "Die Sexual"}


def test_find_spotify_match_falls_through_to_a_later_candidate() -> None:
    title = "Gothic night: Die Sexual, Ronnie Stone & DJ Baby Berlin"
    sp = _FakeSpotify({"Die Sexual": [_artist("Die Sexual")]})  # full title and "Gothic night" both miss
    match = find_spotify_match(sp, title)  # type: ignore[arg-type]
    assert match is not None
    assert match["matched_text"] == "Die Sexual"


def test_find_spotify_match_requires_exact_casefolded_name_not_a_fuzzy_hit() -> None:
    # Spotify's own search is fuzzy -- a top result that ISN'T an exact name
    # match must not count as a hit ("never guess" per the module docstring).
    sp = _FakeSpotify({"Die Sexual": [_artist("Die Sexual (Tribute Band)")]})
    assert find_spotify_match(sp, "Die Sexual") is None  # type: ignore[arg-type]


def test_find_spotify_match_is_case_insensitive_on_the_match() -> None:
    sp = _FakeSpotify({"Die Sexual": [_artist("DIE SEXUAL")]})
    match = find_spotify_match(sp, "Die Sexual")  # type: ignore[arg-type]
    assert match is not None
    assert match["matched_text"] == "Die Sexual"


def test_find_spotify_match_returns_none_when_no_candidate_matches() -> None:
    sp = _FakeSpotify({})
    assert find_spotify_match(sp, "Totally Unknown Act") is None  # type: ignore[arg-type]


def test_find_spotify_match_continues_past_a_failed_candidate_search() -> None:
    """A search failure for one candidate must not abort the whole lookup --
    later candidates still get tried."""
    title = "Die Sexual & The Rest"
    sp = _FakeSpotify(
        {
            title: RuntimeError("Spotify API is down"),
            "Die Sexual": [_artist("Die Sexual")],
        }
    )
    match = find_spotify_match(sp, title)  # type: ignore[arg-type]
    assert match is not None
    assert match["matched_text"] == "Die Sexual"
