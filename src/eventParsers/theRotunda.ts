/**
 * the-rotunda -- Squarespace-style month calendar grid. Rewrite of
 * scripts/event_parsers/the_rotunda.py.
 *
 * Unlike the other HTML parsers, this one needs an explicit `contextDate`
 * option: the grid's non-"notmonth" <td> cells all belong to whichever single
 * month was requested via the fetched URL's ?date= param, and that's not
 * recoverable from the HTML alone (the page shows prev/next-month nav links
 * for all three visible months, not just the current one). Guessing it from
 * day numbers alone (e.g. "small day numbers near a month boundary must be
 * next month") is exactly the kind of fragile inference that silently
 * produces wrong dates -- so it's required instead.
 *
 * Each `li.anEvent` is "<time><a href=/event/...>title</a>".
 *
 * Divergences from the Python: an absolute event href is used as-is instead
 * of being glued onto the site origin; a malformed contextDate throws
 * ParseError instead of a TypeError.
 */

import { load } from "cheerio";
import { type EventParser, ParseError, attr, inWeek, isoDate, leadingIsoDate, makeEvent, text } from "./base.js";

const ORIGIN = "https://www.therotunda.org";

export const parse: EventParser = (html, weekStart, weekEnd, options = {}) => {
  const context = options.contextDate === undefined ? null : leadingIsoDate(options.contextDate);
  if (context === null) {
    throw new ParseError("the-rotunda parser requires contextDate (the same date used in the fetched URL's ?date= param)");
  }
  const [year, month] = context.split("-").map(Number) as [number, number];

  const $ = load(html);
  const cells = $("td:not(.notmonth)").toArray();
  if (cells.length === 0) throw new ParseError("no in-month calendar <td> cells found -- markup may have changed");

  let foundAnyDay = false;
  const events = cells.flatMap((cell) => {
    const dayText = text($(cell).find(".day"));
    if (!/^\d+$/.test(dayText)) return [];
    foundAnyDay = true;
    const date = isoDate(year, month, Number(dayText));
    if (date === null || !inWeek(date, weekStart, weekEnd)) return [];

    return $(cell)
      .find("li.anEvent")
      .toArray()
      .map((item) => {
        const link = $(item).find("a").first();
        const href = attr(link, "href");
        const title = text(link);
        return makeEvent({
          title,
          venue: "The Rotunda, 4014 Walnut St, Philadelphia, PA 19104",
          date,
          time: /^\s*([\d:]+\s*[AP]M)/.exec($(item).text())?.[1] ?? "",
          cost: "",
          url: link.length === 0 ? "" : /^https?:/.test(href) ? href : ORIGIN + href,
          description: title,
        });
      });
  });
  if (!foundAnyDay) throw new ParseError("no calendar day cells with a .day number found -- markup may have changed");
  return events;
};
