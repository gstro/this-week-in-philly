/**
 * oauthBootstrap against a local fake Google token endpoint; the "browser"
 * finishes the redirect itself. No network, no real consent.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_SCOPES } from "./common.js";
import { type Deps, readClientSecrets, run } from "./oauthBootstrap.js";

let server: Server;
let tokenUrl: string;
let tokenBodies: URLSearchParams[];
let tokenReply: { status: number; body: unknown };
let dir: string;
let credentials: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  tokenBodies = [];
  tokenReply = { status: 200, body: { access_token: "ACCESS", refresh_token: "GOOGLE-REFRESH-456", token_type: "Bearer" } };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      tokenBodies.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(tokenReply.status, { "Content-Type": "application/json" }).end(JSON.stringify(tokenReply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  tokenUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/token`;
  dir = mkdtempSync(join(tmpdir(), "oauth-bootstrap-"));
  credentials = join(dir, "credentials.json");
  writeFileSync(credentials, JSON.stringify({ installed: { client_id: "cid.apps.example", client_secret: "csecret", token_uri: "https://evil.example/token" } }));
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((line: string = "") => void out.push(line));
  vi.spyOn(console, "error").mockImplementation((line: string) => void err.push(line));
});

afterEach(async () => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const finish = (query: (state: string) => string): NonNullable<Deps["openBrowser"]> => async (authorizeUrl) => {
  const url = new URL(authorizeUrl);
  await fetch(`${url.searchParams.get("redirect_uri")!}?${query(url.searchParams.get("state")!)}`);
};

const deps = (extra: Deps = {}): Deps => ({
  tokenUrl,
  openBrowser: finish((state) => `code=THE-CODE&state=${state}`),
  callbackTimeoutMs: 5_000,
  ...extra,
});

describe("run", () => {
  it("prints the refresh token", async () => {
    expect(await run(["--credentials", credentials], deps())).toBe(0);
    expect(out.join("\n")).toContain("GOOGLE-REFRESH-456");
    expect(out.join("\n")).toContain(`should match ${credentials}`);
    expect(err).toEqual([]);
  });

  it("asks for offline Calendar access with consent, state and a PKCE challenge", async () => {
    const seenUrls: URL[] = [];
    await run(["--credentials", credentials], deps({
      openBrowser: async (url) => {
        seenUrls.push(new URL(url));
        await finish((state) => `code=c&state=${state}`)(url);
      },
    }));
    const seen = seenUrls[0];
    expect(seen?.origin).toBe("https://accounts.google.com");
    expect(seen?.searchParams.get("client_id")).toBe("cid.apps.example");
    expect(seen?.searchParams.get("access_type")).toBe("offline");
    expect(seen?.searchParams.get("prompt")).toBe("consent");
    expect(seen?.searchParams.get("scope")).toBe(CALENDAR_SCOPES.join(" "));
    expect(seen?.searchParams.get("response_type")).toBe("code");
    expect(seen?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(seen?.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    // The token request proves the verifier behind the challenge, and sends the secret only to the injected endpoint.
    const [body] = tokenBodies;
    const challenge = createHash("sha256").update(body?.get("code_verifier") ?? "").digest("base64url");
    expect(challenge).toBe(seen?.searchParams.get("code_challenge"));
    expect(body?.get("code")).toBe("c");
    expect(body?.get("client_id")).toBe("cid.apps.example");
    expect(body?.get("client_secret")).toBe("csecret");
    expect(body?.get("redirect_uri")).toBe(seen?.searchParams.get("redirect_uri"));
  });

  it("ignores a forged callback with the wrong state", async () => {
    const code = await run(["--credentials", credentials], deps({
      openBrowser: async (url) => {
        const redirect = new URL(url).searchParams.get("redirect_uri")!;
        await fetch(`${redirect}?code=FORGED&state=wrong`);
        await finish((state) => `code=THE-CODE&state=${state}`)(url);
      },
    }));
    expect(code).toBe(0);
    expect(tokenBodies.map((b) => b.get("code"))).toEqual(["THE-CODE"]);
  });

  it("fails when Google returns no refresh token", async () => {
    tokenReply = { status: 200, body: { access_token: "ACCESS", token_type: "Bearer" } };
    expect(await run(["--credentials", credentials], deps())).toBe(1);
    expect(err.join("\n")).toContain("no refresh token");
  });

  it("fails, without echoing the client secret, when the token request is rejected", async () => {
    tokenReply = { status: 400, body: { error: "invalid_grant" } };
    expect(await run(["--credentials", credentials], deps())).toBe(1);
    expect(err.join("\n") + out.join("\n")).not.toContain("csecret");
  });

  it("fails when consent is denied or the browser never returns", async () => {
    expect(await run(["--credentials", credentials], deps({ openBrowser: finish((state) => `error=access_denied&state=${state}`) }))).toBe(1);
    expect(err.join("\n")).toContain("access_denied");
    expect(await run(["--credentials", credentials], deps({ openBrowser: () => undefined, callbackTimeoutMs: 50 }))).toBe(1);
    expect(err.join("\n")).toContain("Timed out");
    expect(tokenBodies).toEqual([]);
  });

  it("explains a missing credentials file, and exits 2 for bad arguments", async () => {
    expect(await run(["--credentials", join(dir, "nope.json")], deps())).toBe(1);
    expect(err.join("\n")).toContain("not found. Download it from Google Cloud Console");
    expect(await run(["--nope"], deps())).toBe(2);
    expect(err.join("\n")).toContain("usage: oauthBootstrap.js");
  });
});

describe("readClientSecrets", () => {
  const write = (value: string): string => {
    writeFileSync(credentials, value);
    return credentials;
  };

  it("reads an installed or a web client", () => {
    expect(readClientSecrets(write(JSON.stringify({ web: { client_id: "a", client_secret: "b" } })))).toEqual({ clientId: "a", clientSecret: "b" });
    expect(readClientSecrets(write(JSON.stringify({ installed: { client_id: "c", client_secret: "d" } })))).toEqual({ clientId: "c", clientSecret: "d" });
  });

  it("rejects invalid JSON and files without a client id and secret", () => {
    expect(() => readClientSecrets(write("{nope"))).toThrow("not valid JSON");
    expect(() => readClientSecrets(write("{}"))).toThrow("no installed/web client_id");
    expect(() => readClientSecrets(write(JSON.stringify({ installed: { client_id: "a" } })))).toThrow("no installed/web client_id");
  });
});
