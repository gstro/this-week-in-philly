/**
 * Real local servers for the fetch-layer tests (no mocks): a static HTTP
 * server, and a forward proxy that records what it carried, so tests can tell
 * proxied traffic from direct traffic.
 */

import { type IncomingMessage, type ServerResponse, createServer, request } from "node:http";
import { type AddressInfo, connect } from "node:net";

export interface Running {
  url: string;
  close(): Promise<void>;
}

export interface StaticServer extends Running {
  /** Paths requested so far, in order. */
  requests: string[];
}

export interface Page {
  body: string | Buffer;
  type?: string;
  status?: number;
  headers?: Record<string, string | string[]>;
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

function closer(server: ReturnType<typeof createServer>): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
}

/** Serves `pages` by path (a function sees the request); anything else is a 404. */
export async function startStaticServer(pages: Record<string, Page | ((req: IncomingMessage) => Page)>): Promise<StaticServer> {
  const requests: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "/";
    requests.push(path);
    const entry = pages[path];
    const page = typeof entry === "function" ? entry(req) : entry;
    if (!page) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(page.status ?? 200, { "Content-Type": page.type ?? "text/html; charset=utf-8", ...page.headers }).end(page.body);
  });
  return { url: await listen(server), requests, close: closer(server) };
}

export interface ProxyServer extends Running {
  /** Targets carried, as "CONNECT host:port" or "GET http://...". */
  carried: string[];
}

/** A forward proxy handling both plain-HTTP forwarding and CONNECT tunnels. */
export async function startProxy(): Promise<ProxyServer> {
  const carried: string[] = [];
  const server = createServer((req, res) => {
    carried.push(`${req.method ?? ""} ${req.url ?? ""}`);
    const upstream = request(req.url ?? "", { method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  server.on("connect", (req: IncomingMessage, socket, head: Buffer) => {
    carried.push(`CONNECT ${req.url ?? ""}`);
    const [host, port] = (req.url ?? "").split(":");
    const upstream = connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return { url: await listen(server), carried, close: closer(server) };
}

const PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];

/** Clear every proxy variable, then apply `vars`; returns a restore function. */
export function setProxyEnv(vars: Record<string, string> = {}): () => void {
  const saved = Object.fromEntries(PROXY_ENV.map((name) => [name, process.env[name]]));
  for (const name of PROXY_ENV) Reflect.deleteProperty(process.env, name);
  Object.assign(process.env, vars);
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
}
