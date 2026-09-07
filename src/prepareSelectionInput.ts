#!/usr/bin/env node
/**
 * Port of scripts/prepare_selection_input.py -- Collection's deterministic
 * pre-filter for Selection's input. Reads _manifest.json + every status:ok
 * source file in a week directory and writes one flattened, deduped,
 * annotated candidate list to data/YYYY-MM-DD/_candidates.json.
 *
 * Every dedupe rule here traces to a documented, measured incident, not a
 * hypothetical:
 *
 * 1. Per-event source tagging. A source's `source` name lives at the FILE
 *    level ({"source": "...", "events": [...]}), not per-event -- naively
 *    flattening files without this step loses which source each event came
 *    from. It also sidesteps a real footgun in the raw per-source files: a
 *    successful source's file has no `status` field at all (only the
 *    manifest says status: ok); a failed source's file HAS status: failed
 *    but no `events` key at all. Filtering by the manifest, never the files
 *    themselves, avoids reading a nonexistent `events` array on every
 *    failed source.
 * 2. Exact-duplicate collapse: same (title, venue, date) -> duplicate.
 *    Source priority when merging: R5 Productions > PhilaMOCA > Philly Ask
 *    A Punk > Do215 > everything else. No clear priority -> keep the most
 *    complete entry. A sold-out mention in a discarded entry's description
 *    is preserved as a note on the kept entry rather than silently lost.
 * 2b. Cross-source duplicate collapse: same (date, normalized title) from
 *    more than one source -> duplicate, resolved by the same
 *    source-priority rule as step 2. Step 2 keys on `venue`, which sources
 *    spell differently for the same room, so ~5% of the pool survived it.
 *    Single-source groups are left alone -- that is what keeps five
 *    distinct Dave & Buster's locations sharing one title from fusing. See
 *    collapseCrossSourceDuplicates' docstring for the full safety argument
 *    and the published wrong-venue defect that motivated it.
 * 3. Recurring-listing grouping: same (title, venue) appearing on 3+
 *    distinct dates this week collapses to one representative (earliest
 *    date), with an added occurrences/recurrence_count annotation. Reuses
 *    events-report-format/SKILL.md's own "3+ days" recurring threshold.
 *    Real motivating case: do215's museum-tour-style daily re-listings.
 *    Never dropped, only annotated -- Selection still applies its own
 *    "avoid recurring weekly events unless something special" judgment,
 *    just against ~1 entry per series instead of 5+.
 * 4. Stable `id` assignment (c0000-style strings), after grouping so it's
 *    assigned exactly once against the final deduped/grouped list.
 *    Selection's annotations and merge_selections.ts key off this id
 *    instead of re-matching on title text -- closing a real drift bug
 *    where a reworded title silently failed to join back to its candidate.
 * 5. `description` capped at 600 chars on emit (raw source files
 *    untouched). Measured against a real week: description was 55% of the
 *    candidates file's token count, and p90 was 751 chars, so this keeps
 *    full text for ~90% of events while bounding the worst case.
 *
 * Optionally (--split-by-day) also writes one candidate file per date under
 * data/YYYY-MM-DD/_candidates/, so a per-day Selection agent reads only its
 * own day's tokens instead of the whole week's.
 *
 * Never touches _selections.json's schema and never makes a judgment call
 * -- scoring, Top 3 selection, and blurb writing stay entirely in
 * Selection's Routine. Exact-string matching only, no fuzzy title matching.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { RECURRING_THRESHOLD, weekDates } from "./common.js";
import { loadRecentWeeks } from "./checkSelection.js";
import { writeJson } from "./lib/json.js";

export interface Candidate {
  title?: string;
  venue?: string;
  date?: string;
  time?: string;
  cost?: string;
  url?: string;
  description?: string;
  source?: string;
  venue_address?: string;
  venue_id?: string;
  id?: string;
  occurrences?: string[];
  recurrence_count?: number;
}

interface ManifestSourceEntry {
  status?: string;
  reason?: string;
  events?: number;
}

interface Manifest {
  week?: string;
  sources?: Record<string, ManifestSourceEntry>;
}

interface CandidatesDoc {
  week: string;
  collection_failures: string[];
  raw_event_count: number;
  exact_duplicates_collapsed: number;
  cross_source_duplicates_collapsed: number;
  candidates: Candidate[];
}

// Lower index = higher priority when merging an exact (title, venue, date)
// duplicate. Matches docs/v1/Scheduled/philly-events-selection/SKILL.md
// Phase 2's source-priority list verbatim (its 5th tier, "all other
// sources", is anything not in this list -- see priorityRank).
export const SOURCE_PRIORITY = ["R5 Productions", "PhilaMOCA", "Philly Ask A Punk", "Do215"];

// Applied on emit only -- raw source files under data/<week>/ are never
// touched. Keeps the full text for ~90% of real events; the other ~10%
// lose detail Selection rarely used anyway (a why/note blurb draws from
// the first sentence or two).
export const DESCRIPTION_CAP = 600;

/** Lower is higher priority. A source not in SOURCE_PRIORITY shares the
 * lowest rank with every other unlisted source (v1's "all other sources" tier). */
export function priorityRank(source: string | undefined): number {
  const index = SOURCE_PRIORITY.indexOf(source ?? "");
  return index === -1 ? SOURCE_PRIORITY.length : index;
}

/** Count of non-empty optional fields -- the tiebreak v1's spec falls back
 * to when no source-priority rule distinguishes two exact-duplicate entries. */
export function completeness(event: Candidate): number {
  return (["time", "cost", "url", "description"] as const).filter((field) => event[field]).length;
}

function mentionsSoldOut(description: string | undefined): boolean {
  return (description ?? "").toLowerCase().includes("sold out");
}

const NON_ALNUM_RE = /[^a-z0-9]/g;

/**
 * Lowercase, letters and digits only -- the cross-source dedupe key.
 *
 * Sources punctuate and case the same title differently ("Christone
 * \"Kingfish\" Ingram", "The 36 Th Chamber Of Shaolin"). Never truncated: a
 * prefix match would fuse distinct entries in a numbered series ("Once Upon
 * A Time In China" / "... Ii" / "... Iii" all ran in one week).
 */
export function normalizeTitle(title: string | undefined): string {
  return (title ?? "").toLowerCase().replace(NON_ALNUM_RE, "");
}

/** Codepoint-aware length/slice -- some real descriptions contain emoji, and
 * a UTF-16-code-unit slice (plain String.prototype.slice) would split a
 * surrogate pair in half where Python's str[:limit] (codepoint-indexed)
 * would not. */
function codepoints(text: string): string[] {
  return Array.from(text);
}

export function loadManifest(weekDir: string): Manifest {
  return JSON.parse(readFileSync(join(weekDir, "_manifest.json"), "utf8")) as Manifest;
}

/**
 * Flattens every status:ok source file into one list, each event tagged
 * with `source`. Iterates the manifest, not the files on disk -- a
 * manifest entry with no matching file (or vice versa) is check_yield.ts's
 * job to catch, not this function's; it just skips what it can't find.
 */
export function loadCandidatesFromSources(weekDir: string, manifest: Manifest): Candidate[] {
  const events: Candidate[] = [];
  for (const [stem, entry] of Object.entries(manifest.sources ?? {})) {
    if (entry.status !== "ok") continue;
    const path = join(weekDir, `${stem}.json`);
    if (!existsSync(path)) continue;
    const payload = JSON.parse(readFileSync(path, "utf8")) as { source?: string; events?: Candidate[] };
    const sourceName = payload.source ?? stem;
    for (const event of payload.events ?? []) {
      events.push({ ...event, source: sourceName });
    }
  }
  return events;
}

/**
 * Highest-source-priority entry, breaking a priority tie on completeness.
 *
 * Shared by both dedupe passes. If any discarded entry's description
 * mentions "sold out" and the kept one's doesn't, prepends a note rather
 * than dropping that signal.
 *
 * Structured venue fields are salvaged the same way, and for a sharper
 * reason: only do215 and philly_ask_a_punk emit venue_address/venue_id, and
 * do215 sits 4th in SOURCE_PRIORITY. So in every cross-source group where
 * R5 Productions, PhilaMOCA or Ask A Punk also carries the event, the
 * winner is the record WITHOUT the address, and merge_selections.ts would
 * silently see nothing. Carrying the fields forward field-by-field is what
 * makes that tranche work at all.
 */
function bestOfGroup(group: Candidate[]): Candidate {
  if (group.length === 1) return group[0]!;

  let bestIndex = 0;
  for (let i = 1; i < group.length; i++) {
    const candidate = group[i]!;
    const current = group[bestIndex]!;
    const candidateKey: [number, number] = [priorityRank(candidate.source), -completeness(candidate)];
    const currentKey: [number, number] = [priorityRank(current.source), -completeness(current)];
    if (candidateKey[0] < currentKey[0] || (candidateKey[0] === currentKey[0] && candidateKey[1] < currentKey[1])) {
      bestIndex = i;
    }
  }

  let best = group[bestIndex]!;
  const othersMentionSoldOut = group.some((e, i) => i !== bestIndex && mentionsSoldOut(e.description));
  if (othersMentionSoldOut && !mentionsSoldOut(best.description)) {
    best = {
      ...best,
      description: `[Note: at least one other source reports this as sold out.] ${best.description ?? ""}`.trim(),
    };
  }
  for (const field of ["venue_address", "venue_id"] as const) {
    if (!best[field]) {
      const donor = group.find((e, i) => i !== bestIndex && e[field])?.[field];
      if (donor) best = { ...best, [field]: donor };
    }
  }
  return best;
}

/**
 * Same (title, venue, date) = duplicate. Keeps the highest-source-priority
 * entry; on a priority tie, keeps whichever has the most complete optional
 * fields. If any discarded entry's description mentions "sold out" and the
 * kept entry's doesn't, a note is prepended to the kept entry's description
 * rather than dropping that signal.
 */
export function collapseExactDuplicates(events: Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const event of events) {
    const key = JSON.stringify([event.title ?? "", event.venue ?? "", event.date ?? ""]);
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }
  return Array.from(groups.values(), bestOfGroup);
}

/**
 * Same (date, normalized title) from DIFFERENT sources = one event.
 *
 * collapseExactDuplicates() keys on `venue`, and sources spell the same
 * room differently, so cross-source duplicates survive it. **Only groups
 * spanning more than one source collapse**, and that restriction is the
 * whole safety argument, not an optimization: a same-source group sharing
 * a (date, normalized title) key can be genuinely different rooms (five
 * Dave & Buster's locations all running "1/2 Price Games Wednesdays" from
 * Do215 alone), and this pass must never touch those.
 */
export function collapseCrossSourceDuplicates(events: Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  const order: string[] = [];
  for (const event of events) {
    const key = JSON.stringify([event.date ?? "", normalizeTitle(event.title)]);
    const group = groups.get(key);
    if (group) group.push(event);
    else {
      groups.set(key, [event]);
      order.push(key);
    }
  }

  const collapsed: Candidate[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    const sources = new Set(group.map((e) => e.source ?? ""));
    if (sources.size < 2) {
      collapsed.push(...group); // single-source: may be genuinely different venues
      continue;
    }
    collapsed.push(bestOfGroup(group));
  }
  return collapsed;
}

/**
 * Same (title, venue) appearing on RECURRING_THRESHOLD+ distinct dates
 * collapses to one representative (earliest date), annotated with
 * `occurrences` (sorted dates) and `recurrence_count`. Events below the
 * threshold pass through unchanged, in original order.
 */
export function groupRecurring(events: Candidate[]): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  const order: string[] = [];
  for (const event of events) {
    const key = JSON.stringify([event.title ?? "", event.venue ?? ""]);
    const group = groups.get(key);
    if (group) group.push(event);
    else {
      groups.set(key, [event]);
      order.push(key);
    }
  }

  const result: Candidate[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    const dates = Array.from(new Set(group.map((e) => e.date ?? ""))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (dates.length < RECURRING_THRESHOLD) {
      result.push(...group);
      continue;
    }
    let representativeIndex = 0;
    for (let i = 1; i < group.length; i++) {
      if ((group[i]!.date ?? "") < (group[representativeIndex]!.date ?? "")) representativeIndex = i;
    }
    result.push({ ...group[representativeIndex]!, occurrences: dates, recurrence_count: dates.length });
  }
  return result;
}

/** Assigns a stable "c0000"-style string `id` to each candidate, in list
 * order -- called after groupRecurring(), the only point the final ordered
 * candidate list exists. String, not number, matching the event schema's
 * all-string-field convention. This id is what Selection's annotations and
 * merge_selections.ts key off of instead of re-matching on title text. */
export function assignIds(candidates: Candidate[]): Candidate[] {
  return candidates.map((candidate, i) => ({ ...candidate, id: `c${String(i).padStart(4, "0")}` }));
}

/** Truncates each candidate's `description` to `limit` chars (by codepoint)
 * with a trailing ellipsis, applied last since this is purely an emit-time
 * size control, not a data transform. */
export function capDescriptions(candidates: Candidate[], limit: number = DESCRIPTION_CAP): Candidate[] {
  return candidates.map((candidate) => {
    const description = codepoints(candidate.description ?? "");
    if (description.length <= limit) return candidate;
    return { ...candidate, description: `${description.slice(0, limit).join("").trimEnd()}…` };
  });
}

/** Builds the same "{source} ({reason})" shape html_render.ts's failure-note
 * formatting already parses, so Selection can pass this straight through to
 * _selections.json's collection_failures field. */
export function collectionFailures(manifest: Manifest): string[] {
  const entries = Object.entries(manifest.sources ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries
    .filter(([, entry]) => entry.status === "failed")
    .map(([stem, entry]) => `${stem} (${entry.reason ?? "unknown reason"})`);
}

export function buildCandidates(weekDir: string): CandidatesDoc {
  const manifest = loadManifest(weekDir);
  const rawEvents = loadCandidatesFromSources(weekDir, manifest);
  const deduped = collapseExactDuplicates(rawEvents);
  // Before groupRecurring, so recurrence counts see one record per event
  // rather than one per source.
  const crossSourceDeduped = collapseCrossSourceDuplicates(deduped);
  const grouped = groupRecurring(crossSourceDeduped);
  const identified = assignIds(grouped);
  const capped = capDescriptions(identified);
  return {
    week: manifest.week ?? basename(weekDir),
    collection_failures: collectionFailures(manifest),
    raw_event_count: rawEvents.length,
    // Counted, not inferred: recurring listings stay visible via
    // recurrence_count, but a collapsed duplicate leaves no trace on the
    // survivor, so without these two the raw -> candidates drop can't be
    // reconciled and a dedupe bug would look like a quiet Collection
    // shortfall.
    exact_duplicates_collapsed: rawEvents.length - deduped.length,
    cross_source_duplicates_collapsed: deduped.length - crossSourceDeduped.length,
    candidates: capped,
  };
}

interface RecentPick {
  title: string;
  venue: string;
  week: string;
}

/**
 * The recent weeks' Top 3 picks, so Selection can avoid repeating them.
 *
 * Reuses checkSelection.loadRecentWeeks so the file Selection reads and the
 * file check_selection.ts checks against cannot disagree about which weeks
 * count. The import points from this Collection-stage module to a
 * Presentation-stage one, which is backwards from the pipeline's data flow
 * -- accepted because one shared definition of "recent weeks" is worth
 * more than tidy layering here (see checkSelection.ts's module comment).
 */
export function buildRecentPicks(weekDir: string): { week: string; recent_top3: RecentPick[] } {
  interface PriorWeek {
    week?: string;
    days?: { top3?: { title?: string; venue?: string }[] }[];
  }
  const picks: RecentPick[] = [];
  for (const prior of loadRecentWeeks(weekDir) as PriorWeek[]) {
    for (const day of prior.days ?? []) {
      for (const pick of day.top3 ?? []) {
        picks.push({ title: pick.title ?? "", venue: pick.venue ?? "", week: prior.week ?? "?" });
      }
    }
  }
  return { week: basename(weekDir), recent_top3: picks };
}

// Structured venue data written by do215/philly_ask_a_punk for
// merge_selections.ts's benefit, deliberately withheld from Selection.
//
// Selection's only input is the per-day files; merge_selections.ts reads
// the monolithic _candidates.json. Because they are different files, the
// source's address can reach the merge without reaching the model -- which
// keeps three things true at once: philly-events-selection/SKILL.md's
// "candidates never carry an address ... written from your own memory"
// stays accurate; the per-day payloads this is token-optimized around
// don't grow; and the model's address stays an INDEPENDENT second opinion
// rather than an echo of the source's, which is what makes
// check_selection.ts's address_conflict check worth anything.
const SELECTION_HIDDEN_FIELDS = new Set(["venue_address", "venue_id"]);

/**
 * Writes one candidate file per date in the target week (Monday through
 * Sunday) to <weekDir>/_candidates/<date>.json, so a Selection day-agent
 * reads only its own day's tokens instead of the whole week's. A recurring
 * candidate (already collapsed to its earliest occurrence by
 * groupRecurring) lands only in that representative date's file. All 7
 * dates get a file even if empty, so a day-agent's "no candidates" case is
 * a real, present file rather than a missing one.
 *
 * Throws if any candidate's date falls outside the Monday-Sunday window --
 * per-day files are Selection's only input once --split-by-day is used, so
 * a candidate that doesn't land in any of the 7 buckets would otherwise
 * vanish from the report with no trace.
 */
export function splitByDay(result: CandidatesDoc, weekDir: string): string[] {
  const week = weekDates(result.week);
  const validDates = new Set(week);
  const outOfWindow = result.candidates.filter((c) => !validDates.has(c.date ?? ""));
  if (outOfWindow.length > 0) {
    const described = outOfWindow
      .map((c) => `${c.id ?? "?"} (${JSON.stringify(c.title ?? "?")}, date=${JSON.stringify(c.date ?? "?")})`)
      .join(", ");
    throw new Error(
      `${outOfWindow.length} candidate(s) fall outside the target week ${week[0]}..${week[6]} ` +
        `and would be silently dropped: ${described}`,
    );
  }

  const byDate = new Map<string, Candidate[]>(week.map((d) => [d, []]));
  for (const candidate of result.candidates) {
    const stripped: Candidate = { ...candidate };
    for (const field of SELECTION_HIDDEN_FIELDS) delete (stripped as Record<string, unknown>)[field];
    byDate.get(candidate.date!)!.push(stripped);
  }

  const outDir = join(weekDir, "_candidates");
  mkdirSync(outDir, { recursive: true });
  const paths: string[] = [];
  for (const day of week) {
    const payload = {
      week: result.week,
      date: day,
      collection_failures: result.collection_failures,
      candidates: byDate.get(day)!,
    };
    const path = join(outDir, `${day}.json`);
    writeFileSync(path, writeJson(payload));
    paths.push(path);
  }
  return paths;
}

function main(): void {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      out: { type: "string" },
      "split-by-day": { type: "boolean", default: false },
    },
  });
  const weekDir = positionals[0];
  if (!weekDir) {
    console.error("usage: prepare_selection_input.js <week_dir> [--out PATH] [--split-by-day]");
    process.exit(2);
  }

  const result = buildCandidates(weekDir);
  const outPath = values.out ?? join(weekDir, "_candidates.json");
  writeFileSync(outPath, writeJson(result));

  // Written next to _candidates.json rather than into it: Selection reads
  // the per-day files, and folding this in there would duplicate it seven
  // times. A missing _recent_picks.json is a soft miss for Selection by
  // design -- see philly-events-selection/SKILL.md Phase 1.
  const recent = buildRecentPicks(weekDir);
  writeFileSync(join(weekDir, "_recent_picks.json"), writeJson(recent));

  const recurringGroups = result.candidates.filter((c) => c.recurrence_count).length;
  console.error(
    `Candidate prep complete. ${result.raw_event_count} raw events -> ${result.candidates.length} candidates ` +
      `(${result.exact_duplicates_collapsed} exact dup(s), ${result.cross_source_duplicates_collapsed} cross-source dup(s), ` +
      `${recurringGroups} recurring group(s) collapsed), ${recent.recent_top3.length} recent top3 pick(s) recorded, ` +
      `${result.collection_failures.length} source(s) failed. Written to ${outPath}`,
  );

  if (values["split-by-day"]) {
    const dayPaths = splitByDay(result, weekDir);
    console.error(`Split into ${dayPaths.length} per-day file(s) under ${join(weekDir, "_candidates")}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
