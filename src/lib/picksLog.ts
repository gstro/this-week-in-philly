/**
 * Reading and writing the picks-log CSV (data/event-picks-log.csv, or
 * $PICKS_LOG_PATH), shared by csvLog.ts and attendanceCheck.ts. The columns
 * are CLAUDE.md's picks-log contract, PICKS_LOG_COLUMNS in common.ts, in
 * that order.
 *
 * CSV goes through csv-parse / csv-stringify (the `csv` project, pinned).
 * Both are zero-dependency, MIT-licensed, ship their own types, and have
 * synchronous APIs. They follow RFC 4180, which is the dialect Python's csv
 * module writes by default. Rows are written with `\r\n` line endings, as
 * Python does, so files written by the Python and the TS read the same way.
 * Quoting is minimal: a field is quoted only if it contains `,`, `"`, `\r`
 * or `\n`.
 *
 * Reading is strict where Python's DictReader was lenient, so a damaged log
 * gives a clear {@link PicksLogError} before anything is written:
 * - The header must be exactly PICKS_LOG_COLUMNS, in order. csvLog appends
 *   rows in that order, so any other header would misalign them.
 * - A blank first line is an error. (DictReader used it as an empty header,
 *   and the first column lookup then failed with `KeyError 'city'`.)
 * - A row with more fields than the header is an error. (DictReader filed
 *   the extras under a `None` key, and DictWriter later raised on it.)
 * - Malformed quoting (`"b"c`, an unclosed quote) is an error. Python's
 *   reader accepted it and guessed.
 * Short rows are padded with "" and blank lines after the header are
 * skipped, as in Python. A leading UTF-8 BOM is stripped. Files are always
 * UTF-8, and invalid UTF-8 throws rather than being decoded with U+FFFD.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { PICKS_LOG_COLUMNS } from "../common.js";

export type PicksLogColumn = (typeof PICKS_LOG_COLUMNS)[number];

export type PicksLogRow = Record<PicksLogColumn, string>;

/** The picks log can't be read safely (bad header, extra fields, broken quoting, ...). */
export class PicksLogError extends Error {
  override name = "PicksLogError";
}

/** The log's text, or null if the file doesn't exist. */
export function readLogText(path: string): string | null {
  if (!existsSync(path)) return null;
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
}

function checkHeader(header: readonly string[], path: string): void {
  if (header.length === PICKS_LOG_COLUMNS.length && header.every((name, i) => name === PICKS_LOG_COLUMNS[i])) return;
  const expected = new Set<string>(PICKS_LOG_COLUMNS);
  const missing = PICKS_LOG_COLUMNS.filter((col) => !header.includes(col));
  const unknown = header.filter((name) => !expected.has(name));
  const duplicated = header.filter((name, i) => header.indexOf(name) !== i);
  const problems = [
    missing.length > 0 ? `missing ${missing.join(", ")}` : "",
    unknown.length > 0 ? `unknown ${unknown.map((n) => JSON.stringify(n)).join(", ")}` : "",
    duplicated.length > 0 ? `duplicated ${duplicated.join(", ")}` : "",
  ].filter(Boolean);
  throw new PicksLogError(
    `${path}: header is not the picks-log columns (${problems.join("; ") || "wrong order"}). ` +
      `Expected: ${PICKS_LOG_COLUMNS.join(",")}`,
  );
}

/**
 * Parses picks-log text into rows. Throws {@link PicksLogError} for an empty
 * file, a blank first line, a header other than PICKS_LOG_COLUMNS, a row
 * with too many fields, or malformed quoting. `path` is only used in error
 * messages.
 */
export function parsePicksLog(text: string, path: string): PicksLogRow[] {
  let records: string[][];
  try {
    records = parse(text, { bom: true, relax_column_count: true });
  } catch (err) {
    throw new PicksLogError(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const isBlank = (record: string[]): boolean => record.length === 1 && record[0] === "";

  const [first, ...rest] = records;
  if (first === undefined) throw new PicksLogError(`${path} is empty (no header row)`);
  if (isBlank(first)) throw new PicksLogError(`${path}: the first line is blank; expected the header row`);
  checkHeader(first, path);

  const rows: PicksLogRow[] = [];
  for (const [i, record] of rest.entries()) {
    if (isBlank(record)) continue;
    if (record.length > PICKS_LOG_COLUMNS.length) {
      // +2: 1-based, and the header is record 1.
      throw new PicksLogError(
        `${path}: record ${String(i + 2)} has ${String(record.length)} fields; ` +
          `the header has ${String(PICKS_LOG_COLUMNS.length)}`,
      );
    }
    rows.push(Object.fromEntries(PICKS_LOG_COLUMNS.map((col, i) => [col, record[i] ?? ""])) as PicksLogRow);
  }
  return rows;
}

/** Rows as CSV text in PICKS_LOG_COLUMNS order, `\r\n`-terminated, with the header line unless `header` is false. */
export function formatPicksLog(rows: readonly PicksLogRow[], { header = true }: { header?: boolean } = {}): string {
  return stringify(
    [...rows],
    {
      columns: [...PICKS_LOG_COLUMNS],
      header,
      record_delimiter: "windows",
      // An explicit record_delimiter turns this off by default, which would
      // leave a lone \r or \n in a field unquoted.
      quote_record_delimiter: true,
    },
  );
}

/** The `(week_of, title)` identity csvLog dedupes on. */
export function rowKey(row: Pick<PicksLogRow, "week_of" | "title">): string {
  return JSON.stringify([row.week_of, row.title]);
}

/**
 * Replaces `path` with `text` via a temp file in the same directory and a
 * rename, so a failure part-way never leaves the log truncated. The temp file
 * is fsynced before the rename so a power loss can't surface an empty log.
 */
export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
