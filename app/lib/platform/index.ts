import { browserPlatform } from "./browser";
import type { Platform } from "./types";

export type { DebugImageSpec, ImageDimensions, Platform, ProxiedProvider } from "./types";

// The browser implementation only touches the DOM inside its methods, so it is
// safe to import (but not call) outside a browser. Non-browser hosts call
// `setPlatform` once at startup before running any generation.
let current: Platform = browserPlatform;

export function getPlatform(): Platform {
  return current;
}

export function setPlatform(platform: Platform): void {
  current = platform;
}
