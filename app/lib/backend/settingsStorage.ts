import type { StateStorage } from "zustand/middleware";

/**
 * zustand `persist` storage backed by the hosted server (`GET/PUT /api/settings`),
 * used by `settingsStore` in `VITE_BACKEND=server` builds. The server stores the
 * persisted JSON string verbatim.
 *
 * - Writes are debounced and sent in order; pending writes flush on `pagehide`.
 * - Writes are dropped until the first successful load, so a state change made
 *   before hydration can never overwrite the server's settings with defaults.
 */

const ENDPOINT = "/api/settings";
const DEBOUNCE_MS = 300;
const RETRY_MS = 2000;
// Browsers cap keepalive request bodies at 64 KiB.
const KEEPALIVE_MAX_BYTES = 60_000;

export type SettingsLoadState =
  | { status: "idle" | "loading" | "ready" }
  | { status: "error"; error: string };

let loadState: SettingsLoadState = { status: "idle" };
const listeners = new Set<() => void>();

function setLoadState(next: SettingsLoadState) {
  loadState = next;
  listeners.forEach((listener) => listener());
}

/** For `useSyncExternalStore`: progress of the initial settings load. */
export function subscribeSettingsLoadState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSettingsLoadState(): SettingsLoadState {
  return loadState;
}

let loaded = false;
let serverWasEmpty = false;
let pendingValue: string | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function put(value: string): Promise<void> {
  // keepalive lets a save outlive the page (reload, close, navigation), within the
  // browser's size cap; larger saves can still be cancelled by an unload.
  const keepalive = value.length < KEEPALIVE_MAX_BYTES;
  const response = await fetch(ENDPOINT, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
    keepalive,
  });
  if (!response.ok) throw new Error(`Saving settings failed: ${response.status}`);
}

function schedule(delay: number) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void flushSettings();
  }, delay);
}

/** Send any pending write now. Resolves once it (and earlier writes) settle. */
export function flushSettings(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const value = pendingValue;
  if (value === null) return writeChain;
  pendingValue = null;

  writeChain = writeChain.then(async () => {
    try {
      await put(value);
    } catch (error) {
      console.error(error);
      // Retry unless a newer value has superseded this one.
      if (pendingValue === null) {
        pendingValue = value;
        schedule(RETRY_MS);
      }
    }
  });
  return writeChain;
}

function flushOnPageHide() {
  const value = pendingValue;
  if (value === null) return;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingValue = null;
  void put(value).catch((error) => console.error(error));
}

let pageHideListenerAdded = false;

const serverSettingsStorage: StateStorage = {
  async getItem() {
    setLoadState({ status: "loading" });
    try {
      const response = await fetch(ENDPOINT, { cache: "no-store" });
      if (!response.ok) throw new Error(`Loading settings failed: ${response.status}`);
      const { value } = (await response.json()) as { value: string | null };
      loaded = true;
      serverWasEmpty = value === null;
      setLoadState({ status: "ready" });
      return value;
    } catch (error) {
      setLoadState({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  setItem(_name, value) {
    if (!loaded) return;
    pendingValue = value;
    schedule(DEBOUNCE_MS);
  },

  // The server keeps settings for the lifetime of the deployment; nothing calls
  // `persist.clearStorage()` today, so there's no delete endpoint.
  removeItem() {
    pendingValue = null;
  },
};

/**
 * The storage for `createJSONStorage`. Throws outside a browser (e.g. during
 * prerender), which zustand treats as "no storage", like a missing localStorage.
 */
export function getServerSettingsStorage(): StateStorage {
  if (typeof window === "undefined") throw new Error("Server settings storage needs a browser");
  if (!pageHideListenerAdded) {
    pageHideListenerAdded = true;
    window.addEventListener("pagehide", flushOnPageHide);
    // Hidden often precedes an unload (closing or reloading the tab), so use the
    // keepalive path here too; a plain fetch would be cancelled with the page.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushOnPageHide();
    });
  }
  return serverSettingsStorage;
}

/**
 * True once, if the server had no settings when they were loaded. The caller
 * then writes the full current state so the server holds a complete,
 * current-version copy (which server-side features such as archive import can
 * merge into) rather than nothing until the first settings change.
 */
export function consumeSettingsSeedRequest(): boolean {
  if (!serverWasEmpty) return false;
  serverWasEmpty = false;
  return true;
}
