/**
 * Minimal iCalendar (RFC 5545) reader shared by luma.ts and meetup.ts.
 * Rewrite of scripts/event_parsers/_ical.py; a support module, not a parser,
 * so it isn't in the registry.
 *
 * Reads just enough of the format for those two feeds: each VEVENT's
 * top-level properties, keyed by upper-cased name with parameters dropped
 * (`DTSTART;TZID=America/New_York:...` -> `DTSTART`). Values are returned
 * raw; TEXT values go through {@link unescapeText}.
 *
 * Divergences from the Python (each a bug fixed):
 *
 * - Unfolding accepts a tab as well as a space as the continuation marker
 *   (RFC 5545 3.1), and bare-CR line endings.
 * - Unescaping is one left-to-right pass, so `\\n` (an escaped backslash
 *   followed by "n") stays a literal backslash + "n" instead of becoming a
 *   newline, and `\N` is recognised as a newline too.
 * - The name/value split skips colons inside quoted parameter values
 *   (`LOCATION;ALTREP="http://x":Foo` was split at "http").
 * - Properties of a nested component (a VALARM's DESCRIPTION, say) no longer
 *   overwrite the event's own.
 * - Property names are case-insensitive, as the RFC specifies.
 */

export type VEvent = Record<string, string>;

/** Undoes RFC 5545 TEXT escaping: `\\`, `\;`, `\,`, `\n`/`\N`. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

/** Splits into content lines, joining folded continuations (a leading space or tab). */
export function unfold(raw: string): string[] {
  const lines: string[] = [];
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

/** Index of the colon that ends the name;params part, skipping quoted parameter values. */
function valueSeparator(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) return i;
  }
  return -1;
}

export function parseVEvents(raw: string): VEvent[] {
  const events: VEvent[] = [];
  let current: VEvent | null = null;
  let nestedDepth = 0;
  for (const line of unfold(raw)) {
    const sep = valueSeparator(line);
    if (sep === -1) continue;
    const name = (line.slice(0, sep).split(";")[0] ?? "").toUpperCase();
    const value = line.slice(sep + 1);
    if (name === "BEGIN") {
      if (value.toUpperCase() === "VEVENT" && current === null) current = {};
      else if (current !== null) nestedDepth++;
    } else if (name === "END") {
      if (current !== null && nestedDepth > 0) nestedDepth--;
      else if (current !== null && value.toUpperCase() === "VEVENT") {
        events.push(current);
        current = null;
      }
    } else if (current !== null && nestedDepth === 0) {
      current[name] = value;
    }
  }
  return events;
}
