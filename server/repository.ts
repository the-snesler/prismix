import type { GalleryRepository, ImageBlobVariant } from "~/lib/backend/types";
import { toImageStatRecord, type ImageStatRecord } from "~/lib/stats";
import type {
  CompletedGalleryItem,
  ImageRecord,
  ImageScorecard,
  ReferenceImage,
  StoredEditorSession,
  StoredImageRecord,
} from "~/types";
import { transaction, type Database } from "./db";
import {
  blobToBytes,
  extensionForMime,
  fileSafeId,
  resolveMimeType,
  type FileStore,
} from "./files";

/** Thrown by `saveImage` when the ID already exists. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export interface StoredFile {
  /** Absolute path on disk. */
  path: string;
  mimeType: string;
}

export interface ReferenceMetadata {
  id: string;
  name: string;
  mimeType: string;
  sourceGalleryItemId?: string;
}

/** Fields `PATCH /api/images/:id` may change. `scorecard: null` clears it. */
export interface ImagePatch {
  isFavorite?: boolean;
  characterIds?: string[];
  embedding?: number[];
  embeddingModelId?: string;
  scorecard?: ImageScorecard | null;
}

interface ImageRow {
  id: string;
  created_at: number;
  record: string;
  original_file: string;
  original_mime: string;
  thumbnail_file: string;
  thumbnail_mime: string;
}

interface ReferenceRow {
  id: string;
  name: string;
  mime_type: string;
  file: string;
  source_gallery_item_id: string | null;
}

export function imageFileUrl(id: string, variant: ImageBlobVariant): string {
  return `/api/images/${encodeURIComponent(id)}/${variant}`;
}

export function referenceFileUrl(id: string): string {
  return `/api/references/${encodeURIComponent(id)}`;
}

function withoutBlobs(record: StoredImageRecord | ImageRecord): ImageRecord {
  const { originalBlob: _o, thumbnailBlob: _t, ...rest } = record as StoredImageRecord;
  void _o;
  void _t;
  return rest;
}

function parseRecord(row: Pick<ImageRow, "record">): ImageRecord {
  return JSON.parse(row.record) as ImageRecord;
}

function parseIdList(json: unknown): string[] {
  if (typeof json !== "string") return [];
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
}

/**
 * SQLite + filesystem implementation of the app's `GalleryRepository`, used by
 * the hosted server. Image metadata lives in `images.record` as JSON; binaries
 * live under the data directory. Files are written before their row, so a row
 * never points at a missing file (an orphaned file is harmless).
 *
 * Ordering and edge cases mirror `~/lib/backend/indexedDb.ts`.
 */
export class SqliteGalleryRepository implements GalleryRepository {
  /** IDs with a `saveImage` in flight, so a concurrent duplicate can't overwrite its files. */
  private readonly savingIds = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly files: FileStore
  ) {}

  // ---------------------------------------------------------------------------
  // Images

  private getImageRow(id: string): ImageRow | undefined {
    return this.db.prepare("SELECT * FROM images WHERE id = ?").get(id) as ImageRow | undefined;
  }

  private async writeImageFiles(image: StoredImageRecord) {
    const dir = `images/${fileSafeId(image.id)}`;
    const [originalBytes, thumbnailBytes] = await Promise.all([
      blobToBytes(image.originalBlob),
      blobToBytes(image.thumbnailBlob),
    ]);
    const originalMime = resolveMimeType(image.originalBlob.type, originalBytes);
    const thumbnailMime = resolveMimeType(image.thumbnailBlob.type, thumbnailBytes);
    const originalFile = `${dir}/original.${extensionForMime(originalMime)}`;
    const thumbnailFile = `${dir}/thumbnail.${extensionForMime(thumbnailMime)}`;
    await this.files.write(originalFile, originalBytes);
    await this.files.write(thumbnailFile, thumbnailBytes);
    return { dir, originalFile, originalMime, thumbnailFile, thumbnailMime };
  }

  private upsertImageRow(
    image: ImageRecord,
    files: Awaited<ReturnType<SqliteGalleryRepository["writeImageFiles"]>>,
    mode: "insert" | "upsert"
  ): void {
    const sql =
      mode === "insert"
        ? `INSERT INTO images (id, created_at, record, original_file, original_mime, thumbnail_file, thumbnail_mime)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO images (id, created_at, record, original_file, original_mime, thumbnail_file, thumbnail_mime)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, record = excluded.record,
             original_file = excluded.original_file, original_mime = excluded.original_mime,
             thumbnail_file = excluded.thumbnail_file, thumbnail_mime = excluded.thumbnail_mime`;
    this.db
      .prepare(sql)
      .run(
        image.id,
        image.createdAt,
        JSON.stringify(withoutBlobs(image)),
        files.originalFile,
        files.originalMime,
        files.thumbnailFile,
        files.thumbnailMime
      );
  }

  async saveImage(image: StoredImageRecord): Promise<void> {
    if (this.savingIds.has(image.id) || this.getImageRow(image.id)) {
      throw new ConflictError(`Image ${image.id} already exists`);
    }
    this.savingIds.add(image.id);
    try {
      const files = await this.writeImageFiles(image);
      try {
        this.upsertImageRow(image, files, "insert");
      } catch (error) {
        await this.files.removeDir(files.dir);
        throw error;
      }
    } finally {
      this.savingIds.delete(image.id);
    }
  }

  async importImage(image: StoredImageRecord): Promise<void> {
    const previous = this.getImageRow(image.id);
    const files = await this.writeImageFiles(image);
    this.upsertImageRow(image, files, "upsert");
    // A re-import with a different format leaves the old files behind; drop them.
    if (previous) {
      for (const old of [previous.original_file, previous.thumbnail_file]) {
        if (old !== files.originalFile && old !== files.thumbnailFile) await this.files.remove(old);
      }
    }
  }

  private toDisplayImage(row: ImageRow): CompletedGalleryItem {
    const record = parseRecord(row);
    return {
      ...record,
      isFavorite: record.isFavorite ?? false,
      status: "completed",
      originalUrl: imageFileUrl(row.id, "original"),
      originalMimeType: row.original_mime,
      thumbnailUrl: imageFileUrl(row.id, "thumbnail"),
    };
  }

  /** One image as the gallery shows it, or null. */
  getDisplayImage(id: string): CompletedGalleryItem | null {
    const row = this.getImageRow(id);
    return row ? this.toDisplayImage(row) : null;
  }

  async getImagesPaginated(limit: number, offset: number): Promise<CompletedGalleryItem[]> {
    const rows = this.db
      .prepare("SELECT * FROM images ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(Math.max(0, limit), Math.max(0, offset)) as unknown as ImageRow[];
    return rows.map((row) => this.toDisplayImage(row));
  }

  async getAllImages(): Promise<ImageRecord[]> {
    const rows = this.db
      .prepare("SELECT record FROM images ORDER BY created_at DESC, id DESC")
      .all() as unknown as ImageRow[];
    return rows.map(parseRecord);
  }

  async getImageById(id: string): Promise<ImageRecord | null> {
    const row = this.getImageRow(id);
    return row ? parseRecord(row) : null;
  }

  /** Where an image's bytes live on disk, for streaming responses and exports. */
  getImageFile(id: string, variant: ImageBlobVariant): StoredFile | null {
    const row = this.getImageRow(id);
    if (!row) return null;
    return variant === "original"
      ? { path: this.files.resolve(row.original_file), mimeType: row.original_mime }
      : { path: this.files.resolve(row.thumbnail_file), mimeType: row.thumbnail_mime };
  }

  async getImageBlob(id: string, variant: ImageBlobVariant): Promise<Blob | null> {
    const row = this.getImageRow(id);
    if (!row) return null;
    return variant === "original"
      ? this.files.openBlob(row.original_file, row.original_mime)
      : this.files.openBlob(row.thumbnail_file, row.thumbnail_mime);
  }

  async getImageStatRecords(): Promise<ImageStatRecord[]> {
    // Oldest first like the IndexedDB index scan; embeddings dropped in SQL so
    // they're never parsed.
    const rows = this.db
      .prepare(
        "SELECT json_remove(record, '$.embedding') AS record FROM images ORDER BY created_at ASC, id ASC"
      )
      .all() as unknown as ImageRow[];
    return rows.map((row) => toImageStatRecord(parseRecord(row)));
  }

  async getImageCount(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM images").get() as { count: number };
    return row.count;
  }

  async getExistingImageIds(): Promise<Set<string>> {
    const rows = this.db.prepare("SELECT id FROM images").all() as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  async getEmbeddingCounts(modelId: string | null): Promise<{ total: number; indexed: number }> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE
             WHEN json_type(record, '$.embedding') = 'array'
               AND json_array_length(record, '$.embedding') > 0
               AND (?1 IS NULL OR json_extract(record, '$.embeddingModelId') = ?1)
             THEN 1 ELSE 0 END), 0) AS indexed
         FROM images`
      )
      .get(modelId || null) as { total: number; indexed: number };
    return { total: row.total, indexed: row.indexed };
  }

  async deleteImage(id: string): Promise<void> {
    const row = this.getImageRow(id);
    if (!row) return;
    this.db.prepare("DELETE FROM images WHERE id = ?").run(id);
    await this.files.removeDir(`images/${fileSafeId(id)}`);
    // Files written under a different layout (shouldn't happen, but be thorough).
    await this.files.remove(row.original_file);
    await this.files.remove(row.thumbnail_file);
  }

  /** Read-modify-write one record. Returns the updated record, or null if missing. */
  updateImageRecord(id: string, mutate: (record: ImageRecord) => void): ImageRecord | null {
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT record FROM images WHERE id = ?").get(id) as
        | Pick<ImageRow, "record">
        | undefined;
      if (!row) return null;
      const record = parseRecord(row);
      mutate(record);
      this.db
        .prepare("UPDATE images SET record = ?, created_at = ? WHERE id = ?")
        .run(JSON.stringify(record), record.createdAt, id);
      return record;
    });
  }

  /** Apply any subset of the patchable fields atomically (backs `PATCH /api/images/:id`). */
  patchImage(id: string, patch: ImagePatch): ImageRecord | null {
    return this.updateImageRecord(id, (record) => {
      if (patch.isFavorite !== undefined) record.isFavorite = patch.isFavorite;
      if (patch.characterIds !== undefined) {
        record.characterIds = patch.characterIds.length > 0 ? patch.characterIds : undefined;
      }
      if (patch.embedding !== undefined) record.embedding = patch.embedding;
      if (patch.embeddingModelId !== undefined) record.embeddingModelId = patch.embeddingModelId;
      if (patch.scorecard !== undefined) {
        if (patch.scorecard) record.scorecard = patch.scorecard;
        else delete record.scorecard;
      }
    });
  }

  async updateImageEmbedding(id: string, embedding: number[], embeddingModelId: string) {
    this.patchImage(id, { embedding, embeddingModelId });
  }

  async updateImageCharacters(id: string, characterIds: string[]) {
    this.patchImage(id, { characterIds });
  }

  async updateImageFavorite(id: string, isFavorite: boolean) {
    this.patchImage(id, { isFavorite });
  }

  async updateImageScorecard(id: string, scorecard: ImageScorecard | undefined) {
    return this.patchImage(id, { scorecard: scorecard ?? null });
  }

  async removeImageStyleReferences(styleId: string): Promise<void> {
    this.db
      .prepare(
        "UPDATE images SET record = json_remove(record, '$.styleId') WHERE json_extract(record, '$.styleId') = ?"
      )
      .run(styleId);
  }

  // ---------------------------------------------------------------------------
  // Reference images

  private getReferenceRow(id: string): ReferenceRow | undefined {
    return this.db.prepare('SELECT * FROM "references" WHERE id = ?').get(id) as
      | ReferenceRow
      | undefined;
  }

  async saveReferenceImage(image: Omit<ReferenceImage, "url">): Promise<ReferenceImage> {
    const previous = this.getReferenceRow(image.id);
    const bytes = await blobToBytes(image.blob);
    const mimeType = resolveMimeType(image.blob.type, bytes);
    const file = `references/${fileSafeId(image.id)}.${extensionForMime(mimeType)}`;
    await this.files.write(file, bytes);
    this.db
      .prepare(
        `INSERT INTO "references" (id, name, mime_type, file, source_gallery_item_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, mime_type = excluded.mime_type,
           file = excluded.file, source_gallery_item_id = excluded.source_gallery_item_id`
      )
      .run(image.id, image.name, mimeType, file, image.sourceGalleryItemId || null, Date.now());
    if (previous && previous.file !== file) await this.files.remove(previous.file);

    const saved: ReferenceImage = {
      id: image.id,
      blob: image.blob,
      name: image.name,
      url: referenceFileUrl(image.id),
    };
    if (image.sourceGalleryItemId) saved.sourceGalleryItemId = image.sourceGalleryItemId;
    return saved;
  }

  private async rowToReference(row: ReferenceRow): Promise<Omit<ReferenceImage, "url"> | null> {
    const blob = await this.files.openBlob(row.file, row.mime_type);
    if (!blob) return null;
    const ref: Omit<ReferenceImage, "url"> = { id: row.id, blob, name: row.name };
    if (row.source_gallery_item_id) ref.sourceGalleryItemId = row.source_gallery_item_id;
    return ref;
  }

  async getReferenceImagesByIds(ids: string[]): Promise<ReferenceImage[]> {
    const result: ReferenceImage[] = [];
    for (const id of ids) {
      const row = this.getReferenceRow(id);
      const ref = row ? await this.rowToReference(row) : null;
      if (ref) result.push({ ...ref, url: referenceFileUrl(ref.id) });
    }
    return result;
  }

  async getAllReferenceImages(): Promise<Omit<ReferenceImage, "url">[]> {
    const rows = this.db
      .prepare('SELECT * FROM "references" ORDER BY id')
      .all() as unknown as ReferenceRow[];
    const refs = await Promise.all(rows.map((row) => this.rowToReference(row)));
    return refs.filter((ref): ref is Omit<ReferenceImage, "url"> => ref !== null);
  }

  /** Reference metadata without bytes, ordered by ID. */
  listReferenceMetadata(): ReferenceMetadata[] {
    const rows = this.db
      .prepare('SELECT id, name, mime_type, source_gallery_item_id FROM "references" ORDER BY id')
      .all() as unknown as ReferenceRow[];
    return rows.map((row) => {
      const meta: ReferenceMetadata = { id: row.id, name: row.name, mimeType: row.mime_type };
      if (row.source_gallery_item_id) meta.sourceGalleryItemId = row.source_gallery_item_id;
      return meta;
    });
  }

  /** Where a reference's bytes live on disk, plus its metadata. */
  getReferenceFile(id: string): (StoredFile & ReferenceMetadata) | null {
    const row = this.getReferenceRow(id);
    if (!row) return null;
    const file: StoredFile & ReferenceMetadata = {
      id: row.id,
      name: row.name,
      mimeType: row.mime_type,
      path: this.files.resolve(row.file),
    };
    if (row.source_gallery_item_id) file.sourceGalleryItemId = row.source_gallery_item_id;
    return file;
  }

  async getExistingReferenceImageIds(): Promise<Set<string>> {
    const rows = this.db.prepare('SELECT id FROM "references"').all() as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  async deleteReferenceImagesByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const select = this.db.prepare('SELECT file FROM "references" WHERE id = ?');
    const remove = this.db.prepare('DELETE FROM "references" WHERE id = ?');
    const files = transaction(this.db, () => {
      const deleted: string[] = [];
      for (const id of ids) {
        const row = select.get(id) as { file: string } | undefined;
        if (!row) continue;
        remove.run(id);
        deleted.push(row.file);
      }
      return deleted;
    });
    await Promise.all(files.map((file) => this.files.remove(file)));
  }

  // Same reachability roots as the IndexedDB implementation: image reference
  // lists, editor sessions, and caller-supplied IDs (characters/styles live in settings).
  async garbageCollectReferences(extraReachableIds: Iterable<string>): Promise<number> {
    const reachable = new Set<string>(extraReachableIds);

    const imageRows = this.db
      .prepare(
        `SELECT json_extract(record, '$.referenceImageIds') AS refs,
                json_extract(record, '$.manualReferenceImageIds') AS manual
         FROM images`
      )
      .all() as Array<{ refs: unknown; manual: unknown }>;
    for (const row of imageRows) {
      if (row.refs == null) continue;
      for (const id of parseIdList(row.refs)) reachable.add(id);
      for (const id of parseIdList(row.manual)) reachable.add(id);
    }

    // Queued, running, and failed (retryable) jobs haven't produced an image yet,
    // but still need their references.
    const jobRows = this.db
      .prepare(
        `SELECT json_extract(item, '$.referenceImageIds') AS refs,
                json_extract(item, '$.manualReferenceImageIds') AS manual
         FROM items
         UNION ALL
         SELECT json_extract(task, '$.referenceImageIds') AS refs, NULL AS manual
         FROM jobs WHERE status IN ('queued', 'running')`
      )
      .all() as Array<{ refs: unknown; manual: unknown }>;
    for (const row of jobRows) {
      for (const id of parseIdList(row.refs)) reachable.add(id);
      for (const id of parseIdList(row.manual)) reachable.add(id);
    }

    for (const session of await this.getAllSessions()) {
      if (session.sourceReferenceId) reachable.add(session.sourceReferenceId);
      for (const id of session.additionalReferenceIds ?? []) reachable.add(id);
      for (const turn of session.turns ?? []) {
        if (turn.sourceReferenceId) reachable.add(turn.sourceReferenceId);
      }
    }

    const orphans = [...(await this.getExistingReferenceImageIds())].filter(
      (id) => !reachable.has(id)
    );
    if (orphans.length === 0) return 0;
    await this.deleteReferenceImagesByIds(orphans);
    return orphans.length;
  }

  // ---------------------------------------------------------------------------
  // Editor sessions

  private parseSessions(rows: Array<{ data: string }>): StoredEditorSession[] {
    return rows.map((row) => JSON.parse(row.data) as StoredEditorSession);
  }

  async upsertEditorSession(session: StoredEditorSession): Promise<string> {
    // Prefer reusing an existing session for the same source image to avoid
    // accumulating duplicate sessions across page loads.
    const existing = session.sourceGalleryItemId
      ? await this.getSessionByGalleryItemId(session.sourceGalleryItemId)
      : await this.getSessionById(session.id);

    const record: StoredEditorSession = {
      ...session,
      id: existing?.id ?? session.id,
      savedAt: Date.now(),
    };

    this.db
      .prepare(
        `INSERT INTO sessions (id, source_gallery_item_id, data, saved_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET source_gallery_item_id = excluded.source_gallery_item_id,
           data = excluded.data, saved_at = excluded.saved_at`
      )
      .run(record.id, record.sourceGalleryItemId ?? null, JSON.stringify(record), record.savedAt);
    return record.id;
  }

  async getSessionById(id: string): Promise<StoredEditorSession | null> {
    const row = this.db.prepare("SELECT data FROM sessions WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as StoredEditorSession) : null;
  }

  async getSessionByGalleryItemId(galleryItemId: string): Promise<StoredEditorSession | null> {
    const row = this.db
      .prepare("SELECT data FROM sessions WHERE source_gallery_item_id = ? ORDER BY id LIMIT 1")
      .get(galleryItemId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as StoredEditorSession) : null;
  }

  async getAllSessions(): Promise<StoredEditorSession[]> {
    const rows = this.db.prepare("SELECT data FROM sessions ORDER BY id").all() as Array<{
      data: string;
    }>;
    return this.parseSessions(rows);
  }

  async deleteEditorSession(id: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  async findSessionForImage(imageId: string): Promise<StoredEditorSession | null> {
    const sessions = await this.getAllSessions();
    return (
      sessions.find(
        (s) =>
          s.sourceGalleryItemId === imageId ||
          s.turns.some((t) => t.sourceItemId === imageId || t.itemIds.includes(imageId))
      ) ?? null
    );
  }
}
