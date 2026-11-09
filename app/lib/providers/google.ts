import { GoogleGenAI, ThinkingLevel, type Model } from "@google/genai";
import { distance } from "fastest-levenshtein";
import type { GenerationParams, GenerationResult } from "~/lib/generation";
import { getPlatform } from "~/lib/platform";
import { logger } from "~/lib/logging";
import { inferName } from "~/lib/modelNames";
import { toRateLimitError } from "~/lib/retry";
import { base64ToBlob, blobToBase64 } from "~/lib/util";
import { GOOGLE_IMAGE_MODELS } from "./googleModels";
import { mergeSearchResults, resolveLibraryModel, searchModelLibrary } from "./modelLibrary";
import type { Provider, ResolvedImageModel, SearchResult, TextGenerationArgs } from "./types";
import { normalizeModelId } from ".";

async function generateImage(
  params: GenerationParams,
  apiKey?: string
): Promise<GenerationResult[]> {
  if (!apiKey) throw new Error("No API key for google");
  const ai = new GoogleGenAI({ apiKey });

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  const modelId = normalizeModelId(params.modelId, "google");

  for (const ref of params.referenceImages) {
    const base64 = await blobToBase64(ref.blob);
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: base64.split(",")[1],
      },
    });
  }
  parts.push({ text: params.prompt });

  const config = {
    responseModalities: ["IMAGE"],
    ...(params.aspectRatio || params.resolution
      ? {
          imageConfig: {
            ...(params.aspectRatio && { aspectRatio: params.aspectRatio }),
            ...(params.resolution && { imageSize: params.resolution }),
          },
        }
      : {}),
  };

  const request = {
    model: modelId,
    config,
    contents: [{ role: "user" as const, parts }],
  };
  logger.debug("[image-generation] Raw API request", { provider: "google", request });

  let response;
  try {
    response = await ai.models.generateContentStream(request);
  } catch (error) {
    throw toRateLimitError(error, "google");
  }

  let imageBlob: Blob | null = null;
  let modelVersion: string | undefined;
  let usageMetadata: any;

  for await (const chunk of response) {
    logger.debug("[image-generation] Raw API response", { provider: "google", response: chunk });
    if (!chunk.candidates?.[0]?.content?.parts) continue;
    const inlineData = chunk.candidates[0].content.parts[0]?.inlineData;
    if (inlineData?.data && inlineData?.mimeType) {
      imageBlob = base64ToBlob(inlineData.data, inlineData.mimeType);
    }
    if (chunk.modelVersion) modelVersion = chunk.modelVersion;
    if ((chunk as any).usageMetadata) usageMetadata = (chunk as any).usageMetadata;
  }

  if (!imageBlob) throw new Error("No image in response");
  const dimensions = await getPlatform().getImageDimensions(imageBlob);

  return [
    {
      blob: imageBlob,
      width: dimensions.width,
      height: dimensions.height,
      metadata: { modelVersion },
      usage: usageMetadata
        ? (() => {
            const details = usageMetadata.candidatesTokensDetails ?? [];
            const imageTokens = details.find(
              (detail: any) => detail.modality === "IMAGE"
            )?.tokenCount;
            const textTokens = details.find(
              (detail: any) => detail.modality === "TEXT"
            )?.tokenCount;
            return {
              metrics: {
                inputTokens: usageMetadata.promptTokenCount,
                textOutputTokens: (textTokens ?? 0) + (usageMetadata.thoughtsTokenCount ?? 0),
                imageOutputTokens:
                  imageTokens ??
                  (details.length === 0 ? usageMetadata.candidatesTokenCount : undefined),
              },
            };
          })()
        : undefined,
    },
  ];
}

async function generateText(args: TextGenerationArgs, apiKey: string): Promise<string> {
  const { systemPrompt, userPrompt, images, prefill } = args;
  const modelId = normalizeModelId(args.modelId, "google");
  const ai = new GoogleGenAI({ apiKey });

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  if (images?.length) {
    for (const blob of images) {
      const base64 = await blobToBase64(blob);
      parts.push({
        inlineData: {
          mimeType: blob.type || "image/png",
          data: base64.split(",")[1],
        },
      });
    }
  }

  parts.push({ text: userPrompt });

  const contents: Array<{
    role: "user" | "model";
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
  }> = [{ role: "user", parts }];

  if (prefill) {
    contents.push({ role: "model", parts: [{ text: prefill }] });
  }

  let response;
  try {
    response = await ai.models.generateContent({
      model: modelId,
      config: {
        systemInstruction: systemPrompt,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.LOW,
        },
      },
      contents,
    });
  } catch (error) {
    throw toRateLimitError(error, "google");
  }

  const text = response.text;
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

const MAX_LIST_PAGES = 5;

async function listGeminiModels(apiKey: string): Promise<Model[]> {
  const ai = new GoogleGenAI({ apiKey });
  const pager = await ai.models.list({ config: { queryBase: true, pageSize: 200 } });
  const models: Model[] = [];
  let pages = 0;
  for await (const model of pager) {
    models.push(model);
    // Prevent runaway iteration on very long lists — a handful of pages covers
    // every Gemini model that's ever been publicly offered.
    if (++pages >= MAX_LIST_PAGES * 200) break;
  }
  return models;
}

function isImageGenerationModel(model: Model): boolean {
  const id = normalizeModelId(model.name, "google").toLowerCase();
  if (!id) return false;
  if (GOOGLE_IMAGE_MODELS.some((model) => model.id === id)) return true;
  // Gemini image generation still uses `generateContent`, so action flags
  // can't distinguish image from text. Go by naming convention.
  return /(^|[-_\/])(image|imagen)([-_\/]|$)/.test(id) || id.includes("-image-");
}

function isTextGenerationModel(model: Model): boolean {
  const id = normalizeModelId(model.name, "google");
  if (!id) return false;
  if (!model.supportedActions?.some((a) => a === "generateContent")) return false;
  if (isImageGenerationModel(model)) return false;
  // Exclude embedding / vision-only / TTS / audio flavors that share generateContent.
  const lower = id.toLowerCase();
  if (/embed|tts|audio|live|native-audio/.test(lower)) return false;
  return true;
}

function toSearchResult(model: Model): SearchResult {
  const id = normalizeModelId(model.name, "google");
  return {
    id,
    name: model.displayName || id,
    description: model.description,
    icon: "/icons/google.svg",
  };
}

function rankAndLimit(models: Model[], query: string, limit = 6): SearchResult[] {
  const q = query.toLowerCase();
  const scored = models
    .map((m) => {
      const id = normalizeModelId(m.name, "google").toLowerCase();
      const name = (m.displayName || "").toLowerCase();
      const containsBoost = id.includes(q) || name.includes(q) ? -1000 : 0;
      const d = Math.min(distance(q, id), distance(q, name));
      return { model: m, score: d + containsBoost };
    })
    .sort((a, b) => a.score - b.score);

  return scored.slice(0, limit).map(({ model }) => toSearchResult(model));
}

const STD_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

function inferGoogleImageCapabilities(modelId: string): ResolvedImageModel["capabilities"] {
  const lower = normalizeModelId(modelId, "google").toLowerCase();
  const supports14References = lower.includes("3");

  return {
    supportsAspectRatios: true,
    supportedAspectRatios: STD_ASPECT_RATIOS,
    supportsResolution: true,
    supportsReferenceImages: true,
    maxReferenceImages: supports14References ? 14 : 10,
  };
}

async function resolveImageModel(
  modelId: string,
  apiKey: string,
  onProgress?: (status: string) => void
): Promise<ResolvedImageModel> {
  const libraryModel = resolveLibraryModel(GOOGLE_IMAGE_MODELS, modelId);
  if (libraryModel) {
    onProgress?.("Using model library...");
    return libraryModel;
  }

  onProgress?.("Looking up model...");
  const all = await listGeminiModels(apiKey);
  const normalizedId = normalizeModelId(modelId, "google");
  const match = all.find((model) => normalizeModelId(model.name, "google") === normalizedId);

  if (!match) {
    throw new Error(`Model not found: ${modelId}`);
  }
  if (!isImageGenerationModel(match)) {
    throw new Error(`Model is not an image generation model: ${modelId}`);
  }

  onProgress?.("Analyzing capabilities...");
  return {
    name: match.displayName || inferName(normalizedId),
    capabilities: inferGoogleImageCapabilities(normalizedId),
    icon: "/icons/google.svg",
  };
}

async function searchImageModels(query: string, apiKey: string): Promise<SearchResult[]> {
  const libraryResults = searchModelLibrary(GOOGLE_IMAGE_MODELS, query);
  const all = await listGeminiModels(apiKey);
  const imageModels = all.filter(isImageGenerationModel);
  return mergeSearchResults(libraryResults, rankAndLimit(imageModels, query));
}

async function searchTextModels(query: string, apiKey: string): Promise<SearchResult[]> {
  const all = await listGeminiModels(apiKey);
  const textModels = all.filter(isTextGenerationModel);
  return rankAndLimit(textModels, query);
}

export const googleProvider: Provider = {
  id: "google",
  label: "Google",
  iconPath: "/icons/google.svg",
  requiresApiKey: true,
  supportsTextPrefill: true,
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
