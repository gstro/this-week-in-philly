import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Loopback, startLoopback } from "./loopback.js";

let open: Loopback | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
});

async function start(redirectUri = "http://127.0.0.1:0/callback", timeoutMs?: number): Promise<Loopback> {
  open = await startLoopback({ redirectUri, state: "S", ...(timeoutMs !== undefined && { timeoutMs }) });
  return open;
}

const hit = (loopback: Loopback, query: string, init?: RequestInit): Promise<Response> =>
  fetch(`${loopback.redirectUri}?${query}`, init);

describe("startLoopback", () => {
  it("binds a free port for port 0 and reports the real redirect URI", async () => {
    const loopback = await start();
    expect(loopback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(loopback.redirectUri).not.toContain(":0/");
  });

  it("resolves the code on a valid callback, then stops listening", async () => {
    const loopback = await start();
    const response = await hit(loopback, "code=abc&state=S");
    expect(response.status).toBe(200);
    expect(await loopback.code).toBe("abc");
    await expect(hit(loopback, "code=again&state=S")).rejects.toThrow();
  });

  it("ignores a request with the wrong state, the wrong path or the wrong method, and keeps waiting", async () => {
    const loopback = await start();
    expect((await hit(loopback, "code=evil&state=nope")).status).toBe(400);
    expect((await fetch(loopback.redirectUri.replace("/callback", "/other") + "?code=evil&state=S")).status).toBe(404);
    expect((await hit(loopback, "code=evil&state=S", { method: "POST" })).status).toBe(404);
    expect((await hit(loopback, "state=S")).status).toBe(400); // no code, no error
    expect((await hit(loopback, "code=good&state=S")).status).toBe(200);
    expect(await loopback.code).toBe("good");
  });

  it("rejects when the provider reports an error (consent denied)", async () => {
    const loopback = await start();
    expect((await hit(loopback, "error=access_denied&state=S")).status).toBe(400);
    await expect(loopback.code).rejects.toThrow("access_denied");
  });

  it("rejects after the timeout", async () => {
    const loopback = await start("http://127.0.0.1:0/callback", 50);
    await expect(loopback.code).rejects.toThrow(/Timed out/);
  });

  it("rejects when closed early", async () => {
    const loopback = await start();
    loopback.close();
    await expect(loopback.code).rejects.toThrow(/Closed before/);
  });

  it("keeps a fixed port's URI byte-for-byte", async () => {
    const probe = await start();
    const port = new URL(probe.redirectUri).port;
    probe.close();
    const loopback = await start(`http://127.0.0.1:${port}/callback`);
    expect(loopback.redirectUri).toBe(`http://127.0.0.1:${port}/callback`);
  });

  it("fails on a busy port without leaving a timer that holds the process open", async () => {
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    const port = (busy.address() as AddressInfo).port;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await expect(startLoopback({ redirectUri: `http://127.0.0.1:${String(port)}/callback`, state: "S" })).rejects.toThrow(/EADDRINUSE/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      await new Promise((resolve) => busy.close(resolve));
    }
  });

  it("delivers the success page whole before ending the flow", async () => {
    const loopback = await start();
    const response = await hit(loopback, "code=abc&state=S");
    expect(await response.text()).toContain("Consent complete");
    expect(await loopback.code).toBe("abc");
  });

  it.each([
    ["https://127.0.0.1:8888/callback", /http loopback/],
    ["http://example.com:8888/callback", /http loopback/],
    ["http://0.0.0.0:8888/callback", /http loopback/],
    ["http://127.0.0.1/callback", /explicit port/],
    ["not a url", /not a URL/],
  ])("refuses %s", async (uri, message) => {
    await expect(startLoopback({ redirectUri: uri, state: "S" })).rejects.toThrow(message);
  });
});
