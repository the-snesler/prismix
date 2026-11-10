import { useCallback } from "react";
import { getReferenceImagesByIds } from "~/lib/db";
import { modelOptionsFromSaved } from "~/lib/modelOptions";
import { hasVariationSections } from "~/lib/promptVariations";
import { useGenerationStore } from "~/stores/generationStore";
import { useSettingsStore } from "~/stores/settingsStore";
import type { CompletedGalleryItem } from "~/types";

function useReuseGalleryItem(sent: boolean) {
  return useCallback(
    async (item: CompletedGalleryItem) => {
      const settings = useSettingsStore.getState();
      const style = settings.styles.find((s) => s.id === item.styleId);
      const characters = (item.characterIds ?? [])
        .map((id) => settings.characters.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => c !== undefined);
      // Older images lack manual-reference provenance; exclude known preset references.
      const presetRefIds = new Set([
        ...(style?.referenceImageId ? [style.referenceImageId] : []),
        ...characters.flatMap((c) => c.referenceImageIds),
      ]);
      const referenceIds = sent
        ? item.referenceImageIds
        : (item.manualReferenceImageIds ??
          item.referenceImageIds.filter((id) => !presetRefIds.has(id)));
      const references = await getReferenceImagesByIds(referenceIds);
      const prompt = sent ? item.prompt : (item.basePrompt ?? item.prompt);
      const basePrompt = sent ? (item.basePrompt ?? null) : null;
      useGenerationStore.getState().clearReferenceImages();
      useGenerationStore.setState({
        currentPrompt: prompt,
        currentBasePrompt: basePrompt,
        currentReferenceImages: references,
        currentStyleId: sent ? null : (style?.id ?? null),
        currentCharacterIds: sent ? [] : characters.map((c) => c.id),
        variationsEnabled: !sent && hasVariationSections(prompt),
        reuseSentPrompt: sent,
        currentModelSelections: { [item.modelId]: 1 },
        currentAspectRatio: item.aspectRatio,
        currentResolution: item.resolution ?? "1K",
        currentModelOptions: {
          ...useGenerationStore.getState().currentModelOptions,
          [item.modelId]: modelOptionsFromSaved(item),
        },
      });
    },
    [sent]
  );
}

export function useReuseGalleryItemPrompt() {
  return useReuseGalleryItem(false);
}

export function useReuseGalleryItemSentPrompt() {
  return useReuseGalleryItem(true);
}
