#!/usr/bin/env node
/**
 * Port of scripts/html_render.py -- renders data/YYYY-MM-DD/_selections.json
 * (+ _spotify.json, _playlist.json, _manifest.json) into the weekly HTML
 * report, then regenerates docs/index.html to link every published week.
 *
 * See html_render.py's module docstring for the product-level divergences
 * from v1's historical LLM-rendered output (fixed category order, verbatim
 * text, the restored All Week table, the unfixed one-Spotify-link-per-pick
 * gap). Those are behaviours of the renderer itself, so this port inherits
 * them unchanged; tests/golden/actual-2026-06-22.html pins both
 * implementations to the same bytes.
 *
 * Template engine: Nunjucks, rendering the very same templates/*.html.j2
 * files Jinja2 renders for the Python. There is deliberately one spec of
 * record -- templates/report.html.j2's own comments are the report spec --
 * so duplicating the markup into TS (or into a second template dialect)
 * would create two copies to keep in sync. Nunjucks parses every construct
 * the two templates use (`{% for %}...{% else %}`, `loop.first/last`,
 * inline `x if c else y`, `is not none`, `|safe`, `|join`) and implements
 * trim_blocks/lstrip_blocks, and rendering Python's own template context
 * through it differed only in the engine-level semantics adapted below; no
 * template edit was needed. The adaptations, all confined to this module's
 * render boundary (renderTemplate) so the view-model builders stay
 * Python-shaped:
 *
 * - Output semantics. Nunjucks' autoescape maps `"` to `&quot;` and `\` to
 *   `&#92;`; Jinja2's markupsafe maps `"` to `&#34;` and leaves `\` alone.
 *   Nunjucks prints null as "", Jinja2 prints None as "None" (and True/False
 *   capitalized). Nunjucks has no hook for either, but every `{{ }}` compiles
 *   to a call through `runtime.suppressValue`, looked up on the shared
 *   runtime module at render time, so renderTemplate swaps in a Jinja2-
 *   faithful version for the duration of one synchronous render and restores
 *   the original in `finally`. That reaches into a Nunjucks internal, which
 *   is why package.json pins nunjucks to an exact version and
 *   htmlRender.test.ts has a guard test that fails loudly if the hook stops
 *   taking effect.
 * - Truthiness. Jinja2 treats an empty list/dict as false (`{% if all_week
 *   %}`, `{% if stats.health.below_floor %}`); JS treats `[]` as true, which
 *   rendered an empty All Week table header. jinjaContext() deep-maps empty
 *   arrays and empty plain objects to null in the template context only:
 *   Nunjucks then skips `if` blocks and runs a `for` loop's `else` branch on
 *   them, exactly as Jinja2 does for an empty container.
 * - keep_trailing_newline=False. Jinja2 normalizes \r\n / \r to \n in the
 *   template source and drops one trailing newline; JinjaSourceLoader does
 *   the same before Nunjucks compiles the file.
 * - `'%.1f'|format(x)`. Nunjucks has no `format` filter; a small custom one
 *   implements Python %-formatting for the only spec the template uses
 *   (`%.Nf`), with Python's exact round-half-even on the binary value.
 * - `is none`. Registered as a custom test (`value === null`), Jinja2's
 *   `value is None`.
 *
 * Divergences from the Python, all intentional:
 *
 * - Float formatting. `'%.1f'` and `round()` are mirrored exactly (Python
 *   rounds an exact binary tie half-to-even: `'%.1f' % 6.25` is "6.2", and
 *   `round(12.5)` is 12, where toFixed/Math.round give "6.3" and 13), as is
 *   `f"{n:,}"` grouping. What JS can't mirror is int-vs-float identity: a
 *   JSON `1.0` is the number 1 here, so a field Python would print as "1.0"
 *   prints as "1". No committed week carries a float in a printed field.
 * - Dates. parseIsoDate/parseIsoDateTime accept only strict ISO 8601
 *   (YYYY-MM-DD, optionally "T"/space + HH:MM[:SS[.ffffff]] + Z/+HH:MM),
 *   where Python 3.12's `fromisoformat` also takes basic ("20260622") and
 *   week-date ("2026-W26-1") forms -- see parseIsoDate. strftime's %a/%A/%B
 *   are hardcoded English (Python runs in the C locale in CI), never Intl.
 *   Nothing here builds a Date from a timestamp string, so there is no
 *   local-time skew of the kind checkYield.ts guards against.
 * - Unicode edge cases. `str.casefold()` becomes `toLowerCase()` (they
 *   differ only for characters like "ß"/"ſ", irrelevant to the ASCII needles
 *   "meetup:" and "multiple showtimes" and to English weekday slugs).
 *   strptime's `\d`/`\s` are Unicode-aware in Python and nearly so in JS
 *   (JS `\d` is ASCII-only; the `\s` sets differ in \x1c-\x1f, \x85 and
 *   U+FEFF). `str.strip()` is mirrored with Python's exact whitespace set
 *   (pyStrip) for this module's own strips; common.ts's
 *   stripPlaceholderWrapper still uses `trim()`, a pre-existing divergence of
 *   that port.
 * - Printing a non-scalar. Jinja2 prints a list/dict as its Python repr and
 *   an empty container that jinjaContext() mapped to null would print
 *   "None" here. Neither template prints a container directly.
 * - A manifest source with `"events": null`. Python's check_yield_floor
 *   raises TypeError on it (`sum(r.get("events", 0))`), taking the whole
 *   render down; checkYield.ts's checkYieldFloor treats it as 0 (`?? 0`),
 *   so this renders. Inherited from that port; no committed manifest has a
 *   null events count.
 * - Python bugs fixed here rather than reproduced (flagged in PR #72's
 *   port; no committed week triggers any of them, so parity on real data
 *   is unaffected):
 *   - Non-canonical categories render after the canonical nine instead of
 *     vanishing from the day blocks and stats (withExtraCategories).
 *   - A Top 3 time gets the "+" multiple-showtimes suffix its listing card
 *     gets (buildDayViewmodel reads the note from the events[] entry).
 *   - An empty Spotify matched_text falls back to the event link instead of
 *     an empty <a> (buildPickNameHtml).
 *   - A comma inside a Meetup group's name doesn't split it into two
 *     sources (splitSourceField).
 *   - Lax ISO dates are rejected (see Dates above).
 *   The funnel's double minus on a stage that grew ("−-314%") was fixed in
 *   templates/report.html.j2 itself, so both renderers print "+314%".
 * - renderIndex takes the weeks directory as an optional parameter (default
 *   docs/weeks) rather than reading a module constant, so it can be pointed
 *   at a scratch dir without monkeypatching. The CLI behaves identically.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
// Python-semantics helpers
// ---------------------------------------------------------------------------

/** Python truthiness: empty containers are false, unlike JS. */
function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

// Exactly the characters for which Python's str.isspace() is true -- what a
// bare str.strip() removes.
const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

/** Python's `str.strip()` with no arguments. */
function pyStrip(text: string): string {
  return text.replace(PY_STRIP_RE, "");
}

/** Compares by Unicode code point, as Python's str ordering does (JS's default compares UTF-16 units). */
function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** Python's `html.escape(s, quote=False)`. */
function htmlEscapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Python's `html.escape(s, quote=True)` -- note `&#x27;`, not markupsafe's `&#39;`. */
function htmlEscapeQuoted(text: string): string {
  return htmlEscapeText(text).replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

/** markupsafe.escape, which Jinja2's autoescape uses. */
export function markupEscape(text: string): string {
  return htmlEscapeText(text).replace(/'/g, "&#39;").replace(/"/g, "&#34;");
}

/** Python's `urllib.parse.quote_plus(s)` (safe=""): space -> "+", and `!'()*` encoded too. */
function quotePlus(text: string): string {
  return encodeURIComponent(text)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** Python's `round(x)` to an int: exact binary ties go to the even neighbour. */
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor; // exact for doubles
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Python's `'%.{digits}f' % x`: rounds the *exact* binary value, ties to
 * even. toFixed() rounds exact ties up instead ("6.3" for 6.25, Python "6.2").
 */
export function pyFormatFixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const negative = x < 0 || Object.is(x, -0);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1075;
  const scale = 10n ** BigInt(digits);
  let scaled: bigint;
  if (exponent >= 0) {
    scaled = (mantissa << BigInt(exponent)) * scale;
  } else {
    const numerator = mantissa * scale;
    const denominator = 1n << BigInt(-exponent);
    scaled = numerator / denominator;
    const twiceRemainder = 2n * (numerator % denominator);
    if (twiceRemainder > denominator || (twiceRemainder === denominator && scaled % 2n === 1n)) {
      scaled += 1n;
    }
  }
  const text = scaled.toString().padStart(digits + 1, "0");
  const intPart = text.slice(0, text.length - digits);
  const fracPart = text.slice(text.length - digits);
  return `${negative ? "-" : ""}${intPart}${digits > 0 ? `.${fracPart}` : ""}`;
}

/** Python's `f"{n:,}"` for an int (or a float, grouping only the integer part). */
export function pyThousands(n: number): string {
  const text = Number.isInteger(n) ? String(Math.abs(n)) : String(Math.abs(n));
  const [intPart = "", fracPart] = text.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 ? "-" : ""}${grouped}${fracPart !== undefined ? `.${fracPart}` : ""}`;
}

/** Python's `int(x)` for the JSON shapes `recurrence_count` can take. */
function pyInt(value: unknown): number {
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const stripped = pyStrip(value).replace(/_/g, "");
    if (/^[+-]?\d+$/.test(stripped)) return Number.parseInt(stripped, 10);
    throw new Error(`invalid literal for int() with base 10: '${value}'`);
  }
  throw new TypeError(`int() argument must be a string or a number, not '${typeof value}'`);
}

/** Python's str() of a scalar, as Jinja2 prints it. */
function pyStr(value: unknown): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  // Not Python's repr for a container -- neither template prints one.
  return JSON.stringify(value) ?? "";
}

interface IsoDate {
  year: number;
  month: number;
  day: number;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validDate(year: number, month: number, day: number): IsoDate | null {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A strict YYYY-MM-DD date; null otherwise. Deliberately narrower than
 * Python's `date.fromisoformat`, which also takes the basic form
 * ("20260622") and ISO week dates ("2026-W26-1") -- so html_render.py would
 * publish a canonical URL like weeks/20260622.html and list such a file in
 * the index. Every date this pipeline writes is YYYY-MM-DD.
 */
export function parseIsoDate(text: string): IsoDate | null {
  const m = ISO_DATE_RE.exec(text);
  if (!m) return null;
  return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

const ISO_DATETIME_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-](\d{2}):(\d{2}))?)?$/;

/**
 * The date part of a strict ISO 8601 timestamp (no tz conversion, like
 * Python's `.date()`): YYYY-MM-DD, optionally followed by "T" or a space,
 * HH:MM[:SS[.ffffff]] and a Z or +/-HH:MM offset. Null otherwise -- narrower
 * than `datetime.fromisoformat`, for the same reason as parseIsoDate.
 */
export function parseIsoDateTime(text: string): IsoDate | null {
  const m = ISO_DATETIME_RE.exec(text);
  if (!m) return null;
  const datePart = parseIsoDate(m[1]!);
  if (!datePart) return null;
  const [hh, mm, ss, offH, offM] = [m[2], m[3], m[4], m[5], m[6]].map((v) =>
    v === undefined ? 0 : Number(v),
  ) as [number, number, number, number, number];
  if (hh > 23 || mm > 59 || ss > 59 || offH > 23 || offM > 59) return null;
  return datePart;
}

function dayOfWeek(d: IsoDate): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay(); // Sunday = 0
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function monthName(d: IsoDate): string {
  return MONTH_NAMES[d.month - 1]!;
}

function weekdayName(d: IsoDate): string {
  return WEEKDAY_NAMES[dayOfWeek(d)]!;
}

function isoDateString(d: IsoDate): string {
  return `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

function requireIsoDate(text: string): IsoDate {
  const parsed = parseIsoDate(text);
  if (!parsed) throw new Error(`Invalid isoformat string: '${text}'`);
  return parsed;
}

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
  const parts = (raw || "")
    .split(SOURCE_SPLIT_RE)
    .map((part) => pyStrip(part))
    .filter((part) => part);
  const merged: string[] = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
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
  const name = pyStrip(raw);
  if (isMeetupSource(name)) return "Meetup";
  return SOURCE_ALIASES[name] ?? name;
}

/**
 * The footer, derived from the week's own events. Every known source renders;
 * contributors carry a count; contributors not in SOURCES (retired sources in
 * archived weeks) render unlinked, sorted, after the known ones.
 */
export function buildSources(days: readonly { events: readonly { source?: string | null }[] }[]): SourceRow[] {
  const counts = new Map<string, number>();
  for (const day of days) {
    for (const event of day.events) {
      for (const part of splitSourceField(event.source)) {
        const name = normalizeSourceName(part);
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }

  const rows: SourceRow[] = [];
  for (const [name, url] of SOURCES) {
    rows.push({ name, url, count: counts.get(name) ?? 0 });
    counts.delete(name);
  }
  for (const name of [...counts.keys()].sort(compareCodePoints)) {
    rows.push({ name, url: null, count: counts.get(name)! });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Per-event helpers
// ---------------------------------------------------------------------------

/** A Google Maps search link for a Top 3 pick's address, or null without one. */
export function buildMapUrl(address: string | null | undefined): string | null {
  const stripped = pyStrip(address || "");
  if (!stripped) return null;
  return `https://www.google.com/maps/search/?api=1&query=${quotePlus(stripped)}`;
}

export function cleanCost(cost: string | null | undefined): string {
  return stripPlaceholderWrapper(cost);
}

export function hasMultipleShowtimes(note: string | null | undefined): boolean {
  return (note || "").toLowerCase().includes("multiple showtimes");
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
  if (pyTruthy(event.sold_out)) return ["sold-out", "SOLD OUT"];
  const cost = cleanCost(event.cost ?? "");
  return [isFreeCost(cost) ? "price-free" : "price-paid", cost];
}

export function buildPickNameHtml(
  pick: { title: string; url?: string; is_music?: unknown },
  spotifyEntry: SpotifyEntry | null | undefined,
): string {
  const title = pick.title;
  if (pyTruthy(pick.is_music) && pyTruthy(spotifyEntry)) {
    const matched = spotifyEntry!.matched_text;
    // An empty matched_text would "match" at index 0 and emit an empty <a>
    // (Python's build_pick_name_html does exactly that); treat it as no match.
    const idx = matched ? title.indexOf(matched) : -1;
    if (idx !== -1) {
      const before = htmlEscapeText(title.slice(0, idx));
      const after = htmlEscapeText(title.slice(idx + matched.length));
      const label = htmlEscapeText(matched);
      const url = htmlEscapeQuoted(spotifyEntry!.spotify_url);
      return `${before}<a href="${url}">${label}</a>${after}`;
    }
  }
  const url = htmlEscapeQuoted(pick.url as string);
  const label = htmlEscapeText(title);
  return `<a class="event-link" href="${url}">${label}</a>`;
}

export function buildEventNameHtml(event: { title: string; url?: string }, isTop3: boolean): string {
  const url = htmlEscapeQuoted(event.url as string);
  const label = htmlEscapeText(event.title);
  const prefix = isTop3 ? "⭐ " : "";
  return `<a href="${url}">${prefix}${label}</a>`;
}

export function buildHonorableMentionsHtml(mentions: readonly HonorableMention[] | null | undefined): string | null {
  if (!mentions || mentions.length === 0) return null;
  return mentions
    .map((m) => {
      const title = htmlEscapeText(m.title).split("(SOLD OUT)").join("(<strong>SOLD OUT</strong>)");
      return `${title} at ${htmlEscapeText(m.venue)}`;
    })
    .join(" · ");
}

// datetime.strptime(s, "%I:%M %p")'s actual compiled regex on Python 3.12
// (`_strptime._TimeRE_cache.pattern("%I:%M %p")`): %I also accepts a
// space-padded hour (" 7:00 PM" parses), the format's space becomes \s+,
// matching is case-insensitive, and it must consume the whole string.
const STRPTIME_I_M_P_RE = /^(1[0-2]|0[1-9]|[1-9]| [1-9]):([0-5]\d|\d)\s+(am|pm)$/i;

/** Minutes past midnight for "7:00 PM", or null where strptime raises. */
export function parseTimeForSort(eventTime: unknown): number | null {
  if (typeof eventTime !== "string") return null;
  const m = STRPTIME_I_M_P_RE.exec(eventTime);
  if (!m) return null;
  const hour12 = Number(m[1]!.trim()) % 12;
  const hour = m[3]!.toLowerCase() === "pm" ? hour12 + 12 : hour12;
  return hour * 60 + Number(m[2]);
}

/**
 * Top 3 first, then Honorable Mentions, then chronological; unparseable times
 * last within their tier; ties keep original array order. Applied before the
 * display cap so the cap can never drop something Selection vetted.
 */
function priorityKey(
  event: SelectionEvent,
  top3Titles: ReadonlySet<string>,
  hmTitles: ReadonlySet<string>,
  index: number,
): number[] {
  const parsed = parseTimeForSort(event.time ?? "");
  return [
    top3Titles.has(event.title) ? 0 : 1,
    hmTitles.has(event.title) ? 0 : 1,
    parsed === null ? 1 : 0,
    parsed ?? 0,
    index,
  ];
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * True when this event belongs in the All Week table instead of a day's
 * category block. A Top 3 pick is deliberately never routed out of its day.
 */
export function isAllWeek(event: SelectionEvent, top3Titles: ReadonlySet<string>): boolean {
  if (top3Titles.has(event.title)) return false;
  const count = event.recurrence_count;
  return pyInt(pyTruthy(count) ? count : 0) >= RECURRING_THRESHOLD;
}

/**
 * CATEGORY_ORDER, then any non-canonical category actually present, in first-
 * seen order. Python iterates CATEGORY_ORDER alone, so an event whose category
 * isn't one of the nine canonical strings silently vanishes from its day and
 * from the stats; here it still renders, under its own label, after the rest.
 */
function withExtraCategories(present: Iterable<string>): string[] {
  const canonical = new Set<string>(CATEGORY_ORDER);
  const extras = [...new Set(present)].filter((label) => !canonical.has(label));
  return [...CATEGORY_ORDER, ...extras];
}

export function buildCategories(
  day: { events: SelectionEvent[]; honorable_mentions?: HonorableMention[] },
  top3Titles: ReadonlySet<string>,
): CategoryView[] {
  const hmTitles = new Set((day.honorable_mentions ?? []).map((mention) => mention.title));
  const byCategory = new Map<string, SelectionEvent[]>();
  for (const event of day.events) {
    if (isAllWeek(event, top3Titles)) continue;
    const key = event.category as string;
    const list = byCategory.get(key);
    if (list) list.push(event);
    else byCategory.set(key, [event]);
  }

  const categories: CategoryView[] = [];
  for (const label of withExtraCategories(byCategory.keys())) {
    const events = byCategory.get(label);
    if (!events || events.length === 0) continue;
    const ordered = events
      .map((event, index) => ({ event, key: priorityKey(event, top3Titles, hmTitles, index) }))
      .sort((a, b) => compareKeys(a.key, b.key));
    const displayed = ordered.slice(0, CATEGORY_DISPLAY_CAP);
    const viewEvents: EventView[] = displayed.map(({ event }) => {
      const [priceClass, priceText] = priceClassAndText(event);
      return {
        name_html: buildEventNameHtml(event, top3Titles.has(event.title)),
        note: pyTruthy(event.note) ? (event.note as string) : null,
        venue: event.venue,
        time_display: displayTime(event.time ?? "", event.note ?? ""),
        price_class: priceClass,
        price_text: priceText,
      };
    });
    // "No silent caps": say when the display cap actually dropped something.
    const omitted = events.length - displayed.length;
    categories.push({ label, events: viewEvents, true_count: events.length, omitted: omitted || null });
  }
  return categories;
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
      if (!isAllWeek(event, top3Titles)) continue;
      const key = JSON.stringify([event.title, event.venue]);
      if (rows.has(key)) continue;
      const occurrences = pyTruthy(event.occurrences) ? event.occurrences! : [day.date];
      const weekdays: string[] = [];
      for (const iso of occurrences) {
        const parsed = parseIsoDate(iso);
        if (!parsed) continue;
        weekdays.push(weekdayName(parsed).slice(0, 3));
      }
      const [, priceText] = priceClassAndText(event);
      rows.set(key, {
        title: event.title,
        venue: event.venue,
        category: event.category,
        days: weekdays.join(", "),
        price_text: priceText,
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
  const picks = new Map<string, number>();
  const bump = (counter: Map<string, number>, key: string, by: number): void => {
    counter.set(key, (counter.get(key) ?? 0) + by);
  };
  for (const day of selections.days) {
    const top3Titles = new Set(day.top3.map((pick) => pick.title));
    for (const category of buildCategories(day, top3Titles)) {
      // true_count, not the displayed length: the cap is a rendering decision.
      bump(listed, category.label, category.true_count);
    }
    for (const pick of day.top3) bump(picks, pick.category as string, 1);
  }

  // All Week events are routed out of the day blocks but are still listed
  // events of their category: count them in both the funnel and the bars.
  for (const row of buildAllWeek(selections.days, top3TitlesByDateOf(selections.days))) {
    bump(listed, row.category as string, 1);
  }

  const categoryRows: CategoryStatRow[] = [];
  const maxListed = Math.max(0, ...listed.values());
  for (const label of withExtraCategories(listed.keys())) {
    const count = listed.get(label) ?? 0;
    if (!count) continue;
    const top3 = picks.get(label) ?? 0;
    categoryRows.push({
      label,
      listed: count,
      top3,
      listed_pct: (100.0 * count) / maxListed,
      top3_pct: (100.0 * top3) / maxListed,
    });
  }
  // Labels all lead with astral-plane emoji, where UTF-16 and code-point
  // order happen to agree -- compareCodePoints is used anyway so that
  // doesn't have to stay true.
  categoryRows.sort((a, b) => b.listed - a.listed || compareCodePoints(a.label, b.label));

  const counted = buildSources(selections.days).filter((row) => row.count);
  counted.sort((a, b) => b.count - a.count || compareCodePoints(a.name, b.name));
  const maxSource = counted[0]?.count ?? 0;
  const sourceRows: SourceStatRow[] = counted.map((row) => ({ ...row, pct: (100.0 * row.count) / maxSource }));

  const listedTotal = [...listed.values()].reduce((sum, n) => sum + n, 0);
  const raw: { label: string; value: number | null | undefined }[] = [];
  const manifestSources = manifest.sources;
  const hasManifestSources = pyTruthy(manifestSources);
  if (hasManifestSources) {
    raw.push({
      label: "Collected",
      value: Object.values(manifestSources!).reduce((sum, s) => sum + (s.events || 0), 0),
    });
  }
  raw.push({ label: "Candidates", value: selections.total_events_after_dedup });
  raw.push({ label: "Listed", value: listedTotal });
  raw.push({ label: "Top 3 picks", value: [...picks.values()].reduce((sum, n) => sum + n, 0) });
  const stages: Stage[] = raw
    .filter((stage): stage is { label: string; value: number } => stage.value !== null && stage.value !== undefined)
    .map((stage) => ({
      label: stage.label,
      value: stage.value,
      // Set explicitly, even on the first stage -- see html_render.py.
      drop_pct: null,
      drop_from: null,
      display: pyThousands(stage.value),
    }));
  for (let i = 1; i < stages.length; i++) {
    const previous = stages[i - 1]!;
    const stage = stages[i]!;
    if (previous.value) {
      stage.drop_pct = pyRound((100.0 * (previous.value - stage.value)) / previous.value);
      stage.drop_from = previous.label.toLowerCase();
    }
  }

  let health: Health | null = null;
  if (hasManifestSources) {
    // check_yield owns what "too few" means, min_expected: 0 exemptions included.
    const belowFloor = checkYieldFloor(manifest as Manifest, expected);
    health = {
      source_count: Object.keys(manifestSources!).length,
      contributed: Object.values(manifestSources!).filter((s) => pyTruthy(s.events)).length,
      below_floor: belowFloor
        .map((issue) => issue.source)
        .filter((source): source is string => Boolean(source))
        .sort(compareCodePoints),
      run_level_shortfall: belowFloor.some((issue) => issue.source === null),
    };
  }

  return { stages, categories: categoryRows, sources: sourceRows, health };
}

export function buildDayViewmodel(day: Day, spotify: Readonly<Record<string, SpotifyEntry | null>>): DayView {
  const dayDate = requireIsoDate(day.date);
  const top3Titles = new Set(day.top3.map((pick) => pick.title));
  // Selection writes `note` on the events[] entry, not the top3 pick, so a
  // pick's "multiple showtimes" note has to come from its listing. Python
  // passes "" here, so a Top 3 time never gets the "+" its listing card shows.
  const noteByTitle = new Map<string, string>();
  for (const event of day.events) {
    if (event.note && !noteByTitle.has(event.title)) noteByTitle.set(event.title, event.note);
  }

  const top3: PickView[] = day.top3.map((pick) => {
    const spotifyEntry = pyTruthy(pick.is_music) ? spotify[pick.title] : null;
    // Same helper as the listed-event cards, so sold_out overrides cost here too.
    const [, costText] = priceClassAndText(pick);
    return {
      rank: pick.rank,
      name_html: buildPickNameHtml(pick, spotifyEntry),
      why: pick.why,
      venue: pick.venue,
      map_url: buildMapUrl(pick.address),
      time_display: displayTime(pick.time ?? "", pick.note || noteByTitle.get(pick.title) || ""),
      cost_text: costText || null,
      sold_out: pyTruthy(pick.sold_out),
    };
  });

  const categories = buildCategories(day, top3Titles);
  return {
    day_name: day.day_name,
    // Weekday, not the ISO date: unambiguous within one Mon-Sun report.
    slug: day.day_name.toLowerCase(),
    date_display: `${monthName(dayDate)} ${String(dayDate.day)}`,
    date_iso: day.date,
    // True counts, before the display cap.
    event_count: categories.reduce((sum, category) => sum + category.true_count, 0),
    top3,
    honorable_mentions_html: buildHonorableMentionsHtml(day.honorable_mentions ?? []),
    categories,
  };
}

export function formatFailureNote(raw: string): string {
  const stripped = pyStrip(raw);
  const idx = stripped.indexOf("(");
  if (idx !== -1) {
    const name = stripped.slice(0, idx);
    const rest = stripped.slice(idx + 1);
    return `${pyStrip(name)} unavailable this week (${rest}`;
  }
  return `${stripped} unavailable this week`;
}

/** The published URL for a week, or null when the week key is missing or malformed. */
export function buildCanonicalUrl(week: string | null | undefined): string | null {
  if (!parseIsoDate(week || "")) return null;
  return `${SITE_BASE_URL}weeks/${week!}.html`;
}

/**
 * [datetime attribute, display text] for the "Compiled ..." subtitle --
 * date-only on purpose, since generated_at is a naive UTC wall clock (see
 * html_render.py's format_compiled).
 */
export function formatCompiled(generatedAt: string | null | undefined): [string | null, string | null] {
  const parsed = parseIsoDateTime(generatedAt || "");
  if (!parsed) return [null, null];
  return [isoDateString(parsed), `${weekdayName(parsed)}, ${monthName(parsed)} ${String(parsed.day)}`];
}

/** The unfurl's one line of body text, derived from the week's own numbers. */
export function buildMetaDescription(
  stats: { stages: readonly { label: string; value: number }[]; sources: readonly unknown[] },
  dateRange: string,
): string {
  const totals = new Map(stats.stages.map((stage) => [stage.label, stage.value]));
  const listed = totals.get("Listed") ?? 0;
  const picks = totals.get("Top 3 picks") ?? 0;
  const sources = stats.sources.length;
  return (
    `${String(picks)} handpicked things to do in Philadelphia, ${dateRange} — ` +
    `chosen from ${String(listed)} events across ${String(sources)} sources.`
  );
}

/** "June 22–28, 2026" / "June 29 – July 5, 2026" from two "YYYY-MM-DD" dates. */
export function formatDateRange(monday: string, sunday: string): string {
  const mon = requireIsoDate(monday);
  const sun = requireIsoDate(sunday);
  if (mon.month === sun.month) {
    return `${monthName(mon)} ${String(mon.day)}–${String(sun.day)}, ${String(sun.year)}`;
  }
  return `${monthName(mon)} ${String(mon.day)} – ${monthName(sun)} ${String(sun.day)}, ${String(sun.year)}`;
}

// ---------------------------------------------------------------------------
// Template rendering (Nunjucks over the shared Jinja2 templates)
// ---------------------------------------------------------------------------

/** Jinja2's template-source preprocessing: newline normalization, and keep_trailing_newline=False. */
export function jinjaSource(src: string): string {
  const lines = src.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

class JinjaSourceLoader extends nunjucks.Loader implements nunjucks.ILoader {
  constructor(private readonly root: string) {
    super();
  }

  getSource(name: string): nunjucks.LoaderSource {
    const path = join(this.root, name);
    return { src: jinjaSource(readFileSync(path, "utf8")), path, noCache: false };
  }
}

/** Python's '%.Nf' % value -- the only format spec the templates use. */
function formatFilter(spec: unknown, ...args: unknown[]): string {
  const m = typeof spec === "string" ? /^%\.(\d+)f$/.exec(spec) : null;
  if (!m || args.length !== 1 || typeof args[0] !== "number") {
    throw new Error(`format filter: only '%.Nf' with one number is ported, got ${JSON.stringify([spec, ...args])}`);
  }
  return pyFormatFixed(args[0], Number(m[1]));
}

let environment: nunjucks.Environment | null = null;

function jinjaEnvironment(): nunjucks.Environment {
  if (!environment) {
    environment = new nunjucks.Environment(new JinjaSourceLoader(TEMPLATES_DIR), {
      autoescape: true,
      trimBlocks: true,
      lstripBlocks: true,
    });
    environment.addFilter("format", formatFilter);
    // addTest exists at runtime but is missing from @types/nunjucks.
    (environment as unknown as { addTest(name: string, test: (value: unknown) => boolean): void }).addTest(
      "none",
      (value) => value === null,
    );
  }
  return environment;
}

/**
 * Empty arrays / plain objects -> null, so Nunjucks' JS truthiness matches
 * Jinja2's Python truthiness in `if` and `for ... else`. Template context only.
 */
export function jinjaContext(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? null : value.map(jinjaContext);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length === 0) return null;
    return Object.fromEntries(entries.map(([key, v]) => [key, jinjaContext(v)]));
  }
  return value;
}

type SuppressValue = (val: unknown, autoescape: boolean) => unknown;
const nunjucksRuntime = nunjucks.runtime as unknown as {
  suppressValue: SuppressValue;
  SafeString: typeof nunjucks.runtime.SafeString;
};
if (typeof nunjucksRuntime.suppressValue !== "function") {
  throw new Error("nunjucks.runtime.suppressValue is missing -- the pinned nunjucks version changed; see htmlRender.ts");
}

/** What Jinja2 emits for `{{ val }}`: Undefined -> "", None -> "None", markupsafe escaping. */
const jinjaSuppressValue: SuppressValue = (val, autoescape) => {
  if (val === undefined) return "";
  if (val instanceof nunjucksRuntime.SafeString) return val;
  const text = pyStr(val);
  return autoescape ? markupEscape(text) : text;
};

/** Renders one of templates/*.j2 with Jinja2's output semantics (see module docstring). */
export function renderTemplate(name: string, context: Record<string, unknown>): string {
  const env = jinjaEnvironment();
  const original = nunjucksRuntime.suppressValue;
  nunjucksRuntime.suppressValue = jinjaSuppressValue;
  try {
    return env.render(name, jinjaContext(context) as object);
  } finally {
    nunjucksRuntime.suppressValue = original;
  }
}

export function renderReport(weekDir: string): string {
  const selections = loadSelections(weekDir) as Selections;
  const spotify = loadSpotify(weekDir) as Record<string, SpotifyEntry | null>;
  // Optional by design: the header link is simply omitted without it.
  const playlistUrl = (loadPlaylist(weekDir) as { playlist_url?: unknown }).playlist_url;

  const dateRange = formatDateRange(selections.days[0]!.date, selections.days[selections.days.length - 1]!.date);

  const days = selections.days.map((day) => buildDayViewmodel(day, spotify));
  const allWeek = buildAllWeek(selections.days, top3TitlesByDateOf(selections.days));
  const collectionFailureNotes = (selections.collection_failures ?? []).map(formatFailureNote);

  const stats = buildStats(selections, loadManifest(weekDir) as ManifestSources, loadExpectedYield() as ExpectedYield);
  const [compiledIso, compiledDisplay] = formatCompiled(selections.generated_at);

  return renderTemplate("report.html.j2", {
    date_range: dateRange,
    canonical_url: buildCanonicalUrl(selections.week),
    meta_description: buildMetaDescription(stats, dateRange),
    compiled_iso: compiledIso,
    compiled_display: compiledDisplay,
    playlist_url: playlistUrl,
    days,
    all_week: allWeek,
    stats,
    sources: buildSources(selections.days),
    collection_failure_notes: collectionFailureNotes,
  });
}

/** Regenerates the index from scratch by scanning `weeksDir`/*.html (newest first). */
export function renderIndex(weeksDir: string = WEEKS_DIR): string {
  const weekFiles = readdirSync(weeksDir)
    .filter((name) => name.endsWith(".html") && name.length > ".html".length)
    .sort(compareCodePoints)
    .reverse();
  const weeks: { href: string; label: string }[] = [];
  for (const name of weekFiles) {
    const stem = name.slice(0, -".html".length);
    const monday = parseIsoDate(stem);
    if (!monday) continue;
    const mondayIso = isoDateString(monday);
    const sunday = weekDates(mondayIso)[6]!;
    weeks.push({ href: `weeks/${name}`, label: formatDateRange(mondayIso, sunday) });
  }
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
