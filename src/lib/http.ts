/**
 * Proxy-aware HTTP for Collection. Replaces scripts/proxy_session.py and the
 * `requests` calls that build on it (fetch_raw.py, fetch_page_text.py's
 * proxied relay, collect_source.py's collectors).
 *
 * Some environments route outbound HTTPS through a local agent proxy
 * (HTTPS_PROXY -- docs/COLLECTION_PROXY_ISSUE.md); a GitHub Actions runner or
 * a dev laptop has none and connects directly. undici's EnvHttpProxyAgent
 * handles both: it reads HTTP(S)_PROXY and NO_PROXY itself, which is all
 * proxy_session.py's `requests.Session` subclass existed to get right.
 *
 * As in the Python, the first of HTTPS_PROXY, https_proxy, HTTP_PROXY,
 * http_proxy carries both http:// and https:// traffic.
 *
 * Divergences from the Python:
 * - A body is decoded with the charset its Content-Type names, else UTF-8.
 *   `requests` decoded a `text/*` response with no charset as ISO-8859-1
 *   (garbling every Meetup feed -- docs/TS_PORT.md) and guessed the charset
 *   for other types. A page that names a legacy charset only in a <meta> tag
 *   would now decode with U+FFFD replacements; no source does. (TextDecoder
 *   also reads ISO-8859-1 as windows-1252, per the WHATWG spec.)
 * - The cap counts UTF-16 code units, not code points, and never splits a
 *   surrogate pair; text with emoji is cut slightly earlier.
 * - NO_PROXY entries are host names/suffixes only; undici ignores CIDR
 *   ranges, which `requests` honoured.
 */

import { EnvHttpProxyAgent, type RequestInit, type Response, fetch } from "undici";

// A realistic desktop-Chrome UA: playwright's default headless UA gets
// flagged by some sites' bot detection (confirmed: libwww.freelibrary.org's
// Cloudflare challenge blocked the default UA, passed cleanly with this one).
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

/** The proxy this environment routes outbound traffic through, if any. */
export function configuredProxy(): string | undefined {
  return PROXY_VARS.map((name) => process.env[name]).find((value) => value);
}

// One agent per proxy configuration, so connections are pooled across a
// collection run while a changed environment (tests) still takes effect.
let agent: { key: string; dispatcher: EnvHttpProxyAgent } | undefined;

function dispatcher(): EnvHttpProxyAgent {
  const key = JSON.stringify([...PROXY_VARS, "NO_PROXY", "no_proxy"].map((name) => process.env[name]));
  if (agent?.key !== key) {
    // requests' timeout=20 limited the connect and each read, not the whole
    // transfer; these are the same limits.
    const proxy = configuredProxy();
    agent = {
      key,
      dispatcher: new EnvHttpProxyAgent({
        ...(proxy !== undefined && { httpProxy: proxy, httpsProxy: proxy }),
        connectTimeout: 20_000,
        headersTimeout: 20_000,
        bodyTimeout: 20_000,
      }),
    };
  }
  return agent.dispatcher;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    statusText: string,
  ) {
    super(`HTTP ${String(status)}${statusText ? ` ${statusText}` : ""} for ${url}`);
    this.name = "HttpError";
  }
}

/** One request through the environment's proxy (if any), redirects not followed unless `init` says so. */
export function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, dispatcher: dispatcher() });
}

/** GET `url` with the Collection user agent; throws {@link HttpError} on a non-2xx status. */
export async function get(url: string): Promise<Response> {
  const response = await request(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(response.status, url, response.statusText);
  }
  return response;
}

/**
 * The body as text, decoded with the charset its Content-Type names (UTF-8
 * if none or unknown). Throws once the body passes `maxBytes`, so a runaway
 * response can't exhaust memory.
 */
export async function readText(response: Response, maxBytes = Number.POSITIVE_INFINITY): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of (response.body ?? []) as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      await response.body?.cancel();
      throw new Error(`response body exceeds ${String(maxBytes)} bytes`);
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

/** Cut `text` to `maxChars` with a visible marker -- a safety cap for runaway responses. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // don't split a surrogate pair
  return `${text.slice(0, end)}\n\n[... truncated at ${String(maxChars)} chars ...]`;
}

/** The message plus its cause -- undici reports a DNS or connect failure as a bare "fetch failed". */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}
