import OpenAI, { toFile } from "openai";
import { distance } from "fastest-levenshtein";
import type { GenerationParams, GenerationResult } from "~/lib/generation";
import { getImageDimensions } from "~/lib/imageProcessing";
import { logger } from "~/lib/logging";
import { toRateLimitError } from "~/lib/retry";
import { blobToBase64 } from "~/lib/util";
import { isGptImage2, resolveOpenAIImageSize } from "~/lib/openaiImageSize";
import {
  findLibraryModel,
  mergeSearchResults,
  resolveLibraryModel,
  searchModelLibrary,
} from "./modelLibrary";
import { OPENAI_IMAGE_MODELS } from "./openaiModels";
import type { Provider, ResolvedImageModel, SearchResult, TextGenerationArgs } from "./types";
import { inferName } from "../modelNames";
import { normalizeModelId } from ".";

function openaiBaseUrl(): string {
  return new URL("/proxy/openai/v1", window.location.origin).toString();
}

function createClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: openaiBaseUrl(),
    dangerouslyAllowBrowser: true,
  });
}

function decodeBase64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

type OutputFormat = "png" | "jpeg" | "webp" | "gif" | "svg";

const MIME_TYPES: Record<OutputFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

/**
 * Request fields the SDK doesn't type yet (GPT Image 2.6). The SDK forwards unknown
 * body fields as-is, so these are spread in after the typed fields.
 */
function untypedImageFields(
  params: GenerationParams,
  outputFormat: OutputFormat
): Record<string, unknown> {
  const options = params.modelOptions ?? {};
  return {
    ...(typeof options.complexity === "string" ? { complexity: options.complexity } : {}),
    ...(outputFormat === "gif"
      ? {
          ...(typeof options.gifFrameCount === "number"
            ? { frame_count: options.gifFrameCount }
            : {}),
          ...(typeof options.gifFrameDurationMs === "number"
            ? { frame_duration_ms: options.gifFrameDurationMs }
            : {}),
        }
      : {}),
  };
}

async function generateImage(
  params: GenerationParams,
  apiKey?: string
): Promise<GenerationResult[]> {
  if (!apiKey) throw new Error("No API key for openai");
  const client = createClient(apiKey);
  const modelId = normalizeModelId(params.modelId, "openai");

  const size = resolveOpenAIImageSize(modelId, params.aspectRatio, params.resolution);
  const isEdit = params.referenceImages.length > 0;
  // SVG and GIF are generations-only; option resolution already drops them when references
  // are attached, but never send them to the edits endpoint.
  const requestedFormat = params.modelOptions?.outputFormat;
  const outputFormat: OutputFormat =
    !isEdit && (requestedFormat === "svg" || requestedFormat === "gif") ? requestedFormat : "png";
  // The API requires n = 1 for SVG.
  const n = outputFormat === "svg" ? 1 : Math.max(1, params.numberOfImages);
  const untypedFields = untypedImageFields(params, outputFormat);
  // The SDK types `output_format` as raster-only.
  const outputFormatParam = outputFormat as "png";
  const quality = (params.quality ?? undefined) as OpenAI.ImageEditParams["quality"];

  // The SDK's `size` is typed as a closed union of the docs' popular strings, but
  // gpt-image-2 accepts any WxH within its constraints. Cast through `as never` so
  // the runtime forwards arbitrary computed sizes (e.g. "3840x2160", "2480x3312").
  const sizeParam = size as never;

  try {
    if (isEdit) {
      const files = await Promise.all(
        params.referenceImages.map((ref, index) =>
          toFile(ref.blob, `reference-${index}.${ref.blob.type.split("/")[1] || "png"}`, {
            type: ref.blob.type || "image/png",
          })
        )
      );

      const request = {
        model: modelId,
        image: files,
        prompt: params.prompt,
        n,
        size: sizeParam,
        ...(quality ? { quality } : {}),
        output_format: outputFormatParam,
        ...untypedFields,
      };
      logger.debug("[image-generation] Raw API request", { provider: "openai", request });
      const response = await client.images.edit(request);
      logger.debug("[image-generation] Raw API response", { provider: "openai", response });

      return parseResponse(response, outputFormat, modelId);
    }

    const request = {
      model: modelId,
      prompt: params.prompt,
      n,
      size: sizeParam,
      ...(quality ? { quality } : {}),
      output_format: outputFormatParam,
      ...untypedFields,
    };
    logger.debug("[image-generation] Raw API request", { provider: "openai", request });
    const response = await client.images.generate(request);
    logger.debug("[image-generation] Raw API response", { provider: "openai", response });

    return parseResponse(response, outputFormat, modelId);
  } catch (error) {
    throw toRateLimitError(error, "openai");
  }
}

async function parseResponse(
  response: { data?: Array<{ b64_json?: string | null; url?: string | null }> | null; usage?: any },
  outputFormat: OutputFormat,
  modelId: string
): Promise<GenerationResult[]> {
  const entries = response.data ?? [];
  if (entries.length === 0) throw new Error("No image in OpenAI response");

  const mimeType = MIME_TYPES[outputFormat];
  const usage = response.usage;

  return Promise.all(
    entries.map(async (entry) => {
      let blob: Blob;
      if (entry.b64_json) {
        blob = decodeBase64ToBlob(entry.b64_json, mimeType);
      } else if (entry.url) {
        const res = await fetch(entry.url);
        if (!res.ok) throw new Error(`Failed to fetch generated image: ${res.status}`);
        blob = await res.blob();
      } else {
        throw new Error("Empty image entry in OpenAI response");
      }

      const dimensions = await getImageDimensions(blob);
      return {
        blob,
        width: dimensions.width,
        height: dimensions.height,
        metadata: { modelId },
        usage: usage
          ? {
              allocationDivisor: entries.length,
              metrics: {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                textInputTokens: usage.input_tokens_details?.text_tokens,
                imageInputTokens: usage.input_tokens_details?.image_tokens,
                imageOutputTokens: usage.output_tokens_details?.image_tokens,
              },
            }
          : undefined,
      };
    })
  );
}

interface OpenAIModel {
  id: string;
  owned_by?: string;
}

export function inferOpenAiImageCapabilities(modelId: string): ResolvedImageModel["capabilities"] {
  const libraryModel = resolveLibraryModel(OPENAI_IMAGE_MODELS, modelId);
  if (libraryModel) return libraryModel.capabilities;

  const lower = normalizeModelId(modelId, "openai").toLowerCase();
  const isGptImage = /(^|[-_])gpt-image/.test(lower);

  if (!isGptImage) {
    return {
      supportsAspectRatios: true,
      supportedAspectRatios: ["1:1"],
      supportsResolution: false,
      supportsReferenceImages: false,
      maxReferenceImages: 1,
      supportsQuality: false,
      supportsNumberOfImages: false,
      maxImagesPerRequest: 1,
    };
  }

  // gpt-image-2 accepts any AR within constraints (resolved at call time);
  // older gpt-image models accept the fixed 3-size enum.
  if (isGptImage2(lower)) {
    return {
      supportsAspectRatios: true,
      supportedAspectRatios: [],
      allowsArbitraryAspectRatio: true,
      maxLongShortRatio: 3,
      supportsResolution: true,
      supportsReferenceImages: true,
      maxReferenceImages: 16,
      supportsQuality: true,
      supportedQualities: ["low", "medium", "high"],
      supportsNumberOfImages: true,
      maxImagesPerRequest: 10,
    };
  }

  return {
    supportsAspectRatios: true,
    supportedAspectRatios: ["1:1", "3:2", "2:3"],
    supportsResolution: false,
    supportsReferenceImages: true,
    maxReferenceImages: 16,
    supportsQuality: true,
    supportedQualities: ["low", "medium", "high"],
    supportsNumberOfImages: true,
    maxImagesPerRequest: 10,
  };
}

async function resolveImageModel(
  modelId: string,
  apiKey: string,
  onProgress?: (status: string) => void
): Promise<ResolvedImageModel> {
  const libraryModel = resolveLibraryModel(OPENAI_IMAGE_MODELS, modelId);
  if (libraryModel) {
    onProgress?.("Using model library...");
    return libraryModel;
  }

  const client = createClient(apiKey);
  const normalizedId = normalizeModelId(modelId, "openai");

  onProgress?.("Looking up model...");

  let found: OpenAIModel | null = null;
  try {
    const retrieved = await client.models.retrieve(normalizedId);
    found = { id: retrieved.id, owned_by: (retrieved as { owned_by?: string }).owned_by };
  } catch {
    try {
      const listed = await client.models.list();
      found =
        (listed.data as OpenAIModel[]).find(
          (m) => m.id.toLowerCase() === normalizedId.toLowerCase()
        ) ?? null;
    } catch {
      found = null;
    }
  }

  if (!found) {
    throw new Error(`Model not found: ${normalizedId}`);
  }
  if (!isImageModel(found)) {
    throw new Error(`Model is not an image generation model: ${normalizedId}`);
  }

  onProgress?.("Analyzing capabilities...");
  return {
    name: inferName(found.id),
    capabilities: inferOpenAiImageCapabilities(found.id),
    icon: "/icons/openai.svg",
  };
}

function isImageModel(model: OpenAIModel): boolean {
  const id = model.id.toLowerCase();
  // Keep image search focused on generation/edit models users can add.
  return /(^|[-_])(gpt-image|image|dall-e)/.test(id);
}

function toSearchResult(model: OpenAIModel): SearchResult {
  return {
    id: model.id,
    name: inferName(model.id),
    description: model.owned_by ? `Owner: ${model.owned_by}` : "OpenAI image model",
    icon: "/icons/openai.svg",
  };
}

async function searchImageModels(query: string, apiKey: string): Promise<SearchResult[]> {
  const libraryResults = searchModelLibrary(OPENAI_IMAGE_MODELS, query);
  const client = createClient(apiKey);

  let models: OpenAIModel[] = [];
  try {
    const response = await client.models.list();
    models = response.data as OpenAIModel[];
  } catch {
    return libraryResults;
  }

  const q = query.trim().toLowerCase();
  const imageModels = models.filter(isImageModel);

  if (!q) {
    return mergeSearchResults(libraryResults, imageModels.slice(0, 6).map(toSearchResult));
  }

  const ranked = imageModels
    .map((model) => {
      const id = model.id.toLowerCase();
      const containsBoost = id.includes(q) ? -1000 : 0;
      const score = distance(q, id) + containsBoost;
      return { model, score };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 6)
    .map(({ model }) => toSearchResult(model));

  return mergeSearchResults(libraryResults, ranked);
}

type ResponseInputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" | "low" | "high" };

async function generateText(args: TextGenerationArgs, apiKey: string): Promise<string> {
  let { userPrompt } = args;
  const { systemPrompt, images, prefill } = args;
  const modelId = normalizeModelId(args.modelId, "openai");
  const client = createClient(apiKey);

  // OpenAI models don't reliably continue from a partial assistant turn the way
  // Gemini does — they treat assistant input as completed history. Fall back to
  // the Replicate strategy of folding the prefill into the user prompt.
  if (prefill) {
    userPrompt = userPrompt + "\n\n" + prefill;
  }

  const content: ResponseInputContent[] = [{ type: "input_text", text: userPrompt }];

  if (images?.length) {
    for (const blob of images) {
      const dataUrl = await blobToBase64(blob);
      content.push({ type: "input_image", image_url: dataUrl, detail: "auto" });
    }
  }

  let response;
  try {
    response = await client.responses.create({
      model: modelId,
      instructions: systemPrompt,
      input: [{ role: "user", content }],
    });
  } catch (error) {
    throw toRateLimitError(error, "openai");
  }

  const text = response.output_text;
  if (!text) {
    throw new Error("No text in response");
  }

  if (prefill) {
    return prefill + text;
  }
  return text;
}

async function testTextModel(apiKey: string, modelId: string): Promise<void> {
  await generateText(
    {
      modelId,
      systemPrompt: "You are a connectivity test.",
      userPrompt: "Respond with the single word 'hi' and nothing else.",
    },
    apiKey
  );
}

// OpenAI's /v1/models endpoint doesn't expose per-capability flags, so we filter
// by naming convention. The goal is to allow general-purpose chat/reasoning
// models and exclude specialized non-text endpoints (images, embeddings, audio,
// transcription, TTS, realtime, moderation).
function isTextModel(model: OpenAIModel): boolean {
  const id = model.id.toLowerCase();
  if (/(^|[-_])(gpt-image|dall-e)/.test(id)) return false;
  if (/(^|[-_])embedding/.test(id)) return false;
  if (/(^|[-_])(whisper|tts|transcribe|audio|realtime|moderation)/.test(id)) return false;
  // Specialized variants that don't use the standard Responses interface cleanly.
  if (/(^|[-_])(search-preview|computer-use|deep-research)/.test(id)) return false;
  // Allow generic gpt-*, chatgpt-*, codex-*, and reasoning models (o1/o3/o4 plus
  // any future o<N>* family). Tolerate "*-mini", "*-pro", "*-nano", date suffixes.
  return /^(gpt-|chatgpt-|codex-|o\d)/.test(id);
}

function toTextSearchResult(model: OpenAIModel): SearchResult {
  return {
    id: model.id,
    name: inferName(model.id),
    description: model.owned_by ? `Owner: ${model.owned_by}` : "OpenAI text model",
    icon: "/icons/openai.svg",
  };
}

async function searchTextModels(query: string, apiKey: string): Promise<SearchResult[]> {
  const client = createClient(apiKey);

  let models: OpenAIModel[] = [];
  try {
    const response = await client.models.list();
    models = response.data as OpenAIModel[];
  } catch {
    return [];
  }

  const textModels = models.filter(isTextModel);
  const q = query.trim().toLowerCase();

  if (!q) {
    return textModels.slice(0, 6).map(toTextSearchResult);
  }

  return textModels
    .map((model) => {
      const id = model.id.toLowerCase();
      const containsBoost = id.includes(q) ? -1000 : 0;
      const score = distance(q, id) + containsBoost;
      return { model, score };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 6)
    .map(({ model }) => toTextSearchResult(model));
}

export const openaiProvider: Provider = {
  id: "openai",
  label: "OpenAI",
  iconPath: "/icons/openai.svg",
  requiresApiKey: true,
  supportsTextPrefill: false,
  capabilities: {
    image: true,
    text: true,
    upscale: false,
    searchImage: true,
    searchText: true,
    searchUpscale: false,
  },
  generateImage,
  generateText,
  testTextModel,
  searchImageModels,
  searchTextModels,
  resolveImageModel,
};
