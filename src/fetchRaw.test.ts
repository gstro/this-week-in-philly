// Tests for fetchRaw.ts and lib/http.ts, against real local servers (lib/testServers.ts).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { fetchRaw } from "./fetchRaw.js";
import { HttpError, configuredProxy, truncate } from "./lib/http.js";
import { type ProxyServer, type StaticServer, setProxyEnv, startProxy, startStaticServer } from "./lib/testServers.js";

const SAMPLE = JSON.stringify({ events: [{ title: "Sample Event" }] }, null, 2);

let server: StaticServer;
let proxy: ProxyServer;
let restoreEnv: () => void = () => undefined;

beforeAll(async () => {
  server = await startStaticServer({
    "/sample.json": { body: SAMPLE, type: "application/json" },
    "/latin1.html": { body: Buffer.from("<p>Caf\xe9</p>", "latin1"), type: "text/html; charset=ISO-8859-1" },
    "/no-charset.html": { body: "<p>Café — ✓</p>", type: "text/html" },
    "/unknown-charset.html": { body: "<p>Café</p>", type: "text/html; charset=x-not-real" },
  });
  proxy = await startProxy();
});

afterAll(async () => {
  await Promise.all([server.close(), proxy.close()]);
});

afterEach(() => {
  restoreEnv();
  proxy.carried.length = 0;
});

describe("fetchRaw", () => {
  it("returns the full body", async () => {
    restoreEnv = setProxyEnv();
    expect(await fetchRaw(`${server.url}/sample.json`, 10_000)).toBe(SAMPLE);
  });

  it("truncates over the limit with a marker", async () => {
    restoreEnv = setProxyEnv();
    const text = await fetchRaw(`${server.url}/sample.json`, 20);
    expect(text).toBe(`${SAMPLE.slice(0, 20)}\n\n[... truncated at 20 chars ...]`);
  });

  it("throws HttpError on a non-2xx status", async () => {
    restoreEnv = setProxyEnv();
    const error = await fetchRaw(`${server.url}/missing.json`).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
  });

  it("throws for an unreachable host", async () => {
    restoreEnv = setProxyEnv();
    await expect(fetchRaw("https://this-domain-should-not-resolve.invalid/")).rejects.toThrow();
  });

  it("decodes with the Content-Type charset, else UTF-8", async () => {
    restoreEnv = setProxyEnv();
    expect(await fetchRaw(`${server.url}/latin1.html`)).toBe("<p>Café</p>");
    // requests would have read this one as ISO-8859-1 (mojibake).
    expect(await fetchRaw(`${server.url}/no-charset.html`)).toBe("<p>Café — ✓</p>");
    expect(await fetchRaw(`${server.url}/unknown-charset.html`)).toBe("<p>Café</p>");
  });
});

describe("proxy handling", () => {
  it("goes direct when no proxy is configured", async () => {
    restoreEnv = setProxyEnv();
    expect(configuredProxy()).toBeUndefined();
    await fetchRaw(`${server.url}/sample.json`);
    expect(proxy.carried).toEqual([]);
  });

  it("sends requests through the configured proxy", async () => {
    restoreEnv = setProxyEnv({ HTTP_PROXY: proxy.url });
    expect(configuredProxy()).toBe(proxy.url);
    expect(await fetchRaw(`${server.url}/sample.json`)).toBe(SAMPLE);
    expect(proxy.carried).toEqual([`GET ${server.url}/sample.json`]);
  });

  it("honours NO_PROXY", async () => {
    restoreEnv = setProxyEnv({ HTTP_PROXY: proxy.url, NO_PROXY: "localhost,127.0.0.1" });
    await fetchRaw(`${server.url}/sample.json`);
    expect(proxy.carried).toEqual([]);
  });

  it("detects each proxy variable", () => {
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      restoreEnv = setProxyEnv({ [name]: "http://127.0.0.1:8080" });
      expect(configuredProxy(), name).toBe("http://127.0.0.1:8080");
      restoreEnv();
    }
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("never splits a surrogate pair", () => {
    expect(truncate("a🎸b", 2)).toBe("a\n\n[... truncated at 2 chars ...]");
  });
});
