#!/usr/bin/env node
/**
 * Compares two HTML files by their parsed DOM, not their bytes: the Python
 * (Jinja2) and TypeScript (Nunjucks) report renderers differ in serialization
 * only (`&#34;` vs `&quot;`, a literal vs encoded apostrophe in text, the
 * trailing newline; see htmlRender.ts), which never changes what a browser
 * shows. Used to rehearse the Presentation cutover: render a week on both
 * engines and check the two reports are the same page.
 *
 *   node dist/compareHtml.js a.html b.html     # exit 0 if the same DOM, 1 if not, 2 for bad arguments
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as cheerio from "cheerio";

/**
 * The document re-serialized by one serializer, so equal DOMs give equal
 * strings. Trailing whitespace-only text at the end of <body> is dropped: a
 * file's final newline is the one serialization difference that parses to a
 * node (it lands inside <body>), and shows nothing.
 */
export function canonicalHtml(html: string): string {
  const $ = cheerio.load(html);
  const body = $("body");
  for (let last = body.contents().last(); last.length > 0 && String(last[0]?.type) === "text" && !/\S/.test(last.text()); last = body.contents().last()) {
    last.remove();
  }
  return ($.root().html() ?? "").trimEnd();
}

export interface Difference {
  line: number;
  a: string;
  b: string;
}

/** The first differing line of the two canonical forms, or null when the DOMs match. */
export function firstDifference(a: string, b: string): Difference | null {
  const left = canonicalHtml(a).split("\n");
  const right = canonicalHtml(b).split("\n");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) return { line: i + 1, a: left[i] ?? "<end of file>", b: right[i] ?? "<end of file>" };
  }
  return null;
}

export function run(argv: string[]): number {
  const [pathA, pathB, ...extra] = argv;
  if (!pathA || !pathB || extra.length > 0) {
    console.error("usage: compareHtml.js a.html b.html");
    return 2;
  }
  const diff = firstDifference(readFileSync(pathA, "utf8"), readFileSync(pathB, "utf8"));
  if (!diff) {
    console.log(`Same DOM: ${pathA} and ${pathB}`);
    return 0;
  }
  console.log(`Different DOM at canonical line ${String(diff.line)}:\n  ${pathA}: ${diff.a}\n  ${pathB}: ${diff.b}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = run(process.argv.slice(2));
}
