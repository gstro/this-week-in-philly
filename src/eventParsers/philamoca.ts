/**
 * philamoca -- static WordPress theme with custom `event__` markup. Rewrite of
 * scripts/event_parsers/philamoca.py.
 *
 * One `a.event` per listing; the date is the machine-readable
 * `.event__date[datetime]`, and a listing can carry several
 * `.event__detail--time time` elements (joined with ", "). Every event is at
 * PhilaMOCA itself, so the venue is a constant.
 *
 * Divergences from the Python: a `datetime` attribute carrying a time as well
 * ("2026-10-07T19:00") is read by its date part instead of being skipped.
 */

import { load } from "cheerio";
import { type Event, type EventParser, ParseError, attr, inWeek, leadingIsoDate, makeEvent, text } from "./base.js";

export const parse: EventParser = (html, weekStart, weekEnd) => {
  const $ = load(html);
  const containers = $("a.event").toArray();
  if (containers.length === 0) throw new ParseError("no a.event blocks found -- markup may have changed");

  return containers.flatMap((el): Event[] => {
    const card = $(el);
    const date = leadingIsoDate(attr(card.find(".event__date"), "datetime"));
    if (date === null || !inWeek(date, weekStart, weekEnd)) return [];

    const times = card
      .find(".event__detail--time time")
      .toArray()
      .map((t) => text($(t)))
      .filter(Boolean);
    return [
      makeEvent({
        title: text(card.find(".event__title")),
        venue: "PhilaMOCA, 531 N 12th St, Philadelphia, PA 19123",
        date,
        time: times.join(", "),
        cost: text(card.find(".event__detail--tickets .event__detail-value")),
        url: attr(card, "href") || "https://www.philamoca.org/",
        description: text(card.find(".event__description")),
      }),
    ];
  });
};
