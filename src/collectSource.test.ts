// Tests for collectSource.ts: fetch orchestration (pagination, per-day loops,
// partial vs total failure) against canned responses. The parsers it hands
// results to have their own real-capture tests in eventParsers/.

import { Response } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  COLLECTORS,
  MAX_PAGES_PER_DAY,
  MAX_PAGES_WXPN,
  buildOutput,
  collectDo215,
  collectLightbox,
  collectPhiladelphiaFilmSociety,
  collectWxpn,
  datesBetween,
  easternTimestamp,
} from "./collectSource.js";
import { ParseError } from "./eventParsers/index.js";
import { fetchPageText } from "./fetchPageText.js";
import { HttpError, get } from "./lib/http.js";

vi.mock("./lib/http.js", async (importActual) => ({ ...(await importActual<object>()), get: vi.fn() }));
vi.mock("./fetchPageText.js", () => ({ fetchPageText: vi.fn() }));

const listEvents = vi.fn();
vi.mock("./common.js", () => ({
  CALENDAR_TIMEZONE: "America/New_York",
  getCalendarService: (): object => ({ events: { list: listEvents } }),
}));

type Canned = string | object | Error | { body: object; headers: Record<string, string> };

/** Route `get` by exact URL; an unexpected URL fails the test. */
function serve(routes: Record<string, Canned>): string[] {
  const requested: string[] = [];
  vi.mocked(get).mockImplementation((url: string) => {
    requested.push(url);
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected URL requested: ${url}`);
    if (route instanceof Error) return Promise.reject(route);
    if (typeof route === "string") return Promise.resolve(new Response(route));
    if ("headers" in route && "body" in route) return Promise.resolve(new Response(JSON.stringify(route.body), { headers: route.headers }));
    return Promise.resolve(new Response(JSON.stringify(route)));
  });
  return requested;
}

// A do215 event the real parser accepts (shape from tests/fixtures/parse_events).
function do215Event(id: number, day: string): object {
  return { id, title: `Event ${String(id)}`, permalink: `/events/${String(id)}`, tz_adjusted_begin_date: `${day}T20:00:00-04:00`, venue: { title: "Venue" } };
}

beforeEach(() => {
  vi.mocked(get).mockReset();
  vi.mocked(fetchPageText).mockReset();
  listEvents.mockReset();
});

describe("dates", () => {
  it("lists every date in the window, across a month end", () => {
    expect(datesBetween("2026-09-28", "2026-10-04")).toEqual([
      "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
    ]);
  });

  it("gives Philadelphia's offset for the day, DST included", () => {
    expect(easternTimestamp("2026-10-12", "00:00:00")).toBe("2026-10-12T00:00:00-04:00");
    expect(easternTimestamp("2026-12-06", "23:59:59.999")).toBe("2026-12-06T23:59:59.999-05:00");
  });
});

describe("do215", () => {
  const base = "https://do215.com/events/2026/10/12.json";

  it("pages each day until total_pages, building unpadded day URLs", async () => {
    const requested = serve({
      [base]: { events: [do215Event(1, "2026-10-12")], paging: { total_pages: 2 } },
      [`${base}?page=2`]: { events: [do215Event(2, "2026-10-12")], paging: { total_pages: 2 } },
      "https://do215.com/events/2026/10/13.json": { events: [], paging: { total_pages: 1 } },
    });
    const { events, failed } = await collectDo215("2026-10-12", "2026-10-13");
    expect(requested).toEqual([base, `${base}?page=2`, "https://do215.com/events/2026/10/13.json"]);
    expect(events.map((event) => event.title)).toEqual(["Event 1", "Event 2"]);
    expect(failed).toEqual([]);
  });

  it(`stops at ${String(MAX_PAGES_PER_DAY)} pages a day whatever total_pages says`, async () => {
    const routes: Record<string, Canned> = {};
    for (let page = 1; page <= 8; page++) {
      routes[page === 1 ? base : `${base}?page=${String(page)}`] = { events: [do215Event(page, "2026-10-12")], paging: { total_pages: 99 } };
    }
    const requested = serve(routes);
    await collectDo215("2026-10-12", "2026-10-12");
    expect(requested).toHaveLength(MAX_PAGES_PER_DAY);
  });

  it("records a failed page or a non-object page and carries on", async () => {
    serve({
      [base]: { events: [do215Event(1, "2026-10-12")], paging: { total_pages: 3 } },
      [`${base}?page=2`]: new HttpError(503, `${base}?page=2`, "Service Unavailable"),
      [`${base}?page=3`]: "[1, 2]",
    });
    const { events, failed } = await collectDo215("2026-10-12", "2026-10-12");
    expect(events).toHaveLength(1);
    expect(failed).toEqual([
      `${base}?page=2 (HTTP 503 Service Unavailable for ${base}?page=2)`,
      `${base}?page=3 (expected a JSON object)`,
    ]);
  });

  it("throws when every request failed instead of returning nothing", async () => {
    serve({ [base]: new Error("down"), "https://do215.com/events/2026/10/13.json": new Error("down") });
    await expect(collectDo215("2026-10-12", "2026-10-13")).rejects.toThrow(
      new ParseError(`every request failed (2 attempted); first: ${base} (down)`),
    );
  });

  it("an empty week with no failures is a real empty result", async () => {
    serve({ [base]: { events: [], paging: { total_pages: 1 } } });
    expect(await collectDo215("2026-10-12", "2026-10-12")).toEqual({ events: [], failed: [] });
  });
});

describe("wxpn", () => {
  const page = (n: number): string => `https://backend.xpn.org/wp-json/wp/v2/event?per_page=100&page=${String(n)}`;

  it("pages until X-WP-TotalPages", async () => {
    const requested = serve({
      [page(1)]: { body: [], headers: { "X-WP-TotalPages": "2" } },
      [page(2)]: { body: [], headers: { "X-WP-TotalPages": "2" } },
    });
    expect(await collectWxpn("2026-10-12", "2026-10-18")).toEqual({ events: [], failed: [] });
    expect(requested).toEqual([page(1), page(2)]);
  });

  it(`stops at ${String(MAX_PAGES_WXPN)} pages`, async () => {
    const routes: Record<string, Canned> = {};
    for (let n = 1; n <= 8; n++) routes[page(n)] = { body: [], headers: { "X-WP-TotalPages": "99" } };
    expect(serve(routes)).toBeDefined();
    await collectWxpn("2026-10-12", "2026-10-18");
    expect(vi.mocked(get)).toHaveBeenCalledTimes(MAX_PAGES_WXPN);
  });

  it("a garbage page count means no further pages, not a crash", async () => {
    const requested = serve({ [page(1)]: { body: [], headers: { "X-WP-TotalPages": "lots" } } });
    await collectWxpn("2026-10-12", "2026-10-18");
    expect(requested).toEqual([page(1)]);
  });

  it("a non-array page counts as a failed request", async () => {
    serve({ [page(1)]: { code: "rest_error" } });
    await expect(collectWxpn("2026-10-12", "2026-10-18")).rejects.toThrow(/every request failed .*expected a JSON array, got object/);
  });
});

describe("lightbox", () => {
  const home = "https://www.lightboxfilmcenter.org/";
  // Minimal index markup parseIndex recognises (see eventParsers/lightbox.test.ts).
  const index = (hrefs: string[]): string =>
    `<html><body>${hrefs.map((href, i) => `<div data-hook="events-card"><a data-hook="title" href="${href}">Film ${String(i)}</a></div>`).join("")}</body></html>`;

  it("fetches the index, then every detail page, keeping going past a broken one", async () => {
    const a = "https://www.lightboxfilmcenter.org/event-details/a";
    const b = "https://www.lightboxfilmcenter.org/event-details/b";
    const requested = serve({ [home]: index([a, b]), [a]: new Error("timeout"), [b]: "<html></html>" });
    const { failed } = await collectLightbox("2026-10-12", "2026-10-18");
    expect(requested).toEqual([home, a, b]);
    expect(failed).toEqual([`${a} (timeout)`]);
  });

  it("a failed index fetch is a ParseError", async () => {
    serve({ [home]: new Error("down") });
    await expect(collectLightbox("2026-10-12", "2026-10-18")).rejects.toThrow(
      new ParseError("failed to fetch or parse the lightbox-film-center homepage: down"),
    );
  });

  it("a structurally broken index is a ParseError", async () => {
    serve({ [home]: "<html><body>redesigned</body></html>" });
    await expect(collectLightbox("2026-10-12", "2026-10-18")).rejects.toBeInstanceOf(ParseError);
  });
});

describe("philadelphia film society", () => {
  it("renders all 3 venues on the week's Wednesday and Saturday, isolating failures", async () => {
    vi.mocked(fetchPageText).mockImplementation((url: string) =>
      url.includes("bourse") && url.endsWith("2026-10-17") ? Promise.reject(new Error("timeout")) : Promise.resolve("no showtimes"),
    );
    const { failed } = await collectPhiladelphiaFilmSociety("2026-10-12", "2026-10-18");
    const urls = vi.mocked(fetchPageText).mock.calls.map(([url]) => url);
    expect(urls).toHaveLength(6);
    expect(urls.filter((url) => url.endsWith("?date=2026-10-14"))).toHaveLength(3);
    expect(urls.filter((url) => url.endsWith("?date=2026-10-17"))).toHaveLength(3);
    expect(failed).toEqual(["https://www.fandango.com/pfs-bourse-theater-aadjc/theater-page?date=2026-10-17 (timeout)"]);
  });

  it("throws when every render failed", async () => {
    vi.mocked(fetchPageText).mockRejectedValue(new Error("no browser"));
    await expect(collectPhiladelphiaFilmSociety("2026-10-12", "2026-10-18")).rejects.toThrow(/every request failed \(6 attempted\)/);
  });
});

describe("venue calendars", () => {
  const item = { summary: "Zine night", start: { dateTime: "2026-10-14T19:00:00-04:00" }, htmlLink: "https://calendar.google.com/x", status: "confirmed" };

  it("pages through the Calendar API over the Eastern week and fills venue gaps", async () => {
    listEvents
      .mockResolvedValueOnce({ data: { items: [item], nextPageToken: "p2" } })
      .mockResolvedValueOnce({ data: { items: [{ ...item, summary: "Reading" }] } });
    const { events, failed } = await COLLECTORS["iffy-books"]!("2026-10-12", "2026-10-18");
    expect(failed).toEqual([]);
    expect(events.map((event) => [event.title, event.venue])).toEqual([
      ["Zine night", "Iffy Books, 404 S. 20th St., Philadelphia, PA 19146"],
      ["Reading", "Iffy Books, 404 S. 20th St., Philadelphia, PA 19146"],
    ]);
    expect(listEvents.mock.calls[0]?.[0]).toMatchObject({
      calendarId: "uim84nkq226inhhqa44v98foigjak9us@import.calendar.google.com",
      timeMin: "2026-10-12T00:00:00-04:00",
      timeMax: "2026-10-18T23:59:59.999-04:00",
      singleEvents: true,
    });
    expect(listEvents.mock.calls[1]?.[0]).toMatchObject({ pageToken: "p2" });
  });

  it("keeps the pages already read when a later page fails", async () => {
    listEvents.mockResolvedValueOnce({ data: { items: [item], nextPageToken: "p2" } }).mockRejectedValueOnce(new Error("quota"));
    const { events, failed } = await COLLECTORS["wooden-shoe-books"]!("2026-10-12", "2026-10-18");
    expect(events).toHaveLength(1);
    expect(failed).toEqual(["wooden-shoe-books calendar page (token=p2) (quota)"]);
  });

  it("throws when the first page fails (the Python wrote an empty file)", async () => {
    listEvents.mockRejectedValueOnce(new Error("404 Not Found"));
    await expect(COLLECTORS["iffy-books"]!("2026-10-12", "2026-10-18")).rejects.toThrow(/every request failed \(1 attempted\)/);
  });
});

describe("buildOutput", () => {
  it("has the source file shape", () => {
    const output = buildOutput("Do215", []);
    expect(Object.keys(output)).toEqual(["source", "collected_at", "events"]);
    // Python's datetime.now(UTC).isoformat(), microseconds included.
    expect(output.collected_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/);
    expect(Math.abs(Date.parse(output.collected_at) - Date.now())).toBeLessThan(5000);
  });
});
