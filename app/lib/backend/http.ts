import type {
  CompletedGalleryItem,
  ImageRecord,
  ReferenceImage,
  StoredEditorSession,
  StoredImageRecord,
} from "~/types";
import type { ImageStatRecord } from "~/lib/stats";
import type { GalleryRepository, ImageBlobVariant } from "./types";

/**
 * `GalleryRepository` over the hosted server's REST API (`server/routes/*`).
 * Gallery items carry server URLs rather than object URLs, so there's nothing
 * to revoke and images load straight from the server.
 */

const enc = encodeURIComponent;

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON.
  }
  return `${response.status} ${response.statusText}`;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${await errorMessage(response)}`);
  }
  return response;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await request(path, init)).json()) as T;
}

/** Like `request`, but a 404 resolves to null (the interface's "missing" value). */
async function requestOrNull(path: string, init?: RequestInit): Promise<Response | null> {
  const response = await fetch(path, init);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${await errorMessage(response)}`);
  }
  return response;
}

async function requestJsonOrNull<T>(path: string, init?: RequestInit): Promise<T | null> {
  const response = await requestOrNull(path, init);
  return response ? ((await response.json()) as T) : null;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function imageForm(image: StoredImageRecord): FormData {
  const { originalBlob, thumbnailBlob, ...record } = image;
  const form = new FormData();
  form.append("record", JSON.stringify(record));
  form.append("original", originalBlob, "original");
  form.append("thumbnail", thumbnailBlob, "thumbnail");
  return form;
}

/** PATCH that tolerates a missing image (the IndexedDB methods are no-ops then). */
async function patchImage(id: string, patch: Record<string, unknown>): Promise<ImageRecord | null> {
  return requestJsonOrNull<ImageRecord>(`/api/images/${enc(id)}`, jsonInit("PATCH", patch));
}

function referenceUrl(id: string): string {
  return `/api/references/${enc(id)}`;
}

async function fetchReference(id: string): Promise<ReferenceImage | null> {
  const response = await requestOrNull(referenceUrl(id));
  if (!response) return null;
  const blob = await response.blob();
  const name = response.headers.get("X-Reference-Name");
  const source = response.headers.get("X-Source-Gallery-Item-Id");
  const ref: ReferenceImage = {
    id,
    blob,
    name: name ? decodeURIComponent(name) : id,
    url: referenceUrl(id),
  };
  if (source) ref.sourceGalleryItemId = decodeURIComponent(source);
  return ref;
}

export const httpRepository: GalleryRepository = {
  // Images
  async saveImage(image) {
    await request("/api/images", { method: "POST", body: imageForm(image) });
  },

  async importImage(image) {
    await request("/api/images?mode=import", { method: "POST", body: imageForm(image) });
  },

  getImagesPaginated(limit, offset) {
    return requestJson<CompletedGalleryItem[]>(`/api/images?limit=${limit}&offset=${offset}`);
  },

  getAllImages() {
    return requestJson<ImageRecord[]>("/api/images/all");
  },

  getImageById(id) {
    return requestJsonOrNull<ImageRecord>(`/api/images/${enc(id)}`);
  },

  async getImageBlob(id: string, variant: ImageBlobVariant) {
    const response = await requestOrNull(`/api/images/${enc(id)}/${variant}`);
    return response ? response.blob() : null;
  },

  getImageStatRecords() {
    return requestJson<ImageStatRecord[]>("/api/images/stats");
  },

  async getImageCount() {
    return (await requestJson<{ count: number }>("/api/images/count")).count;
  },

  async getExistingImageIds() {
    return new Set(await requestJson<string[]>("/api/images/ids"));
  },

  getEmbeddingCounts(modelId) {
    const query = modelId ? `?modelId=${enc(modelId)}` : "";
    return requestJson<{ total: number; indexed: number }>(`/api/images/embedding-counts${query}`);
  },

  async deleteImage(id) {
    await request(`/api/images/${enc(id)}`, { method: "DELETE" });
  },

  async updateImageEmbedding(id, embedding, embeddingModelId) {
    await patchImage(id, { embedding, embeddingModelId });
  },

  async updateImageCharacters(id, characterIds) {
    await patchImage(id, { characterIds });
  },

  async updateImageFavorite(id, isFavorite) {
    await patchImage(id, { isFavorite });
  },

  updateImageScorecard(id, scorecard) {
    return patchImage(id, { scorecard: scorecard ?? null });
  },

  async removeImageStyleReferences(styleId) {
    await request("/api/images/remove-style", jsonInit("POST", { styleId }));
  },

  // Reference images
  async saveReferenceImage(image) {
    const form = new FormData();
    form.append("id", image.id);
    form.append("name", image.name);
    if (image.sourceGalleryItemId) form.append("sourceGalleryItemId", image.sourceGalleryItemId);
    form.append("file", image.blob, image.name || "reference");
    await request("/api/references", { method: "POST", body: form });
    return { ...image, url: referenceUrl(image.id) };
  },

  async getReferenceImagesByIds(ids) {
    // Fetch in parallel but keep the caller's order (it decides reference precedence).
    const refs = await Promise.all(ids.map(fetchReference));
    return refs.filter((ref): ref is ReferenceImage => ref !== null);
  },

  async getAllReferenceImages() {
    const metadata = await requestJson<Array<{ id: string }>>("/api/references");
    const refs = await Promise.all(metadata.map(({ id }) => fetchReference(id)));
    return refs
      .filter((ref): ref is ReferenceImage => ref !== null)
      .map(({ url: _url, ...ref }) => {
        void _url;
        return ref;
      });
  },

  async getExistingReferenceImageIds() {
    return new Set(await requestJson<string[]>("/api/references/ids"));
  },

  async deleteReferenceImagesByIds(ids) {
    if (ids.length === 0) return;
    await request("/api/references/delete", jsonInit("POST", { ids }));
  },

  async garbageCollectReferences(extraReachableIds) {
    const { deleted } = await requestJson<{ deleted: number }>(
      "/api/references/gc",
      jsonInit("POST", { extraReachableIds: [...extraReachableIds] })
    );
    return deleted;
  },

  // Editor sessions
  async upsertEditorSession(session) {
    return (await requestJson<{ id: string }>("/api/sessions", jsonInit("PUT", session))).id;
  },

  getSessionById(id) {
    return requestJsonOrNull<StoredEditorSession>(`/api/sessions/${enc(id)}`);
  },

  getSessionByGalleryItemId(galleryItemId) {
    return requestJsonOrNull<StoredEditorSession>(
      `/api/sessions/by-gallery-item/${enc(galleryItemId)}`
    );
  },

  getAllSessions() {
    return requestJson<StoredEditorSession[]>("/api/sessions");
  },

  async deleteEditorSession(id) {
    await request(`/api/sessions/${enc(id)}`, { method: "DELETE" });
  },

  findSessionForImage(imageId) {
    return requestJsonOrNull<StoredEditorSession>(`/api/sessions/for-image/${enc(imageId)}`);
  },
};
