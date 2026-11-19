import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeps, type AppDeps } from "./app";
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
