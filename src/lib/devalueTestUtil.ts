/**
 * Test support: builds SvelteKit `__data.json` payloads in `devalue`'s flat
 * format, so collector tests can serve synthetic Do215 day pages without
 * hand-writing index tables. The real wire format is covered separately by
 * tests/fixtures/do215-sveltekit/ (raw captures).
 */

/** devalue's flat form of a plain JSON value: element 0 is the root. */
export function flatten(value: unknown): unknown[] {
  const table: unknown[] = [];
  const add = (v: unknown): number => {
    const index = table.length;
    table.push(null); // reserve this slot before the children claim theirs
    if (Array.isArray(v)) table[index] = v.map((item: unknown) => add(item));
    else if (v !== null && typeof v === "object") {
      table[index] = Object.fromEntries(Object.entries(v).map(([key, item]) => [key, add(item)]));
    } else table[index] = v;
    return index;
  };
  add(value);
  return table;
}

/** One Do215 day page: the layout node SvelteKit sends first, then the page node holding `browse`. */
export function dayPagePayload(events: object[], totalPages: number, date = "2026-10-12"): object {
  return {
    type: "data",
    nodes: [
      { type: "data", data: flatten({ site: { host: "do215.com" }, layout: { meta: { title: "Do215" } } }) },
      {
        type: "data",
        data: flatten({
          browse: {
            data: [{ date, events, total: events.length, has_more: false }],
            intent: { page: 1, page_size: 20 },
            _meta: { total: events.length, page: 1, page_size: 20, total_pages: totalPages, has_next: false },
          },
        }),
      },
    ],
  };
}
