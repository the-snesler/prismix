import { getImageDimensions } from "~/lib/imageProcessing";
import type { DebugImageSpec, Platform } from "./types";

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Failed to create debug image"));
      }
    }, "image/png");
  });
}

async function renderDebugImage({
  width,
  height,
  headline,
  detail,
  caption,
}: DebugImageSpec): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to create debug canvas");
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#d4d4d8";
  ctx.lineWidth = Math.max(4, Math.round(Math.min(width, height) * 0.01));
  ctx.strokeRect(0, 0, width, height);

  const headlineSize = Math.max(24, Math.round(Math.min(width, height) * 0.06));
  const detailSize = Math.max(16, Math.round(headlineSize * 0.45));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillStyle = "#18181b";
  ctx.font = `600 ${headlineSize}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(headline, width / 2, height / 2 - headlineSize * 0.7);

  ctx.font = `${detailSize}px ui-monospace, monospace`;
  ctx.fillText(detail, width / 2, height / 2 + detailSize * 0.25);

  ctx.fillStyle = "#52525b";
  ctx.fillText(caption, width / 2, height / 2 + detailSize * 1.8);

  return canvasToPngBlob(canvas);
}

export const browserPlatform: Platform = {
  getImageDimensions,

  // api.openai.com sends no CORS headers and Replicate's are incomplete, so the
  // browser goes through the same-origin proxy (vite dev server / Cloudflare worker).
  providerBaseUrl: (provider) =>
    new URL(`/proxy/${provider}/v1`, window.location.origin).toString(),

  cache: {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Quota exceeded or storage disabled: caching is best-effort.
      }
    },
  },

  renderDebugImage,
};
