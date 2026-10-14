#!/usr/bin/env node
/**
 * One-time LOCAL setup tool: runs the interactive Google OAuth consent flow
 * and prints a refresh token. NOT part of the automated pipeline: Routines
 * and Actions have no browser and no durable home directory (G3), so this
 * runs once, by hand, on a machine with a browser. Rewrite of
 * scripts/oauth_bootstrap.py.
 *
 * Usage (also docs/SETUP.md):
 *
 *   1. In Google Cloud Console (APIs & Services > Credentials) create an
 *      OAuth 2.0 Client ID of type "Desktop app", download its JSON and save
 *      it as credentials.json in the repo root (gitignored; never commit it).
 *   2. node dist/oauthBootstrap.js [--credentials PATH]
 *   3. A browser opens (the URL is printed too); approve Calendar access.
 *   4. Copy the printed refresh token into GOOGLE_REFRESH_TOKEN in the local
 *      .env and as a GitHub Actions repo secret; GOOGLE_CLIENT_ID and
 *      GOOGLE_CLIENT_SECRET come from the same credentials.json.
 *   5. Delete credentials.json. Re-run only if the token is revoked.
 *
 * Tested against a local fake token endpoint; a real consent has never been
 * run from this port.
 *
 * Divergences from the Python:
 *
 * - The consent request always asks for `prompt=consent`. Google issues a
 *   refresh token only on a first consent, so re-running for an
 *   already-authorised account printed `None` in the Python; this run always
 *   gets a fresh one, and fails clearly if Google still returns none.
 * - The redirect is received by lib/loopback.ts on 127.0.0.1 (the Python used
 *   `localhost`), with a random `state` that must match and a PKCE challenge.
 *   It gives up after 5 minutes instead of waiting forever.
 * - The credentials file's own `auth_uri`/`token_uri` are ignored: the
 *   client secret is only ever sent to Google's fixed endpoints.
 * - Errors print one line (never the client secret) and exit 1.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Auth, google } from "googleapis";
import { CALENDAR_SCOPES } from "./common.js";
import { errorMessage } from "./lib/http.js";
import { openBrowser, startLoopback } from "./lib/loopback.js";

export interface Deps {
  /** Default: Google's token endpoint. Tests point this at a local server. */
  tokenUrl?: string;
  openBrowser?: (url: string) => void | Promise<void>;
  callbackTimeoutMs?: number;
}

export interface ClientSecrets {
  clientId: string;
  clientSecret: string;
}

/** Reads a downloaded Google client-secrets file (a Desktop-app "installed" or a "web" client). */
export function readClientSecrets(path: string): ClientSecrets {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `${path} not found. Download it from Google Cloud Console (APIs & Services > Credentials > OAuth 2.0 Client IDs, type: Desktop app) first.`,
    );
  }
  let json: { installed?: Record<string, unknown>; web?: Record<string, unknown> };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  const client = json.installed ?? json.web;
  const clientId = client?.["client_id"];
  const clientSecret = client?.["client_secret"];
  if (typeof clientId !== "string" || typeof clientSecret !== "string" || !clientId || !clientSecret) {
    throw new Error(`${path} has no installed/web client_id and client_secret; download the OAuth client JSON again.`);
  }
  return { clientId, clientSecret };
}

const USAGE = "usage: oauthBootstrap.js [--credentials PATH]";

/** The CLI; returns the exit code (1 for a failed flow, 2 for bad arguments). */
export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { credentials: { type: "string", default: "credentials.json" } } });
  } catch (err) {
    console.error(`${USAGE}\n${errorMessage(err)}`);
    return 2;
  }
  const credentialsPath = parsed.values.credentials;

  let secrets: ClientSecrets;
  try {
    secrets = readClientSecrets(credentialsPath);
  } catch (err) {
    console.error(errorMessage(err));
    return 1;
  }

  const state = randomBytes(16).toString("base64url");
  let loopback;
  try {
    loopback = await startLoopback({
      redirectUri: "http://127.0.0.1:0/",
      state,
      ...(deps.callbackTimeoutMs !== undefined && { timeoutMs: deps.callbackTimeoutMs }),
    });
  } catch (err) {
    console.error(errorMessage(err));
    return 1;
  }

  try {
    const client = new google.auth.OAuth2({
      clientId: secrets.clientId,
      clientSecret: secrets.clientSecret,
      redirectUri: loopback.redirectUri,
      ...(deps.tokenUrl !== undefined && { endpoints: { oauth2TokenUrl: deps.tokenUrl } }),
    });
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    if (!codeVerifier || !codeChallenge) throw new Error("Could not generate a PKCE code verifier.");
    const authorizeUrl = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: CALENDAR_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: Auth.CodeChallengeMethod.S256,
    });
    console.log(`Opening your browser to approve Calendar access. If nothing opens, visit:\n\n${authorizeUrl}\n`);
    await (deps.openBrowser ?? openBrowser)(authorizeUrl);

    const code = await loopback.code;
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.refresh_token) {
      throw new Error(
        "Google returned no refresh token. Revoke this app at myaccount.google.com/permissions and run again.",
      );
    }

    console.log();
    console.log("Consent complete. Set this as GOOGLE_REFRESH_TOKEN -- in your local");
    console.log(".env and as a GitHub Actions repo secret. Never commit it:");
    console.log();
    console.log(tokens.refresh_token);
    console.log();
    console.log(`(GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET should match ${credentialsPath}.)`);
    return 0;
  } catch (err) {
    console.error(`oauth_bootstrap: ${errorMessage(err)}`);
    return 1;
  } finally {
    loopback.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await run(process.argv.slice(2));
}
