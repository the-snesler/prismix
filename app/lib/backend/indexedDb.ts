import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  CompletedGalleryItem,
  ImageRecord,
  ImageScorecard,
  ReferenceImage,
  StoredEditorSession,
  StoredImageRecord,
} from "~/types";
import { createThumbnailBlob } from "~/lib/imageProcessing";
import { toImageStatRecord, type ImageStatRecord } from "~/lib/stats";
import type { GalleryRepository, ImageBlobVariant } from "./types";

const DB_NAME = "studio-image-gallery";
const DB_VERSION = 4;

interface LegacyStoredImageRecord {
  id: string;
  blob: Blob;
  prompt: string;
  modelId: string;
  modelName: string;
  aspectRatio: StoredImageRecord["aspectRatio"];
  resolution: StoredImageRecord["resolution"];
  width: number;
  height: number;
  createdAt: number;
  referenceImageIds: string[];
  metadata: Record<string, unknown>;
}

type StoredReferenceRecord = Omit<ReferenceImage, "url">;

interface GalleryDBSchema extends DBSchema {
  images: {
    key: string;
    value: StoredImageRecord | LegacyStoredImageRecord;
    indexes: { byCreatedAt: number; byModel: string };
  };
  references: {
    key: string;
    value: StoredReferenceRecord;
  };
  sessions: {
    key: string;
    value: StoredEditorSession;
    indexes: { by_gallery_item: string };
  };
}

type GalleryDB = IDBPDatabase<GalleryDBSchema>;

let dbPromise: Promise<GalleryDB> | null = null;

function initDB(): Promise<GalleryDB> {
  dbPromise ??= openDB<GalleryDBSchema>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Images store
      if (!db.objectStoreNames.contains("images")) {
        const imageStore = db.createObjectStore("images", { keyPath: "id" });
        imageStore.createIndex("byCreatedAt", "createdAt", { unique: false });
        imageStore.createIndex("byModel", "modelId", { unique: false });
      }

      // Reference images store
      if (!db.objectStoreNames.contains("references")) {
        db.createObjectStore("references", { keyPath: "id" });
      }

      // Editor sessions store (v3)
      if (!db.objectStoreNames.contains("sessions")) {
        const sessionStore = db.createObjectStore("sessions", { keyPath: "id" });
        sessionStore.createIndex("by_gallery_item", "sourceGalleryItemId", { unique: false });
      }

      // v4: no schema change required; `embedding` and `embeddingModelId` are
      // optional fields on existing records. Bumping the version allows future
      // additions to hook the upgrade path.
    },
  }).catch((error) => {
    // Don't cache a failed open; let the next call retry.
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

// Write helpers resolve when the transaction commits, not just when the request
// succeeds (idb's shortcut writes like `db.put` await `tx.done` internally).
// Resolving on commit prevents writes from being lost if the page is closed or
// reloaded mid-transaction.

/**
 * Read-modify-write a single image record in one transaction. Resolves with the
 * updated record after commit, or null if the image no longer exists.
 */
async function updateImage(
  id: string,
  mutate: (record: StoredImageRecord) => void
): Promise<StoredImageRecord | null> {
  const db = await initDB();
  const tx = db.transaction("images", "readwrite");
  const record = (await tx.store.get(id)) as StoredImageRecord | undefined;
  if (!record) {
    await tx.done;
    return null;
  }
  mutate(record);
  await Promise.all([tx.store.put(record), tx.done]);
  return record;
}

function withoutBlobs(record: StoredImageRecord): ImageRecord {
  const { originalBlob: _o, thumbnailBlob: _t, ...rest } = record;
  void _o;
  void _t;
  return rest;
}

function toDisplayImage(stored: StoredImageRecord): CompletedGalleryItem {
  return {
    ...withoutBlobs(stored),
    isFavorite: stored.isFavorite ?? false,
    status: "completed",
    originalUrl: URL.createObjectURL(stored.originalBlob),
    originalMimeType: stored.originalBlob.type,
    thumbnailUrl: URL.createObjectURL(stored.thumbnailBlob),
  };
}

async function normalizeStoredImageRecord(
  db: GalleryDB,
  record: StoredImageRecord | LegacyStoredImageRecord
): Promise<StoredImageRecord> {
  if ("originalBlob" in record && "thumbnailBlob" in record) {
    return record;
  }

  const legacy = record as LegacyStoredImageRecord;
  const thumbnailBlob = await createThumbnailBlob(legacy.blob, 400);

  const normalized: StoredImageRecord = {
    id: legacy.id,
    originalBlob: legacy.blob,
    thumbnailBlob,
    prompt: legacy.prompt,
    modelId: legacy.modelId,
    modelName: legacy.modelName,
    aspectRatio: legacy.aspectRatio,
    resolution: legacy.resolution,
    width: legacy.width,
    height: legacy.height,
    createdAt: legacy.createdAt,
    referenceImageIds: legacy.referenceImageIds ?? [],
    isFavorite: false,
    metadata: legacy.metadata ?? {},
  };

  await db.put("images", normalized);
  return normalized;
}

async function getStoredImage(id: string): Promise<StoredImageRecord | null> {
  const db = await initDB();
  const record = await db.get("images", id);
  return record ? normalizeStoredImageRecord(db, record) : null;
}

async function getAllSessions(): Promise<StoredEditorSession[]> {
  const db = await initDB();
  return db.getAll("sessions");
}

async function getSessionById(id: string): Promise<StoredEditorSession | null> {
  const db = await initDB();
  return (await db.get("sessions", id)) ?? null;
}

async function getSessionByGalleryItemId(
  galleryItemId: string
): Promise<StoredEditorSession | null> {
  const db = await initDB();
  return (await db.getFromIndex("sessions", "by_gallery_item", galleryItemId)) ?? null;
}

async function getExistingReferenceImageIds(): Promise<Set<string>> {
  const db = await initDB();
  return new Set(await db.getAllKeys("references"));
}

async function deleteReferenceImagesByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await initDB();
  const tx = db.transaction("references", "readwrite");
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
}

export const indexedDbRepository: GalleryRepository = {
  // Images
  async saveImage(image) {
    const db = await initDB();
    await db.add("images", image);
  },

  async importImage(image) {
    const db = await initDB();
    await db.put("images", image);
  },

  async getImagesPaginated(limit, offset) {
    const db = await initDB();
    const tx = db.transaction("images", "readonly");
    const raw: Array<StoredImageRecord | LegacyStoredImageRecord> = [];

    let cursor = await tx.store.index("byCreatedAt").openCursor(null, "prev");
    if (cursor && offset > 0) cursor = await cursor.advance(offset);
    while (cursor && raw.length < limit) {
      raw.push(cursor.value);
      cursor = await cursor.continue();
    }

    const records = await Promise.all(raw.map((r) => normalizeStoredImageRecord(db, r)));
    return records.map(toDisplayImage);
  },

  async getAllImages() {
    const db = await initDB();
    const records = (await db.getAllFromIndex("images", "byCreatedAt")).reverse();
    const normalized = await Promise.all(
      records.map((record) => normalizeStoredImageRecord(db, record))
    );
    return normalized.map(withoutBlobs);
  },

  async getImageById(id) {
    const record = await getStoredImage(id);
    return record ? withoutBlobs(record) : null;
  },

  async getImageBlob(id: string, variant: ImageBlobVariant) {
    const record = await getStoredImage(id);
    if (!record) return null;
    return variant === "original" ? record.originalBlob : record.thumbnailBlob;
  },

  async getImageStatRecords(): Promise<ImageStatRecord[]> {
    // Skips legacy normalization (no thumbnail regeneration); the projection
    // drops blobs/embeddings so the stats page doesn't retain them.
    const db = await initDB();
    const records = await db.getAllFromIndex("images", "byCreatedAt");
    return records.map(toImageStatRecord);
  },

  async getImageCount() {
    const db = await initDB();
    return db.count("images");
  },

  async getExistingImageIds() {
    const db = await initDB();
    return new Set(await db.getAllKeys("images"));
  },

  async getEmbeddingCounts(modelId) {
    const db = await initDB();
    const tx = db.transaction("images", "readonly");

    let total = 0;
    let indexed = 0;
    for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
      const record = cursor.value as StoredImageRecord;
      total++;
      if (
        record.embedding &&
        record.embedding.length > 0 &&
        (!modelId || record.embeddingModelId === modelId)
      ) {
        indexed++;
      }
    }
    return { total, indexed };
  },

  async deleteImage(id) {
    const db = await initDB();
    await db.delete("images", id);
  },

  async updateImageEmbedding(id, embedding, embeddingModelId) {
    await updateImage(id, (record) => {
      record.embedding = embedding;
      record.embeddingModelId = embeddingModelId;
    });
  },

  async updateImageCharacters(id, characterIds) {
    await updateImage(id, (record) => {
      record.characterIds = characterIds.length > 0 ? characterIds : undefined;
    });
  },

  async updateImageFavorite(id, isFavorite) {
    await updateImage(id, (record) => {
      record.isFavorite = isFavorite;
    });
  },

  async updateImageScorecard(id, scorecard: ImageScorecard | undefined) {
    const record = await updateImage(id, (record) => {
      if (scorecard) {
        record.scorecard = scorecard;
      } else {
        delete record.scorecard;
      }
    });
    return record ? withoutBlobs(record) : null;
  },

  async removeImageStyleReferences(styleId) {
    const db = await initDB();
    const tx = db.transaction("images", "readwrite");
    for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
      const record = cursor.value as StoredImageRecord;
      if (record.styleId === styleId) {
        delete record.styleId;
        await cursor.update(record);
      }
    }
    await tx.done;
  },

  // Reference images
  async saveReferenceImage(image) {
    const db = await initDB();

    const record: StoredReferenceRecord = {
      id: image.id,
      blob: image.blob,
      name: image.name,
    };
    if (image.sourceGalleryItemId) record.sourceGalleryItemId = image.sourceGalleryItemId;
    await db.put("references", record);

    return {
      ...image,
      url: URL.createObjectURL(image.blob),
    };
  },

  async getReferenceImagesByIds(ids) {
    if (ids.length === 0) return [];

    const db = await initDB();
    const tx = db.transaction("references", "readonly");
    const records = await Promise.all(ids.map((id) => tx.store.get(id)));

    return records
      .filter((record): record is StoredReferenceRecord => record !== undefined)
      .map((record) => ({
        id: record.id,
        blob: record.blob,
        name: record.name,
        url: URL.createObjectURL(record.blob),
        sourceGalleryItemId: record.sourceGalleryItemId,
      }));
  },

  async getAllReferenceImages() {
    const db = await initDB();
    return db.getAll("references");
  },

  getExistingReferenceImageIds,
  deleteReferenceImagesByIds,

  // Reachability roots:
  //   - `images[].referenceImageIds` / `manualReferenceImageIds`
  //   - `sessions[].sourceReferenceId / additionalReferenceIds / turns[].sourceReferenceId`
  //   - caller-supplied IDs (chars/styles live in settingsStore, not IndexedDB)
  //
  // Refs leak through paths that save into the references store without ever
  // attaching to a gallery item (lightbox "Edit" sources, editor turn canvas
  // snapshots, abandoned uploads), so a periodic sweep is the only way to
  // reclaim that space.
  async garbageCollectReferences(extraReachableIds) {
    const db = await initDB();

    const reachable = new Set<string>(extraReachableIds);

    const tx = db.transaction("images", "readonly");
    for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
      const record = cursor.value;
      if (record.referenceImageIds) {
        for (const id of record.referenceImageIds) reachable.add(id);
        for (const id of (record as StoredImageRecord).manualReferenceImageIds ?? [])
          reachable.add(id);
      }
    }

    const sessions = await getAllSessions();
    for (const session of sessions) {
      if (session.sourceReferenceId) reachable.add(session.sourceReferenceId);
      for (const id of session.additionalReferenceIds) reachable.add(id);
      for (const turn of session.turns) {
        if (turn.sourceReferenceId) reachable.add(turn.sourceReferenceId);
      }
    }

    const allRefIds = await getExistingReferenceImageIds();
    const orphans: string[] = [];
    for (const id of allRefIds) if (!reachable.has(id)) orphans.push(id);

    if (orphans.length === 0) return 0;
    await deleteReferenceImagesByIds(orphans);
    return orphans.length;
  },

  // Editor sessions
  async upsertEditorSession(session) {
    const db = await initDB();

    // Prefer reusing an existing session for the same source image to avoid
    // accumulating duplicate sessions across page loads.
    const existing = session.sourceGalleryItemId
      ? await getSessionByGalleryItemId(session.sourceGalleryItemId)
      : await getSessionById(session.id);

    const record: StoredEditorSession = {
      ...session,
      id: existing?.id ?? session.id,
      savedAt: Date.now(),
    };

    await db.put("sessions", record);
    return record.id;
  },

  getSessionById,
  getSessionByGalleryItemId,
  getAllSessions,

  async deleteEditorSession(id) {
    const db = await initDB();
    await db.delete("sessions", id);
  },

  async findSessionForImage(imageId) {
    const sessions = await getAllSessions();
    return (
      sessions.find(
        (s) =>
          s.sourceGalleryItemId === imageId ||
          s.turns.some((t) => t.sourceItemId === imageId || t.itemIds.includes(imageId))
      ) ?? null
    );
  },
};
