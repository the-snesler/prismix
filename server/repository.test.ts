import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createDeps, type AppDeps } from "./app";
import { loadConfig } from "./config";
import type { StoredImageRecord } from "~/types";

let dataDir: string;
let deps: AppDeps;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prismix-repository-"));
  deps = createDeps(loadConfig({ DATA_DIR: dataDir }));
});

afterEach(() => {
  deps.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function saveImage(
  id: string,
  createdAt: number,
  embedding: Pick<StoredImageRecord, "embedding" | "embeddingModelId"> = {}
) {
  const bytes = await sharp({
    create: { width: 4, height: 4, channels: 3, background: "#000" },
  })
    .png()
    .toBuffer();
  const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
  await deps.repository.saveImage({
    id,
    prompt: id,
    modelId: "debug/debug-model",
    modelName: "Debug",
    aspectRatio: "1:1",
    resolution: null,
    width: 4,
    height: 4,
    createdAt,
    referenceImageIds: [],
    metadata: {},
    originalBlob: blob,
    thumbnailBlob: blob,
    ...embedding,
  });
}

describe("getImageIdsNeedingEmbedding", () => {
  beforeEach(async () => {
    await saveImage("none", 1);
    await saveImage("empty", 2, { embedding: [], embeddingModelId: "clip" });
    await saveImage("clip", 3, { embedding: [0.1], embeddingModelId: "clip" });
    await saveImage("siglip", 4, { embedding: [0.2], embeddingModelId: "siglip" });
    await saveImage("unknown-model", 5, { embedding: [0.3] });
  });

  it("returns images without an embedding when no model is given, newest first", async () => {
    expect(await deps.repository.getImageIdsNeedingEmbedding(null)).toEqual(["empty", "none"]);
  });

  it("also returns images embedded by another model", async () => {
    expect(await deps.repository.getImageIdsNeedingEmbedding("siglip")).toEqual([
      "unknown-model",
      "clip",
      "empty",
      "none",
    ]);
  });

  it("agrees with getEmbeddingCounts", async () => {
    for (const modelId of [null, "clip", "siglip"]) {
      const { total, indexed } = await deps.repository.getEmbeddingCounts(modelId);
      const missing = await deps.repository.getImageIdsNeedingEmbedding(modelId);
      expect(missing.length).toBe(total - indexed);
    }
  });
});

describe("searchImageIds", () => {
  const filter = { query: "", queryEmbedding: null, favoritesOnly: false, characterId: null };

  beforeEach(async () => {
    await saveImage("old-cat", 1, { embedding: [1, 0], embeddingModelId: "m" });
    await saveImage("mid-dog", 2, { embedding: [0, 1], embeddingModelId: "m" });
    await saveImage("new-cat", 3);
  });

  it("searches every image, newest first for substring matches", async () => {
    expect(await deps.repository.searchImageIds({ ...filter, query: "cat" })).toEqual([
      "new-cat",
      "old-cat",
    ]);
  });

  it("ranks by embedding similarity", async () => {
    expect(
      await deps.repository.searchImageIds({ ...filter, query: "pet", queryEmbedding: [0, 1] })
    ).toEqual(["mid-dog"]);
  });

  it("sees writes made after the index was built", async () => {
    expect(await deps.repository.searchImageIds({ ...filter, favoritesOnly: true })).toEqual([]);
    await deps.repository.updateImageFavorite("old-cat", true);
    await deps.repository.updateImageEmbedding("new-cat", [0, 1], "m");
    await deps.repository.deleteImage("mid-dog");
    await saveImage("newest-dog", 4, { embedding: [0, 1], embeddingModelId: "m" });

    expect(await deps.repository.searchImageIds({ ...filter, favoritesOnly: true })).toEqual([
      "old-cat",
    ]);
    expect(
      await deps.repository.searchImageIds({ ...filter, query: "pet", queryEmbedding: [0, 1] })
    ).toEqual(["newest-dog", "new-cat"]);
  });

  it("returns display items by ID in the requested order, skipping missing ones", async () => {
    const items = await deps.repository.getImagesByIds(["old-cat", "missing", "new-cat"]);
    expect(items.map((i) => [i.id, i.status, i.thumbnailUrl])).toEqual([
      ["old-cat", "completed", "/api/images/old-cat/thumbnail"],
      ["new-cat", "completed", "/api/images/new-cat/thumbnail"],
    ]);
  });
});

describe("search routes", () => {
  const post = (path: string, body: unknown) =>
    createApp(deps).request(`/api/images/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    await saveImage("a-fox", 1, { embedding: [1, 0], embeddingModelId: "m" });
    await saveImage("b-sky", 2, { embedding: [0, 1], embeddingModelId: "m" });
  });

  it("POST /search returns ranked IDs and fills optional fields", async () => {
    const res = await post("search", { query: "zzz", queryEmbedding: [1, 0.1] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["a-fox"]);
  });

  it("POST /search rejects a malformed filter", async () => {
    expect((await post("search", { query: 5 })).status).toBe(400);
    expect((await post("search", { query: "", queryEmbedding: ["x"] })).status).toBe(400);
  });

  it("POST /by-ids returns display items", async () => {
    const res = await post("by-ids", { ids: ["b-sky", "missing"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Array<{ id: string }>).map((i) => i.id)).toEqual(["b-sky"]);
    expect((await post("by-ids", { ids: "b-sky" })).status).toBe(400);
  });
});
