import { parseAspectRatio } from "~/lib/models";
import type { GenerationParams, GenerationResult } from "~/lib/generation";
import { getPlatform } from "~/lib/platform";
import type { AspectRatio, Resolution } from "~/types";
import type { Provider, ResolvedImageModel, SearchResult } from "./types";
import { DEFAULT_IMAGE_CAPABILITIES } from "../builtInModels";
import { inferName } from "../modelNames";
import { normalizeModelId } from ".";

type Deferred = {
  resolve: (r: GenerationResult) => void;
  reject: (e: Error) => void;
  promise: Promise<GenerationResult>;
};
const manualDeferred = new Map<string, Deferred>();

function getOrCreateDeferred(itemId: string): Deferred {
  if (!manualDeferred.has(itemId)) {
    let resolve!: (r: GenerationResult) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<GenerationResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    manualDeferred.set(itemId, { resolve, reject, promise });
  }
  return manualDeferred.get(itemId)!;
}

export function resolveManualItem(itemId: string, result: GenerationResult): void {
  manualDeferred.get(itemId)?.resolve(result);
  manualDeferred.delete(itemId);
}

export function rejectManualItem(itemId: string): void {
  manualDeferred.get(itemId)?.reject(new Error("Dismissed"));
  manualDeferred.delete(itemId);
}

const DEBUG_RESOLUTION_WIDTH: Record<Resolution, number> = {
  "1K": 1024,
  "2K": 2048,
  "4K": 4096,
};

function getDebugDimensions(
  aspectRatio: AspectRatio | null,
  resolution: Resolution | null
): { width: number; height: number } {
  const { width: ratioWidth, height: ratioHeight } = parseAspectRatio(aspectRatio ?? "1:1");
  const baseWidth = resolution ? DEBUG_RESOLUTION_WIDTH[resolution] : 1024;
  const computedHeight = Math.round((baseWidth * ratioHeight) / ratioWidth);

  return {
    width: Math.max(1, baseWidth),
    height: Math.max(1, computedHeight),
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generatePicsumImage(
  params: GenerationParams,
  sleepBase: number = 7000
): Promise<GenerationResult[]> {
  const { width, height } = getDebugDimensions(params.aspectRatio, params.resolution);
  const n = Math.max(1, params.numberOfImages);
  const results: GenerationResult[] = [];

  for (let i = 0; i < n; i++) {
    // "finish generating" at a random time between sleepBase and sleepBase * 1.3
    await sleep(Math.floor(Math.random() * 0.3 + 1) * sleepBase);
    // Append a cache-busting seed so each request in the batch yields a different photo.
    const seed = Math.floor(Math.random() * 1_000_000);
    const url = `https://picsum.photos/seed/${seed}/${width}/${height}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`picsum fetch failed: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    const dimensions = await getPlatform().getImageDimensions(blob);

    results.push({
      blob,
      width: dimensions.width,
      height: dimensions.height,
      metadata: {
        debug: true,
        picsum: true,
        picsumSeed: seed,
        generatedAt: new Date().toISOString(),
        batchIndex: i,
      },
    });
  }

  return results;
}

async function generateCanvasImage(params: GenerationParams): Promise<GenerationResult[]> {
  const { width, height } = getDebugDimensions(params.aspectRatio, params.resolution);
  const results: GenerationResult[] = [];
  const n = Math.max(1, params.numberOfImages);

  for (let i = 0; i < n; i++) {
    await sleep(350);

    const blob = await getPlatform().renderDebugImage({
      width,
      height,
      headline: n > 1 ? `DEBUG ${i + 1}/${n}` : "DEBUG",
      detail: params.modelId,
      caption: params.prompt.trim().slice(0, 80) || "No prompt",
    });
    const dimensions = await getPlatform().getImageDimensions(blob);

    results.push({
      blob,
      width: dimensions.width,
      height: dimensions.height,
      metadata: {
        debug: true,
        generatedAt: new Date().toISOString(),
        referenceImageCount: params.referenceImages.length,
        batchIndex: i,
      },
    });
  }

  return results;
}

async function generateImage(params: GenerationParams): Promise<GenerationResult[]> {
  const modelId = normalizeModelId(params.modelId, "debug");

  switch (modelId) {
    case "picsum":
      return generatePicsumImage(params, 7000);
    case "slow":
      return generatePicsumImage(params, 10 * 1000 * 60);
    case "manual":
      const ids = params.itemIds ?? [];
      return Promise.all(ids.map((id) => getOrCreateDeferred(id).promise));
    case "debug-model":
      return generateCanvasImage(params);
    default:
      throw new Error(`Unknown model: ${modelId}`);
  }
}

async function searchModels(query: string, apiKey: string): Promise<SearchResult[]> {
  return [
    {
      id: "debug-model",
      name: "Debug Model",
      description: "Generates basic placeholder images in the browser.",
      icon: "/icons/box.svg",
    },
    {
      id: "picsum",
      name: "Picsum Photos",
      description: "Fetches random placeholder photos from picsum.photos.",
      icon: "/icons/box.svg",
    },
    {
      id: "slow",
      name: "Slow",
      description: "Waits 10 minutes to fetch an image from picsum.photos.",
      icon: "/icons/box.svg",
    },
    {
      id: "manual",
      name: "Manual Upload",
      description: "Prompts you to upload an image instead of generating one.",
      icon: "/icons/box.svg",
    },
  ];
}

async function resolveImageModel(
  modelId: string,
  apiKey: string,
  onProgress?: (status: string) => void
): Promise<ResolvedImageModel> {
  if (modelId === "manual") {
    return {
      name: "Manual Upload",
      capabilities: {
        supportsAspectRatios: false,
        supportsResolution: false,
        supportsReferenceImages: true,
        maxReferenceImages: 10,
      },
      icon: "/icons/box.svg",
    };
  }
  return {
    name: inferName(modelId),
    capabilities: DEFAULT_IMAGE_CAPABILITIES,
    icon: "/icons/box.svg",
  };
}

export const debugProvider: Provider = {
  id: "debug",
  label: "Debug",
  iconPath: "/icons/box.svg",
  requiresApiKey: false,
  capabilities: {
    image: true,
    text: false,
    upscale: false,
    searchImage: true,
    searchText: false,
    searchUpscale: false,
  },
  generateImage,
  searchImageModels: searchModels,
  resolveImageModel,
};
