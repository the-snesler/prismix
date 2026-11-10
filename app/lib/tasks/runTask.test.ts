import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError, type GenerationResult } from "~/lib/generation";
import type { StoredImageRecord } from "~/types";
import { runGenerationTask } from "./runTask";
import type { ImageGenerationTask, TaskEvent, TaskRunnerDeps, UpscaleTask } from "./types";

const executeGeneration = vi.fn();
const executeUpscale = vi.fn();

vi.mock("~/lib/generation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/generation")>()),
  executeGeneration: (...args: unknown[]) => executeGeneration(...args),
}));
vi.mock("~/lib/upscaling", () => ({
  executeUpscale: (...args: unknown[]) => executeUpscale(...args),
}));

function result(label: string): GenerationResult {
  return {
    blob: new Blob([label], { type: "image/png" }),
    width: 64,
    height: 32,
    metadata: { label },
  };
}

function imageTask(overrides: Partial<ImageGenerationTask> = {}): ImageGenerationTask {
  return {
    kind: "image",
    itemIds: ["a", "b"],
    modelId: "gemini-test",
    modelName: "Gemini Test",
    provider: "google",
    prompt: "a cat",
    aspectRatio: "1:1",
    resolution: null,
    quality: null,
    numberOfImages: 2,
    referenceImageIds: ["ref-1"],
    parentGalleryItemIds: ["parent-1"],
    characterIds: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<TaskRunnerDeps> = {}) {
  const events: TaskEvent[] = [];
  const saved: StoredImageRecord[] = [];
  const deleted: string[] = [];
  const canceled = new Set<string>();
  const deps: TaskRunnerDeps = {
    getApiKey: () => "key",
    loadReferences: async (ids) => ids.map((id) => ({ id, blob: new Blob([id]) })),
    createThumbnail: async (original) => new Blob([original], { type: "image/webp" }),
    saveImage: async (record) => {
      saved.push(record);
    },
    deleteImage: async (id) => {
      deleted.push(id);
    },
    isCanceled: (id) => canceled.has(id),
    emit: (event) => events.push(event),
    ...overrides,
  };
  return { deps, events, saved, deleted, canceled };
}

const fastRetry = { retry: { baseBackoffMs: 1, maxRetries: 2 } };

beforeEach(() => {
  executeGeneration.mockReset();
  executeUpscale.mockReset();
});

describe("runGenerationTask", () => {
  it("saves each result and reports completion", async () => {
    executeGeneration.mockResolvedValue([result("one"), result("two")]);
    const { deps, events, saved } = makeDeps();

    await runGenerationTask(imageTask(), deps, fastRetry);

    expect(executeGeneration).toHaveBeenCalledTimes(1);
    const [params, apiKey] = executeGeneration.mock.calls[0];
    expect(apiKey).toBe("key");
    expect(params.referenceImages.map((r: { id: string }) => r.id)).toEqual(["ref-1"]);

    expect(saved.map((r) => r.id).sort()).toEqual(["a", "b"]);
    const record = saved.find((r) => r.id === "a")!;
    expect(record).toMatchObject({
      prompt: "a cat",
      modelId: "gemini-test",
      aspectRatio: "1:1",
      referenceImageIds: ["ref-1"],
      parentGalleryItemIds: ["parent-1"],
      characterIds: undefined,
      isFavorite: false,
      width: 64,
      height: 32,
    });
    expect(record.thumbnailBlob.type).toBe("image/webp");

    expect(events[0]).toEqual({
      type: "progress",
      itemIds: ["a", "b"],
      patch: { status: "generating" },
    });
    expect(events.filter((e) => e.type === "completed")).toHaveLength(2);
  });

  it("fails the items a batch didn't return", async () => {
    executeGeneration.mockResolvedValue([result("only")]);
    const { deps, events, saved } = makeDeps();

    await runGenerationTask(imageTask(), deps, fastRetry);

    expect(saved.map((r) => r.id)).toEqual(["a"]);
    expect(events).toContainEqual({
      type: "failed",
      itemIds: ["b"],
      error: "Model returned fewer images than requested",
      canRetry: true,
    });
  });

  it("waits out a rate limit, then retries", async () => {
    executeGeneration
      .mockRejectedValueOnce(new RateLimitError("Rate limited", 0))
      .mockResolvedValue([result("one")]);
    const { deps, events } = makeDeps();

    await runGenerationTask(imageTask({ itemIds: ["a"], numberOfImages: 1 }), deps, fastRetry);

    expect(executeGeneration).toHaveBeenCalledTimes(2);
    const statuses = events.flatMap((e) => (e.type === "progress" ? [e.patch.status] : [e.type]));
    expect(statuses).toEqual(["generating", "waiting", "generating", "completed"]);
  });

  it("reports a failure after the retries run out", async () => {
    executeGeneration.mockRejectedValue(new Error("boom"));
    const { deps, events } = makeDeps();

    await expect(runGenerationTask(imageTask(), deps, fastRetry)).rejects.toThrow("boom");

    expect(executeGeneration).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toEqual({
      type: "failed",
      itemIds: ["a", "b"],
      error: "boom",
      canRetry: true,
    });
  });

  it("only makes a missing key final when the task asks for it", async () => {
    const { deps, events } = makeDeps({ getApiKey: () => null });
    const noRetry = { useRetry: false };

    await expect(runGenerationTask(imageTask(), deps, noRetry)).rejects.toThrow(
      "No API key for google"
    );
    expect(events.at(-1)).toMatchObject({ type: "failed", canRetry: true });

    await expect(
      runGenerationTask(imageTask({ missingKeyIsFinal: true }), deps, noRetry)
    ).rejects.toThrow("No API key for google");
    expect(events.at(-1)).toMatchObject({ type: "failed", canRetry: false });
    expect(executeGeneration).not.toHaveBeenCalled();
  });

  it("deletes an image that was canceled while it was being saved", async () => {
    executeGeneration.mockResolvedValue([result("one")]);
    const harness = makeDeps();
    harness.deps.saveImage = async (record) => {
      harness.saved.push(record);
      harness.canceled.add(record.id);
    };

    await runGenerationTask(imageTask({ itemIds: ["a"], numberOfImages: 1 }), harness.deps);

    expect(harness.deleted).toEqual(["a"]);
    expect(harness.events.some((e) => e.type === "completed")).toBe(false);
  });

  it("does nothing for a task whose items were all canceled", async () => {
    const harness = makeDeps();
    harness.canceled.add("a").add("b");

    expect(await runGenerationTask(imageTask(), harness.deps)).toEqual([]);
    expect(executeGeneration).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
  });

  it("upscales the first reference and records its lineage", async () => {
    executeUpscale.mockResolvedValue(result("big"));
    const { deps, saved, events } = makeDeps();
    const task: UpscaleTask = {
      kind: "upscale",
      itemIds: ["u"],
      modelId: "real-esrgan-2x",
      modelName: "Real-ESRGAN 2x ↑",
      prompt: "Upscale with Real-ESRGAN 2x",
      referenceImageIds: ["src"],
      parentGalleryItemIds: ["parent"],
      upscaler: {
        id: "real-esrgan-2x",
        name: "Real-ESRGAN 2x",
        replicateId: "nightmareai/real-esrgan",
        scale: 2,
        scaleParam: "scale",
        enabled: true,
      },
    };

    await runGenerationTask(task, deps);

    expect(executeUpscale.mock.calls[0][2]).toBe("key");
    expect(saved[0].metadata).toEqual({
      upscaledFrom: "parent",
      upscaler: "real-esrgan-2x",
      upscaleLabel: "Real-ESRGAN 2x",
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", itemId: "u" });
  });

  it("doesn't retry upscales or offer a retry when they fail", async () => {
    executeUpscale.mockRejectedValue(new Error("upscale broke"));
    const { deps, events } = makeDeps();
    const task: UpscaleTask = {
      kind: "upscale",
      itemIds: ["u"],
      modelId: "x",
      modelName: "X",
      prompt: "Upscale",
      referenceImageIds: ["src"],
      upscaler: {
        id: "x",
        name: "X",
        replicateId: "o/m",
        scale: null,
        scaleParam: null,
        enabled: true,
      },
    };

    await expect(runGenerationTask(task, deps)).rejects.toThrow("upscale broke");
    expect(executeUpscale).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "failed", canRetry: false });
  });
});

describe("missing API keys", () => {
  it("fails without retrying", async () => {
    const { deps } = makeDeps({ getApiKey: () => undefined });
    await expect(
      runGenerationTask(imageTask(), deps, { retry: { baseBackoffMs: 1000, maxRetries: 3 } })
    ).rejects.toThrow("No API key for google");
  });
});
