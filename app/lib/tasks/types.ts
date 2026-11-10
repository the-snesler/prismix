import type {
  AspectRatio,
  ImageRecord,
  ModelCapabilities,
  ModelOptionValues,
  Provider,
  Resolution,
  SchemaMapping,
  StoredImageRecord,
  StoredUpscaler,
} from "~/types";

interface BaseTask {
  /** Gallery item IDs this task produces. Length 1 for single-image models and upscales,
   *  greater for batch-capable models called with numberOfImages > 1. */
  itemIds: string[];
  modelId: string;
  modelName: string;
  prompt: string;
  basePrompt?: string;
  /** IDs in the references store, in the order they are sent to the model. Every ID
   *  must be saved before the task runs. */
  referenceImageIds: string[];
  /** Gallery items the references were derived from. */
  parentGalleryItemIds?: string[];
}

/**
 * A fully resolved image generation: the final prompt after improvement, variations,
 * style and character text, and the final references after precedence rules.
 * Serializable, so it can be sent to a server and stored for retries.
 */
export interface ImageGenerationTask extends BaseTask {
  kind: "image";
  provider: Provider;
  variationReplacements?: string[];
  aspectRatio: AspectRatio | null;
  resolution: Resolution | null;
  quality: string | null;
  /** Resolved model-specific options (see `lib/modelOptions.ts`). */
  modelOptions?: ModelOptionValues;
  numberOfImages: number;
  /** Snapshot of the model's capabilities and schema mapping at submit time. */
  capabilities?: ModelCapabilities;
  schemaMapping?: SchemaMapping;
  characterIds?: string[];
  /** Only set when the style still exists. */
  styleId?: string;
  manualReferenceImageIds?: string[];
  /** When true, a missing API key fails the items without offering a retry. */
  missingKeyIsFinal?: boolean;
}

export interface UpscaleTask extends BaseTask {
  kind: "upscale";
  upscaler: StoredUpscaler;
}

export type GenerationTask = ImageGenerationTask | UpscaleTask;

/** Fields a pending card shows while its task runs. */
export type TaskProgressPatch =
  | { status: "generating"; retryCount?: number }
  | { status: "waiting"; retryCount: number; waitingUntil: number; retryAfter: number };

export type TaskEvent =
  | { type: "progress"; itemIds: string[]; patch: TaskProgressPatch }
  | {
      type: "completed";
      itemId: string;
      record: ImageRecord;
      original: Blob;
      thumbnail: Blob;
    }
  | { type: "failed"; itemIds: string[]; error: string; canRetry: boolean };

/** Everything the runner needs from its environment (browser or server). */
export interface TaskRunnerDeps {
  getApiKey(provider: Provider): string | null | undefined;
  /** Load reference bytes in the given order. Missing IDs may be skipped. */
  loadReferences(ids: string[]): Promise<Array<{ id: string; blob: Blob }>>;
  createThumbnail(original: Blob): Promise<Blob>;
  saveImage(record: StoredImageRecord): Promise<void>;
  deleteImage(id: string): Promise<void>;
  isCanceled(itemId: string): boolean;
  emit(event: TaskEvent): void;
}
