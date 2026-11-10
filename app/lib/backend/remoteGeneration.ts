import { enqueueImageEmbedding } from "~/lib/embeddingQueue";
import { logger } from "~/lib/logging";
import { useGalleryStore } from "~/stores/galleryStore";
import type { CompletedGalleryItem, GalleryItem } from "~/types";
import type { GenerationBackend } from "./generationTypes";

/**
 * Submits tasks to the server's job runner (`/api/jobs`) and mirrors job progress
 * from `/api/events` into `galleryStore`. Jobs keep running after the tab closes;
 * reopening the app restores pending and failed cards from `/api/jobs/items`.
 */

type Store = ReturnType<typeof useGalleryStore.getState>;

const isInFlight = (item: GalleryItem) =>
  item.status === "pending" || item.status === "generating" || item.status === "waiting";

async function post(path: string, body?: unknown): Promise<Response> {
  const response = await fetch(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // Not JSON; keep the status line.
    }
    throw new Error(message);
  }
  return response;
}

/** Merge a server-side item into the store, adding it if this tab hasn't seen it. */
function applyServerItem(item: GalleryItem): void {
  const store = useGalleryStore.getState();
  if (store.isItemCanceled(item.id)) return;
  const existing = store.getItem(item.id);
  if (!existing) {
    if (item.status === "completed") return; // Shows up through the normal gallery load.
    store.addItems([item]);
    return;
  }
  if (existing.status === "completed") return;
  const { id: _id, ...update } = item;
  void _id;
  store.updateItem(item.id, update as Parameters<Store["updateItem"]>[1]);
  if (item.status === "completed") enqueueImageEmbedding(item.id);
}

function removeItem(id: string): void {
  const store = useGalleryStore.getState();
  if (store.getItem(id))
    useGalleryStore.setState({ items: store.items.filter((i) => i.id !== id) });
}

/**
 * After (re)connecting: add or update the server's active and failed items, and
 * settle any card this tab still shows as in flight that the server no longer has
 * (it finished, or was canceled elsewhere, while the stream was down).
 */
async function resync(): Promise<void> {
  const response = await fetch("/api/jobs/items");
  if (!response.ok) throw new Error(`Failed to load jobs: ${response.status}`);
  const serverItems = (await response.json()) as GalleryItem[];
  const serverIds = new Set(serverItems.map((i) => i.id));
  for (const item of serverItems) applyServerItem(item);

  const stale = useGalleryStore
    .getState()
    .items.filter(
      (item) => isInFlight(item) && !serverIds.has(item.id) && !submitting.has(item.id)
    );
  await Promise.all(
    stale.map(async (item) => {
      const imageResponse = await fetch(`/api/images/${encodeURIComponent(item.id)}/item`);
      if (imageResponse.ok) {
        applyServerItem((await imageResponse.json()) as CompletedGalleryItem);
      } else if (imageResponse.status === 404) {
        removeItem(item.id);
      }
    })
  );
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** The server pings every 15s; a stream silent for this long is presumed dead. Some
 *  proxies keep the browser's side open after the server goes away. */
const STALE_STREAM_MS = 45_000;

/** Item IDs whose POST /api/jobs hasn't returned yet; a resync mustn't drop them. */
const submitting = new Set<string>();

function waitForSettled(itemIds: string[]): Promise<void> {
  const settled = () =>
    itemIds.every((id) => {
      const item = useGalleryStore.getState().getItem(id);
      return !item || !isInFlight(item);
    });
  if (settled()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useGalleryStore.subscribe(() => {
      if (!settled()) return;
      unsubscribe();
      resolve();
    });
  });
}

export const remoteGenerationBackend: GenerationBackend = {
  async run(tasks) {
    if (tasks.length === 0) return [];
    const store = useGalleryStore.getState();
    const itemIds = tasks.flatMap((t) => t.itemIds);
    // Send the pending cards too, so another tab (or this one after a reload) can
    // rebuild them with the same labels and loading previews.
    const items = itemIds
      .map((id) => store.getItem(id))
      .filter((item): item is GalleryItem => !!item && !store.isItemCanceled(item.id));

    for (const id of itemIds) submitting.add(id);
    try {
      await post("/api/jobs", { tasks, items });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to submit generation";
      for (const id of itemIds) {
        store.updateItem(id, { status: "failed", error: message, canRetry: true });
      }
      return tasks.map(() => ({ status: "rejected", reason: error }) as const);
    } finally {
      for (const id of itemIds) submitting.delete(id);
    }

    return Promise.allSettled(tasks.map((task) => waitForSettled(task.itemIds)));
  },

  cancel(itemId) {
    post(`/api/items/${encodeURIComponent(itemId)}/cancel`).catch((error) =>
      logger.error("[jobs] Cancel failed", error)
    );
  },

  dismiss(itemId) {
    post(`/api/items/${encodeURIComponent(itemId)}/dismiss`).catch((error) =>
      logger.error("[jobs] Dismiss failed", error)
    );
  },

  connect() {
    if (typeof EventSource === "undefined") return () => {};

    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = RECONNECT_MIN_MS;
    let stopped = false;
    let lastActivity = Date.now();
    const touch = () => {
      lastActivity = Date.now();
    };

    const open = () => {
      touch();
      source = new EventSource("/api/events");
      source.addEventListener("ready", touch);
      source.addEventListener("ping", touch);
      // Resync on every (re)open: events sent while disconnected aren't replayed.
      source.onopen = () => {
        retryDelay = RECONNECT_MIN_MS;
        resync().catch((error) => logger.error("[jobs] Resync failed", error));
      };
      // EventSource retries dropped connections itself, but gives up for good when a
      // reconnect gets an HTTP error (e.g. a reverse proxy's 502 while the server
      // restarts). Reopen it ourselves in that case, with backoff.
      source.onerror = () => {
        if (stopped || source?.readyState !== EventSource.CLOSED) return;
        source = null;
        retryTimer = setTimeout(open, retryDelay);
        retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS);
      };
      source.addEventListener("item", (event) => {
        touch();
        applyServerItem(JSON.parse((event as MessageEvent<string>).data) as GalleryItem);
      });
      source.addEventListener("item-removed", (event) => {
        touch();
        const { id } = JSON.parse((event as MessageEvent<string>).data) as { id: string };
        removeItem(id);
      });
    };
    open();

    const watchdog = setInterval(() => {
      if (!source || Date.now() - lastActivity < STALE_STREAM_MS) return;
      logger.warn("[jobs] Event stream went quiet; reconnecting");
      source.close();
      open();
    }, 5_000);

    return () => {
      stopped = true;
      clearInterval(watchdog);
      clearTimeout(retryTimer);
      source?.close();
    };
  },
};
