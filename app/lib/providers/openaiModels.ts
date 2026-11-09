import type { ModelOptionSpecs } from "~/types";
import type { ImageModelDefinition } from "./modelLibrary";

export interface OpenAIImageModelConfig {
  sizeMode: "fixed" | "arbitrary";
}

// https://developers.openai.com/api/docs/guides/image-generation (GPT Image 2.6 section)
const GPT_IMAGE_2_6_OPTIONS = {
  complexity: { kind: "enum", values: ["low", "medium", "high"] },
  outputFormat: { kind: "enum", values: ["standard", "svg", "gif"] },
  gifFrameCount: { kind: "range", min: 2, max: 64, step: 1, default: 9 },
  gifFrameDurationMs: { kind: "range", min: 20, max: 2000, step: 10, default: 200 },
} satisfies ModelOptionSpecs;

export const OPENAI_IMAGE_MODELS = [
  {
    id: "gpt-image-2.6-flare",
    provider: "openai",
    name: "GPT Image 2.6 Flare",
    icon: "/icons/openai.svg",
    capabilities: {
      supportsAspectRatios: true,
      supportedAspectRatios: [],
      allowsArbitraryAspectRatio: true,
      maxLongShortRatio: 3,
      supportsResolution: true,
      supportsReferenceImages: true,
      maxReferenceImages: 16,
      supportsQuality: true,
      supportedQualities: ["low", "medium", "high", "xhigh", "max"],
      supportsNumberOfImages: true,
      maxImagesPerRequest: 10,
      supportsMarkupEdits: true,
      options: GPT_IMAGE_2_6_OPTIONS,
    },
    config: { sizeMode: "arbitrary" },
    pricing: {
      currency: "USD",
      source: {
        kind: "model-library",
        url: "https://developers.openai.com/api/docs/models/gpt-image-2.6-flare",
        fetchedAt: Date.UTC(2026, 10, 4),
      },
      rules: [
        { metric: "textInputTokens", units: 1_000_000, usd: 5 },
        { metric: "imageInputTokens", units: 1_000_000, usd: 8 },
        { metric: "imageOutputTokens", units: 1_000_000, usd: 30 },
      ],
    },
  },
  {
    id: "gpt-image-2.6-sunburst",
    provider: "openai",
    name: "GPT Image 2.6 Sunburst",
    icon: "/icons/openai.svg",
    capabilities: {
      supportsAspectRatios: true,
      supportedAspectRatios: [],
      allowsArbitraryAspectRatio: true,
      maxLongShortRatio: 3,
      supportsResolution: true,
      supportsReferenceImages: true,
      maxReferenceImages: 16,
      supportsQuality: true,
      supportedQualities: ["low", "medium", "high", "xhigh", "max"],
      supportsNumberOfImages: true,
      maxImagesPerRequest: 10,
      supportsMarkupEdits: true,
      options: GPT_IMAGE_2_6_OPTIONS,
    },
    config: { sizeMode: "arbitrary" },
    pricing: {
      currency: "USD",
      source: {
        kind: "model-library",
        url: "https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst",
        fetchedAt: Date.UTC(2026, 10, 4),
      },
      rules: [
        { metric: "textInputTokens", units: 1_000_000, usd: 5 },
        { metric: "imageInputTokens", units: 1_000_000, usd: 8 },
        { metric: "imageOutputTokens", units: 1_000_000, usd: 30 },
      ],
    },
  },
  {
    id: "gpt-image-2.5-flare",
    provider: "openai",
    name: "GPT Image 2.5 Flare",
    icon: "/icons/openai.svg",
    capabilities: {
      supportsAspectRatios: true,
      supportedAspectRatios: [],
      allowsArbitraryAspectRatio: true,
      maxLongShortRatio: 3,
      supportsResolution: true,
      supportsReferenceImages: true,
      maxReferenceImages: 16,
      supportsQuality: true,
      supportedQualities: ["low", "medium", "high", "xhigh", "max"],
      supportsNumberOfImages: true,
      maxImagesPerRequest: 10,
      supportsMarkupEdits: true,
    },
    config: { sizeMode: "arbitrary" },
    pricing: {
      currency: "USD",
      source: {
        kind: "model-library",
        url: "https://developers.openai.com/api/docs/models/gpt-image-2.5-flare",
        fetchedAt: Date.UTC(2026, 8, 19),
      },
      rules: [
        { metric: "textInputTokens", units: 1_000_000, usd: 5 },
        { metric: "imageInputTokens", units: 1_000_000, usd: 8 },
        { metric: "imageOutputTokens", units: 1_000_000, usd: 30 },
      ],
    },
  },
  {
    id: "gpt-image-2.5-sunburst",
    provider: "openai",
    name: "GPT Image 2.5 Sunburst",
    icon: "/icons/openai.svg",
    capabilities: {
      supportsAspectRatios: true,
      supportedAspectRatios: [],
      allowsArbitraryAspectRatio: true,
      maxLongShortRatio: 3,
      supportsResolution: true,
      supportsReferenceImages: true,
      maxReferenceImages: 16,
      supportsQuality: true,
      supportedQualities: ["low", "medium", "high", "xhigh", "max"],
      supportsNumberOfImages: true,
      maxImagesPerRequest: 10,
      supportsMarkupEdits: true,
    },
    config: { sizeMode: "arbitrary" },
    pricing: {
      currency: "USD",
      source: {
        kind: "model-library",
        url: "https://developers.openai.com/api/docs/models/gpt-image-2.5-flare",
        fetchedAt: Date.UTC(2026, 8, 19),
      },
      rules: [
        { metric: "textInputTokens", units: 1_000_000, usd: 5 },
        { metric: "imageInputTokens", units: 1_000_000, usd: 8 },
        { metric: "imageOutputTokens", units: 1_000_000, usd: 30 },
      ],
    },
  },
] satisfies ImageModelDefinition<OpenAIImageModelConfig>[];
