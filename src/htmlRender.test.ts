/**
 * Port of tests/test_html_render.py, case for case, plus a TS-only block at
 * the end covering the Jinja2-semantics adapters htmlRender.ts adds on top of
 * Nunjucks (escaping, None, truthiness, trailing newline, Python rounding).
 *
 * Same two tiers as the Python: pure-helper unit tests, and render tests
 * against the real committed data/2026-06-22/ week -- including the golden
 * test, which pins this port to the very same tests/golden/actual-2026-06-22.html
 * bytes html_render.py's own golden test pins.
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nunjucks from "nunjucks";
import { afterEach, describe, expect, it } from "vitest";
import { CATEGORY_ORDER, RECURRING_THRESHOLD, loadManifest, loadSelections } from "./common.js";
import {
  CATEGORY_DISPLAY_CAP,
  type Day,
  type HonorableMention,
  type SelectionEvent,
  type Selections,
  SOURCES,
  type TopPick,
  buildAllWeek,
  buildCanonicalUrl,
  buildCategories,
  buildDayViewmodel,
  buildHonorableMentionsHtml,
  buildMapUrl,
  buildMetaDescription,
  buildPickNameHtml,
  buildSources,
  buildStats,
  displayTime,
  formatCompiled,
  formatDateRange,
  formatFailureNote,
  hasMultipleShowtimes,
  jinjaContext,
  jinjaSource,
  markupEscape,
  normalizeSourceName,
  parseTimeForSort,
  priceClassAndText,
  pyFormatFixed,
  pyRound,
  pyThousands,
  renderIndex,
  renderReport,
  renderTemplate,
  splitSourceField,
} from "./htmlRender.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const GOLDEN_DIR = join(REPO_ROOT, "tests", "golden");
const REAL_WEEK_DIR = join(REPO_ROOT, "data", "2026-06-22");

const tmpDirs: string[] = [];
function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "html-render-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// --- display_time ---

describe("displayTime", () => {
  it("returns Various for empty time", () => {
    expect(displayTime("", "")).toBe("Various");
  });

  it("appends plus for multiple showtimes", () => {
    expect(displayTime("7:00 PM", "Multiple showtimes daily.")).toBe("7:00 PM+");
  });

  it("no plus without multiple showtimes note", () => {
    expect(displayTime("7:00 PM", "A regular one-off show.")).toBe("7:00 PM");
  });

  it("falls back to Various for a placeholder time", () => {
    // Regression guard: "*(confirm showtimes)*" + a "multiple showtimes" note
    // used to render as the nonsensical "confirm showtimes+".
    expect(displayTime("*(confirm showtimes)*", "Multiple showtimes daily.")).toBe("Various");
  });

  it("falls back to Various for a long placeholder sentence", () => {
    const placeholder = "*(confirm details — 7:00 AM listed, possible error)*";
    expect(displayTime(placeholder, "")).toBe("Various");
  });
});

// --- has_multiple_showtimes ---

describe("hasMultipleShowtimes", () => {
  it("is case insensitive", () => {
    expect(hasMultipleShowtimes("MULTIPLE SHOWTIMES: 1pm, 3pm")).toBe(true);
  });

  it("is false for a null note", () => {
    expect(hasMultipleShowtimes(null)).toBe(false);
  });
});

// --- price_class_and_text ---

describe("priceClassAndText", () => {
  it("sold out overrides cost", () => {
    expect(priceClassAndText({ sold_out: true, cost: "$15" })).toEqual(["sold-out", "SOLD OUT"]);
  });

  it("free", () => {
    expect(priceClassAndText({ sold_out: false, cost: "free" })).toEqual(["price-free", "free"]);
  });

  it("paid", () => {
    expect(priceClassAndText({ sold_out: false, cost: "$15 adv / $20 DOS" })).toEqual([
      "price-paid",
      "$15 adv / $20 DOS",
    ]);
  });

  it("placeholder cost still gets the paid class", () => {
    // Not a known free synonym, so treated as paid (stripped text shown).
    expect(priceClassAndText({ sold_out: false, cost: "*(confirm details)*" })).toEqual([
      "price-paid",
      "confirm details",
    ]);
  });
});

// --- build_pick_name_html ---

describe("buildPickNameHtml", () => {
  it("links the matched substring", () => {
    const pick = {
      title: "Gothic night: Die Sexual, Ronnie Stone & DJ Baby Berlin",
      is_music: true,
      url: "https://example.com",
    };
    const entry = { spotify_url: "https://open.spotify.com/artist/xyz", matched_text: "Die Sexual" };
    const html = buildPickNameHtml(pick, entry);
    expect(html).toContain("Gothic night: ");
    expect(html).toContain('<a href="https://open.spotify.com/artist/xyz">Die Sexual</a>');
    expect(html).toContain(", Ronnie Stone &amp; DJ Baby Berlin");
  });

  it("falls back to the event url without a spotify entry", () => {
    const pick = {
      title: "CONTRACHARGE (chi), AGONESIAC, DISCLAIM",
      is_music: true,
      url: "https://philly.askapunk.net/events/483",
    };
    expect(buildPickNameHtml(pick, null)).toBe(
      '<a class="event-link" href="https://philly.askapunk.net/events/483">CONTRACHARGE (chi), AGONESIAC, DISCLAIM</a>',
    );
  });

  it("non-music pick ignores the spotify entry", () => {
    const pick = { title: "NFC Sculpture Workshop", is_music: false, url: "https://iffybooks.net/" };
    const html = buildPickNameHtml(pick, { spotify_url: "https://open.spotify.com/artist/xyz", matched_text: "NFC" });
    expect(html).not.toContain("open.spotify.com");
  });

  it("escapes title text", () => {
    // html.escape(quote=False): only &, <, > -- the apostrophe stays literal.
    const pick = { title: "Johnny Brenda's <Show>", is_music: false, url: "https://example.com" };
    expect(buildPickNameHtml(pick, null)).toContain("Johnny Brenda's &lt;Show&gt;");
  });
});

// --- build_honorable_mentions_html ---

describe("buildHonorableMentionsHtml", () => {
  it("joins with a middle dot", () => {
    const mentions = [
      { title: "A", venue: "Venue A" },
      { title: "B", venue: "Venue B" },
    ];
    expect(buildHonorableMentionsHtml(mentions)).toBe("A at Venue A · B at Venue B");
  });

  it("bolds the SOLD OUT suffix", () => {
    const mentions = [{ title: "WILDWOOD, NJ (1994) — Cult Movie Monday (SOLD OUT)", venue: "PhilaMOCA" }];
    const result = buildHonorableMentionsHtml(mentions)!;
    expect(result).toContain("(<strong>SOLD OUT</strong>)");
    expect(result.replace("(<strong>SOLD OUT</strong>)", "")).not.toContain("(SOLD OUT)");
  });

  it("returns null for an empty list", () => {
    expect(buildHonorableMentionsHtml([])).toBeNull();
  });
});

// --- _parse_time_for_sort / build_categories ordering ---

describe("parseTimeForSort", () => {
  it("parses a standard time", () => {
    expect(parseTimeForSort("7:00 PM")).toBe(19 * 60);
  });

  it("returns null for an unparseable time", () => {
    expect(parseTimeForSort("Various")).toBeNull();
    expect(parseTimeForSort("")).toBeNull();
  });
});

function event(title: string, time: string): SelectionEvent {
  return { title, category: CATEGORY_ORDER[0], time, url: "https://example.com", venue: "Test Venue", cost: "free" };
}

function names(categories: ReturnType<typeof buildCategories>, index = 0): string[] {
  return categories[index]!.events.map((e) => e.name_html);
}

describe("buildCategories ordering", () => {
  it("sorts events within a category by time ascending", () => {
    const categories = buildCategories({ events: [event("Late Show", "9:00 PM"), event("Early Show", "6:00 PM")] }, new Set());
    const n = names(categories);
    expect(n[0]).toContain("Early Show");
    expect(n[1]).toContain("Late Show");
  });

  it("sorts an unparseable time last", () => {
    const categories = buildCategories({ events: [event("No Time", ""), event("Has Time", "6:00 PM")] }, new Set());
    const n = names(categories);
    expect(n[0]).toContain("Has Time");
    expect(n[1]).toContain("No Time");
  });

  it("omits categories with no events", () => {
    const categories = buildCategories({ events: [event("Only Music", "7:00 PM")] }, new Set());
    expect(categories).toHaveLength(1);
    expect(categories[0]!.label).toBe(CATEGORY_ORDER[0]);
  });

  it("marks top3 events with a star prefix", () => {
    const categories = buildCategories({ events: [event("Pick", "7:00 PM")] }, new Set(["Pick"]));
    expect(categories[0]!.events[0]!.name_html).toContain("⭐ ");
  });
});

// --- source normalization / derived footer ---
// Every shape here was taken from the real archive (see the Python suite).

describe("splitSourceField", () => {
  it("splits on slash", () => {
    expect(splitSourceField("Do215 / WXPN")).toEqual(["Do215", "WXPN"]);
  });

  it("splits on comma", () => {
    expect(splitSourceField("Do215, WXPN")).toEqual(["Do215", "WXPN"]);
  });

  it("handles three-way attribution", () => {
    expect(splitSourceField("Do215 / PhilaMOCA / R5 Productions")).toEqual(["Do215", "PhilaMOCA", "R5 Productions"]);
  });

  it("is empty for a missing source", () => {
    expect(splitSourceField(null)).toEqual([]);
  });
});

describe("normalizeSourceName", () => {
  it("collapses every meetup group", () => {
    expect(normalizeSourceName("Meetup: Code & Coffee")).toBe("Meetup");
    expect(normalizeSourceName("Meetup: Philadelphia Horror")).toBe("Meetup");
  });

  it("maps WXPN to its footer name", () => {
    expect(normalizeSourceName("WXPN")).toBe("The Key by WXPN");
  });

  it("passes through an unaliased name", () => {
    expect(normalizeSourceName("Iffy Books")).toBe("Iffy Books");
  });
});

function sourcesByName(days: { events: { source?: string }[] }[]): Map<string, { url: string | null; count: number }> {
  return new Map(buildSources(days).map((row) => [row.name, row]));
}

describe("buildSources", () => {
  it("counts a contributor and leaves silent ones at zero", () => {
    const rows = sourcesByName([{ events: [{ source: "Iffy Books" }, { source: "Iffy Books" }] }]);
    expect(rows.get("Iffy Books")!.count).toBe(2);
    expect(rows.get("Do215")!.count).toBe(0);
  });

  it("credits both halves of a shared attribution", () => {
    const rows = sourcesByName([{ events: [{ source: "Do215 / WXPN" }] }]);
    expect(rows.get("Do215")!.count).toBe(1);
    expect(rows.get("The Key by WXPN")!.count).toBe(1);
  });

  it("sums meetup groups into one entry", () => {
    const rows = sourcesByName([{ events: [{ source: "Meetup: Code & Coffee" }, { source: "Meetup: DC 215" }] }]);
    expect(rows.get("Meetup")!.count).toBe(2);
  });

  it("keeps a retired source unlinked rather than dropping it", () => {
    // Songkick left SOURCES (bdc8a84) but is still in the published 2026-06-22 week.
    const row = sourcesByName([{ events: [{ source: "Songkick" }] }]).get("Songkick")!;
    expect(row.count).toBe(1);
    expect(row.url).toBeNull();
  });

  it("lists known sources before retired ones", () => {
    const rowNames = buildSources([{ events: [{ source: "Songkick" }, { source: "Do215" }] }]).map((r) => r.name);
    expect(rowNames.indexOf("Do215")).toBeLessThan(rowNames.indexOf("Songkick"));
    expect(rowNames.slice(0, SOURCES.length)).toEqual(SOURCES.map(([name]) => name));
  });
});

// --- build_map_url ---

describe("buildMapUrl", () => {
  it("encodes the address", () => {
    expect(buildMapUrl("404 S. 20th St., Philadelphia, PA 19146")).toBe(
      "https://www.google.com/maps/search/?api=1&query=404+S.+20th+St.%2C+Philadelphia%2C+PA+19146",
    );
  });

  it("is null without an address", () => {
    // 2 of 21 golden-week picks carry no address; the venue renders as plain text.
    expect(buildMapUrl(null)).toBeNull();
    expect(buildMapUrl("   ")).toBeNull();
  });
});

// --- Top 3 pick view model: sold-out and map link ---

function onePickDay(overrides: Partial<TopPick> = {}): Day {
  const pick: TopPick = {
    rank: 1,
    title: "A Show",
    url: "https://example.com/show",
    why: "Because.",
    venue: "A Venue",
    time: "8:00 PM",
    cost: "$25",
    ...overrides,
  };
  return { date: "2026-06-22", day_name: "Monday", top3: [pick], events: [] };
}

describe("Top 3 pick view model", () => {
  it("shows SOLD OUT instead of its ticket price", () => {
    const pick = buildDayViewmodel(onePickDay({ sold_out: true }), {}).top3[0]!;
    expect(pick.sold_out).toBe(true);
    expect(pick.cost_text).toBe("SOLD OUT");
  });

  it("keeps its cost when not sold out", () => {
    const pick = buildDayViewmodel(onePickDay(), {}).top3[0]!;
    expect(pick.sold_out).toBe(false);
    expect(pick.cost_text).toBe("$25");
    expect(pick.time_display).toBe("8:00 PM");
  });

  it("day slug is the weekday", () => {
    expect(buildDayViewmodel(onePickDay(), {}).slug).toBe("monday");
  });

  it("day index count is the true count before the display cap", () => {
    const day = onePickDay();
    day.events = Array.from({ length: CATEGORY_DISPLAY_CAP + 3 }, (_, i) => ({
      title: `Event ${String(i)}`,
      url: "https://example.com",
      venue: "V",
      category: "🎵 Music & Concerts",
      time: "8:00 PM",
      cost: "",
    }));
    const view = buildDayViewmodel(day, {});
    expect(view.event_count).toBe(CATEGORY_DISPLAY_CAP + 3);
    expect(view.categories[0]!.events).toHaveLength(CATEGORY_DISPLAY_CAP);
  });

  it("gets a map link only when it has an address", () => {
    const withAddress = buildDayViewmodel(onePickDay({ address: "404 S. 20th St., Philadelphia, PA 19146" }), {})
      .top3[0]!;
    expect(withAddress.map_url!.startsWith("https://www.google.com/maps/search/")).toBe(true);
    expect(buildDayViewmodel(onePickDay(), {}).top3[0]!.map_url).toBeNull();
  });
});

// --- build_stats: the Week in Numbers section ---

const MUSIC = "🎵 Music & Concerts";
const FILM = "🎬 Film & Cinema";

function statsDay(date: string, dayName: string, events: SelectionEvent[], top3: TopPick[]): Day {
  return { date, day_name: dayName, events, top3 };
}

function statsEvent(title: string, category: string, source = "Do215"): SelectionEvent {
  return { title, url: "https://example.com", venue: "V", category, source, time: "8:00 PM", cost: "" };
}

function oneDaySelections(events: SelectionEvent[], top3: TopPick[], candidates: number): Selections {
  return { days: [statsDay("2026-06-22", "Monday", events, top3)], total_events_after_dedup: candidates };
}

describe("buildStats", () => {
  it("funnel drops the Collected stage without a manifest", () => {
    // data/2026-06-22 predates v2 and has no _manifest.json.
    const stats = buildStats(oneDaySelections([statsEvent("A", MUSIC)], [], 10), {}, {});
    expect(stats.stages.map((s) => s.label)).toEqual(["Candidates", "Listed", "Top 3 picks"]);
    expect(stats.health).toBeNull();
  });

  it("funnel leads with Collected when the manifest is there", () => {
    const manifest = { sources: { do215: { status: "ok", events: 40 } } };
    const stats = buildStats(oneDaySelections([statsEvent("A", MUSIC)], [], 10), manifest, {});
    expect(stats.stages[0]).toEqual({ label: "Collected", value: 40, drop_pct: null, drop_from: null, display: "40" });
    expect(stats.stages[1]!.drop_pct).toBe(75); // 40 -> 10 candidates
    expect(stats.stages[1]!.drop_from).toBe("collected");
  });

  it("category counts are pre-cap", () => {
    const events = Array.from({ length: CATEGORY_DISPLAY_CAP + 4 }, (_, i) => statsEvent(`E${String(i)}`, MUSIC));
    const stats = buildStats(oneDaySelections(events, [], 100), {}, {});
    expect(stats.categories.find((row) => row.label === MUSIC)!.listed).toBe(CATEGORY_DISPLAY_CAP + 4);
  });

  it("categories sort by listed count descending", () => {
    const events = [0, 1, 2].map((i) => statsEvent(`M${String(i)}`, MUSIC));
    events.push(statsEvent("F1", FILM));
    const stats = buildStats(oneDaySelections(events, [], 10), {}, {});
    expect(stats.categories.map((row) => row.label)).toEqual([MUSIC, FILM]);
    // Percentages of the widest row, so the longest bar is 100%.
    expect(stats.categories[0]!.listed_pct).toBe(100.0);
    expect(Math.abs(stats.categories[1]!.listed_pct - 33.3)).toBeLessThanOrEqual(0.1);
  });

  it("keeps a category that won no slot at its true length", () => {
    const events = [0, 1, 2, 3].map((i) => statsEvent(`M${String(i)}`, MUSIC));
    const row = buildStats(oneDaySelections(events, [], 10), {}, {}).categories[0]!;
    expect(row.top3).toBe(0);
    expect(row.top3_pct).toBe(0.0);
    expect(row.listed).toBe(4);
  });

  it("counts All Week events in their category", () => {
    const recurring: SelectionEvent = {
      ...statsEvent("Runs all week", MUSIC),
      recurrence_count: RECURRING_THRESHOLD,
      occurrences: ["2026-06-22", "2026-06-23", "2026-06-24"],
    };
    const stats = buildStats(oneDaySelections([statsEvent("One-off", MUSIC), recurring], [], 10), {}, {});
    expect(stats.stages.find((s) => s.label === "Listed")!.value).toBe(2);
    expect(stats.categories.reduce((sum, row) => sum + row.listed, 0)).toBe(2);
  });

  it("category bars sum to the funnel Listed total on real weeks", () => {
    for (const week of ["2026-09-14", "2026-08-03", "2026-06-22"]) {
      const weekDir = join(REPO_ROOT, "data", week);
      const stats = buildStats(loadSelections(weekDir) as Selections, loadManifest(weekDir) as object, {});
      const listedStage = stats.stages.find((s) => s.label === "Listed")!;
      expect(stats.categories.reduce((sum, row) => sum + row.listed, 0), week).toBe(listedStage.value);
    }
  });

  it("health does not cry wolf over an expectedly quiet source", () => {
    const manifest = {
      sources: { do215: { status: "ok", events: 40 }, "meetup-owasp": { status: "ok", events: 0 } },
    };
    const expected = { sources: { do215: { min_expected: 20 }, "meetup-owasp": { min_expected: 0 } } };
    const health = buildStats(oneDaySelections([], [], 10), manifest, expected).health!;
    expect(health.below_floor).toEqual([]);
    expect(health.source_count).toBe(2);
    expect(health.contributed).toBe(1);
  });

  it("health names a source that is genuinely below floor", () => {
    const manifest = { sources: { do215: { status: "ok", events: 3 } } };
    const expected = { sources: { do215: { min_expected: 20 } } };
    expect(buildStats(oneDaySelections([], [], 10), manifest, expected).health!.below_floor).toEqual(["do215"]);
  });

  it("sources are contributors only, sorted descending", () => {
    const events = [statsEvent("A", MUSIC, "Do215"), statsEvent("B", MUSIC, "Iffy Books"), statsEvent("B", MUSIC, "Iffy Books")];
    const stats = buildStats(oneDaySelections(events, [], 10), {}, {});
    expect(stats.sources.map((row) => [row.name, row.count])).toEqual([
      ["Iffy Books", 2],
      ["Do215", 1],
    ]);
    expect(stats.sources.every((row) => row.count)).toBe(true);
  });

  it("rendered stats agree with the data they summarize", () => {
    // The golden fixture pins the degraded (no-manifest) path; this pins the full one.
    const weekDir = join(REPO_ROOT, "data", "2026-09-14");
    const selections = loadSelections(weekDir) as Selections;
    const manifest = loadManifest(weekDir) as { sources: Record<string, { events?: number }> };
    const html = renderReport(weekDir);

    const collected = Object.values(manifest.sources).reduce((sum, s) => sum + (s.events || 0), 0);
    const candidates = selections.total_events_after_dedup!;
    const listed = selections.days.reduce((sum, day) => sum + day.events.length, 0);
    const picks = selections.days.reduce((sum, day) => sum + day.top3.length, 0);

    for (const [value, label] of [
      [collected, "Collected"],
      [candidates, "Candidates"],
      [listed, "Listed"],
      [picks, "Top 3 picks"],
    ] as const) {
      expect(html, label).toContain(`<div class="funnel-value">${pyThousands(value)}</div>`);
    }
    expect(html).toContain("none below their expected floor");
  });
});

// --- format_failure_note / format_date_range ---

describe("formatFailureNote / formatDateRange", () => {
  it("failure note splits on paren", () => {
    expect(formatFailureNote("do215 (partial — URL retrieval failed)")).toBe(
      "do215 unavailable this week (partial — URL retrieval failed)",
    );
  });

  it("failure note without a paren", () => {
    expect(formatFailureNote("songkick")).toBe("songkick unavailable this week");
  });

  it("date range within one month", () => {
    expect(formatDateRange("2026-06-22", "2026-06-28")).toBe("June 22–28, 2026");
  });

  it("date range spanning months", () => {
    expect(formatDateRange("2026-06-29", "2026-07-05")).toBe("June 29 – July 5, 2026");
  });
});

// --- render_report: missing _spotify.json degrades silently ---

describe("renderReport optional inputs", () => {
  it("degrades gracefully without a _spotify.json", () => {
    const dir = tmpPath();
    copyFileSync(join(REAL_WEEK_DIR, "_selections.json"), join(dir, "_selections.json"));
    // deliberately no _spotify.json
    const html = renderReport(dir);
    expect(html).not.toContain("open.spotify.com");
    expect(html).toContain("NFC Sculpture Workshop");
    // sanity: the real file does have picks, so this isn't a no-op check
    const real = JSON.parse(readFileSync(join(REAL_WEEK_DIR, "_selections.json"), "utf8")) as Selections;
    expect(real.days[0]!.top3.length).toBeGreaterThan(0);
  });

  it("omits the playlist link without a _playlist.json", () => {
    const dir = tmpPath();
    copyFileSync(join(REAL_WEEK_DIR, "_selections.json"), join(dir, "_selections.json"));
    const html = renderReport(dir);
    // The class is always in the stylesheet; it's the element that must be absent.
    expect(html).not.toContain('<div class="header-playlist">');
    expect(html).not.toContain("open.spotify.com/playlist");
  });

  it("puts the playlist link in the header", () => {
    const dir = tmpPath();
    copyFileSync(join(REAL_WEEK_DIR, "_selections.json"), join(dir, "_selections.json"));
    writeFileSync(
      join(dir, "_playlist.json"),
      JSON.stringify({
        name: "2026-06-22: This Week in Philly",
        playlist_id: "abc123",
        playlist_url: "https://open.spotify.com/playlist/abc123",
      }),
    );
    const html = renderReport(dir);
    const linkHtml =
      '<div class="header-playlist">' +
      '<a href="https://open.spotify.com/playlist/abc123">' +
      "♫ This week's music on Spotify</a></div>";
    expect(html).toContain(linkHtml);
    expect(html.indexOf(linkHtml)).toBeLessThan(html.indexOf('class="day-header"'));
  });
});

// --- Golden test ---

describe("golden", () => {
  it("renderReport matches the golden v2 artifact byte for byte", () => {
    // The same file html_render.py's own golden test pins -- one spec of record.
    const expected = readFileSync(join(GOLDEN_DIR, "actual-2026-06-22.html"), "utf8");
    expect(renderReport(REAL_WEEK_DIR)).toBe(expected);
  });
});

// --- All Week / Recurring table ---

const MUSIC_CAT = "\u{1f3b5} Music & Concerts";

function recEvent(title: string, venue = "A Venue", occurrences?: string[], extra: Partial<SelectionEvent> = {}): SelectionEvent {
  const ev: SelectionEvent = {
    title,
    venue,
    time: "7:00 PM",
    cost: "$10",
    url: "",
    category: MUSIC_CAT,
    source: "Do215",
    sold_out: false,
  };
  if (occurrences && occurrences.length > 0) {
    ev.occurrences = occurrences;
    ev.recurrence_count = occurrences.length;
  }
  return { ...ev, ...extra };
}

function recDay(date: string, events: SelectionEvent[], top3: TopPick[] = []): Day & { honorable_mentions: HonorableMention[] } {
  return { date, day_name: "Monday", top3, honorable_mentions: [], events };
}

describe("All Week / Recurring table", () => {
  it("collects recurring events, one row per series", () => {
    const days = [
      recDay("2026-09-01", [recEvent("Rent", "A Venue", ["2026-09-01", "2026-09-02", "2026-09-03"])]),
      recDay("2026-09-02", [recEvent("One-off Show")]),
    ];
    const rows = buildAllWeek(days, new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Rent");
    expect(rows[0]!.venue).toBe("A Venue");
  });

  it("lists this week's days and makes no claim about the real run", () => {
    const days = [recDay("2026-09-01", [recEvent("Standing Exhibit", "A Venue", ["2026-09-01", "2026-09-03", "2026-09-05"])])];
    const rows = buildAllWeek(days, new Map());
    expect(rows[0]!.days).toBe("Tue, Thu, Sat");
    expect(rows[0]!.days).not.toContain("-");
    expect(rows[0]!.days).not.toContain("–");
  });

  it("ignores events below the recurring threshold", () => {
    const days = [recDay("2026-09-01", [recEvent("Twice Only", "A Venue", ["2026-09-01", "2026-09-02"])])];
    expect(buildAllWeek(days, new Map())).toEqual([]);
  });

  it("leaves a recurring top3 pick in its own day", () => {
    const ev = recEvent("Special Run", "A Venue", ["2026-09-01", "2026-09-02", "2026-09-03"]);
    const days = [recDay("2026-09-01", [ev], [{ title: "Special Run" }])];
    expect(buildAllWeek(days, new Map([["2026-09-01", new Set(["Special Run"])]]))).toEqual([]);
    const categories = buildCategories(days[0]!, new Set(["Special Run"]));
    expect(categories.some((c) => c.events.some((e) => e.name_html))).toBe(true);
  });

  it("removes recurring events from the day category blocks", () => {
    const day = recDay("2026-09-01", [
      recEvent("Rent", "A Venue", ["2026-09-01", "2026-09-02", "2026-09-03"]),
      recEvent("One-off Show"),
    ]);
    const titles = buildCategories(day, new Set()).flatMap((c) => c.events.map((e) => e.name_html));
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain("One-off Show");
  });

  it("category block reports how many the display cap dropped", () => {
    const events = Array.from({ length: 12 }, (_, i) => recEvent(`Show ${String(i)}`, "A Venue", undefined, { time: "7:00 PM" }));
    const categories = buildCategories(recDay("2026-09-01", events), new Set());
    expect(categories[0]!.true_count).toBe(12);
    expect(categories[0]!.events).toHaveLength(CATEGORY_DISPLAY_CAP);
    expect(categories[0]!.omitted).toBe(2);
  });

  it("category block omitted is null when nothing was dropped", () => {
    expect(buildCategories(recDay("2026-09-01", [recEvent("Only Show")]), new Set())[0]!.omitted).toBeNull();
  });
});

// --- Head metadata: canonical URL, description, compiled date ---

describe("head metadata", () => {
  it("canonical URL points at the Pages project subpath", () => {
    expect(buildCanonicalUrl("2026-06-22")).toBe("https://gstro.github.io/this-week-in-philly/weeks/2026-06-22.html");
  });

  it.each([null, "", "not-a-date", "2026-13-01"])("canonical URL is null for an unusable week key %j", (week) => {
    expect(buildCanonicalUrl(week)).toBeNull();
  });

  it("formatCompiled drops the clock time", () => {
    // generated_at is a naive UTC datetime.now(); there's no offset to correct with.
    const [iso, display] = formatCompiled("2026-09-13T22:23:01");
    expect(iso).toBe("2026-09-13");
    expect(display).toBe("Sunday, September 13");
    expect(display).not.toContain("22");
  });

  it.each([null, "", "whenever"])("formatCompiled is null for an unparseable stamp %j", (raw) => {
    expect(formatCompiled(raw)).toEqual([null, null]);
  });

  it("meta description uses the week's own numbers", () => {
    const stats = {
      stages: [
        { label: "Collected", value: 700 },
        { label: "Listed", value: 90 },
        { label: "Top 3 picks", value: 21 },
      ],
      sources: [{ name: "Do215" }, { name: "PhilaMOCA" }],
    };
    const description = buildMetaDescription(stats, "June 22–28, 2026");
    expect(description).toContain("21 handpicked things");
    expect(description).toContain("90 events across 2 sources");
    expect(description).toContain("June 22–28, 2026");
  });

  it("report head carries the link preview tags", () => {
    const html = renderReport(REAL_WEEK_DIR);
    const head = html.slice(0, html.indexOf("</head>"));
    for (const tag of [
      '<meta property="og:type" content="article">',
      '<meta property="og:title" content="This Week in Philadelphia — June 22–28, 2026">',
      '<meta name="twitter:card" content="summary">',
      '<link rel="canonical" href="https://gstro.github.io/this-week-in-philly/weeks/2026-06-22.html">',
    ]) {
      expect(head).toContain(tag);
    }
    expect(head).toContain('rel="icon" href="data:image/svg+xml,');
    expect(head).not.toContain('property="og:image"');
  });

  it("subtitle states the real compile date", () => {
    const html = renderReport(REAL_WEEK_DIR);
    expect(html).toContain('Compiled <time datetime="2026-06-21">Sunday, June 21</time>');
    expect(html).not.toContain("Compiled Sunday</div>");
  });
});

// --- Document outline and keyboard affordances ---

describe("document outline", () => {
  it("has one h1 and a real heading outline", () => {
    const html = renderReport(REAL_WEEK_DIR);
    expect(html.split("<h1").length - 1).toBe(1);
    // One h2 per day, plus Week in Numbers (this week has no All Week rows).
    expect(html.split('<h2 class="day-header"').length - 1).toBe(7);
    expect(html).toContain('<h2 class="stats-label">Week in Numbers</h2>');
    expect(html).toContain('<h3 class="cat-label">');
    expect(html).toContain('<h3 class="top3-label">');
    expect(html).not.toContain('<div class="day-header"');
    expect(html).not.toContain('<div class="cat-label">');
  });

  it("day headers carry a machine-readable date", () => {
    const html = renderReport(REAL_WEEK_DIR);
    expect(html).toContain('<time class="day-date" datetime="2026-06-22">June 22</time>');
    expect(html).not.toContain('<div class="day-rule">');
  });

  it("opens with a skip link to the day index", () => {
    const html = renderReport(REAL_WEEK_DIR);
    expect(html).toContain('<a class="skip-link" href="#day-index">');
    expect(html).toContain('<nav class="day-index" id="day-index"');
    expect(html.indexOf('class="skip-link"')).toBeLessThan(html.indexOf('class="site-header"'));
  });

  it("renderIndex carries the same head block", () => {
    const index = renderIndex();
    expect(index).toContain('rel="icon" href="data:image/svg+xml,');
    expect(index).toContain('<link rel="canonical" href="https://gstro.github.io/this-week-in-philly/">');
  });
});

// --- TS-only: the Jinja2-semantics layer over Nunjucks ---
// No Python counterpart: these pin the adaptations listed in htmlRender.ts's
// module docstring, each of which the parity sweep showed real data needs
// (or would need) to stay byte-identical with the Jinja2 output.

describe("Jinja2 semantics over Nunjucks (TS-only)", () => {
  it("the suppressValue hook takes effect (guards the pinned-version internal)", () => {
    // If a nunjucks upgrade stops routing {{ }} through runtime.suppressValue,
    // this fails before any output silently changes. markupsafe -> &#34;,
    // nunjucks' own escape -> &quot; / &#92;.
    const html = renderTemplate("index.html.j2", {
      weeks: [{ href: 'a"b\\c', label: `<x> & 'y'` }],
      site_url: "u",
    });
    expect(html).toContain('<a href="a&#34;b\\c">&lt;x&gt; &amp; &#39;y&#39;</a>');
    expect(html).not.toContain("&quot;");
  });

  it("the hook is scoped to one render and restored afterwards", () => {
    const before = (nunjucks.runtime as unknown as { suppressValue: unknown }).suppressValue;
    renderIndex();
    expect((nunjucks.runtime as unknown as { suppressValue: unknown }).suppressValue).toBe(before);
  });

  it("the hook is restored even when the render throws", () => {
    const before = (nunjucks.runtime as unknown as { suppressValue: unknown }).suppressValue;
    expect(() => renderTemplate("does-not-exist.html.j2", {})).toThrow();
    expect((nunjucks.runtime as unknown as { suppressValue: unknown }).suppressValue).toBe(before);
  });

  it("markupEscape matches markupsafe, not html.escape", () => {
    expect(markupEscape(`<a href="x">'&'</a>`)).toBe("&lt;a href=&#34;x&#34;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("an empty list is falsy in the template, as in Jinja2", () => {
    // index.html.j2's {% for %}{% else %} branch.
    expect(renderTemplate("index.html.j2", { weeks: [], site_url: "u" })).toContain("No reports published yet.");
  });

  it("jinjaContext maps empty containers to null and leaves everything else alone", () => {
    expect(jinjaContext({ a: [], b: {}, c: [1, []], d: 0, e: "", f: { g: [] } })).toEqual({
      a: null,
      b: null,
      c: [1, null],
      d: 0,
      e: "",
      f: { g: null },
    });
  });

  it("a null printed value renders as None, an undefined one as empty", () => {
    const html = renderTemplate("index.html.j2", { weeks: [{ href: null, label: true }], site_url: undefined });
    expect(html).toContain('<li><a href="None">True</a></li>');
    expect(html).toContain('<link rel="canonical" href="">');
  });

  it("jinjaSource normalizes newlines and drops exactly one trailing newline", () => {
    expect(jinjaSource("a\r\nb\rc\n")).toBe("a\nb\nc");
    expect(jinjaSource("a\n\n")).toBe("a\n");
    expect(jinjaSource("a")).toBe("a");
    expect(renderIndex().endsWith("</html>")).toBe(true);
  });

  it("pyFormatFixed rounds exact binary ties half-to-even, like '%.1f'", () => {
    expect(pyFormatFixed(6.25, 1)).toBe("6.2"); // toFixed gives "6.3"
    expect(pyFormatFixed(18.75, 1)).toBe("18.8");
    expect(pyFormatFixed(0.05, 1)).toBe("0.1"); // 0.05 is slightly above the tie in binary
    expect(pyFormatFixed(100, 1)).toBe("100.0");
    expect(pyFormatFixed(33.333333333333336, 1)).toBe("33.3");
    expect(pyFormatFixed(-0.04, 1)).toBe("-0.0");
  });

  it("pyRound is Python's banker's round", () => {
    expect(pyRound(12.5)).toBe(12);
    expect(pyRound(13.5)).toBe(14);
    expect(pyRound(-2.5)).toBe(-2);
    expect(pyRound(75)).toBe(75);
    expect(pyRound(74.6)).toBe(75);
  });

  it("pyThousands groups like f'{n:,}'", () => {
    expect(pyThousands(40)).toBe("40");
    expect(pyThousands(1234567)).toBe("1,234,567");
    expect(pyThousands(-1234)).toBe("-1,234");
  });

  it("parseTimeForSort mirrors strptime's %I:%M %p regex exactly", () => {
    expect(parseTimeForSort("12:00 am")).toBe(0);
    expect(parseTimeForSort("12:30 PM")).toBe(12 * 60 + 30);
    expect(parseTimeForSort("7:5 PM")).toBe(19 * 60 + 5);
    expect(parseTimeForSort(" 7:00 PM")).toBe(19 * 60); // %I accepts a space-padded hour
    expect(parseTimeForSort("7:00  pm")).toBe(19 * 60); // the space is \s+
    expect(parseTimeForSort("07:00PM")).toBeNull();
    expect(parseTimeForSort("13:00 PM")).toBeNull();
    expect(parseTimeForSort("7:00 PM ")).toBeNull();
    expect(parseTimeForSort(null)).toBeNull();
  });

  it("formatCompiled accepts strict ISO 8601 only (narrower than fromisoformat)", () => {
    expect(formatCompiled("2026-09-13")[0]).toBe("2026-09-13");
    expect(formatCompiled("2026-09-13T22:23")[0]).toBe("2026-09-13");
    expect(formatCompiled("2026-09-13 22:23:01")[0]).toBe("2026-09-13");
    expect(formatCompiled("2026-09-13T22:23:01.123456+01:00")[0]).toBe("2026-09-13");
    expect(formatCompiled("2026-09-13T22:23:01Z")[0]).toBe("2026-09-13");
    // Python's fromisoformat takes all of these; this port rejects them.
    expect(formatCompiled("20260913T222301")[0]).toBeNull();
    expect(formatCompiled("2026-09-13X22:23:01")[0]).toBeNull();
    expect(formatCompiled("2026-W37-7")[0]).toBeNull();
    // Out of range, as in Python.
    expect(formatCompiled("2026-09-13T24:00:00")[0]).toBeNull();
    expect(formatCompiled("2026-09-13T22:23:1")[0]).toBeNull();
    expect(formatCompiled("2026-02-30")[0]).toBeNull();
  });

  it("buildMapUrl encodes what quote_plus encodes and encodeURIComponent doesn't", () => {
    expect(buildMapUrl("1 Main St. (rear)! *x* 'y'")).toBe(
      "https://www.google.com/maps/search/?api=1&query=1+Main+St.+%28rear%29%21+%2Ax%2A+%27y%27",
    );
  });

  it("buildPickNameHtml quotes the href the way html.escape(quote=True) does", () => {
    expect(buildPickNameHtml({ title: "T", url: `a"b'c`, is_music: false }, null)).toBe(
      '<a class="event-link" href="a&quot;b&#x27;c">T</a>',
    );
  });

  it("an empty spotify entry is falsy, as a Python empty dict is", () => {
    const pick = { title: "Band", url: "https://e", is_music: true };
    expect(buildPickNameHtml(pick, {} as never)).toBe('<a class="event-link" href="https://e">Band</a>');
  });
});

// --- Python bugs fixed in this port, not reproduced (TS-only; see the
// module docstring's divergence list and PR #72's notes) ---

describe("Python bugs fixed in the port", () => {
  it("renders a funnel stage that grew as +N%, not a double minus", () => {
    const dir = tmpPath();
    const selections = JSON.parse(readFileSync(join(REAL_WEEK_DIR, "_selections.json"), "utf8")) as Selections;
    selections.total_events_after_dedup = 10; // fewer candidates than the 88 listed
    writeFileSync(join(dir, "_selections.json"), JSON.stringify(selections));
    const html = renderReport(dir);
    expect(html).toContain('<div class="funnel-drop">+780% from candidates</div>');
    expect(html).not.toContain("−-");
    // A real drop still renders with the minus sign.
    expect(html).toMatch(/<div class="funnel-drop">−\d+% from listed<\/div>/);
  });

  it("renders a non-canonical category after the canonical ones instead of dropping it", () => {
    const day = statsDay("2026-06-22", "Monday", [statsEvent("Odd One", "🧪 Experimental"), statsEvent("A", MUSIC)], []);
    expect(buildCategories(day, new Set()).map((c) => c.label)).toEqual([MUSIC, "🧪 Experimental"]);
    const stats = buildStats({ days: [day], total_events_after_dedup: 2 }, {}, {});
    expect(stats.categories.map((row) => row.label)).toContain("🧪 Experimental");
  });

  it("gives a Top 3 time the multiple-showtimes '+' from its listing's note", () => {
    const day = onePickDay();
    day.events = [{ ...statsEvent("A Show", MUSIC), note: "Multiple showtimes Friday." }];
    expect(buildDayViewmodel(day, {}).top3[0]!.time_display).toBe("8:00 PM+");
  });

  it("falls back to the event link when matched_text is empty", () => {
    const pick = { title: "Band", url: "https://e", is_music: true };
    expect(buildPickNameHtml(pick, { spotify_url: "https://open.spotify.com/artist/x", matched_text: "" })).toBe(
      '<a class="event-link" href="https://e">Band</a>',
    );
  });

  it("keeps a comma inside a Meetup group's name", () => {
    expect(splitSourceField("Meetup: Food, Drink & Code")).toEqual(["Meetup: Food, Drink & Code"]);
    expect(splitSourceField("Meetup: Food, Drink & Code, Do215")).toEqual(["Meetup: Food, Drink & Code", "Do215"]);
    expect(splitSourceField("Meetup: A, WXPN")).toEqual(["Meetup: A", "WXPN"]);
    expect(splitSourceField("Meetup: A, Meetup: B")).toEqual(["Meetup: A", "Meetup: B"]);
    expect(splitSourceField("Do215, WXPN")).toEqual(["Do215", "WXPN"]);
  });

  it("rejects basic and week-date ISO forms for week keys and filenames", () => {
    expect(buildCanonicalUrl("2026-06-22")).not.toBeNull();
    expect(buildCanonicalUrl("20260622")).toBeNull();
    expect(buildCanonicalUrl("2026-W26-1")).toBeNull();
    const dir = tmpPath();
    for (const name of ["2026-06-22.html", "20260629.html", "2026-W27-1.html"]) writeFileSync(join(dir, name), "");
    const index = renderIndex(dir);
    expect(index).toContain("weeks/2026-06-22.html");
    expect(index).not.toContain("20260629");
    expect(index).not.toContain("W27");
  });
});
