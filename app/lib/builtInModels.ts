import type { ModelCapabilities, StoredModel, StoredTextModel, StoredUpscaler } from "~/types";
import { GOOGLE_IMAGE_MODELS } from "./providers/googleModels";
import { resolveLibraryModel } from "./providers/modelLibrary";
import { OPENAI_IMAGE_MODELS } from "./providers/openaiModels";
import { REPLICATE_IMAGE_MODELS } from "./providers/replicateModels";

// Built-in IDs this model replaced, newest first. Users who never loaded an
// intermediate version may still have an older ID stored.
const PREVIOUS_BUILT_IN_IDS: Record<string, string[]> = {
  "openai/gpt-image-2.6-flare": ["openai/gpt-image-2.5-flare", "openai/gpt-image-2"],
};

const IMAGE_MODEL_LIBRARY = [
  ...GOOGLE_IMAGE_MODELS,
  ...OPENAI_IMAGE_MODELS,
  ...REPLICATE_IMAGE_MODELS,
];

const DEFAULT_IMAGE_MODEL_IDS = [
  "google/gemini-nano-banana-2.1",
  "replicate/google/nano-banana-pro",
  "openai/gpt-image-2.6-flare",
  "replicate/black-forest-labs/flux-2-flex",
  "replicate/bytedance/seedream-4.5",
];

export const BUILT_IN_MODELS: StoredModel[] = DEFAULT_IMAGE_MODEL_IDS.map((id) => {
  const definition = IMAGE_MODEL_LIBRARY.find((model) => `${model.provider}/${model.id}` === id);
  if (!definition) throw new Error(`Missing model library definition: ${id}`);

  const resolved = resolveLibraryModel([definition], definition.id);
  if (!resolved) throw new Error(`Could not resolve model library definition: ${id}`);

  return {
    id,
    provider: definition.provider,
    enabled: true,
    ...resolved,
  };
});

export function mergeWithBuiltInModels(models?: StoredModel[]): StoredModel[] {
  if (!models || models.length === 0) {
    return BUILT_IN_MODELS.map((model) => ({ ...model }));
  }

  const existingById = new Map(models.map((model) => [model.id, model]));

  const mergedBuiltIns = BUILT_IN_MODELS.map((builtInModel) => {
    const previous = (PREVIOUS_BUILT_IN_IDS[builtInModel.id] ?? [])
      .map((id) => existingById.get(id))
      .find((model) => model && !model.isCustom);
    const existing = existingById.get(builtInModel.id) ?? previous;

    if (!existing) {
      return { ...builtInModel };
    }

    return {
      icon: existing.icon ?? builtInModel.icon,
      schemaFetched: existing.schemaFetched,
      ...builtInModel,
      enabled: existing.enabled,
    };
  });

  // A previously custom model may now be built in.
  const customModels = models.filter(
    (model) => model.isCustom && !BUILT_IN_MODELS.some((builtIn) => builtIn.id === model.id)
  );

  return [...mergedBuiltIns, ...customModels];
}

export const BUILT_IN_TEXT_MODELS: StoredTextModel[] = [
  {
    id: "google:gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    provider: "google",
    modelId: "gemini-3-flash-preview",
    enabled: true,
    icon: "/icons/google.svg",
  },
  {
    id: "replicate:google/gemini-3-flash",
    name: "Gemini 3 Flash (Replicate)",
    provider: "replicate",
    modelId: "google/gemini-3-flash",
    enabled: false,
    icon: "/icons/google.svg",
  },
  {
    id: "openai:gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    provider: "openai",
    modelId: "gpt-5.4-mini",
    enabled: false,
    icon: "/icons/openai.svg",
  },
];

export function mergeWithBuiltInTextModels(models?: StoredTextModel[]): StoredTextModel[] {
  if (!models || models.length === 0) {
    return BUILT_IN_TEXT_MODELS.map((m) => ({ ...m }));
  }

  const existingById = new Map(models.map((m) => [m.id, m]));

  const mergedBuiltIns = BUILT_IN_TEXT_MODELS.map((builtIn) => {
    const existing = existingById.get(builtIn.id);
    if (!existing) return { ...builtIn };
    return {
      ...builtIn,
      enabled: existing.enabled,
    };
  });

  const customModels = models.filter((m) => m.isCustom);

  const merged = [...mergedBuiltIns, ...customModels];

  // Ensure exactly one enabled: if zero, enable the first built-in; if multiple, keep first.
  const enabledCount = merged.filter((m) => m.enabled).length;
  if (enabledCount === 0 && merged.length > 0) {
    merged[0] = { ...merged[0], enabled: true };
  } else if (enabledCount > 1) {
    let seenEnabled = false;
    for (let i = 0; i < merged.length; i++) {
      if (merged[i].enabled) {
        if (seenEnabled) merged[i] = { ...merged[i], enabled: false };
        else seenEnabled = true;
      }
    }
  }

  return merged;
}

export const BUILT_IN_UPSCALERS: StoredUpscaler[] = [
  {
    id: "real-esrgan-2x",
    name: "Real-ESRGAN 2x",
    replicateId: "nightmareai/real-esrgan",
    scale: 2,
    scaleParam: "scale",
    enabled: true,
  },
  {
    id: "real-esrgan-4x",
    name: "Real-ESRGAN 4x",
    replicateId: "nightmareai/real-esrgan",
    scale: 4,
    scaleParam: "scale",
    enabled: true,
  },
  {
    id: "aura-sr-v2",
    name: "AuraSR 4x",
    replicateId:
      "zsxkib/aura-sr-v2:5c137257cce8d5ce16e8a334b70e9e025106b5580affed0bc7d48940b594e74c",
    scale: null,
    scaleParam: null,
    enabled: true,
  },
  {
    id: "clarity",
    name: "Clarity",
    replicateId:
      "philz1337x/clarity-upscaler:dfad41707589d68ecdccd1dfa600d55a208f9310748e44bfe35b4a6291453d5e",
    scale: null,
    scaleParam: null,
    enabled: true,
  },
];

export function mergeWithBuiltInUpscalers(upscalers?: StoredUpscaler[]): StoredUpscaler[] {
  if (!upscalers || upscalers.length === 0) {
    return BUILT_IN_UPSCALERS.map((u) => ({ ...u }));
  }

  const existingById = new Map(upscalers.map((u) => [u.id, u]));

  const mergedBuiltIns = BUILT_IN_UPSCALERS.map((builtIn) => {
    const existing = existingById.get(builtIn.id);
    if (!existing) return { ...builtIn };
    return { ...builtIn, enabled: existing.enabled };
  });

  const customUpscalers = upscalers.filter((u) => u.isCustom);

  return [...mergedBuiltIns, ...customUpscalers];
}

export const DEFAULT_IMAGE_CAPABILITIES: ModelCapabilities = {
  supportsAspectRatios: true,
  supportsResolution: true,
  supportsReferenceImages: true,
  maxReferenceImages: 10,
};
