#!/usr/bin/env node
/**
 * Renders data/YYYY-MM-DD/_selections.json (+ _spotify.json, _playlist.json,
 * _manifest.json) into the weekly HTML report, then regenerates
 * docs/index.html to link every published week. Rewrite (not a byte-level
 * port) of scripts/html_render.py: same view model, same templates, checked
 * for the *same rendered document* on every committed week rather than the
 * same bytes.
 *
 * See html_render.py's module docstring for the product-level divergences
 * from v1's historical LLM-rendered output (fixed category order, verbatim
 * text, the restored All Week table, the unfixed one-Spotify-link-per-pick
 * gap). Those are behaviours of the renderer itself and apply here unchanged.
 *
 * Template engine: Nunjucks, rendering the very same templates/*.html.j2
 * files Jinja2 renders for the Python, so there is one spec of record
 * (templates/report.html.j2's own comments). The templates stick to syntax
 * both engines read the same way -- empty-list checks are `|length`, the
 * funnel's "has a delta" check is `is number` -- so the view model is passed
 * straight through. The one Jinja builtin Nunjucks lacks, `format` (used as
 * `'%.1f'|format(x)` for bar widths), is registered as a plain `toFixed`
 * filter. Escaping is Nunjucks' own autoescape; the HTML fragments the view
 * model builds itself (pick/event names, honorable mentions) go through
 * escapeHtml and are marked `|safe` in the template.
 *
 * Divergences from the Python, all intentional. On every committed week the
 * reports and the index parse to the same DOM as the Python's (same element
 * tree, attributes and whitespace-normalised text) except for the bar-width
 * ties noted under number formatting.
 *
 * - Serialization, not content: Nunjucks writes `"` as `&quot;` and `\` as
 *   `&#92;` (markupsafe: `&#34;`, `\` literal), the view model's own
 *   fragments escape quotes in text too, and the output keeps the template's
 *   trailing newline (Jinja2 drops it). None of this changes the parsed DOM.
 * - Number formatting is plain JS. Bar widths use `toFixed(1)` and the
 *   funnel's percentage uses `Math.round`, so an exact binary tie rounds up
 *   where Python rounds half-to-even (`'%.1f' % 6.25` is "6.2", toFixed gives
 *   "6.3"; `round(12.5)` is 12, Math.round gives 13). This does show in real
 *   output: a 1-of-16 bar is `width: 6.3%` here and `6.2%` in Python (one bar
 *   in the week of 2026-08-17, four in 2026-10-05) -- a fraction of a pixel.
 *   No committed funnel percentage differs. Funnel counts use
 *   `toLocaleString("en-US")`. A JSON `1.0` is the number 1 here, so a
 *   printed field Python would show as "1.0" shows as "1"; no committed week
 *   prints a float.
 * - A null printed field (`why`, `venue`, `rank`) renders empty; Jinja2
 *   prints "None". No committed week has one.
 * - Dates use Date/Intl (en-US, UTC) for month and weekday names. Week keys,
 *   week file names and `occurrences` must be strict YYYY-MM-DD: Python's
 *   `date.fromisoformat` also takes "20260622" / "2026-W26-1", which can
 *   publish a bogus canonical URL or index row. `generated_at` must be
 *   YYYY-MM-DD-led and `Date.parse`-able; its date part is shown as written
 *   (no time-zone conversion), as in Python.
 * - Sort times (category ordering) are read with a plain regex: "7:00PM"
 *   without a space now sorts as 7 PM, while "7:5 PM" (strptime accepts a
 *   one-digit minute) doesn't. No committed time is affected.
 * - `recurrence_count` is read with Number(): a non-numeric string just isn't
 *   recurring, where Python's int() raised. A missing pick/event `url` links
 *   to "" instead of raising KeyError.
 * - The map link is built with URLSearchParams, which leaves `*` literal and
 *   encodes `~` (Python's quote_plus: the reverse). Same query either way.
 * - Strings are trimmed with trim() (Python's strip() whitespace set differs
 *   in \x1c-\x1f, \x85, U+FEFF), lowercased with toLowerCase() (casefold()
 *   differs for "ß"), and tie-break sorts compare UTF-16 code units (Python
 *   compares code points; they differ only between astral and U+E000-U+FFFF
 *   characters). Plain `<`, not localeCompare, so "Do215" still sorts before
 *   "cinéSPEAK" as in Python.
 * - A manifest source with `"events": null` renders (checkYield.ts treats it
 *   as 0); Python's check_yield_floor raises TypeError.
 * - Python bugs fixed here rather than reproduced (PR #73; still present in
 *   html_render.py, triggered by no committed week):
 *   - Non-canonical categories render after the canonical nine instead of
 *     vanishing from the day blocks and stats (withExtraCategories).
 *   - A Top 3 time gets the "+" multiple-showtimes suffix its listing card
 *     gets (buildDayViewmodel reads the note from the events[] entry).
 *   - An empty Spotify matched_text falls back to the event link instead of
 *     an empty <a> (buildPickNameHtml).
 *   - A comma inside a Meetup group's name doesn't split it into two
 *     sources (splitSourceField).
 *   - Lax ISO dates are rejected (see Dates above).
 * - renderIndex takes the weeks directory as an optional parameter (default
 *   docs/weeks), so it can be pointed at a scratch dir.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import nunjucks from "nunjucks";
import { type ExpectedYield, type Manifest, checkYieldFloor } from "./checkYield.js";
import {
  CATEGORY_ORDER,
  RECURRING_THRESHOLD,
  REPO_ROOT,
  isFreeCost,
  isPlaceholderCost,
  loadExpectedYield,
  loadManifest,
  loadPlaylist,
  loadSelections,
  loadSpotify,
  stripPlaceholderWrapper,
  weekDates,
} from "./common.js";

export const TEMPLATES_DIR = join(REPO_ROOT, "templates");
export const DOCS_DIR = join(REPO_ROOT, "docs");
export const WEEKS_DIR = join(DOCS_DIR, "weeks");

// Where GitHub Pages actually serves this site. Trailing slash and project
// subpath both required -- see html_render.py's SITE_BASE_URL comment.
export const SITE_BASE_URL = "https://gstro.github.io/this-week-in-philly/";

// The full set of sources the pipeline watches, in display order. Keep in
// sync with html_render.py's SOURCES (and, through it, collect_week.py's
// registries) -- see that list's comment for the provenance of each change.
export const SOURCES: readonly (readonly [string, string])[] = [
  ["Do215", "https://do215.com"],
  ["Lightbox Film Center", "https://lightboxfilmcenter.org"],
  ["cinéSPEAK", "https://cinesp.net"],
  ["Philadelphia Film Society", "https://filmadelphia.org"],
  ["PhilaMOCA", "https://philamoca.org"],
  ["Phillygoth.net", "https://phillygoth.net"],
  ["Philly-Shows.com", "https://www.philly-shows.com"],
  ["Iffy Books", "https://iffybooks.net"],
  ["Wooden Shoe Books", "https://woodenshoebooks.org"],
  ["The Rotunda", "https://therotunda.org"],
  ["R5 Productions", "https://r5productions.com"],
  ["Philly Ask A Punk", "https://philly.askapunk.net"],
  ["The Key by WXPN", "https://xpn.org"],
  ["Meetup", "https://meetup.com"],
  ["Luma", "https://lu.ma"],
  ["Google Calendar", "https://calendar.google.com"],
];

// Events say "WXPN"; the footer says "The Key by WXPN" (the publication).
export const SOURCE_ALIASES: Readonly<Record<string, string>> = { WXPN: "The Key by WXPN" };

// "Do215 / WXPN" and "Do215, WXPN" both occur in the wild and mean the same.
const SOURCE_SPLIT_RE = /[/,]/;

// Rendered cards per category per day; a category's true count is unaffected.
export const CATEGORY_DISPLAY_CAP = 10;

// ---------------------------------------------------------------------------
// Data shapes (the subset of _selections.json / _spotify.json this reads)
// ---------------------------------------------------------------------------

export interface SelectionEvent {
  title: string;
  url?: string;
  venue?: string | null;
  category?: string;
  time?: string | null;
  cost?: string | null;
  note?: string | null;
  source?: string | null;
  sold_out?: unknown;
  recurrence_count?: number | string | null;
  occurrences?: string[] | null;
}

export interface TopPick extends SelectionEvent {
  rank?: number;
  why?: string | null;
  is_music?: unknown;
  address?: string | null;
}

export interface HonorableMention {
  title: string;
  venue: string;
}

export interface Day {
  date: string;
  day_name: string;
  top3: TopPick[];
  events: SelectionEvent[];
  honorable_mentions?: HonorableMention[];
}

export interface Selections {
  week?: string;
  generated_at?: string | null;
  total_events_after_dedup?: number | null;
  collection_failures?: string[];
  days: Day[];
}

export interface SpotifyEntry {
  matched_text: string;
  spotify_url: string;
}

// The view model below keeps the templates' snake_case keys.

export interface SourceRow {
  name: string;
  url: string | null;
  count: number;
}

export interface EventView {
  name_html: string;
  note: string | null;
  venue: string | null | undefined;
  time_display: string;
  price_class: string;
  price_text: string;
}

export interface CategoryView {
  label: string;
  events: EventView[];
  true_count: number;
  omitted: number | null;
}

export interface AllWeekRow {
  title: string;
  venue: string | null | undefined;
  category: string | undefined;
  days: string;
  price_text: string;
}

export interface Stage {
  label: string;
  value: number;
  drop_pct: number | null;
  drop_from: string | null;
  display: string;
}

export interface CategoryStatRow {
  label: string;
  listed: number;
  top3: number;
  listed_pct: number;
  top3_pct: number;
}

export interface SourceStatRow extends SourceRow {
  pct: number;
}

export interface Health {
  source_count: number;
  contributed: number;
  below_floor: string[];
  run_level_shortfall: boolean;
}

export interface Stats {
  stages: Stage[];
  categories: CategoryStatRow[];
  sources: SourceStatRow[];
  health: Health | null;
}

export interface PickView {
  rank: number | undefined;
  name_html: string;
  why: string | null | undefined;
  venue: string | null | undefined;
  map_url: string | null;
  time_display: string;
  cost_text: string | null;
  sold_out: boolean;
}

export interface DayView {
  day_name: string;
  slug: string;
  date_display: string;
  date_iso: string;
  event_count: number;
  top3: PickView[];
  honorable_mentions_html: string | null;
  categories: CategoryView[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for an HTML fragment the view model builds itself (text or a quoted attribute). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/** Orders strings by UTF-16 code unit -- deliberately not localeCompare, which would put "cinéSPEAK" before "Do215". */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function countBy<T>(items: Iterable<T>, keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Dates (always UTC midnight, so the calendar date never shifts with the host zone)
// ---------------------------------------------------------------------------

/** A strict YYYY-MM-DD calendar date as a UTC-midnight Date, or null. */
export function parseIsoDate(text: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  // Rejects month 13 (Invalid Date) and Feb 30 (which Date rolls over to Mar 2).
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text) ? date : null;
}

function requireIsoDate(text: string): Date {
  const date = parseIsoDate(text);
  if (!date) throw new Error(`not a YYYY-MM-DD date: ${JSON.stringify(text)}`);
  return date;
}

function dateFormat(options: Intl.DateTimeFormatOptions): (date: Date) => string {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options });
  return (date) => format.format(date);
}

const monthDay = dateFormat({ month: "long", day: "numeric" }); // "June 22"
const weekdayShort = dateFormat({ weekday: "short" }); // "Mon"
const weekdayMonthDay = dateFormat({ weekday: "long", month: "long", day: "numeric" }); // "Sunday, June 21"

// ---------------------------------------------------------------------------
// Sources footer
// ---------------------------------------------------------------------------

/**
 * Splits a combined source field into its sources. A comma inside a Meetup
 * group's name ("Meetup: Food, Drink & Code") is not a separator: a piece that
 * follows a "Meetup: ..." piece is folded back into it unless it is itself a
 * known source or another Meetup group. Python's split_source_field has no
 * such guard and counts the tail of the group name as a source of its own.
 */
export function splitSourceField(raw: string | null | undefined): string[] {
  const parts = (raw ?? "")
    .split(SOURCE_SPLIT_RE)
    .map((part) => part.trim())
    .filter(Boolean);
  const merged: string[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (previous !== undefined && isMeetupSource(previous) && !isMeetupSource(part) && !KNOWN_SOURCE_NAMES.has(part)) {
      merged[merged.length - 1] = `${previous}, ${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

function isMeetupSource(name: string): boolean {
  return name.toLowerCase().startsWith("meetup:");
}

const KNOWN_SOURCE_NAMES: ReadonlySet<string> = new Set([
  ...SOURCES.map(([name]) => name),
  ...Object.keys(SOURCE_ALIASES),
]);

/** Maps one source token onto its footer name; every "Meetup: <group>" collapses to "Meetup". */
export function normalizeSourceName(raw: string): string {
  const name = raw.trim();
  if (isMeetupSource(name)) return "Meetup";
  return SOURCE_ALIASES[name] ?? name;
}

/**
 * The footer, derived from the week's own events. Every known source renders;
 * contributors carry a count; contributors not in SOURCES (retired sources in
 * archived weeks) render unlinked, sorted, after the known ones.
 */
export function buildSources(days: readonly { events: readonly { source?: string | null }[] }[]): SourceRow[] {
  const counts = countBy(
    days.flatMap((day) => day.events.flatMap((event) => splitSourceField(event.source))),
    normalizeSourceName,
  );
  const known: SourceRow[] = SOURCES.map(([name, url]) => ({ name, url, count: counts.get(name) ?? 0 }));
  const knownNames = new Set(SOURCES.map(([name]) => name));
  const retired: SourceRow[] = [...counts.keys()]
    .filter((name) => !knownNames.has(name))
    .sort(compareStrings)
    .map((name) => ({ name, url: null, count: counts.get(name)! }));
  return [...known, ...retired];
}

// ---------------------------------------------------------------------------
// Per-event helpers
// ---------------------------------------------------------------------------

/** A Google Maps search link for a Top 3 pick's address, or null without one. */
export function buildMapUrl(address: string | null | undefined): string | null {
  const query = (address ?? "").trim();
  if (!query) return null;
  return `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query }).toString()}`;
}

export function cleanCost(cost: string | null | undefined): string {
  return stripPlaceholderWrapper(cost);
}

export function hasMultipleShowtimes(note: string | null | undefined): boolean {
  return (note ?? "").toLowerCase().includes("multiple showtimes");
}

/**
 * An actual time or "Various" -- never placeholder prose. See html_render.py's
 * display_time for the "confirm showtimes+" regression this guards.
 */
export function displayTime(eventTime: string | null | undefined, note: string | null | undefined): string {
  if (isPlaceholderCost(eventTime)) return "Various";
  const time = stripPlaceholderWrapper(eventTime);
  if (!time) return "Various";
  return time + (hasMultipleShowtimes(note) ? "+" : "");
}

export function priceClassAndText(event: { sold_out?: unknown; cost?: string | null }): [string, string] {
  if (event.sold_out) return ["sold-out", "SOLD OUT"];
  const cost = cleanCost(event.cost);
  return [isFreeCost(cost) ? "price-free" : "price-paid", cost];
}

export function buildPickNameHtml(
  pick: { title: string; url?: string; is_music?: unknown },
  spotifyEntry: Partial<SpotifyEntry> | null | undefined,
): string {
  const { title } = pick;
  const matched = spotifyEntry?.matched_text;
  // An empty matched_text would "match" at index 0 and emit an empty <a>
  // (Python's build_pick_name_html does exactly that); treat it as no match.
  const idx = pick.is_music && matched ? title.indexOf(matched) : -1;
  if (idx !== -1 && matched) {
    const before = escapeHtml(title.slice(0, idx));
    const after = escapeHtml(title.slice(idx + matched.length));
    return `${before}<a href="${escapeHtml(spotifyEntry?.spotify_url ?? "")}">${escapeHtml(matched)}</a>${after}`;
  }
  return `<a class="event-link" href="${escapeHtml(pick.url ?? "")}">${escapeHtml(title)}</a>`;
}

export function buildEventNameHtml(event: { title: string; url?: string }, isTop3: boolean): string {
  const prefix = isTop3 ? "⭐ " : "";
  return `<a href="${escapeHtml(event.url ?? "")}">${prefix}${escapeHtml(event.title)}</a>`;
}

export function buildHonorableMentionsHtml(mentions: readonly HonorableMention[] | null | undefined): string | null {
  if (!mentions?.length) return null;
  return mentions
    .map((m) => `${escapeHtml(m.title).replaceAll("(SOLD OUT)", "(<strong>SOLD OUT</strong>)")} at ${escapeHtml(m.venue)}`)
    .join(" · ");
}

const CLOCK_TIME_RE = /^(\d{1,2}):(\d{2})\s*([ap]m)$/i;

/** Minutes past midnight for "7:00 PM", or null for anything that isn't a 12-hour clock time. */
export function parseTimeForSort(eventTime: unknown): number | null {
  if (typeof eventTime !== "string") return null;
  const m = CLOCK_TIME_RE.exec(eventTime.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  return ((hour % 12) + (m[3]!.toLowerCase() === "pm" ? 12 : 0)) * 60 + minute;
}

/**
 * True when this event belongs in the All Week table instead of a day's
 * category block. A Top 3 pick is deliberately never routed out of its day.
 */
export function isAllWeek(event: SelectionEvent, top3Titles: ReadonlySet<string>): boolean {
  if (top3Titles.has(event.title)) return false;
  return Number(event.recurrence_count ?? 0) >= RECURRING_THRESHOLD;
}

/**
 * CATEGORY_ORDER, then any non-canonical category actually present, in first-
 * seen order. Python iterates CATEGORY_ORDER alone, so an event whose category
 * isn't one of the nine canonical strings silently vanishes from its day and
 * from the stats; here it still renders, under its own label, after the rest.
 */
function withExtraCategories(present: Iterable<string>): string[] {
  const canonical = new Set<string>(CATEGORY_ORDER);
  return [...CATEGORY_ORDER, ...new Set([...present].filter((label) => !canonical.has(label)))];
}

/**
 * Top 3 first, then Honorable Mentions, then chronological, unparseable times
 * last within their tier; Array#sort is stable, so ties keep array order.
 * Applied before the display cap so the cap can never drop something
 * Selection vetted.
 */
function byPriority(
  top3Titles: ReadonlySet<string>,
  hmTitles: ReadonlySet<string>,
): (a: SelectionEvent, b: SelectionEvent) => number {
  const key = (event: SelectionEvent): number[] => {
    const minutes = parseTimeForSort(event.time);
    return [
      top3Titles.has(event.title) ? 0 : 1,
      hmTitles.has(event.title) ? 0 : 1,
      minutes === null ? 1 : 0,
      minutes ?? 0,
    ];
  };
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka.map((value, i) => value - kb[i]!).find((diff) => diff !== 0) ?? 0;
  };
}

export function buildCategories(
  day: { events: SelectionEvent[]; honorable_mentions?: HonorableMention[] },
  top3Titles: ReadonlySet<string>,
): CategoryView[] {
  const hmTitles = new Set((day.honorable_mentions ?? []).map((mention) => mention.title));
  const byCategory = new Map<string, SelectionEvent[]>();
  for (const event of day.events) {
    if (isAllWeek(event, top3Titles)) continue;
    const label = event.category ?? "";
    byCategory.set(label, [...(byCategory.get(label) ?? []), event]);
  }

  return withExtraCategories(byCategory.keys()).flatMap((label): CategoryView[] => {
    const events = byCategory.get(label);
    if (!events?.length) return [];
    const displayed = events.toSorted(byPriority(top3Titles, hmTitles)).slice(0, CATEGORY_DISPLAY_CAP);
    const views = displayed.map((event): EventView => {
      const [priceClass, priceText] = priceClassAndText(event);
      return {
        name_html: buildEventNameHtml(event, top3Titles.has(event.title)),
        note: event.note || null,
        venue: event.venue,
        time_display: displayTime(event.time, event.note),
        price_class: priceClass,
        price_text: priceText,
      };
    });
    // "No silent caps": say when the display cap actually dropped something.
    const omitted = events.length - displayed.length;
    return [{ label, events: views, true_count: events.length, omitted: omitted || null }];
  });
}

/**
 * Rows for the "All Week / Recurring" table: one per (title, venue) series.
 * The days column is only this week's occurrences -- never render it as the
 * run's real span (see html_render.py's build_all_week).
 */
export function buildAllWeek(
  days: readonly Day[],
  top3TitlesByDate: ReadonlyMap<string, ReadonlySet<string>>,
): AllWeekRow[] {
  const rows = new Map<string, AllWeekRow>();
  for (const day of days) {
    const top3Titles = top3TitlesByDate.get(day.date) ?? new Set<string>();
    for (const event of day.events) {
      const key = JSON.stringify([event.title, event.venue]);
      if (!isAllWeek(event, top3Titles) || rows.has(key)) continue;
      const occurrences = event.occurrences?.length ? event.occurrences : [day.date];
      const weekdays = occurrences.flatMap((iso) => {
        const date = parseIsoDate(iso);
        return date ? [weekdayShort(date)] : [];
      });
      rows.set(key, {
        title: event.title,
        venue: event.venue,
        category: event.category,
        days: weekdays.join(", "),
        price_text: priceClassAndText(event)[1],
      });
    }
  }
  return [...rows.values()];
}

function top3TitlesByDateOf(days: readonly Day[]): Map<string, Set<string>> {
  return new Map(days.map((day) => [day.date, new Set(day.top3.map((pick) => pick.title))]));
}

interface ManifestSources {
  sources?: Record<string, { status?: string; events?: number | null }> | null;
}

/**
 * The "Week in Numbers" section: the collection funnel, per-category hit
 * rate, source concentration, and a collection-health line. The funnel's
 * first stage and the health line need _manifest.json and are simply absent
 * without one.
 */
export function buildStats(
  selections: Pick<Selections, "days" | "total_events_after_dedup">,
  manifest: ManifestSources,
  expected: ExpectedYield,
): Stats {
  const listed = new Map<string, number>();
  const bump = (label: string, by: number): void => {
    listed.set(label, (listed.get(label) ?? 0) + by);
  };
  for (const day of selections.days) {
    const top3Titles = new Set(day.top3.map((pick) => pick.title));
    // true_count, not the displayed length: the cap is a rendering decision.
    for (const category of buildCategories(day, top3Titles)) bump(category.label, category.true_count);
  }
  // All Week events are routed out of the day blocks but are still listed
  // events of their category: count them in both the funnel and the bars.
  for (const row of buildAllWeek(selections.days, top3TitlesByDateOf(selections.days))) bump(row.category ?? "", 1);
  const picks = countBy(
    selections.days.flatMap((day) => day.top3),
    (pick) => pick.category ?? "",
  );

  const maxListed = Math.max(0, ...listed.values());
  const categoryRows = withExtraCategories(listed.keys())
    .filter((label) => listed.get(label))
    .map((label): CategoryStatRow => {
      const count = listed.get(label)!;
      const top3 = picks.get(label) ?? 0;
      return { label, listed: count, top3, listed_pct: (100 * count) / maxListed, top3_pct: (100 * top3) / maxListed };
    })
    .sort((a, b) => b.listed - a.listed || compareStrings(a.label, b.label));

  const counted = buildSources(selections.days)
    .filter((row) => row.count)
    .sort((a, b) => b.count - a.count || compareStrings(a.name, b.name));
  const maxSource = counted[0]?.count ?? 0;
  const sourceRows = counted.map((row): SourceStatRow => ({ ...row, pct: (100 * row.count) / maxSource }));

  const manifestSources = Object.values(manifest.sources ?? {});
  const funnel: [string, number | null | undefined][] = [
    ...(manifestSources.length ? [["Collected", sum(manifestSources.map((s) => s.events ?? 0))] as [string, number]] : []),
    ["Candidates", selections.total_events_after_dedup],
    ["Listed", sum(listed.values())],
    ["Top 3 picks", sum(picks.values())],
  ];
  const stages = funnel
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([label, value], i, all): Stage => {
      const previous = all[i - 1];
      const hasDrop = previous !== undefined && previous[1] !== 0;
      return {
        label,
        value,
        drop_pct: hasDrop ? Math.round((100 * (previous[1] - value)) / previous[1]) : null,
        drop_from: hasDrop ? previous[0].toLowerCase() : null,
        display: value.toLocaleString("en-US"),
      };
    });

  let health: Health | null = null;
  if (manifestSources.length) {
    // check_yield owns what "too few" means, min_expected: 0 exemptions included.
    const belowFloor = checkYieldFloor(manifest as Manifest, expected);
    health = {
      source_count: manifestSources.length,
      contributed: manifestSources.filter((s) => s.events).length,
      below_floor: belowFloor.flatMap((issue) => (issue.source ? [issue.source] : [])).sort(compareStrings),
      run_level_shortfall: belowFloor.some((issue) => issue.source === null),
    };
  }

  return { stages, categories: categoryRows, sources: sourceRows, health };
}

export function buildDayViewmodel(day: Day, spotify: Readonly<Record<string, SpotifyEntry | null>>): DayView {
  const top3Titles = new Set(day.top3.map((pick) => pick.title));
  // Selection writes `note` on the events[] entry, not the top3 pick, so a
  // pick's "multiple showtimes" note has to come from its listing. Python
  // passes "" here, so a Top 3 time never gets the "+" its listing card shows.
  const noteByTitle = new Map<string, string>();
  for (const event of day.events) {
    if (event.note && !noteByTitle.has(event.title)) noteByTitle.set(event.title, event.note);
  }

  const top3 = day.top3.map((pick): PickView => {
    // Same helper as the listed-event cards, so sold_out overrides cost here too.
    const [, costText] = priceClassAndText(pick);
    return {
      rank: pick.rank,
      name_html: buildPickNameHtml(pick, pick.is_music ? spotify[pick.title] : null),
      why: pick.why,
      venue: pick.venue,
      map_url: buildMapUrl(pick.address),
      time_display: displayTime(pick.time, pick.note || noteByTitle.get(pick.title)),
      cost_text: costText || null,
      sold_out: Boolean(pick.sold_out),
    };
  });

  const categories = buildCategories(day, top3Titles);
  return {
    day_name: day.day_name,
    // Weekday, not the ISO date: unambiguous within one Mon-Sun report.
    slug: day.day_name.toLowerCase(),
    date_display: monthDay(requireIsoDate(day.date)),
    date_iso: day.date,
    // True counts, before the display cap.
    event_count: sum(categories.map((category) => category.true_count)),
    top3,
    honorable_mentions_html: buildHonorableMentionsHtml(day.honorable_mentions),
    categories,
  };
}

export function formatFailureNote(raw: string): string {
  const text = raw.trim();
  const idx = text.indexOf("(");
  if (idx === -1) return `${text} unavailable this week`;
  return `${text.slice(0, idx).trim()} unavailable this week (${text.slice(idx + 1)}`;
}

/** The published URL for a week, or null when the week key is missing or malformed. */
export function buildCanonicalUrl(week: string | null | undefined): string | null {
  return week && parseIsoDate(week) ? `${SITE_BASE_URL}weeks/${week}.html` : null;
}

/**
 * [datetime attribute, display text] for the "Compiled ..." subtitle --
 * date-only on purpose, since generated_at is a naive UTC wall clock (see
 * html_render.py's format_compiled). The date is taken as written, with no
 * time-zone conversion.
 */
export function formatCompiled(generatedAt: string | null | undefined): [string | null, string | null] {
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) return [null, null];
  const iso = generatedAt.slice(0, 10);
  const date = parseIsoDate(iso);
  return date ? [iso, weekdayMonthDay(date)] : [null, null];
}

/** The unfurl's one line of body text, derived from the week's own numbers. */
export function buildMetaDescription(
  stats: { stages: readonly { label: string; value: number }[]; sources: readonly unknown[] },
  dateRange: string,
): string {
  const totals = new Map(stats.stages.map((stage) => [stage.label, stage.value]));
  const listed = totals.get("Listed") ?? 0;
  const picks = totals.get("Top 3 picks") ?? 0;
  return (
    `${String(picks)} handpicked things to do in Philadelphia, ${dateRange} — ` +
    `chosen from ${String(listed)} events across ${String(stats.sources.length)} sources.`
  );
}

/** "June 22–28, 2026" / "June 29 – July 5, 2026" from two "YYYY-MM-DD" dates. */
export function formatDateRange(monday: string, sunday: string): string {
  const mon = requireIsoDate(monday);
  const sun = requireIsoDate(sunday);
  const year = sun.getUTCFullYear();
  if (mon.getUTCMonth() === sun.getUTCMonth()) {
    return `${monthDay(mon)}–${String(sun.getUTCDate())}, ${String(year)}`;
  }
  return `${monthDay(mon)} – ${monthDay(sun)}, ${String(year)}`;
}

// ---------------------------------------------------------------------------
// Template rendering (Nunjucks over the shared templates)
// ---------------------------------------------------------------------------

/** Jinja's `format` filter for the one spec the templates use, `'%.Nf'|format(x)`. */
function formatFilter(spec: string, value: number): string {
  const m = /^%\.(\d+)f$/.exec(spec);
  if (!m) throw new Error(`format filter: only '%.Nf' is supported, got ${JSON.stringify(spec)}`);
  return value.toFixed(Number(m[1]));
}

let environment: nunjucks.Environment | undefined;

function templateEnvironment(): nunjucks.Environment {
  environment ??= new nunjucks.Environment(new nunjucks.FileSystemLoader(TEMPLATES_DIR), {
    autoescape: true,
    trimBlocks: true,
    lstripBlocks: true,
  }).addFilter("format", formatFilter);
  return environment;
}

/** Renders one of templates/*.html.j2. */
export function renderTemplate(name: string, context: object): string {
  return templateEnvironment().render(name, context);
}

export function renderReport(weekDir: string): string {
  const selections = loadSelections(weekDir) as Selections;
  const spotify = loadSpotify(weekDir) as Record<string, SpotifyEntry | null>;
  // Optional by design: the header link is simply omitted without it.
  const playlistUrl = (loadPlaylist(weekDir) as { playlist_url?: unknown }).playlist_url;

  const dateRange = formatDateRange(selections.days[0]!.date, selections.days.at(-1)!.date);
  const stats = buildStats(selections, loadManifest(weekDir) as ManifestSources, loadExpectedYield() as ExpectedYield);
  const [compiledIso, compiledDisplay] = formatCompiled(selections.generated_at);

  return renderTemplate("report.html.j2", {
    date_range: dateRange,
    canonical_url: buildCanonicalUrl(selections.week),
    meta_description: buildMetaDescription(stats, dateRange),
    compiled_iso: compiledIso,
    compiled_display: compiledDisplay,
    playlist_url: playlistUrl,
    days: selections.days.map((day) => buildDayViewmodel(day, spotify)),
    all_week: buildAllWeek(selections.days, top3TitlesByDateOf(selections.days)),
    stats,
    sources: buildSources(selections.days),
    collection_failure_notes: (selections.collection_failures ?? []).map(formatFailureNote),
  });
}

/** Regenerates the index from scratch by scanning `weeksDir`/*.html (newest first). */
export function renderIndex(weeksDir: string = WEEKS_DIR): string {
  const weeks = readdirSync(weeksDir)
    .map((name) => /^(.+)\.html$/.exec(name)?.[1])
    .filter((stem): stem is string => stem !== undefined && parseIsoDate(stem) !== null)
    .sort()
    .reverse()
    .map((monday) => ({ href: `weeks/${monday}.html`, label: formatDateRange(monday, weekDates(monday).at(-1)!) }));
  return renderTemplate("index.html.j2", { weeks, site_url: SITE_BASE_URL });
}

function main(): void {
  const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {} });
  const [weekDir, htmlPath] = positionals;
  if (!weekDir || !htmlPath) {
    console.error("usage: htmlRender.js week_dir html_path");
    process.exit(2);
  }

  const htmlOut = renderReport(weekDir);
  mkdirSync(dirname(htmlPath), { recursive: true });
  writeFileSync(htmlPath, htmlOut, "utf8");

  mkdirSync(WEEKS_DIR, { recursive: true });
  writeFileSync(join(DOCS_DIR, "index.html"), renderIndex(), "utf8");

  const dayCount = htmlOut.split('class="day-header"').length - 1;
  console.log(`Report complete. ${String(dayCount)} days rendered. File written: ${htmlPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
