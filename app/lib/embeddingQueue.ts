import { getAllImages, getEmbeddingCounts, getImageBlob, updateImageEmbedding } from "./db";
import { useEmbeddingStatusStore } from "~/stores/embeddingStatusStore";
import { useGalleryStore } from "~/stores/galleryStore";
import { useSettingsStore } from "~/stores/settingsStore";

const MAX_TEXT_LISTENERS = 64;

type WorkerProgressMessage =
  | {
      type: "progress";
      data: { status: string; loaded?: number; total?: number; progress?: number };
    }
  | { type: "ready"; modelId: string }
  | { type: "imageResult"; id: string; embedding: number[] }
  | { type: "imageError"; id: string; error: string }
  | { type: "textResult"; queryId: string; embedding: number[] }
  | { type: "textError"; queryId: string; error: string };

let worker: Worker | null = null;
const imageQueue: string[] = [];
const queuedIds = new Set<string>();
let isProcessing = false;
let inflightId: string | null = null;
let textListeners = new Map<
  string,
  { resolve: (embedding: number[]) => void; reject: (error: Error) => void }
>();

// Track per-file download progress so we can show aggregate bytes.
const fileProgress = new Map<string, { loaded: number; total: number }>();

function getWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL("./embeddingWorker.ts", import.meta.url), {
    type: "module",
    name: "embedding-worker",
  });

  worker.addEventListener("message", (event: MessageEvent<WorkerProgressMessage>) => {
    const msg = event.data;
    const status = useEmbeddingStatusStore.getState();

    if (msg.type === "progress") {
      const { status: phase, loaded, total } = msg.data;
      // Aggregate per-file bytes; transformers.js fires multiple files but
      // each carries its own loaded/total. Sum them for a stable bar.
      const fileKey = `${msg.data.status}:${("file" in msg.data && msg.data.file) || ""}`;
      if (typeof loaded === "number" && typeof total === "number" && total > 0) {
        fileProgress.set(fileKey, { loaded, total });
      }
      let aggLoaded = 0;
      let aggTotal = 0;
      for (const v of fileProgress.values()) {
        aggLoaded += v.loaded;
        aggTotal += v.total;
      }
      if (phase === "progress" && aggTotal > 0) {
        status.setModelDownloadProgress(aggLoaded / aggTotal, {
          loaded: aggLoaded,
          total: aggTotal,
        });
      } else if (phase === "initiate" || phase === "download") {
        if (status.modelLoadState === "idle") {
          status.setModelDownloadProgress(0);
        }
      }
    } else if (msg.type === "ready") {
      status.setModelReady(msg.modelId);
    } else if (msg.type === "imageResult") {
      void handleImageResult(msg.id, msg.embedding);
    } else if (msg.type === "imageError") {
      handleImageError(msg.id, msg.error);
    } else if (msg.type === "textResult") {
      const listener = textListeners.get(msg.queryId);
      textListeners.delete(msg.queryId);
      listener?.resolve(msg.embedding);
    } else if (msg.type === "textError") {
      const listener = textListeners.get(msg.queryId);
      textListeners.delete(msg.queryId);
      listener?.reject(new Error(msg.error));
    }
  });

  worker.addEventListener("error", (event) => {
    const status = useEmbeddingStatusStore.getState();
    status.setModelError(event.message || "Embedding worker crashed");
  });

  return worker;
}

async function handleImageResult(id: string, embedding: number[]) {
  inflightId = null;
  const { modelId } = useEmbeddingStatusStore.getState();
  try {
    await updateImageEmbedding(id, embedding, modelId ?? "unknown");
    useGalleryStore.getState().setItemEmbedding(id, embedding, modelId ?? "unknown");
    useEmbeddingStatusStore.getState().reportEmbedSuccess();
  } catch (err) {
    useEmbeddingStatusStore
      .getState()
      .reportEmbedError(err instanceof Error ? err.message : "Failed to persist embedding");
  }
  scheduleNext();
}

function handleImageError(id: string, error: string) {
  inflightId = null;
  useEmbeddingStatusStore.getState().reportEmbedError(`${id.slice(0, 8)}: ${error}`);
  scheduleNext();
}

function scheduleNext() {
  if (isProcessing) return;
  if (typeof window === "undefined") return;

  const tick = () => {
    isProcessing = false;
    void processNext();
  };

  isProcessing = true;
  if ("requestIdleCallback" in window) {
    (
      window as Window & {
        requestIdleCallback: (cb: () => void, options?: { timeout: number }) => number;
      }
    ).requestIdleCallback(tick, { timeout: 2000 });
  } else {
    setTimeout(tick, 200);
  }
}

async function processNext() {
  if (inflightId) return;
  if (!useSettingsStore.getState().semanticSearchEnabled) {
    // Toggle flipped off — drain quietly.
    imageQueue.length = 0;
    queuedIds.clear();
    return;
  }

  const id = imageQueue.shift();
  if (!id) return;
  queuedIds.delete(id);

  // Send the thumbnail (400px, already rasterized) rather than the original:
  // SigLIP resizes to 224 internally, so we lose nothing on quality, and SVG
  // originals would otherwise crash the worker's image decoder.
  let blob: Blob | null = null;
  try {
    blob = await getImageBlob(id, "thumbnail");
  } catch (err) {
    useEmbeddingStatusStore
      .getState()
      .reportEmbedError(err instanceof Error ? err.message : "Failed to load image for embedding");
  }

  if (!blob) {
    scheduleNext();
    return;
  }

  inflightId = id;
  try {
    getWorker().postMessage({ type: "embedImage", id, blob });
  } catch (err) {
    inflightId = null;
    useEmbeddingStatusStore
      .getState()
      .reportEmbedError(err instanceof Error ? err.message : "Failed to dispatch embedding");
    scheduleNext();
  }
}

export function enqueueImageEmbedding(id: string) {
  if (queuedIds.has(id)) return;
  if (!useSettingsStore.getState().semanticSearchEnabled) return;
  imageQueue.push(id);
  queuedIds.add(id);
  scheduleNext();
}

export async function enqueueMissingEmbeddings(currentModelId: string | null): Promise<number> {
  if (!useSettingsStore.getState().semanticSearchEnabled) return 0;

  let queued = 0;
  try {
    const all = await getAllImages();
    for (const record of all) {
      const needs =
        !record.embedding ||
        record.embedding.length === 0 ||
        (currentModelId && record.embeddingModelId !== currentModelId);
      if (needs) {
        enqueueImageEmbedding(record.id);
        queued++;
      }
    }
  } catch (err) {
    useEmbeddingStatusStore
      .getState()
      .reportEmbedError(
        err instanceof Error ? err.message : "Failed to scan for missing embeddings"
      );
  }
  return queued;
}

export async function refreshEmbeddingCounts(currentModelId: string | null) {
  try {
    const { total, indexed } = await getEmbeddingCounts(currentModelId);
    useEmbeddingStatusStore.getState().setCounts(indexed, total);
  } catch (err) {
    useEmbeddingStatusStore
      .getState()
      .reportEmbedError(err instanceof Error ? err.message : "Failed to count embeddings");
  }
}

export async function embedQueryText(text: string, signal?: AbortSignal): Promise<number[]> {
  const queryId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Cap pending listeners; oldest pending queries lose their right to a result
  // if the user types fast (newer query supersedes anyway).
  if (textListeners.size >= MAX_TEXT_LISTENERS) {
    const trimmed = new Map<
      string,
      { resolve: (embedding: number[]) => void; reject: (error: Error) => void }
    >();
    let i = 0;
    for (const [k, v] of textListeners) {
      if (i++ >= textListeners.size - MAX_TEXT_LISTENERS / 2) trimmed.set(k, v);
    }
    textListeners = trimmed;
  }

  return new Promise<number[]>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    textListeners.set(queryId, { resolve, reject });
    signal?.addEventListener("abort", () => {
      textListeners.delete(queryId);
      reject(new DOMException("Aborted", "AbortError"));
    });
    try {
      getWorker().postMessage({ type: "embedText", queryId, text });
    } catch (err) {
      textListeners.delete(queryId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
