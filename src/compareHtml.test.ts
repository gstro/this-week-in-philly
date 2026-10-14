import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHtml, firstDifference, run } from "./compareHtml.js";

describe("firstDifference", () => {
  it("treats the Jinja2 and Nunjucks serializations of the same page as equal", () => {
    const jinja = `<p class="hm">Cousin Danny's &#34;Acid&#34; \\ night</p>\n<a href="x?a=1&amp;b=2">go</a>`;
    const nunjucks = `<p class="hm">Cousin Danny&#39;s &quot;Acid&quot; \\ night</p>\n<a href="x?a=1&amp;b=2">go</a>\n`;
    expect(firstDifference(jinja, nunjucks)).toBeNull();
  });

  it("finds a real content difference and says where", () => {
    const a = "<ul>\n<li>one</li>\n<li>two</li>\n</ul>";
    const b = "<ul>\n<li>one</li>\n<li>TWO</li>\n</ul>";
    expect(firstDifference(a, b)).toEqual({ line: 3, a: "<li>two</li>", b: "<li>TWO</li>" });
  });

  it("notices a changed attribute, a missing element and different whitespace-significant text", () => {
    expect(firstDifference('<a href="a">x</a>', '<a href="b">x</a>')).not.toBeNull();
    expect(firstDifference("<p>a</p><p>b</p>", "<p>a</p>")).not.toBeNull();
    expect(firstDifference("<p>a b</p>", "<p>a  b</p>")).not.toBeNull();
  });

  it("canonicalHtml is stable", () => {
    expect(canonicalHtml(canonicalHtml("<p>It&#39;s</p>"))).toBe(canonicalHtml("<p>It&#39;s</p>"));
  });
});

describe("run", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "compare-html-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, text: string): string => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  it("exits 0 for the same DOM, 1 for a different one, 2 for bad arguments", () => {
    const a = write("a.html", "<p>&#34;hi&#34;</p>");
    expect(run([a, write("b.html", "<p>&quot;hi&quot;</p>\n")])).toBe(0);
    expect(run([a, write("c.html", "<p>bye</p>")])).toBe(1);
    expect(run([a])).toBe(2);
  });
});
