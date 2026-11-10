import { Hono } from "hono";
import type { ImageBlobVariant } from "~/lib/backend/types";
import type { ImageRecord, ImageScorecard, StoredImageRecord } from "~/types";
import { ConflictError, type ImagePatch, type SqliteGalleryRepository } from "../repository";
import { createThumbnail } from "../thumbnails";
import {
  HttpError,
  IMMUTABLE_PRIVATE,
  isObject,
  isStringArray,
  notFound,
  readJsonBody,
  sendFile,
} from "./util";

/** Display-only fields a client might accidentally include in a record. */
const DISPLAY_ONLY_FIELDS = ["status", "originalUrl", "thumbnailUrl", "originalMimeType"];

function parseImageRecord(raw: unknown): ImageRecord {
  if (typeof raw !== "string") throw new HttpError(400, "Missing `record` field");
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "`record` must be JSON");
  }
  if (!isObject(record) || typeof record.id !== "string" || !record.id) {
    throw new HttpError(400, "`record.id` is required");
  }
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) {
    throw new HttpError(400, "`record.createdAt` must be a number");
  }
  for (const field of [...DISPLAY_ONLY_FIELDS, "originalBlob", "thumbnailBlob"]) {
    delete record[field];
  }
  return record as unknown as ImageRecord;
}

function parsePatch(body: unknown): ImagePatch {
  if (!isObject(body)) throw new HttpError(400, "Body must be an object");
  const patch: ImagePatch = {};
  if ("isFavorite" in body) {
    if (typeof body.isFavorite !== "boolean")
      throw new HttpError(400, "`isFavorite` must be boolean");
    patch.isFavorite = body.isFavorite;
  }
  if ("characterIds" in body) {
    if (!isStringArray(body.characterIds)) {
      throw new HttpError(400, "`characterIds` must be a string array");
    }
    patch.characterIds = body.characterIds;
  }
  if ("embedding" in body) {
    if (!Array.isArray(body.embedding) || !body.embedding.every((v) => typeof v === "number")) {
      throw new HttpError(400, "`embedding` must be a number array");
    }
    patch.embedding = body.embedding as number[];
  }
  if ("embeddingModelId" in body) {
    if (typeof body.embeddingModelId !== "string") {
      throw new HttpError(400, "`embeddingModelId` must be a string");
    }
    patch.embeddingModelId = body.embeddingModelId;
  }
  if ("scorecard" in body) {
    if (body.scorecard !== null && !isObject(body.scorecard)) {
      throw new HttpError(400, "`scorecard` must be an object or null");
    }
    patch.scorecard = body.scorecard as ImageScorecard | null;
  }
  return patch;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `Invalid integer: ${value}`);
  return n;
}

export function imageRoutes(repository: SqliteGalleryRepository) {
  const app = new Hono();

  app.get("/", async (c) => {
    const limit = parseNonNegativeInt(c.req.query("limit"), 30);
    const offset = parseNonNegativeInt(c.req.query("offset"), 0);
    return c.json(await repository.getImagesPaginated(limit, offset));
  });

  // Static paths before `/:id`.
  app.get("/all", async (c) => c.json(await repository.getAllImages()));
  app.get("/ids", async (c) => c.json([...(await repository.getExistingImageIds())]));
  app.get("/count", async (c) => c.json({ count: await repository.getImageCount() }));
  app.get("/stats", async (c) => c.json(await repository.getImageStatRecords()));
  app.get("/embedding-counts", async (c) =>
    c.json(await repository.getEmbeddingCounts(c.req.query("modelId") || null))
  );

  app.post("/remove-style", async (c) => {
    const body = await readJsonBody(c);
    if (!isObject(body) || typeof body.styleId !== "string") {
      throw new HttpError(400, "`styleId` is required");
    }
    await repository.removeImageStyleReferences(body.styleId);
    return c.json({ ok: true });
  });

  app.post("/", async (c) => {
    const form = await c.req.parseBody();
    const record = parseImageRecord(form.record);
    const original = form.original;
    if (!(original instanceof Blob)) throw new HttpError(400, "Missing `original` file");
    const thumbnail =
      form.thumbnail instanceof Blob && form.thumbnail.size > 0
        ? form.thumbnail
        : await createThumbnail(original);

    const image: StoredImageRecord = {
      ...record,
      originalBlob: original,
      thumbnailBlob: thumbnail,
    };
    if (c.req.query("mode") === "import") {
      await repository.importImage(image);
    } else {
      try {
        await repository.saveImage(image);
      } catch (error) {
        if (error instanceof ConflictError) throw new HttpError(409, error.message);
        throw error;
      }
    }
    return c.json(await repository.getImageById(record.id), 201);
  });

  app.get("/:id", async (c) => {
    const record = await repository.getImageById(c.req.param("id"));
    return record ? c.json(record) : notFound(c, "Image not found");
  });

  // The image as a completed gallery card (used by the job client to settle cards).
  app.get("/:id/item", (c) => {
    const item = repository.getDisplayImage(c.req.param("id"));
    return item ? c.json(item) : notFound(c, "Image not found");
  });

  for (const variant of ["original", "thumbnail"] as ImageBlobVariant[]) {
    app.on(["GET", "HEAD"], `/:id/${variant}`, async (c) => {
      const file = repository.getImageFile(c.req.param("id"), variant);
      if (!file) return notFound(c, "Image not found");
      return sendFile(c, file, { "Cache-Control": IMMUTABLE_PRIVATE });
    });
  }

  app.patch("/:id", async (c) => {
    const patch = parsePatch(await readJsonBody(c));
    const record = repository.patchImage(c.req.param("id"), patch);
    return record ? c.json(record) : notFound(c, "Image not found");
  });

  app.delete("/:id", async (c) => {
    await repository.deleteImage(c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}
