import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import mime from "mime";

const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/**
 * A filesystem-safe name for an ID. UUIDs (the normal case) pass through so the
 * data directory stays readable; anything else is hashed so a crafted ID can
 * never escape the data directory.
 */
export function fileSafeId(id: string): string {
  if (SAFE_SEGMENT.test(id) && id !== "." && id !== "..") return id;
  return `h-${createHash("sha256").update(id).digest("hex")}`;
}

/** File extension (no dot) for a MIME type, falling back to `bin`. */
export function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  return mime.getExtension(mimeType) ?? "bin";
}

/** Best-effort MIME detection from magic bytes, for blobs that arrive untyped. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const startsWith = (sig: number[], offset = 0) =>
    sig.every((byte, i) => bytes[offset + i] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  if (startsWith([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand.startsWith("hei") || brand.startsWith("mif")) return "image/heic";
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
}

/** The blob's declared type, else sniffed, else `application/octet-stream`. */
export function resolveMimeType(declared: string | undefined, bytes: Uint8Array): string {
  const type = declared?.split(";")[0].trim();
  if (type && type !== "application/octet-stream") return type;
  return sniffImageMime(bytes) ?? "application/octet-stream";
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Files under the data directory, addressed by paths relative to it (which is
 * what the database stores). Writes are atomic: temp file in the same
 * directory, fsync, rename.
 */
export class FileStore {
  constructor(readonly root: string) {}

  resolve(relativePath: string): string {
    const absolute = path.resolve(this.root, relativePath);
    if (absolute !== this.root && !absolute.startsWith(this.root + path.sep)) {
      throw new Error(`Path escapes data directory: ${relativePath}`);
    }
    return absolute;
  }

  async write(relativePath: string, data: Uint8Array): Promise<void> {
    const target = this.resolve(relativePath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      const handle = await fsp.open(temp, "w");
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rename(temp, target);
    } catch (error) {
      await fsp.rm(temp, { force: true });
      throw error;
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      return (await fsp.stat(this.resolve(relativePath))).isFile();
    } catch {
      return false;
    }
  }

  /** A file-backed Blob (bytes are read lazily), or null if the file is missing. */
  async openBlob(relativePath: string, type: string): Promise<Blob | null> {
    try {
      return await fs.openAsBlob(this.resolve(relativePath), { type });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async remove(relativePath: string): Promise<void> {
    await fsp.rm(this.resolve(relativePath), { force: true });
  }

  async removeDir(relativePath: string): Promise<void> {
    await fsp.rm(this.resolve(relativePath), { recursive: true, force: true });
  }
}
