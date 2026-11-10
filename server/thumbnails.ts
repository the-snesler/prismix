import sharp from "sharp";
import { blobToBytes } from "./files";

export const THUMBNAIL_MAX_WIDTH = 400;
const THUMBNAIL_WEBP_QUALITY = 88;

/** Displayed (EXIF-oriented) pixel size, or null if sharp can't decode the image. */
export async function readImageSize(
  bytes: Uint8Array
): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await sharp(bytes).metadata();
    const { width, height } = metadata.autoOrient ?? metadata;
    if (!width || !height) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Server equivalent of `createThumbnailBlob` in `~/lib/imageProcessing`: images
 * at most 400px wide are reused as-is, wider ones are resized to 400px wide and
 * encoded as WebP (quality 0.88). Falls back to the original if decoding fails.
 */
export async function createThumbnail(blob: Blob, maxWidth = THUMBNAIL_MAX_WIDTH): Promise<Blob> {
  const bytes = await blobToBytes(blob);
  // The browser falls back to 1024x1024 when it can't decode, then fails to draw
  // and keeps the original; skipping straight to the original is equivalent.
  const size = await readImageSize(bytes);
  if (!size || size.width <= maxWidth) return blob;

  const targetWidth = maxWidth;
  const targetHeight = Math.max(1, Math.round(size.height * (maxWidth / size.width)));
  try {
    const output = await sharp(bytes)
      .autoOrient()
      .resize(targetWidth, targetHeight, { fit: "fill" })
      .webp({ quality: THUMBNAIL_WEBP_QUALITY })
      .toBuffer();
    return new Blob([new Uint8Array(output)], { type: "image/webp" });
  } catch {
    return blob;
  }
}
