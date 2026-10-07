#!/usr/bin/env node
/**
 * Port of scripts/csv_log.py -- appends a week's Top 3 picks and honorable
 * mentions to data/event-picks-log.csv (or $PICKS_LOG_PATH), per CLAUDE.md's
 * picks-log columns contract (PICKS_LOG_COLUMNS in common.ts).
 *
 * Shelved, like the Python: csv_log.py is not in runner.sh (CLAUDE.md
 * "Attendance feedback loop"), and this port is wired into nothing.
 *
 * See csv_log.py's module docstring for the product rules this inherits
 * unchanged: idempotent on (week_of, title) across runs; new rows always get
 * attended="" and tags=""; price_tier inference (sold_out -> "paid",
 * *(...)* placeholder -> "", free/no cover -> "free", a $amount -> "low"
 * under $15 else "paid", anything else -> "free").
 *
 * CSV I/O is hand-written rather than a dependency. The module needs exactly
 * one dialect (Python's default `excel`: `,` delimiter, `"` quotechar,
 * doublequote, QUOTE_MINIMAL, `\r\n` terminator), and byte parity with the
 * `csv` module is the requirement; a general-purpose JS CSV library would
 * have to be configured into that dialect and then trusted to match CPython's
 * reader state machine on malformed input, which is harder to audit than the
 * ~80 lines below. The writer quotes a field iff it contains `,`, `"`, `\r`
 * or `\n` (doubling embedded quotes), and quotes a lone empty field in a
 * one-column row as CPython does. The reader is a transcription of
 * CPython's Modules/_csv.c parse_process_char for that dialect with
 * strict=False -- including its leniencies (`"b"c` reads as `bc`, an
 * unterminated quoted field at EOF is returned rather than raised) and
 * universal-newline line splitting -- plus csv.DictReader's header/short-row/
 * long-row/blank-row handling. No BOM is written or stripped (Python opens
 * with no `encoding=`, i.e. not utf-8-sig; a BOM would end up in the first
 * header name in both).
 *
 * difflib.SequenceMatcher(None, a, b).ratio() is reproduced exactly
 * (sequenceMatcherRatio): b2j indexing, the autojunk "popular element" purge
 * for len(b) >= 200, find_longest_match's DP with its earliest-in-a-then-b
 * tie-breaking and its extension loops, get_matching_blocks' queue, and
 * 2*M/T (1.0 when both are empty), all over Unicode code points as Python
 * strings are. The two junk-extension loops in find_longest_match are
 * omitted because isjunk=None makes bjunk always empty, so they can never
 * run.
 *
 * Divergences from the Python, all intentional:
 *
 * - casefold. find_matching_event fuzzy-matches on `str.casefold()`; this
 *   uses `toLowerCase()`. They differ only on length-changing or special
 *   folds (ß -> "ss", ſ -> "s", ligatures, final sigma, Cherokee) and on
 *   Unicode-version drift (Python 3.12 is Unicode 15.0, Node 24 is newer).
 *   For all 1217 distinct events/top3/honorable_mentions titles in data/,
 *   JS toLowerCase() equals CPython 3.12 casefold() exactly (checked when
 *   porting).
 * - Encoding. Python opens the log in the locale's preferred encoding (UTF-8
 *   on macOS and the Ubuntu runners); this always uses UTF-8. Invalid UTF-8
 *   raises in both (TextDecoder with fatal: true, mirroring
 *   UnicodeDecodeError). CPython's 131072-char field_size_limit is not
 *   enforced.
 * - Numbers. `str(pick["rank"])` and the csv writer's str() of any
 *   non-string JSON value print an int-valued float as "1.0" in Python;
 *   a JSON `1.0` is the number 1 here and prints "1". Floats with an
 *   exponent (1e16 vs "10000000000000000") also differ. Every committed rank
 *   is an int. A non-scalar (list/dict) in a text field would be written as
 *   its Python repr by the Python and as JSON here; none exists.
 * - `\d` in the price regex is Unicode-aware in Python (and `float()` accepts
 *   any Unicode decimal digit), ASCII-only here: "$١٥" is "paid" in Python
 *   and "free" here.
 * - The printed log path. Python prints `REPO_ROOT / override`, which keeps
 *   `..` segments; common.ts's picksLogPath() uses path.join, which resolves
 *   them. Same file either way; only the dry-run/progress line's text differs.
 * - CLI errors. argparse's usage/exit-2 on bad args is approximated by a
 *   one-line usage message and exit 2; uncaught exceptions (missing
 *   _selections.json, a KeyError-equivalent) exit 1 with a JS stack instead
 *   of a Python traceback.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  CATEGORY_TO_CSV_SLUG,
  PICKS_LOG_COLUMNS,
  isFreeCost,
  isPlaceholderCost,
  loadSelections,
  loadSpotify,
  picksLogPath,
  stripPlaceholderWrapper,
} from "./common.js";
import type { Day, HonorableMention, SelectionEvent, Selections, TopPick } from "./htmlRender.js";

export type PicksLogColumn = (typeof PICKS_LOG_COLUMNS)[number];

/** A value the csv writer can stringify; null is Python's None (written as ""). */
export type CsvField = string | number | boolean | null;

export type PicksLogRow = Record<PicksLogColumn, CsvField>;

/** _spotify.json: title -> match, or null when spotify_lookup found nothing. */
export type SpotifyMap = Record<string, { spotify_url?: string | null; matched_text?: string } | null>;

// ---------------------------------------------------------------------------
// Python-semantics helpers
// ---------------------------------------------------------------------------

/** Python truthiness: empty containers are false, unlike JS. */
function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python's str() of a JSON scalar (see the Numbers divergence above). */
function pyStr(value: unknown): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value) ?? "";
}

/** `d[key]`: a KeyError-equivalent when the key is absent. */
function req<T>(obj: object, key: string): T {
  if (!Object.hasOwn(obj, key)) throw new Error(`KeyError: '${key}'`);
  return (obj as Record<string, T>)[key] as T;
}

/** `d.get(key, default)`: the default only when the key is absent (a present null stays null). */
function get<T>(obj: object, key: string, fallback: T): T {
  return Object.hasOwn(obj, key) ? (obj as Record<string, T>)[key] as T : fallback;
}

/** `CATEGORY_TO_CSV_SLUG.get(category, category)`. */
function categorySlug(category: CsvField): CsvField {
  if (typeof category === "string" && Object.hasOwn(CATEGORY_TO_CSV_SLUG, category)) {
    return (CATEGORY_TO_CSV_SLUG as Record<string, string>)[category] ?? category;
  }
  return category;
}

// ---------------------------------------------------------------------------
// difflib.SequenceMatcher(None, a, b).ratio()
// ---------------------------------------------------------------------------

interface Match {
  i: number;
  j: number;
  k: number;
}

/** Exact port of `difflib.SequenceMatcher(None, a, b).ratio()` (autojunk=True), over code points. */
export function sequenceMatcherRatio(aText: string, bText: string): number {
  const a = Array.from(aText);
  const b = Array.from(bText);

  // __chain_b
  const b2j = new Map<string, number[]>();
  b.forEach((elt, i) => {
    let indices = b2j.get(elt);
    if (!indices) {
      indices = [];
      b2j.set(elt, indices);
    }
    indices.push(i);
  });
  const n = b.length;
  if (n >= 200) {
    const ntest = Math.floor(n / 100) + 1;
    const popular = [...b2j].filter(([, idxs]) => idxs.length > ntest).map(([elt]) => elt);
    for (const elt of popular) b2j.delete(elt);
  }

  const findLongestMatch = (alo: number, ahi: number, blo: number, bhi: number): Match => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]!) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // bjunk is empty (isjunk=None), so "not isbjunk(...)" is always true and
    // the two junk-only extension loops can never run.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize += 1;
    }
    return { i: besti, j: bestj, k: bestsize };
  };

  // get_matching_blocks (only the sum of sizes matters for ratio(), so the
  // final sort/collapse of adjacent blocks is unnecessary).
  let matches = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
    const [alo, ahi, blo, bhi] = item;
    const { i, j, k } = findLongestMatch(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }

  const length = a.length + b.length;
  return length ? (2.0 * matches) / length : 1.0;
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

export function inferPriceTier(cost: string | null | undefined, soldOut: unknown = false): string {
  if (pyTruthy(soldOut)) return "paid";
  if (isPlaceholderCost(cost)) return "";
  const stripped = stripPlaceholderWrapper(cost);
  if (!stripped) return "";
  if (isFreeCost(stripped)) return "free";
  const match = /\$(\d+(?:\.\d+)?)/.exec(stripped);
  if (match) return Number.parseFloat(match[1]!) < 15 ? "low" : "paid";
  return "free";
}

/**
 * honorable_mentions only carries {title, venue}; cost/sold_out/source come
 * from the matching entry in the day's full events array -- an exact title
 * match, else the best fuzzy match (first maximum wins) at ratio >= 0.6,
 * else {} (see csv_log.py's docstring for the real-week cases behind this).
 */
export function findMatchingEvent(
  mention: HonorableMention,
  events: readonly SelectionEvent[],
): SelectionEvent | Record<string, never> {
  const mentionTitle = req<string>(mention, "title");
  for (const event of events) {
    if (req<string>(event, "title") === mentionTitle) return event;
  }
  let best: SelectionEvent | Record<string, never> = {};
  let bestScore = 0.0;
  for (const event of events) {
    const score = sequenceMatcherRatio(mentionTitle.toLowerCase(), req<string>(event, "title").toLowerCase());
    if (score > bestScore) {
      bestScore = score;
      best = event;
    }
  }
  return bestScore >= 0.6 ? best : {};
}

export function buildRows(selections: Selections, spotify: SpotifyMap): PicksLogRow[] {
  const rows: PicksLogRow[] = [];
  const week = req<CsvField>(selections, "week");
  for (const day of req<Day[]>(selections, "days")) {
    const dayName = req<CsvField>(day, "day_name");
    const date = req<CsvField>(day, "date");

    for (const pick of req<TopPick[]>(day, "top3")) {
      const title = req<CsvField>(pick, "title");
      const spotifyEntry =
        pyTruthy(get(pick, "is_music", undefined)) && typeof title === "string" && Object.hasOwn(spotify, title)
          ? spotify[title]
          : null;
      const category = req<CsvField>(pick, "category");
      rows.push({
        city: "Philadelphia",
        week_of: week,
        day: dayName,
        date,
        title,
        venue: req<CsvField>(pick, "venue"),
        category: categorySlug(category),
        source: req<CsvField>(pick, "source"),
        rank: pyStr(req<unknown>(pick, "rank")),
        price_tier: inferPriceTier(get<string | null>(pick, "cost", ""), get<unknown>(pick, "sold_out", false)),
        spotify_link: pyTruthy(spotifyEntry) ? req<CsvField>(spotifyEntry!, "spotify_url") : "",
        tags: "",
        attended: "",
      });
    }

    for (const mention of get<HonorableMention[]>(day, "honorable_mentions", [])) {
      const event = findMatchingEvent(mention, req<SelectionEvent[]>(day, "events"));
      const category = get<CsvField>(event, "category", "");
      rows.push({
        city: "Philadelphia",
        week_of: week,
        day: dayName,
        date,
        title: req<CsvField>(mention, "title"),
        venue: req<CsvField>(mention, "venue"),
        category: categorySlug(category),
        source: get<CsvField>(event, "source", ""),
        rank: "HM",
        price_tier: inferPriceTier(get<string | null>(event, "cost", ""), get<unknown>(event, "sold_out", false)),
        spotify_link: "",
        tags: "",
        attended: "",
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// CSV I/O (Python csv module, excel dialect)
// ---------------------------------------------------------------------------

/** The csv writer's str() of one field: None -> "", else str(). */
function csvFieldText(value: CsvField): string {
  return value === null ? "" : pyStr(value);
}

/** One csv.writer().writerow() line, `\r\n`-terminated, QUOTE_MINIMAL. */
export function formatCsvRow(fields: readonly CsvField[]): string {
  const cells = fields.map((value) => {
    const text = csvFieldText(value);
    return /[,"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  });
  // CPython quotes a lone empty field so the row isn't read back as blank.
  if (cells.length === 1 && cells[0] === "") return '""\r\n';
  return `${cells.join(",")}\r\n`;
}

/** Splits like iterating a file opened with newline="": keeps terminators, breaks on \r\n, \r or \n. */
function splitLinesKeepEnds(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

const enum State {
  StartRecord,
  StartField,
  InField,
  InQuotedField,
  QuoteInQuotedField,
  EatCrnl,
}

/** csv.reader(f) for the excel dialect, strict=False -- CPython's parse_process_char state machine. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let fieldLen = 0;
  let state = State.StartRecord;
  const EOL = null;

  const saveField = (): void => {
    fields.push(field);
    field = "";
    fieldLen = 0;
  };
  const addChar = (c: string): void => {
    field += c;
    fieldLen += 1;
  };

  const processChar = (c: string | null): void => {
    switch (state) {
      case State.StartRecord:
        if (c === EOL) return; // empty line: yields []
        if (c === "\n" || c === "\r") {
          state = State.EatCrnl;
          return;
        }
        state = State.StartField;
      // falls through
      case State.StartField:
        if (c === "\n" || c === "\r" || c === EOL) {
          saveField();
          state = c === EOL ? State.StartRecord : State.EatCrnl;
        } else if (c === '"') {
          state = State.InQuotedField;
        } else if (c === ",") {
          saveField();
        } else {
          addChar(c);
          state = State.InField;
        }
        return;
      case State.InField:
        if (c === "\n" || c === "\r" || c === EOL) {
          saveField();
          state = c === EOL ? State.StartRecord : State.EatCrnl;
        } else if (c === ",") {
          saveField();
          state = State.StartField;
        } else {
          addChar(c);
        }
        return;
      case State.InQuotedField:
        if (c === EOL) return;
        if (c === '"') state = State.QuoteInQuotedField;
        else addChar(c);
        return;
      case State.QuoteInQuotedField:
        if (c === '"') {
          addChar('"');
          state = State.InQuotedField;
        } else if (c === ",") {
          saveField();
          state = State.StartField;
        } else if (c === "\n" || c === "\r" || c === EOL) {
          saveField();
          state = c === EOL ? State.StartRecord : State.EatCrnl;
        } else {
          addChar(c);
          state = State.InField;
        }
        return;
      case State.EatCrnl:
        if (c === "\n" || c === "\r") return;
        if (c === EOL) {
          state = State.StartRecord;
          return;
        }
        throw new Error("_csv.Error: new-line character seen in unquoted field - do you need to open the file with newline=''?");
    }
  };

  const lines = splitLinesKeepEnds(text);
  let lineIndex = 0;
  for (;;) {
    fields = [];
    field = "";
    fieldLen = 0;
    let done = false;
    do {
      const line = lines[lineIndex++];
      if (line === undefined) {
        // `as State`: processChar() mutates `state` in a closure, which TS's
        // narrowing from the assignment above doesn't see.
        if (fieldLen !== 0 || (state as State) === State.InQuotedField) {
          saveField();
          state = State.StartRecord;
          records.push(fields);
        }
        done = true;
        break;
      }
      for (const c of line) processChar(c);
      processChar(EOL);
    } while (state !== State.StartRecord);
    if (done) break;
    records.push(fields);
  }
  return records;
}

/** csv.DictReader(f): header from the first row, blank rows skipped, short rows padded with None. */
export function parseCsvDicts(text: string): Map<string | null, string | string[] | null>[] {
  const records = parseCsv(text);
  const header = records.shift();
  if (header === undefined) return [];
  const dicts: Map<string | null, string | string[] | null>[] = [];
  for (const row of records) {
    if (row.length === 0) continue;
    const d = new Map<string | null, string | string[] | null>();
    header.forEach((name, idx) => {
      if (idx < row.length) d.set(name, row[idx]!);
    });
    if (header.length < row.length) d.set(null, row.slice(header.length));
    else for (const name of header.slice(row.length)) d.set(name, null);
    dicts.push(d);
  }
  return dicts;
}

/** Python's set-of-tuples key for (week_of, title). */
export function logKey(weekOf: unknown, title: unknown): string {
  return JSON.stringify([weekOf ?? null, title ?? null]);
}

function readUtf8(path: string): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
}

/** The (week_of, title) keys already in the log, as logKey() strings; empty if the file doesn't exist. */
export function loadExistingKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const keys = new Set<string>();
  for (const row of parseCsvDicts(readUtf8(path))) {
    if (!row.has("week_of")) throw new Error("KeyError: 'week_of'");
    if (!row.has("title")) throw new Error("KeyError: 'title'");
    keys.add(logKey(row.get("week_of"), row.get("title")));
  }
  return keys;
}

/** Appends rows (header first iff the file doesn't exist yet); returns the count written. */
export function appendRows(path: string, rows: readonly PicksLogRow[]): number {
  mkdirSync(dirname(path), { recursive: true });
  const fileExists = existsSync(path);
  let out = fileExists ? "" : formatCsvRow(PICKS_LOG_COLUMNS);
  for (const row of rows) out += formatCsvRow(PICKS_LOG_COLUMNS.map((col) => row[col]));
  appendFileSync(path, out, "utf8");
  return rows.length;
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

  const selections = loadSelections(weekDir) as Selections;
  const spotify = loadSpotify(weekDir) as SpotifyMap;
  const allRows = buildRows(selections, spotify);

  const logPath = picksLogPath();
  const existingKeys = loadExistingKeys(logPath);
  const newRows = allRows.filter((r) => !existingKeys.has(logKey(r.week_of, r.title)));
  const skipped = allRows.length - newRows.length;

  if (values["dry-run"]) {
    console.log(
      `[dry-run] Would append ${String(newRows.length)} rows to ${logPath} (${String(skipped)} already logged).`,
    );
    return;
  }

  const written = appendRows(logPath, newRows);
  console.log(`CSV log complete. ${String(written)} rows appended, ${String(skipped)} already logged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
