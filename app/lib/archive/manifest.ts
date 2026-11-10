import type { ImageRecord, StoredCharacter, StoredStyle } from "~/types";

/**
 * The gallery archive (.zip) format, shared by the browser's JSZip export/import
 * and the server's streaming one, so archives move freely between the two:
 *
 *   manifest.json              ManifestEntry[]: every ImageRecord field, plus `filename`
 *   images/<id>.<ext>          originals (thumbnails are regenerated on import)
 *   references-manifest.json   ReferencesManifestEntry[]
 *   references/<id>.<ext>
 *   characters.json            StoredCharacter[]
 *   custom-styles.json         StoredStyle[] (custom styles only)
 *   prismix-archive.json       { format: "prismix-archive", version: 1 } (optional)
 *
 * Older builds ignore files they don't know, so adding `prismix-archive.json`
 * keeps new archives importable everywhere.
 */

export const MANIFEST_FILE = "manifest.json";
export const REFERENCES_MANIFEST_FILE = "references-manifest.json";
export const CHARACTERS_FILE = "characters.json";
export const CUSTOM_STYLES_FILE = "custom-styles.json";
export const ARCHIVE_INFO_FILE = "prismix-archive.json";
export const ARCHIVE_VERSION = 1;

export interface ArchiveInfo {
  format: "prismix-archive";
  version: number;
  exportedAt: number;
}

/** Derived from ImageRecord so new fields round-trip without changes here. */
export type ManifestEntry = ImageRecord & { filename: string };

export interface ReferencesManifestEntry {
  id: string;
  name: string;
  filename: string;
  sourceGalleryItemId?: string;
}

export interface ImportResult {
  imported: number;
  referencesImported: number;
  charactersImported: number;
  stylesImported: number;
  skipped: number;
  failed: number;
}

export function emptyImportResult(): ImportResult {
  return {
    imported: 0,
    referencesImported: 0,
    charactersImported: 0,
    stylesImported: 0,
    skipped: 0,
    failed: 0,
  };
}

export function archiveInfo(): ArchiveInfo {
  return { format: "prismix-archive", version: ARCHIVE_VERSION, exportedAt: Date.now() };
}

export function archiveFilename(date = new Date()): string {
  return `prismix-export-${date.toISOString().slice(0, 10)}.zip`;
}

export function imageEntryName(id: string, extension: string): string {
  return `images/${id}.${extension}`;
}

export function referenceEntryName(id: string, extension: string): string {
  return `references/${id}.${extension}`;
}

export function toManifestEntry(record: ImageRecord, filename: string): ManifestEntry {
  return { ...record, filename };
}

export function toReferencesManifestEntry(
  reference: { id: string; name: string; sourceGalleryItemId?: string },
  filename: string
): ReferencesManifestEntry {
  const entry: ReferencesManifestEntry = { id: reference.id, name: reference.name, filename };
  if (reference.sourceGalleryItemId) entry.sourceGalleryItemId = reference.sourceGalleryItemId;
  return entry;
}

/** Extension of an entry's filename, for its MIME type. Defaults to png like older exports. */
export function entryExtension(filename: string): string {
  const extension = filename.includes(".") ? filename.split(".").pop() : undefined;
  return extension || "png";
}

/** The record to store for a manifest entry (filename dropped, required fields defaulted). */
export function manifestEntryToRecord(entry: ManifestEntry): ImageRecord {
  const { filename: _filename, ...record } = entry;
  void _filename;
  return {
    ...record,
    referenceImageIds: entry.referenceImageIds ?? [],
    metadata: entry.metadata ?? {},
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid archive: ${file} is not valid JSON`);
  }
}

/**
 * Parse `manifest.json`. Throws if it isn't an array; entries missing an id or
 * filename are dropped and counted as failed by the caller.
 */
export function parseManifest(text: string): { entries: ManifestEntry[]; invalid: number } {
  const value = parseJson(text, MANIFEST_FILE);
  if (!Array.isArray(value)) throw new Error(`Invalid archive: ${MANIFEST_FILE} must be an array`);
  const entries = value.filter(
    (entry): entry is ManifestEntry =>
      isObject(entry) &&
      typeof entry.id === "string" &&
      entry.id.length > 0 &&
      typeof entry.filename === "string"
  );
  return { entries, invalid: value.length - entries.length };
}

export function parseReferencesManifest(text: string): {
  entries: ReferencesManifestEntry[];
  invalid: number;
} {
  const value = parseJson(text, REFERENCES_MANIFEST_FILE);
  if (!Array.isArray(value)) {
    throw new Error(`Invalid archive: ${REFERENCES_MANIFEST_FILE} must be an array`);
  }
  const entries = value.filter(
    (entry): entry is ReferencesManifestEntry =>
      isObject(entry) &&
      typeof entry.id === "string" &&
      entry.id.length > 0 &&
      typeof entry.filename === "string"
  );
  return {
    entries: entries.map((entry) => ({ ...entry, name: entry.name ?? "" })),
    invalid: value.length - entries.length,
  };
}

function parseIdList<T extends { id: string }>(text: string, file: string): T[] {
  const value = parseJson(text, file);
  if (!Array.isArray(value)) throw new Error(`Invalid archive: ${file} must be an array`);
  return value.filter((item): item is T => isObject(item) && typeof item.id === "string");
}

export const parseCharacters = (text: string) =>
  parseIdList<StoredCharacter>(text, CHARACTERS_FILE);

export const parseCustomStyles = (text: string) =>
  parseIdList<StoredStyle>(text, CUSTOM_STYLES_FILE);

/**
 * Append incoming items whose IDs aren't present yet (existing ones win). Same
 * rule as `settingsStore.importCharacters` / `importCustomStyles`.
 */
export function mergeById<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[]
): { merged: T[]; added: number } {
  const ids = new Set(existing.map((item) => item.id));
  const added = incoming.filter((item) => {
    if (ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  });
  return { merged: [...existing, ...added], added: added.length };
}
