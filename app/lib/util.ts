import type { AspectRatio } from "~/types";

/** Encode bytes as plain base64 (no data-URL prefix). Works in browsers and Node. */
export function bytesToBase64(bytes: Uint8Array): string {
  // String.fromCharCode(...bytes) overflows the call stack on large images, so encode in chunks.
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

/** Decode plain base64 (no data-URL prefix) into a Blob of the given MIME type. */
export function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * Encode a blob as a `data:<type>;base64,...` URL. Same output as
 * `FileReader.readAsDataURL`, without depending on the DOM.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${blob.type || "application/octet-stream"};base64,${bytesToBase64(bytes)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export function formatRelativeDate(createdAt: number): string {
  const now = Date.now();
  const delta = Math.max(0, now - createdAt);
  const day = 24 * 60 * 60 * 1000;
  const minute = 60 * 1000;
  const hour = 60 * minute;

  if (delta < 30) {
    return "Just now";
  } else if (delta < minute) {
    return Math.floor(delta / 1000) + " seconds ago";
  } else if (delta < 2 * minute) {
    return "1 minute ago";
  } else if (delta < hour) {
    return Math.floor(delta / minute) + " minutes ago";
  } else if (Math.floor(delta / hour) == 1) {
    return "1 hour ago";
  } else if (delta < day) {
    return Math.floor(delta / hour) + " hours ago";
  } else if (delta < day * 2) {
    return "Yesterday";
  }

  return new Date(createdAt).toLocaleDateString("en-US");
}
export function getAspectRatioValue(aspectRatio: AspectRatio | null): number {
  if (!aspectRatio) {
    return 1;
  }

  const [first, second] = aspectRatio.split(":");
  return parseFloat(first) / parseFloat(second);
}
export function formatUsd(value: number): string {
  if (value < 0.0001) return "<$0.0001";
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}
