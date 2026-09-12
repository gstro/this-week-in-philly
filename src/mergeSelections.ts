/**
 * Deterministic merge: _candidates.json + Selection's _selection_annotations.json
 * -> _selections.json, in exactly the schema Presentation's four consumer scripts
 * (html_render.py, calendar_create.py, spotify_lookup.py, csv_log.py) already expect.
 *
 * Runs as presentation.yml's first step, before scripts/runner.sh -- not as its
 * own push-triggered workflow. A separate workflow that merged and pushed
 * _selections.json would push with the default GITHUB_TOKEN, which does not
 * retrigger `on: push`; presentation.yml would then never fire for that push,
 * same constraint that already forced check_yield.py inline into
 * collection.yml and prepare_selection_input.py inline as well. Selection
 * itself pushes _selection_annotations.json with ambient user auth, so
 * presentation.yml's `on: push` trigger fires for that push -- see the trigger
 * repoint in presentation.yml.
 *
 * Why a merge step exists at all, rather than Selection writing _selections.json
 * directly: Selection re-transcribing title/venue/time/cost/url/source data it
 * was just handed in _candidates.json cost ~32k output tokens per run for no
 * reason -- see the token-optimization plan. Selection now writes only the
 * judgment calls (category, sold_out, note, why, rank, is_music, address) keyed
 * by a candidate's stable `id`; this script reconstructs the rest verbatim. One
 * exception: a top3 pick MAY include an explicit `time` override, letting
 * Selection still clean up a candidate's genuinely messy raw time (a list, a
 * doors/show pair, a range) the way it always could -- see buildTop3.
 *
 * Two consequences of resolving by id instead of Selection re-typing title/venue:
 *
 * 1. It closes a real drift bug: on the real 2026-08-03 week, 62 of 562 events
 *    in _selections.json did not join back to any candidate by exact title
 *    string (Selection had silently reworded some titles). html_render.py's
 *    star (top3) marking and Spotify/calendar lookups all key off exact title
 *    match -- resolving top3/honorable_mentions/events from the same candidate
 *    id guarantees the title used everywhere is the one that already round-trips.
 * 2. It requires every id Selection references to actually resolve, appear on
 *    the day it's placed under, and (for top3/honorable_mentions) also appear
 *    in that day's own annotations list -- so the event shows up in `events[]`
 *    with its full card. A merge that silently dropped a referenced event
 *    would be the same failure class check_yield.py already guards against
 *    for raw Collection data; this script raises instead.
 *
 * events[] order is not cosmetic: html_render.py's build_categories() sorts by
 * parsed time with the original array index as the final tie-break, and (an
 * unwired but still-live) csv_log.py's honorable-mention lookup resolves ties
 * by earliest array position. This script emits events[] pre-ordered by
 * CATEGORY_ORDER, then chronologically within category, with ties
 * broken by each candidate's original position in _candidates.json -- fully
 * reproducible regardless of what order Selection's annotations happen to be
 * written in.
 *
 * `is_music` is written on top3 picks only, not on events[] -- confirmed by
 * grepping every consumer (scripts/ and templates/): only pick/top3 objects
 * are ever read for is_music (html_render.py's Spotify-link lookup,
 * spotify_lookup.py's batch lookup, csv_log.py's spotify_link column). No
 * consumer reads it off an events[] entry, so omitting it there is a schema
 * simplification with zero behavior change, not a feature cut.
 *
 * `cost` defaults to "Not listed" rather than "" when the candidate has no
 * price -- confirmed live on 2026-08-10: 13 of 21 top3 picks rendered a blank
 * cost, which is the source data faithfully passed through (Selection can no
 * longer write cost at all, so it can't be inventing this), but a blank card
 * field reads as broken rather than as "genuinely not listed." The prior
 * failure this same field had -- Selection inventing prices like "typical for
 * Wooden Shoe programming" before this refactor -- can't recur through this
 * path, so this default doesn't reopen it.
 *
 * A top3 pick's resolved `time` (the override if one was given, else the
 * candidate's raw value) must parse as a single `%I:%M %p` string, or this
 * script raises -- confirmed live on 2026-08-17: two picks (a PhilaMOCA
 * double-header) omitted the `time` override, so this fell through to the
 * candidate's dirty raw "7:00, 7:30", which calendar_create.py's parse_start()
 * silently can't parse -- both picks published with no calendar entry, and
 * check_selection.py only caught it as a WARN, so the bad week shipped
 * anyway. This is the same invariant class as the required-field checks
 * above (a Selection omission that would otherwise silently degrade a
 * downstream consumer), just discovered later -- raising here, before
 * _selections.json is even written, means the fix is "correct the
 * annotation and re-run," not "notice a missing calendar entry after the
 * fact."
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { CATEGORY_ORDER, loadJson } from "./common.js";
import type { Candidate } from "./prepareSelectionInput.js";
import { writeJson } from "./lib/json.js";

/**
 * Matches check_selection.py's TIME_RE -- both enforce the same "single
 * clean H:MM AM/PM start time" contract from 9bbd592, at two different
 * points in the pipeline (this one at merge time, that one as a
 * CI-visible post-condition on the merge's own output).
 *
 * One deliberate divergence from the Python: its `$` also matches just
 * before a trailing newline, so "7:00 PM\n" passes the guard there and
 * fails here. That leniency is a latent hole, not a behavior worth
 * porting -- calendar_create.py's parse_start() rejects the value anyway, so
 * Python lets through exactly the case this guard exists to catch.
 */
const TIME_RE = /^\d{1,2}:\d{2} [AP]M$/;

/**
 * The sort's time parser is deliberately NOT TIME_RE -- it mirrors
 * Python's `strptime("%I:%M %p")`, which is both looser and stricter in
 * different places, and the difference is load-bearing because events[]
 * (unlike top3) is never time-guarded and so routinely sorts dirty
 * values: `%I` is 1-12 (so "13:00 PM" parses under TIME_RE but sorts
 * last here), `%M` is one or two digits, `%p` is case-insensitive (so
 * "7:00 pm" fails TIME_RE but still sorts chronologically), and the
 * format's single space matches a run of whitespace.
 */
const SORT_TIME_RE = /^(1[0-2]|0[1-9]|[1-9]):([0-5]\d|\d)\s+(AM|PM)$/i;

/**
 * Raised for any of the fail-loud conditions below. Caught once, in
 * main(), and reported as a single clean message -- never a condition
 * this script silently works around, since a merge that quietly drops or
 * misfiles a referenced event is the exact failure class it exists to
 * prevent.
 */
export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeError";
  }
}

export interface CandidatesDoc {
  week?: string;
  collection_failures?: string[];
  raw_event_count?: number;
  candidates: Candidate[];
}

export interface Top3Pick {
  id: string;
  rank?: number;
  category?: string;
  is_music?: boolean;
  sold_out?: boolean;
  why?: string;
  address?: string;
  time?: string;
}

export interface Annotation {
  id: string;
  category?: string;
  sold_out?: boolean;
  note?: string;
}

export interface AnnotationDay {
  date?: string;
  day_name?: string;
  top3?: Top3Pick[];
  honorable_mentions?: { id: string }[];
  annotations?: Annotation[];
}

export interface AnnotationsDoc {
  week: string;
  collection_failures?: string[];
  days: AnnotationDay[];
}

export interface Top3Entry {
  rank: number;
  title: string;
  venue: string;
  address?: string;
  venue_address?: string;
  venue_id?: string;
  selection_address?: string;
  time: string;
  cost: string;
  url: string;
  category: string;
  source: string;
  is_music: boolean;
  sold_out: boolean;
  why: string;
}

export interface EventEntry {
  title: string;
  venue: string;
  time: string;
  cost: string;
  url: string;
  category: string;
  source: string;
  sold_out: boolean;
  note?: string;
  recurrence_count?: number;
  occurrences?: string[];
}

export interface SelectionsDay {
  date: string;
  day_name: string;
  top3: Top3Entry[];
  honorable_mentions: { title: string; venue: string }[];
  events: EventEntry[];
}

export interface SelectionsDoc {
  week: string;
  total_events_after_dedup: number;
  collection_failures: string[];
  days: SelectionsDay[];
  generated_at?: string;
}

/** Mirrors Python's `!r` in the error messages below, so stderr reads identically. */
function repr(value: unknown): string {
  if (value === undefined || value === null) return "None";
  if (typeof value === "string") return `'${value}'`;
  return JSON.stringify(value) ?? "None";
}

function candidateLookup(candidatesDoc: CandidatesDoc): Map<string, Candidate> {
  const byId = new Map<string, Candidate>();
  for (const candidate of candidatesDoc.candidates) {
    if (candidate.id !== undefined) byId.set(candidate.id, candidate);
  }
  return byId;
}

function resolveCandidate(
  candidateId: string,
  dayDate: string,
  candidatesById: Map<string, Candidate>,
  context: string,
): Candidate {
  const candidate = candidatesById.get(candidateId);
  if (candidate === undefined) {
    throw new MergeError(`${context}: id ${repr(candidateId)} does not match any candidate in _candidates.json`);
  }
  if (candidate.date !== dayDate) {
    throw new MergeError(
      `${context}: id ${repr(candidateId)} (${repr(candidate.title)}) belongs to ` +
        `${repr(candidate.date)}, not the day it was placed under (${repr(dayDate)})`,
    );
  }
  return candidate;
}

/**
 * top3 and honorable_mentions ids must also appear in that day's own
 * `annotations` list -- otherwise the pick/mention would have no entry in
 * events[], which is where consumers (html_render.py's category listing,
 * csv_log.py's honorable-mention lookup) get its category/source/cost/note.
 */
function requireInAnnotations(
  candidateId: string,
  annById: Map<string, Annotation>,
  dayDate: string,
  kind: string,
): void {
  if (!annById.has(candidateId)) {
    throw new MergeError(
      `${dayDate}: ${kind} id ${repr(candidateId)} is not present in this day's annotations -- it would be missing from events[]`,
    );
  }
}

export function buildTop3(
  day: AnnotationDay,
  candidatesById: Map<string, Candidate>,
  annById: Map<string, Annotation>,
): Top3Entry[] {
  const dayDate = day.date!;
  const result: Top3Entry[] = [];
  for (const pick of day.top3 ?? []) {
    const candidateId = pick.id;
    const candidate = resolveCandidate(candidateId, dayDate, candidatesById, `${dayDate} top3`);
    requireInAnnotations(candidateId, annById, dayDate, "top3");
    // category, why, and rank have no safe default -- a missing one is a
    // real Selection bug, fail loudly. is_music/sold_out DO have a safe
    // default (false), so they're defaulted rather than required: at
    // ~350 annotated candidates a week, a model omitting an
    // occasionally-false boolean is exactly the compression that happens
    // at volume, and requiring it would fail the whole week's report
    // over a single omitted `false`.
    for (const field of ["category", "why", "rank"] as const) {
      if (!(field in pick)) {
        throw new MergeError(`${dayDate} top3 id ${repr(candidateId)}: annotation missing required field ${repr(field)}`);
      }
    }
    // `time` normally comes verbatim from the candidate -- an explicit
    // override on the pick lets Selection still clean up a genuinely
    // messy raw time (a list, a doors/show pair, a range) into the
    // single clean start time calendar_create.py's parse_start()
    // requires, same capability the old re-typed-everything schema
    // had. Rare in practice (omitted on the overwhelming majority of
    // picks), so it costs nothing in the common case -- but when the
    // candidate's own time IS messy and no override was given, the
    // resolved value is exactly as unparseable as the raw scrape, and
    // that must fail loudly rather than silently drop the calendar
    // entry (see this module's docstring for the real 2026-08-17 case).
    const resolvedTime = "time" in pick ? pick.time : (candidate.time ?? "");
    if (typeof resolvedTime !== "string" || !TIME_RE.test(resolvedTime)) {
      throw new MergeError(
        `${dayDate} top3 id ${repr(candidateId)} (${repr(candidate.title)}): resolved time ` +
          `${repr(resolvedTime)} is not a single H:MM AM/PM value -- calendar_create.py's ` +
          `parse_start() would silently drop this pick's calendar entry. Set a clean \`time\` ` +
          `override on this pick's annotation (see philly-events-selection/SKILL.md's ` +
          `annotation field notes).`,
      );
    }
    // `address` becomes the Google Calendar entry's `location`
    // (calendar_create.py), so a wrong one sends you to the wrong place and
    // a missing one leaves the entry unpinned. Two candidate answers exist:
    // the source's structured venue address and Selection's, authored from
    // memory. Prefer the source's.
    //
    // That precedence is measured, not assumed. Joining a live re-fetch of
    // the 2026-08-31 week onto its committed do215.json (373/373 events
    // matched on permalink) and recomputing that week's 21 top3 venue keys
    // both ways: with Selection's address first, Spruce Street Harbor and
    // Cherry Street Pier collapse into one key at "301 S Christopher
    // Columbus Blvd" -- an address Selection invented for both, and wrong
    // for Cherry Street Pier, which Do215 puts at 121 N. With the source's
    // address first they separate correctly and the calendar entry points
    // at the right pier.
    //
    // The counter-precedent (2026-08-10, where the model overrode PhilaMOCA
    // and was right that the show was at the Keswick) does not apply: that
    // was a bad venue DISPLAY STRING from PhilaMOCA's own feed
    // self-stamping its address onto an offsite show, not a structured
    // per-event venue record. Do215 supplies the latter and has no such
    // failure mode. Deliberately not extended to philamoca.py or
    // the_rotunda.py, whose hardcoded addresses ARE that self-stamp.
    //
    // Nothing is lost silently when the model was right:
    // check_selection.py's address_conflict warns whenever the two disagree.
    const resolvedAddress = candidate.venue_address || pick.address || "";
    result.push({
      rank: pick.rank!,
      title: candidate.title ?? "",
      venue: candidate.venue ?? "",
      ...(resolvedAddress ? { address: resolvedAddress } : {}),
      // Carried for check_selection.py, which only ever sees
      // _selections.json -- without them it cannot compare the two
      // addresses or report which venues a cap bucket actually pooled.
      ...(candidate.venue_address ? { venue_address: candidate.venue_address } : {}),
      ...(candidate.venue_id ? { venue_id: candidate.venue_id } : {}),
      // Only when BOTH exist, i.e. only when there is a disagreement to
      // audit. With no source address, `address` above already is
      // Selection's and recording it twice is pure duplication.
      ...(pick.address && candidate.venue_address ? { selection_address: pick.address } : {}),
      time: resolvedTime,
      cost: candidate.cost || "Not listed",
      url: candidate.url ?? "",
      category: pick.category!,
      source: candidate.source ?? "",
      is_music: pick.is_music ?? false,
      sold_out: pick.sold_out ?? false,
      why: pick.why!,
    });
  }
  return result;
}

export function buildHonorableMentions(
  day: AnnotationDay,
  candidatesById: Map<string, Candidate>,
  annById: Map<string, Annotation>,
): { title: string; venue: string }[] {
  const dayDate = day.date!;
  const result: { title: string; venue: string }[] = [];
  for (const mention of day.honorable_mentions ?? []) {
    const candidateId = mention.id;
    const candidate = resolveCandidate(candidateId, dayDate, candidatesById, `${dayDate} honorable_mentions`);
    requireInAnnotations(candidateId, annById, dayDate, "honorable_mentions");
    // Python indexes these directly (a bare KeyError, not a MergeError, if
    // a candidate somehow lacks them). Defaulting to "" instead: in TS a
    // missing field would otherwise serialize as `undefined` and JSON
    // .stringify would DROP the key, turning a loud crash into a silently
    // malformed mention.
    let title = candidate.title ?? "";
    // html_render.py's build_honorable_mentions_html() bolds a literal
    // "(SOLD OUT)" suffix on the title -- restoring that requires
    // appending it here, since the title now always comes verbatim from
    // the candidate (which never carries this suffix itself). This
    // breaks the honorable-mention's exact-title match against
    // events[] (whose title has no suffix), but csv_log.py's
    // find_matching_event() already has a fuzzy-match fallback for
    // exactly this case -- its own docstring names "a (SOLD OUT) suffix
    // added" as the real, observed reason that fallback exists.
    if (annById.get(candidateId)?.sold_out && !title.endsWith("(SOLD OUT)")) {
      title = `${title} (SOLD OUT)`;
    }
    result.push({ title, venue: candidate.venue ?? "" });
  }
  return result;
}

/**
 * Minutes since midnight, or null when the value does not parse -- the
 * non-string guard ports Python's `except TypeError`, which is not
 * theoretical here: a raw scraped `time` can be a list (see this module's
 * docstring), and unlike Python's `strptime` a JS regex would happily
 * coerce `["7:00 PM"]` to a matching string.
 */
export function parseTimeForSort(eventTime: unknown): number | null {
  if (typeof eventTime !== "string") return null;
  const match = SORT_TIME_RE.exec(eventTime);
  if (match === null) return null;
  let hour = Number(match[1]) % 12;
  if (match[3]!.toUpperCase() === "PM") hour += 12;
  return hour * 60 + Number(match[2]);
}

export function buildEvents(
  day: AnnotationDay,
  candidatesDoc: CandidatesDoc,
): EventEntry[] {
  const dayDate = day.date!;
  const annById = new Map<string, Annotation>();
  for (const ann of day.annotations ?? []) annById.set(ann.id, ann);
  for (const [candidateId, ann] of annById) {
    // sold_out has a safe default (false) and is deliberately not
    // required here -- see buildTop3's comment on the same tradeoff.
    if (!("category" in ann)) {
      throw new MergeError(`${dayDate} annotation id ${repr(candidateId)}: missing required field 'category'`);
    }
    if (!(CATEGORY_ORDER as readonly string[]).includes(ann.category)) {
      throw new MergeError(
        `${dayDate} annotation id ${repr(candidateId)}: category ${repr(ann.category)} is not one of the nine canonical categories`,
      );
    }
  }

  const events: EventEntry[] = [];
  // Iterate candidates in their original _candidates.json order (not
  // annById's insertion order) so ties in the sort below break on a fixed,
  // reproducible position rather than whatever order Selection happened
  // to write annotations in.
  for (const candidate of candidatesDoc.candidates) {
    const candidateId = candidate.id;
    const ann = candidateId === undefined ? undefined : annById.get(candidateId);
    if (ann === undefined) continue;
    if (candidate.date !== dayDate) {
      throw new MergeError(
        `${dayDate} annotation id ${repr(candidateId)} (${repr(candidate.title)}) belongs to ${repr(candidate.date)}, not ${repr(dayDate)}`,
      );
    }
    events.push({
      title: candidate.title ?? "",
      venue: candidate.venue ?? "",
      time: candidate.time ?? "",
      cost: candidate.cost || "Not listed",
      url: candidate.url ?? "",
      category: ann.category!,
      source: candidate.source ?? "",
      sold_out: ann.sold_out ?? false,
      ...(ann.note ? { note: ann.note } : {}),
      // Recurrence, carried from the candidate so html_render.py can
      // build the "All Week / Recurring" table. groupRecurring() in
      // prepareSelectionInput has emitted these since the v2 data
      // layout landed -- they just never survived this merge, which is
      // why html_render.py's docstring long claimed _selections.json had
      // "no structured field a script could use to detect a 3+ day span"
      // and the spec'd table never rendered once in six published weeks.
      //
      // `occurrences` is ONLY the dates the series falls on inside the
      // collected week. It is not the run's real start or end and must
      // never be rendered as one -- see html_render.py's build_all_week.
      //
      // Both tests mirror Python truthiness, which is why `occurrences`
      // checks `.length`: an empty list is falsy in Python and omits the
      // key, where a bare `[]` would be truthy in JS and emit it.
      ...(candidate.recurrence_count ? { recurrence_count: candidate.recurrence_count } : {}),
      ...(candidate.occurrences?.length ? { occurrences: candidate.occurrences } : {}),
    });
  }

  events.sort((a, b) => {
    const categoryDelta =
      (CATEGORY_ORDER as readonly string[]).indexOf(a.category) - (CATEGORY_ORDER as readonly string[]).indexOf(b.category);
    if (categoryDelta !== 0) return categoryDelta;
    const parsedA = parseTimeForSort(a.time);
    const parsedB = parseTimeForSort(b.time);
    // Unparseable sorts last within its category, matching Python's
    // `parsed is None` as the second tuple element.
    if ((parsedA === null) !== (parsedB === null)) return parsedA === null ? 1 : -1;
    // `??`, not `||` -- midnight is 0, which is falsy in JS but a
    // perfectly ordinary sort position.
    return (parsedA ?? 0) - (parsedB ?? 0);
  });
  return events;
}

export function mergeDay(
  day: AnnotationDay,
  candidatesDoc: CandidatesDoc,
  candidatesById: Map<string, Candidate>,
): SelectionsDay {
  for (const field of ["date", "day_name"] as const) {
    if (!(field in day)) {
      throw new MergeError(`a day entry is missing required field ${repr(field)}: ${JSON.stringify(day)}`);
    }
  }
  const annById = new Map<string, Annotation>();
  for (const ann of day.annotations ?? []) annById.set(ann.id, ann);
  return {
    date: day.date!,
    day_name: day.day_name!,
    top3: buildTop3(day, candidatesById, annById),
    honorable_mentions: buildHonorableMentions(day, candidatesById, annById),
    events: buildEvents(day, candidatesDoc),
  };
}

export function merge(candidatesDoc: CandidatesDoc, annotationsDoc: AnnotationsDoc): SelectionsDoc {
  const candidatesById = candidateLookup(candidatesDoc);
  // Key presence, not `??` -- Python's `.get(k, default)` falls back only
  // when the key is absent, so a present-but-null annotations value stays
  // null rather than reaching past it to the candidates doc.
  const collectionFailures =
    "collection_failures" in annotationsDoc
      ? annotationsDoc.collection_failures
      : "collection_failures" in candidatesDoc
        ? candidatesDoc.collection_failures
        : [];
  return {
    week: annotationsDoc.week,
    total_events_after_dedup: candidatesDoc.candidates.length,
    collection_failures: collectionFailures,
    days: annotationsDoc.days.map((day) => mergeDay(day, candidatesDoc, candidatesById)),
  };
}

/**
 * Local wall-clock, second precision, no timezone suffix -- matches
 * Python's `datetime.now().isoformat(timespec="seconds")` and the untyped
 * local-time convention already in real _selections.json files.
 * `toISOString()` would emit UTC with a `Z`.
 */
function localTimestampSeconds(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

function main(): void {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { out: { type: "string" } },
  });
  const weekDir = positionals[0];
  if (!weekDir) {
    console.error("usage: merge_selections.js <week_dir> [--out PATH]");
    process.exit(2);
  }

  const candidatesDoc = loadJson(join(weekDir, "_candidates.json")) as CandidatesDoc;
  const annotationsDoc = loadJson(join(weekDir, "_selection_annotations.json")) as AnnotationsDoc;

  let result: SelectionsDoc;
  try {
    result = merge(candidatesDoc, annotationsDoc);
  } catch (error) {
    if (error instanceof MergeError) {
      console.error(`merge_selections: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  // Added here, not inside merge(), so merge() stays a pure function of
  // its two inputs -- deterministic and easy to test. Purely informational:
  // grepped every consumer, nothing reads generated_at.
  result.generated_at = localTimestampSeconds();

  const outPath = values.out ?? join(weekDir, "_selections.json");
  writeFileSync(outPath, writeJson(result));

  const totalTop3 = result.days.reduce((sum, day) => sum + day.top3.length, 0);
  const totalEvents = result.days.reduce((sum, day) => sum + day.events.length, 0);
  console.error(
    `Merge complete. ${String(result.days.length)} day(s), ${String(totalTop3)} top3 pick(s), ` +
      `${String(totalEvents)} listed event(s). Written to ${outPath}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
