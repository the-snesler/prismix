/** Providers whose REST APIs the browser must reach through a same-origin CORS proxy. */
export type ProxiedProvider = "openai" | "replicate";

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Text card drawn by the debug provider's `debug-model`. */
export interface DebugImageSpec {
  width: number;
  height: number;
  headline: string;
  detail: string;
  caption: string;
}

/**
 * Environment-specific capabilities used by the shared generation pipeline
 * (providers, pricing, `executeGeneration`). The browser implementation backs
 * these with the DOM; a server implementation can back them with Node libraries.
 * Nothing reachable from `executeGeneration` should touch `window`, `document`,
 * `localStorage`, or a zustand store directly. Go through this interface instead.
 */
export interface Platform {
  /** Decode just enough of an image to report its pixel size. */
  getImageDimensions(blob: Blob): Promise<ImageDimensions>;
  /** Root URL of a provider's REST API, including the version segment (e.g. `.../v1`). */
  providerBaseUrl(provider: ProxiedProvider): string;
  /** Best-effort string key/value cache. Implementations must never throw. */
  cache: {
    get(key: string): string | null;
    set(key: string, value: string): void;
  };
  /** Render the debug provider's placeholder card as a PNG. */
  renderDebugImage(spec: DebugImageSpec): Promise<Blob>;
}
