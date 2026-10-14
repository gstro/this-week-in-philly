/**
 * The loopback half of an OAuth "installed app" flow, shared by oauthBootstrap
 * (Google) and spotifyOauthBootstrap: a one-shot HTTP listener on a loopback
 * address that receives the provider's redirect, checks `state`, and hands
 * back the authorization code.
 *
 * Only a loopback host is accepted (127.0.0.1, localhost or [::1]), and the
 * listener binds to exactly that host, so nothing off this machine can reach
 * it. A request with the wrong path, method or `state` is answered and
 * ignored (the listener keeps waiting), so a stray hit cannot end the flow or
 * plant a code. The first valid callback ends it.
 */

import { spawn } from "node:child_process";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;

export interface Loopback {
  /** The redirect URI to send to the provider (port 0 in the request is replaced by the bound port). */
  redirectUri: string;
  /** Resolves with the authorization code; rejects on a provider error, a timeout, or `close()`. */
  code: Promise<string>;
  close(): void;
}

export interface LoopbackOptions {
  /** e.g. "http://127.0.0.1:8888/callback"; port 0 picks a free one. Must be an http loopback URL. */
  redirectUri: string;
  state: string;
  timeoutMs?: number;
}

const PAGE = (message: string): string =>
  `<!doctype html><meta charset="utf-8"><title>This Week in Philly</title><p>${message}</p>`;

export async function startLoopback({ redirectUri, state, timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS }: LoopbackOptions): Promise<Loopback> {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error(`Redirect URI is not a URL: ${JSON.stringify(redirectUri)}`);
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`Redirect URI must be an http loopback address (127.0.0.1, localhost or [::1]), got ${redirectUri}`);
  }
  if (url.port === "") {
    throw new Error(`Redirect URI needs an explicit port, e.g. http://127.0.0.1:8888/callback; got ${redirectUri}`);
  }

  let settle!: { resolve(code: string): void; reject(error: Error): void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller may only attach a handler after the browser step; a rejection
  // before then must not count as unhandled.
  code.catch(() => undefined);

  const server: Server = createServer((req, res) => {
    // `then` runs once the page is flushed, so ending the flow cannot cut it off.
    const reply = (status: number, message: string, then?: () => void): void => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(PAGE(message), then);
    };
    const requested = new URL(req.url ?? "/", "http://loopback.invalid");
    if (req.method !== "GET" || requested.pathname !== url.pathname) {
      reply(404, "Not found.");
      return;
    }
    if (requested.searchParams.get("state") !== state) {
      reply(400, "State mismatch; this request was ignored. Start again from the terminal if the flow was yours.");
      return;
    }
    const error = requested.searchParams.get("error");
    const authCode = requested.searchParams.get("code");
    if (error) {
      reply(400, "Consent was not granted. You can close this tab.", () => {
        finish(() => settle.reject(new Error(`The provider returned an error: ${error}`)));
      });
    } else if (authCode) {
      reply(200, "Consent complete. You can close this tab and return to the terminal.", () => {
        finish(() => settle.resolve(authCode));
      });
    } else {
      reply(400, "No authorization code in the request.");
    }
  });

  function finish(settleNow: () => void): void {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    settleNow();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(url.port), url.hostname.replace(/^\[|\]$/g, ""), resolve);
  });
  // Started only once listening: a failed bind must not leave a timer holding the process open.
  const timer = setTimeout(() => {
    finish(() => settle.reject(new Error(`Timed out after ${String(Math.round(timeoutMs / 1000))}s waiting for the browser redirect.`)));
  }, timeoutMs);

  // Byte-for-byte the caller's URI, unless it asked for port 0: providers
  // match the registered redirect URI exactly.
  let boundUri = redirectUri;
  if (Number(url.port) === 0) {
    url.port = String((server.address() as AddressInfo).port);
    boundUri = url.toString();
  }

  return {
    redirectUri: boundUri,
    code,
    close: (): void => {
      finish(() => settle.reject(new Error("Closed before the redirect arrived.")));
    },
  };
}

/** Opens `url` in the default browser, best effort (the caller always prints the URL as well). */
export function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!opener) return;
  const child = spawn(opener, [url], { stdio: "ignore", detached: true });
  child.on("error", () => undefined); // no opener installed: the printed URL still works
  child.unref();
}
