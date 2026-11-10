import JSZip from "jszip";
import mime from "mime/lite";
import type { ImageRecord, StoredCharacter, StoredImageRecord, StoredStyle } from "~/types";
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

// Derived from ImageRecord so any new field added there is automatically
// included in the export manifest. The binaries live as separate files inside the zip.
type ManifestEntry = ImageRecord & {
  filename: string;
};

type ReferencesManifestEntry = {
  id: string;
  name: string;
  filename: string;
  sourceGalleryItemId?: string;
};

export async function exportAllImages(
  onProgress?: (current: number, total: number) => void
): Promise<void> {
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
      const ext = mime.getExtension(originalBlob.type) || "png";
      const filename = `images/${image.id}.${ext}`;
      zip.file(filename, originalBlob);

      // Spread the whole record so any new fields on ImageRecord round-trip
      // through export without needing to be added here.
      manifest.push({ ...image, filename });
    }

    onProgress?.(i + 1, images.length);
  }

  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const referenceImages = await getAllReferenceImages();
  const referencesManifest: ReferencesManifestEntry[] = [];
  for (const ref of referenceImages) {
    const ext = mime.getExtension(ref.blob.type) || "png";
    const filename = `references/${ref.id}.${ext}`;
    zip.file(filename, ref.blob);
    const entry: ReferencesManifestEntry = { id: ref.id, name: ref.name, filename };
    if (ref.sourceGalleryItemId) entry.sourceGalleryItemId = ref.sourceGalleryItemId;
    referencesManifest.push(entry);
  }
  zip.file("references-manifest.json", JSON.stringify(referencesManifest, null, 2));

  const { characters, styles } = useSettingsStore.getState();
  zip.file("characters.json", JSON.stringify(characters, null, 2));
  const customStyles = styles.filter((s) => s.isCustom);
  zip.file("custom-styles.json", JSON.stringify(customStyles, null, 2));

  const blob = await zip.generateAsync({ type: "blob" });
  const date = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `prismix-export-${date}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export interface ImportResult {
  imported: number;
  referencesImported: number;
  charactersImported: number;
  stylesImported: number;
  skipped: number;
  failed: number;
}

export async function importFromZip(
  file: File,
  onProgress?: (current: number, total: number) => void
): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(file);

  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) {
    throw new Error("Invalid archive: missing manifest.json");
  }

  const manifestText = await manifestFile.async("text");
  const manifest: ManifestEntry[] = JSON.parse(manifestText);

  const existingIds = await getExistingImageIds();
  const result: ImportResult = {
    imported: 0,
    referencesImported: 0,
    charactersImported: 0,
    stylesImported: 0,
    skipped: 0,
    failed: 0,
  };

  for (let i = 0; i < manifest.length; i++) {
    const entry = manifest[i];
    onProgress?.(i + 1, manifest.length);

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

      const ext = entry.filename.split(".").pop() || "png";
      const arrayBuffer = await imageFile.async("arraybuffer");
      const originalBlob = new Blob([arrayBuffer], {
        type: mime.getType(ext) || "application/octet-stream",
      });
      const thumbnailBlob = await createThumbnailBlob(originalBlob, 400);

      // Spread the manifest entry so any new fields added to StoredImageRecord
      // round-trip through import without needing to be added here.
      const { filename: _f, ...entryRest } = entry;
      void _f;
      const record: StoredImageRecord = {
        ...entryRest,
        originalBlob,
        thumbnailBlob,
        referenceImageIds: entry.referenceImageIds ?? [],
        metadata: entry.metadata ?? {},
      };

      await importImage(record);
      result.imported++;
    } catch {
      result.failed++;
    }
  }

  const referencesManifestFile = zip.file("references-manifest.json");
  if (referencesManifestFile) {
    const referencesManifest: ReferencesManifestEntry[] = JSON.parse(
      await referencesManifestFile.async("text")
    );
    const existingRefIds = await getExistingReferenceImageIds();

    for (const entry of referencesManifest) {
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
        const ext = entry.filename.split(".").pop() || "png";
        const arrayBuffer = await refFile.async("arraybuffer");
        const blob = new Blob([arrayBuffer], {
          type: mime.getType(ext) || "application/octet-stream",
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

  const charsFile = zip.file("characters.json");
  if (charsFile) {
    const chars: StoredCharacter[] = JSON.parse(await charsFile.async("text"));
    const before = useSettingsStore.getState().characters.length;
    importCharacters(chars);
    result.charactersImported = useSettingsStore.getState().characters.length - before;
  }

  const stylesFile = zip.file("custom-styles.json");
  if (stylesFile) {
    const importedStyles: StoredStyle[] = JSON.parse(await stylesFile.async("text"));
    const before = useSettingsStore.getState().styles.filter((s) => s.isCustom).length;
    importCustomStyles(importedStyles);
    result.stylesImported =
      useSettingsStore.getState().styles.filter((s) => s.isCustom).length - before;
  }

  return result;
}
