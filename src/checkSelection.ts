#!/usr/bin/env node
/**
 * Port of scripts/check_selection.py -- mechanical post-conditions for a
 * week's Selection output, modeled on check_yield.ts's (not yet ported)
 * role for Collection: the SKILL-level rules in
 * event-selection-philosophy/SKILL.md and philly-events-selection/SKILL.md's
 * own Phase 4 self-check are prose a model reads and can drift from. This
 * script re-checks the parts of that prose that are actually mechanical, in
 * CI, where a check the model runs on itself can be skipped exactly the way
 * a fetch can.
 *
 * Runs against a week's merged _selections.json -- after mergeSelections.ts,
 * not after Selection's own push -- because `title`, `venue`, and `cost`
 * don't exist until the merge. `address` is Selection's own field and is
 * present earlier, but the venue cap needs the resolved venue/address
 * pairing the merge produces, so this runs after it regardless.
 *
 * Two severities: FAIL exits nonzero, the same "any issue -> loud CI
 * failure" contract check_yield uses for Collection. WARN prints but
 * doesn't fail the build -- reserved for checks with a plausible legitimate
 * exception (a genuinely late-night show at 12:30 AM, two workshops that
 * happen to share a title prefix by coincidence), where failing the whole
 * week's report over one false positive would be worse than the thing being
 * guarded against. Per-check severity and the incidents behind each one are
 * documented on each check function below; see check_selection.py's module
 * docstring for the fuller promotion history (cost_blank and time_format
 * were both promoted from WARN to FAIL after running clean/catching a real
 * defect respectively; venue_cap is WARN permanently by Greg's call --
 * three Core-tier DIY/political venues take a third of every top3 slot ever
 * published, and a venue is not a proxy for event quality).
 *
 * Also prints a venue/category/source histogram unconditionally (see
 * summarize()) -- not an Issue, informational, the CI-side confirmation of
 * the same numbers philly-events-selection/SKILL.md's Phase 4 self-check
 * asks the model to print at authoring time.
 *
 * Divergences from the Python, all intentional:
 *
 * - `!r` everywhere (time_value, venue_key, address, prefix, and every
 *   issue.title in formatReport) is ported by pyRepr(), which switches to
 *   double quotes exactly the way Python's repr() does when a string
 *   contains a single quote but no double quote -- load-bearing here, not
 *   cosmetic, because this corpus is full of "Ortlieb's" / "Johnny
 *   Brenda's" / "Cousin Danny's". A naive JSON.stringify or hardcoded
 *   single-quote wrap would diverge on most real titles.
 * - checkTimeFormat: Python's `TIME_RE.match(time_value or "")` raises an
 *   uncaught TypeError when `time` is a non-string truthy value (a list),
 *   which aborts the whole script before any report prints. This port
 *   reports it as a clean FAIL issue instead -- same call merge_selections'
 *   TS port made for the equivalent trap (its divergence #2): both exit
 *   nonzero, but a report that names every other issue too beats a
 *   traceback and silence.
 * - checkImplausibleStartTime reuses mergeSelections.ts's parseTimeForSort
 *   rather than a second %I:%M %p-shaped parser in this file -- one clock
 *   parser per repo tier, not two per file, and it already ports Python's
 *   `except TypeError` (a non-string `time`) as a `typeof` guard returning
 *   null, exactly what this check needs to fall through to "already flagged
 *   by checkTimeFormat, skip."
 * - _repeat_key's Python uses `str.casefold()`, not `.lower()` -- ported as
 *   `.toLowerCase()`. They agree on this corpus (plain ASCII venue/title
 *   text); not engineered around for the theoretical divergence (e.g. "ß").
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadJson } from "./common.js";
import { parseTimeForSort } from "./mergeSelections.js";

export const RECENT_WEEKS_LOOKBACK = 3;

/**
 * The `lookback` most recent week directories before `weekDir` that
 * actually contain a _selections.json, newest first.
 *
 * Counted in *directories*, not calendar weeks: data/ has real gaps (e.g.
 * a Collection-only week with no selections at all), so a date-window
 * would silently reach back further than intended whenever the data is
 * sparse. Directory names are YYYY-MM-DD, so lexicographic order is
 * chronological.
 *
 * Reads the week directories directly and must keep doing so -- it
 * deliberately does NOT read _recent_picks.json, which is a token-saving
 * convenience for Selection that can legitimately be missing or stale. Two
 * independent readers of the same source of truth is the point.
 */
export function loadRecentWeeks(weekDir: string, lookback: number = RECENT_WEEKS_LOOKBACK): unknown[] {
  const resolvedWeekDir = resolve(weekDir);
  const parent = dirname(resolvedWeekDir);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) return [];
  const weekDirName = basename(resolvedWeekDir);
  const prior = readdirSync(parent)
    .filter((name) => statSync(join(parent, name)).isDirectory())
    .filter((name) => name < weekDirName)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const weeks: unknown[] = [];
  for (let i = prior.length - 1; i >= 0; i--) {
    const path = join(parent, prior[i]!, "_selections.json");
    if (!existsSync(path) || !statSync(path).isFile()) continue; // Collection-only week, no selections to compare against
    weeks.push(JSON.parse(readFileSync(path, "utf8")));
    if (weeks.length === lookback) break;
  }
  return weeks;
}

const VENUE_CAP = 2;
const IMPLAUSIBLE_HOUR_START = 0; // 12:00 AM
const IMPLAUSIBLE_HOUR_END = 6; // up to, not including, 6:00 AM

const TIME_RE = /^\d{1,2}:\d{2} [AP]M$/;

export interface Issue {
  check: string;
  severity: "fail" | "warn";
  day: string | null;
  title: string | null;
  message: string;
}

export interface Pick {
  title?: string;
  venue?: string;
  time?: unknown;
  cost?: string;
  category?: string;
  source?: string;
  address?: string;
  venue_address?: string;
  venue_id?: string;
  selection_address?: string;
}

export interface ListedEvent {
  title?: string;
  cost?: string;
}

export interface SelectionsDay {
  date?: string;
  day_name?: string;
  top3?: Pick[];
  honorable_mentions?: unknown[];
  events?: ListedEvent[];
}

export interface Selections {
  week?: string;
  days?: SelectionsDay[];
}

/** Returns [day_date, pick] for every top3 pick in the week, in file order. */
function iterTop3(selections: Selections): [string, Pick][] {
  const picks: [string, Pick][] = [];
  for (const day of selections.days ?? []) {
    for (const pick of day.top3 ?? []) {
      picks.push([day.date ?? "?", pick]);
    }
  }
  return picks;
}

/**
 * Mirrors Python's str repr(): single-quoted by default, switching to
 * double quotes when the string contains a single quote but no double
 * quote, and backslash-escaping the chosen quote character otherwise. See
 * this module's docstring for why the quote-switch is load-bearing here.
 */
function pyRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = value.replace(/\\/g, "\\\\").split(quote).join(`\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

const NON_ALNUM_RE = /[^a-z0-9]/g;

/**
 * Fallback key for the venue cap when a pick has no `address` -- the text
 * before the first comma, lowercased. Matches
 * event-selection-philosophy/SKILL.md's Weekly Patterns fallback rule.
 */
export function normalizeVenue(venue: string): string {
  return venue.split(",")[0]!.trim().toLowerCase();
}

// Whole-token synonyms, applied before the alphanumeric strip. Selection
// authors addresses free-hand and spells the same one several ways across
// weeks; without this, one venue mints several keys.
const ADDRESS_SYNONYMS: Record<string, string> = {
  street: "st",
  str: "st",
  avenue: "ave",
  av: "ave",
  boulevard: "blvd",
  road: "rd",
  drive: "dr",
  place: "pl",
  court: "ct",
  lane: "ln",
  square: "sq",
  terrace: "ter",
  parkway: "pkwy",
  highway: "hwy",
  circle: "cir",
  saint: "st",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  northeast: "ne",
  northwest: "nw",
  southeast: "se",
  southwest: "sw",
};
const UNIT_NOISE = new Set(["suite", "ste", "unit", "apt", "floor", "fl", "rear", "bldg", "usa", "us"]);
const ZIP_RE = /^\d{5}(-\d{4})?$/;

/**
 * Normalize one address string to a comparable street key.
 *
 * Deliberately discards locality (city/state/ZIP) and unit noise, keeping
 * only house number + street -- what makes the key comparable ACROSS
 * SOURCES, which the whole venue cap rests on. See check_selection.py's
 * _street_key docstring for the full verification history (57 -> 52 venue
 * keys across all 126 published top3 picks, zero false merges except the
 * one documented and accepted Moshulu/Spirit of Philadelphia case).
 *
 * Guiding asymmetry: a false SPLIT fails open (a venue is under-counted,
 * the report still ships) while a false MERGE fails closed (a warning
 * about venues that aren't the same room). Resolve anything ambiguous
 * toward splitting.
 */
function streetKey(text: string): string {
  const stripped = [...text.normalize("NFKD").replace(/[̀-ͯ]/g, "")]
    .filter((ch) => (ch.codePointAt(0) ?? 0) <= 0x7f)
    .join("");
  const head = stripped.split(",")[0]!.trim();
  const cleaned = head && /^[0-9]/.test(head) ? head : stripped;
  const tokens = cleaned
    .toLowerCase()
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t.length > 0);
  return tokens
    .filter((t) => !ZIP_RE.test(t) && !UNIT_NOISE.has(t))
    .map((t) => ADDRESS_SYNONYMS[t] ?? t)
    .join("");
}

/**
 * Cap key for a pick: the source's venue address, else Selection's
 * `address`, else a normalized venue-name prefix. Source address first is
 * what fixes a real false merge -- see check_selection.py's _venue_key
 * docstring for the 2026-08-31 Spruce Street Harbor / Cherry Street Pier
 * incident this precedence exists to split.
 */
export function venueKey(pick: Pick): string {
  for (const field of ["venue_address", "address"] as const) {
    const value = pick[field];
    if (value && value.trim()) return streetKey(value);
  }
  return normalizeVenue(pick.venue ?? "").replace(NON_ALNUM_RE, "");
}

/**
 * Identity of an event for cross-week repeat detection: normalized title
 * plus normalized *venue name*. Deliberately NOT venueKey() -- see
 * check_selection.py's _repeat_key docstring for the West Philly canvass
 * case that an address key silently missed two of three repeats on.
 */
function repeatKey(pick: Pick): string {
  const title = (pick.title ?? "").toLowerCase().replace(NON_ALNUM_RE, "");
  const venue = normalizeVenue(pick.venue ?? "").replace(NON_ALNUM_RE, "");
  return `${title}\u0000${venue}`;
}

/**
 * WARN: a top3 pick that already held a top3 slot in a recent week.
 * `priorWeeks` is optional so every caller keeps working; the cross-week
 * check simply produces nothing without it. Scope is deliberately narrow:
 * only an exact repeat of the same event at the same venue -- a new
 * instalment of a series (Dekalog Parts 1&2 -> 3&4) is genuinely different
 * content and is not flagged.
 */
export function checkRepeatOfRecentPick(selections: Selections, priorWeeks?: Selections[] | null): Issue[] {
  const issues: Issue[] = [];
  const seen = new Map<string, Set<string>>();
  for (const prior of priorWeeks ?? []) {
    const week = prior.week ?? "?";
    for (const [, pick] of iterTop3(prior)) {
      const key = repeatKey(pick);
      let weeks = seen.get(key);
      if (!weeks) {
        weeks = new Set();
        seen.set(key, weeks);
      }
      weeks.add(week);
    }
  }

  for (const [dayDate, pick] of iterTop3(selections)) {
    const weeks = seen.get(repeatKey(pick));
    if (!weeks || weeks.size === 0) continue;
    issues.push({
      check: "repeat_pick",
      severity: "warn",
      day: dayDate,
      title: pick.title ?? null,
      message:
        `already held a top3 slot in ${[...weeks].sort().join(", ")} -- ` +
        "event-selection-philosophy's Avoid rule covers recurring events across weeks, " +
        "not just within one. Drop it, or say in the `why` what makes this instance worth the slot",
    });
  }
  return issues;
}

/**
 * WARN permanently, by decision -- see this module's docstring. Reports
 * drift only, naming the venues and ids pooled under each key so a false
 * merge is visible in the output instead of looking like real concentration.
 */
export function checkVenueCap(selections: Selections): Issue[] {
  const issues: Issue[] = [];
  const byVenue = new Map<string, [string, Pick][]>();
  for (const [dayDate, pick] of iterTop3(selections)) {
    const key = venueKey(pick);
    const list = byVenue.get(key);
    if (list) list.push([dayDate, pick]);
    else byVenue.set(key, [[dayDate, pick]]);
  }

  for (const [venue, picks] of byVenue) {
    if (picks.length > VENUE_CAP) {
      const days = picks.map(([d, p]) => `${d} (${pyRepr(p.title ?? "?")})`).join(", ");
      const pooled = [...new Set(picks.map(([, p]) => p.venue ?? "?"))].sort();
      const ids = [...new Set(picks.map(([, p]) => p.venue_id).filter((id): id is string => Boolean(id)))].sort();
      const detail = ` [${pooled.join("; ")}]` + (ids.length ? ` ids=${ids.join(",")}` : "");
      issues.push({
        check: "venue_cap",
        severity: "warn",
        day: null,
        title: null,
        message: `${pyRepr(venue)} took ${String(picks.length)} top3 slots this week: ${days}${detail}`,
      });
    }
  }
  return issues;
}

/** WARN: a top3 pick with no address at all, from either the source or Selection. */
export function checkMissingAddress(selections: Selections): Issue[] {
  const issues: Issue[] = [];
  for (const [dayDate, pick] of iterTop3(selections)) {
    if (!(pick.address ?? "").trim()) {
      issues.push({
        check: "missing_address",
        severity: "warn",
        day: dayDate,
        title: pick.title ?? null,
        message:
          "top3 pick has no address -- its Google Calendar entry will have no location, " +
          "and the venue cap falls back to keying on the venue name",
      });
    }
  }
  return issues;
}

/**
 * WARN: Selection's address disagrees with the source's structured one.
 * mergeSelections.ts prefers the source's, so this is what makes that
 * precedence auditable rather than silent.
 */
export function checkAddressConflict(selections: Selections): Issue[] {
  const issues: Issue[] = [];
  for (const [dayDate, pick] of iterTop3(selections)) {
    const sourceAddress = (pick.venue_address ?? "").trim();
    const modelAddress = (pick.selection_address ?? "").trim();
    if (sourceAddress && modelAddress && streetKey(sourceAddress) !== streetKey(modelAddress)) {
      issues.push({
        check: "address_conflict",
        severity: "warn",
        day: dayDate,
        title: pick.title ?? null,
        message:
          `source says ${pyRepr(sourceAddress)}, Selection wrote ${pyRepr(modelAddress)} -- ` +
          "the source's is used for the calendar pin; check which is right",
      });
    }
  }
  return issues;
}

/**
 * FAIL: regression guard for the defect fixed in 9bbd592 -- every top3
 * pick's `time` must be a single `%I:%M %p` string, never a list, a
 * doors/show pair, or a range. See this module's docstring for the
 * non-string-`time` divergence from the Python.
 */
export function checkTimeFormat(selections: Selections): Issue[] {
  const issues: Issue[] = [];
  for (const [dayDate, pick] of iterTop3(selections)) {
    const timeValue = pick.time;
    const isValid = typeof timeValue === "string" && TIME_RE.test(timeValue);
    if (!isValid) {
      const shown = typeof timeValue === "string" ? timeValue : JSON.stringify(timeValue ?? null);
      issues.push({
        check: "time_format",
        severity: "fail",
        day: dayDate,
        title: pick.title ?? null,
        message:
          `time ${pyRepr(shown)} is not a single H:MM AM/PM value -- calendar_create.py's ` +
          "parse_start() will silently drop this pick's calendar entry",
      });
    }
  }
  return issues;
}

/** FAIL: regression guard for mergeSelections.ts's "Not listed" cost default. */
export function checkCostNotBlank(selections: Selections): Issue[] {
  const issues: Issue[] = [];
  for (const day of selections.days ?? []) {
    for (const pick of day.top3 ?? []) {
      if (!(pick.cost ?? "").trim()) {
        issues.push({
          check: "cost_blank",
          severity: "fail",
          day: day.date ?? null,
          title: pick.title ?? null,
          message: "top3 pick has a blank cost -- merge_selections.py's 'Not listed' default was bypassed",
        });
      }
    }
    for (const event of day.events ?? []) {
      if (!(event.cost ?? "").trim()) {
        issues.push({
          check: "cost_blank",
          severity: "fail",
          day: day.date ?? null,
          title: event.title ?? null,
          message: "listed event has a blank cost -- merge_selections.py's 'Not listed' default was bypassed",
        });
      }
    }
  }
  return issues;
}

/**
 * WARN: a top3 pick starting between 12:00 AM and 5:59 AM is usually a
 * scrape artifact per event-selection-philosophy's Data Plausibility
 * Checklist -- but a real late show is possible, so this is flagged for
 * review, not failed. Reuses mergeSelections.ts's parseTimeForSort rather
 * than a second time parser -- see this module's docstring.
 */
export function checkImplausibleStartTime(selections: Selections): Issue[] {
  const issues: Issue[] = [];
  for (const [dayDate, pick] of iterTop3(selections)) {
    const minutes = parseTimeForSort(pick.time);
    if (minutes === null) continue; // unparseable -- already flagged by checkTimeFormat
    const hour = Math.floor(minutes / 60);
    if (hour >= IMPLAUSIBLE_HOUR_START && hour < IMPLAUSIBLE_HOUR_END) {
      issues.push({
        check: "implausible_time",
        severity: "warn",
        day: dayDate,
        title: pick.title ?? null,
        message: `starts at ${String(pick.time)} -- often a scrape artifact per the Data Plausibility Checklist; confirm this is really the start time before trusting it`,
      });
    }
  }
  return issues;
}

function seriesPrefix(title: string): string | null {
  for (const sep of [":", " - ", "—"]) {
    if (title.includes(sep)) {
      const prefix = title.split(sep)[0]!.trim();
      if (prefix) return prefix.toLowerCase();
      // Falls through to the next separator when this one strips to empty.
    }
  }
  return null;
}

/**
 * WARN: a soft heuristic for the same-series cap -- two top3 picks in one
 * week sharing both a venue and a title prefix before the first colon or
 * dash likely belong to the same series. Titles vary more than this
 * catches, which is why the SKILL-level rule is still the primary
 * enforcement -- this is a backstop, not authoritative.
 */
export function checkSameSeries(selections: Selections): Issue[] {
  const issues: Issue[] = [];
  const seen = new Map<string, { venue: string; prefix: string; occurrences: [string, string][] }>();
  for (const [dayDate, pick] of iterTop3(selections)) {
    const prefix = seriesPrefix(pick.title ?? "");
    if (prefix === null) continue;
    const venue = venueKey(pick);
    const key = `${venue}\u0000${prefix}`;
    let entry = seen.get(key);
    if (!entry) {
      entry = { venue, prefix, occurrences: [] };
      seen.set(key, entry);
    }
    entry.occurrences.push([dayDate, pick.title ?? ""]);
  }

  for (const { venue, prefix, occurrences } of seen.values()) {
    if (occurrences.length > 1) {
      const days = occurrences.map(([d, t]) => `${d} (${pyRepr(t)})`).join(", ");
      issues.push({
        check: "same_series",
        severity: "warn",
        day: null,
        title: null,
        message:
          `${String(occurrences.length)} top3 picks at ${pyRepr(venue)} share the title prefix ${pyRepr(prefix)} ` +
          `-- possibly the same series (event-selection-philosophy's same-series cap): ${days}`,
      });
    }
  }
  return issues;
}

/**
 * WARN: event-selection-philosophy's Data Plausibility Checklist names "a
 * venue address outside Philadelphia" as something to verify. Skips picks
 * with no `address` at all -- a missing address falls back to a venue-name
 * key with no municipality to check, and treating "no address" as "not
 * Philadelphia" would false-positive on address-less picks.
 */
export function checkOutsidePhiladelphia(selections: Selections): Issue[] {
  const issues: Issue[] = [];
  for (const [dayDate, pick] of iterTop3(selections)) {
    const address = pick.address;
    if (!address) continue;
    if (!address.toLowerCase().includes("philadelphia")) {
      issues.push({
        check: "outside_philadelphia",
        severity: "warn",
        day: dayDate,
        title: pick.title ?? null,
        message: `address ${pyRepr(address)} doesn't name Philadelphia -- confirm this is really in the city, and that the why explains the travel if it's not`,
      });
    }
  }
  return issues;
}

/**
 * `priorWeeks` is optional so every existing caller keeps working; the
 * cross-week check simply produces nothing without it.
 */
export function collectIssues(selections: Selections, priorWeeks?: Selections[] | null): Issue[] {
  return [
    ...checkVenueCap(selections),
    ...checkTimeFormat(selections),
    ...checkCostNotBlank(selections),
    ...checkImplausibleStartTime(selections),
    ...checkSameSeries(selections),
    ...checkOutsidePhiladelphia(selections),
    ...checkRepeatOfRecentPick(selections, priorWeeks),
    ...checkMissingAddress(selections),
    ...checkAddressConflict(selections),
  ];
}

export function summarize(selections: Selections): string {
  const venues = new Map<string, number>();
  const categories = new Map<string, number>();
  const sources = new Map<string, number>();
  for (const [, pick] of iterTop3(selections)) {
    const venue = venueKey(pick);
    venues.set(venue, (venues.get(venue) ?? 0) + 1);
    const category = pick.category ?? "?";
    categories.set(category, (categories.get(category) ?? 0) + 1);
    const source = pick.source ?? "?";
    sources.set(source, (sources.get(source) ?? 0) + 1);
  }

  // Stable sort, count-descending -- ties keep first-seen (insertion) order,
  // no alphabetical secondary key. Matches Python's `sorted(..., key=lambda
  // kv: -kv[1])` over an already-insertion-ordered dict.
  const fmt = (counts: Map<string, number>): string => {
    if (counts.size === 0) return "(none)";
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(", ");
  };

  return [
    `top3 by venue: ${fmt(venues)}`,
    `top3 by category: ${fmt(categories)}`,
    `top3 by source: ${fmt(sources)}`,
  ].join("\n");
}

export function formatReport(issues: Issue[], week: string): string {
  const fails = issues.filter((i) => i.severity === "fail");
  const warns = issues.filter((i) => i.severity === "warn");
  const lines = [`check_selection: ${week}`];

  if (issues.length === 0) {
    lines.push("  no issues found.");
  } else {
    const byCheck = new Map<string, Issue[]>();
    for (const issue of issues) {
      const list = byCheck.get(issue.check);
      if (list) list.push(issue);
      else byCheck.set(issue.check, [issue]);
    }
    for (const [check, checkIssues] of byCheck) {
      lines.push(`\n${checkIssues[0]!.severity.toUpperCase()} -- ${check}:`);
      for (const issue of checkIssues) {
        const where = issue.day ? `[${issue.day}] ` : "";
        const title = issue.title ? `${pyRepr(issue.title)}: ` : "";
        lines.push(`  ${where}${title}${issue.message}`);
      }
    }
  }

  lines.push(`\n${String(fails.length)} fail(s), ${String(warns.length)} warn(s).`);
  return lines.join("\n");
}

function main(): void {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { selections: { type: "string" } },
  });
  const weekDir = positionals[0];
  if (!weekDir) {
    console.error("usage: check_selection.js <week_dir> [--selections PATH]");
    process.exit(2);
  }

  const selectionsPath = values.selections ?? join(weekDir, "_selections.json");
  const selections = loadJson(selectionsPath) as Selections;
  const priorWeeks = loadRecentWeeks(weekDir) as Selections[];

  const issues = collectIssues(selections, priorWeeks);
  const week = selections.week ?? basename(weekDir);

  console.log(formatReport(issues, week));
  console.log();
  console.log(summarize(selections));

  if (issues.some((i) => i.severity === "fail")) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
