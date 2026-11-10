import fs from "node:fs";
import type { Readable } from "node:stream";
import mime from "mime/lite";
import yauzl from "yauzl";
import yazl from "yazl";
import {
  ARCHIVE_INFO_FILE,
  CHARACTERS_FILE,
  CUSTOM_STYLES_FILE,
  MANIFEST_FILE,
  REFERENCES_MANIFEST_FILE,
  archiveInfo,
  emptyImportResult,
  entryExtension,
  imageEntryName,
  manifestEntryToRecord,
  mergeById,
  parseCharacters,
  parseCustomStyles,
  parseManifest,
  parseReferencesManifest,
  referenceEntryName,
  toManifestEntry,
  toReferencesManifestEntry,
  type ImportResult,
  type ManifestEntry,
  type ReferencesManifestEntry,
} from "~/lib/archive/manifest";
import type { StoredCharacter, StoredStyle } from "~/types";
import type { SqliteGalleryRepository } from "./repository";
import type { SettingsService } from "./settings";

/**
 * Streaming zip export/import in the same format as the browser's
 * (`~/lib/archive/manifest`). Export reads originals straight from disk and stores
 * them uncompressed (they're already compressed images); import reads one entry at
 * a time from a temp file, so neither direction buffers the whole archive.
 */

export interface ArchiveDeps {
  repository: SqliteGalleryRepository;
  settings: SettingsService;
  createThumbnail(original: Blob): Promise<Blob>;
}

/** Larger entries are skipped as failed rather than read into memory. */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024 * 1024;

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2));
}

/** Build the export archive. The returned stream is the zip's bytes. */
export async function createExportStream(deps: ArchiveDeps): Promise<Readable> {
  const { repository, settings } = deps;
  const zip = new yazl.ZipFile();

  const manifest: ManifestEntry[] = [];
  for (const image of await repository.getAllImages()) {
    const file = repository.getImageFile(image.id, "original");
    if (!file || !fs.existsSync(file.path)) continue;
    const filename = imageEntryName(image.id, mime.getExtension(file.mimeType) || "png");
    zip.addFile(file.path, filename, { compress: false });
    manifest.push(toManifestEntry(image, filename));
  }
  zip.addBuffer(json(manifest), MANIFEST_FILE);

  const referencesManifest: ReferencesManifestEntry[] = [];
  for (const reference of repository.listReferenceMetadata()) {
    const file = repository.getReferenceFile(reference.id);
    if (!file || !fs.existsSync(file.path)) continue;
    const filename = referenceEntryName(reference.id, mime.getExtension(file.mimeType) || "png");
    zip.addFile(file.path, filename, { compress: false });
    referencesManifest.push(toReferencesManifestEntry(reference, filename));
  }
  zip.addBuffer(json(referencesManifest), REFERENCES_MANIFEST_FILE);

  const state = settings.readSettingsState();
  const characters = Array.isArray(state?.characters) ? state.characters : [];
  const styles = (Array.isArray(state?.styles) ? state.styles : []) as StoredStyle[];
  zip.addBuffer(json(characters), CHARACTERS_FILE);
  zip.addBuffer(json(styles.filter((style) => style?.isCustom)), CUSTOM_STYLES_FILE);
  zip.addBuffer(json(archiveInfo()), ARCHIVE_INFO_FILE);

  zip.end();
  // A PassThrough at runtime; typed as the looser NodeJS.ReadableStream.
  return zip.outputStream as unknown as Readable;
}

async function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, limit: number): Promise<Buffer> {
  if (entry.uncompressedSize > limit) {
    throw new Error(`${entry.fileName} is too large (${entry.uncompressedSize} bytes)`);
  }
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export interface ImportArchiveOptions {
  /** Called after each image or reference entry with (done, total). */
  onProgress?: (done: number, total: number) => void;
  /** Stops between entries; what was already imported stays. */
  signal?: AbortSignal;
}

/**
 * Import an archive from a file on disk. Existing image and reference IDs are
 * skipped (so re-running an interrupted import is safe); characters and custom
 * styles merge into the stored settings by ID.
 */
export async function importArchive(
  zipPath: string,
  deps: ArchiveDeps,
  options: ImportArchiveOptions = {}
): Promise<ImportResult> {
  const { onProgress, signal } = options;
  const { repository, settings } = deps;
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false });
  } catch (error) {
    throw new ArchiveError(
      `Not a valid zip archive${error instanceof Error ? `: ${error.message}` : ""}`
    );
  }

  try {
    const entries = new Map<string, yauzl.Entry>();
    for await (const entry of zip.eachEntry()) {
      if (!entry.fileName.endsWith("/")) entries.set(entry.fileName, entry);
    }
    const readText = async (name: string): Promise<string | null> => {
      const entry = entries.get(name);
      return entry ? (await readEntry(zip, entry, MAX_JSON_BYTES)).toString("utf8") : null;
    };
    const readBlob = async (filename: string): Promise<Blob | null> => {
      const entry = entries.get(filename);
      if (!entry) return null;
      const type = mime.getType(entryExtension(filename)) || "application/octet-stream";
      return new Blob([new Uint8Array(await readEntry(zip, entry, MAX_ENTRY_BYTES))], { type });
    };

    const manifestText = await readText(MANIFEST_FILE);
    if (manifestText === null) throw new ArchiveError(`Invalid archive: missing ${MANIFEST_FILE}`);
    let parsed: ReturnType<typeof parseManifest>;
    try {
      parsed = parseManifest(manifestText);
    } catch (error) {
      throw new ArchiveError(error instanceof Error ? error.message : String(error));
    }

    const referencesText = await readText(REFERENCES_MANIFEST_FILE);
    const references = referencesText !== null ? parseReferencesManifest(referencesText) : null;

    const result = emptyImportResult();
    result.failed += parsed.invalid + (references?.invalid ?? 0);
    const total = parsed.entries.length + (references?.entries.length ?? 0);
    let done = 0;
    const step = () => {
      done++;
      onProgress?.(done, total);
    };
    onProgress?.(0, total);

    const existingImages = await repository.getExistingImageIds();
    for (const entry of parsed.entries) {
      signal?.throwIfAborted();
      if (existingImages.has(entry.id)) {
        result.skipped++;
        step();
        continue;
      }
      try {
        const originalBlob = await readBlob(entry.filename);
        if (!originalBlob) {
          result.failed++;
          step();
          continue;
        }
        const thumbnailBlob = await deps.createThumbnail(originalBlob);
        await repository.importImage({
          ...manifestEntryToRecord(entry),
          originalBlob,
          thumbnailBlob,
        });
        existingImages.add(entry.id);
        result.imported++;
      } catch (error) {
        console.warn(`Import: skipping image ${entry.id}:`, error);
        result.failed++;
      }
      step();
    }

    if (references) {
      const existingReferences = await repository.getExistingReferenceImageIds();
      for (const entry of references.entries) {
        signal?.throwIfAborted();
        if (existingReferences.has(entry.id)) {
          result.skipped++;
          step();
          continue;
        }
        try {
          const blob = await readBlob(entry.filename);
          if (!blob) {
            result.failed++;
            step();
            continue;
          }
          await repository.saveReferenceImage({
            id: entry.id,
            name: entry.name,
            blob,
            sourceGalleryItemId: entry.sourceGalleryItemId,
          });
          existingReferences.add(entry.id);
          result.referencesImported++;
        } catch (error) {
          console.warn(`Import: skipping reference ${entry.id}:`, error);
          result.failed++;
        }
        step();
      }
    }

    const charactersText = await readText(CHARACTERS_FILE);
    const stylesText = await readText(CUSTOM_STYLES_FILE);
    const characters = charactersText ? parseCharacters(charactersText) : [];
    const styles = stylesText ? parseCustomStyles(stylesText) : [];
    if (characters.length > 0 || styles.length > 0) {
      settings.updateSettingsState((state) => {
        const existingCharacters = (
          Array.isArray(state.characters) ? state.characters : []
        ) as StoredCharacter[];
        const existingStyles = (Array.isArray(state.styles) ? state.styles : []) as StoredStyle[];
        const mergedCharacters = mergeById(existingCharacters, characters);
        const mergedStyles = mergeById(existingStyles, styles);
        result.charactersImported = mergedCharacters.added;
        result.stylesImported = mergedStyles.added;
        return { ...state, characters: mergedCharacters.merged, styles: mergedStyles.merged };
      });
    }

    return result;
  } finally {
    zip.close();
  }
}

/** A problem with the uploaded archive itself (400, not 500). */
export class ArchiveError extends Error {}
