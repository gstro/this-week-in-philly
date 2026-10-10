/**
 * Spotify Web API plumbing shared by spotifyLookup (app-only Client
 * Credentials) and spotifyPlaylist (the user-authorized client).
 */

import { setTimeout as sleep } from "node:timers/promises";

import { getSpotifyUserClient } from "../common.js";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 10_000;
// A Retry-After longer than this is a ban, not a blip (one seen 2026-10-10
// was 85,725s, ~24h, after a day of repeated test runs). The lookup stops
// rather than waiting it out -- spotipy sleeps through any Retry-After, so
// the Python would hang until the job timed out.
const MAX_RETRY_AFTER_S = 60;

/** Spotify has banned this app for longer than a run should wait; the whole run stops. */
export class RateLimitedError extends Error {
  override name = "RateLimitedError";
}

export interface HttpDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
}

export interface FetchOptions {
  /**
   * False for a request that must not run twice (POST /me/playlists, an
   * append to a playlist): a timeout or 5xx may mean the server did act, and a
   * retry would duplicate it. Then only a 429 (rejected before processing) is
   * retried. Default true.
   */
  idempotent?: boolean;
}

/** One request with spotipy-like resilience: retries network errors, 429 and 5xx (honouring Retry-After), with a timeout. */
export async function resilientFetch(
  url: string,
  init: () => RequestInit,
  { fetch: doFetch = fetch, sleep: wait = sleep }: HttpDeps,
  { idempotent = true }: FetchOptions = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await doFetch(url, { ...init(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (!idempotent || attempt >= MAX_RETRIES) throw err;
      await wait(300 * 2 ** attempt);
      continue;
    }
    const retryable = idempotent ? RETRY_STATUSES.has(response.status) : response.status === 429;
    if (!retryable || attempt >= MAX_RETRIES) return response;
    const retryAfter = Number(response.headers.get("retry-after"));
    await response.body?.cancel();
    if (retryAfter > MAX_RETRY_AFTER_S) throw new RateLimitedError(`Spotify rate-limited this app for ${String(retryAfter)}s`);
    await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 300 * 2 ** attempt);
  }
}


const API = "https://api.spotify.com/v1";

/** A non-2xx Web API response. */
export class SpotifyApiError extends Error {
  override name = "SpotifyApiError";
  constructor(
    readonly status: number,
    method: string,
    path: string,
    detail: string,
  ) {
    super(`HTTP ${String(status)} from Spotify ${method} ${path}: ${detail}`);
  }
}

/** A minimal JSON client for the Web API with a user's bearer token. */
export interface SpotifyUserApi {
  get<T = unknown>(path: string, query?: Record<string, string>): Promise<T>;
  put<T = unknown>(path: string, body: unknown): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

export interface UserApiDeps extends HttpDeps {
  /** A fresh user access token; defaults to the refresh-token flow in common.ts. */
  getToken?: () => Promise<string>;
}

/**
 * The user-authorized client: the token is fetched on first use and
 * refreshed once on a 401. Never the Client Credentials flow, which has no
 * user context and cannot touch playlists.
 */
export function spotifyUserApi({ getToken = async (): Promise<string> => (await getSpotifyUserClient()).accessToken, ...http }: UserApiDeps = {}): SpotifyUserApi {
  let token: string | undefined;

  async function call<T>(method: string, path: string, query: Record<string, string> | undefined, body: unknown): Promise<T> {
    // `path` may be an absolute `next` URL from a paged response; the bearer
    // token only ever goes to Spotify's own API.
    if (path.startsWith("https://") && !path.startsWith(`${API}/`)) throw new Error(`refusing to send a Spotify token to ${path}`);
    const url = path.startsWith("https://") ? path : `${API}${path}${query ? `?${new URLSearchParams(query).toString()}` : ""}`;
    const send = async (): Promise<Response> => {
      token ??= await getToken();
      const authorization = `Bearer ${token}`;
      return resilientFetch(
        url,
        () => ({
          method,
          headers: { Authorization: authorization, ...(body !== undefined && { "Content-Type": "application/json" }) },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        }),
        http,
        { idempotent: method !== "POST" },
      );
    };
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      token = await getToken();
      response = await send();
    }
    if (!response.ok) throw new SpotifyApiError(response.status, method, path, await response.text());
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    get: (path, query) => call("GET", path, query, undefined),
    put: (path, body) => call("PUT", path, undefined, body),
    post: (path, body) => call("POST", path, undefined, body),
  };
}
