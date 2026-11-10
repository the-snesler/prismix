import fsp from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import mime from "mime";
import { sendFile } from "./util";

const SPA_FALLBACK = "__spa-fallback.html";

function contentType(file: string): string {
  const type = mime.getType(file) ?? "application/octet-stream";
  return type.startsWith("text/") ||
    type === "application/javascript" ||
    type === "application/json"
    ? `${type}; charset=utf-8`
    : type;
}

function cacheControl(urlPath: string, file: string): string {
  // Vite emits content-hashed filenames under /assets.
  if (urlPath.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (file.endsWith(".html")) return "no-cache";
  return "public, max-age=3600";
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The built SPA: real files from `staticDir` (`/` is the prerendered landing
 * page), and `__spa-fallback.html` for every other path so client-side routes
 * like `/app/settings` load the app shell.
 */
export function staticRoutes(staticDir: string) {
  const root = path.resolve(staticDir);
  const app = new Hono();

  app.on(["GET", "HEAD"], "*", async (c) => {
    const urlPath = new URL(c.req.url).pathname;

    let candidate: string | null = null;
    try {
      const decoded = decodeURIComponent(urlPath);
      const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
      const resolved = path.resolve(root, relative);
      if (resolved.startsWith(root + path.sep) && !decoded.includes("\0")) candidate = resolved;
    } catch {
      // Malformed escape sequence: serve the app shell.
    }

    if (candidate && (await isFile(candidate))) {
      return sendFile(
        c,
        { path: candidate, mimeType: contentType(candidate) },
        { "Cache-Control": cacheControl(urlPath, candidate) }
      );
    }

    // A missing hashed asset (stale tab after a redeploy) must not get HTML back.
    if (urlPath.startsWith("/assets/")) return c.text("Not found", 404);

    const fallback = path.join(root, SPA_FALLBACK);
    if (!(await isFile(fallback))) {
      return c.text("Prismix web build not found. Run `pnpm build` or set STATIC_DIR.", 404);
    }
    return sendFile(
      c,
      { path: fallback, mimeType: contentType(fallback) },
      { "Cache-Control": "no-cache" }
    );
  });

  return app;
}
