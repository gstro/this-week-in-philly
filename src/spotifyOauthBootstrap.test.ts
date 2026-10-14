/**
 * spotifyOauthBootstrap against local fake Spotify endpoints. The "browser"
 * is a function that finishes the redirect itself, so no consent screen and
 * no network is involved.
 */

import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPOTIFY_PLAYLIST_SCOPE } from "./common.js";
import { type Deps, missingScopes, run } from "./spotifyOauthBootstrap.js";

interface Recorded {
  tokenRequests: { authorization: string | undefined; body: URLSearchParams }[];
  meAuthorization: string[];
}

let server: Server;
let base: string;
let recorded: Recorded;
let tokenReply: { status: number; body: unknown };
let out: string[];
let err: string[];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

beforeEach(async () => {
  recorded = { tokenRequests: [], meAuthorization: [] };
  tokenReply = {
    status: 200,
    body: { access_token: "ACCESS", refresh_token: "REFRESH-TOKEN-123", scope: SPOTIFY_PLAYLIST_SCOPE },
  };
  server = createServer((req, res) => {
    void (async (): Promise<void> => {
      if (req.method === "POST" && req.url === "/api/token") {
        recorded.tokenRequests.push({ authorization: req.headers.authorization, body: new URLSearchParams(await readBody(req)) });
        res.writeHead(tokenReply.status, { "Content-Type": "application/json" }).end(JSON.stringify(tokenReply.body));
      } else if (req.method === "GET" && req.url === "/v1/me") {
        recorded.meAuthorization.push(req.headers.authorization ?? "");
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "greg", display_name: "Greg" }));
      } else {
        res.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((line: string = "") => void out.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => void err.push(line));
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const ENV = { SPOTIFY_CLIENT_ID: "client-id", SPOTIFY_CLIENT_SECRET: "client-secret" };

/** Completes the redirect the way a browser would, after `before` (e.g. a forged callback). */
function browser(query: (state: string) => string, before?: (redirectUri: string, state: string) => Promise<void>): NonNullable<Deps["openBrowser"]> {
  return async (authorizeUrl) => {
    const url = new URL(authorizeUrl);
    const redirectUri = url.searchParams.get("redirect_uri")!;
    const state = url.searchParams.get("state")!;
    await before?.(redirectUri, state);
    await fetch(`${redirectUri}?${query(state)}`);
  };
}

const deps = (extra: Deps = {}): Deps => ({
  accountsUrl: base,
  apiUrl: `${base}/v1`,
  env: ENV,
  openBrowser: browser((state) => `code=THE-CODE&state=${state}`),
  callbackTimeoutMs: 5_000,
  ...extra,
});

describe("run", () => {
  it("prints the refresh token, the user, and the redirect URI to set", async () => {
    expect(await run(["--redirect-uri", "http://127.0.0.1:0/callback"], deps())).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Consent complete for Spotify user: greg (Greg)");
    expect(text).toContain("REFRESH-TOKEN-123");
    expect(text).toMatch(/SPOTIFY_REDIRECT_URI=http:\/\/127\.0\.0\.1:\d+\/callback in both places/);
    expect(err).toEqual([]);
  });

  it("sends the documented authorize parameters", async () => {
    const seen: URL[] = [];
    await run(["--redirect-uri", "http://127.0.0.1:0/callback"], deps({
      openBrowser: async (url) => {
        seen.push(new URL(url));
        await browser((state) => `code=c&state=${state}`)(url);
      },
    }));
    const [url] = seen;
    expect(`${url?.origin ?? ""}${url?.pathname ?? ""}`).toBe(`${base}/authorize`);
    expect(url?.searchParams.get("client_id")).toBe("client-id");
    expect(url?.searchParams.get("response_type")).toBe("code");
    expect(url?.searchParams.get("scope")).toBe(SPOTIFY_PLAYLIST_SCOPE);
    expect(url?.searchParams.get("state")).toMatch(/^[\w-]{16,}$/);
    expect(out.join("\n")).toContain(url?.toString() ?? "missing");
  });

  it("exchanges the code with Basic auth and the same redirect URI", async () => {
    await run(["--redirect-uri", "http://127.0.0.1:0/callback"], deps());
    const [request] = recorded.tokenRequests;
    expect(request?.authorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
    expect(request?.body.get("grant_type")).toBe("authorization_code");
    expect(request?.body.get("code")).toBe("THE-CODE");
    expect(request?.body.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(recorded.meAuthorization).toEqual(["Bearer ACCESS"]);
  });

  it("ignores a forged callback with the wrong state and still completes", async () => {
    const code = await run(["--redirect-uri", "http://127.0.0.1:0/callback"], deps({
      openBrowser: browser((state) => `code=THE-CODE&state=${state}`, async (redirectUri) => {
        await fetch(`${redirectUri}?code=FORGED&state=wrong`);
      }),
    }));
    expect(code).toBe(0);
    expect(recorded.tokenRequests.map((r) => r.body.get("code"))).toEqual(["THE-CODE"]);
  });

  it("fails clearly when consent is denied", async () => {
    const code = await run(["--redirect-uri", "http://127.0.0.1:0/callback"], deps({
      openBrowser: browser((state) => `error=access_denied&state=${state}`),
    }));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("access_denied");
    expect(recorded.tokenRequests).toEqual([]);
  });

  it("fails when the browser never comes back", async () => {
    const code = await run(["--redirect-uri", "http://127.0.0.1:0/callback"], deps({ openBrowser: () => undefined, callbackTimeoutMs: 50 }));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Timed out");
  });

  it("fails, without echoing the client secret, when the token exchange is rejected", async () => {
    tokenReply = { status: 400, body: { error: "invalid_grant" } };
    expect(await run(["--redirect-uri", "http://127.0.0.1:0/callback"], deps())).toBe(1);
    expect(err.join("\n")).toContain("400");
    expect(err.join("\n") + out.join("\n")).not.toContain("client-secret");
  });

  it("fails when Spotify returns no refresh token", async () => {
    tokenReply = { status: 200, body: { access_token: "A", scope: SPOTIFY_PLAYLIST_SCOPE } };
    expect(await run(["--redirect-uri", "http://127.0.0.1:0/callback"], deps())).toBe(1);
    expect(err.join("\n")).toContain("no refresh token");
  });

  it("fails when the granted scope lacks one the playlist step needs", async () => {
    tokenReply = { status: 200, body: { access_token: "A", refresh_token: "R", scope: "playlist-read-private" } };
    expect(await run(["--redirect-uri", "http://127.0.0.1:0/callback"], deps())).toBe(1);
    expect(err.join("\n")).toContain("playlist-modify-public");
    expect(out.join("\n")).not.toContain("REFRESH");
  });

  it("still prints the token when the profile lookup fails", async () => {
    expect(await run(["--redirect-uri", "http://127.0.0.1:0/callback"], deps({ apiUrl: `${base}/nope` }))).toBe(0);
    expect(out.join("\n")).toContain("REFRESH-TOKEN-123");
    expect(out.join("\n")).toContain("could not read the user's profile");
    expect(err.join("\n")).toContain("Could not read the Spotify user");
  });

  it("needs the client id and secret", async () => {
    expect(await run([], deps({ env: { SPOTIFY_CLIENT_ID: "x" } }))).toBe(1);
    expect(err.join("\n")).toContain("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET");
  });

  it("refuses a non-loopback redirect URI before opening a browser", async () => {
    const open = vi.fn();
    expect(await run(["--redirect-uri", "https://example.com/callback"], deps({ openBrowser: open }))).toBe(1);
    expect(open).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("loopback");
  });

  it("takes the redirect URI from SPOTIFY_REDIRECT_URI, and exits 2 for bad arguments", async () => {
    expect(await run([], deps({ env: { ...ENV, SPOTIFY_REDIRECT_URI: "http://127.0.0.1:0/cb" } }))).toBe(0);
    expect(out.join("\n")).toMatch(/SPOTIFY_REDIRECT_URI=http:\/\/127\.0\.0\.1:\d+\/cb /);
    expect(await run(["--nope"], deps())).toBe(2);
    expect(err.join("\n")).toContain("usage: spotifyOauthBootstrap.js");
  });
});

describe("missingScopes", () => {
  it("lists the needed scopes the grant lacks", () => {
    expect(missingScopes("a b", "a b c")).toEqual(["c"]);
    expect(missingScopes(undefined, "a")).toEqual(["a"]);
    expect(missingScopes("a b", "b a")).toEqual([]);
  });
});
