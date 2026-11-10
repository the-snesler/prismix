import { randomUUID } from "node:crypto";
import type { GalleryRepository } from "~/lib/backend/types";
import { runGenerationTask, type RunTaskOptions } from "~/lib/tasks/runTask";
import type { GenerationTask, TaskEvent, TaskRunnerDeps } from "~/lib/tasks/types";
import type { CompletedGalleryItem, FailedGalleryItem, GalleryItem, Provider } from "~/types";
import { transaction, type Database } from "./db";
import type { EventHub } from "./events";
import { imageFileUrl } from "./repository";

/**
 * Durable generation jobs. A job is one `GenerationTask`; its gallery items live
 * in the `items` table (as the same `GalleryItem` JSON the client renders) until
 * they complete, which moves them into `images`, or until a failed one is dismissed.
 *
 * Restart semantics: queued jobs, and running jobs whose items were all still
 * waiting out a rate limit, run again. Anything that was mid-request is marked as
 * an interrupted, retryable failure, so a restart never silently pays twice.
 */

export const INTERRUPTED_ERROR = "Interrupted by a server restart. Retry to run it again.";

type JobStatus = "queued" | "running" | "done" | "failed";

interface JobRow {
  id: string;
  task: string;
  status: JobStatus;
}

export interface JobRunnerOptions {
  db: Database;
  repository: GalleryRepository;
  events: EventHub;
  getApiKey: TaskRunnerDeps["getApiKey"];
  createThumbnail: TaskRunnerDeps["createThumbnail"];
  /** Concurrent provider calls per provider. */
  concurrencyPerProvider: number;
  /** Test hook for retry timing. */
  runOptions?: RunTaskOptions;
}

export class JobValidationError extends Error {
  status = 400 as const;
}

export class JobConflictError extends Error {
  status = 409 as const;
}

const PENDING_ONLY_FIELDS = ["pendingPhase", "retryCount", "waitingUntil", "retryAfter"] as const;

function taskProvider(task: GenerationTask): Provider {
  return task.kind === "upscale" ? "replicate" : task.provider;
}

function validateTask(value: unknown): GenerationTask {
  const task = value as Partial<GenerationTask> | null;
  if (!task || typeof task !== "object") throw new JobValidationError("Task must be an object");
  if (task.kind !== "image" && task.kind !== "upscale") {
    throw new JobValidationError("Task kind must be image or upscale");
  }
  if (
    !Array.isArray(task.itemIds) ||
    task.itemIds.length === 0 ||
    !task.itemIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    throw new JobValidationError("Task itemIds must be a non-empty string array");
  }
  if (typeof task.modelId !== "string" || typeof task.prompt !== "string") {
    throw new JobValidationError("Task needs modelId and prompt");
  }
  if (!Array.isArray(task.referenceImageIds)) {
    throw new JobValidationError("Task referenceImageIds must be an array");
  }
  if (task.kind === "image" && typeof task.provider !== "string") {
    throw new JobValidationError("Image task needs a provider");
  }
  if (task.kind === "upscale" && !task.upscaler) {
    throw new JobValidationError("Upscale task needs an upscaler");
  }
  if (task.modelId === "debug/manual") {
    throw new JobValidationError("The manual debug model only works in the browser-only build");
  }
  return task as GenerationTask;
}

/** The card shown while a task is queued, from the client's copy when it sent one. */
function pendingItemFor(
  task: GenerationTask,
  id: string,
  sent: GalleryItem | undefined
): GalleryItem {
  const base = {
    ...(sent && sent.status !== "completed" ? sent : {}),
    id,
    modelId: task.modelId,
    modelName: task.modelName,
    prompt: task.prompt,
    basePrompt: task.basePrompt,
    referenceImageIds: task.referenceImageIds,
    aspectRatio: task.kind === "image" ? task.aspectRatio : null,
    resolution: task.kind === "image" ? task.resolution : null,
  } as Record<string, unknown>;
  if (task.kind === "image") {
    base.quality = task.quality;
    base.modelOptions = task.modelOptions;
    base.variationReplacements = task.variationReplacements;
    base.styleId = task.styleId;
    base.characterIds = task.characterIds;
    base.manualReferenceImageIds = task.manualReferenceImageIds;
  }
  for (const field of PENDING_ONLY_FIELDS) delete base[field];
  delete base.error;
  delete base.canRetry;
  return { ...base, status: "pending", retryCount: 0, isFavorite: false } as GalleryItem;
}

export class JobRunner {
  private readonly canceled = new Set<string>();
  private readonly running = new Map<Provider, number>();
  private readonly queues = new Map<Provider, string[]>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: JobRunnerOptions) {}

  // --- Queries -------------------------------------------------------------

  /** Pending, running, and failed (not yet dismissed) items, newest job first. */
  listItems(): GalleryItem[] {
    const rows = this.options.db
      .prepare(
        `SELECT items.item AS item FROM items
         LEFT JOIN jobs ON jobs.id = items.job_id
         ORDER BY COALESCE(jobs.created_at, items.updated_at) DESC, items.rowid ASC`
      )
      .all() as Array<{ item: string }>;
    return rows.map((row) => JSON.parse(row.item) as GalleryItem);
  }

  private getItem(id: string): GalleryItem | null {
    const row = this.options.db.prepare("SELECT item FROM items WHERE id = ?").get(id) as
      | { item: string }
      | undefined;
    return row ? (JSON.parse(row.item) as GalleryItem) : null;
  }

  private putItem(item: GalleryItem, jobId?: string): void {
    const now = Date.now();
    if (jobId) {
      this.options.db
        .prepare(
          `INSERT INTO items (id, job_id, item, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET job_id = excluded.job_id, item = excluded.item,
             updated_at = excluded.updated_at`
        )
        .run(item.id, jobId, JSON.stringify(item), now);
    } else {
      this.options.db
        .prepare("UPDATE items SET item = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(item), now, item.id);
    }
    this.options.events.publish({ type: "item", data: item });
  }

  private removeItem(id: string): boolean {
    const result = this.options.db.prepare("DELETE FROM items WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  private setJobStatus(id: string, status: JobStatus, error?: string): void {
    this.options.db
      .prepare("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, error ?? null, Date.now(), id);
  }

  /** Drop finished jobs that no longer own any item. */
  private pruneJob(id: string): void {
    this.options.db
      .prepare(
        `DELETE FROM jobs WHERE id = ? AND status IN ('done', 'failed')
         AND NOT EXISTS (SELECT 1 FROM items WHERE job_id = ?)`
      )
      .run(id, id);
  }

  // --- Commands ------------------------------------------------------------

  /**
   * Queue tasks. `items` are the client's pending cards (for labels and loading
   * previews); they're optional. Rejects IDs that are already running or saved.
   * A failed item's ID may be resubmitted, which is how retry works.
   */
  async submit(rawTasks: unknown, items: unknown = []): Promise<string[]> {
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      throw new JobValidationError("tasks must be a non-empty array");
    }
    const tasks = rawTasks.map(validateTask);
    const sent = new Map(
      (Array.isArray(items) ? (items as GalleryItem[]) : [])
        .filter((item) => item && typeof item.id === "string")
        .map((item) => [item.id, item])
    );

    const itemIds = tasks.flatMap((task) => task.itemIds);
    if (new Set(itemIds).size !== itemIds.length) {
      throw new JobValidationError("Item IDs must be unique");
    }
    const existingImages = await this.options.repository.getExistingImageIds();
    for (const id of itemIds) {
      if (existingImages.has(id)) throw new JobConflictError(`Image ${id} already exists`);
      const existing = this.getItem(id);
      if (existing && existing.status !== "failed") {
        throw new JobConflictError(`Item ${id} is already running`);
      }
    }

    const now = Date.now();
    const jobs = tasks.map((task) => ({ id: randomUUID(), task }));
    transaction(this.options.db, () => {
      for (const { id, task } of jobs) {
        this.options.db
          .prepare(
            `INSERT INTO jobs (id, task, item_ids, status, created_at, updated_at)
             VALUES (?, ?, ?, 'queued', ?, ?)`
          )
          .run(id, JSON.stringify(task), JSON.stringify(task.itemIds), now, now);
      }
    });
    const previousJobs = new Set<string>();
    for (const { id, task } of jobs) {
      for (const itemId of task.itemIds) {
        const previous = this.options.db
          .prepare("SELECT job_id FROM items WHERE id = ?")
          .get(itemId) as { job_id: string } | undefined;
        if (previous) previousJobs.add(previous.job_id);
        this.canceled.delete(itemId);
        this.putItem(pendingItemFor(task, itemId, sent.get(itemId)), id);
      }
      this.enqueue(id, task);
    }
    for (const id of previousJobs) this.pruneJob(id);
    return itemIds;
  }

  /** Stop an item. A provider call already in flight finishes, and its result is discarded. */
  cancel(itemId: string): boolean {
    const item = this.getItem(itemId);
    if (!item || item.status === "failed") return false;
    this.canceled.add(itemId);
    this.removeItem(itemId);
    this.options.events.publish({ type: "item-removed", data: { id: itemId } });
    return true;
  }

  /** Forget a failed item. */
  dismiss(itemId: string): boolean {
    const row = this.options.db.prepare("SELECT job_id FROM items WHERE id = ?").get(itemId) as
      | { job_id: string }
      | undefined;
    const item = this.getItem(itemId);
    if (!item || item.status !== "failed") return false;
    this.removeItem(itemId);
    if (row) this.pruneJob(row.job_id);
    this.options.events.publish({ type: "item-removed", data: { id: itemId } });
    return true;
  }

  /** Call once at startup, before accepting requests. */
  recover(): void {
    const jobs = this.options.db
      .prepare(
        "SELECT id, task, status FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at"
      )
      .all() as unknown as JobRow[];

    for (const job of jobs) {
      const task = JSON.parse(job.task) as GenerationTask;
      const items = task.itemIds
        .map((id) => this.getItem(id))
        .filter((item): item is GalleryItem => !!item && item.status !== "failed");
      if (items.length === 0) {
        this.setJobStatus(job.id, "done");
        this.pruneJob(job.id);
        continue;
      }

      const neverReachedProvider = items.every(
        (item) => item.status === "pending" || item.status === "waiting"
      );
      if (job.status === "queued" || neverReachedProvider) {
        for (const item of items) this.putItem(pendingItemFor(task, item.id, item));
        this.enqueue(job.id, task);
        continue;
      }

      for (const item of items) this.fail(item, INTERRUPTED_ERROR, true);
      this.setJobStatus(job.id, "failed", INTERRUPTED_ERROR);
    }
  }

  /** Resolves once nothing is queued or running. For tests and graceful shutdown. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  // --- Scheduling ----------------------------------------------------------

  private enqueue(jobId: string, task: GenerationTask): void {
    const provider = taskProvider(task);
    const queue = this.queues.get(provider) ?? [];
    queue.push(jobId);
    this.queues.set(provider, queue);
    this.pump(provider);
  }

  private pump(provider: Provider): void {
    const queue = this.queues.get(provider);
    while (
      queue?.length &&
      (this.running.get(provider) ?? 0) < this.options.concurrencyPerProvider
    ) {
      const jobId = queue.shift()!;
      this.running.set(provider, (this.running.get(provider) ?? 0) + 1);
      const run = this.execute(jobId).finally(() => {
        this.running.set(provider, (this.running.get(provider) ?? 1) - 1);
        this.inFlight.delete(run);
        this.pump(provider);
      });
      this.inFlight.add(run);
    }
  }

  private async execute(jobId: string): Promise<void> {
    const row = this.options.db
      .prepare("SELECT id, task, status FROM jobs WHERE id = ?")
      .get(jobId) as JobRow | undefined;
    if (!row) return;
    const task = JSON.parse(row.task) as GenerationTask;
    this.setJobStatus(jobId, "running");

    try {
      await runGenerationTask(task, this.depsFor(), this.options.runOptions);
      this.setJobStatus(jobId, "done");
    } catch (error) {
      this.setJobStatus(jobId, "failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.pruneJob(jobId);
    }
  }

  private depsFor(): TaskRunnerDeps {
    const { repository } = this.options;
    return {
      getApiKey: this.options.getApiKey,
      async loadReferences(ids) {
        const references = await repository.getReferenceImagesByIds(ids);
        const byId = new Map(references.map((r) => [r.id, r]));
        return ids.flatMap((id) => {
          const reference = byId.get(id);
          return reference ? [{ id, blob: reference.blob }] : [];
        });
      },
      createThumbnail: this.options.createThumbnail,
      saveImage: (record) => repository.saveImage(record),
      deleteImage: (id) => repository.deleteImage(id),
      isCanceled: (id) => this.canceled.has(id) || !this.getItem(id),
      emit: (event) => this.apply(event),
    };
  }

  private apply(event: TaskEvent): void {
    switch (event.type) {
      case "progress":
        for (const id of event.itemIds) {
          const item = this.getItem(id);
          if (!item || item.status === "failed") continue;
          this.putItem({ ...item, ...event.patch } as GalleryItem);
        }
        return;
      case "completed": {
        const pending = this.getItem(event.itemId);
        this.removeItem(event.itemId);
        const item: CompletedGalleryItem = {
          ...event.record,
          ...(pending?.loadingPreview ? { loadingPreview: pending.loadingPreview } : {}),
          isFavorite: event.record.isFavorite ?? false,
          status: "completed",
          originalUrl: imageFileUrl(event.itemId, "original"),
          originalMimeType: event.original.type,
          thumbnailUrl: imageFileUrl(event.itemId, "thumbnail"),
        };
        this.options.events.publish({ type: "item", data: item });
        return;
      }
      case "failed":
        for (const id of event.itemIds) {
          const item = this.getItem(id);
          if (item) this.fail(item, event.error, event.canRetry);
        }
        return;
    }
  }

  private fail(item: GalleryItem, error: string, canRetry: boolean): void {
    const failed = { ...item } as Record<string, unknown>;
    for (const field of PENDING_ONLY_FIELDS) delete failed[field];
    this.putItem({ ...failed, status: "failed", error, canRetry } as FailedGalleryItem);
  }
}
