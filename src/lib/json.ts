/**
 * This repo's Python scripts write JSON in two different, deliberate
 * conventions, and a TS port must pick the right one per script or its
 * output silently fails to byte-match:
 *
 * - `ensure_ascii=False` (literal UTF-8, never backslash-u-escaped):
 *   everything from `prepare_selection_input.py` onward --
 *   `merge_selections.py`, `prepare_selection_input.py` (`_candidates.json`,
 *   `_candidates/<date>.json`, `_recent_picks.json`), `spotify_lookup.py`'s
 *   real write, `spotify_playlist.py`. Selection's own
 *   `_selection_annotations.json` output follows the same convention. Use
 *   `writeJson`.
 * - `ensure_ascii=True` (Python's *default*: non-ASCII escaped as
 *   backslash-u-XXXX, astral characters as surrogate pairs): raw Collection
 *   output -- `collect_week.py`'s per-source writes and `_manifest.json`,
 *   `collect_source.py`'s write. Use `writeJsonAsciiEscaped`.
 *
 * Confirmed two independent ways: grepping every `json.dump(s)` call site in
 * `scripts/` for an explicit `ensure_ascii=False`, and scanning every
 * committed JSON artifact under `data/`/`archive/` for literal non-ASCII
 * bytes vs. escape sequences -- the two partitions agree exactly, with zero
 * files in either showing both conventions at once.
 */

/**
 * Mirrors Python's json.encoder ASCII escape range (outside printable
 * 0x20-0x7e), applied only *inside* JSON string literals -- never to
 * `JSON.stringify(..., null, 2)`'s own structural pretty-print whitespace,
 * which uses literal newlines and spaces that must survive untouched. A
 * naive whole-text regex would mangle those structural newlines and corrupt
 * the document; walking the text with a string-boundary tracker (toggling
 * on unescaped double-quotes, copying existing backslash escapes verbatim)
 * is what keeps the two apart. Iterating UTF-16 code units (not codepoints)
 * matches Python's own behavior of emitting astral characters as two
 * separate escaped surrogate halves.
 */
function escapeNonAscii(jsonText: string): string {
  let result = "";
  let inString = false;
  let i = 0;
  while (i < jsonText.length) {
    const ch = jsonText[i];
    if (!inString) {
      if (ch === '"') inString = true;
      result += ch;
      i++;
      continue;
    }
    if (ch === "\\") {
      // Copy an existing escape sequence verbatim: a unicode escape is 6
      // chars, every other backslash escape (quote, backslash, newline,
      // tab, ...) is 2.
      const len = jsonText[i + 1] === "u" ? 6 : 2;
      result += jsonText.slice(i, i + len);
      i += len;
      continue;
    }
    if (ch === '"') {
      inString = false;
      result += ch;
      i++;
      continue;
    }
    const code = ch!.charCodeAt(0);
    result += code > 0x7e ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
    i++;
  }
  return result;
}

/** For scripts that pass `ensure_ascii=False` (see module docstring). */
export function writeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** For scripts that rely on Python's `ensure_ascii=True` default (see module docstring). */
export function writeJsonAsciiEscaped(value: unknown): string {
  return escapeNonAscii(JSON.stringify(value, null, 2));
}
