/**
 * philly-shows.com -- Webflow CMS list. Rewrite of
 * scripts/event_parsers/philly_shows.py.
 *
 * Each `div.showblock` carries two `p.showdatevenue` lines: date + time
 * ("October 15, 2026 6:00 PM"), then the venue.
 *
 * As of 2026-08-30 the site's Webflow CMS collection could render zero items
 * with its own confirmed-empty marker (`<div class="w-dyn-empty"><div>No
 * items found.</div></div>`) and no `div.showblock` at all. That is the site
 * saying its own list is empty -- different from "we don't recognise this
 * page" -- so it returns [] rather than throwing (this source's documented
 * min_expected is 0). Populated markup was seen again in the 2026-10-07 real
 * capture (tests/fixtures/parse_events/real/) with the original selectors.
 *
 * Divergences from the Python: none beyond base.ts's text normalisation.
 */

import { load } from "cheerio";
import { type EventParser, ParseError, attr, inWeek, isoDate, makeEvent, parseMonth, text } from "./base.js";

export const parse: EventParser = (html, weekStart, weekEnd) => {
  const $ = load(html);
  const containers = $("div.showblock").toArray();
  if (containers.length === 0) {
    if ($("div.w-dyn-empty").length > 0) return [];
    throw new ParseError("no showblock elements found -- markup may have changed");
  }

  return containers.flatMap((el) => {
    const card = $(el);
    const fields = card.find("p.showdatevenue").toArray();
    if (fields.length < 2) return [];
    const dateTimeText = text($(fields[0]));
    const m = /(\w+)\s+(\d{1,2}),?\s+(\d{4})/.exec(dateTimeText);
    const month = m ? parseMonth(m[1] ?? "") : null;
    const date = m && month !== null ? isoDate(Number(m[3]), month, Number(m[2])) : null;
    if (date === null || !inWeek(date, weekStart, weekEnd)) return [];

    const title = text(card.find("h3"));
    return [
      makeEvent({
        title,
        venue: text($(fields[1])),
        date,
        time: /\d{1,2}:\d{2}\s*[AP]M/.exec(dateTimeText)?.[0] ?? "",
        cost: text(card.find(".showprice")),
        url: attr(card.find("a.btn"), "href") || "https://www.philly-shows.com/",
        description: title,
      }),
    ];
  });
};
