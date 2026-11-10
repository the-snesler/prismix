import { useCallback } from "react";
import { useSettingsStore } from "~/stores/settingsStore";
import { useGalleryStore } from "~/stores/galleryStore";
import { doesModelSupportAspectRatio, getModel } from "~/lib/models";
import { getGenerationBackend } from "~/lib/backend/generation";
import { saveReferenceImage } from "~/lib/db";
import { preparePromptBatch } from "~/lib/promptPreparation";
import { createLoadingPreview } from "~/lib/imageProcessing";
import type { AspectRatio, GalleryItem, Resolution, StoredUpscaler } from "~/types";
import {
  useGenerationTask,
  type ImageGenerationTask,
  type UpscaleTask,
} from "~/hooks/useGenerationTask";

export function useEditorGeneration() {
  const models = useSettingsStore((s) => s.models);
  const alwaysImprovePromptEnabled = useSettingsStore((s) => s.alwaysImprovePromptEnabled);
  const replicateKey = useSettingsStore((s) => s.apiKeys.replicate);
  const addItems = useGalleryStore((s) => s.addItems);
  const updatePendingPromptFields = useGalleryStore((s) => s.updatePendingPromptFields);
  const updatePendingPhase = useGalleryStore((s) => s.updatePendingPhase);
  const { runTasks } = useGenerationTask();

  /**
   * Prepare and execute an edit turn.
   *
   * Synchronously creates pending gallery items and calls `onItemsCreated`
   * with their IDs before any async work begins, so the caller can immediately
   * register the turn in the editor store.
   */
  const generateEdit = useCallback(
    async (params: {
      instruction: string;
      /** Original user-typed instruction before any improvement. When set, stored as
       *  basePrompt on resulting gallery items so the lightbox can show it. */
      basePrompt?: string;
      referenceBlob: Blob;
      referenceId: string;
      /** Gallery item ID that the source blob was derived from, if any */
      sourceGalleryItemId?: string;
      additionalReferences?: Array<{
        id: string;
        blob: Blob;
        name: string;
        sourceGalleryItemId?: string;
      }>;
      modelSelections: Record<string, number>;
      aspectRatio: AspectRatio | null;
      resolution: Resolution;
      quality: string | null;
      numberOfImages: number;
      skipAutoImprove?: boolean;
      onItemsCreated: (itemIds: string[]) => void;
      onPromptPrepared?: (prompt: string) => void;
    }): Promise<void> => {
      const {
        instruction,
        basePrompt,
        referenceBlob,
        referenceId,
        sourceGalleryItemId,
        additionalReferences,
        modelSelections,
        aspectRatio,
        resolution,
        quality,
        numberOfImages,
        skipAutoImprove,
        onItemsCreated,
        onPromptPrepared,
      } = params;

      // Source image first, then additional references
      const allReferences: Array<{ id: string; blob: Blob; sourceGalleryItemId?: string }> = [
        { id: referenceId, blob: referenceBlob, sourceGalleryItemId },
        ...(additionalReferences ?? []).map((r) => ({
          id: r.id,
          blob: r.blob,
          sourceGalleryItemId: r.sourceGalleryItemId,
        })),
      ];
      const allReferenceIds = allReferences.map((r) => r.id);
      const loadingPreview = await createLoadingPreview(referenceBlob);

      const taskSlots: Array<{
        itemIds: string[];
        modelId: string;
        modelName: string;
        provider: ImageGenerationTask["provider"];
        aspectRatio: ImageGenerationTask["aspectRatio"];
        resolution: ImageGenerationTask["resolution"];
        quality: string | null;
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
        const maxBatch = model.capabilities.maxImagesPerRequest ?? 1;
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
            numberOfImages: perCallImages,
          });

          for (const itemId of itemIds) {
            pendingItems.push({
              id: itemId,
              status: "pending",
              modelId,
              modelName: model.name,
              prompt: instruction,
              basePrompt,
              aspectRatio: taskAspectRatio,
              resolution: taskResolution,
              quality: taskQuality,
              referenceImageIds: allReferenceIds,
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
      onItemsCreated(taskIds);

      // Persist additional references to IndexedDB for retry support
      if (additionalReferences && additionalReferences.length > 0) {
        await Promise.all(
          additionalReferences.map(async (ref) => {
            const saved = await saveReferenceImage(ref);
            URL.revokeObjectURL(saved.url);
          })
        );
      }

      const preparedPrompts = await preparePromptBatch({
        prompt: instruction,
        totalTasks: taskSlots.length,
        images: allReferences.map((r) => r.blob),
        improvePrompt: alwaysImprovePromptEnabled && !skipAutoImprove,
        onStageChange: (stage) => {
          updatePendingPhase(taskIds, stage);
        },
      });

      const sentPrompt = preparedPrompts.prompts[0] ?? instruction;
      if (onPromptPrepared) {
        onPromptPrepared(sentPrompt);
      }

      const displayBasePrompt = basePrompt && sentPrompt !== basePrompt ? basePrompt : undefined;

      const parentGalleryItemIds = allReferences
        .map((r) => r.sourceGalleryItemId)
        .filter((id): id is string => !!id);
      const tasks: ImageGenerationTask[] = taskSlots.map((slot, taskIndex) => {
        const model = getModel(models, slot.modelId);
        return {
          kind: "image",
          itemIds: slot.itemIds,
          modelId: slot.modelId,
          modelName: slot.modelName,
          provider: slot.provider,
          prompt: preparedPrompts.prompts[taskIndex] ?? instruction,
          basePrompt: displayBasePrompt,
          aspectRatio: slot.aspectRatio,
          resolution: slot.resolution,
          quality: slot.quality,
          numberOfImages: slot.numberOfImages,
          referenceImageIds: allReferenceIds,
          parentGalleryItemIds,
          capabilities: model?.capabilities,
          schemaMapping: model?.schemaMapping,
          missingKeyIsFinal: true,
        };
      });

      updatePendingPromptFields(
        tasks.flatMap((task) =>
          task.itemIds.map((id) => ({
            id,
            prompt: task.prompt,
            basePrompt: task.basePrompt,
          }))
        )
      );
      updatePendingPhase(taskIds, undefined);

      await runTasks(tasks);
    },
    [
      addItems,
      alwaysImprovePromptEnabled,
      models,
      runTasks,
      updatePendingPhase,
      updatePendingPromptFields,
    ]
  );

  /**
   * Run an upscale as an editor turn. Synchronously creates a pending gallery
   * item and calls `onItemsCreated` before any async work begins, mirroring
   * `generateEdit`'s contract so the caller can register the turn first.
   *
   * No prompt prep, no model loop — single fixed upscaler, single output.
   */
  const generateUpscale = useCallback(
    async (params: {
      referenceBlob: Blob;
      referenceId: string;
      sourceGalleryItemId?: string;
      upscaler: StoredUpscaler;
      onItemsCreated: (itemIds: string[]) => void;
    }): Promise<void> => {
      const { referenceBlob, referenceId, sourceGalleryItemId, upscaler, onItemsCreated } = params;
      if (!replicateKey) return;

      const itemId = crypto.randomUUID();
      const modelName = `${upscaler.name} ↑`;
      const instruction = `Upscale with ${upscaler.name}`;
      const loadingPreview = await createLoadingPreview(referenceBlob);

      const pendingItem: GalleryItem = {
        id: itemId,
        status: "generating",
        modelId: upscaler.id,
        modelName,
        prompt: instruction,
        aspectRatio: null,
        resolution: null,
        referenceImageIds: [referenceId],
        loadingPreview,
        retryCount: 0,
      };

      addItems([pendingItem]);
      onItemsCreated([itemId]);

      const task: UpscaleTask = {
        kind: "upscale",
        itemIds: [itemId],
        modelId: upscaler.id,
        modelName,
        prompt: instruction,
        referenceImageIds: [referenceId],
        parentGalleryItemIds: sourceGalleryItemId ? [sourceGalleryItemId] : undefined,
        upscaler,
      };
      // Not counted in requestedOutputCount, which tracks image model requests.
      await getGenerationBackend().run([task]);
    },
    [addItems, replicateKey]
  );

  return { generateEdit, generateUpscale };
}
