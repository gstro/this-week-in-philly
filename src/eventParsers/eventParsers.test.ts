/**
 * Port of tests/test_parse_events.py, case for case, against the same
 * hand-trimmed fixtures in tests/fixtures/parse_events/. Each fixture has at
 * least one event inside its test week and one outside it.
 *
 * The ParseError tests matter most: a parser that finds zero of its expected
 * containers must throw, not return a plausible-looking [] -- the failure
 * mode that hid the R5 Productions breakage in production.
 *
 * Where the Python test pins behaviour this rewrite fixes, the test asserts
 * the fixed behaviour and says so. Tests for the fixed bugs themselves are in
 * the "fixed Python bugs" block at the end.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeJsonAsciiEscaped } from "../lib/json.js";
import { type Event, ParseError, resolveYear } from "./base.js";
import { parse as cinespeak } from "./cinespeak.js";
import { parse as do215 } from "./do215.js";
import { parse as gcal } from "./gcal.js";
import { PARSERS } from "./index.js";
import { parse as lightbox, parseIndex } from "./lightbox.js";
import { parse as luma } from "./luma.js";
import { parse as meetup } from "./meetup.js";
import { parse as pfs } from "./philadelphiaFilmSociety.js";
import { parse as philamoca } from "./philamoca.js";
import { parse as askAPunk } from "./phillyAskAPunk.js";
import { parse as phillyShows } from "./phillyShows.js";
import { parse as phillygoth } from "./phillygoth.js";
import { parse as r5 } from "./r5Productions.js";
import { parse as rotunda } from "./theRotunda.js";
import { parse as wxpn } from "./wxpn.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "tests", "fixtures", "parse_events");
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const WEEK_START = "2026-07-20";
const WEEK_END = "2026-07-26";

function find(events: Event[], predicate: (e: Event) => boolean): Event {
  const event = events.find(predicate);
  if (!event) throw new Error("no matching event");
  return event;
}
const titles = (events: Event[]): Set<string> => new Set(events.map((e) => e.title));
const dates = (events: Event[]): Set<string> => new Set(events.map((e) => e.date));

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe("registry", () => {
  it("keeps the Python CLI keys", () => {
    expect(Object.keys(PARSERS).sort()).toEqual(
      [
        "cinespeak",
        "do215",
        "gcal",
        "lightbox-film-center",
        "luma-ical",
        "meetup-ical",
        "philadelphia-film-society",
        "philamoca",
        "philly-ask-a-punk",
        "philly-shows",
        "phillygoth",
        "r5-productions",
        "the-rotunda",
        "wxpn",
      ].sort(),
    );
  });

  it("serialises with Python's key order and ensure_ascii escaping", () => {
    // collect_week.py writes events with json.dumps(indent=2); the optional
    // venue keys come last and only when present.
    const [event] = do215(read("do215-venue-objects.json"), "2026-08-03", "2026-08-09").filter(
      (e) => e.title === "Address already carries locality",
    );
    expect(Object.keys(event ?? {})).toEqual(["title", "venue", "date", "time", "cost", "url", "description", "venue_address", "venue_id"]);
    const coffee = find(gcal(read("gcal.json"), "2026-08-03", "2026-08-09"), (e) => e.title.includes("Coffee Talk"));
    expect(writeJsonAsciiEscaped(coffee)).toContain('"title": "\\u2615\\ufe0f Coffee Talk"');
  });
});

describe("resolveYear", () => {
  it("picks weekStart's own year in the ordinary case", () => {
    expect(resolveYear(7, 22, "2026-07-20")).toBe(2026);
  });
  it("rolls forward across a Dec/Jan boundary", () => {
    expect(resolveYear(1, 1, "2026-12-28")).toBe(2027);
  });
  it("rolls backward across a Dec/Jan boundary", () => {
    expect(resolveYear(12, 30, "2027-01-01")).toBe(2026);
  });
  it("returns null for Feb 29 outside a leap year", () => {
    expect(resolveYear(2, 29, "2026-06-01")).toBeNull();
  });
});

describe("r5-productions", () => {
  it("filters to the target week", () => {
    const events = r5(read("r5-productions.html"), WEEK_START, WEEK_END);
    expect(events).toHaveLength(2);
    expect(dates(events)).toEqual(new Set(["2026-07-22", "2026-07-24"]));
  });
  it("combines tagline and title", () => {
    const pavements = find(r5(read("r5-productions.html"), WEEK_START, WEEK_END), (e) => e.title.includes("PAVEMENTS"));
    expect(pavements.title).toBe("WXPN 88.5 Welcomes | PAVEMENTS (2024)");
    expect(pavements.venue).toBe("PhilaMOCA");
    expect(pavements.cost).toBe("$15.39");
  });
  it("throws on a structural mismatch", () => {
    expect(() => r5("<html><body>no events here</body></html>", WEEK_START, WEEK_END)).toThrow(ParseError);
  });
  it("resolves the year across a Dec/Jan boundary", () => {
    const html = `
      <div class="rhp-event">
        <div id="eventDate">Fri, Jan 1</div>
        <div class="rhp-event-info rhp-event__info--list">
          <a id="eventTitle" href="https://r5productions.com/event/nye-show/"><h2 class="rhp-event__title--list">New Year's Show</h2></a>
          <span class="rhp-event__time-text--list">8 pm</span>
          <span class="rhp-event__cost-text--list">$20</span>
          <a class="venueLink" title="First Unitarian Church">First Unitarian Church</a>
        </div>
      </div>`;
    const events = r5(html, "2026-12-28", "2027-01-03");
    expect(events).toHaveLength(1);
    expect(events[0]?.date).toBe("2027-01-01");
  });
});

describe("philamoca", () => {
  it("filters to the target week", () => {
    const events = philamoca(read("philamoca.html"), WEEK_START, WEEK_END);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: "Philadelphia Psychotronic Film Society", cost: "$5 At Door", date: "2026-07-20" });
  });
  it("throws on a structural mismatch", () => {
    expect(() => philamoca("<html><body>nothing</body></html>", WEEK_START, WEEK_END)).toThrow(ParseError);
  });
});

describe("phillygoth", () => {
  it("extracts every event in the window", () => {
    // A live run once under-collected this source (2 written when 7+ were in
    // the window) by reading manually and stopping early.
    const events = phillygoth(read("phillygoth.html"), WEEK_START, WEEK_END);
    expect(events).toHaveLength(4);
    expect(titles(events)).toEqual(
      new Set(["Stabbing Westward, Priest, & Acumen Nation", "Death Disco", "Heathen Playhouse: Carnal Carnival", "Phoenixville PRFM"]),
    );
  });
  it("throws on a structural mismatch", () => {
    expect(() => phillygoth("<html><body>nothing</body></html>", WEEK_START, WEEK_END)).toThrow(ParseError);
  });
  it("resolves the year across a Dec/Jan boundary when the year is absent", () => {
    const html = `
      <div class="em-event em-item">
        <h3 class="em-item-title"><a href="https://phillygoth.net/events/nye/">New Year's Show</a></h3>
        <div class="em-event-date">January 1</div>
        <div class="em-event-location"><a href="https://phillygoth.net/locations/x/">Some Venue</a></div>
      </div>`;
    const events = phillygoth(html, "2026-12-28", "2027-01-03");
    expect(events).toHaveLength(1);
    expect(events[0]?.date).toBe("2027-01-01");
  });
  it("trusts an explicit year when the source provides one", () => {
    const html = `
      <div class="em-event em-item">
        <h3 class="em-item-title"><a href="https://phillygoth.net/events/x/">Explicit Year Show</a></h3>
        <div class="em-event-date">December 30, 2026</div>
        <div class="em-event-location"><a href="https://phillygoth.net/locations/x/">Some Venue</a></div>
      </div>`;
    const events = phillygoth(html, "2026-12-28", "2027-01-03");
    expect(events).toHaveLength(1);
    expect(events[0]?.date).toBe("2026-12-30");
  });
});

describe("philly-shows", () => {
  it("filters to the target week", () => {
    const events = phillyShows(read("philly-shows.html"), WEEK_START, WEEK_END);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ venue: "Bonks Bar -3467 Richmond Street, Phila Pa 19134", time: "7:00 PM", cost: "$20" });
  });
  it("throws on a structural mismatch", () => {
    expect(() => phillyShows("<html><body>nothing</body></html>", WEEK_START, WEEK_END)).toThrow(ParseError);
  });
  it("returns [] on the site's own confirmed-empty marker", () => {
    // 2026-08-30: the Webflow collection rendered div.w-dyn-empty and no
    // div.showblock -- the site confirming its list is empty, not unknown markup.
    expect(phillyShows(read("philly-shows-empty-collection.html"), WEEK_START, WEEK_END)).toEqual([]);
  });
});

describe("the-rotunda", () => {
  it("filters to the target week and skips notmonth cells", () => {
    const events = rotunda(read("the-rotunda.html"), WEEK_START, WEEK_END, { contextDate: "2026-07-01" });
    expect(events).toHaveLength(2);
    expect(dates(events)).toEqual(new Set(["2026-07-20", "2026-07-21"]));
    expect(events.every((e) => e.venue.startsWith("The Rotunda"))).toBe(true);
  });
  it("throws without contextDate", () => {
    expect(() => rotunda(read("the-rotunda.html"), WEEK_START, WEEK_END)).toThrow(ParseError);
  });
  it("throws on a structural mismatch", () => {
    expect(() => rotunda("<html><body>nothing</body></html>", WEEK_START, WEEK_END, { contextDate: "2026-07-01" })).toThrow(ParseError);
  });
});

describe("philly-ask-a-punk", () => {
  it("filters and handles multidate", () => {
    const events = askAPunk(read("philly-ask-a-punk.json"), WEEK_START, WEEK_END);
    expect(titles(events)).toEqual(new Set(["BLEEDER (BMG), LOVERGIRL (MPLS), MYSTERY DUNGEONS, B00B", "Multi-day Festival"]));
  });
  it("throws on invalid JSON", () => {
    expect(() => askAPunk("not json", WEEK_START, WEEK_END)).toThrow(ParseError);
  });
  it("throws on non-array JSON", () => {
    expect(() => askAPunk('{"not": "an array"}', WEEK_START, WEEK_END)).toThrow(ParseError);
  });
  it("uses the correct offset across the EDT/EST transition", () => {
    // Both encode 20:00 UTC; a fixed -4h offset would say 4:00 PM in November.
    const raw = JSON.stringify([
      { title: "Summer Show (EDT)", start_datetime: 1785960000, place: { name: "Test Venue" }, slug: "a" },
      { title: "Winter Show (EST)", start_datetime: 1794772800, place: { name: "Test Venue" }, slug: "b" },
    ]);
    expect(askAPunk(raw, "2026-08-01", "2026-08-09")).toMatchObject([{ date: "2026-08-05", time: "4:00 PM" }]);
    expect(askAPunk(raw, "2026-11-10", "2026-11-20")).toMatchObject([{ date: "2026-11-15", time: "3:00 PM" }]);
  });
});

describe("luma-ical", () => {
  it("filters to the target week", () => {
    const events = luma(read("luma.ics"), WEEK_START, WEEK_END);
    expect(events).toHaveLength(2);
    expect(dates(events)).toEqual(new Set(["2026-07-22", "2026-07-23"]));
  });
  it("unescapes iCal commas in LOCATION", () => {
    const happyHour = find(luma(read("luma.ics"), WEEK_START, WEEK_END), (e) => e.title.includes("Happy Hour"));
    expect(happyHour.venue).toBe("Morgan's Pier, 221 N Columbus Blvd, Philadelphia, PA 19106, USA");
  });
  it("flags a URL-only LOCATION as online", () => {
    const online = find(luma(read("luma.ics"), WEEK_START, WEEK_END), (e) => e.title.includes("Online-Only"));
    expect(online.venue).toBe("(online / see description)");
    expect(online.url).toBe("https://luma.com/event/evt-online-only");
  });
  it("returns [] for an empty calendar, not an error", () => {
    expect(luma("BEGIN:VCALENDAR\nEND:VCALENDAR\n", WEEK_START, WEEK_END)).toEqual([]);
  });
  it("uses the correct offset across the EDT/EST transition", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART:20260805T200000Z",
      "SUMMARY:Summer Show (EDT)",
      "LOCATION:Test Venue",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART:20261115T200000Z",
      "SUMMARY:Winter Show (EST)",
      "LOCATION:Test Venue",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");
    expect(luma(ics, "2026-08-01", "2026-08-09")).toMatchObject([{ date: "2026-08-05", time: "4:00 PM" }]);
    expect(luma(ics, "2026-11-10", "2026-11-20")).toMatchObject([{ date: "2026-11-15", time: "3:00 PM" }]);
  });
  it("throws when the response isn't iCal at all", () => {
    expect(() => luma("<html><body>404 not found</body></html>", WEEK_START, WEEK_END)).toThrow(ParseError);
  });
});

describe("meetup-ical", () => {
  it("filters to the target week", () => {
    const events = meetup(read("meetup.ics"), WEEK_START, WEEK_END);
    expect(events).toHaveLength(2);
    expect(dates(events)).toEqual(new Set(["2026-07-21", "2026-07-23"]));
  });
  it("flags a missing LOCATION as online", () => {
    expect(find(meetup(read("meetup.ics"), WEEK_START, WEEK_END), (e) => e.title.includes("SHARK")).venue).toBe("(online)");
  });
  it("unescapes iCal commas in LOCATION", () => {
    const party = find(meetup(read("meetup.ics"), WEEK_START, WEEK_END), (e) => e.title.includes("Watch Party"));
    expect(party.venue).toBe("PhilaMOCA, 531 N 12th St, Philadelphia, PA 19123");
  });
  it("returns [] for an empty calendar, not an error", () => {
    expect(meetup("BEGIN:VCALENDAR\nEND:VCALENDAR\n", WEEK_START, WEEK_END)).toEqual([]);
  });
  it("throws when the response isn't iCal at all", () => {
    expect(() => meetup("<html><body>404 not found</body></html>", WEEK_START, WEEK_END)).toThrow(ParseError);
  });
});

describe("do215", () => {
  const start = "2026-08-03";
  const end = "2026-08-09";
  const fixture = (): Event[] => do215(read("do215.json"), start, end);
  const venueEvents = (): Map<string, Event> =>
    new Map(do215(read("do215-venue-objects.json"), start, end).map((e) => [e.title, e]));

  it("filters to the target week", () => {
    const events = fixture();
    expect(events).toHaveLength(3);
    expect(titles(events)).toEqual(new Set(["Drink Responsibly", "Happy Together 2026 Tour", "KALEO - Way Down We Go Tour"]));
  });
  it("dedupes by event id", () => {
    expect(fixture().filter((e) => e.title === "Happy Together 2026 Tour")).toHaveLength(1);
  });
  it("drops is_ongoing events even when in the window", () => {
    expect(do215(read("do215.json"), "2026-06-01", "2026-06-10")).toEqual([]);
  });
  it("drops stale entries outside the window even when not ongoing", () => {
    expect(do215(read("do215.json"), "2026-05-20", "2026-05-26")).toEqual([]);
  });
  it("uses tz_adjusted_begin_date, not the mis-offset begin_time", () => {
    expect(find(fixture(), (e) => e.title.includes("Happy Together"))).toMatchObject({ date: "2026-08-05", time: "7:00 PM" });
  });
  it("formats the venue with city and state when present", () => {
    expect(find(fixture(), (e) => e.title.includes("Happy Together")).venue).toBe("Lansdowne Theater, Lansdowne, PA");
  });
  it("omits the city when the venue has none", () => {
    expect(find(fixture(), (e) => e.title === "Drink Responsibly").venue).toBe("Winston On The Water");
  });
  it("appends the address to the venue title rather than replacing it", () => {
    // Venue 511812 "Nikki Lopez" reads like a person's name but is a real DIY
    // venue; appending is the only lossless move (see do215.ts).
    expect(venueEvents().get("Address already carries locality")).toMatchObject({
      venue: "Nikki Lopez, 304 South St, Philadelphia, PA 19147",
      venue_address: "304 South St, Philadelphia, PA 19147",
      venue_id: "511812",
    });
  });
  it("composes locality onto a bare street address", () => {
    expect(venueEvents().get("Bare street address")).toMatchObject({
      venue_address: "121 N Christopher Columbus Blvd, Philadelphia, PA 19106",
      venue: "Cherry Street Pier, 121 N Christopher Columbus Blvd, Philadelphia, PA 19106",
    });
  });
  it("does not repeat a venue name that is also its address", () => {
    expect(venueEvents().get("Address restates the title")?.venue).toBe("Upper Merion Township Building Park");
  });
  it("treats null and blank addresses as absent", () => {
    const events = venueEvents();
    for (const title of ["Null address falls back to city and state", "Empty and padded address"]) {
      const event = events.get(title);
      expect(event, title).toBeDefined();
      expect(event).not.toHaveProperty("venue_address");
      expect(event?.venue.endsWith(", Philadelphia, PA"), title).toBe(true);
    }
  });
  it("omits venue_id when the object has none", () => {
    expect(venueEvents().get("Venue object has no id at all")).not.toHaveProperty("venue_id");
  });
  it("marks free events explicitly", () => {
    expect(find(fixture(), (e) => e.title === "Drink Responsibly").cost).toBe("Free");
  });
  it("builds the full URL from the permalink", () => {
    expect(find(fixture(), (e) => e.title.includes("Happy Together")).url).toBe(
      "https://do215.com/events/2026/8/5/happy-together-2026-tour-tickets",
    );
  });
  it("throws when the events key is missing", () => {
    expect(() => do215(JSON.stringify({ paging: {} }), start, end)).toThrow(ParseError);
  });
  it("throws on invalid JSON", () => {
    expect(() => do215("not json at all", start, end)).toThrow(ParseError);
  });
  it("treats an empty events list as valid", () => {
    expect(do215(JSON.stringify({ events: [] }), start, end)).toEqual([]);
  });
});

describe("wxpn", () => {
  const start = "2026-08-03";
  const end = "2026-08-09";
  const fixture = (): Event[] => wxpn(read("wxpn.json"), start, end);

  it("filters to the target week", () => {
    const events = fixture();
    expect(events).toHaveLength(5);
    expect(titles(events).has("Samantha Fish")).toBe(false);
    expect(titles(events).has("Malformed Entry, No Date")).toBe(false);
  });
  it("unescapes HTML entities in the title", () => {
    expect(find(fixture(), (e) => e.title.includes("Devin Tuel")).title).toBe("Devin Tuel & Stephen Harms / JR Everhart / Joey Sweeney");
  });
  it("leaves time blank, not a fake midnight", () => {
    expect(find(fixture(), (e) => e.title.includes("PINKNOISE"))).toMatchObject({ time: "", date: "2026-08-03" });
  });
  it("skips entries with no acf.date", () => {
    expect(fixture().every((e) => e.title !== "Malformed Entry, No Date")).toBe(true);
  });
  it("falls back to external_link when the wp link is missing", () => {
    expect(find(fixture(), (e) => e.title.includes("No wp link")).url).toBe("https://tickets.example.com/no-wp-link");
  });
  it("carries external_artist as the description", () => {
    expect(find(fixture(), (e) => e.title.includes("Isley Brothers")).description).toBe("The Isley Brothers / Stephanie Mills");
  });
  it("throws when the response is not a list", () => {
    expect(() => wxpn(JSON.stringify({ error: "not found" }), start, end)).toThrow(ParseError);
  });
  it("throws on invalid JSON", () => {
    expect(() => wxpn("not json", start, end)).toThrow(ParseError);
  });
  it("treats an empty list as valid", () => {
    expect(wxpn("[]", start, end)).toEqual([]);
  });
});

describe("cinespeak", () => {
  const fixture = (start = "2026-08-03", end = "2026-08-09"): Event[] => cinespeak(read("cinespeak.html"), start, end);

  it("filters to the target week", () => {
    const events = fixture();
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("Crooklyn (1994)");
  });
  it("takes the venue from the maps link, not the ticket link", () => {
    expect(fixture()[0]).toMatchObject({
      venue: "Two Locals Brewing",
      url: "https://cinespeak.eventive.org/schedule/6a16f9b8b94123950ecaa48d",
    });
  });
  it("handles irregular whitespace in the date string", () => {
    expect(fixture()[0]).toMatchObject({ date: "2026-08-03", time: "7:00 PM" });
  });
  it("carries the tag as the description when present", () => {
    expect(fixture()[0]?.description).toBe("Short Narrative");
  });
  it("handles a missing tag", () => {
    expect(find(fixture("2026-08-10", "2026-08-16"), (e) => e.title.includes("Elio")).description).toBe("");
  });
  it("preserves a sold-out marker in the title", () => {
    expect(fixture("2026-08-17", "2026-08-23").some((e) => e.title.includes("*SOLD OUT*"))).toBe(true);
  });
  it("throws on a structural mismatch", () => {
    expect(() => cinespeak("<html><body>nothing here</body></html>", "2026-08-03", "2026-08-09")).toThrow(ParseError);
  });
});

describe("lightbox-film-center", () => {
  const start = "2026-07-27";
  const end = "2026-08-02";
  const fixture = (): Event[] => lightbox(read("lightbox.json"), start, end);

  it("parseIndex extracts title and href", () => {
    const candidates = parseIndex(read("lightbox-index.html"));
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toEqual({
      title: "O'er the Land & Bestiary",
      href: "https://www.lightboxfilmcenter.org/events/oer-the-land-bestiary",
    });
  });
  it("parseIndex throws on a structural mismatch", () => {
    expect(() => parseIndex("<html><body>nothing here</body></html>")).toThrow(ParseError);
  });
  it("filters to the target week using the detail page's JSON-LD", () => {
    const events = fixture();
    expect(events).toHaveLength(2);
    expect(titles(events)).toEqual(new Set(["O'er the Land & Bestiary", "Physical Media Fair"]));
  });
  it("takes the year from the detail JSON-LD", () => {
    expect(find(fixture(), (e) => e.title.includes("Bestiary"))).toMatchObject({ date: "2026-07-29", time: "7:00 PM" });
  });
  it("combines venue name and address", () => {
    expect(find(fixture(), (e) => e.title.includes("Bestiary")).venue).toBe(
      "Moore College of Art & Design, 1916 Race St, Philadelphia, PA 19103, USA",
    );
  });
  it("unescapes HTML entities from the templated JSON-LD", () => {
    expect(find(fixture(), (e) => e.title.includes("Bestiary")).title).toBe("O'er the Land & Bestiary");
  });
  it("skips a candidate whose detail fetch failed", () => {
    expect(fixture().every((e) => e.title !== "Broken Detail Fetch")).toBe(true);
  });
  it("skips a candidate whose detail page has no JSON-LD", () => {
    expect(fixture().every((e) => e.title !== "Detail Page With No JSON-LD")).toBe(true);
  });
  it("throws on invalid top-level JSON", () => {
    expect(() => lightbox("not json", start, end)).toThrow(ParseError);
  });
  it("throws when not a list", () => {
    expect(() => lightbox(JSON.stringify({ not: "a list" }), start, end)).toThrow(ParseError);
  });
  it("treats an empty candidate list as valid", () => {
    expect(lightbox("[]", start, end)).toEqual([]);
  });
});

describe("philadelphia-film-society", () => {
  const start = "2026-08-03";
  const end = "2026-08-09";
  const fixture = (): Event[] => pfs(read("philadelphia-film-society.json"), start, end);

  it("filters to the target week and extracts all venues", () => {
    const events = fixture();
    expect(events).toHaveLength(5);
    expect(titles(events)).toEqual(
      new Set(["Compensation", "The Odyssey (2026)", "Vanishing Point", "Sheep in the Box (2026)", "The Outlaw Josey Wales"]),
    );
  });
  it("joins multiple showtimes for one film", () => {
    expect(find(fixture(), (e) => e.title.includes("Odyssey"))).toMatchObject({
      time: "12:00 PM, 3:30 PM, 7:30 PM",
      date: "2026-08-05",
    });
  });
  it("combines the collector-provided venue name and address", () => {
    expect(find(fixture(), (e) => e.title === "Compensation")).toMatchObject({
      venue: "PFS Film Society Center, 1412 Chestnut Street, Philadelphia, PA 19102",
      url: "https://www.fandango.com/pfs-film-society-center-aaxow/theater-page",
    });
  });
  it("carries rating and runtime in the description", () => {
    expect(find(fixture(), (e) => e.title === "Compensation").description).toBe("Rated Not Rated. Runtime: 1 hr 31 min.");
  });
  it("skips an entry whose fetch failed", () => {
    expect(fixture().every((e) => e.title !== "Sheep in the Box" || e.date !== "2026-08-08")).toBe(true);
  });
  it("treats a genuinely dark day as valid", () => {
    expect(
      fixture().every((e) => e.venue !== "PFS East Theater, 125 S. 2nd Street, Philadelphia, PA 19106" || e.date !== "2026-08-08"),
    ).toBe(true);
  });
  it("throws on invalid JSON", () => {
    expect(() => pfs("not json", start, end)).toThrow(ParseError);
  });
  it("throws when not a list", () => {
    expect(() => pfs(JSON.stringify({ not: "a list" }), start, end)).toThrow(ParseError);
  });
  it("treats an empty entry list as valid", () => {
    expect(pfs("[]", start, end)).toEqual([]);
  });
});

describe("gcal", () => {
  const start = "2026-08-03";
  const end = "2026-08-09";
  const fixture = (): Event[] => gcal(read("gcal.json"), start, end);

  it("gives every event a non-empty url", () => {
    // THE regression guard: on 2026-08-01 an improvised conversion wrote all
    // 15 events across the three calendars with "url": "", silently.
    const events = fixture();
    expect(events.length).toBeGreaterThan(0);
    expect(events.filter((e) => !e.url)).toEqual([]);
  });
  it("filters to the target week and skips cancelled and malformed events", () => {
    expect(titles(fixture())).toEqual(
      new Set(["☕️ Coffee Talk", "Super Troopers 3 (2026)", "Event With No Location Field", "Event With No htmlLink"]),
    );
  });
  it("parses timed events with local time", () => {
    expect(find(fixture(), (e) => e.title.includes("Coffee Talk"))).toMatchObject({
      date: "2026-08-03",
      time: "6:00 PM",
      url: "https://www.google.com/calendar/event?eid=evt-timed-inweek",
    });
  });
  it("gives all-day events a blank time, not a fake midnight", () => {
    expect(find(fixture(), (e) => e.title.includes("Super Troopers"))).toMatchObject({ date: "2026-08-07", time: "" });
  });
  it("falls back to the calendar venue when the event has no location", () => {
    expect(find(fixture(), (e) => e.title === "Event With No Location Field").venue).toBe(
      "Iffy Books, 404 S. 20th St., Philadelphia, PA 19146",
    );
  });
  it("falls back to the calendar url when the event has no htmlLink", () => {
    expect(find(fixture(), (e) => e.title === "Event With No htmlLink").url).toBe("https://iffybooks.net/");
  });
  it("throws when the items key is missing", () => {
    expect(() => gcal(JSON.stringify({ venue: "x" }), start, end)).toThrow(ParseError);
  });
  it("throws on invalid JSON", () => {
    expect(() => gcal("not json", start, end)).toThrow(ParseError);
  });
  it("treats empty items as valid", () => {
    expect(gcal(JSON.stringify({ items: [] }), start, end)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fixed Python bugs. Each case is behaviour the Python gets wrong; see the
// "Divergences from the Python" note in the named module.
// ---------------------------------------------------------------------------

describe("fixed Python bugs", () => {
  it("r5: an event with no date of its own is skipped, not given the previous event's date", () => {
    const html = `
      <div class="rhp-event">
        <div id="eventDate">Wed, Jul 22</div>
        <div class="rhp-event__info--list"><a id="eventTitle" href="/a"><h2>Dated Show</h2></a></div>
      </div>
      <div class="rhp-event">
        <div class="rhp-event__info--list"><a id="eventTitle" href="/b"><h2>Undated Show</h2></a></div>
      </div>`;
    expect(r5(html, WEEK_START, WEEK_END).map((e) => e.title)).toEqual(["Dated Show"]);
  });

  it("do215: a null title skips the event; a null permalink or venue title reads as empty, never 'None'", () => {
    const raw = JSON.stringify({
      events: [
        { id: 1, title: null, tz_adjusted_begin_date: "2026-08-05T19:00:00-04:00", permalink: "/x" },
        { id: 2, title: "Real Show", tz_adjusted_begin_date: "2026-08-05T19:00:00-04:00", permalink: null, venue: { title: null, city: "Philadelphia" } },
      ],
    });
    const events = do215(raw, "2026-08-03", "2026-08-09");
    expect(events).toEqual([
      { title: "Real Show", venue: ", Philadelphia", date: "2026-08-05", time: "7:00 PM", cost: "", url: "", description: "" },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("has no title"));
  });

  it("do215: a non-object venue skips only that event", () => {
    const raw = JSON.stringify({
      events: [
        { id: 1, title: "Bad Venue", tz_adjusted_begin_date: "2026-08-05T19:00:00-04:00", venue: "Somewhere" },
        { id: 2, title: "Good", tz_adjusted_begin_date: "2026-08-05T19:00:00-04:00" },
      ],
    });
    expect(do215(raw, "2026-08-03", "2026-08-09").map((e) => e.title)).toEqual(["Good"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("philly-ask-a-punk: string tags are used as-is, not split into characters", () => {
    const raw = JSON.stringify([{ title: "Show", start_datetime: 1784671200, tags: "punk", slug: "s" }]);
    expect(askAPunk(raw, WEEK_START, WEEK_END)[0]?.description).toBe("punk");
  });

  it("philly-ask-a-punk: a non-object or bad-timestamp record is skipped, not fatal", () => {
    const raw = JSON.stringify([
      "garbage",
      { title: "String Timestamp", start_datetime: "1784671200" },
      { title: "Good", start_datetime: 1784671200, slug: "good", tags: ["punk", "hardcore"] },
    ]);
    const events = askAPunk(raw, WEEK_START, WEEK_END);
    expect(events.map((e) => e.title)).toEqual(["Good"]);
    expect(events[0]).toMatchObject({ url: "https://philly.askapunk.net/event/good", description: "punk / hardcore" });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("philly-ask-a-punk: a multidate event that began before the week is dated the week's first day", () => {
    // Python kept its pre-week start date (2026-07-19), putting an "in-week"
    // event on a day outside the week.
    const festival = find(askAPunk(read("philly-ask-a-punk.json"), WEEK_START, WEEK_END), (e) => e.title === "Multi-day Festival");
    expect(festival).toMatchObject({ date: WEEK_START, time: "" });
  });

  it("lightbox: a PostalAddress object is formatted, and an @type array is accepted", () => {
    const ld = {
      "@context": "https://schema.org",
      "@type": ["Event"],
      name: "Film &amp; Talk",
      startDate: "2026-07-29T19:00:00-04:00",
      location: {
        "@type": "Place",
        name: "Bok Auditorium",
        address: { "@type": "PostalAddress", streetAddress: "800 Mifflin St", addressLocality: "Philadelphia", addressRegion: "PA", postalCode: "19148", addressCountry: "US" },
      },
    };
    const detail = `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head></html>`;
    const raw = JSON.stringify([{ title: "Index Title", href: "https://example.org/e", detail_html: detail }]);
    expect(lightbox(raw, "2026-07-27", "2026-08-02")).toEqual([
      {
        title: "Film & Talk",
        venue: "Bok Auditorium, 800 Mifflin St, Philadelphia, PA 19148, US",
        date: "2026-07-29",
        time: "7:00 PM",
        cost: "",
        url: "https://example.org/e",
        description: "",
      },
    ]);
  });

  it("meetup: an impossible hour skips that event instead of failing the source", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART;TZID=America/New_York:20260721T250000",
      "SUMMARY:Bad Hour",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART;TZID=America/New_York:20260722T190000",
      "SUMMARY:Good",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(meetup(ics, WEEK_START, WEEK_END).map((e) => e.title)).toEqual(["Good"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no such time 25:0"));
  });

  it("luma: an impossible month skips that event instead of failing the source", () => {
    const ics = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20261322T200000Z\nSUMMARY:Bad\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20260722T200000Z\nSUMMARY:Good\nEND:VEVENT\nEND:VCALENDAR";
    expect(luma(ics, WEEK_START, WEEK_END).map((e) => e.title)).toEqual(["Good"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("cinespeak: an impossible minute skips that screening instead of failing the source", () => {
    const card = (title: string, when: string): string =>
      `<li class="wp-block-post event"><h2 class="wp-block-post-title"><a href="/${title}">${title}</a></h2><p class="wp-block-paragraph">${when}</p></li>`;
    const html = `<ul>${card("Bad", "July 22, 2026 @ 7:75 pm")}${card("Good", "July 22, 2026 @ 7:45 pm")}</ul>`;
    expect(cinespeak(html, WEEK_START, WEEK_END)).toMatchObject([{ title: "Good", time: "7:45 PM" }]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("philadelphia-film-society: an impossible showtime skips that film, not the source", () => {
    const text = "Bad Film\n\nRated:\nR\nRuntime:\n1 hr\n\nStandard\n7:99p\nGood Film\n\nRated:\nPG\nRuntime:\n2 hr\n\nStandard\n7:30p";
    const raw = JSON.stringify([{ venue_name: "PFS", venue_address: "", theater_url: "u", context_date: "2026-07-22", rendered_text: text }]);
    expect(pfs(raw, WEEK_START, WEEK_END)).toMatchObject([{ title: "Good Film", time: "7:30 PM" }]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("wxpn: a non-object acf skips that post, not the source", () => {
    const raw = JSON.stringify([
      { title: { rendered: "Bad" }, acf: "nope" },
      { title: { rendered: "Good" }, acf: { date: "2026-07-22 00:00:00", price: false } },
    ]);
    expect(wxpn(raw, WEEK_START, WEEK_END)).toMatchObject([{ title: "Good", cost: "" }]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("gcal: a non-object start skips that event, not the source", () => {
    const raw = JSON.stringify({ items: [{ summary: "Bad", start: "2026-07-22" }, { summary: "Good", start: { date: "2026-07-22" }, htmlLink: "h" }] });
    expect(gcal(raw, WEEK_START, WEEK_END).map((e) => e.title)).toEqual(["Good"]);
    expect(warn).toHaveBeenCalledOnce();
  });
});
