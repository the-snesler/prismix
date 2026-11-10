import { Hono } from "hono";
import type { ServerConfig } from "../config";

// Hop-by-hop headers (and ones fetch must compute itself) never cross a proxy.
const STRIPPED_REQUEST_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  // Let Node's fetch negotiate compression; it decodes transparently.
  "accept-encoding",
  // Same-origin cookies belong to this app, not the provider.
  "cookie",
];

// Node's fetch has already decoded the body, so the upstream framing headers no longer apply.
const STRIPPED_RESPONSE_HEADERS = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
];

async function forward(request: Request, targetUrl: string): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      // Required by Node's fetch to stream a request body.
      ...(hasBody ? { duplex: "half" as const } : {}),
    } as RequestInit);
  } catch (error) {
    return Response.json(
      { error: `Upstream request failed: ${(error as Error).message}` },
      { status: 502 }
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) responseHeaders.delete(name);
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

/**
 * `/proxy/openai/*` and `/proxy/replicate/*`: same-origin pass-through for the
 * browser's text-model calls (the providers' CORS headers are missing or
 * incomplete). Mirrors `workers/app.ts`.
 */
export function proxyRoutes(upstream: ServerConfig["upstream"]) {
  const app = new Hono();

  for (const provider of ["openai", "replicate"] as const) {
    const prefix = `/${provider}`;
    app.all(`${prefix}/*`, (c) => {
      const url = new URL(c.req.url);
      const targetPath = url.pathname.slice(`/proxy${prefix}`.length);
      return forward(c.req.raw, `${upstream[provider]}${targetPath}${url.search}`);
    });
  }

  return app;
}
