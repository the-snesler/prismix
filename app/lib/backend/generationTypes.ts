import type { GenerationTask } from "~/lib/tasks/types";

/**
 * Where generation tasks run. The browser-only build runs them in the tab
 * (`localGenerationBackend`); the server build submits them to the server, which
 * keeps running them after the tab closes.
 *
 * Either way, progress lands in `galleryStore`: callers add pending items first,
 * then hand the tasks over here.
 */
export interface GenerationBackend {
  /** Run tasks in parallel. Resolves once every task has completed or failed. */
  run(tasks: GenerationTask[]): Promise<PromiseSettledResult<void>[]>;
  /** Stop a pending or running item. `galleryStore.cancelItem` has already removed its card. */
  cancel(itemId: string): void;
  /** Forget a failed item. `galleryStore.dismissItem` has already removed its card. */
  dismiss(itemId: string): void;
  /**
   * Start background sync when the app shell mounts (restoring in-flight and failed
   * items from the server). Returns a cleanup function.
   */
  connect(): () => void;
}
