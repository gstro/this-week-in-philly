"""Tests for scripts/spotify_lookup.py.

find_spotify_matches takes `sp` as a parameter, so it's tested against a fake
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

from spotify_lookup import (
    candidate_groups,
    find_spotify_matches,
    music_titles,
    spotify_entry,
)


def candidate_names(title: str) -> list[str]:
    """candidate_groups flattened: every search find_spotify_matches might
    make, in order. Most tests below care about which strings get tried,
    not how they're grouped."""
    return [candidate for group in candidate_groups(title) for candidate in group]


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
    title = ", ".join(f"Act{i}" for i in range(30))
    candidates = candidate_names(title)
    assert len(candidates) == 20


def test_candidate_names_covers_every_act_on_a_seven_act_bill() -> None:
    """The cap must leave room for a long bill now that every act is looked
    up, not just the first hit. (Modelled on a real 2026-10-05 title that
    used bare "/" with no spaces -- which deliberately does NOT split, so
    "AC/DC" survives; that real title still resolves as one candidate.)"""
    acts = ["Missing Link (NJ)", "King 9", "Criminal Instinct", "Morning Again", "Scorched Earth Policy", "Azshara", "Unmoved"]
    candidates = candidate_names(" / ".join(acts))
    for act in [*acts, "Missing Link"]:
        assert act in candidates


# --- candidate_groups ---


def test_candidate_groups_puts_the_full_title_alone_in_the_first_group() -> None:
    assert candidate_groups("Quicksand + Bane") == [["Quicksand + Bane"], ["Quicksand"], ["Bane"]]


def test_candidate_groups_keeps_an_acts_fallback_variants_in_its_own_group() -> None:
    title = "SKEKSIS (RVA), DoYeon Kim Quartet"
    assert candidate_groups(title) == [
        [title],
        ["SKEKSIS (RVA)", "SKEKSIS"],
        ["DoYeon Kim Quartet", "DoYeon Kim"],
    ]


def test_candidate_groups_truncates_the_last_group_at_the_cap() -> None:
    groups = candidate_groups(", ".join(f"Act{i} (x)" for i in range(30)))
    assert sum(len(group) for group in groups) == 20


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

MUSIC = "\U0001f3b5 Music & Concerts"
FILM = "\U0001f3ac Film & Cinema"


def _day(top3: list[dict], events: list[dict], honorable_mentions: list[dict] | None = None) -> dict:
    return {"top3": top3, "events": events, "honorable_mentions": honorable_mentions or []}


def test_music_titles_takes_top3_by_is_music_and_the_rest_by_category() -> None:
    selections = {
        "days": [
            _day(
                [
                    {"title": "Music Pick", "is_music": True},
                    {"title": "Reading", "is_music": False},
                ],
                [
                    {"title": "Music Pick", "category": MUSIC},
                    {"title": "Reading", "category": "\U0001f4da Literary"},
                    {"title": "Other Band", "category": MUSIC},
                    {"title": "A Film", "category": FILM},
                ],
            ),
            _day([{"title": "Another Band", "is_music": True}], [{"title": "Another Band", "category": MUSIC}]),
        ]
    }
    assert music_titles(selections) == ["Music Pick", "Other Band", "Another Band"]


def test_music_titles_trusts_is_music_false_over_a_music_category_on_a_top3_pick() -> None:
    """Selection flagged the pick not-music (e.g. a karaoke night filed under
    Music) -- it must not come back in through the category path."""
    selections = {
        "days": [
            _day(
                [{"title": "Karaoke Night", "is_music": False}],
                [{"title": "Karaoke Night", "category": MUSIC}],
            )
        ]
    }
    assert music_titles(selections) == []


def test_music_titles_includes_a_top3_is_music_pick_outside_the_music_category() -> None:
    selections = {
        "days": [
            _day(
                [{"title": "Silent Film w/ Live Score", "is_music": True}],
                [{"title": "Silent Film w/ Live Score", "category": FILM}],
            )
        ]
    }
    assert music_titles(selections) == ["Silent Film w/ Live Score"]


def test_music_titles_orders_honorable_mentions_before_the_rest_of_the_day() -> None:
    selections = {
        "days": [
            _day(
                [],
                [
                    {"title": "Early Show", "category": MUSIC},
                    {"title": "Mentioned Band", "category": MUSIC},
                ],
                honorable_mentions=[{"title": "Mentioned Band (SOLD OUT)", "venue": "X"}],
            )
        ]
    }
    assert music_titles(selections) == ["Mentioned Band", "Early Show"]


def test_music_titles_dedupes_a_title_listed_on_two_days() -> None:
    day = _day([], [{"title": "Two Night Stand", "category": MUSIC}])
    assert music_titles({"days": [day, day]}) == ["Two Night Stand"]


def test_music_titles_treats_missing_is_music_key_as_false() -> None:
    selections = {"days": [_day([{"title": "No Flag Set"}], [])]}
    assert music_titles(selections) == []


# --- find_spotify_matches ---


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


def _artist(name: str, url: str = "https://open.spotify.com/artist/xyz", followers: int | None = None) -> dict:
    artist = {"name": name, "external_urls": {"spotify": url}}
    if followers is not None:
        artist["followers"] = {"total": followers}
    return artist


def test_find_spotify_matches_exact_hit_on_full_title() -> None:
    sp = _FakeSpotify({"Die Sexual": [_artist("Die Sexual")]})
    matches = find_spotify_matches(sp, "Die Sexual")  # type: ignore[arg-type]
    assert matches == [{"spotify_url": "https://open.spotify.com/artist/xyz", "matched_text": "Die Sexual"}]


def test_find_spotify_matches_falls_through_to_a_later_candidate() -> None:
    title = "Gothic night: Die Sexual, Ronnie Stone & DJ Baby Berlin"
    sp = _FakeSpotify({"Die Sexual": [_artist("Die Sexual")]})  # full title and "Gothic night" both miss
    matches = find_spotify_matches(sp, title)  # type: ignore[arg-type]
    assert [m["matched_text"] for m in matches] == ["Die Sexual"]


def test_find_spotify_matches_requires_exact_casefolded_name_not_a_fuzzy_hit() -> None:
    # Spotify's own search is fuzzy -- a top result that ISN'T an exact name
    # match must not count as a hit ("never guess" per the module docstring).
    sp = _FakeSpotify({"Die Sexual": [_artist("Die Sexual (Tribute Band)")]})
    assert find_spotify_matches(sp, "Die Sexual") == []  # type: ignore[arg-type]


def test_find_spotify_matches_is_case_insensitive_on_the_match() -> None:
    sp = _FakeSpotify({"Die Sexual": [_artist("DIE SEXUAL")]})
    matches = find_spotify_matches(sp, "Die Sexual")  # type: ignore[arg-type]
    assert [m["matched_text"] for m in matches] == ["Die Sexual"]


def test_find_spotify_matches_returns_none_when_no_candidate_matches() -> None:
    sp = _FakeSpotify({})
    assert find_spotify_matches(sp, "Totally Unknown Act") == []  # type: ignore[arg-type]


def test_find_spotify_matches_checks_all_returned_results_not_just_the_top_one() -> None:
    """Spotify's own ranking can put a fuzzy/unrelated same-named result
    above the real exact-name match -- the exact-match requirement is
    unchanged, but it must be checked against more than just items[0]."""
    sp = _FakeSpotify(
        {"The Body": [_artist("The Body (Karaoke Tribute)"), _artist("The Body")]}
    )
    matches = find_spotify_matches(sp, "The Body")  # type: ignore[arg-type]
    assert [m["matched_text"] for m in matches] == ["The Body"]


def test_find_spotify_matches_continues_past_a_failed_candidate_search() -> None:
    """A search failure for one candidate must not abort the whole lookup --
    later candidates still get tried."""
    title = "Die Sexual & The Rest"
    sp = _FakeSpotify(
        {
            title: RuntimeError("Spotify API is down"),
            "Die Sexual": [_artist("Die Sexual")],
        }
    )
    matches = find_spotify_matches(sp, title)  # type: ignore[arg-type]
    assert [m["matched_text"] for m in matches] == ["Die Sexual"]


def _url(name: str) -> str:
    return f"https://open.spotify.com/artist/{name.replace(' ', '')}"


def test_find_spotify_matches_returns_every_act_on_the_bill_in_listed_order() -> None:
    title = "Noun / Sensor Ghost / Northern Liberties / Gutter Pearl"
    sp = _FakeSpotify(
        {
            "Gutter Pearl": [_artist("Gutter Pearl", _url("Gutter Pearl"))],
            "Sensor Ghost": [_artist("Sensor Ghost", _url("Sensor Ghost"))],
        }
    )
    matches = find_spotify_matches(sp, title)  # type: ignore[arg-type]
    assert [m["matched_text"] for m in matches] == ["Sensor Ghost", "Gutter Pearl"]


def test_find_spotify_matches_does_not_split_a_title_that_is_itself_an_act() -> None:
    """"Simon & Garfunkel" is one act -- splitting it would add a "Simon" and
    a "Garfunkel" that merely share the words."""
    sp = _FakeSpotify(
        {
            "Simon & Garfunkel": [_artist("Simon & Garfunkel", _url("SG"))],
            "Simon": [_artist("Simon", _url("Simon"))],
            "Garfunkel": [_artist("Garfunkel", _url("Garfunkel"))],
        }
    )
    matches = find_spotify_matches(sp, "Simon & Garfunkel")  # type: ignore[arg-type]
    assert [m["matched_text"] for m in matches] == ["Simon & Garfunkel"]
    assert sp.queries == ["Simon & Garfunkel"]


def test_find_spotify_matches_takes_only_the_first_hit_per_act() -> None:
    """"SKEKSIS (RVA)" matching means "SKEKSIS" is never searched -- one act
    must not produce two links."""
    sp = _FakeSpotify(
        {
            "SKEKSIS (RVA)": [_artist("SKEKSIS (RVA)", _url("a"))],
            "SKEKSIS": [_artist("SKEKSIS", _url("b"))],
        }
    )
    matches = find_spotify_matches(sp, "SKEKSIS (RVA), NIGHTFALL")  # type: ignore[arg-type]
    assert [m["matched_text"] for m in matches] == ["SKEKSIS (RVA)"]
    assert "SKEKSIS" not in sp.queries


def test_find_spotify_matches_dedupes_two_acts_resolving_to_one_artist() -> None:
    same = _url("same")
    sp = _FakeSpotify({"Foo": [_artist("Foo", same)], "FOO": [_artist("foo", same)]})
    matches = find_spotify_matches(sp, "Foo, FOO")  # type: ignore[arg-type]
    assert [m["matched_text"] for m in matches] == ["Foo"]


# --- exact-match tie-break (several artists share a name) ---


def _lee_fields_matches(artists: list[dict]) -> list[dict]:
    return find_spotify_matches(_FakeSpotify({"Lee Fields": artists}), "Lee Fields")  # type: ignore[arg-type]


def test_tie_break_highest_followers_wins_even_when_listed_second() -> None:
    matches = _lee_fields_matches(
        [_artist("Lee Fields", "u/small", followers=10), _artist("Lee Fields", "u/big", followers=5000)]
    )
    assert [m["spotify_url"] for m in matches] == ["u/big"]


def test_tie_break_equal_followers_keeps_first_listed() -> None:
    matches = _lee_fields_matches(
        [_artist("Lee Fields", "u/first", followers=7), _artist("Lee Fields", "u/second", followers=7)]
    )
    assert [m["spotify_url"] for m in matches] == ["u/first"]


def test_tie_break_without_followers_keeps_first_listed() -> None:
    matches = _lee_fields_matches([_artist("Lee Fields", "u/first"), _artist("Lee Fields", "u/second")])
    assert [m["spotify_url"] for m in matches] == ["u/first"]


def test_tie_break_followers_null_is_treated_as_missing() -> None:
    first = _artist("Lee Fields", "u/first")
    first["followers"] = {"total": None}
    matches = _lee_fields_matches([first, _artist("Lee Fields", "u/second", followers=1)])
    assert [m["spotify_url"] for m in matches] == ["u/second"]


def test_tie_break_non_exact_result_with_more_followers_never_wins() -> None:
    matches = _lee_fields_matches(
        [
            _artist("Lee Fields Tribute", "u/fuzzy", followers=999999),
            _artist("Lee Fields", "u/a", followers=1),
            _artist("Lee Fields", "u/b", followers=2),
        ]
    )
    assert [m["spotify_url"] for m in matches] == ["u/b"]


def test_tie_break_logs_only_when_two_or_more_exact_matches(capsys: pytest.CaptureFixture[str]) -> None:
    _lee_fields_matches([_artist("Lee Fields", "u/only", followers=1), _artist("Lee Fields Tribute")])
    assert capsys.readouterr().err == ""

    _lee_fields_matches([_artist("Lee Fields", "u/a", followers=1), _artist("Lee Fields", "u/b", followers=2)])
    err = capsys.readouterr().err
    assert "2 exact matches" in err and "'Lee Fields'" in err and "u/b" in err and "2 followers" in err


# --- spotify_entry ---


def test_spotify_entry_repeats_the_first_act_at_the_top_level_for_the_renderer() -> None:
    first = {"spotify_url": _url("a"), "matched_text": "A"}
    second = {"spotify_url": _url("b"), "matched_text": "B"}
    assert spotify_entry([first, second]) == {**first, "artists": [first, second]}


def test_spotify_entry_is_none_when_nothing_matched() -> None:
    assert spotify_entry([]) is None


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
        matches = find_spotify_matches(sp, title)
        if matches:
            hits += 1
            for match in matches:
                print(f"MATCHED  {title!r} -> {match['matched_text']!r} ({match['spotify_url']})")
        else:
            print(f"null     {title!r}")

    assert hits >= len(_REAL_HISTORICAL_NULLS) // 3, (
        f"only {hits}/{len(_REAL_HISTORICAL_NULLS)} recovered -- expected at least a third"
    )


@pytest.mark.network
@pytest.mark.skipif(
    not (os.environ.get("SPOTIFY_CLIENT_ID") and os.environ.get("SPOTIFY_CLIENT_SECRET")),
    reason="requires SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET",
)
def test_lee_fields_name_clash_resolves_to_a_match() -> None:
    """Several real artists are named "Lee Fields"; the tie-break must still
    land on one. Deliberately doesn't pin which id wins."""
    import spotipy
    from spotipy.oauth2 import SpotifyClientCredentials

    sp = spotipy.Spotify(
        auth_manager=SpotifyClientCredentials(
            client_id=os.environ["SPOTIFY_CLIENT_ID"],
            client_secret=os.environ["SPOTIFY_CLIENT_SECRET"],
        )
    )
    assert find_spotify_matches(sp, "Lee Fields")
