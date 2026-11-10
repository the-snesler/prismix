import { Hono } from "hono";
import type { SqliteGalleryRepository } from "../repository";
import {
  HttpError,
  IMMUTABLE_PRIVATE,
  isObject,
  isStringArray,
  notFound,
  readJsonBody,
  sendFile,
} from "./util";

export function referenceRoutes(repository: SqliteGalleryRepository) {
  const app = new Hono();

  app.get("/", (c) => c.json(repository.listReferenceMetadata()));
  app.get("/ids", async (c) => c.json([...(await repository.getExistingReferenceImageIds())]));

  app.post("/", async (c) => {
    const form = await c.req.parseBody();
    const { id, name, sourceGalleryItemId, file } = form;
    if (typeof id !== "string" || !id) throw new HttpError(400, "`id` is required");
    if (typeof name !== "string") throw new HttpError(400, "`name` is required");
    if (!(file instanceof Blob)) throw new HttpError(400, "Missing `file`");

    const saved = await repository.saveReferenceImage({
      id,
      name,
      blob: file,
      ...(typeof sourceGalleryItemId === "string" && sourceGalleryItemId
        ? { sourceGalleryItemId }
        : {}),
    });
    return c.json(
      {
        id: saved.id,
        name: saved.name,
        ...(saved.sourceGalleryItemId ? { sourceGalleryItemId: saved.sourceGalleryItemId } : {}),
      },
      201
    );
  });

  app.post("/delete", async (c) => {
    const body = await readJsonBody(c);
    if (!isObject(body) || !isStringArray(body.ids)) {
      throw new HttpError(400, "`ids` must be a string array");
    }
    await repository.deleteReferenceImagesByIds(body.ids);
    return c.json({ ok: true });
  });

  app.post("/gc", async (c) => {
    const body = await readJsonBody(c);
    const extra = isObject(body) ? (body.extraReachableIds ?? []) : undefined;
    if (!isStringArray(extra))
      throw new HttpError(400, "`extraReachableIds` must be a string array");
    return c.json({ deleted: await repository.garbageCollectReferences(extra) });
  });

  // Bytes. Metadata rides along in headers so the client can rebuild a
  // `ReferenceImage` without a second request.
  app.on(["GET", "HEAD"], "/:id", async (c) => {
    const file = repository.getReferenceFile(c.req.param("id"));
    if (!file) return notFound(c, "Reference not found");
    const headers: Record<string, string> = {
      "Cache-Control": IMMUTABLE_PRIVATE,
      "X-Reference-Name": encodeURIComponent(file.name),
    };
    if (file.sourceGalleryItemId) {
      headers["X-Source-Gallery-Item-Id"] = encodeURIComponent(file.sourceGalleryItemId);
    }
    return sendFile(c, file, headers);
  });

  return app;
}
