import type {
  CompletedGalleryItem,
  ImageRecord,
  ImageScorecard,
  ReferenceImage,
  StoredEditorSession,
  StoredImageRecord,
} from "~/types";
import type { ImageStatRecord } from "~/lib/stats";

export type ImageBlobVariant = "original" | "thumbnail";

/**
 * Persistence for gallery images, reference images, and editor sessions.
 *
 * The browser-only build uses IndexedDB. A server build will implement the same
 * interface over HTTP. Reads that list images never carry binaries: use
 * `getImageBlob` when the bytes are actually needed, so a remote implementation
 * can serve images by URL instead of downloading every original.
 *
 * Methods returning URLs (`getImagesPaginated`, reference images) hand ownership
 * of any object URLs to the caller; release them with `revokeImageUrl`.
 */
export interface GalleryRepository {
  // Images
  /** Insert a new image. Rejects if the ID already exists. */
  saveImage(image: StoredImageRecord): Promise<void>;
  /** Insert or overwrite an image (archive import). */
  importImage(image: StoredImageRecord): Promise<void>;
  /** Newest first, ready to display. */
  getImagesPaginated(limit: number, offset: number): Promise<CompletedGalleryItem[]>;
  /** Every image's metadata, newest first. */
  getAllImages(): Promise<ImageRecord[]>;
  getImageById(id: string): Promise<ImageRecord | null>;
  getImageBlob(id: string, variant: ImageBlobVariant): Promise<Blob | null>;
  /** Slim projection for the stats page; skips legacy normalization. */
  getImageStatRecords(): Promise<ImageStatRecord[]>;
  getImageCount(): Promise<number>;
  getExistingImageIds(): Promise<Set<string>>;
  getEmbeddingCounts(modelId: string | null): Promise<{ total: number; indexed: number }>;
  deleteImage(id: string): Promise<void>;
  /** No-op if the image no longer exists. */
  updateImageEmbedding(id: string, embedding: number[], embeddingModelId: string): Promise<void>;
  updateImageCharacters(id: string, characterIds: string[]): Promise<void>;
  updateImageFavorite(id: string, isFavorite: boolean): Promise<void>;
  /** Resolves with the updated record, or null if the image no longer exists. */
  updateImageScorecard(
    id: string,
    scorecard: ImageScorecard | undefined
  ): Promise<ImageRecord | null>;
  /** Clear a deleted style's ID without changing the saved sent prompt or references. */
  removeImageStyleReferences(styleId: string): Promise<void>;

  // Reference images
  saveReferenceImage(image: Omit<ReferenceImage, "url">): Promise<ReferenceImage>;
  /** Missing IDs are skipped. */
  getReferenceImagesByIds(ids: string[]): Promise<ReferenceImage[]>;
  getAllReferenceImages(): Promise<Omit<ReferenceImage, "url">[]>;
  getExistingReferenceImageIds(): Promise<Set<string>>;
  deleteReferenceImagesByIds(ids: string[]): Promise<void>;
  /**
   * Delete references not reachable from any image, editor session, or
   * `extraReachableIds` (character + style refs, which live in settings).
   * Returns the number deleted.
   */
  garbageCollectReferences(extraReachableIds: Iterable<string>): Promise<number>;

  // Editor sessions
  /**
   * Upsert a session. Returns the ID actually used, which may differ from
   * `session.id` when an existing session for the same source image is reused.
   */
  upsertEditorSession(session: StoredEditorSession): Promise<string>;
  getSessionById(id: string): Promise<StoredEditorSession | null>;
  getSessionByGalleryItemId(galleryItemId: string): Promise<StoredEditorSession | null>;
  getAllSessions(): Promise<StoredEditorSession[]>;
  deleteEditorSession(id: string): Promise<void>;
  /** First session that uses `imageId` as a source, turn reference, or turn output. */
  findSessionForImage(imageId: string): Promise<StoredEditorSession | null>;
}
