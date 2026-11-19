import { describe, expect, it } from "vitest";
import { estimateGenerationCost, resolveModelPricing } from "./pricing";

describe("resolveModelPricing", () => {
  it.each([
    "google/gemini-3-pro-image",
    "google/models/gemini-3-pro-image",
    "google/gemini-3-pro-image-preview",
  ])("finds library pricing for %s", async (modelId) => {
    const pricing = await resolveModelPricing("google", modelId);
    expect(pricing?.source.kind).toBe("model-library");
    expect(pricing?.rules).toContainEqual({
      metric: "imageOutputTokens",
      units: 1_000_000,
      usd: 120,
    });
  });
});

describe("estimateGenerationCost", () => {
  it("prices a Gemini 3 Pro Image token breakdown", async () => {
    const pricing = await resolveModelPricing("google", "google/models/gemini-3-pro-image");
    const estimate = estimateGenerationCost(
      pricing,
      { metrics: { inputTokens: 1029, textOutputTokens: 243, imageOutputTokens: 1120 } },
      { resolution: "2K", quality: null }
    );
    expect(estimate?.usd).toBeCloseTo((1029 * 2 + 243 * 12 + 1120 * 120) / 1_000_000, 10);
  });
});
