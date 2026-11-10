import { indexedDbRepository } from "./indexedDb";
import type { GalleryRepository } from "./types";

export type { GalleryRepository, ImageBlobVariant } from "./types";

// IndexedDB opens lazily on first use, so importing it outside a browser is safe.
// A server-backed build swaps this with `setRepository` before the app renders.
let current: GalleryRepository = indexedDbRepository;

export function getRepository(): GalleryRepository {
  return current;
}

export function setRepository(repository: GalleryRepository): void {
  current = repository;
}
