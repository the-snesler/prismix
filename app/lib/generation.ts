import type {
  AspectRatio,
  GenerationCostEstimate,
  GenerationUsage,
  ModelOptionValues,
  Provider as ProviderId,
  Resolution,
} from "~/types";
import { getProvider } from "~/lib/providers";
import { estimateGenerationCost, resolveModelPricing } from "~/lib/pricing";
import { beginGenerationUnloadGuard } from "./generationUnloadGuard";

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
}

export interface GenerationResult {
  blob: Blob;
  width: number;
  height: number;
  metadata: Record<string, unknown>;
  usage?: GenerationUsage;
  costEstimate?: GenerationCostEstimate;
}

export async function executeGeneration(
  params: GenerationParams,
  apiKey?: string
): Promise<GenerationResult[]> {
  const provider = getProvider(params.provider);
  if (!provider.generateImage) {
    throw new Error(`Provider ${params.provider} does not support image generation`);
  }
  const endUnloadGuard = beginGenerationUnloadGuard();
  try {
    const pricing = resolveModelPricing(params.provider, params.modelId);
    const results = await provider.generateImage(params, apiKey);
    const resolvedPricing = await pricing;
    return results.map((result) => ({
      ...result,
      costEstimate: estimateGenerationCost(resolvedPricing, result.usage, params),
    }));
  } finally {
    endUnloadGuard();
  }
}
