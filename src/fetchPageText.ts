/**
 * Renders a URL in headless Chromium and prints its visible text. Rewrite of
 * scripts/fetch_page_text.py.
 *
 * For sources that need JS rendering (Fandango's PFS theater pages are the
 * one live caller, via collect_source). Playwright needs a browser:
 * `npx playwright install chromium` (CI adds `--with-deps`).
 *
 * Two networking modes, chosen by whether a proxy is configured:
 *
 * - Direct (GitHub Actions, a dev laptop): Chromium does its own networking
 *   -- HTTP/2, connection reuse, parallelism -- and routing only drops the
 *   images, media and fonts we never read.
 * - Proxied (the old Routine sandbox): Chromium's own TLS can't traverse the
 *   egress proxy -- every navigation dies with ERR_CONNECTION_RESET after the
 *   ClientHello, though the CONNECT succeeds (docs/COLLECTION_PROXY_ISSUE.md).
 *   So Chromium is launched with --no-proxy-server and every request is
 *   relayed through lib/http.ts, which goes through the proxy normally. JS
 *   still runs in the browser; only the network I/O is rerouted. The relay
 *   costs HTTP/2 and parallelism, which is why it's proxy-only (measured
 *   2026-08-01).
 *
 * Divergences from the Python, all in the proxied relay unless noted:
 * - Redirects are followed inside the relay. The Python handed a 3xx back to
 *   Chromium, which follows it without consulting the route handler -- i.e.
 *   directly, which is exactly what fails behind the proxy. The cost: the
 *   page keeps the original URL as its base for relative links.
 * - Cookies go back to the server (`allHeaders()`; `headers()` omits
 *   Cookie), so a challenge that sets a clearance cookie and reloads can
 *   pass. Several Set-Cookie headers are kept apart (requests joined them
 *   with ", ", corrupting them), and br/zstd bodies are decoded.
 * - lib/http.ts's 20s timeouts (the Python relay used 15s); hop-by-hop
 *   headers undici rejects are dropped.
 * - Both modes: the browser is closed on every path, not just on success.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import { type Route, chromium, errors } from "playwright";

import { USER_AGENT, configuredProxy, errorMessage, request, truncate } from "./lib/http.js";

export const DEFAULT_MAX_CHARS = 200_000;

// How long to let a page settle after domcontentloaded before reading text.
// We don't wait for networkidle: ad-funded pages (Fandango) fire a
// continuous real-time-bidding storm and never reach idle -- measured
// 2026-08-01 on a PFS theater page, networkidle 45.2s (timed out) vs
// domcontentloaded + 2s settle 2.6s, with identical parsed output. Raise it
// with waitMs for a slow client-rendered page.
export const DEFAULT_SETTLE_MS = 2000;

// Self-resolving bot-challenge interstitials (Cloudflare, WordPress.com/
// Jetpack) that redirect to real content via JS after a few seconds -- seen
// live on cinespeak.org. Not hard blocks like filmadelphia.org's WAF "Access
// Denied" page, which there's no point waiting out. Retried once.
const CHALLENGE_MARKERS = ["checking your browser", "just a moment", "please wait while we verify", "performing security verification"];
const CHALLENGE_RETRY_WAIT_MS = 6000;

// Some cloud environments pre-bake Chromium here so sessions needn't run
// `playwright install`; the pinned path sidesteps playwright's own browser
// version matching, which a fresh install can fail against an older cache
// (debugged live 2026-07-20). Otherwise playwright resolves its own browser.
const PREBAKED_CHROMIUM = "/opt/pw-browsers/chromium";

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
// Set by the relay itself, or hop-by-hop headers undici refuses to forward.
const STRIP_REQUEST_HEADERS = new Set(["host", "content-length", "connection", "keep-alive", "transfer-encoding", "upgrade"]);
// undici has already decoded and de-chunked the body.
const STRIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

export interface FetchPageTextOptions {
  /** Settle wait after domcontentloaded; 0 means {@link DEFAULT_SETTLE_MS}. */
  waitMs?: number;
  maxChars?: number;
}

export async function fetchPageText(url: string, { waitMs = 0, maxChars = DEFAULT_MAX_CHARS }: FetchPageTextOptions = {}): Promise<string> {
  const proxied = configuredProxy() !== undefined;
  const browser = await chromium.launch({
    ...(existsSync(PREBAKED_CHROMIUM) && { executablePath: PREBAKED_CHROMIUM }),
    args: proxied ? ["--no-proxy-server"] : [],
  });
  try {
    const page = await browser.newPage({ userAgent: USER_AGENT });
    await page.route("**/*", proxied ? relayRoute : blockOnlyRoute);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (err) {
      // A page that hasn't reached domcontentloaded in 30s may still have
      // content worth reading. A real navigation failure (DNS, refused
      // connection) is a different error and propagates.
      if (!(err instanceof errors.TimeoutError)) throw err;
    }
    await sleep(waitMs || DEFAULT_SETTLE_MS);
    let text = await page.innerText("body");
    if (CHALLENGE_MARKERS.some((marker) => text.toLowerCase().includes(marker))) {
      await sleep(CHALLENGE_RETRY_WAIT_MS);
      text = await page.innerText("body");
    }
    return truncate(text, maxChars);
  } finally {
    await browser.close();
  }
}

/** Direct mode: drop heavy sub-resources, hand everything else back to Chromium. */
export async function blockOnlyRoute(route: Route): Promise<void> {
  if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) await route.abort();
  else await route.continue();
}

/** Proxied mode: fulfil each request with a response fetched through lib/http.ts. */
export async function relayRoute(route: Route): Promise<void> {
  const req = route.request();
  if (!/^https?:\/\//.test(req.url())) {
    await route.continue();
    return;
  }
  if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
    await route.abort();
    return;
  }
  let response;
  let body: Buffer;
  try {
    response = await request(req.url(), {
      method: req.method(),
      headers: Object.fromEntries(Object.entries(await req.allHeaders()).filter(([name]) => !STRIP_REQUEST_HEADERS.has(name.toLowerCase()))),
      body: req.postDataBuffer(),
      // Chromium would follow a 3xx itself, bypassing this handler and so the proxy.
      redirect: "follow",
    });
    body = Buffer.from(await response.arrayBuffer());
  } catch {
    await route.abort();
    return;
  }
  const headers = Object.fromEntries([...response.headers].filter(([name]) => !STRIP_RESPONSE_HEADERS.has(name) && name !== "set-cookie"));
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies.join("\n"); // playwright splits on newlines
  await route.fulfill({ status: response.status, headers, body });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "wait-ms": { type: "string", default: "0" },
      "max-chars": { type: "string", default: String(DEFAULT_MAX_CHARS) },
    },
  });
  const [url] = positionals;
  const waitMs = Number(values["wait-ms"]);
  const maxChars = Number(values["max-chars"]);
  if (!url || positionals.length > 1 || ![waitMs, maxChars].every((n) => Number.isInteger(n) && n >= 0)) {
    console.error(`usage: fetchPageText.js [--wait-ms N (default ${String(DEFAULT_SETTLE_MS)})] [--max-chars N] url`);
    process.exit(2);
  }
  try {
    console.log(await fetchPageText(url, { waitMs, maxChars }));
  } catch (err) {
    console.error(`FAILED to fetch ${url}: ${errorMessage(err)}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
