# Headless Chromium (Playwright) TLS handshake fails through the Claude Code Routines egress proxy

## Summary

In a Claude Code Routines cloud environment, a headless Chromium browser launched via Playwright
cannot complete a TLS handshake to any external HTTPS host when routed through the environment's
egress proxy (`HTTPS_PROXY`). Every navigation attempt fails with `net::ERR_CONNECTION_RESET`.
`curl` through the identical proxy, from the same session, to the same hosts, succeeds without
issue. The failure is not host-specific — it was reproduced against multiple, unrelated domains.

## Environment

- Claude Code Routines cloud environment (custom environment, not the platform default).
- Outbound HTTPS is routed through a local forwarding proxy set via `HTTPS_PROXY=http://127.0.0.1:<port>`,
  which itself tunnels to an upstream policy-enforcing egress proxy. This is documented inside the
  sandbox (a local README describing the proxy) and via a local status endpoint
  (`curl http://127.0.0.1:<port>/__agentproxy/status`) that reports proxy configuration and recent
  relay failures.
- The environment pre-bakes a Chromium install at a fixed path so sessions don't need to run
  `playwright install` (no root/apt-get available). Resolved binary: Chromium **141.0.7390.37**.
- Playwright package version: **1.61.0** (Python).

## Reproduction

1. Launch headless Chromium via Playwright with the proxy passed explicitly:
   ```python
   from playwright.sync_api import sync_playwright

   with sync_playwright() as p:
       browser = p.chromium.launch(
           executable_path="/path/to/prebaked/chromium",
           proxy={"server": os.environ["HTTPS_PROXY"]},
       )
       page = browser.new_page()
       page.goto("https://example.com/", timeout=15000)
   ```
2. Navigation fails after roughly 6 seconds:
   ```
   Page.goto: net::ERR_CONNECTION_RESET at https://example.com/
   ```
3. The same failure was reproduced against several unrelated public HTTPS hosts (not a single
   flaky site), and separately observed against `accounts.google.com` during the same session.
4. In contrast, from the same shell in the same session:
   ```
   curl -v --proxy "$HTTPS_PROXY" https://example.com/
   ```
   completes a full request/response cycle without any special configuration.

## What was ruled out

- **Wrong browser binary / missing executable.** An earlier, separate issue (browser-executable-
  not-found, caused by a version mismatch between the pre-baked Chromium cache and the pip-installed
  Playwright package's default resolution) was fixed by pointing `executable_path` explicitly at the
  pre-baked binary. That fix is confirmed working — this is a distinct, later-stage failure.
- **Playwright not receiving the proxy config.** Passing `proxy={"server": ...}` to `launch()` was
  confirmed applied: the CONNECT tunnel to the target host is established immediately
  (`HTTP/1.1 200 Connection Established` observed in a Chromium netlog capture), so the browser is
  correctly using the configured proxy for the TCP-level connection.
- **Proxy connectivity or policy blocking.** A verbose `curl -v --proxy "$HTTPS_PROXY"` trace to the
  same target succeeds cleanly: CONNECT tunnel established, full TLS 1.3 handshake, ALPN negotiates
  `h2`, genuine certificate for the real origin presented (a real publicly-trusted cert, not a
  proxy-substituted one — confirming this is a pass-through tunnel, not TLS re-termination for this
  destination), `HTTP/2 200` with real content returned.
- **CA trust.** The proxy setup documents a CA bundle intended for tools that need it when TLS *is*
  re-terminated. Passing that CA bundle explicitly to curl via `--cacert` made no difference —
  curl already succeeded without it, and (per the point above) no re-termination is happening for
  this destination in the first place. Not a plausible cause for the browser failure either.
- **Environment network access level.** Confirmed via the platform's own documentation that the
  egress proxy applies to all outbound traffic unconditionally, regardless of the environment's
  configured access level (unrestricted / allowlist-only / restricted). Access level only changes
  which destinations are permitted through the same proxy — it does not provide a proxy-free path,
  and would not change this behavior. Separately, policy/allowlist denials have a distinct,
  different failure signature (an HTTP-level 4xx response with a deny-reason header) — nothing like
  the TLS-level `ERR_CONNECTION_RESET` seen here — so this was never an allowlist issue.

## What the evidence shows

A Chromium network log (`--log-net-log`) captured during a reproduced failure shows a consistent
signature across every failed attempt:

```
TCP_CONNECT → 127.0.0.1:<proxy port>        succeeds instantly
CONNECT <host>:443 HTTP/1.1                  sent
HTTP/1.1 200 Connection Established          received immediately
SSL_HANDSHAKE_MESSAGE_SENT (ClientHello, ~1.8–1.9 KB)
   ... ~6.0–6.1 second stall, consistently ...
SOCKET_READ_ERROR   net_error: -101 (ECONNRESET), os_error: 104
SSL_HANDSHAKE_ERROR
```

No `ServerHello` is ever received. The CONNECT tunnel itself completes normally and immediately —
the failure happens strictly after Chromium sends its TLS `ClientHello`, following a uniform ~6
second stall (consistent with a timeout somewhere in the path, not an instant rejection).

**Working hypothesis:** Chromium's `ClientHello` here is roughly 1.8–1.9 KB — large enough to span
more than one TCP segment — versus curl's much smaller `ClientHello` (well under one segment,
completing instantly). This size difference is consistent with Chromium's default post-quantum
hybrid key share (X25519MLKEM768), which the Chrome team has documented elsewhere as having
exposed real middlebox bugs across the internet: some proxies/middleboxes fail to correctly handle
a `ClientHello` that doesn't arrive in a single read. An attempt to test this directly, by disabling
the relevant Chromium feature flags and re-running the reproduction, produced an **identical
failure** — so either the flags used weren't the ones actually controlling this behavior in
Chromium 141 (the `ClientHello` size was not re-verified after applying them, so this test is
inconclusive rather than a clean negative result), or the size hypothesis is wrong and something
else about Chromium's TLS fingerprint (extension set, ALPN offer, cipher list) is the actual
trigger.

## Impact

Any tool that depends on launching a real browser (Playwright, Puppeteer, Selenium, etc.) for
outbound HTTPS from within this kind of Routines environment is likely to hit the same failure,
regardless of what destination it's reaching — this was not specific to any one site. Tools using
standard HTTP client libraries (curl, Python's `requests`/`urllib`, etc.) are unaffected.

## Suggested next steps for investigation

- Confirm whether the upstream egress proxy (or an intermediate hop in the tunnel path) has a
  known limitation handling multi-segment / fragmented TLS `ClientHello` records.
- If so, a fix on the proxy side (buffering/reassembling before parsing, or increasing a read
  timeout) would likely resolve this for any browser-based tool, not just this specific case.
- If not, a byte-level diff between Chromium's actual `ClientHello` and curl's (rather than just a
  size comparison) would help identify what specifically is different.
