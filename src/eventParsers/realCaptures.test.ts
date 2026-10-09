/**
 * The HTML parsers against real full-page captures
 * (tests/fixtures/parse_events/real/, see its README), compared with what the
 * Python parsers extracted from the same pages (real/expected/*.json), using
 * the README's window 2026-10-01..2026-12-31.
 *
 * Same events, same order, same keys, same values -- except for one
 * intentional divergence, declared per capture in WHITESPACE_DIFFS below:
 * base.ts normalises element text (whitespace runs -> one space) where bs4's
 * get_text(strip=True) glued text nodes together and kept in-node runs. For
 * the declared fields only, the TS value must equal the Python value modulo
 * whitespace, and the exact number of differing events is pinned, so any new
 * or vanished difference fails the test.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type Event, normalizeSpace } from "./base.js";
import { PARSERS, parseLightboxIndex } from "./index.js";

const REAL = join(import.meta.dirname, "..", "..", "tests", "fixtures", "parse_events", "real");
const capture = (name: string): string => gunzipSync(readFileSync(join(REAL, name))).toString("utf8");
const expected = <T>(name: string): T => JSON.parse(readFileSync(join(REAL, "expected", name), "utf8")) as T;
const START = "2026-10-01";
const END = "2026-12-31";

function run(key: string, file: string, contextDate?: string): Event[] {
  const parser = PARSERS[key];
  if (!parser) throw new Error(`no parser ${key}`);
  return parser(capture(file), START, END, contextDate === undefined ? {} : { contextDate });
}

function lightboxCandidates(): string {
  // Built the way collect_source.collect_lightbox does: index order, each
  // detail page attached as detail_html.
  const index = parseLightboxIndex(capture("lightbox-index.html.gz"));
  return JSON.stringify(index.map((c, i) => ({ ...c, detail_html: capture(`lightbox-detail-${i + 1}.html.gz`) })));
}

interface Case {
  expected: string;
  events: () => Event[];
}

const CASES: Record<string, Case> = {
  cinespeak: { expected: "cinespeak.json", events: () => run("cinespeak", "cinespeak.html.gz") },
  philamoca: { expected: "philamoca.json", events: () => run("philamoca", "philamoca.html.gz") },
  "philly-shows": { expected: "philly-shows.json", events: () => run("philly-shows", "philly-shows.html.gz") },
  phillygoth: { expected: "phillygoth.json", events: () => run("phillygoth", "phillygoth.html.gz") },
  "r5-productions": { expected: "r5-productions.json", events: () => run("r5-productions", "r5-productions.html.gz") },
  "the-rotunda-2026-10": {
    expected: "the-rotunda-2026-10.json",
    events: () => run("the-rotunda", "the-rotunda-2026-10.html.gz", "2026-10-01"),
  },
  "the-rotunda-2026-11": {
    expected: "the-rotunda-2026-11.json",
    events: () => run("the-rotunda", "the-rotunda-2026-11.html.gz", "2026-11-01"),
  },
  "lightbox-film-center": {
    expected: "lightbox-film-center.json",
    events: () => PARSERS["lightbox-film-center"]?.(lightboxCandidates(), START, END) ?? [],
  },
};

/** Intentional whitespace-only differences: which fields, and exactly how many events differ. */
const WHITESPACE_DIFFS: Record<string, { fields: (keyof Event)[]; differingEvents: number }> = {
  // Two descriptions with a double space between sentences.
  philamoca: { fields: ["description"], differingEvents: 2 },
  // Every `.em-item-actions` description: bs4 glued "...$10" + "Featuring:" +
  // "Links:" + "Facebook event" with no separator.
  phillygoth: { fields: ["description"], differingEvents: 89 },
  // One title (and its copy in description) with "MARKET!  ART" in the source.
  "the-rotunda-2026-10": { fields: ["title", "description"], differingEvents: 1 },
};

const squash = (value: string | undefined): string => (value ?? "").replace(/\s/g, "");

describe("real captures match the Python's extraction", () => {
  for (const [name, testCase] of Object.entries(CASES)) {
    it(name, () => {
      const python = expected<Event[]>(testCase.expected);
      const ts = testCase.events();
      const allowed = WHITESPACE_DIFFS[name] ?? { fields: [], differingEvents: 0 };

      expect(ts.map((e) => [e.date, squash(e.title)])).toEqual(python.map((e) => [e.date, squash(e.title)]));
      let differing = 0;
      ts.forEach((event, i) => {
        const py = python[i];
        expect(Object.keys(event)).toEqual(Object.keys(py ?? {}));
        const strict = { ...event };
        const pyStrict = { ...py };
        let differs = false;
        for (const field of allowed.fields) {
          expect(squash(event[field])).toBe(squash(py?.[field]));
          expect(event[field]).toBe(normalizeSpace(event[field] ?? ""));
          if (event[field] !== py?.[field]) differs = true;
          delete strict[field];
          delete pyStrict[field];
        }
        expect(strict).toEqual(pyStrict);
        if (differs) differing++;
      });
      expect(differing).toBe(allowed.differingEvents);
    });
  }

  it("pins one example of each whitespace difference exactly", () => {
    const goth = run("phillygoth", "phillygoth.html.gz")[0];
    expect(expected<Event[]>("phillygoth.json")[0]?.description).toBe("21+, 9pm-1am, $10Featuring:Links:Facebook event");
    expect(goth?.description).toBe("21+, 9pm-1am, $10 Featuring: Links: Facebook event");

    const rotunda = run("the-rotunda", "the-rotunda-2026-10.html.gz", "2026-10-01")[1];
    expect(rotunda?.title).toBe(
      "In-person! FR33 TH3 PU$$Y AN ARTIVIST EXTRAVAGANZA POP UP MARKET! ART VENDORS MUSIC AND ENTERTAINMENT raising funds for a sanctuary for big cats!",
    );
  });

  it("lightbox parseIndex matches", () => {
    expect(parseLightboxIndex(capture("lightbox-index.html.gz"))).toEqual(expected("lightbox-index.json"));
  });
});
