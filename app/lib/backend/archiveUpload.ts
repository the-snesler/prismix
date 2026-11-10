import type { ImportProgress, ImportResult } from "~/lib/archive/manifest";
import { sleep } from "~/lib/util";

/**
 * Server builds: send an archive to `/api/import/uploads` in small chunks and
 * wait for the background import (see `server/uploads.ts`).
 *
 * Each chunk is its own short request, so a large archive doesn't depend on one
 * multi-minute request surviving every proxy and timeout in between. Failed
 * chunks are retried with backoff and resume from the offset the server
 * confirms; a 413 (a proxy's body-size limit) halves the chunk size.
 */

interface UploadState {
  id: string;
  size: number;
  received: number;
  status: "uploading" | "processing" | "done" | "failed" | "canceled";
  progress?: { done: number; total: number };
  result?: ImportResult;
  error?: string;
}

const INITIAL_CHUNK_BYTES = 8 * 1024 * 1024;
const MIN_CHUNK_BYTES = 256 * 1024;
const MAX_CONSECUTIVE_FAILURES = 8;
const MAX_BACKOFF_MS = 30_000;
const POLL_MS = 1000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly upload?: UploadState
  ) {
    super(message);
  }
}

async function call(path: string, init: RequestInit = {}): Promise<UploadState> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => null)) as
    | (UploadState & { error?: string; upload?: UploadState })
    | null;
  if (!response.ok) {
    throw new HttpError(
      response.status,
      body?.error ?? `${response.status} ${response.statusText}`,
      body?.upload
    );
  }
  return body as UploadState;
}

const isRetryable = (error: unknown) =>
  !(error instanceof HttpError) ||
  error.status >= 500 ||
  error.status === 408 ||
  error.status === 429;

function backoff(failures: number): Promise<void> {
  return sleep(Math.min(1000 * 2 ** (failures - 1), MAX_BACKOFF_MS));
}

export async function uploadAndImportArchive(
  file: File,
  options: { onProgress?: (progress: ImportProgress) => void; signal?: AbortSignal } = {}
): Promise<ImportResult> {
  const { onProgress, signal } = options;
  let upload = await call("/api/import/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ size: file.size, name: file.name }),
    signal,
  });
  const cancelOnServer = () => {
    void fetch(`/api/import/uploads/${upload.id}`, { method: "DELETE", keepalive: true }).catch(
      () => {}
    );
  };

  try {
    // 1. Upload.
    let chunkSize = INITIAL_CHUNK_BYTES;
    let failures = 0;
    onProgress?.({ phase: "uploading", loaded: 0, total: file.size });
    while (upload.received < file.size) {
      signal?.throwIfAborted();
      const start = upload.received;
      const end = Math.min(start + chunkSize, file.size);
      try {
        upload = await call(`/api/import/uploads/${upload.id}?offset=${start}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: file.slice(start, end),
          signal,
        });
        failures = 0;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof HttpError && error.status === 413 && chunkSize > MIN_CHUNK_BYTES) {
          chunkSize = Math.max(MIN_CHUNK_BYTES, Math.floor(chunkSize / 2));
          continue;
        }
        if (
          error instanceof HttpError &&
          error.status === 409 &&
          error.upload?.status === "uploading"
        ) {
          upload = error.upload; // Out of step (e.g. a retried chunk landed); continue from the server's offset.
          continue;
        }
        if (!isRetryable(error) || ++failures > MAX_CONSECUTIVE_FAILURES) throw error;
        await backoff(failures);
        // The chunk may have landed before the connection dropped; ask where we are.
        upload = await call(`/api/import/uploads/${upload.id}`, { signal }).catch(() => upload);
      }
      onProgress?.({ phase: "uploading", loaded: upload.received, total: file.size });
    }

    // 2. Import in the background on the server; poll until it settles.
    upload = await call(`/api/import/uploads/${upload.id}/complete`, { method: "POST", signal });
    failures = 0;
    while (upload.status === "processing") {
      onProgress?.({
        phase: "importing",
        loaded: upload.progress?.done ?? 0,
        total: upload.progress?.total ?? 0,
      });
      await sleep(POLL_MS);
      signal?.throwIfAborted();
      try {
        upload = await call(`/api/import/uploads/${upload.id}`, { signal });
        failures = 0;
      } catch (error) {
        // The import keeps running on the server; ride out brief outages.
        if (signal?.aborted || !isRetryable(error) || ++failures > MAX_CONSECUTIVE_FAILURES)
          throw error;
        await backoff(failures);
      }
    }

    if (upload.status === "done" && upload.result) return upload.result;
    throw new Error(upload.error ?? `Import ${upload.status}`);
  } catch (error) {
    if (signal?.aborted) cancelOnServer();
    throw error;
  }
}
