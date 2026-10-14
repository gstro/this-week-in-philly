#!/usr/bin/env node
/**
 * One-time LOCAL setup tool: runs the interactive Spotify consent flow and
 * prints a refresh token. The Spotify counterpart to oauthBootstrap, and NOT
 * part of the automated pipeline: Actions runners and Routines have no
 * browser and no durable home directory (G3), so this runs once, by hand, on
 * a machine with a browser. Rewrite of scripts/spotify_oauth_bootstrap.py.
 *
 * It exists because spotifyPlaylist writes to a *user's* account, which
 * spotifyLookup's Client Credentials flow cannot do; only the Authorization
 * Code flow can. Steps (also docs/SETUP.md):
 *
 *   1. At developer.spotify.com/dashboard, open the app that already supplies
 *      SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET and add the Redirect URI
 *      http://127.0.0.1:8888/callback (the default here). Spotify rejects a
 *      bare `localhost`; whatever is registered must byte-match
 *      SPOTIFY_REDIRECT_URI everywhere it is set.
 *   2. Export SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.
 *   3. node dist/spotifyOauthBootstrap.js
 *   4. A browser opens (the URL is printed too); approve playlist access.
 *   5. Copy the printed refresh token into SPOTIFY_REFRESH_TOKEN in the local
 *      .env and as a GitHub Actions repo secret, and set SPOTIFY_REDIRECT_URI
 *      in both places.
 *
 * The token does not expire on its own; re-run only if access is revoked or
 * the requested scope (common.SPOTIFY_PLAYLIST_SCOPE) changes.
 *
 * Nothing is written to disk (the Python needed MemoryCacheHandler to keep
 * spotipy's `.cache` file out of the CWD): the token goes to stdout only.
 * Tested against local fake Spotify endpoints; a real consent has never been
 * run from this port.
 *
 * Divergences from the Python:
 *
 * - The redirect is received by lib/loopback.ts, which binds only the
 *   loopback host in the redirect URI and checks a random `state`; a request
 *   with the wrong state is ignored. The Python's spotipy listener did not
 *   verify state.
 * - It gives up after 5 minutes instead of waiting forever, and says so when
 *   consent is denied (the Python hung or crashed).
 * - It fails if Spotify's response has no refresh token, or if the granted
 *   scope lacks one the playlist step needs (the Python would print `None`
 *   or a token that later 403s at the first playlist write).
 * - The final user lookup is best effort: if it fails, the token is still
 *   printed (the Python lost it to the traceback, forcing a second consent).
 * - Network calls have a 10s timeout; errors print one line (never the
 *   client secret) and exit 1.
 */

import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { SPOTIFY_PLAYLIST_SCOPE } from "./common.js";
import { errorMessage, truncate } from "./lib/http.js";
import { openBrowser, startLoopback } from "./lib/loopback.js";

export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8888/callback";
const TIMEOUT_MS = 10_000;

export interface Deps {
  /** Default: the real Spotify. Tests point these at local servers. */
  accountsUrl?: string;
  apiUrl?: string;
  openBrowser?: (url: string) => void | Promise<void>;
  /** Default: the environment. */
  env?: Record<string, string | undefined>;
  callbackTimeoutMs?: number;
}

interface TokenResponse {
  refresh_token?: string;
  access_token?: string;
  scope?: string;
}

async function postToken(accountsUrl: string, clientId: string, clientSecret: string, body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(`${accountsUrl}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Spotify token exchange failed: ${String(response.status)} ${truncate(text, 200)}`);
  return JSON.parse(text) as TokenResponse;
}

/** The scopes in `needed` that `granted` (Spotify's space-separated string) lacks. */
export function missingScopes(granted: string | undefined, needed: string): string[] {
  const have = new Set((granted ?? "").split(/\s+/).filter(Boolean));
  return needed.split(/\s+/).filter((scope) => !have.has(scope));
}

const USAGE = "usage: spotifyOauthBootstrap.js [--redirect-uri URI]";

/** The CLI; returns the exit code (1 for a failed flow, 2 for bad arguments). */
export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { "redirect-uri": { type: "string", default: env["SPOTIFY_REDIRECT_URI"] ?? DEFAULT_REDIRECT_URI } },
    });
  } catch (err) {
    console.error(`${USAGE}\n${errorMessage(err)}`);
    return 2;
  }
  const requestedRedirect = parsed.values["redirect-uri"];

  const clientId = env["SPOTIFY_CLIENT_ID"];
  const clientSecret = env["SPOTIFY_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    console.error(
      "Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first (they're already in .env for spotifyLookup -- the same app is reused for the user flow).",
    );
    return 1;
  }

  const accountsUrl = deps.accountsUrl ?? "https://accounts.spotify.com";
  const apiUrl = deps.apiUrl ?? "https://api.spotify.com/v1";
  const state = randomBytes(16).toString("base64url");
  let loopback;
  try {
    loopback = await startLoopback({
      redirectUri: requestedRedirect,
      state,
      ...(deps.callbackTimeoutMs !== undefined && { timeoutMs: deps.callbackTimeoutMs }),
    });
  } catch (err) {
    console.error(errorMessage(err));
    return 1;
  }

  try {
    const authorizeUrl = new URL(`${accountsUrl}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: loopback.redirectUri,
      scope: SPOTIFY_PLAYLIST_SCOPE,
      state,
    }).toString();
    console.log(`Opening your browser to approve playlist access. If nothing opens, visit:\n\n${authorizeUrl.toString()}\n`);
    await (deps.openBrowser ?? openBrowser)(authorizeUrl.toString());

    const code = await loopback.code;
    const token = await postToken(accountsUrl, clientId, clientSecret, {
      grant_type: "authorization_code",
      code,
      redirect_uri: loopback.redirectUri,
    });
    if (!token.refresh_token || !token.access_token) throw new Error("Spotify's response had no refresh token.");
    const missing = missingScopes(token.scope, SPOTIFY_PLAYLIST_SCOPE);
    if (missing.length > 0) {
      throw new Error(`Spotify granted "${token.scope ?? ""}" but the playlist step needs ${missing.join(", ")}. Run again and approve everything it asks for.`);
    }

    // Best effort: the token is already issued, and losing it to a failed
    // lookup would force a second consent.
    let who = "(could not read the user's profile)";
    try {
      const me = await fetch(`${apiUrl}/me`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!me.ok) throw new Error(String(me.status));
      const user = (await me.json()) as { id: string; display_name?: string | null };
      who = `${user.id} (${user.display_name ?? "None"})`;
    } catch (err) {
      console.error(`Could not read the Spotify user (${errorMessage(err)}); the token below is still valid.`);
    }

    console.log();
    console.log(`Consent complete for Spotify user: ${who}`);
    console.log();
    console.log("Set this as SPOTIFY_REFRESH_TOKEN -- in your local .env and as a");
    console.log("GitHub Actions repo secret. Never commit it:");
    console.log();
    console.log(token.refresh_token);
    console.log();
    console.log(`Also set SPOTIFY_REDIRECT_URI=${loopback.redirectUri} in both places.`);
    return 0;
  } catch (err) {
    console.error(`spotify_oauth_bootstrap: ${errorMessage(err)}`);
    return 1;
  } finally {
    loopback.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await run(process.argv.slice(2));
}
