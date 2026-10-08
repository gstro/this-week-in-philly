/**
 * phillygoth.net -- WordPress "Events Manager" plugin. Rewrite of
 * scripts/event_parsers/phillygoth.py.
 *
 * One `div.em-event.em-item` per event. The date text sometimes carries a
 * year ("December 30, 2026") and sometimes doesn't ("January 1"); an explicit
 * year is trusted as-is, a missing one goes through resolveYear so a week
 * spanning New Year's doesn't assign "January 1" to the departing year. No
 * time field is parsed (the listing has none in a stable place).
 *
 * Divergences from the Python: none beyond base.ts's text normalisation
 * (which matters here: `.em-item-actions` text was glued node-to-node).
 */

import { load } from "cheerio";
import { type EventParser, ParseError, attr, inWeek, isoDate, makeEvent, parseMonth, resolveYear, text } from "./base.js";

export function parseLongDate(dateText: string, weekStart: string): string | null {
  const m = /(\w+)\s+(\d{1,2}),?\s*(\d{4})?/.exec(dateText);
  const month = m ? parseMonth(m[1] ?? "") : null;
  if (!m || month === null) return null;
  const day = Number(m[2]);
  const year = m[3] !== undefined ? Number(m[3]) : resolveYear(month, day, weekStart);
  return year === null ? null : isoDate(year, month, day);
}

export const parse: EventParser = (html, weekStart, weekEnd) => {
  const $ = load(html);
  const containers = $("div.em-event.em-item").toArray();
  if (containers.length === 0) throw new ParseError("no em-event em-item blocks found -- markup may have changed");

  return containers.flatMap((el) => {
    const card = $(el);
    const date = parseLongDate(text(card.find(".em-event-date")), weekStart);
    if (date === null || !inWeek(date, weekStart, weekEnd)) return [];

    const titleLink = card.find(".em-item-title a");
    return [
      makeEvent({
        title: text(titleLink),
        venue: text(card.find(".em-event-location a")),
        date,
        time: "",
        cost: "",
        url: attr(titleLink, "href"),
        description: text(card.find(".em-item-actions")),
      }),
    ];
  });
};
