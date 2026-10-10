/**
 * Fetches a URL's raw response body and prints it. Rewrite of
 * scripts/fetch_raw.py.
 *
 * For sources that are plain JSON APIs, iCal feeds, or HTML that needs no JS
 * rendering. It exists so that no model sits between a source and its
 * parser: the WebFetch tool it replaced "may summarize" large content, which
 * silently mangles a JSON events array or an iCal feed that has to be parsed
 * exactly as returned. This is just an HTTP GET, through the environment's
 * proxy if one is set (lib/http.ts).
 *
 * Divergences from the Python: see lib/http.ts (charset decoding, HTTP_PROXY
 * for http:// URLs).
 */

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { errorMessage, get, readText, truncate } from "./lib/http.js";

export const DEFAULT_MAX_CHARS = 200_000;

export async function fetchRaw(url: string, maxChars = DEFAULT_MAX_CHARS): Promise<string> {
  return truncate(await readText(await get(url)), maxChars);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    // Truncate output beyond this length (safety cap for runaway feeds).
    options: { "max-chars": { type: "string", default: String(DEFAULT_MAX_CHARS) } },
  });
  const [url] = positionals;
  const maxChars = Number(values["max-chars"]);
  if (!url || positionals.length > 1 || !Number.isInteger(maxChars) || maxChars < 0) {
    console.error("usage: fetchRaw.js [--max-chars N] url");
    process.exit(2);
  }
  try {
    console.log(await fetchRaw(url, maxChars));
  } catch (err) {
    console.error(`FAILED to fetch ${url}: ${errorMessage(err)}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
