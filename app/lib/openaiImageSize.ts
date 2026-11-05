import type { AspectRatio, Resolution } from "~/types";
import { findLibraryModel } from "./providers/modelLibrary";
import { OPENAI_IMAGE_MODELS } from "./providers/openaiModels";

// gpt-image-1 (and unknown OpenAI image models) accept only a fixed set of size strings.
const ASPECT_RATIO_TO_SIZE: Record<string, "1024x1024" | "1536x1024" | "1024x1536"> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
};

// gpt-image-2, 2.5, and 2.6 accept arbitrary WxH within these constraints.
const GPT_IMAGE_2_MAX_EDGE = 3840;
const GPT_IMAGE_2_MIN_PIXELS = 655_360;
const GPT_IMAGE_2_MAX_PIXELS = 8_294_400;
const GPT_IMAGE_2_MAX_LONG_SHORT_RATIO = 3;

// Target the shortest edge, then scale down to fit the model's limits.
const GPT_IMAGE_2_RESOLUTION_SHORT_EDGE: Record<Resolution, number> = {
  "1K": 1024,
  "2K": 2048,
  "4K": 4096,
};

// 16:9 / 9:16 use video presets; 1080 is snapped to 1072 for API alignment.
const GPT_IMAGE_2_VIDEO_SHORT_EDGE: Record<Resolution, number> = {
  "1K": 1152,
  "2K": 1440,
  "4K": 2160,
};

export function isGptImage2(modelId: string): boolean {
  return /(^|[-_/])gpt-image-2/.test(modelId.toLowerCase());
}

function usesArbitraryImageSize(modelId: string): boolean {
  const libraryModel = findLibraryModel(OPENAI_IMAGE_MODELS, modelId);
  return libraryModel ? libraryModel.config.sizeMode === "arbitrary" : isGptImage2(modelId);
}

// Snap downward to a multiple of 16 to stay within the model's pixel cap.
function snap16(value: number): number {
  return Math.max(16, Math.floor(value / 16) * 16);
}

function resolveGptImage2Size(
  aspectRatio: AspectRatio,
  resolution: Resolution | null
): string | null {
  const [wStr, hStr] = aspectRatio.split(":");
  const wRatio = Number(wStr);
  const hRatio = Number(hStr);
  if (!Number.isFinite(wRatio) || !Number.isFinite(hRatio) || wRatio <= 0 || hRatio <= 0) {
    return null;
  }

  const longShort = Math.max(wRatio, hRatio) / Math.min(wRatio, hRatio);
  if (longShort > GPT_IMAGE_2_MAX_LONG_SHORT_RATIO) return null;

  const targets =
    longShort === 16 / 9 ? GPT_IMAGE_2_VIDEO_SHORT_EDGE : GPT_IMAGE_2_RESOLUTION_SHORT_EDGE;
  const target = targets[resolution ?? "1K"];
  const w = (target * wRatio) / Math.min(wRatio, hRatio);
  const h = (target * hRatio) / Math.min(wRatio, hRatio);
  const scale = Math.min(
    1,
    GPT_IMAGE_2_MAX_EDGE / Math.max(w, h),
    Math.sqrt(GPT_IMAGE_2_MAX_PIXELS / (w * h))
  );

  const width = snap16(w * scale);
  const height = snap16(h * scale);
  const pixels = width * height;

  if (
    width > GPT_IMAGE_2_MAX_EDGE ||
    height > GPT_IMAGE_2_MAX_EDGE ||
    pixels < GPT_IMAGE_2_MIN_PIXELS ||
    pixels > GPT_IMAGE_2_MAX_PIXELS
  ) {
    return null;
  }

  return `${width}x${height}`;
}

export function resolveOpenAIImageSize(
  modelId: string,
  aspectRatio: AspectRatio | null,
  resolution: Resolution | null
): string {
  if (!aspectRatio) return "auto";
  if (usesArbitraryImageSize(modelId)) {
    return resolveGptImage2Size(aspectRatio, resolution) ?? "auto";
  }
  return ASPECT_RATIO_TO_SIZE[aspectRatio] ?? "auto";
}

export function getOpenAIImagePixelCount(
  modelId: string,
  aspectRatio: AspectRatio | null,
  resolution: Resolution | null
): number | null {
  const [width, height] = resolveOpenAIImageSize(modelId, aspectRatio, resolution)
    .split("x")
    .map(Number);
  const pixels = width * height;
  return Number.isFinite(pixels) && pixels > 0 ? pixels : null;
}
