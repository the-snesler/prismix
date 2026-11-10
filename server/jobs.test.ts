import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setPlatform } from "~/lib/platform";
import type { ImageGenerationTask } from "~/lib/tasks/types";
import type { GalleryItem } from "~/types";
import { createDeps, type AppDeps } from "./app";
import { loadConfig } from "./config";
import type { ServerEvent } from "./events";
import { INTERRUPTED_ERROR, JobConflictError, JobRunner, JobValidationError } from "./jobs";
import { createNodePlatform } from "./platform";
import { createThumbnail } from "./thumbnails";

let dataDir: string;
let deps: AppDeps;
let events: ServerEvent[];

function open(concurrency = 4): AppDeps {
  const config = { ...loadConfig({ DATA_DIR: dataDir }), generationConcurrency: concurrency };
  const opened = createDeps(config);
  setPlatform(createNodePlatform(opened.db, config));
  opened.events.subscribe((event) => events.push(event));
  return opened;
}

function debugTask(itemIds: string[], overrides: Partial<ImageGenerationTask> = {}) {
  return {
    kind: "image",
    itemIds,
    modelId: "debug/debug-model",
    modelName: "Debug",
    provider: "debug",
    prompt: "a test card",
    aspectRatio: "1:1",
    resolution: null,
    quality: null,
    numberOfImages: itemIds.length,
    referenceImageIds: [],
    ...overrides,
  } satisfies ImageGenerationTask;
}

function itemRow(id: string): GalleryItem | undefined {
  return deps.jobs.listItems().find((item) => item.id === id);
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prismix-jobs-"));
  events = [];
  deps = open();
});

afterEach(async () => {
  await deps.jobs.idle();
  deps.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("JobRunner", () => {
  it("runs a job to completion and stores the images", async () => {
    await deps.jobs.submit(
      [debugTask(["a", "b"])],
      [
        {
          id: "a",
          status: "pending",
          modelId: "x",
          modelName: "Client label",
          prompt: "p",
          aspectRatio: "1:1",
          resolution: null,
          referenceImageIds: [],
          loadingPreview: { dataUrl: "data:image/webp;base64,AA==", width: 1, height: 1 },
        },
      ]
    );
    // Queued jobs start straight away, so the card may already be generating.
    expect(itemRow("a")).toMatchObject({
      status: expect.stringMatching(/^(pending|generating)$/),
      modelName: "Debug",
      loadingPreview: { width: 1 },
    });

    await deps.jobs.idle();

    expect(deps.jobs.listItems()).toEqual([]);
    expect(await deps.repository.getImageCount()).toBe(2);
    const record = await deps.repository.getImageById("a");
    expect(record).toMatchObject({ prompt: "a test card", modelId: "debug/debug-model" });
    const thumbnail = await deps.repository.getImageBlob("a", "thumbnail");
    expect(thumbnail?.type).toBe("image/webp");

    const completed = events.filter(
      (e) => e.type === "item" && (e.data as GalleryItem).status === "completed"
    );
    expect(completed.map((e) => (e.data as GalleryItem).id).sort()).toEqual(["a", "b"]);
    expect(completed[0].data).toMatchObject({
      originalUrl: expect.stringMatching(/^\/api\/images\/.+\/original$/),
      originalMimeType: "image/png",
    });
    // No finished job rows are kept.
    expect(deps.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });

  it("keeps failures until they're dismissed, and retries a failed ID", async () => {
    await deps.jobs.submit([
      debugTask(["f"], { provider: "google", modelId: "gemini-x", missingKeyIsFinal: false }),
    ]);
    await deps.jobs.idle();

    expect(itemRow("f")).toMatchObject({
      status: "failed",
      error: "No API key for google",
      canRetry: true,
    });

    // Retry = resubmit the same item ID with a working task.
    await deps.jobs.submit([debugTask(["f"])]);
    await deps.jobs.idle();
    expect(itemRow("f")).toBeUndefined();
    expect(await deps.repository.getImageById("f")).not.toBeNull();

    await deps.jobs.submit([debugTask(["g"], { provider: "google", modelId: "gemini-x" })]);
    await deps.jobs.idle();
    expect(deps.jobs.dismiss("g")).toBe(true);
    expect(itemRow("g")).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "item-removed", data: { id: "g" } });
  });

  it("drops a canceled job's result", async () => {
    deps.db.close();
    deps = open(1);
    await deps.jobs.submit([debugTask(["first"]), debugTask(["second"])]);
    expect(deps.jobs.cancel("second")).toBe(true);
    expect(deps.jobs.cancel("first")).toBe(true); // already running

    await deps.jobs.idle();

    expect(await deps.repository.getImageCount()).toBe(0);
    expect(deps.jobs.listItems()).toEqual([]);
  });

  it("keeps references of failed and pending jobs through reference GC", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    for (const id of ["ref-failed", "ref-orphan"]) {
      await deps.repository.saveReferenceImage({ id, name: id, blob });
    }
    await deps.jobs.submit([
      debugTask(["f"], {
        provider: "google",
        modelId: "gemini-x",
        referenceImageIds: ["ref-failed"],
      }),
    ]);
    await deps.jobs.idle();
    expect(itemRow("f")?.status).toBe("failed");

    expect(await deps.repository.garbageCollectReferences([])).toBe(1);
    expect([...(await deps.repository.getExistingReferenceImageIds())]).toEqual(["ref-failed"]);
  });

  it("rejects duplicate, running, and manual-debug submissions", async () => {
    await deps.jobs.submit([debugTask(["dup"])]);
    await expect(deps.jobs.submit([debugTask(["dup"])])).rejects.toBeInstanceOf(JobConflictError);
    await deps.jobs.idle();
    await expect(deps.jobs.submit([debugTask(["dup"])])).rejects.toBeInstanceOf(JobConflictError);

    await expect(
      deps.jobs.submit([debugTask(["m"], { modelId: "debug/manual" })])
    ).rejects.toBeInstanceOf(JobValidationError);
    await expect(deps.jobs.submit([{ kind: "image" }])).rejects.toBeInstanceOf(JobValidationError);
    await expect(deps.jobs.submit([debugTask(["x", "x"])])).rejects.toBeInstanceOf(
      JobValidationError
    );
  });

  it("recovers after a restart without re-running requests that may have been billed", () => {
    const insertJob = deps.db.prepare(
      `INSERT INTO jobs (id, task, item_ids, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertItem = deps.db.prepare(
      "INSERT INTO items (id, job_id, item, updated_at) VALUES (?, ?, ?, ?)"
    );
    const now = Date.now();
    const seed = (jobId: string, status: string, itemId: string, itemStatus: string) => {
      const task = debugTask([itemId]);
      insertJob.run(jobId, JSON.stringify(task), JSON.stringify([itemId]), status, now, now);
      insertItem.run(
        itemId,
        jobId,
        JSON.stringify({
          id: itemId,
          status: itemStatus,
          modelId: task.modelId,
          modelName: "Debug",
          prompt: task.prompt,
          aspectRatio: "1:1",
          resolution: null,
          referenceImageIds: [],
        }),
        now
      );
    };
    seed("j-queued", "queued", "q", "pending");
    seed("j-waiting", "running", "w", "waiting");
    seed("j-running", "running", "r", "generating");

    // A fresh runner over the same database, as after a restart.
    const runner = new JobRunner({
      db: deps.db,
      repository: deps.repository,
      events: deps.events,
      getApiKey: () => undefined,
      createThumbnail: (blob) => createThumbnail(blob),
      concurrencyPerProvider: 4,
    });
    runner.recover();

    const byId = new Map(runner.listItems().map((item) => [item.id, item]));
    expect(byId.get("q")?.status).toMatch(/^(pending|generating)$/);
    expect(byId.get("w")?.status).toMatch(/^(pending|generating)$/);
    expect(byId.get("r")).toMatchObject({
      status: "failed",
      error: INTERRUPTED_ERROR,
      canRetry: true,
    });

    return runner.idle().then(async () => {
      expect(await deps.repository.getImageById("q")).not.toBeNull();
      expect(await deps.repository.getImageById("w")).not.toBeNull();
      expect(await deps.repository.getImageById("r")).toBeNull();
    });
  });
});
