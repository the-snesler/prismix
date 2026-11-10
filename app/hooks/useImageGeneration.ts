import { useCallback } from "react";
import { useGalleryStore } from "~/stores/galleryStore";
import { useGenerationStore } from "~/stores/generationStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { saveReferenceImage } from "~/lib/db";
import { buildGenerationSignature } from "~/lib/generationSignature";
import { createLoadingPreview } from "~/lib/imageProcessing";
import { logger } from "~/lib/logging";
import { doesModelSupportAspectRatio, getModel, getStrictReferenceImageLimit } from "~/lib/models";
import { preparePromptBatch } from "~/lib/promptPreparation";
import {
  getDraftModelOptionContext,
  getOptionImagesPerRequestLimit,
  resolveSelectedModelOptions,
} from "~/lib/modelOptions";
import type { GalleryItem, ModelOptionValues } from "~/types";
import { useGenerationTask, type ImageGenerationTask } from "~/hooks/useGenerationTask";

export function useImageGeneration() {
  const models = useSettingsStore((s) => s.models);

  const prompt = useGenerationStore((s) => s.currentPrompt);
  const basePrompt = useGenerationStore((s) => s.currentBasePrompt);
  const modelSelections = useGenerationStore((s) => s.currentModelSelections);
  const aspectRatio = useGenerationStore((s) => s.currentAspectRatio);
  const resolution = useGenerationStore((s) => s.currentResolution);
  const quality = useGenerationStore((s) => s.currentQuality);
  const numberOfImages = useGenerationStore((s) => s.currentNumberOfImages);
  const referenceImages = useGenerationStore((s) => s.currentReferenceImages);
  const startGeneration = useGenerationStore((s) => s.startGeneration);
  const finishGeneration = useGenerationStore((s) => s.finishGeneration);
  const addItems = useGalleryStore((s) => s.addItems);
  const updatePendingPromptFields = useGalleryStore((s) => s.updatePendingPromptFields);
  const updatePendingPhase = useGalleryStore((s) => s.updatePendingPhase);
  const { runTasks, retryItem, cancelItem, dismissItem } = useGenerationTask();

  const persistReferences = useCallback(
    async (
      images: Array<{ id: string; blob: Blob; name: string; sourceGalleryItemId?: string }>
    ) => {
      await Promise.all(
        images.map(async (image) => {
          const saved = await saveReferenceImage(image);
          URL.revokeObjectURL(saved.url);
        })
      );
    },
    []
  );

  const generate = useCallback(async () => {
    const variationsEnabled = useGenerationStore.getState().variationsEnabled;
    const { currentStyleId, currentCharacterIds, currentModelOptions, reuseSentPrompt } =
      useGenerationStore.getState();
    const settings = useSettingsStore.getState();
    const alwaysImprovePromptEnabled = settings.alwaysImprovePromptEnabled;
    const selectedStyle = currentStyleId
      ? (settings.styles.find((s) => s.id === currentStyleId && s.enabled) ?? null)
      : null;
    const selectedCharacters = currentCharacterIds
      .map((id) => settings.characters.find((c) => c.id === id && c.enabled))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);

    const modelOptions = resolveSelectedModelOptions(
      models,
      modelSelections,
      currentModelOptions,
      getDraftModelOptionContext({
        models,
        modelSelections,
        manualReferenceCount: referenceImages.length,
        style: selectedStyle,
        characters: selectedCharacters,
      })
    );

    const signature = buildGenerationSignature({
      prompt,
      modelSelections,
      aspectRatio,
      resolution,
      quality,
      modelOptions,
      numberOfImages,
      referenceImages,
      styleId: currentStyleId,
      characterIds: currentCharacterIds,
      reuseSentPrompt,
    });

    // Count total API calls synchronously.
    let totalTasks = 0;
    for (const [modelId, count] of Object.entries(modelSelections)) {
      if (count === 0) continue;
      const model = getModel(models, modelId);
      if (model) totalTasks += count;
    }
    if (totalTasks === 0) return;

    const originalPrompt = prompt;
    const loadingPreview = referenceImages[0]
      ? await createLoadingPreview(referenceImages[0].blob)
      : undefined;
    const taskSlots: Array<{
      itemIds: string[];
      modelId: string;
      modelName: string;
      provider: ImageGenerationTask["provider"];
      aspectRatio: ImageGenerationTask["aspectRatio"];
      resolution: ImageGenerationTask["resolution"];
      quality: string | null;
      modelOptions: ModelOptionValues;
      numberOfImages: number;
    }> = [];
    const pendingItems: GalleryItem[] = [];

    for (const [modelId, count] of Object.entries(modelSelections)) {
      if (count === 0) continue;
      const model = getModel(models, modelId);
      if (!model) continue;

      const taskResolution = model.capabilities.supportsResolution ? resolution : null;
      const taskAspectRatio =
        aspectRatio && doesModelSupportAspectRatio(model, aspectRatio) ? aspectRatio : null;
      const taskQuality = model.capabilities.supportsQuality ? quality : null;
      const taskOptions = modelOptions[modelId] ?? {};
      const maxBatch = Math.min(
        model.capabilities.maxImagesPerRequest ?? 1,
        getOptionImagesPerRequestLimit(taskOptions)
      );
      const perCallImages = model.capabilities.supportsNumberOfImages
        ? Math.max(1, Math.min(numberOfImages, maxBatch))
        : 1;

      for (let i = 0; i < count; i++) {
        const itemIds = Array.from({ length: perCallImages }, () => crypto.randomUUID());

        taskSlots.push({
          itemIds,
          modelId,
          modelName: model.name,
          provider: model.provider,
          aspectRatio: taskAspectRatio,
          resolution: taskResolution,
          quality: taskQuality,
          modelOptions: taskOptions,
          numberOfImages: perCallImages,
        });

        for (const itemId of itemIds) {
          pendingItems.push({
            id: itemId,
            status: "pending",
            modelId,
            modelName: model.name,
            prompt: originalPrompt,
            aspectRatio: taskAspectRatio,
            resolution: taskResolution,
            quality: taskQuality,
            modelOptions: taskOptions,
            referenceImageIds: referenceImages.map((r) => r.id),
            styleId: selectedStyle?.id,
            manualReferenceImageIds: referenceImages.map((r) => r.id),
            characterIds: selectedCharacters.map((c) => c.id),
            isFavorite: false,
            loadingPreview,
            retryCount: 0,
          });
        }
      }
    }

    if (taskSlots.length === 0) return;
    const taskIds = taskSlots.flatMap((slot) => slot.itemIds);

    addItems(pendingItems);
    startGeneration(signature);
    const generationStartedAt = performance.now();
    logger.info("[image-generation] Started", {
      signature,
      itemIds: taskIds,
      prompt,
      basePrompt,
      modelSelections,
      aspectRatio,
      resolution,
      quality,
      modelOptions,
      numberOfImages,
      referenceImages,
      styleId: currentStyleId,
      characterIds: currentCharacterIds,
      totalTasks,
    });

    try {
      await persistReferences(
        referenceImages.map((image) => ({
          id: image.id,
          blob: image.blob,
          name: image.name,
          sourceGalleryItemId: image.sourceGalleryItemId,
        }))
      );

      const selectedModelIds = Object.entries(modelSelections)
        .filter(([, c]) => c > 0)
        .map(([id]) => id);
      const strictLimit = getStrictReferenceImageLimit(models, selectedModelIds);
      const { avoidPastVariations } = useGenerationStore.getState();
      const { items } = useGalleryStore.getState();
      const preparedPrompts = await preparePromptBatch({
        prompt: originalPrompt,
        totalTasks,
        manualReferenceImages: referenceImages,
        style: selectedStyle,
        characters: selectedCharacters,
        referenceLimit: strictLimit,
        improvePrompt: alwaysImprovePromptEnabled && basePrompt === null && !reuseSentPrompt,
        variationsEnabled,
        avoidPastVariations,
        galleryItemsForAvoid: items,
        onStageChange: (stage) => {
          updatePendingPhase(taskIds, stage);
        },
      });

      const anyTransformApplied =
        preparedPrompts.unifiedPromptAdditions ||
        preparedPrompts.improved ||
        preparedPrompts.usedVariations;
      const groupPrompt =
        basePrompt ??
        (anyTransformApplied || selectedStyle || selectedCharacters.length
          ? originalPrompt
          : undefined);

      const referenceImageIds = preparedPrompts.referenceImages.map((r) => r.id);
      const parentGalleryItemIds = preparedPrompts.referenceImages
        .map((r) => r.sourceGalleryItemId)
        .filter((id): id is string => !!id);

      const tasks: ImageGenerationTask[] = taskSlots.map((slot, taskIndex) => {
        const taskPrompt = preparedPrompts.prompts[taskIndex] ?? originalPrompt;
        const taskReplacements = preparedPrompts.variationReplacementsByTask?.[taskIndex];
        const model = getModel(models, slot.modelId);

        return {
          kind: "image",
          itemIds: slot.itemIds,
          modelId: slot.modelId,
          modelName: slot.modelName,
          provider: slot.provider,
          prompt: taskPrompt,
          basePrompt: groupPrompt,
          variationReplacements: taskReplacements,
          aspectRatio: slot.aspectRatio,
          resolution: slot.resolution,
          quality: slot.quality,
          modelOptions: slot.modelOptions,
          numberOfImages: slot.numberOfImages,
          referenceImageIds,
          parentGalleryItemIds,
          capabilities: model?.capabilities,
          schemaMapping: model?.schemaMapping,
          styleId: selectedStyle?.id,
          manualReferenceImageIds: referenceImages.map((r) => r.id),
          characterIds: selectedCharacters.map((c) => c.id),
        };
      });

      updatePendingPromptFields(
        tasks.flatMap((t) =>
          t.itemIds.map((id) => ({
            id,
            prompt: t.prompt,
            basePrompt: t.basePrompt,
            variationReplacements: t.variationReplacements,
          }))
        )
      );
      updatePendingPhase(taskIds, undefined);

      logger.debug("[image-generation] Prepared tasks", tasks);
      const results = await runTasks(tasks);
      logger.info("[image-generation] Settled", { signature, results });
      return results;
    } finally {
      finishGeneration(signature);
      logger.info("[image-generation] Finished", {
        signature,
        durationMs: Math.round(performance.now() - generationStartedAt),
      });
    }
  }, [
    prompt,
    basePrompt,
    modelSelections,
    aspectRatio,
    resolution,
    quality,
    numberOfImages,
    referenceImages,
    models,
    startGeneration,
    finishGeneration,
    persistReferences,
    runTasks,
    addItems,
    updatePendingPromptFields,
    updatePendingPhase,
  ]);

  return { generate, retryItem, cancelItem, dismissItem };
}
