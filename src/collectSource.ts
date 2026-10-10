/**
 * Collection's multi-request sources: paginated APIs, per-day URLs, index +
 * detail pages, and the venue Google Calendars. Rewrite of
 * scripts/collect_source.py.
 *
 * A single-request source is one fetch handed to one parser (collectWeek).
 * These need a loop -- do215's yield sits behind 7 day-URLs times several
 * pages -- and the loop is code, never a model: a model orchestrating it one
 * call at a time is the budget-exhaustion path that fabricated empty results
 * for the week of 2026-07-27 (see checkYield.ts).
 *
 * Each collector fetches what it needs, hands it to its source's pure parser
 * (eventParsers/) in that parser's own input shape, and returns the events
 * plus a description of every request that failed. Failure semantics:
 *
 * - A failed request is recorded and the loop carries on; the result is a
 *   "partial" source as long as something succeeded.
 * - If every request failed, the collector throws ParseError rather than
 *   return a plausible-looking empty list -- the specific failure this module
 *   exists to prevent. So does a structural break (Lightbox's index losing
 *   its event cards).
 *
 * Divergences from the Python:
 * - Collectors parse their own results, so the flatten-then-rewrap step
 *   (RAW_WRAPPERS, gcal's `_gcal_meta` marker entry) is gone.
 * - "Every request failed" now covers the venue calendars and PFS too. The
 *   Python counted gcal's meta marker, and PFS's per-(venue, day) entries
 *   with a null page, as fetched items, so a total failure there wrote an
 *   empty "ok" file instead.
 * - A do215 page that isn't a JSON object, or a WXPN X-WP-TotalPages header
 *   that isn't a number, is recorded as a failed request (do215) or treated
 *   as "no further pages" (WXPN); both crashed the whole source.
 * - The CLI rejects an impossible date or an inverted window (exit 2); the
 *   Python crashed on the former and wrote an empty "ok" file for the
 *   latter. A blank render counts as a failed PFS fetch, and the calendar
 *   loop is capped at MAX_PAGES_GCAL pages.
 *
 * Output JSON keeps Python's default ASCII escaping, so committed source
 * files don't churn at the cutover.
 */

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { type Event, PARSERS, ParseError, parseLightboxIndex } from "./eventParsers/index.js";
import { fetchPageText } from "./fetchPageText.js";
import { errorMessage, get, readText } from "./lib/http.js";
import { writeJsonAsciiEscaped } from "./lib/json.js";

export interface Collected {
  events: Event[];
  failed: string[];
}

export type Collector = (weekStart: string, weekEnd: string) => Promise<Collected>;

// Per-day pagination cap. Observed live (2026-07-29): a typical day is 1-3
// pages; a big day (concerts + a multi-week festival re-listed daily) hit 4.
// Capped well above that rather than left unbounded -- an unbounded loop is
// its own silent-cost risk (docs/COLLECTION_PROXY_ISSUE.md: Songkick).
export const MAX_PAGES_PER_DAY = 6;

// WXPN's REST API sorts by publish date, not event date, so every page must
// be fetched. Observed live (2026-07-29): 495 records across 5 pages of 100
// (the API's per_page cap). Capped one page above that.
export const MAX_PAGES_WXPN = 6;

// A venue calendar's week is a few events (one page of up to 250). The cap
// only guards against an API that keeps handing back a nextPageToken.
export const MAX_PAGES_GCAL = 10;

const failure = (url: string, err: unknown): string => `${url} (${errorMessage(err)})`;

/** The ParseError for a loop in which nothing at all succeeded. */
function allFailed(failed: string[]): ParseError {
  return new ParseError(`every request failed (${String(failed.length)} attempted); first: ${failed[0] ?? ""}`);
}

async function getJson(url: string): Promise<{ payload: unknown; headers: { get(name: string): string | null } }> {
  const response = await get(url);
  return { payload: JSON.parse(await readText(response)) as unknown, headers: response.headers };
}

/** Every ISO date from `start` to `end` inclusive. */
export function datesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let day = new Date(`${start}T00:00:00Z`); day.toISOString().slice(0, 10) <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

// --- do215: one JSON URL per day, each paginated ---

export async function collectDo215(weekStart: string, weekEnd: string): Promise<Collected> {
  const events: unknown[] = [];
  const failed: string[] = [];
  for (const day of datesBetween(weekStart, weekEnd)) {
    const [year, month, dayOfMonth] = day.split("-").map(Number) as [number, number, number];
    const base = `https://do215.com/events/${String(year)}/${String(month)}/${String(dayOfMonth)}.json`;
    let totalPages = 1;
    for (let page = 1; page <= Math.min(totalPages, MAX_PAGES_PER_DAY); page++) {
      const url = page === 1 ? base : `${base}?page=${String(page)}`;
      try {
        const { payload } = await getJson(url);
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          throw new TypeError("expected a JSON object");
        }
        const body = payload as { events?: unknown; paging?: { total_pages?: unknown } };
        if (Array.isArray(body.events)) events.push(...(body.events as unknown[]));
        totalPages = typeof body.paging?.total_pages === "number" ? body.paging.total_pages : 1;
      } catch (err) {
        failed.push(failure(url, err));
      }
    }
  }
  if (events.length === 0 && failed.length > 0) throw allFailed(failed);
  return { events: PARSERS["do215"]!(JSON.stringify({ events }), weekStart, weekEnd), failed };
}

// --- WXPN: one paginated WP REST endpoint with no date filter ---

const WXPN_API_URL = "https://backend.xpn.org/wp-json/wp/v2/event";

export async function collectWxpn(weekStart: string, weekEnd: string): Promise<Collected> {
  // The API has no server-side date filter (see eventParsers/wxpn.ts), so
  // every page is fetched whatever the window; the parser does the filtering.
  const records: unknown[] = [];
  const failed: string[] = [];
  let totalPages = 1;
  for (let page = 1; page <= Math.min(totalPages, MAX_PAGES_WXPN); page++) {
    const url = `${WXPN_API_URL}?per_page=100&page=${String(page)}`;
    try {
      const { payload, headers } = await getJson(url);
      if (!Array.isArray(payload)) throw new TypeError(`expected a JSON array, got ${payload === null ? "null" : typeof payload}`);
      records.push(...(payload as unknown[]));
      const header = Number(headers.get("x-wp-totalpages"));
      totalPages = Number.isInteger(header) && header > 0 ? header : page;
    } catch (err) {
      failed.push(failure(url, err));
    }
  }
  if (records.length === 0 && failed.length > 0) throw allFailed(failed);
  return { events: PARSERS["wxpn"]!(JSON.stringify(records), weekStart, weekEnd), failed };
}

// --- Lightbox: homepage index, then every detail page it links to ---

const LIGHTBOX_HOMEPAGE = "https://www.lightboxfilmcenter.org/";

export async function collectLightbox(weekStart: string, weekEnd: string): Promise<Collected> {
  // The index has no date filter and only ever lists a handful of upcoming
  // events (see eventParsers/lightbox.ts), so every detail page is fetched;
  // the parser filters on each page's JSON-LD startDate.
  let candidates;
  try {
    candidates = parseLightboxIndex(await readText(await get(LIGHTBOX_HOMEPAGE)));
  } catch (err) {
    if (err instanceof ParseError) throw err; // the index itself broke structurally
    throw new ParseError(`failed to fetch or parse the lightbox-film-center homepage: ${errorMessage(err)}`);
  }
  const failed: string[] = [];
  const entries = [];
  for (const { title, href } of candidates) {
    let detailHtml: string | null = null;
    try {
      detailHtml = await readText(await get(href));
    } catch (err) {
      // One detail page failing mustn't lose the others; the parser keeps
      // the index's title for it.
      failed.push(failure(href, err));
    }
    entries.push({ title, href, detail_html: detailHtml });
  }
  return { events: PARSERS["lightbox-film-center"]!(JSON.stringify(entries), weekStart, weekEnd), failed };
}

// --- Philadelphia Film Society: Fandango theater pages, rendered ---

// The three venues PFS sells tickets for on Fandango. Fixed and known, so
// the collector attaches each venue's real name and address rather than
// re-deriving them from page text (see eventParsers/philadelphiaFilmSociety.ts).
export const PFS_VENUES = [
  {
    name: "PFS Film Society Center",
    address: "1412 Chestnut Street, Philadelphia, PA 19102",
    url: "https://www.fandango.com/pfs-film-society-center-aaxow/theater-page",
  },
  {
    name: "PFS Bourse Theater",
    address: "400 Ranstead St, Philadelphia, PA 19106",
    url: "https://www.fandango.com/pfs-bourse-theater-aadjc/theater-page",
  },
  {
    name: "PFS East Theater",
    address: "125 S. 2nd Street, Philadelphia, PA 19106",
    url: "https://www.fandango.com/pfs-east-theater-aandq/theater-page",
  },
] as const;

export async function collectPhiladelphiaFilmSociety(weekStart: string, weekEnd: string): Promise<Collected> {
  // Two days per venue (the week's Wednesday and Saturday), not all 7.
  // PFS's own day-picker jumps from Sunday to the following Wednesday for
  // weeks further out, suggesting Wed-Sun programming blocks (inferred from
  // the widget, not confirmed by comparing two same-block days). Each render
  // takes seconds, so 6 fetches instead of 21. Each (venue, day) is isolated:
  // one hanging or failing mustn't take the other five with it.
  const sampleDays = [addDays(weekStart, 2), addDays(weekStart, 5)];
  const entries = [];
  const failed: string[] = [];
  for (const venue of PFS_VENUES) {
    for (const day of sampleDays) {
      const url = `${venue.url}?date=${day}`;
      let renderedText: string | null = null;
      try {
        renderedText = await fetchPageText(url, { maxChars: 20_000 });
      } catch (err) {
        failed.push(failure(url, err));
      }
      entries.push({
        venue_name: venue.name,
        venue_address: venue.address,
        theater_url: venue.url,
        context_date: day,
        rendered_text: renderedText,
      });
    }
  }
  // A blank page reads as nothing to the parser, so it counts as a failure too.
  if (entries.every((entry) => !entry.rendered_text)) {
    throw allFailed(failed.length > 0 ? failed : entries.map((entry) => `${entry.theater_url}?date=${entry.context_date} (blank page)`));
  }
  return { events: PARSERS["philadelphia-film-society"]!(JSON.stringify(entries), weekStart, weekEnd), failed };
}

// --- Venue Google Calendars, via the Calendar API ---

// Third-party public calendars addressed by ID -- NOT Greg's own "Curated
// Events" calendar, so common.getCalendarId (a name search) isn't used.
// `venue` and `fallbackUrl` are per-calendar facts the API's event resources
// don't carry; the parser fills gaps with them.
//
// trakt-film-releases retired 2026-09-13: Trakt removed iCal export in its
// V3 redesign, and the imported calendar started 404ing once Google gave up
// re-fetching the dead subscription.
export const GCAL_CALENDARS = {
  "iffy-books": {
    calendarId: "uim84nkq226inhhqa44v98foigjak9us@import.calendar.google.com",
    venue: "Iffy Books, 404 S. 20th St., Philadelphia, PA 19146",
    fallbackUrl: "https://iffybooks.net/",
  },
  "wooden-shoe-books": {
    calendarId: "t8qmive63n27mdj7gt03ntc2u8@group.calendar.google.com",
    venue: "Wooden Shoe Books, 704 South St, Philadelphia, PA 19147",
    fallbackUrl: "https://woodenshoebooks.org/",
  },
} as const;

/** `date` at `time` in Philadelphia, as RFC 3339 with that day's offset. */
export function easternTimestamp(date: string, time: string): string {
  // The offset in force at noon that day; DST changes at 2 AM, so only a
  // timestamp inside the skipped/repeated hour could disagree.
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((part) => part.type === "timeZoneName")?.value.replace("GMT", "");
  return `${date}T${time}${offset || "+00:00"}`;
}

function gcalCollector(key: keyof typeof GCAL_CALENDARS): Collector {
  return async (weekStart, weekEnd) => {
    const config = GCAL_CALENDARS[key];
    // Imported lazily: keeps googleapis off every other collector's path.
    const { CALENDAR_TIMEZONE, getCalendarService } = await import("./common.js");
    let service;
    try {
      service = getCalendarService();
    } catch (err) {
      throw new ParseError(`Google Calendar auth failed: ${errorMessage(err)}`);
    }
    const items: unknown[] = [];
    const failed: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      pages++;
      try {
        const { data } = await service.events.list({
          calendarId: config.calendarId,
          // Mon 00:00 -> Sun 23:59 in Philadelphia, not the runner's UTC,
          // or a Sunday-evening event falls outside the window.
          timeMin: easternTimestamp(weekStart, "00:00:00"),
          timeMax: easternTimestamp(weekEnd, "23:59:59.999"),
          singleEvents: true,
          orderBy: "startTime",
          timeZone: CALENDAR_TIMEZONE,
          ...(pageToken !== undefined && { pageToken }),
        });
        items.push(...(data.items ?? []));
        pageToken = data.nextPageToken ?? undefined;
      } catch (err) {
        // One page failing mustn't lose the pages already read.
        failed.push(`${key} calendar page (token=${pageToken ?? "none"}) (${errorMessage(err)})`);
        break;
      }
    } while (pageToken && pages < MAX_PAGES_GCAL);
    if (items.length === 0 && failed.length > 0) throw allFailed(failed);
    const raw = JSON.stringify({ items, venue: config.venue, fallback_url: config.fallbackUrl });
    return { events: PARSERS["gcal"]!(raw, weekStart, weekEnd), failed };
  };
}

/** Keyed like collect_source.py's COLLECTORS (collectWeek's source table refers to them). */
export const COLLECTORS: Readonly<Record<string, Collector>> = {
  do215: collectDo215,
  wxpn: collectWxpn,
  "lightbox-film-center": collectLightbox,
  "philadelphia-film-society": collectPhiladelphiaFilmSociety,
  "iffy-books": gcalCollector("iffy-books"),
  "wooden-shoe-books": gcalCollector("wooden-shoe-books"),
};

/**
 * Now, as Python's `datetime.now(UTC).isoformat()` writes it
 * ("2026-10-12T00:22:01.054578+00:00"). Microseconds matter: checkYield
 * flags source files sharing an identical `collected_at` as fabricated, and
 * `toISOString()`'s milliseconds would make honest collisions likelier.
 */
export function utcTimestamp(): string {
  // Wall clock from Date (the clock collectWeek's manifest timestamps use);
  // only the sub-millisecond digits come from the high-resolution timer.
  const fraction = performance.now() % 1;
  const micros = String(Math.min(999, Math.floor(fraction * 1000))).padStart(3, "0");
  return new Date().toISOString().replace("Z", `${micros}+00:00`);
}

export function buildOutput(sourceName: string, events: Event[]): { source: string; collected_at: string; events: Event[] } {
  return { source: sourceName, collected_at: utcTimestamp(), events };
}

const USAGE = `usage: collectSource.js {${Object.keys(COLLECTORS).sort().join(",")}} --source-name NAME --week-start YYYY-MM-DD --week-end YYYY-MM-DD --out PATH`;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().startsWith(value);
}

/** The CLI; returns the exit code (2 bad arguments, 1 collection failed and nothing written). */
export async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "source-name": { type: "string" },
        "week-start": { type: "string" },
        "week-end": { type: "string" },
        out: { type: "string" },
      },
    });
  } catch (err) {
    console.error(`${errorMessage(err)}\n${USAGE}`);
    return 2;
  }
  const { positionals, values } = parsed;
  const [key] = positionals;
  const { "source-name": sourceName, "week-start": weekStart, "week-end": weekEnd, out } = values;
  if (!key || positionals.length > 1 || !(key in COLLECTORS) || !sourceName || !out || !weekStart || !weekEnd) {
    console.error(USAGE);
    return 2;
  }
  if (!isIsoDate(weekStart) || !isIsoDate(weekEnd) || weekStart > weekEnd) {
    // An inverted window would make no requests and write an empty "ok" file.
    console.error(`invalid week window ${weekStart}..${weekEnd}\n${USAGE}`);
    return 2;
  }

  let result: Collected;
  try {
    result = await COLLECTORS[key]!(weekStart, weekEnd);
  } catch (err) {
    // Nothing is written: an empty file on total failure is what this exists to avoid.
    console.error(`FAILED to collect ${key}: ${errorMessage(err)}`);
    return 1;
  }

  writeFileSync(out, writeJsonAsciiEscaped(buildOutput(sourceName, result.events)));
  if (result.failed.length > 0) {
    console.error(
      `WARNING: ${String(result.failed.length)} request(s) failed during collection ` +
        `(partial result -- see below), but ${String(result.events.length)} events were still written.`,
    );
    for (const item of result.failed) console.error(`  FAILED: ${item}`);
  }
  console.error(`${sourceName}: ${String(result.events.length)} events written. Proceeding.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await run(process.argv.slice(2));
}
