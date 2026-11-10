import type { AspectRatio, Resolution, StoredModel } from "~/types";

export const ASPECT_RATIOS: { value: AspectRatio; label: string; width: number; height: number }[] =
  [
    { value: "1:1", label: "1:1", width: 1, height: 1 },
    { value: "16:9", label: "16:9", width: 16, height: 9 },
    { value: "9:16", label: "9:16", width: 9, height: 16 },
    { value: "4:3", label: "4:3", width: 4, height: 3 },
    { value: "3:4", label: "3:4", width: 3, height: 4 },
    { value: "21:9", label: "21:9", width: 21, height: 9 },
  ];

const PRIMARY_ASPECT_RATIO_VALUES = ASPECT_RATIOS.map((ratio) => ratio.value);

export const RESOLUTIONS_LABELS: [string, Resolution][] = [
  ["Standard", "1K"],
  ["High", "2K"],
  ["Ultra", "4K"],
];

export const QUALITIES = ["low", "medium", "high", "xhigh", "max"] as const;
export type Quality = (typeof QUALITIES)[number];

export const AR_DIFF_THRESHOLD = 0.1;

/** Symmetric distance between two aspect ratios (w/h). |ln(a/b)| — invariant under inversion,
 *  so 16:9 vs 4:3 and 9:16 vs 3:4 yield the same magnitude. */
export function aspectRatioDistance(arA: number, arB: number): number {
  if (!(arA > 0) || !(arB > 0)) return Infinity;
  return Math.abs(Math.log(arA / arB));
}

/** Simplest integer ratio within 0.5% of positive image dimensions, preserving orientation. */
export function simplifyImageAspectRatio(
  width: number,
  height: number,
  maxLongShortRatio = Infinity
): string {
  const ratio = Math.max(width, height) / Math.min(width, height);
  for (let short = 1; short <= Math.min(width, height); short++) {
    const long = Math.round(ratio * short);
    if (
      long / short <= maxLongShortRatio &&
      aspectRatioDistance(long / short, ratio) <= Math.log(1.005)
    ) {
      return width >= height ? `${long}:${short}` : `${short}:${long}`;
    }
  }
  return `${width}:${height}`;
}

export function aspectRatiosCompatibleForDiff(arA: number, arB: number): boolean {
  return aspectRatioDistance(arA, arB) < AR_DIFF_THRESHOLD;
}

// Helper to get a model by ID from a models array
export function getModel(models: StoredModel[], modelId: string): StoredModel | undefined {
  return models.find((m) => m.id === modelId);
}

// Helper to check if any selected model supports aspect ratios
export function anyModelSupportsAspectRatio(
  models: StoredModel[],
  selectedModelIds: string[]
): boolean {
  return getAspectRatioIntersection(models, selectedModelIds).length > 0;
}

export function getSupportedAspectRatiosForModel(model: StoredModel): string[] {
  if (!model.capabilities.supportsAspectRatios) {
    return [];
  }

  if (
    Array.isArray(model.capabilities.supportedAspectRatios) &&
    model.capabilities.supportedAspectRatios.length > 0
  ) {
    return model.capabilities.supportedAspectRatios;
  }

  // Fallback for un-migrated models or schemas with unknown enum values.
  return PRIMARY_ASPECT_RATIO_VALUES;
}

export function doesModelSupportAspectRatio(model: StoredModel, aspectRatio: string): boolean {
  if (!model.capabilities.supportsAspectRatios) {
    return false;
  }

  if (model.capabilities.allowsArbitraryAspectRatio) {
    const { width, height } = parseAspectRatio(aspectRatio);
    const longShort = Math.max(width, height) / Math.min(width, height);
    const cap = model.capabilities.maxLongShortRatio ?? Infinity;
    return longShort <= cap;
  }

  const supportedRatios = getSupportedAspectRatiosForModel(model);
  return supportedRatios.length === 0 || supportedRatios.includes(aspectRatio);
}

export function parseAspectRatio(ratio: string): { width: number; height: number } {
  const [w, h] = ratio.split(":");
  const width = Number(w);
  const height = Number(h);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 };
  }

  return { width, height };
}

export function getAspectRatioIntersection(
  models: StoredModel[],
  selectedModelIds: string[]
): string[] {
  if (selectedModelIds.length === 0) {
    return PRIMARY_ASPECT_RATIO_VALUES;
  }

  const selectedModels = selectedModelIds
    .map((id) => getModel(models, id))
    .filter((m): m is StoredModel => !!m);

  if (selectedModels.length === 0) return [];
  if (selectedModels.some((m) => !m.capabilities.supportsAspectRatios)) return [];

  // Candidate universe: primaries plus any explicit ratios that non-arbitrary
  // models declare. Arbitrary-AR models don't contribute concrete extras —
  // they're filtered in via the predicate below.
  const candidates = new Set<string>(PRIMARY_ASPECT_RATIO_VALUES);
  for (const m of selectedModels) {
    if (!m.capabilities.allowsArbitraryAspectRatio) {
      for (const r of getSupportedAspectRatiosForModel(m)) candidates.add(r);
    }
  }

  return [...candidates].filter((r) =>
    selectedModels.every((m) => doesModelSupportAspectRatio(m, r))
  );
}

// True when exactly one model is selected and it accepts arbitrary aspect ratios.
// Used to enable the custom WxH picker UI.
export function isSoleArbitraryAspectRatioModel(
  models: StoredModel[],
  selectedModelIds: string[]
): boolean {
  if (selectedModelIds.length !== 1) return false;
  const model = getModel(models, selectedModelIds[0]);
  return !!model?.capabilities.allowsArbitraryAspectRatio;
}

export function getAspectRatioUnion(models: StoredModel[], selectedModelIds: string[]): string[] {
  if (selectedModelIds.length === 0) {
    return PRIMARY_ASPECT_RATIO_VALUES;
  }

  const ratioSet = new Set<string>();

  for (const modelId of selectedModelIds) {
    const model = getModel(models, modelId);
    if (!model) continue;

    for (const ratio of getSupportedAspectRatiosForModel(model)) {
      ratioSet.add(ratio);
    }
  }

  return [...ratioSet];
}

// Helper to check if any selected model supports resolution
export function anyModelSupportsResolution(
  models: StoredModel[],
  selectedModelIds: string[]
): boolean {
  return selectedModelIds.some((modelId) => {
    const model = getModel(models, modelId);
    return model?.capabilities.supportsResolution;
  });
}

// Helper to check if any selected model supports reference images
export function anyModelSupportsReferenceImages(
  models: StoredModel[],
  selectedModelIds: string[]
): boolean {
  if (selectedModelIds.length === 0) return true; // If no models selected, allow reference images by default
  return selectedModelIds.some((modelId) => {
    const model = getModel(models, modelId);
    return model?.capabilities.supportsReferenceImages;
  });
}

export function getStrictReferenceImageLimit(
  models: StoredModel[],
  selectedModelIds: string[]
): number | null {
  if (selectedModelIds.length === 0) {
    return Infinity;
  }

  let limit = Infinity;

  for (const modelId of selectedModelIds) {
    const model = getModel(models, modelId);
    if (!model || !model.capabilities.supportsReferenceImages) {
      return null;
    }

    limit = Math.min(limit, model.capabilities.maxReferenceImages);
  }

  return Number.isFinite(limit) ? limit : Infinity;
}

export function canAttachReferenceCount(
  models: StoredModel[],
  selectedModelIds: string[],
  totalReferenceCount: number
): { allowed: boolean; maxAllowed: number | null } {
  const maxAllowed = getStrictReferenceImageLimit(models, selectedModelIds);

  if (maxAllowed === null) {
    return { allowed: false, maxAllowed: null };
  }

  return {
    allowed: totalReferenceCount <= maxAllowed,
    maxAllowed,
  };
}
