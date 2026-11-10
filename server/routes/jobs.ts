import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventHub, ServerEvent } from "../events";
import { JobConflictError, JobValidationError, type JobRunner } from "../jobs";
import { isObject, notFound, readJsonBody } from "./util";

/** Clients treat a silent stream as dead after a few missed pings (see remoteGeneration.ts). */
const KEEPALIVE_MS = 15_000;

/** `/api/jobs` and `/api/items`: submit, list, cancel, dismiss. */
export function jobRoutes(runner: JobRunner) {
  const app = new Hono();

  app.post("/jobs", async (c) => {
    const body = await readJsonBody(c);
    if (!isObject(body)) return c.json({ error: "Body must be an object" }, 400);
    try {
      const itemIds = await runner.submit(body.tasks, body.items);
      return c.json({ itemIds }, 202);
    } catch (error) {
      if (error instanceof JobValidationError || error instanceof JobConflictError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });

  app.get("/jobs/items", (c) => c.json(runner.listItems()));

  app.post("/items/:id/cancel", (c) =>
    runner.cancel(c.req.param("id")) ? c.json({ ok: true }) : notFound(c, "No active item")
  );

  app.post("/items/:id/dismiss", (c) =>
    runner.dismiss(c.req.param("id")) ? c.json({ ok: true }) : notFound(c, "No failed item")
  );

  return app;
}

/** `/api/events`: job progress as server-sent events. */
export function eventRoutes(events: EventHub) {
  const app = new Hono();

  app.get("/", (c) =>
    streamSSE(c, async (stream) => {
      const queue: ServerEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = events.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });

      // Tell the client the stream is live; it resyncs on open.
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        while (queue.length > 0 && !stream.aborted) {
          const event = queue.shift()!;
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, KEEPALIVE_MS);
        });
        clearTimeout(timer);
        wake = null;
        // A named event rather than an SSE comment, so the client can see it.
        if (queue.length === 0 && !stream.aborted) {
          await stream.writeSSE({ event: "ping", data: "{}" });
        }
      }
      unsubscribe();
    })
  );

  return app;
}
