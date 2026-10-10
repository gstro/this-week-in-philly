/**
 * Registry of source parsers, keyed by the same CLI keys as
 * scripts/event_parsers/__init__.py's PARSERS (collect_week's source table
 * refers to them). To add a source: add a module exporting a `parse`
 * matching {@link EventParser}, register it here, and add fixture tests.
 */

import type { EventParser } from "./base.js";
import * as cinespeak from "./cinespeak.js";
import * as do215 from "./do215.js";
import * as gcal from "./gcal.js";
import * as lightbox from "./lightbox.js";
import * as luma from "./luma.js";
import * as meetup from "./meetup.js";
import * as philadelphiaFilmSociety from "./philadelphiaFilmSociety.js";
import * as philamoca from "./philamoca.js";
import * as phillyAskAPunk from "./phillyAskAPunk.js";
import * as phillyShows from "./phillyShows.js";
import * as phillygoth from "./phillygoth.js";
import * as r5Productions from "./r5Productions.js";
import * as theRotunda from "./theRotunda.js";
import * as wxpn from "./wxpn.js";

export { type Event, type EventParser, type ParserOptions, ParseError, skippedRecords } from "./base.js";
export { parseIndex as parseLightboxIndex } from "./lightbox.js";

export const PARSERS: Readonly<Record<string, EventParser>> = {
  "r5-productions": r5Productions.parse,
  philamoca: philamoca.parse,
  phillygoth: phillygoth.parse,
  "philly-shows": phillyShows.parse,
  "the-rotunda": theRotunda.parse,
  "philly-ask-a-punk": phillyAskAPunk.parse,
  "luma-ical": luma.parse,
  "meetup-ical": meetup.parse,
  do215: do215.parse,
  wxpn: wxpn.parse,
  cinespeak: cinespeak.parse,
  "lightbox-film-center": lightbox.parse,
  "philadelphia-film-society": philadelphiaFilmSociety.parse,
  gcal: gcal.parse,
};
