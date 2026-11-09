import type { GenerationCostEstimate, GenerationUsage, ModelPricing, Provider } from "~/types";
import { findLibraryModel } from "~/lib/providers/modelLibrary";
import { GOOGLE_IMAGE_MODELS } from "~/lib/providers/googleModels";
import { OPENAI_IMAGE_MODELS } from "~/lib/providers/openaiModels";
import { REPLICATE_IMAGE_MODELS } from "~/lib/providers/replicateModels";
import { getPlatform } from "~/lib/platform";

const CACHE_KEY = "paintball-model-pricing-v1";
const TTL_MS = 24 * 60 * 60 * 1000;
let pricingRequest: Promise<Record<string, ModelPricing>> | null = null;

function libraryPricing(provider: Provider, modelId: string): ModelPricing | undefined {
  const library =
    provider === "google"
      ? GOOGLE_IMAGE_MODELS
      : provider === "openai"
        ? OPENAI_IMAGE_MODELS
        : provider === "replicate"
          ? REPLICATE_IMAGE_MODELS
          : [];
  return findLibraryModel(library, modelId)?.pricing;
}

function cache(): { fetchedAt: number; prices: Record<string, ModelPricing> } | null {
  try {
    const value = JSON.parse(getPlatform().cache.get(CACHE_KEY) ?? "null");
    return value && typeof value.fetchedAt === "number" && value.prices ? value : null;
  } catch {
    return null;
  }
}

function fromCatalog(payload: any, fetchedAt: number): Record<string, ModelPricing> {
  const prices: Record<string, ModelPricing> = {};
  for (const provider of ["google", "openai"] as const) {
    for (const [id, model] of Object.entries(payload?.[provider]?.models ?? {}) as Array<
      [string, any]
    >) {
      const input = model?.cost?.input,
        output = model?.cost?.output;
      const rules = [
        typeof input === "number" && Number.isFinite(input) && input >= 0
          ? { metric: "inputTokens" as const, units: 1_000_000, usd: input }
          : null,
        typeof output === "number" && Number.isFinite(output) && output >= 0
          ? { metric: "outputTokens" as const, units: 1_000_000, usd: output }
          : null,
      ].filter(Boolean) as ModelPricing["rules"];
      if (rules.length)
        prices[`${provider}:${id}`] = {
          currency: "USD",
          rules,
          source: { kind: "models.dev", url: "https://models.dev/api.json", fetchedAt },
        };
    }
  }
  return prices;
}

async function catalogPricing(): Promise<Record<string, ModelPricing>> {
  const previous = cache();
  if (previous && Date.now() - previous.fetchedAt < TTL_MS) return previous.prices;
  if (!pricingRequest)
    pricingRequest = (async () => {
      try {
        const response = await fetch("https://models.dev/api.json", {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
        const fetchedAt = Date.now();
        const prices = fromCatalog(await response.json(), fetchedAt);
        getPlatform().cache.set(CACHE_KEY, JSON.stringify({ fetchedAt, prices }));
        return prices;
      } catch {
        return previous?.prices ?? {};
      } finally {
        pricingRequest = null;
      }
    })();
  return pricingRequest;
}

export async function resolveModelPricing(
  provider: Provider,
  modelId: string
): Promise<ModelPricing | undefined> {
  const official = libraryPricing(provider, modelId);
  if (official) return official;
  if (provider !== "google" && provider !== "openai") return undefined;
  const id = modelId.replace(new RegExp(`^${provider}/`), "");
  const prices = await catalogPricing();
  return (
    prices[`${provider}:${id}`] ?? prices[`${provider}:${id.replace(/-\\d{4}-\\d{2}-\\d{2}$/, "")}`]
  );
}

export function estimateGenerationCost(
  pricing: ModelPricing | undefined,
  usage: GenerationUsage | undefined,
  context: { resolution: string | null; quality: string | null }
): GenerationCostEstimate | undefined {
  if (!pricing || !usage) return undefined;
  const divisor =
    usage.allocationDivisor && usage.allocationDivisor > 0 ? usage.allocationDivisor : 1;
  const breakdown = pricing.rules.flatMap((rule) => {
    if (
      rule.when?.resolutions &&
      (!context.resolution || !rule.when.resolutions.includes(context.resolution as never))
    )
      return [];
    if (
      rule.when?.qualities &&
      (!context.quality || !rule.when.qualities.includes(context.quality))
    )
      return [];
    const amount = usage.metrics[rule.metric];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return [];
    return [
      {
        metric: rule.metric,
        amount: amount / divisor,
        usd: (amount * rule.usd) / rule.units / divisor,
      },
    ];
  });
  if (!breakdown.length) return undefined;
  return {
    usd: breakdown.reduce((sum, item) => sum + item.usd, 0),
    currency: "USD",
    breakdown,
    pricing,
    calculatedAt: Date.now(),
  };
}
