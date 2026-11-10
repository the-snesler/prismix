import type { AspectRatio, ModelOptionValues, ReferenceImage, Resolution } from "~/types";

interface GenerationSignatureInput {
  prompt: string;
  modelSelections: Record<string, number>;
  aspectRatio: AspectRatio | null;
  resolution: Resolution;
  /** Resolved per-model options (including quality and images per call). */
  modelOptions?: Record<string, ModelOptionValues>;
  referenceImages: ReferenceImage[];
  styleId?: string | null;
  characterIds?: string[];
  reuseSentPrompt?: boolean;
}

export function buildGenerationSignature(input: GenerationSignatureInput): string {
  const normalizedSelections = Object.entries(input.modelSelections)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  const normalizedReferenceIds = input.referenceImages.map((image) => image.id).sort();
  const normalizedCharacterIds = [...(input.characterIds ?? [])].sort();

  return JSON.stringify({
    prompt: input.prompt.trim(),
    selections: normalizedSelections,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    modelOptions: Object.entries(input.modelOptions ?? {})
      .filter(([, values]) => Object.keys(values).length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([modelId, values]) => [
        modelId,
        Object.entries(values).sort(([a], [b]) => a.localeCompare(b)),
      ]),
    referenceImageIds: normalizedReferenceIds,
    styleId: input.styleId ?? null,
    characterIds: normalizedCharacterIds,
    reuseSentPrompt: input.reuseSentPrompt ?? false,
  });
}
