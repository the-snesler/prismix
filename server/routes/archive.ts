import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Hono } from "hono";
import { archiveFilename } from "~/lib/archive/manifest";
import { ArchiveError, createExportStream, importArchive, type ArchiveDeps } from "../archive";
import { MAX_CHUNK_BYTES, readLimitedBody, UploadError, type ImportUploads } from "../uploads";
import { isObject, readJsonBody } from "./util";

/**
 * `GET /api/export` (zip download), `/api/import/uploads/*` (resumable chunked
 * import, used by the web app), and `POST /api/import` (one-shot raw zip body,
 * handy for scripts and small archives).
 */
export function archiveRoutes(deps: ArchiveDeps & { tempDir: string; uploads: ImportUploads }) {
  const app = new Hono();
  const { uploads } = deps;

  app.onError((error, c) => {
    if (error instanceof UploadError) {
      return c.json({ error: error.message, upload: error.state }, error.status);
    }
    throw error;
  });

  // Start: { size, name } -> UploadState
  app.post("/import/uploads", async (c) => {
    const body = await readJsonBody(c);
    if (!isObject(body)) return c.json({ error: "Body must be an object" }, 400);
    return c.json(await uploads.create(body.size, body.name), 201);
  });

  app.get("/import/uploads/:id", (c) => {
    const state = uploads.get(c.req.param("id"));
    return state ? c.json(state) : c.json({ error: "Upload not found" }, 404);
  });

  // One chunk: raw bytes written at ?offset=N.
  app.put("/import/uploads/:id", async (c) => {
    const offset = Number(c.req.query("offset"));
    const chunk = await readLimitedBody(c.req.raw.body, MAX_CHUNK_BYTES);
    return c.json(await uploads.appendChunk(c.req.param("id"), offset, chunk));
  });

  // All bytes sent: import in the background; poll GET for progress.
  app.post("/import/uploads/:id/complete", async (c) =>
    c.json(await uploads.complete(c.req.param("id")), 202)
  );

  app.delete("/import/uploads/:id", async (c) => c.json(await uploads.cancel(c.req.param("id"))));

  app.get("/export", async () => {
    const stream = await createExportStream(deps);
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${archiveFilename()}"`,
        "Cache-Control": "no-store",
      },
    });
  });

  app.post("/import", async (c) => {
    const body = c.req.raw.body;
    if (!body) return c.json({ error: "Request body must be a zip archive" }, 400);

    // yauzl needs random access, so spool the upload to disk first.
    await fsp.mkdir(deps.tempDir, { recursive: true });
    const temp = path.join(deps.tempDir, `import-${randomBytes(8).toString("hex")}.zip`);
    try {
      await pipeline(
        Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>),
        fs.createWriteStream(temp)
      );
      return c.json(await importArchive(temp, deps));
    } catch (error) {
      if (error instanceof ArchiveError) return c.json({ error: error.message }, 400);
      throw error;
    } finally {
      await fsp.rm(temp, { force: true });
    }
  });

  return app;
}
