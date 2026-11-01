import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DevalueError, unflatten } from "./devalue.js";
import { flatten } from "./devalueTestUtil.js";

describe("unflatten", () => {
  it("resolves object keys and array items through their indices", () => {
    // devalue.stringify({ a: "x", list: [1, "x"] }) style: values are shared by index.
    expect(unflatten([{ a: 1, list: 2 }, "x", [3, 1], 1])).toEqual({ a: "x", list: [1, "x"] });
  });

  it("reads null, booleans and the root primitive", () => {
    expect(unflatten([{ n: 1, t: 2, f: 3 }, null, true, false])).toEqual({ n: null, t: true, f: false });
    expect(unflatten(["just a string"])).toBe("just a string");
  });

  it("maps the sentinel indices", () => {
    const [undef, nan, inf, negInf, negZero] = unflatten([[-1, -2, -3, -4, -5]]) as number[];
    expect(undef).toBeUndefined();
    expect(Number.isNaN(nan)).toBe(true);
    expect(inf).toBe(Number.POSITIVE_INFINITY);
    expect(negInf).toBe(Number.NEGATIVE_INFINITY);
    expect(Object.is(negZero, -0)).toBe(true);
  });

  it("gives a repeated reference one shared object, and survives a cycle", () => {
    const shared = unflatten([{ a: 1, b: 1 }, { x: 2 }, 5]) as { a: object; b: object };
    expect(shared.a).toBe(shared.b);
    const cyclic = unflatten([{ self: 0 }]) as { self: unknown };
    expect(cyclic.self).toBe(cyclic);
  });

  it("reads a Date as its ISO string", () => {
    expect(unflatten([{ when: 1 }, ["Date", "2026-11-02T18:30:00.000Z"]])).toEqual({ when: "2026-11-02T18:30:00.000Z" });
  });

  it("throws on types it does not read, bad indices and non-payloads", () => {
    expect(() => unflatten([["Set", 1], 5])).toThrow(DevalueError);
    expect(() => unflatten([{ a: 9 }])).toThrow(/out of range/);
    expect(() => unflatten([{ a: -42 }])).toThrow(/sentinel/);
    expect(() => unflatten([{ a: "1" }])).toThrow(/not an integer index/);
    expect(() => unflatten({})).toThrow(DevalueError);
    expect(() => unflatten([])).toThrow(DevalueError);
  });

  it("round-trips the test flattener", () => {
    const value = { browse: { data: [{ date: "2026-11-02", events: [{ id: 1, tags: [], venue: { id: 2, title: null } }] }] } };
    expect(unflatten(flatten(value))).toEqual(value);
  });
});

describe("a real Do215 capture", () => {
  const capture = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "tests", "fixtures", "do215-sveltekit", "2026-11-02-page1.json"), "utf8"),
  ) as { nodes: { type: string; data: unknown[] }[] };

  it("decodes the page node to a browse listing of 20 events", () => {
    const page = unflatten(capture.nodes[1]!.data) as { browse: { data: { date: string; events: { title: string }[] }[]; _meta: { total: number; total_pages: number } } };
    expect(page.browse._meta).toMatchObject({ total: 33, total_pages: 2 });
    expect(page.browse.data[0]?.date).toBe("2026-11-02");
    expect(page.browse.data[0]?.events).toHaveLength(20);
    expect(page.browse.data[0]?.events[0]?.title).toBe("Taylor Tomlinson");
  });
});
