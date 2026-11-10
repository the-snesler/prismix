import { distance } from "fastest-levenshtein";
import type { GenerationParams, GenerationResult } from "~/lib/generation";
import { getPlatform } from "~/lib/platform";
import { logger } from "~/lib/logging";
import { toRateLimitError } from "~/lib/retry";
import { base64ToBlob, blobToBase64 } from "~/lib/util";
import type { ModelCapabilities, Resolution } from "~/types";
import { normalizeModelId } from ".";
import type { Provider, SearchResult, TextGenerationArgs } from "./types";

type Parameter =
  | { type: "enum"; values: string[] }
  | { type: "range"; min: number; max: number }
  | { type: "boolean" };

interface CatalogModel {
  id: string;
  name: string;
  description?: string;
  architecture: { input_modalities: string[]; output_modalities: string[] };
  supported_parameters?: Record<string, Parameter>;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
}

const ICON = "/icons/openrouter.svg";
const BASE_URL = "https://openrouter.ai/api/v1";

async function request<T>(path: string, apiKey: string, body?: object): Promise<T> {
  if (!apiKey) throw new Error("Add an OpenRouter API key first");
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) {
      const retryAfter = response.headers.get("retry-after");
      const error = Object.assign(
        new Error(
          `OpenRouter: ${payload?.error?.message || response.statusText || "Request failed"}` +
            (retryAfter ? ` (retry-after: ${retryAfter})` : "")
        ),
        { status: response.status, code: payload?.error?.code }
      );
      throw error;
    }
    if (!payload) throw new Error("Empty response from OpenRouter");
    return payload as T;
  } catch (error) {
    throw toRateLimitError(error, "OpenRouter");
  }
}

async function listModels(kind: "image" | "text", apiKey: string): Promise<CatalogModel[]> {
  const { data } = await request<{ data: CatalogModel[] }>(
    kind === "image" ? "/images/models" : "/models",
    apiKey
  );
  return data.filter((model) => model.architecture.output_modalities.includes(kind));
}

async function findModel(kind: "image" | "text", modelId: string, apiKey: string) {
  const id = normalizeModelId(modelId, "openrouter");
  const model = (await listModels(kind, apiKey)).find((model) => model.id === id);
  if (!model) throw new Error(`OpenRouter ${kind} model not found: ${id}`);
  return model;
}

async function searchModels(
  kind: "image" | "text",
  query: string,
  apiKey: string
): Promise<SearchResult[]> {
  const models = await listModels(kind, apiKey);
  const q = query.trim().toLowerCase();
  return models
    .map((model) => {
      const id = model.id.toLowerCase();
      const name = model.name.toLowerCase();
      const boost = id.includes(q) || name.includes(q) ? -1000 : 0;
      return { model, score: q ? Math.min(distance(q, id), distance(q, name)) + boost : 0 };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 6)
    .map(({ model }) => ({
      id: model.id,
      name: model.name,
      description: model.description,
      icon: ICON,
    }));
}

function enumValues(parameter?: Parameter): string[] {
  return parameter?.type === "enum" ? parameter.values.filter((value) => value !== "auto") : [];
}

function maxCount(parameter?: Parameter): number {
  return parameter?.type === "range" ? parameter.max : 1;
}

function imageCapabilities(model: CatalogModel): ModelCapabilities {
  const parameters = model.supported_parameters ?? {};
  const resolutions = enumValues(parameters.resolution).filter(
    (value): value is Resolution => value === "1K" || value === "2K" || value === "4K"
  );
  const supportsReferences =
    !!parameters.input_references && model.architecture.input_modalities.includes("image");
  return {
    supportsAspectRatios: !!parameters.aspect_ratio,
    supportedAspectRatios: enumValues(parameters.aspect_ratio),
    supportsResolution: resolutions.length > 0,
    resolutions,
    supportsQuality: !!parameters.quality,
    supportedQualities: enumValues(parameters.quality),
    supportsReferenceImages: supportsReferences,
    maxReferenceImages: supportsReferences ? maxCount(parameters.input_references) : 0,
    supportsNumberOfImages: maxCount(parameters.n) > 1,
    maxImagesPerRequest: maxCount(parameters.n),
  };
}

async function generateImage(params: GenerationParams, apiKey = ""): Promise<GenerationResult[]> {
  const model = await findModel("image", params.modelId, apiKey);
  const capabilities = imageCapabilities(model);
  const references = params.referenceImages;
  const referenceRange = model.supported_parameters?.input_references;
  const minReferences = referenceRange?.type === "range" ? referenceRange.min : 0;
  if (references.length < minReferences) {
    throw new Error(
      `OpenRouter model ${model.id} requires at least ${minReferences} reference images`
    );
  }
  if (references.length > capabilities.maxReferenceImages) {
    throw new Error(
      `OpenRouter model ${model.id} accepts at most ${capabilities.maxReferenceImages} reference images`
    );
  }
  if (params.numberOfImages > capabilities.maxImagesPerRequest!) {
    throw new Error(
      `OpenRouter model ${model.id} accepts at most ${capabilities.maxImagesPerRequest} images per request`
    );
  }

  const body = {
    model: model.id,
    prompt: params.prompt,
    ...(model.supported_parameters?.n ? { n: params.numberOfImages } : {}),
    ...(capabilities.supportsAspectRatios && params.aspectRatio
      ? { aspect_ratio: params.aspectRatio }
      : {}),
    ...(capabilities.supportsResolution && params.resolution
      ? { resolution: params.resolution }
      : {}),
    ...(capabilities.supportsQuality && params.quality ? { quality: params.quality } : {}),
    ...(references.length
      ? {
          input_references: await Promise.all(
            references.map(async (ref) => ({
              type: "image_url",
              image_url: { url: await blobToBase64(ref.blob) },
            }))
          ),
        }
      : {}),
  };
  logger.debug("[image-generation] Raw API request", { provider: "openrouter", request: body });
  const response = await request<{
    data: Array<{ b64_json: string; media_type?: string }>;
    usage?: Usage;
  }>("/images", apiKey, body);
  logger.debug("[image-generation] Raw API response", { provider: "openrouter", response });
  if (!response.data?.length) throw new Error("No image in OpenRouter response");

  return Promise.all(
    response.data.map(async (entry) => {
      if (!entry.b64_json) throw new Error("Empty image entry in OpenRouter response");
      const blob = base64ToBlob(entry.b64_json, entry.media_type ?? "image/png");
      const dimensions = await getPlatform().getImageDimensions(blob);
      return {
        blob,
        width: dimensions.width,
        height: dimensions.height,
        metadata: { modelId: model.id, usage: response.usage },
        usage: response.usage
          ? {
              allocationDivisor: response.data.length,
              metrics: {
                inputTokens: response.usage.prompt_tokens,
                outputTokens: response.usage.completion_tokens,
                outputImages: response.data.length,
              },
            }
          : undefined,
      };
    })
  );
}

async function generateText(args: TextGenerationArgs, apiKey: string): Promise<string> {
  const modelId = normalizeModelId(args.modelId, "openrouter");
  if (args.images?.length) {
    const model = await findModel("text", modelId, apiKey);
    if (!model.architecture.input_modalities.includes("image")) {
      throw new Error(`OpenRouter model ${modelId} does not support image inputs`);
    }
  }
  const content = [
    { type: "text", text: args.userPrompt + (args.prefill ? `\n\n${args.prefill}` : "") },
    ...(await Promise.all(
      (args.images ?? []).map(async (blob) => ({
        type: "image_url",
        image_url: { url: await blobToBase64(blob) },
      }))
    )),
  ];
  const response = await request<{
    choices: Array<{ message: { content: string | null } }>;
  }>("/chat/completions", apiKey, {
    model: modelId,
    messages: [
      { role: "system", content: args.systemPrompt },
      { role: "user", content },
    ],
  });
  const text = response.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("No text in OpenRouter response");
  return (args.prefill ?? "") + text;
}

export const openrouterProvider: Provider = {
  id: "openrouter",
  label: "OpenRouter",
  iconPath: ICON,
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
  testTextModel: (apiKey, modelId) =>
    generateText(
      {
        modelId,
        systemPrompt: "You are a connectivity test.",
        userPrompt: "Respond with the single word 'hi' and nothing else.",
      },
      apiKey
    ).then(() => {}),
  searchImageModels: (query, apiKey) => searchModels("image", query, apiKey),
  searchTextModels: (query, apiKey) => searchModels("text", query, apiKey),
  resolveImageModel: async (modelId, apiKey, onProgress) => {
    onProgress?.("Looking up OpenRouter model...");
    const model = await findModel("image", modelId, apiKey);
    return { name: model.name, capabilities: imageCapabilities(model), icon: ICON };
  },
};
