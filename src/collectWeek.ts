/**
 * Runs a full Collection pass for one week, deterministically, with no
 * model. Rewrite of scripts/collect_week.py, the GitHub Actions replacement
 * for the old Collection Routine.
 *
 * Every source is backed by a tested parser (eventParsers/); nothing reads
 * page text and transcribes fields by hand, which is the failure class
 * behind both the 2026-07-27 fabrication (17 source files sharing one
 * made-up timestamp) and the 2026-08-01 silent `url` drop across the Google
 * Calendar sources. A workflow has no session budget to exhaust and no
 * judgment to exercise: it completes or it fails loudly.
 *
 * Each source in {@link SOURCES} is a function returning its events plus any
 * failed requests -- one fetch and a parser, or a collectSource loop -- and
 * is isolated: one failing is recorded `status: failed` with its reason (the
 * manifest convention checkYield validates) and never stops the others.
 * Sources run one at a time, as in the Python, so no site sees a burst.
 *
 * Each parser module's header is the spec of record for its source (depth
 * varies: do215, wxpn, cinespeak, gcal, lightbox, philadelphiaFilmSociety
 * and theRotunda carry real quirks; the rest are a one-line description).
 *
 * Divergences from the Python:
 * - A source that skipped malformed records (eventParsers' collectRecords)
 *   says so in its manifest `note`, next to any failed requests; the Python
 *   only printed a warning, and its parsers failed the whole source instead.
 * - `--week-start` must be a real date and a Monday (the week-window
 *   convention); the Python accepted any date, or crashed on a bad one.
 * - Pages are parsed whole (up to a 5 MB runaway guard). The Python capped
 *   each fetch at 200,000 characters. cinéSPEAK's page grew past that
 *   between 2026-10-07 (~200,000 characters, all events inside the cap) and
 *   2026-10-09 (~368,000, first event ~270,000 in), so under the cap it now
 *   fails as "markup may have changed". The cap also hides r5's and
 *   phillygoth's later listings.
 * - A failure reason carries the underlying cause (undici reports a DNS or
 *   TLS failure as a bare "fetch failed"), and error class names are the TS
 *   ones (`HttpError`, not requests' `HTTPError`).
 *
 * Usage:
 *   node dist/collectWeek.js                       # next Monday's week
 *   node dist/collectWeek.js --week-start 2026-08-03
 *   node dist/collectWeek.js --only do215,wxpn     # a subset, for debugging
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { COLLECTORS, type Collected, addDays, utcTimestamp } from "./collectSource.js";
import { DATA_DIR, targetWeekMonday } from "./common.js";
import { type Event, PARSERS, skippedRecords } from "./eventParsers/index.js";
import { errorMessage, get, readText } from "./lib/http.js";
import { writeJsonAsciiEscaped } from "./lib/json.js";

export interface Source {
  /** Output filename stem and manifest key. */
  stem: string;
  /** The source file's `source` field. */
  name: string;
  collect: (weekStart: string, weekEnd: string) => Promise<Collected>;
}

// Real pages run to ~450 KB; anything past this is a runaway response.
const MAX_BODY_BYTES = 5_000_000;

/**
 * The whole response body. Deliberately not fetchRaw's 200,000-character cap:
 * that's for printing a feed, and cutting a page short only hides content
 * from its parser (cinéSPEAK's first event sat ~270,000 characters in on
 * 2026-10-09).
 */
async function fetchBody(url: string): Promise<string> {
  return readText(await get(url), MAX_BODY_BYTES);
}

/** One fetch handed to one parser. */
function simple(stem: string, name: string, url: string, parserKey: string): Source {
  return {
    stem,
    name,
    collect: async (weekStart, weekEnd) => ({ events: PARSERS[parserKey]!(await fetchBody(url), weekStart, weekEnd), failed: [] }),
  };
}

function collector(stem: string, name: string, key: string): Source {
  return { stem, name, collect: COLLECTORS[key]! };
}

/**
 * The Rotunda's page is a monthly grid whose HTML doesn't say which month it
 * shows, so the parser needs the month as context; a week spanning two
 * months fetches both and merges them.
 */
const rotunda: Source = {
  stem: "the-rotunda",
  name: "The Rotunda",
  collect: async (weekStart, weekEnd) => {
    const months = [...new Set([`${weekStart.slice(0, 7)}-01`, `${weekEnd.slice(0, 7)}-01`])];
    const merged = new Map<string, Event>();
    for (const month of months) {
      const raw = await fetchBody(`https://www.therotunda.org/events?date=${month}`);
      for (const event of PARSERS["the-rotunda"]!(raw, weekStart, weekEnd, { contextDate: month })) {
        const key = JSON.stringify([event.title, event.date]);
        if (!merged.has(key)) merged.set(key, event);
      }
    }
    return { events: [...merged.values()], failed: [] };
  },
};

// (stem, display name, meetup URL slug) -- all share the meetup-ical parser.
const MEETUP_GROUPS = [
  ["meetup-philadelphia-horror-meetup-group", "Meetup: Philadelphia Horror", "philadelphia-horror-meetup-group"],
  ["meetup-code-coffee", "Meetup: Code & Coffee", "code-coffee-philly"],
  ["meetup-ai-philly", "Meetup: AI Philly", "ai-philly"],
  ["meetup-tech-in-motion", "Meetup: Tech in Motion", "techinmotionphilly"],
  ["meetup-dc215", "Meetup: DC 215", "dc_215"],
  ["meetup-owasp", "Meetup: OWASP", "owasp-philadelphia-chapter"],
  ["meetup-philly-hardware", "Meetup: Philly Hardware", "philly-hardware"],
  ["meetup-philly-film-club", "Meetup: Philly Film Club", "philly-film-club"],
] as const;

/** Every source, in run order. */
export const SOURCES: readonly Source[] = [
  simple("philly-ask-a-punk", "Philly Ask A Punk", "https://philly.askapunk.net/api/events", "philly-ask-a-punk"),
  simple("luma", "Luma", "https://api.luma.com/ics/get?entity=discover&id=discplace-VGLZZfVwOKRD1Yd", "luma-ical"),
  simple("r5-productions", "R5 Productions", "https://r5productions.com/events/", "r5-productions"),
  simple("philamoca", "PhilaMOCA", "https://www.philamoca.org/", "philamoca"),
  simple("cinespeak", "cinéSPEAK", "https://cinespeak.org/cinema/", "cinespeak"),
  simple("phillygoth", "Phillygoth.net", "https://phillygoth.net/", "phillygoth"),
  simple("philly-shows", "Philly-Shows.com", "https://www.philly-shows.com/", "philly-shows"),
  rotunda,
  ...MEETUP_GROUPS.map(([stem, name, slug]) => simple(stem, name, `https://www.meetup.com/${slug}/events/ical/`, "meetup-ical")),
  collector("do215", "Do215", "do215"),
  collector("wxpn", "WXPN", "wxpn"),
  collector("lightbox-film-center", "Lightbox Film Center", "lightbox-film-center"),
  collector("philadelphia-film-society", "Philadelphia Film Society", "philadelphia-film-society"),
  collector("iffy-books", "Iffy Books", "iffy-books"),
  collector("wooden-shoe-books", "Wooden Shoe Books", "wooden-shoe-books"),
  // trakt-film-releases retired 2026-09-13 -- see collectSource.ts's GCAL_CALENDARS.
];

const MAX_SHOWN_IN_NOTE = 3;
// A skip message can embed a whole bad record.
const MAX_ITEM_CHARS = 200;

/** "a; b; c; +4 more" -- bounded, since the note lands in the committed manifest. */
function capped(items: readonly string[]): string {
  const clip = (item: string): string => (item.length > MAX_ITEM_CHARS ? `${item.slice(0, MAX_ITEM_CHARS)}...` : item);
  const shown = items.slice(0, MAX_SHOWN_IN_NOTE).map(clip).join("; ");
  return items.length > MAX_SHOWN_IN_NOTE ? `${shown}; +${String(items.length - MAX_SHOWN_IN_NOTE)} more` : shown;
}

/**
 * The manifest `note` for an ok source that lost something along the way:
 * failed requests (a "partial" source -- added after the 2026-09-13
 * trakt-film-releases yield failure left no record of why) and skipped
 * malformed records. Undefined when nothing was lost.
 */
export function partialNote(failedRequests: readonly string[], skipped: readonly string[] = []): string | undefined {
  const parts: string[] = [];
  if (failedRequests.length > 0) parts.push(`partial -- ${String(failedRequests.length)} request(s) failed: ${capped(failedRequests)}`);
  if (skipped.length > 0) parts.push(`skipped ${String(skipped.length)} malformed record(s): ${capped(skipped)}`);
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

export type ManifestEntry = { status: "ok"; events: number; note?: string } | { status: "failed"; reason: string };

export interface Manifest {
  week: string;
  run_started: string;
  run_completed: string;
  sources: Record<string, ManifestEntry>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, writeJsonAsciiEscaped(value));
}

export interface CollectWeekOptions {
  weekStart: string;
  outRoot?: string;
  /** Stems to run; all when undefined. */
  only?: ReadonlySet<string>;
  sources?: readonly Source[];
}

export async function collectWeek({ weekStart, outRoot = DATA_DIR, only, sources = SOURCES }: CollectWeekOptions): Promise<Manifest> {
  const weekEnd = addDays(weekStart, 6);
  const outDir = join(outRoot, weekStart);
  mkdirSync(outDir, { recursive: true });
  const runStarted = utcTimestamp();
  console.error(`Collecting ${weekStart} .. ${weekEnd} into ${outDir}`);

  const entries: Record<string, ManifestEntry> = {};
  for (const source of sources) {
    if (only && !only.has(source.stem)) continue;
    const skipped: string[] = [];
    try {
      const { events, failed } = await skippedRecords.run(skipped, () => source.collect(weekStart, weekEnd));
      writeJson(join(outDir, `${source.stem}.json`), { source: source.name, collected_at: utcTimestamp(), events });
      const note = partialNote(failed, skipped);
      entries[source.stem] = { status: "ok", events: events.length, ...(note !== undefined && { note }) };
      console.error(`${source.stem}: ${String(events.length)} events written.${note ? ` ${note}` : ""}`);
    } catch (err) {
      // Per-source isolation is the whole point: record it and carry on.
      const reason = `${err instanceof Error ? err.name : "Error"}: ${errorMessage(err)}`;
      entries[source.stem] = { status: "failed", reason };
      writeJson(join(outDir, `${source.stem}.json`), { source: source.name, status: "failed", reason, collected_at: utcTimestamp() });
      console.error(`${source.stem}: FAILED -- ${reason}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
    }
  }

  const manifest: Manifest = {
    week: weekStart,
    run_started: runStarted,
    run_completed: utcTimestamp(),
    sources: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
  writeJson(join(outDir, "_manifest.json"), manifest);

  const values = Object.values(entries);
  const failedStems = Object.keys(entries).filter((stem) => entries[stem]?.status !== "ok");
  const total = values.reduce((sum, entry) => sum + (entry.status === "ok" ? entry.events : 0), 0);
  console.error(
    `\nCollection complete. ${String(values.length - failedStems.length)}/${String(values.length)} sources ok` +
      (failedStems.length > 0 ? `, ${String(failedStems.length)} failed (${failedStems.join(", ")})` : "") +
      `.\n${String(total)} total events written to ${outDir}.`,
  );
  return manifest;
}

const USAGE = "usage: collectWeek.js [--week-start YYYY-MM-DD (a Monday)] [--out-root DIR] [--only stem,stem]";

/** The CLI; returns the exit code. Source failures don't fail the run (checkYield judges the result). */
export async function run(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { "week-start": { type: "string" }, "out-root": { type: "string" }, only: { type: "string" } },
    }));
  } catch (err) {
    console.error(`${errorMessage(err)}\n${USAGE}`);
    return 2;
  }
  const weekStart = values["week-start"] ?? targetWeekMonday();
  const day = new Date(`${weekStart}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || Number.isNaN(day.getTime()) || !day.toISOString().startsWith(weekStart) || day.getUTCDay() !== 1) {
    console.error(`--week-start must be a Monday, got ${weekStart}\n${USAGE}`);
    return 2;
  }
  const only = values.only === undefined ? undefined : new Set(values.only.split(",").map((stem) => stem.trim()));
  await collectWeek({ weekStart, ...(values["out-root"] !== undefined && { outRoot: values["out-root"] }), ...(only && { only }) });
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await run(process.argv.slice(2));
}
