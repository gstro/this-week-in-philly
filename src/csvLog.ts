#!/usr/bin/env node
/**
 * Appends a week's Top 3 picks and honorable mentions to the picks log
 * (data/event-picks-log.csv, or $PICKS_LOG_PATH), per CLAUDE.md's
 * picks-log columns contract. Rewrite (not a byte-level port) of
 * scripts/csv_log.py, checked for the same parsed rows as the Python on
 * every committed week rather than the same bytes.
 *
 * Shelved, like the Python: csv_log.py is not in runner.sh (CLAUDE.md
 * "Attendance feedback loop"), and this is wired into nothing.
 *
 * The product rules are csv_log.py's docstring, unchanged: idempotent on
 * (week_of, title); new rows always get attended="" and tags=""; price_tier
 * is sold_out -> "paid", a *(...)* placeholder -> "", free/no cover ->
 * "free", a $amount -> "low" under $15 else "paid", anything else -> "free".
 * Reading and writing the CSV is lib/picksLog.ts (csv-parse/csv-stringify).
 *
 * Honorable mentions carry only {title, venue}, so category/source/cost come
 * from the day's matching events[] entry: an exact title match, else the
 * most similar title if it is similar enough (findMatchingEvent). Python
 * scores similarity with difflib.SequenceMatcher; this uses the Dice
 * coefficient over lowercased word sets (titleSimilarity), with the same 0.6
 * threshold. Only 2 of the 163 honorable mentions in data/ need the fuzzy
 * fallback, both in 2026-06-22, and both get the same match from either
 * method (difflib 0.876 / 0.86, Dice 0.857 / 0.857; every other event that
 * day scores below 0.41 in difflib).
 *
 * Divergences from the Python, all intentional:
 *
 * - Python bugs fixed here rather than reproduced (still present in
 *   csv_log.py; none is triggered by a committed week):
 *   - A log that exists but is empty gets a header. (Python wrote a header
 *     only when the file was missing.)
 *   - A log whose last line has no line ending gets one before new rows are
 *     appended. (Python glued the first new row onto the last line.)
 *   - A (week_of, title) that appears twice in one week's selections is
 *     written once; the repeat counts as "already logged". (Python wrote both,
 *     because it only checked against rows already in the file.)
 *   - A Spotify entry without `spotify_url` gives an empty spotify_link
 *     (Python: KeyError), and `honorable_mentions: null` is read as no
 *     honorable mentions (Python: TypeError).
 *   - The log is always read and written as UTF-8. Python used the locale's
 *     encoding (UTF-8 on every machine this has run on).
 * - The existing log is validated before anything is appended (see
 *   lib/picksLog.ts): a header other than PICKS_LOG_COLUMNS, a row with too
 *   many fields, or broken quoting throws PicksLogError and appends nothing.
 *   Python read such files leniently and appended anyway.
 * - Fuzzy title matching uses titleSimilarity, not difflib (see above). The
 *   two scores differ, so a near-threshold pair could match in one and not
 *   the other; none in data/ does.
 * - Field values are plain JS. A missing optional field (venue, source,
 *   rank) is written as "" where Python raised KeyError. A JSON `1.0` rank
 *   prints as "1" (Python: "1.0"); every committed rank is an int.
 * - `\d` in the price regex matches ASCII digits only. Python's matches any
 *   Unicode digit, so "$١٥" is "paid" there and "free" here.
 * - A missing `week` in _selections.json is a clear error, not KeyError.
 * - The printed log path is picksLogPath()'s, which resolves `..` in a
 *   relative PICKS_LOG_PATH. Same file; only the message text differs.
 * - CLI errors: a usage line and exit 2 for bad arguments; other errors exit
 *   1 with a JS stack instead of a Python traceback.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  CATEGORY_TO_CSV_SLUG,
  isFreeCost,
  isPlaceholderCost,
  loadSelections,
  loadSpotify,
  picksLogPath,
  stripPlaceholderWrapper,
} from "./common.js";
import type { HonorableMention, SelectionEvent, Selections } from "./htmlRender.js";
import { type PicksLogRow, formatPicksLog, parsePicksLog, readLogText, rowKey, writeFileAtomic } from "./lib/picksLog.js";

/** _spotify.json: title -> match, or null when spotify_lookup found nothing. */
export type SpotifyMap = Record<string, { spotify_url?: string | null } | null>;

/** Minimum titleSimilarity for an honorable mention to borrow an event's details. */
export const FUZZY_MATCH_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

export function inferPriceTier(cost: string | null | undefined, soldOut: unknown = false): string {
  if (soldOut) return "paid";
  if (isPlaceholderCost(cost)) return "";
  const stripped = stripPlaceholderWrapper(cost);
  if (!stripped) return "";
  if (isFreeCost(stripped)) return "free";
  const amount = /\$(\d+(?:\.\d+)?)/.exec(stripped)?.[1];
  if (amount !== undefined) return Number(amount) < 15 ? "low" : "paid";
  return "free";
}

function words(title: string): Set<string> {
  return new Set(title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/**
 * Dice coefficient of the two titles' lowercased word sets: 2|A∩B| / (|A|+|B|),
 * from 0 (no word in common) to 1 (same words). Punctuation is ignored, so
 * "Tommy Conwell & The Young Rumblers + fireworks" and "Tommy Conwell & The
 * Young Rumblers — Free Concert + Fireworks" score 12/14.
 */
export function titleSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size + wb.size === 0) return 0;
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return (2 * shared) / (wa.size + wb.size);
}

/**
 * The events[] entry an honorable mention refers to: an exact title match,
 * else the most similar title at or above FUZZY_MATCH_THRESHOLD (the first
 * one on a tie), else undefined.
 */
export function findMatchingEvent(
  mention: HonorableMention,
  events: readonly SelectionEvent[],
): SelectionEvent | undefined {
  const exact = events.find((event) => event.title === mention.title);
  if (exact) return exact;
  let best: SelectionEvent | undefined;
  let bestScore = 0;
  for (const event of events) {
    const score = titleSimilarity(mention.title, event.title);
    if (score > bestScore) {
      bestScore = score;
      best = event;
    }
  }
  return bestScore >= FUZZY_MATCH_THRESHOLD ? best : undefined;
}

function categorySlug(category: string | undefined): string {
  if (category === undefined) return "";
  return Object.hasOwn(CATEGORY_TO_CSV_SLUG, category)
    ? CATEGORY_TO_CSV_SLUG[category as keyof typeof CATEGORY_TO_CSV_SLUG]
    : category;
}

function spotifyLink(spotify: SpotifyMap, title: string): string {
  return (Object.hasOwn(spotify, title) ? spotify[title]?.spotify_url : undefined) ?? "";
}

export function buildRows(selections: Selections, spotify: SpotifyMap): PicksLogRow[] {
  const weekOf = selections.week;
  if (!weekOf) throw new Error("_selections.json has no `week`");
  const rows: PicksLogRow[] = [];
  for (const day of selections.days) {
    const base = { city: "Philadelphia", week_of: weekOf, day: day.day_name, date: day.date, tags: "", attended: "" };

    for (const pick of day.top3) {
      rows.push({
        ...base,
        title: pick.title,
        venue: pick.venue ?? "",
        category: categorySlug(pick.category),
        source: pick.source ?? "",
        rank: String(pick.rank ?? ""),
        price_tier: inferPriceTier(pick.cost, pick.sold_out),
        spotify_link: pick.is_music ? spotifyLink(spotify, pick.title) : "",
      });
    }

    for (const mention of day.honorable_mentions ?? []) {
      const event = findMatchingEvent(mention, day.events);
      rows.push({
        ...base,
        title: mention.title,
        venue: mention.venue,
        category: categorySlug(event?.category),
        source: event?.source ?? "",
        rank: "HM",
        price_tier: inferPriceTier(event?.cost, event?.sold_out),
        spotify_link: "",
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/** The (week_of, title) keys already in the log (rowKey strings); empty if the log is missing or empty. */
export function loadExistingKeys(path: string): Set<string> {
  const text = readLogText(path);
  if (!text) return new Set();
  return new Set(parsePicksLog(text, path).map(rowKey));
}

/**
 * Appends rows to the log, writing the header first if the log is missing or
 * empty (so a missing log with no rows still gets created with its header,
 * as in Python), and ending an unterminated last line first. Returns the
 * count written. Does not dedupe; that's {@link run}'s job. Rewrites the
 * whole (small) log atomically rather than appending in place, so an
 * interrupted write can never leave a partial last record.
 */
export function appendRows(path: string, rows: readonly PicksLogRow[]): number {
  mkdirSync(dirname(path), { recursive: true });
  const existing = readLogText(path) ?? "";
  if (existing !== "" && rows.length === 0) return 0;
  const separator = existing !== "" && !/[\r\n]$/.test(existing) ? "\r\n" : "";
  writeFileAtomic(path, existing + separator + formatPicksLog(rows, { header: existing === "" }));
  return rows.length;
}

export interface RunOptions {
  weekDir: string;
  dryRun: boolean;
}

export interface RunResult {
  appended: number;
  skipped: number;
}

/** Logs one week's picks; rows whose (week_of, title) is already logged, or repeated, are skipped. */
export function run({ weekDir, dryRun }: RunOptions): RunResult {
  const allRows = buildRows(loadSelections(weekDir) as Selections, loadSpotify(weekDir) as SpotifyMap);

  const logPath = picksLogPath();
  const seen = loadExistingKeys(logPath);
  const newRows = allRows.filter((row) => {
    const key = rowKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const skipped = allRows.length - newRows.length;

  if (dryRun) {
    console.log(`[dry-run] Would append ${String(newRows.length)} rows to ${logPath} (${String(skipped)} already logged).`);
    return { appended: 0, skipped };
  }

  const appended = appendRows(logPath, newRows);
  console.log(`CSV log complete. ${String(appended)} rows appended, ${String(skipped)} already logged.`);
  return { appended, skipped };
}

function main(): void {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false } },
  });
  const [weekDir] = positionals;
  if (!weekDir || positionals.length > 1) {
    console.error("usage: csvLog.js [--dry-run] week_dir");
    process.exit(2);
  }
  run({ weekDir, dryRun: values["dry-run"] });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
