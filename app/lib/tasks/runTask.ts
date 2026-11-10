import { executeGeneration, type GenerationResult } from "~/lib/generation";
import { providerRequiresApiKey } from "~/lib/providers";
import { retryWithBackoff, type RetryOptions } from "~/lib/retry";
import { executeUpscale } from "~/lib/upscaling";
import type { ImageRecord, ModelOptionValues } from "~/types";
import type {
  GenerationTask,
  ImageGenerationTask,
  TaskProgressPatch,
  TaskRunnerDeps,
  UpscaleTask,
} from "./types";

export interface RunTaskOptions {
  /** Retry with backoff and wait out rate limits. Default true for image tasks. */
  useRetry?: boolean;
  /** Overrides for tests. */
  retry?: Pick<RetryOptions, "maxRetries" | "baseBackoffMs">;
}

const MISSING_KEY_PREFIX = "No API key for ";

export class MissingApiKeyError extends Error {
  constructor(provider: string) {
    super(`${MISSING_KEY_PREFIX}${provider}`);
    this.name = "MissingApiKeyError";
  }
}

const hasOptions = (options: ModelOptionValues | undefined): options is ModelOptionValues =>
  !!options && Object.keys(options).length > 0;

/**
 * Run one generation task end to end: call the provider (with retries), save each
 * result with its thumbnail, and report progress through `deps.emit`. Shared by the
 * browser's local backend and the server's job runner, so it must not touch the DOM
 * or any store.
 *
 * Resolves with the provider results. On failure it emits `failed` for the items
 * that are still active, then rethrows.
 */
export async function runGenerationTask(
  task: GenerationTask,
  deps: TaskRunnerDeps,
  options: RunTaskOptions = {}
): Promise<GenerationResult[]> {
  const activeIds = () => task.itemIds.filter((id) => !deps.isCanceled(id));
  const isCanceled = () => activeIds().length === 0;
  const emitProgress = (patch: TaskProgressPatch) => {
    const itemIds = activeIds();
    if (itemIds.length > 0) deps.emit({ type: "progress", itemIds, patch });
  };

  if (isCanceled()) return [];
  emitProgress({ status: "generating" });

  try {
    const startTime = Date.now();
    const call = () => executeTask(task, deps);
    const useRetry = options.useRetry ?? task.kind === "image";
    const results = useRetry
      ? await retryWithBackoff(call, {
          ...options.retry,
          shouldContinue: () => !isCanceled(),
          // A missing key won't appear between attempts.
          shouldRetry: (error) => !(error instanceof MissingApiKeyError),
          onWaiting: ({ retryCount, waitMs, waitingUntil }) =>
            emitProgress({
              status: "waiting",
              retryCount,
              waitingUntil,
              retryAfter: Math.ceil(waitMs / 1000),
            }),
          onRetrying: ({ retryCount }) => emitProgress({ status: "generating", retryCount }),
        })
      : await call();
    if (isCanceled()) return results;
    await completeTask(task, results, Date.now() - startTime, deps);
    return results;
  } catch (error) {
    const itemIds = activeIds();
    if (itemIds.length === 0) return [];
    deps.emit({
      type: "failed",
      itemIds,
      error: error instanceof Error ? error.message : "Generation failed",
      canRetry: canRetry(task, error),
    });
    throw error;
  }
}

function canRetry(task: GenerationTask, error: unknown): boolean {
  if (task.kind === "upscale") return false;
  return !(task.missingKeyIsFinal && error instanceof MissingApiKeyError);
}

async function executeTask(
  task: GenerationTask,
  deps: TaskRunnerDeps
): Promise<GenerationResult[]> {
  const provider = task.kind === "upscale" ? "replicate" : task.provider;
  const apiKey = deps.getApiKey(provider) || undefined;
  if (providerRequiresApiKey(provider) && !apiKey) throw new MissingApiKeyError(provider);

  const references = await deps.loadReferences(task.referenceImageIds);

  if (task.kind === "upscale") {
    const source = references[0];
    if (!source) throw new Error("Source image not found");
    return [await executeUpscale(source.blob, task.upscaler, apiKey!)];
  }

  return executeGeneration(
    {
      modelId: task.modelId,
      provider: task.provider,
      prompt: task.prompt,
      aspectRatio: task.aspectRatio,
      resolution: task.resolution,
      quality: task.quality,
      modelOptions: task.modelOptions,
      numberOfImages: task.numberOfImages,
      referenceImages: references,
      itemIds: task.itemIds,
      capabilities: task.capabilities,
      schemaMapping: task.schemaMapping,
    },
    apiKey
  );
}

/** The saved record for one result. Exported for tests. */
export function buildImageRecord(
  task: GenerationTask,
  itemId: string,
  result: GenerationResult,
  createdAt: number,
  generationTimeMs: number
): ImageRecord {
  const base: ImageRecord = {
    id: itemId,
    prompt: task.prompt,
    basePrompt: task.basePrompt,
    modelId: task.modelId,
    modelName: task.modelName,
    aspectRatio: null,
    resolution: null,
    width: result.width,
    height: result.height,
    createdAt,
    referenceImageIds: task.referenceImageIds,
    isFavorite: false,
    parentGalleryItemIds: task.parentGalleryItemIds?.length ? task.parentGalleryItemIds : undefined,
    metadata: result.metadata,
  };

  if (task.kind === "upscale") {
    return {
      ...base,
      metadata: {
        upscaledFrom: task.parentGalleryItemIds?.[0],
        upscaler: task.upscaler.id,
        upscaleLabel: task.upscaler.name,
      },
    };
  }

  return {
    ...base,
    variationReplacements: task.variationReplacements,
    aspectRatio: task.aspectRatio,
    resolution: task.resolution,
    quality: task.quality,
    modelOptions: hasOptions(task.modelOptions) ? task.modelOptions : undefined,
    generationTimeMs,
    characterIds: task.characterIds?.length ? task.characterIds : undefined,
    styleId: task.styleId,
    manualReferenceImageIds: task.manualReferenceImageIds,
    usage: result.usage,
    costEstimate: result.costEstimate,
  };
}

/** Pair each expected item ID with a result; fail the extras if fewer results arrived. */
async function completeTask(
  task: GenerationTask,
  results: GenerationResult[],
  generationTimeMs: number,
  deps: TaskRunnerDeps
): Promise<void> {
  const createdAt = Date.now();

  await Promise.all(
    task.itemIds.map(async (itemId, index) => {
      if (deps.isCanceled(itemId)) return;

      const result = results[index];
      if (!result) {
        deps.emit({
          type: "failed",
          itemIds: [itemId],
          error: "Model returned fewer images than requested",
          canRetry: true,
        });
        return;
      }

      const thumbnail = await deps.createThumbnail(result.blob);
      if (deps.isCanceled(itemId)) return;

      const record = buildImageRecord(task, itemId, result, createdAt, generationTimeMs);
      await deps.saveImage({ ...record, originalBlob: result.blob, thumbnailBlob: thumbnail });
      if (deps.isCanceled(itemId)) {
        await deps.deleteImage(itemId);
        return;
      }

      deps.emit({ type: "completed", itemId, record, original: result.blob, thumbnail });
    })
  );
}

export type { ImageGenerationTask, UpscaleTask };
