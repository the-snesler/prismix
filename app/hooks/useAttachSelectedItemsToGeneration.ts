import { useCallback } from "react";
import { loadImageBlob } from "~/lib/db";
import { logger } from "~/lib/logging";
import { canAttachReferenceCount } from "~/lib/models";
import { useGalleryStore } from "~/stores/galleryStore";
import { useGenerationStore } from "~/stores/generationStore";
import { useSettingsStore } from "~/stores/settingsStore";
import type { AttachSelectedItemsResult, CompletedGalleryItem, ReferenceImage } from "~/types";

export function useAttachSelectedItemsToGeneration() {
  const models = useSettingsStore((s) => s.models);
  const clearSelection = useGalleryStore((s) => s.clearSelection);

  return useCallback(async (): Promise<AttachSelectedItemsResult> => {
    const galleryState = useGalleryStore.getState();
    const selectedSet = new Set(galleryState.selectedItemIds);
    const selectedItems = galleryState.items.filter(
      (item): item is CompletedGalleryItem =>
        item.status === "completed" && selectedSet.has(item.id)
    );

    if (selectedItems.length === 0) {
      return {
        success: false,
        attachedCount: 0,
        maxAllowed: null,
        reason: "No images selected.",
      };
    }

    // Validate against the current state before and after loading: references or
    // model selections may change while the blobs load.
    const checkFit = () => {
      const generationState = useGenerationStore.getState();
      const selectedModelIds = Object.entries(generationState.currentModelSelections)
        .filter(([, count]) => count > 0)
        .map(([modelId]) => modelId);
      const totalReferences = generationState.currentReferenceImages.length + selectedItems.length;
      return canAttachReferenceCount(models, selectedModelIds, totalReferences);
    };
    const notAllowed = (fit: ReturnType<typeof checkFit>): AttachSelectedItemsResult => ({
      success: false,
      attachedCount: 0,
      maxAllowed: fit.maxAllowed,
      reason:
        fit.maxAllowed === null
          ? "One or more selected models do not support reference images."
          : `Selected images exceed the current model limit (${fit.maxAllowed} max).`,
    });

    const initialFit = checkFit();
    if (!initialFit.allowed) return notAllowed(initialFit);

    let blobs: Blob[];
    try {
      blobs = await Promise.all(selectedItems.map((item) => loadImageBlob(item)));
    } catch (error) {
      logger.error("[attach-selected] Failed to load selected images", error);
      return {
        success: false,
        attachedCount: 0,
        maxAllowed: initialFit.maxAllowed,
        reason: "Some selected images could not be loaded.",
      };
    }

    const fit = checkFit();
    if (!fit.allowed) return notAllowed(fit);

    const newReferences: ReferenceImage[] = selectedItems.map((item, index) => ({
      id: crypto.randomUUID(),
      blob: blobs[index],
      url: URL.createObjectURL(blobs[index]),
      name: `${item.modelName} - ${item.prompt.slice(0, 40).trim() || "Image"}`,
    }));

    useGenerationStore.getState().addReferenceImages(newReferences);
    clearSelection();

    return {
      success: true,
      attachedCount: newReferences.length,
      maxAllowed: fit.maxAllowed,
    };
  }, [clearSelection, models]);
}
