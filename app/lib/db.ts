/**
 * App-facing persistence API. Every function delegates to the active
 * `GalleryRepository` (`~/lib/backend`), which is IndexedDB in the browser-only
 * build. Call sites import from here rather than from a concrete backend.
 */
import { getRepository, type GalleryRepository, type ImageBlobVariant } from "~/lib/backend";
import type { CompletedGalleryItem, ReferenceImage } from "~/types";

export type { ImageBlobVariant } from "~/lib/backend";

type Repo = GalleryRepository;
const repo = getRepository;

export const PAGE_SIZE = 30;

// Images
export const saveImage: Repo["saveImage"] = (image) => repo().saveImage(image);
export const importImage: Repo["importImage"] = (image) => repo().importImage(image);
/** Newest first, display-ready. The caller owns the returned URLs (see `revokeImageUrl`). */
export const getImagesPaginated: Repo["getImagesPaginated"] = (limit, offset) =>
  repo().getImagesPaginated(limit, offset);
export const getAllImages: Repo["getAllImages"] = () => repo().getAllImages();
export const getImageById: Repo["getImageById"] = (id) => repo().getImageById(id);
export const getImageBlob: Repo["getImageBlob"] = (id, variant) => repo().getImageBlob(id, variant);
export const getImageStatRecords: Repo["getImageStatRecords"] = () => repo().getImageStatRecords();
export const getImageCount: Repo["getImageCount"] = () => repo().getImageCount();
export const getExistingImageIds: Repo["getExistingImageIds"] = () => repo().getExistingImageIds();
export const getEmbeddingCounts: Repo["getEmbeddingCounts"] = (modelId) =>
  repo().getEmbeddingCounts(modelId);
export const deleteImage: Repo["deleteImage"] = (id) => repo().deleteImage(id);
export const updateImageEmbedding: Repo["updateImageEmbedding"] = (id, embedding, modelId) =>
  repo().updateImageEmbedding(id, embedding, modelId);
export const updateImageCharacters: Repo["updateImageCharacters"] = (id, characterIds) =>
  repo().updateImageCharacters(id, characterIds);
export const updateImageFavorite: Repo["updateImageFavorite"] = (id, isFavorite) =>
  repo().updateImageFavorite(id, isFavorite);
export const updateImageScorecard: Repo["updateImageScorecard"] = (id, scorecard) =>
  repo().updateImageScorecard(id, scorecard);
export const removeImageStyleReferences: Repo["removeImageStyleReferences"] = (styleId) =>
  repo().removeImageStyleReferences(styleId);

/**
 * Load a completed gallery image's bytes. Gallery items carry URLs, not blobs,
 * so anything that needs the binary (attach as reference, editor canvas, diff,
 * upscaling) goes through here. Rejects if the image no longer exists.
 */
export async function loadImageBlob(
  item: Pick<CompletedGalleryItem, "id">,
  variant: ImageBlobVariant = "original"
): Promise<Blob> {
  const blob = await repo().getImageBlob(item.id, variant);
  if (!blob) throw new Error("Image not found");
  return blob;
}

// Reference images
export const saveReferenceImage: Repo["saveReferenceImage"] = (image) =>
  repo().saveReferenceImage(image);
export const getReferenceImagesByIds: Repo["getReferenceImagesByIds"] = (ids) =>
  repo().getReferenceImagesByIds(ids);
export const getAllReferenceImages: Repo["getAllReferenceImages"] = () =>
  repo().getAllReferenceImages();
export const getExistingReferenceImageIds: Repo["getExistingReferenceImageIds"] = () =>
  repo().getExistingReferenceImageIds();
export const deleteReferenceImagesByIds: Repo["deleteReferenceImagesByIds"] = (ids) =>
  repo().deleteReferenceImagesByIds(ids);
export const deleteReferenceImage = (id: string): Promise<void> =>
  repo().deleteReferenceImagesByIds([id]);
export const garbageCollectReferences: Repo["garbageCollectReferences"] = (extraReachableIds) =>
  repo().garbageCollectReferences(extraReachableIds);

// Editor sessions
export const upsertEditorSession: Repo["upsertEditorSession"] = (session) =>
  repo().upsertEditorSession(session);
export const getSessionById: Repo["getSessionById"] = (id) => repo().getSessionById(id);
export const getSessionByGalleryItemId: Repo["getSessionByGalleryItemId"] = (galleryItemId) =>
  repo().getSessionByGalleryItemId(galleryItemId);
export const getAllSessions: Repo["getAllSessions"] = () => repo().getAllSessions();
export const deleteEditorSession: Repo["deleteEditorSession"] = (id) =>
  repo().deleteEditorSession(id);
export const findSessionForImage: Repo["findSessionForImage"] = (imageId) =>
  repo().findSessionForImage(imageId);

/** Release URLs created for display. A no-op for non-`blob:` URLs. */
export function revokeImageUrl(image: CompletedGalleryItem | ReferenceImage): void {
  if ("thumbnailUrl" in image) {
    revokeIfObjectUrl(image.originalUrl);
    revokeIfObjectUrl(image.thumbnailUrl);
    return;
  }

  revokeIfObjectUrl(image.url);
}

function revokeIfObjectUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}
