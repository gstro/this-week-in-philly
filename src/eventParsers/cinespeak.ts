/**
 * cinespeak -- server-rendered WordPress block markup (`/cinema/`). Rewrite
 * of scripts/event_parsers/cinespeak.py.
 *
 * Previously documented as having "no stable structure" and left to
 * manual/model reading -- confirmed live 2026-07-29 that's no longer true (or
 * wasn't ever quite true): the page is a plain Gutenberg block listing, one
 * `li.wp-block-post.event` per screening, with a consistent internal shape:
 *
 * - title + ticket URL: the `.wp-block-post-title a` link
 *   (cinespeak.eventive.org)
 * - date/time: a single `p.wp-block-paragraph`, formatted like
 *   "July 30, 2026   @ 7:45  pm" -- irregular whitespace around "@ ", handled
 *   with a permissive regex rather than a fixed-width split
 * - venue: NOT in a dedicated venue element -- it's the second
 *   `.wp-block-buttons` block's link (the first is always "Buy Tickets",
 *   pointing to eventive.org; the second points to a Google Maps link and its
 *   text is the venue name). Distinguished by link target (maps.app.goo.gl /
 *   google.com/maps) rather than position, in case a listing without a ticket
 *   button ever appears.
 * - tag/category (e.g. "Documentary Feature", "LGBTQIA+"): optional,
 *   `.wp-block-post-terms a` -- not every event has one
 *
 * Divergences from the Python: an impossible time ("7:75 pm") skips that
 * screening with a warning instead of failing the whole source.
 */

import { load } from "cheerio";
import { type Event, type EventParser, ParseError, attr, collectRecords, formatTime, inWeek, isoDate, makeEvent, parseMonth, text, to24Hour } from "./base.js";

const DATE_RE = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*@\s*(\d{1,2}):(\d{2})\s*(am|pm)/i;

export const parse: EventParser = (html, weekStart, weekEnd) => {
  const $ = load(html);
  const containers = $("li.wp-block-post.event").toArray();
  if (containers.length === 0) {
    throw new ParseError("no li.wp-block-post.event blocks found -- markup may have changed");
  }

  return collectRecords("cinespeak", containers, (el): Event | null => {
    const card = $(el);
    const m = DATE_RE.exec(text(card.find("p.wp-block-paragraph")));
    if (!m) return null;
    const [, monthName = "", day, year, hour, minute, meridiem = ""] = m;
    const month = parseMonth(monthName);
    const date = month === null ? null : isoDate(Number(year), month, Number(day));
    if (date === null || !inWeek(date, weekStart, weekEnd)) return null;

    const titleLink = card.find(".wp-block-post-title a");
    const venueLink = card
      .find(".wp-block-buttons a")
      .filter((_i, a) => /maps\.app\.goo\.gl|google\.com\/maps/.test($(a).attr("href") ?? ""));

    return makeEvent({
      title: text(titleLink),
      venue: text(venueLink),
      date,
      time: formatTime(to24Hour(Number(hour), meridiem), Number(minute)),
      cost: "",
      url: attr(titleLink, "href") || "https://cinespeak.org/cinema/",
      description: text(card.find(".wp-block-post-terms a")),
    });
  });
};
