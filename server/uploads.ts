import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ImportResult } from "~/lib/archive/manifest";
import { ArchiveError, importArchive, type ArchiveDeps } from "./archive";

/**
 * Resumable archive uploads for `/api/import/uploads`.
 *
 * A browser sends a large archive as a series of small chunks (each its own
 * request, retried on failure), so no single request has to survive the whole
 * transfer through every proxy on the way. Once all bytes have arrived, the
 * import runs in the background and the client polls for progress, so a slow
 * import can't hit a proxy's response timeout either.
 *
 * State lives next to the data in `<dir>/<id>.json` (+ `<id>.zip`), so an upload
 * can resume after a server restart, and an import that was running restarts
 * from the top (already-imported IDs are skipped).
 */

export type UploadStatus = "uploading" | "processing" | "done" | "failed" | "canceled";

export interface UploadState {
  id: string;
  name: string;
  size: number;
  received: number;
  status: UploadStatus;
  /** Import progress while processing: entries done out of total. */
  progress?: { done: number; total: number };
  result?: ImportResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export class UploadError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    message: string,
    readonly state?: UploadState
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/** Largest chunk the server accepts; clients send 8 MB and shrink on 413. */
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
/** Finished, failed, or abandoned uploads are cleaned up after this long. */
const RETENTION_MS = 24 * 60 * 60 * 1000;
/** Persist import progress at most this often. */
const PROGRESS_SAVE_MS = 1000;
const ID_PATTERN = /^[0-9a-f-]{36}$/;

export class ImportUploads {
  private readonly states = new Map<string, UploadState>();
  /** Per-upload write chain, so chunks for one upload are applied in order. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly aborts = new Map<string, AbortController>();
  /** Imports run one at a time. */
  private importChain: Promise<void> = Promise.resolve();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly dir: string,
    private readonly deps: ArchiveDeps
  ) {}

  private zipPath(id: string) {
    return path.join(this.dir, `${id}.zip`);
  }

  private statePath(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  private async save(state: UploadState): Promise<void> {
    state.updatedAt = Date.now();
    this.states.set(state.id, state);
    const target = this.statePath(state.id);
    const temp = `${target}.tmp-${randomUUID()}`;
    await fsp.writeFile(temp, JSON.stringify(state));
    await fsp.rename(temp, target);
  }

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.locks.set(
      id,
      next.catch(() => {})
    );
    return next;
  }

  /** Load saved uploads, resume interrupted imports, and drop stale ones. Call at startup. */
  async recover(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const now = Date.now();
    for (const file of await fsp.readdir(this.dir)) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -".json".length);
      let state: UploadState;
      try {
        state = JSON.parse(await fsp.readFile(this.statePath(id), "utf8")) as UploadState;
      } catch {
        await this.remove(id);
        continue;
      }
      if (now - state.updatedAt > RETENTION_MS) {
        await this.remove(id);
        continue;
      }
      this.states.set(id, state);
      if (state.status === "processing") this.startImport(state);
    }
  }

  get(id: string): UploadState | null {
    return ID_PATTERN.test(id) ? (this.states.get(id) ?? null) : null;
  }

  private require(id: string): UploadState {
    const state = this.get(id);
    if (!state) throw new UploadError(404, "Upload not found");
    return state;
  }

  async create(size: unknown, name: unknown): Promise<UploadState> {
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
      throw new UploadError(400, "`size` must be a positive integer");
    }
    await fsp.mkdir(this.dir, { recursive: true });
    const now = Date.now();
    await this.prune(now);
    const state: UploadState = {
      id: randomUUID(),
      name: typeof name === "string" ? name.slice(0, 200) : "archive.zip",
      size,
      received: 0,
      status: "uploading",
      createdAt: now,
      updatedAt: now,
    };
    // Reserve the file; chunks are written at their offsets.
    await (await fsp.open(this.zipPath(state.id), "w")).close();
    await this.save(state);
    return state;
  }

  /**
   * Write one chunk at `offset`. The offset may repeat bytes already received (a
   * retried chunk) but may not leave a gap; a gap answers 409 with the current
   * state so the client can continue from `received`.
   */
  appendChunk(id: string, offset: number, chunk: Uint8Array): Promise<UploadState> {
    return this.withLock(id, async () => {
      const state = this.require(id);
      if (state.status !== "uploading") {
        throw new UploadError(409, `Upload is ${state.status}`, state);
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > state.received) {
        throw new UploadError(409, "Chunk offset doesn't match the upload", state);
      }
      if (offset + chunk.byteLength > state.size) {
        throw new UploadError(400, "Chunk runs past the declared size", state);
      }
      const handle = await fsp.open(this.zipPath(id), "r+");
      try {
        await handle.write(chunk, 0, chunk.byteLength, offset);
      } finally {
        await handle.close();
      }
      state.received = Math.max(state.received, offset + chunk.byteLength);
      await this.save(state);
      return state;
    });
  }

  /** All bytes are in: start the import in the background. */
  complete(id: string): Promise<UploadState> {
    return this.withLock(id, async () => {
      const state = this.require(id);
      if (state.status === "processing" || state.status === "done") return state;
      if (state.status !== "uploading") {
        throw new UploadError(409, `Upload is ${state.status}`, state);
      }
      if (state.received !== state.size) {
        throw new UploadError(
          409,
          `Upload is incomplete (${state.received} of ${state.size} bytes)`,
          state
        );
      }
      state.status = "processing";
      state.progress = { done: 0, total: 0 };
      await this.save(state);
      this.startImport(state);
      return state;
    });
  }

  /** Stop an upload or a running import. What was already imported stays. */
  async cancel(id: string): Promise<UploadState> {
    const state = this.require(id);
    this.aborts.get(id)?.abort();
    if (state.status === "uploading" || state.status === "processing") {
      state.status = "canceled";
      await this.save(state);
    }
    await fsp.rm(this.zipPath(id), { force: true });
    return state;
  }

  private startImport(state: UploadState): void {
    const controller = new AbortController();
    this.aborts.set(state.id, controller);
    const run = (this.importChain = this.importChain.then(() =>
      this.runImport(state, controller.signal)
    ));
    this.inFlight.add(run);
    void run.finally(() => {
      this.inFlight.delete(run);
      this.aborts.delete(state.id);
    });
  }

  private async runImport(state: UploadState, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    let lastSave = 0;
    try {
      const result = await importArchive(this.zipPath(state.id), this.deps, {
        signal,
        onProgress: (done, total) => {
          state.progress = { done, total };
          state.updatedAt = Date.now();
          if (Date.now() - lastSave > PROGRESS_SAVE_MS) {
            lastSave = Date.now();
            void this.save(state).catch(() => {});
          }
        },
      });
      state.status = "done";
      state.result = result;
    } catch (error) {
      if (signal.aborted) return; // cancel() already recorded it
      state.status = "failed";
      state.error =
        error instanceof ArchiveError
          ? error.message
          : `Import failed: ${error instanceof Error ? error.message : String(error)}`;
      if (!(error instanceof ArchiveError)) console.error(`Import ${state.id} failed:`, error);
    }
    await this.save(state);
    await fsp.rm(this.zipPath(state.id), { force: true });
  }

  /** Drop uploads nobody has touched within the retention window. */
  private async prune(now: number): Promise<void> {
    for (const state of [...this.states.values()]) {
      if (state.status !== "processing" && now - state.updatedAt > RETENTION_MS) {
        await this.remove(state.id);
      }
    }
  }

  private async remove(id: string): Promise<void> {
    this.states.delete(id);
    await fsp.rm(this.zipPath(id), { force: true });
    await fsp.rm(this.statePath(id), { force: true });
  }

  /** Resolves once no import is running. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }
}

/** Read a request body into memory, refusing anything over `limit` bytes. */
export async function readLimitedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new UploadError(413, `Chunks may be at most ${limit} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
