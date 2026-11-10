import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createDeps, type AppDeps } from "./app";
import { loadConfig } from "./config";
import { createThumbnail } from "./thumbnails";
import { ImportUploads, readLimitedBody, UploadError, type UploadState } from "./uploads";

let dataDir: string;
let deps: AppDeps;
let app: ReturnType<typeof createApp>;

async function archive(imageCount: number): Promise<Uint8Array> {
  const zip = new JSZip();
  const manifest = [];
  for (let i = 0; i < imageCount; i++) {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: `#00${i}0ff` },
    })
      .png()
      .toBuffer();
    zip.file(`images/img-${i}.png`, png);
    manifest.push({
      id: `img-${i}`,
      filename: `images/img-${i}.png`,
      prompt: `image ${i}`,
      modelId: "m",
      modelName: "M",
      aspectRatio: null,
      resolution: null,
      width: 32,
      height: 32,
      createdAt: i,
      referenceImageIds: [],
      metadata: {},
    });
  }
  zip.file("manifest.json", JSON.stringify(manifest));
  return zip.generateAsync({ type: "uint8array" });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function put(id: string, offset: number, bytes: Uint8Array) {
  return app.request(`/api/import/uploads/${id}?offset=${offset}`, {
    method: "PUT",
    body: new Blob([new Uint8Array(bytes)]),
  });
}

async function pollUntilSettled(id: string): Promise<UploadState> {
  for (let i = 0; i < 200; i++) {
    const state = await json<UploadState>(await app.request(`/api/import/uploads/${id}`));
    if (state.status !== "processing") return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("import never finished");
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prismix-uploads-"));
  deps = createDeps(loadConfig({ DATA_DIR: dataDir }));
  app = createApp(deps);
});

afterEach(async () => {
  await deps.uploads.idle();
  deps.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("chunked import uploads", () => {
  it("assembles chunks (including a retried one), imports in the background, and reports progress", async () => {
    const bytes = await archive(3);
    const created = await app.request("/api/import/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size: bytes.byteLength, name: "test.zip" }),
    });
    expect(created.status).toBe(201);
    const { id } = await json<UploadState>(created);

    const third = Math.ceil(bytes.byteLength / 3);
    expect((await put(id, 0, bytes.subarray(0, third))).status).toBe(200);
    // A retried chunk (same offset) is accepted and doesn't double-count.
    const retried = await json<UploadState>(await put(id, 0, bytes.subarray(0, third)));
    expect(retried.received).toBe(third);
    await put(id, third, bytes.subarray(third, third * 2));

    // Completing early is refused.
    expect(
      (await app.request(`/api/import/uploads/${id}/complete`, { method: "POST" })).status
    ).toBe(409);

    const last = await json<UploadState>(await put(id, third * 2, bytes.subarray(third * 2)));
    expect(last.received).toBe(bytes.byteLength);

    const completed = await app.request(`/api/import/uploads/${id}/complete`, { method: "POST" });
    expect(completed.status).toBe(202);
    const settled = await pollUntilSettled(id);

    expect(settled).toMatchObject({
      status: "done",
      progress: { done: 3, total: 3 },
      result: { imported: 3, failed: 0, skipped: 0 },
    });
    expect(await deps.repository.getImageCount()).toBe(3);
    expect(fs.existsSync(path.join(dataDir, "tmp", "uploads", `${id}.zip`))).toBe(false);
  });

  it("answers a gap with 409 and the offset to resume from", async () => {
    const { id } = await deps.uploads.create(100, "x.zip");
    await put(id, 0, new Uint8Array(10));
    const gap = await put(id, 50, new Uint8Array(10));
    expect(gap.status).toBe(409);
    expect((await json<{ upload: UploadState }>(gap)).upload.received).toBe(10);
    expect((await put(id, 95, new Uint8Array(10))).status).toBe(409);
    expect((await app.request(`/api/import/uploads/not-an-id`)).status).toBe(404);
  });

  it("reports a broken archive as a failed import", async () => {
    const bytes = new TextEncoder().encode("definitely not a zip");
    const { id } = await deps.uploads.create(bytes.byteLength, "bad.zip");
    await put(id, 0, bytes);
    await app.request(`/api/import/uploads/${id}/complete`, { method: "POST" });
    const settled = await pollUntilSettled(id);
    expect(settled.status).toBe("failed");
    expect(settled.error).toMatch(/Not a valid zip archive/);
  });

  it("cancels an upload and removes its bytes", async () => {
    const { id } = await deps.uploads.create(100, "x.zip");
    await put(id, 0, new Uint8Array(10));
    const canceled = await json<UploadState>(
      await app.request(`/api/import/uploads/${id}`, { method: "DELETE" })
    );
    expect(canceled.status).toBe("canceled");
    expect((await put(id, 10, new Uint8Array(10))).status).toBe(409);
    expect(fs.existsSync(path.join(dataDir, "tmp", "uploads", `${id}.zip`))).toBe(false);
  });

  it("resumes uploads and restarts interrupted imports after a server restart", async () => {
    const bytes = await archive(2);
    const partial = await deps.uploads.create(bytes.byteLength, "resume.zip");
    await deps.uploads.appendChunk(partial.id, 0, bytes.subarray(0, 100));

    const full = await deps.uploads.create(bytes.byteLength, "interrupted.zip");
    await deps.uploads.appendChunk(full.id, 0, bytes);
    // Simulate a crash mid-import: the saved state says "processing".
    const statePath = path.join(dataDir, "tmp", "uploads", `${full.id}.json`);
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8")) as UploadState;
    fs.writeFileSync(statePath, JSON.stringify({ ...saved, status: "processing" }));

    const restarted = new ImportUploads(path.join(dataDir, "tmp", "uploads"), {
      repository: deps.repository,
      settings: deps.settings,
      createThumbnail: (blob) => createThumbnail(blob),
    });
    await restarted.recover();
    await restarted.idle();

    expect(restarted.get(full.id)).toMatchObject({ status: "done", result: { imported: 2 } });
    expect(restarted.get(partial.id)).toMatchObject({ status: "uploading", received: 100 });
    const resumed = await restarted.appendChunk(partial.id, 100, bytes.subarray(100));
    expect(resumed.received).toBe(bytes.byteLength);
  });

  it("refuses oversized chunks", async () => {
    const body = new Blob([new Uint8Array(2048)]).stream();
    await expect(readLimitedBody(body, 1024)).rejects.toMatchObject({ status: 413 });
    expect(new UploadError(413, "x").status).toBe(413);
  });
});
