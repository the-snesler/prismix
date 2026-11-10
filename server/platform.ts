import sharp from "sharp";
import type { DebugImageSpec, Platform } from "~/lib/platform";
import type { ServerConfig } from "./config";
import type { Database } from "./db";
import { blobToBytes } from "./files";
import { readImageSize } from "./thumbnails";

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Same layout as the browser's canvas version, drawn as SVG and rasterized by sharp. */
async function renderDebugImage({
  width,
  height,
  headline,
  detail,
  caption,
}: DebugImageSpec): Promise<Blob> {
  const border = Math.max(4, Math.round(Math.min(width, height) * 0.01));
  const headlineSize = Math.max(24, Math.round(Math.min(width, height) * 0.06));
  const detailSize = Math.max(16, Math.round(headlineSize * 0.45));
  const cx = width / 2;
  const cy = height / 2;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <rect x="${border / 2}" y="${border / 2}" width="${width - border}" height="${height - border}" fill="none" stroke="#d4d4d8" stroke-width="${border}"/>
  <g text-anchor="middle" dominant-baseline="middle">
    <text x="${cx}" y="${cy - headlineSize * 0.7}" font-family="sans-serif" font-weight="600" font-size="${headlineSize}" fill="#18181b">${escapeXml(headline)}</text>
    <text x="${cx}" y="${cy + detailSize * 0.25}" font-family="monospace" font-size="${detailSize}" fill="#18181b">${escapeXml(detail)}</text>
    <text x="${cx}" y="${cy + detailSize * 1.8}" font-family="monospace" font-size="${detailSize}" fill="#52525b">${escapeXml(caption)}</text>
  </g>
</svg>`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return new Blob([new Uint8Array(png)], { type: "image/png" });
}

/** `Platform` for running the shared generation pipeline in Node. */
export function createNodePlatform(db: Database, config: Pick<ServerConfig, "upstream">): Platform {
  const getStmt = db.prepare("SELECT value FROM kv WHERE key = ?");
  const setStmt = db.prepare(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );

  return {
    async getImageDimensions(blob) {
      // Same fallback as the browser when the image can't be decoded.
      return (await readImageSize(await blobToBytes(blob))) ?? { width: 1024, height: 1024 };
    },

    // No CORS in Node, so call the providers directly.
    providerBaseUrl: (provider) => `${config.upstream[provider]}/v1`,

    cache: {
      get(key) {
        try {
          const row = getStmt.get(key) as { value: string } | undefined;
          return row?.value ?? null;
        } catch {
          return null;
        }
      },
      set(key, value) {
        try {
          setStmt.run(key, value);
        } catch {
          // Best-effort, like the browser's localStorage cache.
        }
      },
    },

    renderDebugImage,
  };
}
