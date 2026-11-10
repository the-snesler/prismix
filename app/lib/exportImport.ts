import JSZip from "jszip";
import mime from "mime/lite";
import type { StoredImageRecord } from "~/types";
import {
  ARCHIVE_INFO_FILE,
  CHARACTERS_FILE,
  CUSTOM_STYLES_FILE,
  MANIFEST_FILE,
  REFERENCES_MANIFEST_FILE,
  archiveFilename,
  archiveInfo,
  emptyImportResult,
  entryExtension,
  imageEntryName,
  manifestEntryToRecord,
  parseCharacters,
  parseCustomStyles,
  parseManifest,
  parseReferencesManifest,
  referenceEntryName,
  toManifestEntry,
  toReferencesManifestEntry,
  type ImportProgress,
  type ImportResult,
  type ManifestEntry,
  type ReferencesManifestEntry,
} from "./archive/manifest";
import { isServerBackend } from "./backend/mode";
import { uploadAndImportArchive } from "./backend/archiveUpload";
import { flushSettings } from "./backend/settingsStorage";
import {
  getAllImages,
  getImageBlob,
  getAllReferenceImages,
  getExistingImageIds,
  getExistingReferenceImageIds,
  importImage,
  saveReferenceImage,
} from "./db";
import { createThumbnailBlob } from "./imageProcessing";
import { useSettingsStore } from "~/stores/settingsStore";

export type { ImportProgress, ImportResult } from "./archive/manifest";

function downloadUrl(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function exportAllImages(
  onProgress?: (current: number, total: number) => void
): Promise<void> {
  // The server streams the archive straight from disk; the browser just downloads it.
  if (isServerBackend) {
    downloadUrl("/api/export", archiveFilename());
    return;
  }

  const images = await getAllImages();
  if (images.length === 0) return;

  const zip = new JSZip();
  const manifest: ManifestEntry[] = [];

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    // Loaded one at a time so the export never holds every original in memory at once
    // (JSZip still buffers the archive itself).
    const originalBlob = await getImageBlob(image.id, "original");
    if (originalBlob) {
      const filename = imageEntryName(image.id, mime.getExtension(originalBlob.type) || "png");
      zip.file(filename, originalBlob);
      manifest.push(toManifestEntry(image, filename));
    }

    onProgress?.(i + 1, images.length);
  }

  zip.file(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  const referenceImages = await getAllReferenceImages();
  const referencesManifest: ReferencesManifestEntry[] = [];
  for (const ref of referenceImages) {
    const filename = referenceEntryName(ref.id, mime.getExtension(ref.blob.type) || "png");
    zip.file(filename, ref.blob);
    referencesManifest.push(toReferencesManifestEntry(ref, filename));
  }
  zip.file(REFERENCES_MANIFEST_FILE, JSON.stringify(referencesManifest, null, 2));

  const { characters, styles } = useSettingsStore.getState();
  zip.file(CHARACTERS_FILE, JSON.stringify(characters, null, 2));
  zip.file(
    CUSTOM_STYLES_FILE,
    JSON.stringify(
      styles.filter((s) => s.isCustom),
      null,
      2
    )
  );
  zip.file(ARCHIVE_INFO_FILE, JSON.stringify(archiveInfo(), null, 2));

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  downloadUrl(url, archiveFilename());
  URL.revokeObjectURL(url);
}

export interface ImportOptions {
  onProgress?: (progress: ImportProgress) => void;
  /** Server builds: cancels the upload, or the import running on the server. */
  signal?: AbortSignal;
}

/** Server builds: upload the archive in chunks and let the server unpack it. */
async function importOnServer(file: File, options: ImportOptions): Promise<ImportResult> {
  // The server merges into its stored settings; send any pending local change first.
  await flushSettings();
  const result = await uploadAndImportArchive(file, options);
  // The server merged characters and styles into the stored settings; pick them up
  // before anything here writes settings back.
  await useSettingsStore.persist.rehydrate();
  return result;
}

export async function importFromZip(
  file: File,
  options: ImportOptions = {}
): Promise<ImportResult> {
  if (isServerBackend) return importOnServer(file, options);
  const { onProgress } = options;

  const zip = await JSZip.loadAsync(file);

  const manifestFile = zip.file(MANIFEST_FILE);
  if (!manifestFile) {
    throw new Error(`Invalid archive: missing ${MANIFEST_FILE}`);
  }

  const { entries: manifest, invalid } = parseManifest(await manifestFile.async("text"));

  const referencesManifestFile = zip.file(REFERENCES_MANIFEST_FILE);
  const references = referencesManifestFile
    ? parseReferencesManifest(await referencesManifestFile.async("text"))
    : null;

  const existingIds = await getExistingImageIds();
  const result = emptyImportResult();
  result.failed += invalid + (references?.invalid ?? 0);
  const total = manifest.length + (references?.entries.length ?? 0);
  let done = 0;
  onProgress?.({ phase: "importing", loaded: 0, total });

  for (let i = 0; i < manifest.length; i++) {
    const entry = manifest[i];
    onProgress?.({ phase: "importing", loaded: ++done, total });

    if (existingIds.has(entry.id)) {
      result.skipped++;
      continue;
    }

    try {
      const imageFile = zip.file(entry.filename);
      if (!imageFile) {
        result.failed++;
        continue;
      }

      const arrayBuffer = await imageFile.async("arraybuffer");
      const originalBlob = new Blob([arrayBuffer], {
        type: mime.getType(entryExtension(entry.filename)) || "application/octet-stream",
      });
      const thumbnailBlob = await createThumbnailBlob(originalBlob, 400);

      const record: StoredImageRecord = {
        ...manifestEntryToRecord(entry),
        originalBlob,
        thumbnailBlob,
      };

      await importImage(record);
      result.imported++;
    } catch {
      result.failed++;
    }
  }

  if (references) {
    const existingRefIds = await getExistingReferenceImageIds();

    for (const entry of references.entries) {
      onProgress?.({ phase: "importing", loaded: ++done, total });
      if (existingRefIds.has(entry.id)) {
        result.skipped++;
        continue;
      }
      try {
        const refFile = zip.file(entry.filename);
        if (!refFile) {
          result.failed++;
          continue;
        }
        const arrayBuffer = await refFile.async("arraybuffer");
        const blob = new Blob([arrayBuffer], {
          type: mime.getType(entryExtension(entry.filename)) || "application/octet-stream",
        });
        await saveReferenceImage({
          id: entry.id,
          name: entry.name,
          blob,
          sourceGalleryItemId: entry.sourceGalleryItemId,
        });
        result.referencesImported++;
      } catch {
        result.failed++;
      }
    }
  }

  const { importCharacters, importCustomStyles } = useSettingsStore.getState();

  const charsFile = zip.file(CHARACTERS_FILE);
  if (charsFile) {
    const chars = parseCharacters(await charsFile.async("text"));
    const before = useSettingsStore.getState().characters.length;
    importCharacters(chars);
    result.charactersImported = useSettingsStore.getState().characters.length - before;
  }

  const stylesFile = zip.file(CUSTOM_STYLES_FILE);
  if (stylesFile) {
    const importedStyles = parseCustomStyles(await stylesFile.async("text"));
    const before = useSettingsStore.getState().styles.filter((s) => s.isCustom).length;
    importCustomStyles(importedStyles);
    result.stylesImported =
      useSettingsStore.getState().styles.filter((s) => s.isCustom).length - before;
  }

  return result;
}
