import { distance } from "fastest-levenshtein";
import Replicate from "replicate";
import type { GenerationParams, GenerationResult } from "~/lib/generation";
import { getPlatform } from "~/lib/platform";
import { logger } from "~/lib/logging";
import { inferIcon, inferName } from "~/lib/modelNames";
import { dereferenceProperties, type OpenApiSchemaProperty } from "~/lib/openapi";
import { SCHEMA_MAPPING_SYSTEM } from "~/lib/prompts";
import { toRateLimitError } from "~/lib/retry";
import { blobToBase64 } from "~/lib/util";
import type { ModelCapabilities, SchemaMapping, StoredUpscaler } from "~/types";
import { mergeSearchResults, resolveLibraryModel, searchModelLibrary } from "./modelLibrary";
import { REPLICATE_IMAGE_MODELS } from "./replicateModels";
import type { Provider, ResolvedImageModel, SearchResult, TextGenerationArgs } from "./types";
import { normalizeModelId } from ".";

function replicateBaseUrl(): string {
  return getPlatform().providerBaseUrl("replicate");
}

async function generateImage(
  params: GenerationParams,
  apiKey?: string
): Promise<GenerationResult[]> {
  if (!apiKey) throw new Error("No API key for replicate");
  const replicate = new Replicate({ auth: apiKey, baseUrl: replicateBaseUrl() });

  const imageInputs = await Promise.all(
    params.referenceImages.map(async (ref) => blobToBase64(ref.blob))
  );

  const mapping = params.schemaMapping;
  const caps = params.capabilities;

  const input: Record<string, unknown> = {
    prompt: params.prompt,
  };
  if (params.aspectRatio) {
    const aspectRatioKey = mapping?.aspectRatioKey ?? "aspect_ratio";
    input[aspectRatioKey] = params.aspectRatio;
  }
  if (imageInputs.length > 0) {
    const imageKey = mapping?.imageInputKey ?? "image_input";
    input[imageKey] = imageInputs;
  }
  if (params.resolution) {
    const resolutionKey = mapping?.resolutionKey ?? "resoluton";
    input[resolutionKey] = mapping?.resolution?.[params.resolution] ?? params.resolution;
  }
  if (caps?.supportsQuality && params.quality) {
    const qualityKey = mapping?.qualityKey ?? "quality";
    input[qualityKey] = params.quality;
  }
  if (caps?.supportsNumberOfImages && params.numberOfImages > 1) {
    const numberOfImagesKey = mapping?.numberOfImagesKey ?? "number_of_images";
    input[numberOfImagesKey] = params.numberOfImages;
  }
  if (mapping?.extraDefaults) {
    for (const [key, value] of Object.entries(mapping.extraDefaults)) {
      if (!(key in input)) input[key] = value;
    }
  }

  const replicateModel = normalizeModelId(params.modelId, "replicate") as `${string}/${string}`;
  const request = { model: replicateModel, input };
  logger.debug("[image-generation] Raw API request", { provider: "replicate", request });

  let output;
  let prediction: any;
  try {
    output = await (replicate.run as any)(replicateModel, {
      input,
      progress: (next: any) => {
        prediction = next;
      },
    });
  } catch (error) {
    throw toRateLimitError(error, "replicate");
  }
  logger.debug("[image-generation] Raw API response", { provider: "replicate", response: output });

  // Normalize output to a list of image URLs. Replicate returns either a single
  // string/FileOutput, or an array of them for batch-capable models.
  const urls = extractReplicateUrls(output);
  if (urls.length === 0) throw new Error("No image in Replicate response");

  const results = await Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch generated image: ${response.status}`);
      }
      const blob = await response.blob();
      const dimensions = await getPlatform().getImageDimensions(blob);
      const inputMegapixels = await Promise.all(
        params.referenceImages.map(async (ref) => {
          const size = await getPlatform().getImageDimensions(ref.blob);
          return (size.width * size.height) / 1_000_000;
        })
      );
      return {
        blob,
        width: dimensions.width,
        height: dimensions.height,
        metadata: {
          ...(prediction?.id && { predictionId: prediction.id }),
          ...(prediction?.version && { predictionVersion: prediction.version }),
          ...(prediction?.metrics?.predict_time != null && {
            predictTime: prediction.metrics.predict_time,
          }),
          ...(prediction?.metrics?.total_time != null && {
            totalTime: prediction.metrics.total_time,
          }),
        },
        usage: {
          metrics: {
            outputImages: 1,
            inputMegapixels: inputMegapixels.reduce((sum, value) => sum + value, 0) / urls.length,
            outputMegapixels: (dimensions.width * dimensions.height) / 1_000_000,
            runtimeSeconds: prediction?.metrics?.predict_time,
          },
        },
      };
    })
  );

  return results;
}

function extractReplicateUrls(output: unknown): string[] {
  if (output == null) return [];
  if (typeof output === "string") return [output];
  if (typeof output === "object" && "url" in (output as object)) {
    const url = (output as { url: () => string }).url();
    return url ? [url] : [];
  }
  if (Array.isArray(output)) {
    return output.flatMap((entry) => extractReplicateUrls(entry));
  }
  const str = String(output);
  return str ? [str] : [];
}

async function generateText(args: TextGenerationArgs, apiKey: string): Promise<string> {
  const replicate = new Replicate({ auth: apiKey, baseUrl: replicateBaseUrl() });
  let { systemPrompt, userPrompt } = args;
  const { images, prefill } = args;
  const modelId = normalizeModelId(args.modelId, "replicate");

  // Replicate doesn't support prefills, so we just concatenate it to the user prompt.
  if (prefill) {
    userPrompt = userPrompt + "\n\n" + prefill;
  }

  let output;
  try {
    output = await replicate.run(modelId as `${string}/${string}`, {
      input: { prompt: userPrompt, system_instruction: systemPrompt, images },
    });
  } catch (error) {
    throw toRateLimitError(error, "replicate");
  }

  if (typeof output === "string") {
    return output;
  }

  if (Array.isArray(output)) {
    return output.join("");
  }

  throw new Error("Unexpected text model response format");
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

async function upscale(
  sourceBlob: Blob,
  upscaler: StoredUpscaler,
  apiKey: string
): Promise<GenerationResult> {
  const replicate = new Replicate({ auth: apiKey, baseUrl: replicateBaseUrl() });
  const dataUri = await blobToBase64(sourceBlob);

  const input: Record<string, unknown> = { image: dataUri };
  if (upscaler.scaleParam !== null && upscaler.scale !== null) {
    input[upscaler.scaleParam] = upscaler.scale;
  }

  const output = await replicate.run(upscaler.replicateId as `${string}/${string}`, { input });

  const imageUrl =
    typeof output === "object" && output !== null && "url" in output
      ? (output as { url: () => string }).url()
      : Array.isArray(output)
        ? output[0]
        : String(output);

  if (!imageUrl) throw new Error("No image in upscale response");

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) throw new Error(`Failed to fetch upscaled image: ${imageResponse.status}`);

  const blob = await imageResponse.blob();
  const dimensions = await getPlatform().getImageDimensions(blob);

  return { blob, width: dimensions.width, height: dimensions.height, metadata: {} };
}

interface ReplicateSearchResponse {
  results: Array<{
    owner: string;
    name: string;
    description?: string;
    cover_image_url?: string;
    latest_version?: {
      openapi_schema?: {
        components?: {
          schemas?: any;
        };
      };
    };
  }>;
}

async function searchModels(query: string, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch(`${replicateBaseUrl()}/models`, {
    method: "QUERY",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "text/plain",
    },
    body: query,
  });

  if (!response.ok) return [];

  const data: ReplicateSearchResponse = await response.json();

  const imageModels = data.results.filter((r) => {
    const outputSchema = r.latest_version?.openapi_schema?.components?.schemas?.Output;
    return outputSchema?.items?.format === "uri" || outputSchema?.format === "uri";
  });

  imageModels.sort((a, b) => {
    return distance(query, `${a.owner}/${a.name}`) - distance(query, `${b.owner}/${b.name}`);
  });

  return imageModels.slice(0, 6).map((r) => {
    const id = `${r.owner}/${r.name}`;
    return {
      id,
      name: inferName(id),
      description: r.description,
      coverImageUrl: r.cover_image_url,
      icon: inferIcon(id),
    };
  });
}

async function searchImageModels(query: string, apiKey: string): Promise<SearchResult[]> {
  const libraryResults = searchModelLibrary(REPLICATE_IMAGE_MODELS, query);
  const discovered = await searchModels(query, apiKey);
  return mergeSearchResults(libraryResults, discovered);
}

interface ReplicateModelResponse {
  name: string;
  description?: string;
  latest_version?: {
    openapi_schema?: {
      components?: {
        schemas?: Record<string, OpenApiSchemaProperty>;
      };
    };
  };
}

interface HeuristicResult {
  capabilities: ModelCapabilities;
  detectedAspectRatioKey?: string;
  detectedQualityKey?: string;
  detectedNumberOfImagesKey?: string;
  detectedResolutionKey?: string;
}

interface SchemaAnalysis {
  mapping: SchemaMapping;
  supportedAspectRatios?: string[];
  supportedQualities?: string[];
  maxImagesPerRequest?: number;
}

async function fetchReplicateModelSchema(
  modelId: string,
  apiKey: string
): Promise<{ properties: Record<string, OpenApiSchemaProperty> }> {
  const lower = normalizeModelId(modelId, "replicate").toLowerCase();
  const response = await fetch(`${replicateBaseUrl()}/models/${lower}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Model not found: ${lower}`);
  }

  const data: ReplicateModelResponse = await response.json();
  const allSchemas = data.latest_version?.openapi_schema?.components?.schemas ?? {};
  const inputSchema = allSchemas["Input"] as
    | { properties?: Record<string, OpenApiSchemaProperty> }
    | undefined;
  const rawProperties = inputSchema?.properties ?? {};
  const properties = dereferenceProperties(rawProperties, allSchemas);

  return { properties };
}

function inferCapabilitiesFromProperties(
  properties: Record<string, OpenApiSchemaProperty>
): HeuristicResult {
  const aspectRatioKeys = ["aspect_ratio", "aspectRatio", "output_aspect_ratio"];
  const detectedAspectRatioKey = aspectRatioKeys.find((key) => properties[key]);
  const supportsAspectRatios = !!detectedAspectRatioKey;

  const resolutionKeys = ["resolution", "output_resolution", "megapixels", "size"];
  const detectedResolutionKey = resolutionKeys.find((key) => properties[key]);
  const supportsResolution = !!detectedResolutionKey;

  const imageProps = [
    "image",
    "image_input",
    "input_image",
    "input_images",
    "reference_image",
    "init_image",
    "control_image",
  ];
  const imageProperty = imageProps.find((prop) => properties[prop]);
  const supportsReferenceImages = !!imageProperty;

  let maxReferenceImages = 1;
  if (imageProperty && properties[imageProperty].type === "array") {
    maxReferenceImages = 10;
  }

  const qualityKeys = ["quality", "image_quality", "output_quality"];
  const detectedQualityKey = qualityKeys.find((key) => {
    const prop = properties[key];
    return prop && prop.type === "string" && Array.isArray(prop.enum) && prop.enum.length > 0;
  });
  const supportsQuality = !!detectedQualityKey;
  const supportedQualities = detectedQualityKey ? properties[detectedQualityKey].enum : undefined;

  const numberOfImagesKeys = ["number_of_images", "num_images", "n_images", "num_outputs"];
  const detectedNumberOfImagesKey = numberOfImagesKeys.find((key) => {
    const prop = properties[key];
    return prop && (prop.type === "integer" || prop.type === "number");
  });
  const supportsNumberOfImages = !!detectedNumberOfImagesKey;
  const maxImagesPerRequest = detectedNumberOfImagesKey
    ? typeof properties[detectedNumberOfImagesKey].maximum === "number"
      ? properties[detectedNumberOfImagesKey].maximum
      : 10
    : undefined;

  return {
    capabilities: {
      supportsAspectRatios,
      supportsResolution,
      supportsReferenceImages,
      maxReferenceImages,
      supportsQuality,
      ...(supportedQualities ? { supportedQualities } : {}),
      supportsNumberOfImages,
      ...(typeof maxImagesPerRequest === "number" ? { maxImagesPerRequest } : {}),
    },
    detectedAspectRatioKey,
    detectedQualityKey,
    detectedNumberOfImagesKey,
    detectedResolutionKey,
  };
}

async function analyzeSchemaWithTextModel(
  properties: Record<string, OpenApiSchemaProperty>
): Promise<SchemaAnalysis | null> {
  try {
    // Loaded lazily: the text model reads the settings store, which must stay out of
    // the image-generation import graph so it can run outside the browser.
    // Schema analysis only happens when a user adds a model in Settings.
    const { callTextModel } = await import("~/lib/textModel");
    const response = await callTextModel(SCHEMA_MAPPING_SYSTEM, JSON.stringify(properties));

    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
    const jsonStr = (jsonMatch[1] ?? response).trim();
    const parsed = JSON.parse(jsonStr);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const mapping: SchemaMapping = {};
    let supportedAspectRatios: string[] | undefined;
    let supportedQualities: string[] | undefined;
    let maxImagesPerRequest: number | undefined;

    if (parsed.resolution && typeof parsed.resolution === "object") {
      mapping.resolution = parsed.resolution;
    }
    if (typeof parsed.aspectRatioKey === "string" && parsed.aspectRatioKey !== "aspect_ratio") {
      mapping.aspectRatioKey = parsed.aspectRatioKey;
    }
    if (typeof parsed.imageInputKey === "string" && parsed.imageInputKey !== "image_input") {
      mapping.imageInputKey = parsed.imageInputKey;
    }
    if (typeof parsed.maxReferenceImages === "number" && parsed.maxReferenceImages > 0) {
      mapping.maxReferenceImages = parsed.maxReferenceImages;
    }
    if (typeof parsed.qualityKey === "string" && parsed.qualityKey.length > 0) {
      if (parsed.qualityKey !== "quality") {
        mapping.qualityKey = parsed.qualityKey;
      }
    }
    if (typeof parsed.numberOfImagesKey === "string" && parsed.numberOfImagesKey.length > 0) {
      if (parsed.numberOfImagesKey !== "number_of_images") {
        mapping.numberOfImagesKey = parsed.numberOfImagesKey;
      }
    }
    if (parsed.extraDefaults && typeof parsed.extraDefaults === "object") {
      mapping.extraDefaults = parsed.extraDefaults;
    }
    if (Array.isArray(parsed.supportedAspectRatios)) {
      supportedAspectRatios = parsed.supportedAspectRatios.filter(
        (v: unknown): v is string => typeof v === "string"
      );
    }
    if (Array.isArray(parsed.supportedQualities)) {
      supportedQualities = parsed.supportedQualities.filter(
        (v: unknown): v is string => typeof v === "string"
      );
    }
    if (typeof parsed.maxImagesPerRequest === "number" && parsed.maxImagesPerRequest > 0) {
      maxImagesPerRequest = Math.floor(parsed.maxImagesPerRequest);
    }

    const hasMapping = Object.keys(mapping).length > 0;
    if (!hasMapping && !supportedAspectRatios && !supportedQualities && !maxImagesPerRequest) {
      return null;
    }

    return { mapping, supportedAspectRatios, supportedQualities, maxImagesPerRequest };
  } catch {
    return null;
  }
}

function mergeAnalysis(
  heuristic: HeuristicResult,
  analysis: SchemaAnalysis | null,
  properties: Record<string, OpenApiSchemaProperty>
): { capabilities: ModelCapabilities; schemaMapping: SchemaMapping | undefined } {
  const capabilities: ModelCapabilities = { ...heuristic.capabilities };
  const mapping: SchemaMapping = { ...(analysis?.mapping ?? {}) };

  if (analysis?.supportedAspectRatios !== undefined) {
    capabilities.supportedAspectRatios = analysis.supportedAspectRatios;
  }

  if (
    heuristic.detectedAspectRatioKey &&
    heuristic.detectedAspectRatioKey !== "aspect_ratio" &&
    !mapping.aspectRatioKey
  ) {
    mapping.aspectRatioKey = heuristic.detectedAspectRatioKey;
  }

  if (
    heuristic.detectedResolutionKey &&
    heuristic.detectedResolutionKey !== "resolution" &&
    !mapping.resolutionKey
  ) {
    mapping.resolutionKey = heuristic.detectedResolutionKey;
  }

  if (mapping.imageInputKey && !capabilities.supportsReferenceImages) {
    capabilities.supportsReferenceImages = true;
    capabilities.maxReferenceImages =
      mapping.maxReferenceImages ?? (properties[mapping.imageInputKey]?.type === "array" ? 10 : 1);
  } else if (mapping.maxReferenceImages) {
    capabilities.maxReferenceImages = mapping.maxReferenceImages;
  }

  if (mapping.resolution && !capabilities.supportsResolution) {
    capabilities.supportsResolution = true;
  }

  // Quality: the analyzer may have named a non-default property key OR provided
  // an enum list. The heuristic may have found a default-named `quality` prop.
  if (mapping.qualityKey && !capabilities.supportsQuality) {
    const prop = properties[mapping.qualityKey];
    capabilities.supportsQuality = true;
    if (!capabilities.supportedQualities && Array.isArray(prop?.enum)) {
      capabilities.supportedQualities = prop.enum;
    }
  } else if (
    heuristic.detectedQualityKey &&
    heuristic.detectedQualityKey !== "quality" &&
    !mapping.qualityKey
  ) {
    mapping.qualityKey = heuristic.detectedQualityKey;
  }
  if (analysis?.supportedQualities && analysis.supportedQualities.length > 0) {
    capabilities.supportedQualities = analysis.supportedQualities;
  }

  // Batch: similar pattern.
  if (mapping.numberOfImagesKey && !capabilities.supportsNumberOfImages) {
    const prop = properties[mapping.numberOfImagesKey];
    capabilities.supportsNumberOfImages = true;
    if (!capabilities.maxImagesPerRequest) {
      capabilities.maxImagesPerRequest =
        typeof prop?.maximum === "number" ? prop.maximum : (analysis?.maxImagesPerRequest ?? 4);
    }
  } else if (
    heuristic.detectedNumberOfImagesKey &&
    heuristic.detectedNumberOfImagesKey !== "number_of_images" &&
    !mapping.numberOfImagesKey
  ) {
    mapping.numberOfImagesKey = heuristic.detectedNumberOfImagesKey;
  }
  if (typeof analysis?.maxImagesPerRequest === "number") {
    capabilities.maxImagesPerRequest = analysis.maxImagesPerRequest;
  }

  const schemaMapping = Object.keys(mapping).length > 0 ? mapping : undefined;
  return { capabilities, schemaMapping };
}

async function resolveImageModel(
  modelId: string,
  apiKey: string,
  onProgress?: (status: string) => void
): Promise<ResolvedImageModel> {
  const libraryModel = resolveLibraryModel(REPLICATE_IMAGE_MODELS, modelId);
  if (libraryModel) {
    onProgress?.("Using model library...");
    return libraryModel;
  }

  onProgress?.("Fetching schema...");
  const { properties } = await fetchReplicateModelSchema(modelId, apiKey);
  const heuristic = inferCapabilitiesFromProperties(properties);

  onProgress?.("Analyzing parameters...");
  const analysis = await analyzeSchemaWithTextModel(properties);

  const { capabilities, schemaMapping } = mergeAnalysis(heuristic, analysis, properties);
  return { name: inferName(modelId), capabilities, schemaMapping, icon: inferIcon(modelId) };
}

export const replicateProvider: Provider = {
  id: "replicate",
  label: "Replicate",
  iconPath: "/icons/replicate.svg",
  requiresApiKey: true,
  supportsTextPrefill: false,
  capabilities: {
    image: true,
    text: true,
    upscale: true,
    searchImage: true,
    searchText: false,
    searchUpscale: true,
  },
  generateImage,
  generateText,
  testTextModel,
  upscale,
  searchImageModels,
  searchUpscalers: searchModels,
  resolveImageModel,
};
