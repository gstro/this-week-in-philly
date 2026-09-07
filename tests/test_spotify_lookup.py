"""Tests for scripts/spotify_lookup.py.

find_spotify_match takes `sp` as a parameter, so it's tested against a fake
Spotify client with a `.search()` method -- zero network, following the
_FakeSession dependency-injection precedent used elsewhere in this repo's
tests rather than mocking spotipy internals.

The one exception is the @pytest.mark.network canary at the bottom (real
Spotify API, `pytest -m network`, excluded from the default run per
pyproject.toml's addopts) -- it re-runs the live matcher against real
historical null titles to empirically confirm this file's candidate-
generation and limit=5 changes actually recover matches, not just that the
offline logic behaves as designed.
"""

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from spotify_lookup import candidate_names, find_spotify_match, music_titles

# --- candidate_names ---


def test_candidate_names_always_includes_the_full_title() -> None:
    assert candidate_names("Some Show Title")[0] == "Some Show Title"


def test_candidate_names_splits_on_a_leading_colon_prefix() -> None:
    """"Gothic night: Die Sexual, Ronnie Stone & DJ Baby Berlin" -> the act
    list follows the colon, and every act in it is tried, in order --
    "Die Sexual" first (it's listed first), not just "Gothic night"."""
    title = "Gothic night: Die Sexual, Ronnie Stone & DJ Baby Berlin"
    candidates = candidate_names(title)
    assert candidates == [
        title,
        "Gothic night",
        "Die Sexual",
        "Ronnie Stone",
        "DJ Baby Berlin",
    ]


def test_candidate_names_splits_on_a_trailing_colon_subtitle() -> None:
    """"LAYER MEAT, SPECTRAL FORCES: A Benefit Show" -- here the act list
    precedes the colon, so both pre-colon acts are useful candidates, not
    just the post-colon subtitle."""
    title = "LAYER MEAT, SPECTRAL FORCES: A Benefit Show"
    candidates = candidate_names(title)
    assert "LAYER MEAT" in candidates
    assert "SPECTRAL FORCES" in candidates
    assert candidates[0] == title


def test_candidate_names_splits_on_comma_without_a_colon() -> None:
    title = "CONTRACHARGE (chi), AGONESIAC, DISCLAIM"
    candidates = candidate_names(title)
    assert candidates == [
        title,
        "CONTRACHARGE (chi)",
        "CONTRACHARGE",
        "AGONESIAC",
        "DISCLAIM",
    ]


def test_candidate_names_does_not_duplicate_an_identical_head_from_both_sides() -> None:
    candidates = candidate_names("Foo: Foo")
    assert candidates == ["Foo: Foo", "Foo"]


def test_candidate_names_splits_on_ampersand_and_and_and_slash_variants() -> None:
    for sep in (" & ", " and ", " w/ ", " with "):
        candidates = candidate_names(f"Die Sexual{sep}The Rest")
        assert candidates[1] == "Die Sexual"
        assert "The Rest" in candidates


def test_candidate_names_no_separator_returns_only_the_full_title() -> None:
    assert candidate_names("Just One Act") == ["Just One Act"]


# --- new separators: +, x/X, /, | ---


def test_candidate_names_splits_on_plus() -> None:
    title = "Quicksand + Bane"
    assert candidate_names(title) == [title, "Quicksand", "Bane"]


def test_candidate_names_splits_on_x_case_insensitive_multi_way() -> None:
    title = "Fraternal Twin x Ditch x Lo Fives x Wax Girl"
    candidates = candidate_names(title)
    assert candidates == [
        title,
        "Fraternal Twin",
        "Ditch",
        "Lo Fives",
        "Wax Girl",
    ]


def test_candidate_names_splits_on_slash_but_not_inside_a_real_name() -> None:
    title = "Gay Cum Daddies (Denton) / Sweepers / Good Pollution / Gr3yboy"
    candidates = candidate_names(title)
    assert candidates == [
        title,
        "Gay Cum Daddies (Denton)",
        "Gay Cum Daddies",
        "Sweepers",
        "Good Pollution",
        "Gr3yboy",
    ]
    assert candidate_names("AC/DC") == ["AC/DC"]


def test_candidate_names_splits_on_pipe_but_not_inside_a_real_name() -> None:
    title = "Successor Tour | Spike Hellis"
    assert candidate_names(title) == [title, "Successor Tour", "Spike Hellis"]
    assert candidate_names("BIG|BRAVE") == ["BIG|BRAVE"]


def test_candidate_names_comma_then_connector_word_does_not_leave_a_stray_fragment() -> None:
    title = "The Body, with BIG|BRAVE, Carnivorous Bells"
    candidates = candidate_names(title)
    assert candidates == [title, "The Body", "BIG|BRAVE", "Carnivorous Bells"]
    assert "with BIG|BRAVE" not in candidates


# --- venue/punctuation/parenthetical stripping ---


def test_candidate_names_strips_a_trailing_venue_suffix() -> None:
    title = "the pleasant uprising @ Wooden Shoe Books!!!!!"
    assert candidate_names(title) == [title, "the pleasant uprising"]


def test_candidate_names_tries_both_with_and_without_a_trailing_parenthetical() -> None:
    title = "DoYeon Kim Quartet (Ars Nova Workshop)"
    candidates = candidate_names(title)
    assert candidates[0] == title
    assert "DoYeon Kim Quartet" in candidates

    title2 = "SKEKSIS (RVA), NIGHTFALL, SEDIMENT, DISKRITIK"
    candidates = candidate_names(title2)
    assert candidates.index("SKEKSIS (RVA)") < candidates.index("SKEKSIS")
    assert "NIGHTFALL" in candidates
    assert "SEDIMENT" in candidates
    assert "DISKRITIK" in candidates


def test_candidate_names_strips_dash_boilerplate_and_splits_on_x() -> None:
    title = "REPO MAN X CIRCLE JERKS – Screening & Performance"
    candidates = candidate_names(title)
    assert "REPO MAN" in candidates
    assert "CIRCLE JERKS" in candidates
    assert "Screening" not in candidates
    assert "Performance" not in candidates


def test_candidate_names_filters_generic_boilerplate_words_via_stop_list() -> None:
    title = "Benefit Show w/ Godcaster, Fib, Taurus Judge, & More!"
    candidates = candidate_names(title)
    assert "Godcaster" in candidates
    assert "Fib" in candidates
    assert "Taurus Judge" in candidates
    assert "More" not in candidates
    assert "& More" not in candidates


def test_candidate_names_splits_on_the_boundary_after_a_parenthetical_tag() -> None:
    """"VOIDHAMMER (LA) HARSH REALM (AVL) DIURETIC" has no separator between
    acts at all beyond a "(city)" tag on each -- the whitespace right after
    each closing paren is the only signal an act ended."""
    title = "VOIDHAMMER (LA) HARSH REALM (AVL) DIURETIC + AGONESIAC @ Cousin Dannys"
    candidates = candidate_names(title)
    assert "VOIDHAMMER" in candidates
    assert "HARSH REALM" in candidates
    assert "DIURETIC" in candidates
    assert "AGONESIAC" in candidates


def test_candidate_names_paren_boundary_defers_to_a_connector_word() -> None:
    """"Foo (bar) with Baz" must still resolve to a clean "Baz" via the
    normal " with " separator, not a stray "with Baz" from a premature
    paren-boundary split."""
    candidates = candidate_names("Foo (bar) with Baz")
    assert "Baz" in candidates
    assert "with Baz" not in candidates


def test_candidate_names_paren_boundary_defers_to_a_symbol_separator() -> None:
    """"(Denton) / Sweepers" must still resolve to a clean "Sweepers" via
    the normal "/" separator, not a stray "/ Sweepers"."""
    title = "Gay Cum Daddies (Denton) / Sweepers / Good Pollution / Gr3yboy"
    candidates = candidate_names(title)
    assert "Sweepers" in candidates
    assert "/ Sweepers" not in candidates


def test_candidate_names_no_paren_boundary_split_on_a_lone_trailing_parenthetical() -> None:
    """Nothing follows the paren in "DoYeon Kim Quartet (Ars Nova Workshop)"
    -- the paren-boundary rule must not fire when there's no next act."""
    title = "DoYeon Kim Quartet (Ars Nova Workshop)"
    assert candidate_names(title) == [title, "DoYeon Kim Quartet", "DoYeon Kim"]


def test_candidate_names_strips_a_trailing_ensemble_size_word() -> None:
    assert candidate_names("DoYeon Kim Quartet") == ["DoYeon Kim Quartet", "DoYeon Kim"]


def test_candidate_names_does_not_strip_band_or_orchestra() -> None:
    """"Band"/"Orchestra" are routinely part of a real act's exact Spotify
    name (e.g. a "Dave Matthews Band" distinct from "Dave Matthews") --
    stripping them risks linking the wrong artist, so they're deliberately
    excluded from the ensemble-suffix list."""
    assert candidate_names("Dave Matthews Band") == ["Dave Matthews Band"]


def test_candidate_names_preserves_a_period_in_an_initialism_act_name() -> None:
    title = "M.I.A. @ Union Transfer"
    assert candidate_names(title) == [title, "M.I.A."]


def test_candidate_names_caps_the_total_number_of_candidates() -> None:
    title = ", ".join(f"Act{i}" for i in range(10))
    candidates = candidate_names(title)
    assert len(candidates) == 8


def test_candidate_names_every_candidate_is_a_substring_of_the_raw_title() -> None:
    """html_render.py links a pick by title.find(matched_text) and falls back
    to a plain link when that's -1 -- every candidate must be a real,
    contiguous substring of the original title for that link path to fire."""
    titles = [
        "Gothic night: Die Sexual, Ronnie Stone & DJ Baby Berlin",
        "LAYER MEAT, SPECTRAL FORCES: A Benefit Show",
        "CONTRACHARGE (chi), AGONESIAC, DISCLAIM",
        "Foo: Foo",
        "Quicksand + Bane",
        "Fraternal Twin x Ditch x Lo Fives x Wax Girl",
        "Gay Cum Daddies (Denton) / Sweepers / Good Pollution / Gr3yboy",
        "AC/DC",
        "BIG|BRAVE",
        "Successor Tour | Spike Hellis",
        "The Body, with BIG|BRAVE, Carnivorous Bells",
        "the pleasant uprising @ Wooden Shoe Books!!!!!",
        "DoYeon Kim Quartet (Ars Nova Workshop)",
        "SKEKSIS (RVA), NIGHTFALL, SEDIMENT, DISKRITIK",
        "M.I.A. @ Union Transfer",
        "VOIDHAMMER (LA) HARSH REALM (AVL) DIURETIC + AGONESIAC @ Cousin Dannys",
        "Foo (bar) with Baz",
    ]
    for title in titles:
        for candidate in candidate_names(title):
            assert candidate in title, f"{candidate!r} not a substring of {title!r}"


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


def test_find_spotify_match_checks_all_returned_results_not_just_the_top_one() -> None:
    """Spotify's own ranking can put a fuzzy/unrelated same-named result
    above the real exact-name match -- the exact-match requirement is
    unchanged, but it must be checked against more than just items[0]."""
    sp = _FakeSpotify(
        {"The Body": [_artist("The Body (Karaoke Tribute)"), _artist("The Body")]}
    )
    match = find_spotify_match(sp, "The Body")  # type: ignore[arg-type]
    assert match is not None
    assert match["matched_text"] == "The Body"


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


# --- live canary: real historical nulls against the real Spotify API ---

# Real Top 3 music-pick titles that came back null from spotify_lookup.py
# in production, and were judged plausibly recoverable by better candidate
# extraction (excludes obscure/local acts, titles with no artist name at
# all, and possessive-project-name titles -- see the implementation plan's
# "Accepted gaps" for why those are left out). Not read from data/*/_spotify.json
# since most of those weeks' files aren't on this branch.
_REAL_HISTORICAL_NULLS = [
    "Kinetic Orbital Strike Record Release w/ Nightfall, Condumb, Durex (mtl), Filth of Society",
    "The Body, with BIG|BRAVE, Carnivorous Bells",
    "SKEKSIS (RVA), NIGHTFALL, SEDIMENT, DISKRITIK",
    "Benefit Show w/ Godcaster, Fib, Taurus Judge, & More!",
    "Fraternal Twin x Ditch x Lo Fives x Wax Girl",
    "Quicksand + Bane",
    "A Black Celebration - Philly's Favorite Depeche Mode Dance Party",
    "Gay Cum Daddies (Denton) / Sweepers / Good Pollution / Gr3yboy",
    "Froggy, PLEASURE DEATH & The Angies",
    "VOIDHAMMER (LA) HARSH REALM (AVL) DIURETIC + AGONESIAC @ Cousin Dannys",
    "DoYeon Kim Quartet (Ars Nova Workshop)",
    "REPO MAN X CIRCLE JERKS – Screening & Performance",
    "Successor Tour | Spike Hellis",
    "the pleasant uprising @ Wooden Shoe Books!!!!!",
]


@pytest.mark.network
@pytest.mark.skipif(
    not (os.environ.get("SPOTIFY_CLIENT_ID") and os.environ.get("SPOTIFY_CLIENT_SECRET")),
    reason="requires SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET",
)
def test_matcher_recovers_a_meaningful_fraction_of_real_historical_nulls() -> None:
    """Empirical check against the real Spotify API: live search results
    drift over time (see tests/golden/README.md), so this pins an aggregate
    improvement threshold, not exact per-title matches, which would be
    flaky by design."""
    import spotipy
    from spotipy.oauth2 import SpotifyClientCredentials

    sp = spotipy.Spotify(
        auth_manager=SpotifyClientCredentials(
            client_id=os.environ["SPOTIFY_CLIENT_ID"],
            client_secret=os.environ["SPOTIFY_CLIENT_SECRET"],
        )
    )

    hits = 0
    for title in _REAL_HISTORICAL_NULLS:
        match = find_spotify_match(sp, title)
        if match:
            hits += 1
            print(f"MATCHED  {title!r} -> {match['matched_text']!r} ({match['spotify_url']})")
        else:
            print(f"null     {title!r}")

    assert hits >= len(_REAL_HISTORICAL_NULLS) // 3, (
        f"only {hits}/{len(_REAL_HISTORICAL_NULLS)} recovered -- expected at least a third"
    )
