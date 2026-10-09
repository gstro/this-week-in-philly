// Tests for fetchPageText.ts: real headless Chromium against local file:// fixtures
// and local servers (lib/testServers.ts). Needs `npx playwright install chromium`.

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_SETTLE_MS, fetchPageText } from "./fetchPageText.js";
import { type ProxyServer, type StaticServer, setProxyEnv, startProxy, startStaticServer } from "./lib/testServers.js";

const FIXTURES = join(import.meta.dirname, "..", "tests", "fixtures");
const fixtureUrl = (name: string): string => pathToFileURL(join(FIXTURES, name)).href;

const PIXEL = Buffer.from("R0lGODlhAQABAAAAACw=", "base64");

let server: StaticServer;
let proxy: ProxyServer;
let restoreEnv: () => void = () => undefined;

beforeAll(async () => {
  server = await startStaticServer({
    "/page.html": {
      body: `<html><body><h1>Rendered</h1><img src="/pixel.gif"><p id="late"></p>
        <script>fetch("/data.json").then((r) => r.json()).then((d) => { document.getElementById("late").textContent = d.text; });</script>
        </body></html>`,
    },
    "/data.json": { body: JSON.stringify({ text: "Painted by JS" }), type: "application/json" },
    "/pixel.gif": { body: PIXEL, type: "image/gif" },
    "/moved": { body: "", status: 302, headers: { Location: "/page.html" } },
    "/cookies.html": {
      body: `<html><body><p id="echo"></p>
        <script>fetch("/echo").then((r) => r.text()).then((t) => { document.getElementById("echo").textContent = "cookies: " + t; });</script>
        </body></html>`,
      headers: { "Set-Cookie": ["a=1; Path=/", "b=2; Path=/"] },
    },
    "/echo": (req) => ({ body: req.headers.cookie ?? "none", type: "text/plain" }),
    "/challenge.html": {
      body: `<html><body><p id="msg">Checking your browser before accessing</p>
        <script>setTimeout(() => { document.getElementById("msg").textContent = "Real listings"; }, ${String(DEFAULT_SETTLE_MS + 1500)});</script>
        </body></html>`,
    },
  });
  proxy = await startProxy();
});

afterAll(async () => {
  await Promise.all([server.close(), proxy.close()]);
});

afterEach(() => {
  restoreEnv();
  server.requests.length = 0;
  proxy.carried.length = 0;
});

describe("fetchPageText", { timeout: 20_000 }, () => {
  it("returns the visible text, untruncated under the limit", async () => {
    restoreEnv = setProxyEnv();
    const text = await fetchPageText(fixtureUrl("short_page.html"), { maxChars: 1000 });
    expect(text).toContain("Short Test Page");
    expect(text).toContain("small amount of text");
    expect(text).not.toContain("truncated");
  });

  it("truncates over the limit", async () => {
    restoreEnv = setProxyEnv();
    const text = await fetchPageText(fixtureUrl("long_page.html"), { maxChars: 200 });
    expect(text.startsWith("Long Test Page")).toBe(true);
    expect(text.endsWith("\n\n[... truncated at 200 chars ...]")).toBe(true);
    expect(text.length).toBeLessThan(300);
  });

  it("throws for an unreachable host", async () => {
    restoreEnv = setProxyEnv();
    await expect(fetchPageText("https://this-domain-should-not-resolve.invalid/")).rejects.toThrow();
  });

  it("direct mode: runs the page's JS and drops images, with no proxy involved", async () => {
    restoreEnv = setProxyEnv();
    const text = await fetchPageText(`${server.url}/page.html`);
    expect(text).toContain("Rendered");
    expect(text).toContain("Painted by JS");
    expect(server.requests).toContain("/data.json");
    expect(server.requests).not.toContain("/pixel.gif");
    expect(proxy.carried).toEqual([]);
  });

  it("proxied mode: relays every request through the proxy and still runs JS", async () => {
    restoreEnv = setProxyEnv({ HTTPS_PROXY: proxy.url });
    const text = await fetchPageText(`${server.url}/page.html`);
    expect(text).toContain("Painted by JS");
    expect(proxy.carried).toEqual(expect.arrayContaining([`GET ${server.url}/page.html`, `GET ${server.url}/data.json`]));
    expect(server.requests).not.toContain("/pixel.gif");
  });

  it("proxied mode: follows redirects through the proxy", async () => {
    restoreEnv = setProxyEnv({ HTTPS_PROXY: proxy.url });
    const text = await fetchPageText(`${server.url}/moved`);
    expect(text).toContain("Painted by JS");
    expect(proxy.carried).toEqual(expect.arrayContaining([`GET ${server.url}/moved`, `GET ${server.url}/page.html`]));
    expect(server.requests.length).toBe(proxy.carried.length); // nothing went direct
  });

  it("proxied mode: keeps each Set-Cookie and sends cookies back", async () => {
    restoreEnv = setProxyEnv({ HTTPS_PROXY: proxy.url });
    expect(await fetchPageText(`${server.url}/cookies.html`)).toContain("cookies: a=1; b=2");
  });

  it("waits out a self-resolving bot challenge once", { timeout: 30_000 }, async () => {
    restoreEnv = setProxyEnv();
    const text = await fetchPageText(`${server.url}/challenge.html`);
    expect(text).toContain("Real listings");
  });
});
