import { Hono } from "hono";
import type { StoredEditorSession } from "~/types";
import type { SqliteGalleryRepository } from "../repository";
import { HttpError, isObject, notFound, readJsonBody } from "./util";

function parseSession(body: unknown): StoredEditorSession {
  if (!isObject(body) || typeof body.id !== "string" || !body.id) {
    throw new HttpError(400, "Session `id` is required");
  }
  if (!Array.isArray(body.turns) || !Array.isArray(body.additionalReferenceIds)) {
    throw new HttpError(400, "Session `turns` and `additionalReferenceIds` must be arrays");
  }
  return body as unknown as StoredEditorSession;
}

export function sessionRoutes(repository: SqliteGalleryRepository) {
  const app = new Hono();

  app.get("/", async (c) => c.json(await repository.getAllSessions()));

  app.put("/", async (c) => {
    const id = await repository.upsertEditorSession(parseSession(await readJsonBody(c)));
    return c.json({ id });
  });

  app.get("/by-gallery-item/:galleryItemId", async (c) => {
    // Lookups by image answer 200 null when there's no session: most images have none,
    // and a 404 would log a console error on every lightbox open.
    return c.json(await repository.getSessionByGalleryItemId(c.req.param("galleryItemId")));
  });

  app.get("/for-image/:imageId", async (c) => {
    return c.json(await repository.findSessionForImage(c.req.param("imageId")));
  });

  app.get("/:id", async (c) => {
    const session = await repository.getSessionById(c.req.param("id"));
    return session ? c.json(session) : notFound(c, "Session not found");
  });

  app.delete("/:id", async (c) => {
    await repository.deleteEditorSession(c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}
