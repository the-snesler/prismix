import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import type { Context } from "hono";
import type { StoredFile } from "../repository";

/** Stored blobs are keyed by immutable UUIDs, so their URLs can be cached forever. */
export const IMMUTABLE_PRIVATE = "private, max-age=31536000, immutable";

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415 | 500,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function notFound(c: Context, what = "Not found") {
  return c.json({ error: what }, 404);
}

export async function readJsonBody<T = unknown>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Stream a stored file, or 404 JSON if it vanished from disk. */
export async function sendFile(
  c: Context,
  file: StoredFile,
  headers: Record<string, string> = {}
): Promise<Response> {
  let size: number;
  try {
    const stat = await fsp.stat(file.path);
    if (!stat.isFile()) return notFound(c, "File not found");
    size = stat.size;
  } catch {
    return notFound(c, "File not found");
  }

  const responseHeaders = new Headers({
    "Content-Type": file.mimeType,
    "Content-Length": String(size),
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers: responseHeaders });

  const stream = Readable.toWeb(fs.createReadStream(file.path)) as ReadableStream<Uint8Array>;
  return new Response(stream, { status: 200, headers: responseHeaders });
}
