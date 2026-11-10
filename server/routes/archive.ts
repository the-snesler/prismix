import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Hono } from "hono";
import { archiveFilename } from "~/lib/archive/manifest";
import { ArchiveError, createExportStream, importArchive, type ArchiveDeps } from "../archive";

/** `GET /api/export` (zip download) and `POST /api/import` (raw zip body). */
export function archiveRoutes(deps: ArchiveDeps & { tempDir: string }) {
  const app = new Hono();

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
