import { httpRepository } from "./http";
import { indexedDbRepository } from "./indexedDb";
import { isServerBackend } from "./mode";
import type { GalleryRepository } from "./types";

export type { GalleryRepository, ImageBlobVariant } from "./types";
export { isServerBackend } from "./mode";

// IndexedDB opens lazily on first use, so importing it outside a browser is safe.
// `VITE_BACKEND=server` builds talk to the hosted server's REST API instead.
let current: GalleryRepository = isServerBackend ? httpRepository : indexedDbRepository;

export function getRepository(): GalleryRepository {
  return current;
}

export function setRepository(repository: GalleryRepository): void {
  current = repository;
}
