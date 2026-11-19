import type { ImageModelDefinition } from "./modelLibrary";

const STANDARD_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];

export const GOOGLE_IMAGE_MODELS = [
  {
    id: "gemini-nano-banana-2.1",
    provider: "google",
    name: "Nano Banana 2.1",
    icon: "/icons/google.svg",
    capabilities: {
      supportsAspectRatios: true,
      supportedAspectRatios: [...STANDARD_ASPECT_RATIOS, "1:4", "4:1", "1:8", "8:1", "9:21"],
      supportsResolution: true,
      resolutions: ["1K", "2K", "4K"],
      supportsReferenceImages: true,
      maxReferenceImages: 14,
    },
    pricing: {
      currency: "USD",
      source: {
        kind: "model-library",
        url: "https://ai.google.dev/gemini-api/docs/pricing",
        fetchedAt: Date.UTC(2026, 9, 7),
      },
      rules: [
        { metric: "inputTokens", units: 1_000_000, usd: 1.5 },
        { metric: "textOutputTokens", units: 1_000_000, usd: 7.5 },
        { metric: "imageOutputTokens", units: 1_000_000, usd: 30 },
      ],
    },
  },
  {
    id: "gemini-3-pro-image",
    aliases: ["gemini-3-pro-image-preview"],
    provider: "google",
    name: "Gemini 3.0 Pro",
    icon: "/icons/google.svg",
    capabilities: {
      supportsAspectRatios: true,
      supportedAspectRatios: STANDARD_ASPECT_RATIOS,
      supportsResolution: true,
      supportsReferenceImages: true,
      maxReferenceImages: 10,
    },
    pricing: {
      currency: "USD",
      source: {
        kind: "model-library",
        url: "https://ai.google.dev/gemini-api/docs/pricing",
        fetchedAt: Date.UTC(2026, 10, 19),
      },
      rules: [
        { metric: "inputTokens", units: 1_000_000, usd: 2 },
        { metric: "textOutputTokens", units: 1_000_000, usd: 12 },
        { metric: "imageOutputTokens", units: 1_000_000, usd: 120 },
      ],
    },
  },
  {
    id: "gemini-3.1-flash-image",
    aliases: ["gemini-3.1-flash-image-preview"],
    provider: "google",
    name: "Gemini 3.1 Flash",
    icon: "/icons/google.svg",
    capabilities: {
      supportsAspectRatios: true,
      supportedAspectRatios: [
        "1:1",
        "1:4",
        "1:8",
        "2:3",
        "3:2",
        "3:4",
        "4:1",
        "4:3",
        "4:5",
        "5:4",
        "8:1",
        "9:16",
        "16:9",
        "21:9",
      ],
      supportsResolution: true,
      supportsReferenceImages: true,
      maxReferenceImages: 10,
    },
    pricing: {
      currency: "USD",
      source: {
        kind: "model-library",
        url: "https://ai.google.dev/gemini-api/docs/pricing",
        fetchedAt: Date.UTC(2026, 10, 19),
      },
      rules: [
        { metric: "inputTokens", units: 1_000_000, usd: 0.5 },
        { metric: "textOutputTokens", units: 1_000_000, usd: 3 },
        { metric: "imageOutputTokens", units: 1_000_000, usd: 60 },
      ],
    },
  },
] satisfies ImageModelDefinition[];
