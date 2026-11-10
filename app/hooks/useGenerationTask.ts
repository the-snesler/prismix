import { useCallback } from "react";
import { getGenerationBackend } from "~/lib/backend/generation";
import { getModel } from "~/lib/models";
import type { GenerationTask, ImageGenerationTask } from "~/lib/tasks/types";
import { useGalleryStore } from "~/stores/galleryStore";
import { useSettingsStore } from "~/stores/settingsStore";

export type { GenerationTask, ImageGenerationTask, UpscaleTask } from "~/lib/tasks/types";

/** Keep a style ID only while the style still exists. */
export function existingStyleId(styleId: string | undefined): string | undefined {
  if (!styleId) return undefined;
  return useSettingsStore.getState().styles.some((s) => s.id === styleId) ? styleId : undefined;
}

/**
 * Hands resolved tasks to the active generation backend (in the tab, or on the
 * server) and exposes the card-level actions: retry, cancel, dismiss.
 */
export function useGenerationTask() {
  const models = useSettingsStore((s) => s.models);
  const incrementRequestedOutputCount = useSettingsStore((s) => s.incrementRequestedOutputCount);
  const getItem = useGalleryStore((s) => s.getItem);

  const runTasks = useCallback(
    async (tasks: GenerationTask[]): Promise<PromiseSettledResult<void>[]> => {
      if (tasks.length === 0) return [];
      incrementRequestedOutputCount(tasks.reduce((sum, t) => sum + t.itemIds.length, 0));
      return getGenerationBackend().run(tasks);
    },
    [incrementRequestedOutputCount]
  );

  const retryItem = useCallback(
    async (itemId: string) => {
      const item = getItem(itemId);
      if (!item || item.status !== "failed") return;

      const model = getModel(models, item.modelId);
      if (!model) return;

      const task: ImageGenerationTask = {
        kind: "image",
        itemIds: [itemId],
        modelId: item.modelId,
        modelName: item.modelName,
        provider: model.provider,
        prompt: item.prompt,
        basePrompt: item.basePrompt,
        variationReplacements: item.variationReplacements,
        styleId: existingStyleId(item.styleId),
        manualReferenceImageIds: item.manualReferenceImageIds,
        characterIds: item.characterIds,
        aspectRatio: item.aspectRatio,
        resolution: item.resolution,
        quality: item.quality ?? null,
        modelOptions: item.modelOptions,
        numberOfImages: 1,
        referenceImageIds: item.referenceImageIds,
        capabilities: model.capabilities,
        schemaMapping: model.schemaMapping,
      };

      await runTasks([task]);
    },
    [getItem, models, runTasks]
  );

  const cancelItem = useCallback((itemId: string) => {
    useGalleryStore.getState().cancelItem(itemId);
    getGenerationBackend().cancel(itemId);
  }, []);

  const dismissItem = useCallback((itemId: string) => {
    useGalleryStore.getState().dismissItem(itemId);
    getGenerationBackend().dismiss(itemId);
  }, []);

  return { runTasks, retryItem, cancelItem, dismissItem };
}
