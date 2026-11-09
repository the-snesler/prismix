import type {
  AspectRatio,
  GenerationCostEstimate,
  GenerationUsage,
  ModelCapabilities,
  ModelOptionValues,
  Provider as ProviderId,
  Resolution,
  SchemaMapping,
} from "~/types";
import { getProvider } from "~/lib/providers";
import { estimateGenerationCost, resolveModelPricing } from "~/lib/pricing";

export class RateLimitError extends Error {
  retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export interface GenerationParams {
  modelId: string;
  provider: ProviderId;
  prompt: string;
  aspectRatio: AspectRatio | null;
  resolution: Resolution | null;
  quality: string | null;
  /** Resolved model-specific options (see `lib/modelOptions.ts`). */
  modelOptions?: ModelOptionValues;
  numberOfImages: number;
  referenceImages: Array<{ id: string; blob: Blob }>;
  itemIds?: string[];
  /** The model's capabilities (`StoredModel.capabilities`), so providers never read the settings store. */
  capabilities?: ModelCapabilities;
  /** Parameter translation for non-standard Replicate models (`StoredModel.schemaMapping`). */
  schemaMapping?: SchemaMapping;
}

export interface GenerationResult {
  blob: Blob;
  width: number;
  height: number;
  metadata: Record<string, unknown>;
  usage?: GenerationUsage;
  costEstimate?: GenerationCostEstimate;
}

/**
 * Run one provider image call and attach cost estimates. Environment-neutral:
 * browser concerns such as the tab-close guard belong to the caller.
 */
export async function executeGeneration(
  params: GenerationParams,
  apiKey?: string
): Promise<GenerationResult[]> {
  const provider = getProvider(params.provider);
  if (!provider.generateImage) {
    throw new Error(`Provider ${params.provider} does not support image generation`);
  }
  const pricing = resolveModelPricing(params.provider, params.modelId);
  const results = await provider.generateImage(params, apiKey);
  const resolvedPricing = await pricing;
  return results.map((result) => ({
    ...result,
    costEstimate: estimateGenerationCost(resolvedPricing, result.usage, params),
  }));
}
