import { deleteImage, getReferenceImagesByIds, saveImage } from "~/lib/db";
import { enqueueImageEmbedding } from "~/lib/embeddingQueue";
import { beginGenerationUnloadGuard } from "~/lib/generationUnloadGuard";
import { createThumbnailBlob } from "~/lib/imageProcessing";
import { logger } from "~/lib/logging";
import { runGenerationTask } from "~/lib/tasks/runTask";
import type { TaskEvent, TaskRunnerDeps } from "~/lib/tasks/types";
import { useGalleryStore } from "~/stores/galleryStore";
import { useSettingsStore } from "~/stores/settingsStore";
import type { GenerationBackend } from "./generationTypes";

/** Apply a runner event to the gallery store. `updateItem` ignores canceled items. */
function applyEvent(event: TaskEvent): void {
  const { updateItem } = useGalleryStore.getState();
  switch (event.type) {
    case "progress":
      for (const id of event.itemIds) updateItem(id, event.patch);
      return;
    case "completed":
      updateItem(event.itemId, {
        ...event.record,
        status: "completed",
        originalUrl: URL.createObjectURL(event.original),
        originalMimeType: event.original.type,
        thumbnailUrl: URL.createObjectURL(event.thumbnail),
      });
      logger.debug("[image-generation] Stored image", event.record);
      enqueueImageEmbedding(event.itemId);
      return;
    case "failed":
      for (const id of event.itemIds) {
        updateItem(id, { status: "failed", error: event.error, canRetry: event.canRetry });
      }
      return;
  }
}

const deps: TaskRunnerDeps = {
  getApiKey: (provider) =>
    provider === "debug" ? undefined : useSettingsStore.getState().apiKeys[provider],
  async loadReferences(ids) {
    const references = await getReferenceImagesByIds(ids);
    // Only the bytes are needed; release the display URLs straight away.
    for (const reference of references) URL.revokeObjectURL(reference.url);
    return references.map(({ id, blob }) => ({ id, blob }));
  },
  createThumbnail: (original) => createThumbnailBlob(original, 400),
  saveImage,
  deleteImage,
  isCanceled: (itemId) => useGalleryStore.getState().isItemCanceled(itemId),
  emit: applyEvent,
};

/** Runs tasks in this tab. Closing the tab abandons them (the unload guard warns first). */
export const localGenerationBackend: GenerationBackend = {
  async run(tasks) {
    if (tasks.length === 0) return [];
    const endUnloadGuard = beginGenerationUnloadGuard();
    try {
      return await Promise.allSettled(
        tasks.map(async (task) => {
          for (const id of task.itemIds) {
            useGalleryStore
              .getState()
              .updateItem(id, { status: "generating", referenceImageIds: task.referenceImageIds });
          }
          await runGenerationTask(task, deps);
        })
      );
    } finally {
      endUnloadGuard();
    }
  },
  cancel() {
    // The canceled-ID set in galleryStore is what the runner checks.
  },
  dismiss() {
    // Failed items only live in memory locally.
  },
  connect() {
    return () => {};
  },
};
